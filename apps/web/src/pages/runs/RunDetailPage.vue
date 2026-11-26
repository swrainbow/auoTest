<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ExternalLink, FileText, Stethoscope } from '@lucide/vue';
import { toast } from 'vue-sonner';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { cancelRun, createRun, diagnoseRun, getCase, getRun, getRunArtifacts, getRunLog, messageOf, repairRun } from '@/api/client';
import { MODE_TEXT, RUN_STATUS_BADGE, RUN_STATUS_TEXT, formatDuration, formatTime } from '@/utils/format';
import StatusBadge from '@/components/StatusBadge.vue';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { TestCaseDto, TestRunDto } from '@autotest/shared';
import { failedOrder, groupRunSteps, summarizeRunFailure } from '@/utils/run-report';

const SKILL_LEARNING_TEXT = {
  recorded: '已写入业务 Skill',
  'pending-verification': '等待严格回放验证后写入 Skill',
  skipped: '未写入业务 Skill',
  failed: '写入业务 Skill 失败',
};

const route = useRoute();
const router = useRouter();
const runId = computed(() => Number(route.params.id));

const run = shallowRef<TestRunDto | null>(null);
const repairSource = shallowRef<TestRunDto | null>(null);
const repairTrial = shallowRef<TestRunDto | null>(null);
const verificationCase = shallowRef<TestCaseDto | null>(null);
const verificationTrial = shallowRef<TestRunDto | null>(null);
const log = ref('');
const artifacts = ref<string[]>([]);
const logBox = ref<HTMLPreElement | null>(null);
const diagnosing = ref(false);
const repairing = ref(false);
const repairRequestError = ref('');
const verificationError = ref('');
const startingVerification = ref(false);
let repairRequest = 0;
let verificationRequest = 0;
let timer: ReturnType<typeof setInterval> | null = null;

const isLive = computed(() => run.value?.status === 'running' || run.value?.status === 'queued');
const repairActive = computed(() => ['pending', 'running', 'queued'].includes(run.value?.repairState ?? ''));
const prerequisite = computed(() => run.value?.summary?.prerequisite);
const verificationDeferred = computed(() => run.value?.summary?.verificationDeferred);
const verifiesSimulationCreation = computed(() => verificationDeferred.value?.kind === 'simulation-instance');
const verificationCaseId = computed(() => verificationDeferred.value ? run.value?.testCaseId : null);
const verificationRunId = computed(() => verificationDeferred.value ? run.value?.verificationRunId : null);
const verificationActive = computed(() => ['queued', 'running'].includes(verificationTrial.value?.status ?? ''));
const canStartVerification = computed(() => {
  const testCase = verificationCase.value;
  const item = run.value;
  if (!verificationDeferred.value || !testCase || !item || testCase.id !== item.testCaseId) return false;
  if (testCase.status === 'deprecated' || testCase.currentVersion !== item.version || testCase.zeroAiVerified) return false;
  return !verificationActive.value && verificationTrial.value?.status !== 'passed';
});
const verificationStatus = computed(() => {
  const testCase = verificationCase.value;
  if (!testCase) return '';
  if (testCase.status === 'deprecated') return '用例已停用。';
  if (testCase.currentVersion !== run.value?.version) return `当前用例已更新至 v${testCase.currentVersion}，请从当前版本发起验证。`;
  if (testCase.zeroAiVerified || verificationTrial.value?.status === 'passed') return '此版本已通过零 AI 验证。';
  if (verificationTrial.value?.status === 'warning') return '严格回放以告警结束，此版本仍待验证。';
  if (verificationActive.value) return '严格回放验证已提交。';
  return '';
});
const updatedSkillFiles = computed(() => {
  const summary = run.value?.summary;
  if (summary?.skillFiles?.length) return summary.skillFiles;
  return summary?.skillFile ? [summary.skillFile] : [];
});
const skillLearning = computed(() => run.value?.summary?.skillLearning);
const warning = computed(() => run.value?.status === 'warning' ? run.value.summary?.warning : undefined);
const stepGroups = computed(() => groupRunSteps(run.value));
const failure = computed(() => summarizeRunFailure(run.value, stepGroups.value));

function describeTrial(source: TestRunDto | null, trial: TestRunDto, label: string): string {
  if (trial.status === 'passed') return label + '通过';
  if (trial.status === 'warning') return label + '以告警结束';
  if (trial.status === 'canceled') return label + '已取消';
  if (trial.status === 'running') return label + '进行中';
  if (trial.status === 'queued') return label + '已排队';
  const prior = failedOrder(source);
  const next = failedOrder(trial);
  if (prior === undefined || next === undefined) return label + '未通过';
  if (next > prior) return `${label}已通过原失败的第 ${prior} 步，在第 ${next} 步遇到新问题`;
  if (next < prior) return `${label}在第 ${next} 步提前失败，原运行到达第 ${prior} 步`;
  return `${label}在第 ${next} 步再次失败`;
}

const repairOutcome = computed(() => run.value?.repairOf ? describeTrial(repairSource.value, run.value, '修复试跑') : '');
const repairProgress = computed(() => {
  const item = run.value;
  if (!item) return '';
  const state = item.repairState;
  if (state === 'pending') return item.repairOf ? '下一轮修复等待生成' : '等待生成修复版本';
  if (state === 'running') return item.repairOf ? '正在生成下一轮修复版本' : '正在生成修复版本';
  if (state === 'queued') return '修复版本已生成，正在等待试跑结果';
  if (state === 'regressed') return '已停止自动修复';
  const label = item.repairOf ? '后续试跑' : '修复试跑';
  if (item.repairRunId && repairTrial.value) return describeTrial(item, repairTrial.value, label);
  if (state === 'trial-passed') return label + '通过';
  if (state === 'warning') return label + '以告警结束';
  if (state === 'failed' && item.repairRunId) return label + '未通过';
  if (state === 'failed' && !item.repairAvailability?.reason) return '修复版本未生成';
  return '';
});
const canDiagnose = computed(
  () => !!run.value?.testCaseId && !isLive.value && ['failed', 'timeout', 'error'].includes(run.value?.status ?? ''),
);
const repairAvailability = computed(() => run.value?.repairAvailability);
const canRepair = computed(() => {
  if (repairAvailability.value) return repairAvailability.value.canStart;
  return canDiagnose.value && prerequisite.value?.status !== 'failed' &&
    !run.value?.repairRunId && run.value?.repairState !== 'regressed' &&
    run.value?.summary?.failedBusinessStep !== null && run.value?.summary?.failedCallKind !== null;
});
const repairUnavailableReason = computed(() => {
  const availability = repairAvailability.value;
  if (!availability || availability.canStart || availability.reason === repairRequestError.value) return '';
  return availability.reason ?? '';
});
const currentPassedRun = computed(() => {
  const item = run.value;
  const id = repairAvailability.value?.currentRunId;
  return item && id && ![item.id, item.repairOf, item.repairRunId, item.verificationRunId].includes(id) ? id : null;
});
const diagnosisHtml = computed(() =>
  run.value?.diagnosis ? DOMPurify.sanitize(marked.parse(run.value.diagnosis, { async: false })) : '',
);

async function load(): Promise<void> {
  const id = runId.value;
  if (!Number.isInteger(id)) return;
  const [r, l, a] = await Promise.all([
    getRun(id),
    getRunLog(id).catch(() => ({ log: '' })),
    getRunArtifacts(id).catch(() => ({ files: [] as string[] })),
  ]);
  if (runId.value !== id) return;
  run.value = r;
  log.value = l.log;
  artifacts.value = a.files;
  if (isLive.value) setTimeout(() => logBox.value?.scrollTo({ top: logBox.value.scrollHeight }), 50);
}

async function onCancel(): Promise<void> {
  await cancelRun(runId.value);
  toast.success('已发送取消信号');
  void load();
}

async function onDiagnose(): Promise<void> {
  diagnosing.value = true;
  try {
    run.value = await diagnoseRun(runId.value);
    toast.success('诊断完成');
  } finally {
    diagnosing.value = false;
  }
}

function artifactUrl(file: string): string {
  return `/artifacts/run-${runId.value}/${file.split('/').map(encodeURIComponent).join('/')}`;
}

async function onRepair(): Promise<void> {
  if (!canRepair.value || repairing.value || repairActive.value) return;
  const id = runId.value;
  const request = ++repairRequest;
  repairRequestError.value = '';
  repairing.value = true;
  try {
    const next = await repairRun(id);
    if (request === repairRequest) await router.push(`/runs/${next.id}`);
  } catch (error) {
    if (request !== repairRequest) return;
    repairRequestError.value = messageOf(error) || '修复请求未完成，请重试。';
    const updated = await getRun(id).catch(() => null);
    if (request === repairRequest && updated) run.value = updated;
  } finally {
    if (request === repairRequest) repairing.value = false;
  }
}

async function onVerify(): Promise<void> {
  const item = run.value;
  if (!canStartVerification.value || startingVerification.value || !item?.testCaseId || item.version == null) return;
  const request = ++verificationRequest;
  startingVerification.value = true;
  verificationError.value = '';
  try {
    const next = await createRun({ testCaseId: item.testCaseId, version: item.version, mode: 'strict', verificationOf: item.id });
    if (request === verificationRequest) await router.push(`/runs/${next.id}`);
  } catch (error) {
    if (request === verificationRequest) verificationError.value = messageOf(error);
  } finally {
    if (request === verificationRequest) startingVerification.value = false;
  }
}

watch(runId, () => {
  repairRequest++;
  verificationRequest++;
  repairing.value = false;
  repairRequestError.value = '';
  verificationCase.value = null;
  verificationTrial.value = null;
  startingVerification.value = false;
  verificationError.value = '';
  run.value = null;
  void load();
});
watch([verificationCaseId, verificationRunId], async ([caseId, trialId], _old, onCleanup) => {
  let stale = false;
  onCleanup(() => { stale = true; });
  if (!caseId) return;
  const [testCase, trial] = await Promise.all([
    getCase(caseId, { silent: true }).catch(() => null),
    trialId ? getRun(trialId).catch(() => null) : null,
  ]);
  if (!stale) {
    verificationCase.value = testCase;
    verificationTrial.value = trial;
  }
});
watch(
  [() => run.value?.repairOf, () => run.value?.repairRunId, () => run.value?.repairState],
  async ([source, trial], _old, onCleanup) => {
    let stale = false;
    onCleanup(() => { stale = true; });
    const fetchRelated = (id: number | null | undefined) => id ? getRun(id).catch(() => null) : null;
    if (repairSource.value?.id !== source) repairSource.value = null;
    if (repairTrial.value?.id !== trial) repairTrial.value = null;
    const [origin, retry] = await Promise.all([repairSource.value || fetchRelated(source), fetchRelated(trial)]);
    if (stale) return;
    repairSource.value = origin;
    repairTrial.value = retry;
  },
);
watch(
  () => run.value?.status === 'passed' && run.value.verificationOf && skillLearning.value?.status === 'pending-verification'
    ? run.value.id : null,
  (id, _old, onCleanup) => {
    if (!id) return;
    const refresh = setTimeout(() => void load().catch(() => undefined), 2000);
    onCleanup(() => clearTimeout(refresh));
  },
);
onMounted(() => {
  void load();
  timer = setInterval(() => {
    if (isLive.value || repairActive.value) void load();
  }, 2000);
});
onBeforeUnmount(() => {
  repairRequest++;
  verificationRequest++;
  if (timer) clearInterval(timer);
});
</script>

<template>
  <div v-if="run" class="flex flex-col gap-4">
    <!-- 头部 -->
    <Card>
      <CardContent class="flex flex-col gap-4 pt-6">
        <div class="flex flex-col items-start justify-between gap-3 sm:flex-row">
          <div class="min-w-0">
            <div class="flex items-center gap-2.5">
              <span class="text-lg font-semibold tracking-tight">执行 #{{ run.id }}</span>
              <StatusBadge
                :text="RUN_STATUS_TEXT[run.status] ?? run.status"
                :type="RUN_STATUS_BADGE[run.status] ?? 'neutral'"
                :dot="run.status === 'running'"
              />
            </div>
            <div class="mt-1.5 text-xs text-muted-foreground wrap-anywhere">
              <RouterLink v-if="run.testCaseId" :to="`/cases/${run.testCaseId}/edit`" class="underline">{{ run.testCaseCode }} · {{ run.testCaseName }}</RouterLink>
              <span v-if="run.version"> · v{{ run.version }}</span>
              · {{ MODE_TEXT[run.mode] ?? run.mode }}
            </div>
          </div>
          <div class="flex shrink-0 flex-wrap gap-2">
            <Button v-if="canRepair || repairing" size="sm" :disabled="repairing || repairActive" @click="onRepair">
              {{ repairing || repairActive ? '修复中…' : repairAvailability?.label || 'AI 修复并试跑' }}
            </Button>
            <Button
              v-if="canDiagnose"
              variant="outline"
              size="sm"
              :disabled="diagnosing"
              @click="onDiagnose"
            >
              <Stethoscope data-icon="inline-start" />
              {{ diagnosing ? '诊断中…' : 'AI 诊断' }}
            </Button>
            <Button v-if="isLive" variant="destructive" size="sm" @click="onCancel">取消执行</Button>
          </div>
        </div>

        <div class="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-7">
          <div>
            <div class="text-xs text-muted-foreground">开始时间</div>
            <div class="mt-1 text-[13px] font-semibold">{{ formatTime(run.startedAt) }}</div>
          </div>
          <div>
            <div class="text-xs text-muted-foreground">结束时间</div>
            <div class="mt-1 text-[13px] font-semibold">{{ formatTime(run.finishedAt) }}</div>
          </div>
          <div>
            <div class="text-xs text-muted-foreground">耗时</div>
            <div class="mt-1 text-[13px] font-semibold">{{ formatDuration(run.durationMs) }}</div>
          </div>
          <div>
            <div class="text-xs text-muted-foreground">退出码</div>
            <div class="mt-1 text-[13px] font-semibold">{{ run.exitCode ?? '-' }}</div>
          </div>
          <div>
            <div class="text-xs text-muted-foreground">运行器模型调用</div>
            <div class="mt-1 text-[13px] font-semibold">{{ run.aiCalls ?? '—' }}</div>
          </div>
          <div>
            <div class="text-xs text-muted-foreground">缓存命中</div>
            <div class="mt-1 text-[13px] font-semibold">{{ run.cacheHits ?? '—' }}</div>
          </div>
          <div>
            <div class="text-xs text-muted-foreground">通过 / 失败 / 告警 / 总数</div>
            <div class="mt-1 text-[13px] font-semibold">
              <span class="text-emerald-600">{{ run.summary?.passed ?? '-' }}</span> /
              <span class="text-red-600">{{ run.summary?.failed ?? '-' }}</span> /
              <span class="text-status-warning-foreground">{{ run.summary ? run.summary.warnings ?? 0 : '-' }}</span> /
              {{ run.summary?.total ?? '-' }}
            </div>
          </div>
        </div>
        <div v-if="run.repairRunId || run.repairOf || run.verificationRunId || run.verificationOf || repairProgress || repairUnavailableReason || currentPassedRun" class="flex flex-col gap-1.5 rounded-lg bg-muted/60 px-3.5 py-2.5 text-sm">
          <p v-if="repairOutcome" class="font-medium">{{ repairOutcome }}</p>
          <p v-if="repairProgress" class="font-medium">{{ repairProgress }}</p>
          <p v-if="repairUnavailableReason" class="text-muted-foreground wrap-anywhere">{{ repairUnavailableReason }}</p>
          <div class="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
            <RouterLink v-if="run.repairOf" :to="`/runs/${run.repairOf}`" class="underline underline-offset-2">原失败 #{{ run.repairOf }}</RouterLink>
            <RouterLink v-if="run.repairRunId" :to="`/runs/${run.repairRunId}`" class="underline underline-offset-2">修复试跑 #{{ run.repairRunId }}</RouterLink>
            <RouterLink v-if="run.verificationRunId" :to="`/runs/${run.verificationRunId}`" class="underline underline-offset-2">严格回放验证 #{{ run.verificationRunId }}</RouterLink>
            <RouterLink v-if="run.verificationOf" :to="`/runs/${run.verificationOf}`" class="underline underline-offset-2">触发本次验证的探索 #{{ run.verificationOf }}</RouterLink>
            <RouterLink v-if="currentPassedRun" :to="`/runs/${currentPassedRun}`" class="font-medium text-primary underline underline-offset-2">当前版本通过记录 #{{ currentPassedRun }}</RouterLink>
          </div>
        </div>

        <div v-if="verificationDeferred" class="flex flex-col gap-2 rounded-lg border px-3.5 py-2.5 text-sm wrap-anywhere">
          <p class="font-semibold">{{ run.verificationRunId ? '严格回放验证' : '自动严格回放已暂缓' }}</p>
          <p v-if="verifiesSimulationCreation" class="text-muted-foreground">本次探索已创建仿真实例「{{ verificationDeferred.name }}」。完整回放会再次执行创建步骤。</p>
          <p v-else class="text-muted-foreground">本次探索已创建「{{ verificationDeferred.name }}」。同名配置仍存在时，回放会在查重步骤停止。</p>
          <p v-if="verificationStatus" class="text-muted-foreground">{{ verificationStatus }}</p>
          <template v-if="canStartVerification">
            <p id="verification-data-preparation" class="text-muted-foreground">{{
              verifiesSimulationCreation
                ? '手动验证时，若已有同名仿真实例，回放会在新增前停止并记录告警。'
                : '请先确认同名记录的归属并恢复测试数据，再验证严格回放。'
            }}</p>
            <Button size="sm" class="self-start" :disabled="startingVerification" aria-describedby="verification-data-preparation" @click="onVerify">
              {{ startingVerification ? '正在提交验证…' : '验证严格回放' }}
            </Button>
          </template>
          <p v-if="verificationError" role="alert" class="text-destructive">{{ verificationError }}</p>
        </div>

        <div v-if="repairRequestError" role="alert" class="rounded-lg border border-destructive/25 bg-status-failure px-3.5 py-2.5 text-[13px] text-status-failure-foreground wrap-anywhere">
          <p class="font-semibold">修复请求未完成</p>
          <p class="mt-1 whitespace-pre-line">{{ repairRequestError }}</p>
        </div>

        <div v-if="skillLearning || updatedSkillFiles.length" class="text-sm">
          <p class="font-medium">{{ skillLearning ? SKILL_LEARNING_TEXT[skillLearning.status] : '已写入业务 Skill' }}</p>
          <p v-if="skillLearning?.reason" class="mt-1 text-muted-foreground wrap-anywhere">{{ skillLearning.reason }}</p>
          <ul v-if="updatedSkillFiles.length" class="mt-1 flex list-disc flex-col gap-1 pl-5 text-muted-foreground wrap-anywhere">
            <li v-for="file in updatedSkillFiles" :key="file">{{ file }}</li>
          </ul>
        </div>

        <div v-if="prerequisite" class="flex items-center gap-2 text-sm">
          <span>前置检查</span>
          <StatusBadge :text="RUN_STATUS_TEXT[prerequisite.status]" :type="prerequisite.status" />
        </div>

        <div
          v-if="warning"
          role="status"
          class="rounded-lg border border-status-warning-foreground/25 bg-status-warning px-3.5 py-2.5 text-[13px] text-status-warning-foreground wrap-anywhere"
        >
          <p class="font-semibold">第 {{ warning.step }} 步 · 告警</p>
          <p class="mt-1 whitespace-pre-line">{{ warning.message }}</p>
        </div>
        <div
          v-else-if="(run.error || run.summary?.testDataConflict) && failure"
          class="rounded-lg border border-destructive/25 bg-status-failure px-3.5 py-2.5 text-[13px] text-status-failure-foreground wrap-anywhere"
        >
          <p class="font-semibold">{{ failure.title }}</p>
          <p v-if="failure.action" class="mt-1">{{ failure.action }}</p>
          <p v-if="failure.hint" class="mt-1">{{ failure.hint }}</p>
          <details v-if="failure.action && run.error" class="mt-1.5">
            <summary class="w-fit cursor-pointer">查看原始错误</summary>
            <p class="mt-1 whitespace-pre-line">{{ run.error }}</p>
          </details>
          <p v-else-if="run.error" class="mt-1 whitespace-pre-line">{{ run.error }}</p>
        </div>
      </CardContent>
    </Card>

    <Card v-if="stepGroups.length">
      <CardHeader><CardTitle class="text-[15px]">执行步骤</CardTitle></CardHeader>
      <CardContent>
        <ol class="space-y-2 text-sm">
          <li v-for="group in stepGroups" :key="group.key" class="rounded-lg border px-3.5 py-2.5" :class="{ 'border-destructive/25': group.status === 'failed', 'border-status-warning-foreground/25': group.status === 'warning' }">
            <details :open="group.status === 'failed' || group.status === 'warning'">
              <summary class="cursor-pointer text-muted-foreground wrap-anywhere">
                <span class="font-medium text-foreground">
                  <template v-if="group.business">第 {{ group.business.order }} 步 · {{ group.business.action }}</template>
                  <template v-else>{{ prerequisite ? '前置检查或未归组记录' : '未归组记录' }}</template>
                </span>
                <StatusBadge class="ml-2" :text="RUN_STATUS_TEXT[group.status] ?? '已记录'" :type="RUN_STATUS_BADGE[group.status] ?? 'neutral'" />
                <span class="ml-2 text-xs tabular-nums">{{ formatDuration(group.durationMs) }}</span>
              </summary>
              <p v-if="group.business" class="mt-2 text-xs text-muted-foreground wrap-anywhere">业务预期：{{ group.business.expected }}</p>
              <ol class="mt-2 divide-y border-t text-xs">
                <li
                  v-for="(step, index) in group.steps"
                  :key="index"
                  class="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2 py-1.5"
                  :class="step.error ? 'text-destructive' : 'text-muted-foreground'"
                >
                  <span>{{ RUN_STATUS_TEXT[step.status] ?? step.status }}</span>
                  <div class="wrap-anywhere">
                    <p>{{ step.callKind === 'check' ? '业务断言 · ' : '' }}{{ step.api }}<template v-if="step.label && step.label !== step.api"> · {{ step.label }}</template></p>
                    <p v-if="step.error?.message" class="mt-0.5 whitespace-pre-line">{{ step.error.message }}</p>
                  </div>
                  <span class="tabular-nums">{{ formatDuration(step.durationMs) }}</span>
                </li>
              </ol>
            </details>
          </li>
        </ol>
      </CardContent>
    </Card>

    <!-- AI 诊断报告 -->
    <Card v-if="diagnosisHtml">
      <CardHeader>
        <CardTitle class="text-[15px]">AI 诊断与修复说明</CardTitle>
      </CardHeader>
      <CardContent>
        <!-- 内容经 DOMPurify 消毒 -->
        <div class="at-md-preview max-h-[480px]" v-html="diagnosisHtml" />
      </CardContent>
    </Card>

    <!-- 日志 -->
    <Card>
      <CardHeader class="flex flex-row items-center justify-between space-y-0">
        <CardTitle class="text-[15px]">执行日志</CardTitle>
        <span v-if="isLive" class="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span class="size-1.5 animate-pulse rounded-full bg-indigo-500" />
          实时刷新中
        </span>
      </CardHeader>
      <CardContent>
        <pre ref="logBox" class="at-log">{{ log || '（等待输出…）' }}</pre>
      </CardContent>
    </Card>

    <!-- 证据 -->
    <Card>
      <CardHeader>
        <CardTitle class="text-[15px]">执行证据</CardTitle>
        <CardDescription>本次执行归档的产物（日志 / 报告 / Trace）</CardDescription>
        <CardAction v-if="!isLive">
          <Button as-child size="sm">
            <RouterLink :to="{ name: 'run-report', params: { id: run.id } }" target="_blank" rel="noopener">
              查看测试报告
              <ExternalLink data-icon="inline-end" aria-hidden="true" />
              <span class="sr-only">（在新标签页打开）</span>
            </RouterLink>
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent class="flex flex-col">
        <template v-if="artifacts.length">
          <a
            v-for="f in artifacts"
            :key="f"
            :href="artifactUrl(f)"
            target="_blank"
            rel="noopener"
            class="flex items-center gap-2 border-b py-2 text-[13px] transition-colors hover:underline last:border-b-0"
          >
            <FileText class="size-3.5 shrink-0 text-muted-foreground/70" />
            <span class="min-w-0 font-mono wrap-anywhere">{{ f }}</span>
          </a>
        </template>
        <div v-else class="text-xs text-muted-foreground">暂无证据文件</div>
      </CardContent>
    </Card>
  </div>
</template>
