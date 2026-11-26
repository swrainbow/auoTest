<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ArrowDown, ArrowUp, ArrowUpToLine, Eye, FileCode2, Play, Plus, X } from '@lucide/vue';
import { toast } from 'vue-sonner';
import { createRun, getCase, getCaseSkills, isRequestTimeout, messageOf, readScript, updateCase, updateCaseStatus } from '@/api/client';
import { SCRIPT_GENERATION_TEXT, isScriptGenerationActive, useScriptGenerationStore } from '@/stores/script-generation';
import { CASE_STATUS_TEXT, formatTime } from '@/utils/format';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import StatusBadge from '@/components/StatusBadge.vue';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Field, FieldGroup } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Spinner } from '@/components/ui/spinner';
import type { BusinessStep, CasePrerequisite, SkillDto, TestCaseDto, TestCaseVersionDto } from '@autotest/shared';
import CasePrerequisiteFields from './CasePrerequisiteFields.vue';
import StepSkillSelect from './StepSkillSelect.vue';

type CaseDetail = TestCaseDto & {
  versions: TestCaseVersionDto[];
};

type EditableStep = Omit<BusinessStep, 'order'> & { key: number };

const route = useRoute();
const router = useRouter();
const caseId = computed(() => Number(route.params.id));
const scriptGenerations = useScriptGenerationStore();

const loading = ref(true);
const saving = ref(false);
const detail = ref<CaseDetail | null>(null);
const steps = ref<EditableStep[]>([]);
const skills = ref<SkillDto[]>([]);
const prerequisiteSkill = ref<string>();
const prerequisite = ref<CasePrerequisite>();
const validatePrerequisite = ref(false);
let nextStepKey = 0;
const form = ref({ name: '', module: '', priority: 'P1', changeNote: '' });
const publishConfirm = ref(false);
const submittingGeneration = ref(false);
const refreshingGeneratedCase = ref(false);
const scriptError = ref<{ title: string; message: string } | null>(null);
const scriptDlg = ref({ open: false, path: '', content: '' });
const autoRepair = ref(true);
const starting = ref(false);
let loadRequest = 0;
let scriptRequest = 0;
let saveRequest = 0;

const locked = computed(() => detail.value?.status === 'published' || detail.value?.status === 'deprecated');
const requirementText = computed(() => detail.value?.originalRequirement ?? detail.value?.description ?? '');
const dirty = computed(() => {
  const saved = detail.value;
  if (!saved) return false;
  return form.value.name !== saved.name || form.value.module !== saved.module ||
    prerequisite.value?.skill !== saved.prerequisite?.skill ||
    prerequisite.value?.mapName !== saved.prerequisite?.mapName ||
    prerequisite.value?.serviceName !== saved.prerequisite?.serviceName ||
    form.value.priority !== saved.priority || steps.value.length !== saved.steps.length ||
    steps.value.some((step, i) => {
      const original = saved.steps[i];
      return !original || step.action !== original.action || step.expected !== original.expected || step.skill !== original.skill;
    });
});
const generation = computed(() => scriptGenerations.latestByCase.get(caseId.value));
const generationActive = computed(() => !!generation.value && isScriptGenerationActive(generation.value));
const generationBusy = computed(() => submittingGeneration.value || generationActive.value || refreshingGeneratedCase.value);
const generationNeedsRefresh = computed(() => {
  const job = generation.value;
  return job?.status === 'succeeded' && job.resultVersion !== null &&
    detail.value?.id === job.testCaseId && detail.value.currentVersion < job.resultVersion;
});

function populateCase(result: CaseDetail): void {
  detail.value = result;
  prerequisite.value = result.prerequisite ? { ...result.prerequisite } : undefined;
  validatePrerequisite.value = false;
  steps.value = result.steps.map(({ action, expected, skill }) => ({ key: nextStepKey++, action, expected, skill }));
  form.value = { name: result.name, module: result.module, priority: result.priority, changeNote: '' };
}

async function load(): Promise<void> {
  const id = caseId.value;
  const request = ++loadRequest;
  loading.value = true;
  try {
    const result = await getCase(id);
    if (request !== loadRequest || id !== caseId.value) return;
    populateCase(result);
  } finally {
    if (request === loadRequest) loading.value = false;
  }
}

function addStep(): void {
  steps.value.push({ key: nextStepKey++, action: '', expected: '' });
}

function removeStep(index: number): void {
  steps.value.splice(index, 1);
}

async function moveStep(from: number, to: number, event: MouseEvent): Promise<void> {
  const step = steps.value[from];
  if (!step || to < 0 || to >= steps.value.length || from === to) return;
  const button = event.currentTarget as HTMLButtonElement;
  steps.value.splice(from, 1);
  steps.value.splice(to, 0, step);
  await nextTick();
  const row = button.closest<HTMLElement>('[role="group"]');
  row?.scrollIntoView({ block: 'nearest' });
  (button.disabled ? row : button)?.focus({ preventScroll: true });
}

async function onSave(): Promise<void> {
  if (saving.value || refreshingGeneratedCase.value) return;
  validatePrerequisite.value = true;
  if (prerequisite.value && !prerequisite.value.mapName.trim()) return;
  if (!detail.value || !steps.value.length || steps.value.some((s) => !s.action.trim() || !s.expected.trim())) {
    toast.warning('每个业务步骤都需要动作与预期');
    return;
  }
  const id = caseId.value;
  const request = ++saveRequest;
  saving.value = true;
  try {
    await updateCase(id, {
      name: form.value.name.trim(),
      module: form.value.module.trim() || '通用',
      priority: form.value.priority as TestCaseDto['priority'],
      executionMode: detail.value.executionMode,
      description: detail.value.description,
      tags: detail.value.tags,
      skill: detail.value.skill,
      taskId: detail.value.taskId,
      prerequisite: prerequisite.value ?? null,
      steps: steps.value.map(({ action, expected, skill }, index) => ({
        order: index + 1, action: action.trim(), expected: expected.trim(), skill,
      })),
      changeNote: form.value.changeNote.trim() || undefined,
    });
    if (request === saveRequest) {
      toast.success('已保存');
      await load();
    }
  } catch {
    // Keep the user's draft. The API client reports any save error.
  } finally {
    if (request === saveRequest) saving.value = false;
  }
}

async function onTrialRun(): Promise<void> {
  if (!detail.value || starting.value) return;
  starting.value = true;
  try {
    const run = await createRun({
      testCaseId: caseId.value,
      mode: detail.value.zeroAiVerified || locked.value ? 'strict' : 'explore',
      autoRepair: !detail.value.zeroAiVerified && !locked.value && autoRepair.value,
    });
    await router.push(`/runs/${run.id}`);
  } finally {
    starting.value = false;
  }
}

async function newVersion(): Promise<void> {
  await updateCaseStatus(caseId.value, 'draft');
  await load();
}

async function replayVersion(version: number): Promise<void> {
  const run = await createRun({ testCaseId: caseId.value, version, mode: 'strict' });
  await router.push(`/runs/${run.id}`);
}

async function onPublish(): Promise<void> {
  publishConfirm.value = false;
  await updateCaseStatus(caseId.value, 'published');
  toast.success('已发布');
  void load();
}

async function onGenerateScript(): Promise<void> {
  const current = detail.value;
  if (!current || current.id !== caseId.value || generationBusy.value || generationNeedsRefresh.value ||
    locked.value || dirty.value || saving.value) return;
  const request = ++scriptRequest;
  const previousJob = generation.value;
  submittingGeneration.value = true;
  scriptError.value = null;
  try {
    await scriptGenerations.start(current.id, current.currentVersion);
  } catch (error) {
    if (request !== scriptRequest) return;
    const latest = await scriptGenerations.fetchLatest(current.id).catch(() => null);
    if (request !== scriptRequest) return;
    if (latest?.sourceVersion === current.currentVersion && (latest.id !== previousJob?.id || isScriptGenerationActive(latest))) return;
    scriptError.value = isRequestTimeout(error) ? {
      title: '等待平台响应超时',
      message: '任务可能已提交。请先查看脚本生成通知或刷新此页再重试。',
    } : {
      title: 'AI 生成脚本失败', message: messageOf(error) || '未收到具体错误信息，请重试。',
    };
  } finally {
    if (request === scriptRequest) submittingGeneration.value = false;
  }
}

async function syncGeneratedCase(): Promise<void> {
  const job = generation.value;
  if (!job || job.resultVersion === null || !generationNeedsRefresh.value || refreshingGeneratedCase.value ||
    dirty.value || saving.value) return;
  const request = scriptRequest;
  refreshingGeneratedCase.value = true;
  scriptError.value = null;
  try {
    const updated = await getCase(job.testCaseId, { silent: true });
    if (request !== scriptRequest || caseId.value !== job.testCaseId || dirty.value || saving.value) return;
    if (updated.currentVersion < job.resultVersion) throw new Error('当前用例尚未显示生成的版本');
    const changeNote = form.value.changeNote;
    populateCase(updated);
    form.value.changeNote = changeNote;
  } catch (error) {
    if (request === scriptRequest) scriptError.value = { title: '脚本已生成，刷新用例失败', message: messageOf(error) };
  } finally {
    if (request === scriptRequest) refreshingGeneratedCase.value = false;
  }
}

async function onViewScript(version?: number): Promise<void> {
  const id = caseId.value;
  const request = scriptRequest;
  const result = await readScript(id, version).catch(() => null);
  if (result && request === scriptRequest && caseId.value === id) {
    scriptDlg.value = { open: true, path: result.scriptPath, content: result.content };
  }
}

watch([generationNeedsRefresh, dirty, saving], ([needsRefresh, hasEdits, isSaving]) => {
  if (needsRefresh && !hasEdits && !isSaving) void syncGeneratedCase();
});
watch(caseId, (id) => {
  scriptRequest++;
  saveRequest++;
  detail.value = null;
  saving.value = false;
  submittingGeneration.value = false;
  refreshingGeneratedCase.value = false;
  scriptError.value = null;
  scriptDlg.value = { open: false, path: '', content: '' };
  void load().catch(() => undefined);
  void scriptGenerations.fetchLatest(id).catch(() => undefined);
}, { immediate: true });
onBeforeUnmount(() => {
  scriptRequest++;
  saveRequest++;
  loadRequest++;
});
onMounted(() => {
  void getCaseSkills().then((available) => {
    skills.value = available.business;
    prerequisiteSkill.value = available.prerequisite;
  }).catch(() => undefined);
});
</script>

<template>
  <div v-if="loading" class="flex justify-center py-24">
    <Spinner class="size-6 text-muted-foreground" />
  </div>
  <div v-else-if="detail" class="grid grid-cols-1 items-start gap-4 lg:grid-cols-[44fr_56fr]">
    <div class="flex flex-col gap-4">
      <!-- 基本信息 -->
      <Card>
        <CardHeader class="flex flex-row items-center justify-between space-y-0">
          <CardTitle class="text-[15px]">{{ detail.code }} · 基本信息</CardTitle>
          <div class="flex items-center gap-1.5">
            <span
              v-if="detail.zeroAiVerified"
              class="rounded-md border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-600"
            >
              零 AI 已验证
            </span>
            <StatusBadge
              :text="CASE_STATUS_TEXT[detail.status] ?? detail.status"
              :type="detail.status === 'published' ? 'passed' : detail.status === 'trial-passed' ? 'info' : 'neutral'"
            />
          </div>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <Field :data-disabled="locked || undefined">
              <Label for="case-name">用例名称</Label>
              <Input id="case-name" v-model="form.name" :disabled="locked" />
            </Field>
            <Field :data-disabled="locked || undefined">
              <Label for="case-module">业务模块</Label>
              <Input id="case-module" v-model="form.module" placeholder="如：任务配置" :disabled="locked" />
            </Field>
            <div class="grid grid-cols-2 gap-3">
              <Field :data-disabled="locked || undefined">
                <Label>优先级</Label>
                <Select v-model="form.priority" :disabled="locked">
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem v-for="p in ['P0', 'P1', 'P2', 'P3']" :key="p" :value="p">{{ p }}</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <Label>默认业务 Skill</Label>
                <p class="break-all text-sm text-muted-foreground">
                  {{ skills.find((item) => item.dir === detail?.skill)?.name || detail.skill || '自动匹配' }}
                </p>
              </Field>
            </div>
            <CasePrerequisiteFields
              id="case-prerequisite"
              v-model="prerequisite"
              :available-skill="prerequisiteSkill"
              :disabled="locked || saving"
              :validate="validatePrerequisite"
            />
            <Field>
              <Label>自然语言需求</Label>
              <div>
                <Dialog v-if="requirementText.trim()">
                  <DialogTrigger as-child>
                    <Button variant="outline" size="sm">
                      <Eye data-icon="inline-start" />
                      查看原始需求
                    </Button>
                  </DialogTrigger>
                  <DialogContent class="sm:max-w-3xl">
                    <DialogHeader>
                      <DialogTitle>{{ detail.originalRequirement == null ? '已保存的需求描述' : '原始自然语言需求' }}</DialogTitle>
                      <DialogDescription>{{ detail.code }} · {{ detail.name }}</DialogDescription>
                    </DialogHeader>
                    <pre tabindex="0" class="max-h-[55vh] overflow-y-auto whitespace-pre-wrap wrap-anywhere rounded-md border bg-muted/40 p-4 font-sans text-sm leading-relaxed">{{ requirementText }}</pre>
                    <DialogFooter>
                      <DialogClose as-child>
                        <Button variant="outline">关闭</Button>
                      </DialogClose>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
                <p v-else class="text-sm text-muted-foreground">此用例暂无需求记录</p>
              </div>
            </Field>
            <Field :data-disabled="locked || undefined">
              <Label for="case-script">脚本路径（相对 e2e-project）</Label>
              <div class="flex gap-2">
                <Input id="case-script" :model-value="detail.scriptPath ?? ''" placeholder="等待生成" readonly class="font-mono text-xs" />
                <Button
                  variant="outline"
                  size="sm"
                  class="shrink-0"
                  :disabled="locked || dirty || saving || generationBusy || generationNeedsRefresh"
                  @click="onGenerateScript"
                >
                  <FileCode2 data-icon="inline-start" />
                  {{ submittingGeneration ? '提交中…' : generationActive ? '生成中…' : 'AI 生成脚本' }}
                </Button>
                <Button
                  v-if="detail.scriptPath"
                  variant="ghost"
                  size="sm"
                  class="shrink-0"
                  @click="onViewScript()"
                >
                  <Eye data-icon="inline-start" />
                  查看
                </Button>
              </div>
              <p v-if="generationActive && generation" class="text-xs text-muted-foreground" role="status">
                v{{ generation.sourceVersion }} 的脚本{{ SCRIPT_GENERATION_TEXT[generation.status] }}。可离开此页，稍后从顶部通知查看结果。
              </p>
              <div v-else-if="generation?.status === 'succeeded' && generation.resultVersion" class="flex flex-wrap items-center gap-2 text-xs">
                <span role="status">脚本 v{{ generation.resultVersion }} 已生成</span>
                <Button type="button" size="sm" variant="ghost" @click="onViewScript(generation.resultVersion)">查看生成结果</Button>
                <Button
                  v-if="generationNeedsRefresh && !dirty && scriptError"
                  type="button" size="sm" variant="ghost" :disabled="refreshingGeneratedCase" @click="syncGeneratedCase"
                >刷新用例</Button>
                <p v-if="generationNeedsRefresh && dirty" class="basis-full text-muted-foreground">当前未保存的编辑已保留。</p>
              </div>
              <Alert v-else-if="generation?.status === 'failed' && !scriptError" variant="destructive">
                <AlertTitle>v{{ generation.sourceVersion }} 的脚本生成失败</AlertTitle>
                <AlertDescription class="whitespace-pre-wrap wrap-anywhere">{{ generation.error || '未收到具体错误信息，请重试。' }}</AlertDescription>
              </Alert>
              <Alert v-if="scriptError" variant="destructive">
                <AlertTitle>{{ scriptError.title }}</AlertTitle>
                <AlertDescription class="whitespace-pre-wrap wrap-anywhere">{{ scriptError.message }}</AlertDescription>
              </Alert>
            </Field>
            <div
              v-if="detail.scriptPath && !locked && !detail.zeroAiVerified"
              class="rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-xs leading-relaxed text-amber-700"
            >
              无需 AI 的脚本可在首次执行通过时完成零 AI 验证。使用 AI 的探索通过后通常会追加严格回放。若自动回放暂缓，请按运行详情准备测资并手动验证。零 AI 验证通过后可发布。
            </div>
            <Field :data-disabled="locked || undefined">
              <Label for="case-note">变更说明（保存时记录）</Label>
              <Input id="case-note" v-model="form.changeNote" placeholder="本次改了什么，便于回溯" :disabled="locked" />
            </Field>
          </FieldGroup>
        </CardContent>
      </Card>

      <!-- 版本历史 -->
      <Card>
        <CardHeader>
          <CardTitle class="text-[15px]">版本历史</CardTitle>
          <CardDescription>每次保存业务步骤自动生成版本快照</CardDescription>
        </CardHeader>
        <CardContent class="flex flex-col">
          <div v-for="v in detail.versions" :key="v.id" class="flex items-center gap-2.5 border-b py-2 last:border-b-0">
            <span class="rounded-md bg-muted px-2 py-0.5 text-xs font-semibold">v{{ v.version }}</span>
            <div class="min-w-0 flex-1">
              <div class="truncate text-[13px]">{{ v.changeNote || '（无说明）' }}</div>
              <div class="text-[11px] text-muted-foreground">{{ formatTime(v.createdAt) }} · {{ v.steps.length }} 步{{ v.prerequisite ? ' · 含前置检查' : '' }}{{ v.publishedAt ? ' · 已发布' : '' }}</div>
            </div>
            <Button v-if="v.scriptPath" variant="ghost" size="sm" @click="onViewScript(v.version)">脚本</Button>
            <Button v-if="v.publishedAt && detail.status !== 'deprecated' && v.version !== detail.currentVersion" variant="ghost" size="sm" @click="replayVersion(v.version)">回放</Button>
          </div>
        </CardContent>
      </Card>
    </div>

    <!-- 业务步骤 -->
    <Card class="h-fit">
      <CardHeader>
        <CardTitle class="text-[15px]">业务步骤</CardTitle>
        <CardDescription>保存业务步骤或前置操作设置后生成新版本</CardDescription>
      </CardHeader>
      <CardContent class="flex flex-col gap-3">
        <div
          v-if="locked"
          class="rounded-lg border bg-muted/40 px-3.5 py-2.5 text-xs leading-relaxed text-muted-foreground"
        >
          当前版本已锁定。创建新版本后可以编辑业务步骤。
        </div>

        <div
          v-for="(step, i) in steps"
          :key="step.key"
          role="group"
          :aria-label="`第 ${i + 1} 步`"
          tabindex="-1"
          class="flex items-start gap-2.5 rounded-xl border p-3"
        >
          <div class="mt-1 grid size-5.5 shrink-0 place-items-center rounded-md bg-muted text-xs font-semibold text-muted-foreground">
            {{ i + 1 }}
          </div>
          <div class="flex min-w-0 flex-1 flex-col gap-1.5">
            <div class="flex items-center gap-2">
              <Label :for="`step-action-${step.key}`" class="w-8 shrink-0 text-xs text-muted-foreground">动作</Label>
              <Input :id="`step-action-${step.key}`" v-model="step.action" :disabled="locked || saving" class="h-8 text-xs" />
            </div>
            <div class="flex items-center gap-2">
              <Label :for="`step-expected-${step.key}`" class="w-8 shrink-0 text-xs text-muted-foreground">预期</Label>
              <Input :id="`step-expected-${step.key}`" v-model="step.expected" :disabled="locked || saving" class="h-8 text-xs" />
            </div>
            <StepSkillSelect :id="`step-skill-${step.key}`" v-model="step.skill" :skills="skills" :disabled="locked || saving" />
          </div>
          <div v-if="!locked" class="grid shrink-0 grid-cols-2 gap-1 self-center">
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              title="置顶"
              :aria-label="`将第 ${i + 1} 步移到第一步`"
              :disabled="saving || i === 0"
              @click="moveStep(i, 0, $event)"
            >
              <ArrowUpToLine aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              title="上移"
              :aria-label="`上移第 ${i + 1} 步`"
              :disabled="saving || i === 0"
              @click="moveStep(i, i - 1, $event)"
            >
              <ArrowUp aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              title="下移"
              :aria-label="`下移第 ${i + 1} 步`"
              :disabled="saving || i === steps.length - 1"
              @click="moveStep(i, i + 1, $event)"
            >
              <ArrowDown aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              class="text-destructive"
              title="删除"
              :aria-label="`删除第 ${i + 1} 步`"
              :disabled="saving"
              @click="removeStep(i)"
            >
              <X aria-hidden="true" />
            </Button>
          </div>
        </div>

        <div class="flex items-center gap-2.5">
          <Button v-if="!locked" variant="outline" :disabled="saving" @click="addStep">
            <Plus data-icon="inline-start" />
            添加步骤
          </Button>
          <div class="flex-1" />
          <Button v-if="!locked" :disabled="saving || refreshingGeneratedCase" @click="onSave">
            {{ saving ? '保存中…' : '保存用例' }}
          </Button>
        </div>

        <Separator />
        <label v-if="detail.scriptPath && !locked && !detail.zeroAiVerified" class="flex items-center gap-2 text-sm">
          <input v-model="autoRepair" type="checkbox" class="accent-primary" />
          定位或 Agent 操作失败时，最多自动修复两轮
        </label>
        <p v-if="detail.zeroAiVerified" class="text-xs leading-relaxed text-muted-foreground">
          回放会重新执行用例步骤。涉及新增或修改时，请先确认目标环境的测试数据满足用例前置条件。
        </p>
        <div class="flex flex-wrap items-center gap-2.5">
          <Button v-if="detail.status !== 'deprecated'" variant="secondary" :disabled="!detail.scriptPath || dirty || starting || generationBusy || generationNeedsRefresh" @click="onTrialRun">
            <Play data-icon="inline-start" />
            {{ detail.zeroAiVerified || detail.status === 'published' ? '零 AI 回放' : '开始探索' }}
          </Button>
          <Button v-if="detail.status === 'trial-passed' && detail.zeroAiVerified" variant="outline" :disabled="dirty || generationBusy || generationNeedsRefresh" @click="publishConfirm = true">
            发布用例
          </Button>
          <Button v-if="locked" variant="outline" @click="newVersion">创建新版本</Button>
        </div>
      </CardContent>
    </Card>

    <ConfirmDialog
      v-model:open="publishConfirm"
      title="发布用例"
      description="确认发布该用例？发布后进入只读状态。"
      confirm-text="发布"
      @confirm="onPublish"
    />

    <!-- 脚本查看 -->
    <Dialog v-model:open="scriptDlg.open">
      <DialogContent class="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle class="font-mono text-sm">{{ scriptDlg.path || '测试脚本' }}</DialogTitle>
          <DialogDescription>此版本的 TesterArmy/e2e 执行脚本</DialogDescription>
        </DialogHeader>
        <pre class="at-log max-h-[55vh]">{{ scriptDlg.content }}</pre>
        <DialogFooter>
          <Button variant="outline" @click="scriptDlg.open = false">关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
