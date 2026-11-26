<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue';
import { Activity, ArrowRight, CalendarDays, ChevronRight, CircleCheck, Clock3, ListChecks, Plus, RefreshCw, Search } from '@lucide/vue';
import { getDashboard } from '@/api/client';
import { formatDuration, formatTime, fromNow, RUN_STATUS_BADGE, RUN_STATUS_TEXT } from '@/utils/format';
import ExecutionTrend from '@/components/ExecutionTrend.vue';
import KpiCard from '@/components/KpiCard.vue';
import StatusBadge from '@/components/StatusBadge.vue';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { DashboardSummary } from '@autotest/shared';

const days = ref('90');
const summary = shallowRef<DashboardSummary>();
const loading = ref(true);
const loadFailed = ref(false);
const query = ref('');
let latestRequest = 0;

const filteredFailures = computed(() => {
  const failures = summary.value?.flakyTests ?? [];
  const term = query.value.trim().toLowerCase();
  return failures.filter((test) => [test.code, test.name, test.module].some((field) => field.toLowerCase().includes(term)));
});

const recentRuns = computed(() => summary.value?.trend.slice(-5).reverse() ?? []);

const metrics = computed(() => {
  const result = summary.value;
  if (!result) return;
  const { kpis } = result;
  const hasRuns = (kpis.assessedRuns ?? result.trend.length) > 0;
  const duration = kpis.avgDurationMs;
  return {
    pass: {
      label: '执行通过率', icon: CircleCheck, value: hasRuns ? kpis.passRate + '%' : '—',
      info: '通过次数占通过与失败总次数的比例', delta: hasRuns ? kpis.trends.passRate.delta : null,
      direction: 'higher' as const,
    },
    stability: {
      label: '稳定性评分', icon: Activity, value: hasRuns ? String(kpis.reliabilityScore) : '—',
      info: '满分 100，按通过率和不稳定用例占比计算', delta: hasRuns ? kpis.trends.reliabilityScore.delta : null,
      direction: 'higher' as const,
    },
    other: [
      {
        label: '用例总数', icon: ListChecks, value: String(kpis.totalCases),
        info: '平台内全部测试用例的数量', delta: kpis.trends.totalCases.delta,
      },
      {
        label: '平均耗时', icon: Clock3,
        value: duration == null ? '—' : duration < 1000 ? duration + ' ms' : formatDuration(duration),
        info: '统计期内已完成执行的平均时长',
        delta: duration != null && kpis.trends.avgDurationMs.delta != null ? -kpis.trends.avgDurationMs.delta : null,
        direction: 'lower' as const,
      },
    ],
  };
});

async function load(): Promise<void> {
  const request = ++latestRequest;
  loading.value = true;
  loadFailed.value = false;
  try {
    const result = await getDashboard(Number(days.value));
    if (request === latestRequest) summary.value = result;
  } catch {
    if (request === latestRequest) loadFailed.value = true;
  } finally {
    if (request === latestRequest) loading.value = false;
  }
}

watch(days, () => {
  query.value = '';
  void load();
}, { immediate: true });
</script>

<template>
  <div class="dashboard flex flex-col gap-4 sm:gap-5">
    <header class="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
      <h1 class="text-[1.45rem] leading-tight font-semibold tracking-tight sm:text-[1.7rem]">测试总览</h1>
      <div class="flex flex-wrap items-center gap-2">
        <Select v-model="days">
          <SelectTrigger class="bg-card" aria-label="统计范围">
            <CalendarDays class="size-4" aria-hidden="true" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="7">最近 7 天</SelectItem>
              <SelectItem value="30">最近 30 天</SelectItem>
              <SelectItem value="90">最近 90 天</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
        <Button type="button" variant="ghost" size="icon" aria-label="刷新" title="刷新" :disabled="loading" @click="load">
          <RefreshCw :class="{ 'motion-safe:animate-spin': loading }" />
        </Button>
        <Button as-child>
          <RouterLink to="/cases/new">
            <Plus data-icon="inline-start" />
            新建用例
          </RouterLink>
        </Button>
      </div>
    </header>

    <Alert v-if="loadFailed" variant="destructive">
      <AlertTitle>总览加载失败</AlertTitle>
      <AlertDescription>{{ summary ? '当前显示上次加载的数据。' : '请刷新后重试。' }}</AlertDescription>
    </Alert>

    <div v-if="summary || loading" class="dashboard-grid grid items-start gap-3.5 sm:gap-4" :aria-busy="loading">
      <Card class="trend-panel" aria-label="执行趋势">
        <CardHeader class="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div class="flex min-w-0 flex-col gap-3">
            <CardTitle>执行趋势</CardTitle>
            <KpiCard v-if="metrics" v-bind="metrics.pass" size="large" />
            <Skeleton v-else class="h-12 w-28" />
          </div>
          <div v-if="summary?.trend.length" class="flex flex-wrap items-center gap-x-3.5 gap-y-1 pt-0.5 text-xs text-muted-foreground">
            <span class="flex items-center gap-1.5"><span class="series-key series-passed" />通过</span>
            <span class="flex items-center gap-1.5"><span class="series-key series-failed" />失败</span>
            <span v-if="summary.trend.some(run => run.warnings)" class="flex items-center gap-1.5"><span class="series-key series-warning" />告警</span>
          </div>
        </CardHeader>
        <CardContent>
          <template v-if="summary?.trend.length">
            <ExecutionTrend :runs="summary.trend" />
            <p class="mt-1 pl-[29px] text-xs text-muted-foreground">最近 {{ summary.trend.length }} 次已完成执行</p>
          </template>
          <Skeleton v-else-if="!summary" class="h-48 w-full sm:h-60" />
          <Empty v-else class="min-h-40 px-3 py-8">
            <EmptyHeader>
              <EmptyTitle>暂无执行记录</EmptyTitle>
              <EmptyDescription>执行完成后显示趋势</EmptyDescription>
            </EmptyHeader>
          </Empty>
        </CardContent>
      </Card>

      <div class="dashboard-aside grid min-w-0 gap-3.5 sm:gap-4">
        <Card aria-label="运行概况">
          <CardHeader>
            <CardTitle>运行概况</CardTitle>
          </CardHeader>
          <CardContent class="flex flex-col gap-3.5">
            <template v-if="metrics">
              <div>
                <KpiCard v-bind="metrics.stability" unit="/ 100" />
                <div v-if="summary && metrics.stability.value !== '—'" class="mt-3 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                  <div class="series-passed h-full rounded-full" :style="{ width: summary.kpis.reliabilityScore + '%' }" />
                </div>
              </div>
              <div class="grid grid-cols-2 gap-2 rounded-lg bg-muted/65 px-3 py-2.5">
                <KpiCard v-for="metric in metrics.other" :key="metric.label" v-bind="metric" size="small" />
              </div>
            </template>
            <Skeleton v-else class="h-28 w-full" />
          </CardContent>
        </Card>

        <Card aria-label="失败用例">
          <CardHeader class="flex items-center justify-between gap-2">
            <CardTitle>失败用例</CardTitle>
            <Badge v-if="summary?.flakyTests.length" variant="secondary">{{ summary.flakyTests.length }} 个</Badge>
          </CardHeader>
          <CardContent>
            <div v-if="(summary?.flakyTests.length ?? 0) > 1 || query" class="relative mb-1.5">
              <Search class="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input v-model="query" type="search" class="h-8 border-transparent bg-muted pl-8 text-xs shadow-none" aria-label="搜索失败用例" placeholder="搜索失败用例" />
            </div>
            <ul v-if="filteredFailures.length" class="flex flex-col gap-1">
              <li v-for="test in filteredFailures" :key="test.testCaseId">
                <RouterLink
                  :to="'/cases/' + test.testCaseId + '/edit'"
                  class="-mx-2 flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring sm:gap-2.5"
                >
                  <div class="min-w-0 flex-1">
                    <p class="text-sm leading-snug font-medium">{{ test.name }}</p>
                    <p class="mt-1 text-xs text-muted-foreground">{{ test.code }} · {{ test.failures }}/{{ test.runs }} 次失败</p>
                  </div>
                  <StatusBadge :text="test.flakyScore + '%'" type="failed" class="shrink-0 tabular-nums" />
                  <ChevronRight class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                </RouterLink>
              </li>
            </ul>
            <Skeleton v-else-if="!summary" class="h-10 w-full" />
            <Empty v-else class="px-2 py-4 md:p-4">
              <EmptyHeader>
                <EmptyDescription>{{ query.trim() ? '没有匹配的用例' : '统计期内暂无失败用例' }}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          </CardContent>
        </Card>

        <Card aria-label="模块通过率">
          <CardHeader>
            <CardTitle>模块通过率</CardTitle>
          </CardHeader>
          <CardContent>
            <ul v-if="summary?.moduleSummary.length" class="flex flex-col gap-3.5">
              <li v-for="module in summary.moduleSummary" :key="module.module">
                <div class="flex items-baseline justify-between gap-2">
                  <span class="min-w-0 break-words text-sm font-medium">{{ module.module }}</span>
                  <span class="shrink-0 text-sm font-semibold tabular-nums">{{ module.status === 'warning' ? '告警' : module.runs ? module.passRate + '%' : '—' }}</span>
                </div>
                <div v-if="module.runs && module.status !== 'warning'" class="mt-2 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                  <div class="series-passed h-full rounded-full" :style="{ width: module.passRate + '%' }" />
                </div>
                <p class="mt-1.5 text-xs text-muted-foreground">
                  {{ module.runs ? module.runs + ' 次执行 · ' + fromNow(module.lastRunAt) : '未执行' }}
                </p>
              </li>
            </ul>
            <Skeleton v-else-if="!summary" class="h-10 w-full" />
            <Empty v-else class="px-2 py-4 md:p-4">
              <EmptyHeader><EmptyDescription>暂无模块数据</EmptyDescription></EmptyHeader>
            </Empty>
          </CardContent>
        </Card>
      </div>

      <Card class="recent-panel" aria-label="最近执行">
        <CardHeader class="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>最近执行</CardTitle>
          <Button variant="ghost" size="sm" as-child>
            <RouterLink to="/runs">全部运行 <ArrowRight data-icon="inline-end" /></RouterLink>
          </Button>
        </CardHeader>
        <CardContent>
          <Table v-if="recentRuns.length" class="table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead>用例</TableHead>
                <TableHead class="w-16">状态</TableHead>
                <TableHead class="hidden w-14 text-right sm:table-cell">耗时</TableHead>
                <TableHead class="w-20 text-right">时间</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow v-for="run in recentRuns" :key="run.runId" class="border-dashed border-border/70">
                <TableCell class="py-2.5">
                  <RouterLink :to="'/runs/' + run.runId" class="block rounded-sm text-sm font-medium hover:underline focus-visible:ring-2 focus-visible:ring-ring">
                    <span class="block truncate" :title="run.caseName ?? '执行 #' + run.runId">{{ run.caseName ?? '执行 #' + run.runId }}</span>
                    <span v-if="run.caseName" class="block text-xs font-normal text-muted-foreground">#{{ run.runId }}</span>
                  </RouterLink>
                </TableCell>
                <TableCell>
                  <StatusBadge :text="RUN_STATUS_TEXT[run.status]" :type="RUN_STATUS_BADGE[run.status]" />
                </TableCell>
                <TableCell class="hidden text-right text-xs tabular-nums text-muted-foreground sm:table-cell">{{ formatDuration(run.durationMs) }}</TableCell>
                <TableCell class="text-right text-xs text-muted-foreground" :title="formatTime(run.createdAt)">{{ fromNow(run.createdAt) }}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
          <Skeleton v-else-if="!summary" class="h-20 w-full" />
          <Empty v-else class="px-2 py-4 md:p-4">
            <EmptyHeader><EmptyDescription>统计期内暂无已完成的执行</EmptyDescription></EmptyHeader>
          </Empty>
        </CardContent>
      </Card>
    </div>
  </div>
</template>

<style scoped>
.dashboard {
  container-type: inline-size;
  --dashboard-passed: var(--chart-1);
  --dashboard-failed: #c65d4e;
  --dashboard-warning: var(--status-warning-foreground);
  --dashboard-axis: #636b7a;
  --dashboard-grid: #e7ebf2;
  --dashboard-tooltip: #fff;
  --dashboard-tooltip-text: #222a39;
}

:global(.dark) .dashboard {
  --dashboard-failed: #ef927f;
  --dashboard-axis: #b4bac7;
  --dashboard-grid: #363d4b;
  --dashboard-tooltip: #222a39;
  --dashboard-tooltip-text: #fff;
}

.series-key { width: 0.5rem; height: 0.5rem; border-radius: 2px; }
.series-passed { background-color: var(--dashboard-passed); }
.series-failed { background-color: var(--dashboard-failed); }
.series-warning { background-color: var(--dashboard-warning); }

@container (min-width: 46rem) {
  .dashboard-grid {
    grid-template-columns: minmax(0, 1.8fr) minmax(0, 1fr);
    grid-template-areas: 'trend sidebar' 'recent sidebar';
  }

  .trend-panel { grid-area: trend; }
  .dashboard-aside { grid-area: sidebar; }
  .recent-panel { grid-area: recent; }
}
</style>
