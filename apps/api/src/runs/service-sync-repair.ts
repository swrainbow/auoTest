import type { BusinessStep } from '@autotest/shared';
import type { Workflow } from '../planner/workflow';
import type { readE2eReport } from './e2e-report';

type Report = Awaited<ReturnType<typeof readE2eReport>>;
type Summary = Report['summary'];

function bindRequests(summary: Summary, step: number) {
  return summary.steps.filter(call => call.business?.order === step && call.callType === 'bind-paladin-map' &&
    call.api === 'browser.waitForResponse' && call.status === 'passed');
}

function requestId(label: string) {
  return /\/basic\/tuskService\/(\d+)\/syncInfo\//.exec(label.replaceAll('\\', ''))?.[1];
}

/** The old runner submitted a second synchronization while verifying a saved binding. */
export function repeatedBindingSync(summary: Summary | null | undefined, error?: string | null) {
  if (!summary?.failedBusinessStep || summary.failedCallType !== 'bind-paladin-map' ||
      summary.failedCallKind !== 'operation' || summary.failedCallIndex == null ||
      !/^服务「[^」]+」第 [2-9]\d* 次同步操作失败/.test(error ?? '')) return;
  const ids = bindRequests(summary, summary.failedBusinessStep).flatMap(call => requestId(call.label) ?? []);
  if (new Set(ids).size === 2 && ids.length > 2) {
    return { step: summary.failedBusinessStep, index: summary.failedCallIndex, services: [...new Set(ids)] };
  }
}

export function shouldResyncBinding(workflow: Workflow, steps: BusinessStep[], step: number, index: number) {
  const bind = workflow[step - 1]?.operations[index];
  if (bind?.type !== 'bind-paladin-map' || bind.syncExisting) return false;
  // A separate sync operation already covers this path on replay.
  if (workflow.slice(step - 1).some(entry => entry.operations.some(op =>
    op.type === 'sync-bound-map-services' && op.mapName === bind.mapName))) return false;
  const instructions = steps.slice(step - 1, step + 1).map(s => s.action).join('\n');
  return /同步/.test(instructions) && !/(?:不(?:需要|用|必|再|要)?|无需|跳过|禁[止用])(?:执行|点击|触发)?[「“"]?同步/.test(instructions);
}

export function verifiedBindingSync(report: Report, failure: NonNullable<ReturnType<typeof repeatedBindingSync>>) {
  if (!report.zeroAi || !report.fullyPassed) return false;
  const reads = bindRequests(report.summary, failure.step);
  const ids = reads.flatMap(call => requestId(call.label) ?? []);
  const last = reads[reads.length - 1]?.label ?? '';
  return ids.length === 2 && failure.services.every(id => ids.includes(id)) &&
    !requestId(last) && last.replaceAll('\\', '').includes('/basic/tuskService');
}

export const serviceSyncPractice = {
  page: '/config/tuskService', operation: 'bind-paladin-map', syncExisting: true,
  guidance: '当业务要求已有绑定也要同步时，设置 syncExisting。对应的 Paladin 和 Rattletrap 各提交一次，按服务编号等待异步结果，回读确认成功再继续。处理中只轮询。',
};
