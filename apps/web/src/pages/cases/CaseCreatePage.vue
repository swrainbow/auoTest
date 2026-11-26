<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ArrowDown, ArrowUp, Plus, Wand2, X } from '@lucide/vue';
import { toast } from 'vue-sonner';
import { createCase, generatePlan, getCaseSkills, getSettings } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldGroup } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import type { BusinessStep, CasePrerequisite, GeneratedPlan, SkillDto } from '@autotest/shared';
import CasePrerequisiteFields from './CasePrerequisiteFields.vue';
import StepSkillSelect from './StepSkillSelect.vue';

type EditableStep = BusinessStep & { key: number };
type EditablePlan = Omit<GeneratedPlan, 'steps'> & { steps: EditableStep[] };

const router = useRouter();
const requirement = ref('');
const generating = ref(false);
const saving = ref(false);
const plan = ref<EditablePlan | null>(null);
let nextStepKey = 0;
const plannedRequirement = ref('');
const modelReady = ref<boolean>();
const skills = ref<SkillDto[]>([]);
const skill = ref('auto');
const taskId = ref('');
const prerequisiteSkill = ref<string>();
const prerequisite = ref<CasePrerequisite>();
const validatePrerequisite = ref(false);
onMounted(() => {
  void getCaseSkills().then((available) => {
    skills.value = available.business;
    prerequisiteSkill.value = available.prerequisite;
  }).catch(() => undefined);
  void getSettings().then((settings) => { modelReady.value = settings.model.configured; }).catch(() => undefined);
});

const form = reactive({
  name: '',
  module: '',
  priority: 'P1' as GeneratedPlan['priority'],
});

async function onGenerate(): Promise<void> {
  if (!requirement.value.trim()) {
    toast.warning('请先描述测试目标');
    return;
  }
  generating.value = true;
  plan.value = null;
  try {
    const request = requirement.value;
    const result = await generatePlan(request, skill.value === 'auto' ? undefined : skill.value, taskId.value.trim());
    plannedRequirement.value = request;
    plan.value = { ...result, steps: result.steps.map((step) => ({ ...step, key: nextStepKey++ })) };
    form.name = result.name;
    form.module = result.module;
    form.priority = result.priority;
  } catch {
    // 错误信息已由拦截器 toast 提示（模型未配置 / 调用失败等）
  } finally {
    generating.value = false;
  }
}

function startManual(): void {
  plannedRequirement.value = requirement.value;
  plan.value = {
    name: '', module: '通用', priority: 'P1', steps: [],
    skill: skill.value === 'auto' ? '' : skill.value, taskId: taskId.value.trim(),
  };
  form.name = '';
  form.module = '通用';
  form.priority = 'P1';
}

function addStep(): void {
  if (!plan.value) return;
  plan.value.steps.push({ key: nextStepKey++, order: plan.value.steps.length + 1, action: '', expected: '' });
  reorder();
}

function removeStep(index: number): void {
  plan.value?.steps.splice(index, 1);
  reorder();
}

function move(index: number, dir: -1 | 1): void {
  if (!plan.value) return;
  const target = index + dir;
  if (target < 0 || target >= plan.value.steps.length) return;
  const steps = plan.value.steps;
  [steps[index], steps[target]] = [steps[target]!, steps[index]!];
  reorder();
}

function reorder(): void {
  plan.value?.steps.forEach((s, i) => (s.order = i + 1));
}

async function onSave(): Promise<void> {
  if (!plan.value) return;
  validatePrerequisite.value = true;
  if (prerequisite.value && !prerequisite.value.mapName.trim()) return;
  const steps = plan.value.steps;
  if (!steps.length || steps.some((s) => !s.action.trim() || !s.expected.trim())) {
    toast.warning('每个业务步骤都需要动作与预期');
    return;
  }
  if (!form.name.trim()) {
    toast.warning('请填写用例名称');
    return;
  }
  saving.value = true;
  try {
    const created = await createCase({
      name: form.name.trim(),
      module: form.module.trim() || '通用',
      priority: form.priority,
      steps: steps.map(({ order, action, expected, skill }) => ({ order, action: action.trim(), expected: expected.trim(), skill })),
      description: plannedRequirement.value.trim(),
      originalRequirement: plannedRequirement.value.trim() ? plannedRequirement.value : undefined,
      skill: plan.value.skill,
      taskId: plan.value.taskId,
      prerequisite: prerequisite.value,
    });
    toast.success(`已创建 ${created.code}「${created.name}」`);
    router.push(`/cases/${created.id}/edit`);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="grid grid-cols-1 items-start gap-4 lg:grid-cols-[45fr_55fr]">
    <!-- 左：需求输入 -->
    <Card>
      <CardHeader>
        <CardTitle class="text-[15px]">自然语言测试目标</CardTitle>
        <CardDescription>结合「Skill 管理」中的业务知识生成测试计划，确认后保存为用例</CardDescription>
      </CardHeader>
      <CardContent class="flex flex-col gap-3.5">
        <FieldGroup class="grid gap-3 sm:grid-cols-2">
          <Field>
            <Label for="plan-skill">默认业务 Skill</Label>
            <Select v-model="skill">
              <SelectTrigger id="plan-skill" class="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="auto">自动匹配</SelectItem>
                  <SelectItem v-for="item in skills" :key="item.dir" :value="item.dir">{{ item.name }}</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <Label for="plan-task">任务 ID（可选）</Label>
            <Input id="plan-task" v-model="taskId" placeholder="例如 task-e2e-001" />
          </Field>
        </FieldGroup>
        <CasePrerequisiteFields
          id="plan-prerequisite"
          v-model="prerequisite"
          :available-skill="prerequisiteSkill"
          :disabled="saving"
          :validate="validatePrerequisite"
        />
        <Textarea
          v-model="requirement"
          aria-label="自然语言测试目标"
          :rows="10"
          placeholder="示例：打开测试任务，在指定移动节点的创建时添加校验 Hook，将货物状态和锁定状态设为不校验，保存并刷新，验证配置正确。"
        />
        <div>
          <Button :disabled="generating" @click="onGenerate">
            <Wand2 data-icon="inline-start" />
            {{ generating ? '生成中…' : '生成测试计划' }}
          </Button>
        </div>
        <div v-if="modelReady === false" class="rounded-lg border bg-muted/40 px-3.5 py-3 text-xs leading-relaxed text-muted-foreground">
          配置模型后即可生成测试计划。<RouterLink to="/settings" class="underline">查看模型设置</RouterLink>
        </div>
      </CardContent>
    </Card>

    <!-- 右：计划确认 -->
    <Card>
      <CardHeader class="flex flex-row items-start justify-between space-y-0">
        <div class="flex flex-col gap-1.5">
          <CardTitle class="text-[15px]">测试计划</CardTitle>
          <CardDescription>{{ plan ? '请确认业务步骤与预期结果，可直接编辑' : '生成或手动添加步骤后确认' }}</CardDescription>
        </div>
        <Button v-if="!plan" variant="outline" size="sm" :disabled="generating" @click="startManual">手动新建</Button>
      </CardHeader>
      <CardContent class="flex flex-col gap-3">
        <template v-if="plan">
          <p class="text-xs text-muted-foreground">
            默认 Skill · {{ skills.find((item) => item.dir === plan?.skill)?.name || plan.skill || '自动匹配' }}{{ plan.taskId ? ' · ' + plan.taskId : '' }}
          </p>
          <div class="grid grid-cols-[1fr_140px_90px] gap-2.5">
            <Field>
              <Label for="plan-name">用例名称</Label>
              <Input id="plan-name" v-model="form.name" />
            </Field>
            <Field>
              <Label for="plan-module">业务模块</Label>
              <Input id="plan-module" v-model="form.module" />
            </Field>
            <Field>
              <Label>优先级</Label>
              <Select v-model="form.priority">
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
          </div>

          <div v-if="plan.notes" class="rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-xs leading-relaxed text-amber-700">
            {{ plan.notes }}
          </div>

          <div
            v-for="(step, i) in plan.steps"
            :key="step.key"
            role="group"
            :aria-label="`第 ${i + 1} 步`"
            class="flex items-start gap-2.5 rounded-xl border p-3"
          >
            <div class="mt-1 grid size-5.5 shrink-0 place-items-center rounded-md bg-muted text-xs font-semibold text-muted-foreground">
              {{ i + 1 }}
            </div>
            <div class="flex min-w-0 flex-1 flex-col gap-1.5">
              <div class="flex items-center gap-2">
                <Label :for="`plan-step-action-${step.key}`" class="w-8 shrink-0 text-xs text-muted-foreground">动作</Label>
                <Input :id="`plan-step-action-${step.key}`" v-model="step.action" :disabled="saving" class="h-8 text-xs" />
              </div>
              <div class="flex items-center gap-2">
                <Label :for="`plan-step-expected-${step.key}`" class="w-8 shrink-0 text-xs text-muted-foreground">预期</Label>
                <Input :id="`plan-step-expected-${step.key}`" v-model="step.expected" :disabled="saving" class="h-8 text-xs" />
              </div>
              <StepSkillSelect :id="`plan-step-skill-${step.key}`" v-model="step.skill" :skills="skills" :disabled="saving" />
            </div>
            <div class="flex shrink-0 flex-col gap-0.5">
              <Button variant="ghost" size="icon-xs" :aria-label="`上移第 ${i + 1} 步`" :disabled="saving || i === 0" @click="move(i, -1)">
                <ArrowUp aria-hidden="true" />
              </Button>
              <Button variant="ghost" size="icon-xs" :aria-label="`下移第 ${i + 1} 步`" :disabled="saving || i === plan.steps.length - 1" @click="move(i, 1)">
                <ArrowDown aria-hidden="true" />
              </Button>
              <Button variant="ghost" size="icon-xs" class="text-destructive" :aria-label="`删除第 ${i + 1} 步`" :disabled="saving" @click="removeStep(i)">
                <X aria-hidden="true" />
              </Button>
            </div>
          </div>

          <div class="flex items-center gap-2.5">
            <Button variant="outline" :disabled="saving" @click="addStep">
              <Plus data-icon="inline-start" />
              添加步骤
            </Button>
            <div class="flex-1" />
            <Button :disabled="!plan.steps.length || saving" @click="onSave">{{ saving ? '保存中…' : '保存为用例' }}</Button>
          </div>
        </template>

        <div v-else class="flex flex-col items-center gap-2 py-16 text-muted-foreground">
          <Wand2 class="size-7 text-muted-foreground/40" />
          <p class="text-[13px]">生成的计划将在这里展示，供业务人员确认</p>
        </div>
      </CardContent>
    </Card>
  </div>
</template>
