<script setup lang="ts">
import { computed } from 'vue';
import { Copy } from '@lucide/vue';
import { toast } from 'vue-sonner';
import type { PreparationRun } from '@autotest/shared';
import StatusBadge from '@/components/StatusBadge.vue';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatTime, RUN_STATUS_BADGE, RUN_STATUS_TEXT } from '@/utils/format';
import { selectionLabel } from './labels';

const props = defineProps<{ run: PreparationRun }>();
const stepStatus: Record<string, string> = { ...RUN_STATUS_TEXT, pending: '等待执行', skipped: '已跳过' };
const hasReadback = computed(() => props.run.status === 'passed' && props.run.steps.some(step => step.skillId === 'readiness-check' && step.status === 'passed'));
const handoff = computed(() => {
  const { run } = props;
  const evidence = run.evidence;
  const rows = [
    ['运行记录', run.id],
    ['测试环境', run.targetBaseUrl],
    ['流程', run.flowName],
    ['选择规则', `v${run.ruleVersion} · ${selectionLabel[run.selection]}`],
    ['开始时间', formatTime(run.createdAt)],
  ];
  if (run.mapName) rows.push(['目标地图', run.mapName]);
  if (run.serviceName) rows.push(['指定服务', run.serviceName]);
  if (evidence?.serviceName) rows.push(['实际服务', evidence.serviceName]);
  if (evidence?.mapsBefore) rows.push(['绑定前地图', evidence.mapsBefore.join('、') || '无']);
  if (evidence?.mapsAfter) rows.push(['绑定后地图', evidence.mapsAfter.join('、') || '无']);
  if (typeof evidence?.wroteBinding === 'boolean') rows.push(['绑定操作', evidence.wroteBinding ? '已提交绑定' : '已有绑定，跳过保存']);
  if (evidence?.services) {
    const services = evidence.services.map(service => {
      const attempts = service.attempts === undefined ? '' : `，已尝试同步 ${service.attempts} 次`;
      return `${service.name}（${service.status}${attempts}）`;
    });
    rows.push(['同步回读', services.join('、')]);
  }
  return rows;
});
async function copyHandoff() {
  const text = handoff.value.map(([label, value]) => `${label}　${value}`).join('\n');
  try {
    await navigator.clipboard.writeText(text);
    toast.success('已复制交接清单');
  } catch {
    toast.error('浏览器未允许复制，可直接选中清单文本复制');
  }
}
</script>

<template>
  <Card>
    <CardHeader>
      <div class="flex flex-wrap items-center justify-between gap-2">
        <CardTitle>{{ hasReadback ? '准备结果与交接清单' : '准备运行详情' }}</CardTitle>
        <StatusBadge :text="RUN_STATUS_TEXT[run.status]" :type="RUN_STATUS_BADGE[run.status]" dot />
      </div>
    </CardHeader>
    <CardContent class="flex flex-col gap-4">
      <dl class="grid gap-x-5 gap-y-2 text-sm sm:grid-cols-2">
        <div v-for="[label, value] in handoff" :key="label" class="min-w-0">
          <dt class="text-xs text-muted-foreground">{{ label }}</dt>
          <dd class="break-all">{{ value }}</dd>
        </div>
      </dl>
      <p v-if="run.error" class="whitespace-pre-wrap break-words text-sm text-destructive" role="alert">{{ run.error }}</p>
      <ol class="divide-y rounded-lg border px-3">
        <li v-for="(step, index) in run.steps" :key="step.skillId" class="py-2.5">
          <div class="flex items-baseline justify-between gap-2 text-sm">
            <strong class="font-medium">{{ index + 1 }}. {{ step.name }}</strong>
            <span class="text-xs text-muted-foreground">{{ stepStatus[step.status] }}</span>
          </div>
          <p v-if="step.evidence" class="mt-1 whitespace-pre-wrap break-words text-xs text-muted-foreground">{{ step.evidence }}</p>
        </li>
      </ol>
      <div v-if="hasReadback"><Button variant="outline" size="sm" @click="copyHandoff"><Copy />复制交接清单</Button></div>
    </CardContent>
  </Card>
</template>
