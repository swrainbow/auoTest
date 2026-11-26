import type { BusinessStep, TestRunDto } from '@autotest/shared';

export interface ReportStep {
  api: string;
  label: string;
  status: string;
  durationMs: number;
  error?: { message?: string };
  business?: BusinessStep;
  callKind?: 'operation' | 'check';
}

interface RecordedStepGroup {
  key: number;
  business?: BusinessStep;
  steps: ReportStep[];
}

export interface RunStepGroup extends RecordedStepGroup {
  failed?: ReportStep;
  status: 'passed' | 'failed' | 'warning' | 'recorded';
  durationMs: number;
}

export function failedOrder(run: TestRunDto | null): number | undefined {
  const order = run?.summary?.failedBusinessStep;
  return typeof order === 'number' ? order : undefined;
}

export function groupRunSteps(run: TestRunDto | null): RunStepGroup[] {
  const steps = run?.summary?.steps;
  if (!run || !Array.isArray(steps)) return [];
  const groups: RecordedStepGroup[] = [];
  for (const [index, step] of (steps as ReportStep[]).entries()) {
    const last = groups.at(-1);
    if (last && last.business?.order === step.business?.order) last.steps.push(step);
    else groups.push({ key: index, business: step.business, steps: [step] });
  }
  const stoppedAt = failedOrder(run);
  const warnedAt = run.status === 'warning' ? run.summary?.warning?.step : undefined;
  const furthestOrder = groups.reduce((max, group) => Math.max(max, group.business?.order ?? 0),
    Math.max(stoppedAt ?? 0, warnedAt ?? 0));
  return groups.map(group => {
    const order = group.business?.order;
    const failed = group.steps.find(step => step.error || ['failed', 'error', 'timeout', 'timed-out'].includes(step.status));
    let status: RunStepGroup['status'] = 'recorded';
    // A helper can fail between two successful browser calls. Some legacy reports also
    // lose the mapping partway through a step, so passing calls alone cannot prove it passed.
    if (order !== undefined && order === warnedAt) status = 'warning';
    else if (failed || (order !== undefined && order === stoppedAt)) status = 'failed';
    else if (order !== undefined && (run.status === 'passed' || order < furthestOrder) &&
        group.steps.every(step => step.status === 'passed')) status = 'passed';
    const durationMs = group.steps.reduce((total, step) => total + (step.durationMs || 0), 0);
    return { ...group, status, failed, durationMs };
  });
}

export function summarizeRunFailure(run: TestRunDto | null, groups?: RunStepGroup[]):
    { title: string; action?: string; hint?: string } | null {
  if (!run || !['failed', 'timeout', 'error'].includes(run.status)) return null;
  if (run.summary?.prerequisite?.status === 'failed') return { title: '前置检查未通过' };
  const conflict = run.summary?.testDataConflict;
  if (conflict) {
    return {
      title: `第 ${conflict.step} 步 · 测试数据冲突`,
      action: `目标环境已有 ${conflict.observedCount} 条名为「${conflict.name}」的任务配置，执行在查重步骤停止。`,
      hint: '请先核对目标环境中的同名记录，再使用隔离的测资，或在确认记录归属后恢复测试数据并重新运行。',
    };
  }
  const recorded = groups ?? groupRunSteps(run);
  const failures = recorded.filter(group => group.status === 'failed' && group.business);
  const order = failedOrder(run) ?? (failures.length === 1 ? failures[0]?.business?.order : undefined);
  const group = failures.find(group => group.business?.order === order);
  const { failedCallKind, failedCallType } = run.summary ?? {};
  let title = '执行失败';
  if (run.status === 'timeout') title = '执行超时';
  else if (run.status === 'error') title = '执行器错误';
  else if (failedCallKind === 'check') title = '业务断言未通过';
  else if (failedCallKind === 'operation') {
    const waiting = typeof failedCallType === 'string'
      ? failedCallType.startsWith('wait-')
      : /^expect\.toBe(?:Hidden|Visible)$/.test(group?.failed?.api ?? '');
    title = waiting ? '页面状态等待失败' : '操作未完成';
  }
  return {
    title: order === undefined ? title : `第 ${order} 步 · ${title}`,
    action: group?.business?.action,
    hint: failedCallKind === 'operation' && group?.business ? '此步骤的业务断言尚未执行。' : undefined,
  };
}
