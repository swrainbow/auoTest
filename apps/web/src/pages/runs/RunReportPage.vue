<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue';
import { useRoute } from 'vue-router';
import { ArrowLeft, ChevronDown, ExternalLink, FileText } from '@lucide/vue';
import type { BusinessStep, TestRunDto } from '@autotest/shared';
import { getCase, getRun, getRunArtifacts, messageOf } from '@/api/client';
import StatusBadge from '@/components/StatusBadge.vue';
import { Card, CardContent } from '@/components/ui/card';
import { MODE_TEXT, RUN_STATUS_BADGE, RUN_STATUS_TEXT, formatDuration, formatTime } from '@/utils/format';
import { failedOrder, groupRunSteps, summarizeRunFailure } from '@/utils/run-report';

const route = useRoute();
const id = computed(() => Number(route.params.id));
const run = shallowRef<TestRunDto | null>(null);
const plan = shallowRef<BusinessStep[]>([]);
const artifacts = shallowRef<string[]>([]);
const loading = ref(false);
const loadError = ref('');
const evidenceError = ref(false);
const live = computed(() => run.value?.status === 'queued' || run.value?.status === 'running');
const groups = computed(() => groupRunSteps(run.value));
const failure = computed(() => summarizeRunFailure(run.value, groups.value));
const warning = computed(() => run.value?.status === 'warning' ? run.value.summary?.warning : undefined);
const recordedGroups = computed(() => groups.value.filter(group => group.business));
const ungroupedCalls = computed(() => groups.value.reduce((count, group) => count + (group.business ? 0 : group.steps.length), 0));

const steps = computed(() => {
  const summary = run.value?.summary;
  const stop = warning.value?.step ?? failedOrder(run.value);
  const rows = new Map(plan.value.map(step => [step.order, step]));
  const recorded = new Map(recordedGroups.value.map(group => [group.business!.order, group]));
  for (const [order, group] of recorded) rows.set(order, group.business!);
  return [...rows.values()].sort((a, b) => a.order - b.order).map(step => {
    const group = recorded.get(step.order);
    let status: string = group?.status ?? 'unrecorded';
    if (!group) {
      if (warning.value?.step === step.order) status = 'warning';
      else if (failedOrder(run.value) === step.order) status = 'failed';
      else if (summary?.prerequisite?.status === 'failed' || (stop !== undefined && step.order > stop)) status = 'skipped';
    }
    return { ...step, status, duration: group?.durationMs };
  });
});
const stepLabels: Record<string, string> = { ...RUN_STATUS_TEXT, recorded: '已记录', skipped: '未执行', unrecorded: '无执行记录' };
const totals = computed(() => {
  const s = run.value?.summary;
  return [
    { label: '用例总数', value: s?.total },
    { label: '通过', value: s?.passed, color: 'text-status-success-foreground' },
    { label: '失败', value: s?.failed, color: 'text-status-failure-foreground' },
    { label: '告警', value: s?.warnings ?? (s?.total != null ? 0 : undefined), color: 'text-status-warning-foreground' },
  ];
});

watch(id, async (runId, _, onCleanup) => {
  let stale = false;
  const originalTitle = document.title;
  onCleanup(() => { stale = true; document.title = originalTitle; });
  document.title = '测试报告 · AutoTest';
  run.value = null;
  artifacts.value = [];
  plan.value = [];
  loadError.value = '';
  evidenceError.value = false;
  loading.value = true;
  try {
    if (!Number.isSafeInteger(runId) || runId <= 0) throw new Error('执行编号无效');
    const item = await getRun(runId);
    if (stale) return;
    run.value = item;
    document.title = `测试报告 #${runId} · ${item.testCaseCode ?? 'AutoTest'}`;
    if (live.value) return;
    const [files, versionSteps] = await Promise.allSettled([
      getRunArtifacts(runId),
      item.testCaseId && item.version != null
        ? getCase(item.testCaseId, { silent: true }).then(testCase =>
            testCase.versions.find(version => version.version === item.version)?.steps ?? [])
        : Promise.resolve([]),
    ]);
    if (stale) return;
    if (files.status === 'fulfilled') artifacts.value = files.value.files;
    else evidenceError.value = true;
    if (versionSteps.status === 'fulfilled') plan.value = versionSteps.value;
  } catch (error) {
    if (!stale) loadError.value = messageOf(error);
  } finally {
    if (!stale) loading.value = false;
  }
}, { immediate: true });

function artifactLabel(file: string) {
  if (file === 'e2e/report.json') return '原始报告';
  if (file === 'run.log') return '运行日志';
  if (file.endsWith('/trace.md')) return '执行跟踪';
  if (file.endsWith('/screen-at-failure.txt')) return '失败时的页面内容';
  if (file.endsWith('-failure.png')) return '失败截图';
  return file.split('/').pop();
}
</script>

<template>
  <main class="min-h-dvh bg-workspace pb-12 text-foreground">
    <div class="border-b bg-card">
      <nav aria-label="报告导航" class="mx-auto flex max-w-5xl items-center justify-between px-4 py-3 sm:px-8">
        <div class="flex items-center gap-2 text-sm font-semibold"><FileText class="size-4 text-primary" />AutoTest</div>
        <RouterLink v-if="run" :to="`/runs/${run.id}`" class="inline-flex items-center gap-1.5 text-sm text-primary hover:underline">
          <ArrowLeft class="size-4" />执行详情
        </RouterLink>
        <RouterLink v-else to="/runs" class="text-sm text-primary hover:underline">测试运行</RouterLink>
      </nav>
    </div>
    <article class="mx-auto max-w-5xl space-y-4 px-4 pt-5 sm:px-8 sm:pt-8">
      <p v-if="loading" role="status" class="text-sm text-muted-foreground">正在读取测试报告…</p>
      <Card v-else-if="loadError || live">
        <CardContent class="space-y-2 py-2">
          <h1 class="text-xl font-semibold">测试报告</h1>
          <p v-if="loadError" role="alert" class="text-sm text-status-failure-foreground">无法打开报告。{{ loadError }}</p>
          <p v-else class="text-sm text-muted-foreground">执行 #{{ run?.id }} {{ RUN_STATUS_TEXT[run!.status] }}，完成后可查看测试报告。</p>
        </CardContent>
      </Card>
      <template v-else-if="run">
        <Card class="gap-0 overflow-hidden border-t-[3px] border-t-primary py-0">
          <CardContent class="py-5 sm:px-7 sm:py-6">
            <div class="flex items-center justify-between gap-3">
              <h1 class="text-2xl font-bold tracking-tight">测试报告</h1>
              <StatusBadge :text="RUN_STATUS_TEXT[run.status]" :type="RUN_STATUS_BADGE[run.status]" />
            </div>
            <p class="mt-3 text-lg font-semibold leading-snug wrap-anywhere">{{ run.testCaseName || run.target || '历史测试运行' }}</p>
            <p class="mt-1.5 flex flex-wrap gap-x-3 text-sm text-muted-foreground">
              <span>执行 #{{ run.id }}</span><span v-if="run.testCaseCode">{{ run.testCaseCode }}</span>
              <span v-if="run.version != null">v{{ run.version }}</span><span>{{ MODE_TEXT[run.mode] }}</span>
            </p>
            <dl class="mt-5 grid gap-x-5 gap-y-3 border-t pt-4 text-sm sm:grid-cols-[1fr_1fr_.6fr]">
              <div><dt class="text-xs text-muted-foreground">开始时间</dt><dd class="mt-1 tabular-nums">{{ formatTime(run.startedAt) }}</dd></div>
              <div><dt class="text-xs text-muted-foreground">结束时间</dt><dd class="mt-1 tabular-nums">{{ formatTime(run.finishedAt) }}</dd></div>
              <div><dt class="text-xs text-muted-foreground">耗时</dt><dd class="mt-1 tabular-nums">{{ formatDuration(run.durationMs) }}</dd></div>
            </dl>
          </CardContent>
          <dl class="grid grid-cols-4 border-t bg-muted/35 py-3.5">
            <div v-for="metric in totals" :key="metric.label" class="border-l px-3 first:border-0 sm:px-7">
              <dt class="text-xs text-muted-foreground">{{ metric.label }}</dt>
              <dd class="mt-1 text-xl font-semibold tabular-nums" :class="metric.value ? metric.color : ''">{{ metric.value ?? '—' }}</dd>
            </div>
          </dl>
        </Card>

        <section v-if="failure || warning || run.error" class="rounded-xl border px-4 py-4 sm:px-6"
          :class="warning ? 'border-status-warning-foreground/20 bg-status-warning' : 'border-border bg-card'">
          <h2 class="text-base font-semibold" :class="failure ? 'text-status-failure-foreground' : ''">
            {{ failure?.title ?? (warning ? `第 ${warning.step} 步 · 告警` : '执行说明') }}
          </h2>
          <p v-if="warning || failure?.action" class="mt-2 text-sm leading-relaxed wrap-anywhere">{{ warning?.message ?? failure?.action }}</p>
          <p v-if="failure?.hint" class="mt-1 text-sm text-muted-foreground">{{ failure.hint }}</p>
          <details v-if="run.error" class="mt-2 text-sm" :open="!failure?.action && !warning">
            <summary class="w-fit cursor-pointer text-primary">原始错误</summary>
            <p class="mt-2 max-h-64 overflow-auto rounded-md bg-muted p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap wrap-anywhere">{{ run.error }}</p>
          </details>
        </section>

        <Card>
          <CardContent>
            <div class="mb-3 flex flex-wrap items-baseline justify-between gap-2">
              <h2 class="text-base font-semibold">业务步骤</h2>
              <span v-if="plan.length" class="text-xs text-muted-foreground">计划 {{ plan.length }} 步 · 已记录 {{ recordedGroups.length }} 步</span>
            </div>
            <p v-if="run.summary?.prerequisite" class="mb-3 flex items-center gap-2 text-sm">
              前置检查 <StatusBadge :text="RUN_STATUS_TEXT[run.summary.prerequisite.status]" :type="RUN_STATUS_BADGE[run.summary.prerequisite.status]" />
            </p>
            <ol v-if="steps.length" class="divide-y border-t">
              <li v-for="step in steps" :key="step.order">
                <details class="group" :open="step.status === 'failed' || step.status === 'warning'">
                  <summary class="flex cursor-pointer list-none items-start gap-2 py-3 text-sm marker:hidden">
                    <ChevronDown class="mt-1 size-3.5 shrink-0 -rotate-90 text-muted-foreground group-open:rotate-0" />
                    <span class="shrink-0 pt-px text-xs leading-5 text-muted-foreground">第 {{ step.order }} 步</span>
                    <span class="min-w-0 flex-1 font-medium leading-relaxed wrap-anywhere">{{ step.action }}</span>
                    <StatusBadge class="mt-px shrink-0" :type="RUN_STATUS_BADGE[step.status] ?? 'neutral'" :text="stepLabels[step.status]" />
                  </summary>
                  <div class="mb-3 ml-5 border-l-2 pl-3 text-sm leading-relaxed text-muted-foreground wrap-anywhere">
                    <p v-if="step.expected"><span class="font-semibold">业务预期</span>　{{ step.expected }}</p>
                    <p v-if="step.duration != null" class="text-xs">记录耗时 {{ step.duration < 1000 ? step.duration + ' ms' : formatDuration(step.duration) }}</p>
                  </div>
                </details>
              </li>
            </ol>
            <p v-else class="text-sm text-muted-foreground">本次运行没有可展示的业务步骤记录。</p>
            <p v-if="ungroupedCalls" class="mt-3 text-xs text-muted-foreground">
              {{ ungroupedCalls }} 条执行记录未关联到业务步骤，可在
              <RouterLink :to="`/runs/${run.id}`" class="text-primary hover:underline">执行详情</RouterLink>中查看。
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardContent>
            <h2 class="mb-3 text-base font-semibold">执行证据</h2>
            <ul v-if="artifacts.length" class="divide-y border-t">
              <li v-for="file in artifacts" :key="file">
                <a :href="`/artifacts/run-${run.id}/${file.split('/').map(encodeURIComponent).join('/')}`"
                  target="_blank" rel="noopener" class="group flex items-center gap-3 py-2.5">
                  <FileText class="size-4 shrink-0 text-muted-foreground" />
                  <span class="min-w-0 flex-1">
                    <span class="block text-sm font-medium group-hover:text-primary group-hover:underline">{{ artifactLabel(file) }}</span>
                    <span class="block text-xs text-muted-foreground wrap-anywhere">{{ file }}</span>
                  </span>
                  <ExternalLink class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                </a>
              </li>
            </ul>
            <p v-else class="text-sm text-muted-foreground">{{ evidenceError ? '暂时无法读取证据列表。' : '本次运行没有归档的证据文件。' }}</p>
          </CardContent>
        </Card>
      </template>
    </article>
  </main>
</template>
