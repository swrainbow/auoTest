import type { Workflow } from '../planner/workflow';
import type { readE2eReport } from './e2e-report';

type Report = Awaited<ReturnType<typeof readE2eReport>>;

/** Recognize the old compound failure inside a single import, before any upload. */
export function mapReadbackFailureStep(workflow: Workflow, summary?: Report['summary'] | null) {
  if (!summary?.failedBusinessStep || summary.failedCallKind !== 'operation' ||
      summary.failedCallType !== 'import-generated-map' || summary.failedCallIndex == null) return;
  const step = summary.failedBusinessStep;
  const op = workflow[step - 1]?.operations[summary.failedCallIndex];
  if (op?.type !== 'import-generated-map') return;
  const calls = (summary.steps ?? []).filter(call =>
    call.business?.order === step && call.callKind === 'operation' && call.callType === op.type);
  const wait = calls.findIndex(call => call.api === 'browser.waitForResponse' && call.error?.code === 'STEP_NOT_AWAITED' &&
    /\/tkmap\/map\/getById\/\d+\//.test(call.label.replaceAll('\\', '')));
  if (wait < 0 || calls.some(call => call.api === 'locator.setInputFiles')) return;
  const item = 'getByRole("menuitem", name: ' + JSON.stringify(op.layout.mapName) + ')';
  if (calls.slice(wait + 1).some(call => call.api === 'locator.click' && call.error?.code === 'ACTION_FAILED' &&
      call.label.includes('.map-dropdown-menu[') && call.label.endsWith(item) && call.error.message?.includes('element is not visible'))) return step;
}

export function verifiedMapReadback(report: Report, step: number) {
  if (!report.fullyPassed || !report.zeroAi) return false;
  return report.summary.steps.some(call => call.business?.order === step && call.callType === 'import-generated-map' &&
    call.api === 'browser.waitForResponse' && call.status === 'passed' &&
    /\/tkmap\/map\/getById\/\d+\//.test(call.label.replaceAll('\\', '')));
}

export const mapReadbackPractice = {
  page: '/tkmap/mapDraw',
  operation: 'import-generated-map',
  guidance: '复用原步骤的地图布局。刷新回读时以地图控件中的实际 ID 等待目标详情，在已展开的地图菜单中按完整名称选取目标项。等待选图与详情监听都结束，再核对当前地图的 ID、名称和已保存内容。选图失败时保留原始操作错误。',
};
