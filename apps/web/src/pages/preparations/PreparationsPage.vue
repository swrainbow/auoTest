<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { History, ListChecks, Play, RefreshCw, Settings2 } from '@lucide/vue';
import { toast } from 'vue-sonner';
import type { PreparationFlow, PreparationRule, PreparationWorkspace } from '@autotest/shared';
import { getPreparations, messageOf, startPreparation } from '@/api/client';
import StatusBadge from '@/components/StatusBadge.vue';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { formatTime, RUN_STATUS_BADGE, RUN_STATUS_TEXT } from '@/utils/format';
import PreparationEditor from './PreparationEditor.vue';
import PreparationReport from './PreparationReport.vue';
import { flowLabel, selectionLabel } from './labels';

const route = useRoute();
const router = useRouter();
const tabs = [
  { key: 'run', label: '运行准备', icon: Play },
  { key: 'edit', label: '流程与规则', icon: Settings2 },
  { key: 'history', label: '运行记录', icon: History },
] as const;
const view = computed(() => tabs.find(tab => tab.key === route.query.view)?.key ?? 'run');
const workspace = shallowRef<PreparationWorkspace>();
const loading = ref(false);
const loadError = ref('');
const runError = ref('');
const flowId = ref('');
const selectedFlow = computed(() => workspace.value?.flows.find(flow => flow.id === flowId.value));
const selectedRule = computed(() => workspace.value?.rules.find(rule => rule.version === selectedFlow.value?.ruleVersion));
const needsMap = computed(() => selectedFlow.value?.steps.includes('map-binding') ?? false);
const needsService = computed(() => needsMap.value && selectedRule.value?.selection === 'explicit');
const mapName = ref('');
const serviceName = ref('');
const submitting = ref(false);
const history = computed(() => [...workspace.value?.runs ?? []].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
const selectedRunId = ref('');
const selectedRun = computed(() => history.value.find(run => run.id === selectedRunId.value) ?? history.value[0]);
const currentRun = computed(() => history.value.find(run => run.flowId === flowId.value));
const running = computed(() => history.value.some(run => run.status === 'queued' || run.status === 'running'));
let poll: ReturnType<typeof setTimeout> | undefined;
let loadNumber = 0;
let disposed = false;

function updateWorkspace(patch: Partial<PreparationWorkspace>) {
  if (workspace.value) workspace.value = { ...workspace.value, ...patch };
}

function scheduleRefresh() {
  clearTimeout(poll);
  if (!disposed && running.value) poll = setTimeout(() => void refresh(), 2000);
}

async function refresh() {
  const request = ++loadNumber;
  loading.value = true;
  try {
    const updated = await getPreparations();
    if (request !== loadNumber) return;
    workspace.value = updated;
    if (!updated.flows.some(flow => flow.id === flowId.value)) flowId.value = updated.flows[0]?.id ?? '';
    loadError.value = '';
  } catch (error) {
    if (request === loadNumber) loadError.value = messageOf(error);
  } finally {
    if (request === loadNumber) {
      loading.value = false;
      scheduleRefresh();
    }
  }
}

function ruleSaved(rule: PreparationRule) {
  if (!workspace.value) return;
  ++loadNumber;
  loading.value = false;
  updateWorkspace({ rules: [rule, ...workspace.value.rules.filter(item => item.version !== rule.version)] });
  scheduleRefresh();
}

function flowSaved(flow: PreparationFlow) {
  if (!workspace.value) return;
  ++loadNumber;
  loading.value = false;
  updateWorkspace({ flows: [flow, ...workspace.value.flows.filter(item => item.id !== flow.id)] });
  scheduleRefresh();
  flowId.value = flow.id;
  toast.success('流程已保存，可以填写参数并独立运行');
  void router.push({ path: '/preparations' });
}

async function submit() {
  if (!workspace.value || !selectedFlow.value || submitting.value) return;
  runError.value = '';
  if (needsMap.value && !mapName.value.trim()) {
    runError.value = '请输入目标地图的完整名称。';
    return;
  }
  if (needsService.value && !serviceName.value.trim()) {
    runError.value = `规则 v${selectedRule.value?.version} 要求填写 Paladin 服务完整名称。请补齐后再运行。`;
    return;
  }
  submitting.value = true;
  try {
    const run = await startPreparation({
      flowId: selectedFlow.value.id,
      targetBaseUrl: workspace.value.targetBaseUrl,
      mapName: needsMap.value ? mapName.value.trim() : '',
      serviceName: needsMap.value ? serviceName.value.trim() || undefined : undefined,
    });
    ++loadNumber;
    loading.value = false;
    updateWorkspace({ runs: [run, ...workspace.value.runs.filter(item => item.id !== run.id)] });
    selectedRunId.value = run.id;
    scheduleRefresh();
    toast.success('已提交准备运行');
  } catch (error) {
    runError.value = messageOf(error);
  } finally {
    submitting.value = false;
  }
}

watch([flowId, mapName, serviceName], () => { runError.value = ''; });
onMounted(() => void refresh());
onBeforeUnmount(() => { disposed = true; ++loadNumber; clearTimeout(poll); });
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <h1 class="text-xl font-semibold">测试准备</h1>
      <Button variant="outline" size="sm" :disabled="loading" @click="refresh"><RefreshCw />刷新</Button>
    </div>
    <nav aria-label="测试准备视图" class="flex flex-wrap gap-1 border-b pb-2">
      <Button v-for="tab in tabs" :key="tab.key" as-child size="sm" :variant="tab.key === view ? 'secondary' : 'ghost'">
        <RouterLink :aria-current="tab.key === view ? 'page' : undefined" :to="{ path: '/preparations', query: tab.key === 'run' ? {} : { view: tab.key } }">
          <component :is="tab.icon" />{{ tab.label }}
        </RouterLink>
      </Button>
    </nav>
    <Alert v-if="loadError" variant="destructive" role="alert">
      <AlertTitle>准备数据加载失败</AlertTitle><AlertDescription>{{ loadError }}</AlertDescription>
    </Alert>
    <div v-if="!workspace && loading" class="flex items-center gap-2 text-sm"><Spinner />正在加载准备流程…</div>
    <template v-if="workspace">
      <PreparationEditor v-if="view === 'edit'" :workspace="workspace" @rule="ruleSaved" @flow="flowSaved" />
      <div v-else-if="view === 'run'" class="grid items-start gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>独立运行准备流程</CardTitle><CardDescription>在当前测试站点执行已保存的准备步骤。</CardDescription></CardHeader>
          <CardContent>
            <form v-if="workspace.flows.length" class="flex flex-col gap-5" novalidate @submit.prevent="submit">
              <Field>
                <FieldLabel for="run-flow">准备流程</FieldLabel>
                <Select v-model="flowId" :disabled="submitting">
                  <SelectTrigger id="run-flow" class="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem v-for="flow in workspace.flows" :key="flow.id" :value="flow.id">{{ flowLabel(flow, workspace.flows) }}</SelectItem></SelectContent>
                </Select>
                <FieldDescription v-if="selectedFlow">{{ selectedFlow.steps.map(id => workspace?.skills.find(skill => skill.id === id)?.name ?? id).join(' → ') }}</FieldDescription>
              </Field>
              <div class="flex flex-col gap-1 text-sm">
                <div class="flex flex-wrap items-baseline gap-2"><span class="font-medium">测试环境</span><span class="break-all">{{ workspace.targetBaseUrl || '尚未设置' }}</span><RouterLink to="/settings" class="text-xs text-primary underline">更换站点</RouterLink></div>
                <p v-if="selectedRule && needsMap" class="text-xs text-muted-foreground">规则 v{{ selectedRule.version }} · {{ selectionLabel[selectedRule.selection] }} · {{ selectedRule.status === 'verified' ? '已验证' : '待完整试跑' }}</p>
              </div>
              <FieldGroup v-if="needsMap" class="gap-3">
                <Field><FieldLabel for="prep-map">地图完整名称</FieldLabel><Input id="prep-map" v-model="mapName" required placeholder="输入测试站点中已存在的地图" /></Field>
                <Field>
                  <FieldLabel for="prep-service">Paladin 服务完整名称{{ needsService ? '（必填）' : '（可选）' }}</FieldLabel>
                  <Input id="prep-service" v-model="serviceName" :required="needsService" placeholder="输入服务完整名称" />
                  <FieldDescription v-if="!needsService">存在多个候选且地图归属不明确时，填写目标服务。</FieldDescription>
                </Field>
              </FieldGroup>
              <FieldError v-if="runError" role="alert">{{ runError }}</FieldError>
              <div><Button type="submit" :disabled="submitting || !workspace.targetBaseUrl"><Play />{{ submitting ? '正在提交…' : selectedRule?.status === 'draft' ? '试跑准备流程' : '运行准备流程' }}</Button></div>
            </form>
            <div v-else class="flex flex-col items-start gap-3">
              <p class="text-sm text-muted-foreground">还没有保存的准备流程。</p>
              <Button as-child><RouterLink to="/preparations?view=edit"><ListChecks />编排准备流程</RouterLink></Button>
            </div>
          </CardContent>
        </Card>
        <PreparationReport v-if="currentRun" :run="currentRun" />
      </div>
      <div v-else class="grid items-start gap-4 lg:grid-cols-[minmax(230px,1fr)_minmax(0,1.7fr)]">
        <Card>
          <CardHeader><CardTitle>运行记录</CardTitle></CardHeader>
          <CardContent>
            <p v-if="!history.length" class="text-sm text-muted-foreground">还没有准备运行记录。</p>
            <ul v-else class="max-h-[64vh] overflow-auto">
              <li v-for="run in history" :key="run.id">
                <button type="button" class="flex w-full flex-col items-start gap-1 rounded-lg p-2.5 text-left hover:bg-muted" :aria-pressed="run.id === selectedRun?.id" :class="{ 'bg-muted': run.id === selectedRun?.id }" @click="selectedRunId = run.id">
                  <span class="text-sm font-medium">{{ run.flowName }}</span>
                  <span class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">{{ formatTime(run.createdAt) }}<StatusBadge :type="RUN_STATUS_BADGE[run.status]" :text="RUN_STATUS_TEXT[run.status]" /></span>
                </button>
              </li>
            </ul>
          </CardContent>
        </Card>
        <PreparationReport v-if="selectedRun" :run="selectedRun" />
      </div>
    </template>
  </div>
</template>
