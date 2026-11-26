<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { LineChart, ScatterChart } from 'echarts/charts';
import { GridComponent, TooltipComponent } from 'echarts/components';
import { graphic, init, use, type ECharts } from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import type { DashboardSummary } from '@autotest/shared';

use([LineChart, ScatterChart, GridComponent, TooltipComponent, CanvasRenderer]);

const props = defineProps<{ runs: DashboardSummary['trend'] }>();
const router = useRouter();
const element = ref<HTMLDivElement | null>(null);
let chart: ECharts | undefined;
let resize: ResizeObserver | undefined;

function render(): void {
  if (!chart || !element.value) return;
  const styles = getComputedStyle(element.value);
  const color = (name: string) => styles.getPropertyValue('--dashboard-' + name).trim();
  const passed = color('passed');
  const compact = element.value.clientWidth < 450;
  chart.setOption({
    animation: false,
    grid: { top: 15, left: 29, right: 5, bottom: 28 },
    tooltip: {
      trigger: 'axis',
      renderMode: 'richText',
      confine: true,
      axisPointer: { type: 'line', lineStyle: { color: color('axis'), type: 'dashed' } },
      backgroundColor: color('tooltip'),
      borderWidth: 0,
      textStyle: { color: color('tooltip-text'), fontSize: 12 },
    },
    xAxis: {
      type: 'category',
      data: props.runs.map(({ runId }) => '#' + runId),
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        color: color('axis'), fontSize: 11,
        interval: compact && props.runs.length > 5 ? Math.ceil(props.runs.length / 5) - 1 : 'auto',
      },
    },
    yAxis: {
      type: 'value', min: 0, minInterval: 1, splitNumber: 4,
      axisLabel: { color: color('axis'), fontSize: 11, hideOverlap: true },
      splitLine: { lineStyle: { color: color('grid'), type: 'dashed' } },
    },
    series: [
      {
        name: '通过', type: 'line', smooth: true, symbol: 'circle', symbolSize: 6,
        lineStyle: { color: passed, width: 2 },
        itemStyle: { color: passed },
        areaStyle: {
          color: new graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: passed + '36' },
            { offset: 1, color: passed + '05' },
          ]),
          opacity: 1,
        },
        data: props.runs.map(({ passed }) => passed),
      },
      {
        name: '失败', type: 'line', smooth: true, symbol: 'circle', symbolSize: 6,
        lineStyle: { color: color('failed'), width: 2 },
        itemStyle: { color: color('failed') },
        data: props.runs.map(({ failed }) => failed),
      },
      ...(props.runs.some(run => run.warnings) ? [{
        name: '告警', type: 'scatter', symbol: 'diamond', symbolSize: 8,
        itemStyle: { color: color('warning') },
        data: props.runs.map(({ warnings }) => warnings || null),
      }] : []),
    ],
  }, { replaceMerge: ['series'] });
}

onMounted(() => {
  if (!element.value) return;
  chart = init(element.value);
  chart.on('click', ({ dataIndex }) => {
    const run = props.runs[dataIndex];
    if (run) void router.push('/runs/' + run.runId);
  });
  resize = new ResizeObserver(() => {
    chart?.resize();
    render();
  });
  resize.observe(element.value);
  render();
});

watch(() => props.runs, render);
onBeforeUnmount(() => {
  resize?.disconnect();
  chart?.dispose();
});
</script>

<template>
  <div ref="element" class="h-48 w-full min-w-0 touch-pan-y overflow-hidden sm:h-60" role="img" aria-label="按执行编号展示通过、失败和告警次数" />
</template>
