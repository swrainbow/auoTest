import { taskConfigExactRowSelector, type HookGraphCheck, type Operation, type Workflow } from './workflow';

const graphSelector = /^\.el-drawer:visible \.vue-flow__node:has-text\("(回调|机器人|流程|继续任务)"\)$/;
const stageSelector = /^\.vue-flow__node-llm:has\(\.node-header > div:text-is\("([^"\\\r\n]+)"\)\) \.node-item > div:text-is\("([^"\\\r\n]+)"\)$/;
const stages: HookGraphCheck['stage'][] = ['创建时', '进入前', '到达时', '离开前', '离开后'];
const key = 'hookGraphBeforeSave';

function activatedCss(op: Operation) {
  if (op.type !== 'click' && !(op.type === 'press' && op.key === 'Enter')) return;
  return 'locator' in op && op.locator.kind === 'css' && !op.locator.frame ? op.locator.value : undefined;
}

function savedAndReopened(workflow: Workflow, first: number, secondOpening: number) {
  let saved = false;
  let filter: string | undefined;
  for (const step of workflow.slice(first + 1, secondOpening + 1)) {
    for (const op of step.operations) {
      if (op.type === 'act' || op.type === 'open') return false;
      const css = activatedCss(op);
      if (css === '[role="dialog"][aria-label="任务配置"] button[name="确定"]') saved = true;
      if (saved && op.type === 'filter-task-config') filter = op.value;
      if (filter && css === taskConfigExactRowSelector(filter) + ' button[title="修改"]') return true;
    }
  }
  return false;
}

export function hookGraphCheckPair(workflow: Workflow) {
  type Opening = { node: string; stage: HookGraphCheck['stage']; step: number };
  const matches: Array<{ stepIndex: number; checkIndex: number; opening: Opening; hook: string }> = [];
  let page = '';
  let opening: Opening | undefined;
  for (const [stepIndex, step] of workflow.entries()) {
    for (const op of step.operations) {
      if (op.type === 'open') page = op.path.split(/[?#]/, 1)[0]!;
      if (op.type === 'open' || op.type === 'act' || op.type === 'filter-task-config') opening = undefined;
      const css = activatedCss(op);
      if (!css || (!css.includes('.node-item') && !css.includes('.el-drawer__close-btn'))) continue;
      const match = stageSelector.exec(css);
      const stage = stages.find(name => name === match?.[2]);
      opening = match && stage ? { node: match[1]!, stage, step: stepIndex } : undefined;
    }
    for (const [checkIndex, check] of step.checks.entries()) {
      if ('key' in check && check.key === key) return;
      if (page !== '/task/taskLego' || check.type !== 'count' || !('locator' in check) || check.locator.kind !== 'css' || check.locator.frame) continue;
      const match = graphSelector.exec(check.locator.value);
      if (!match) continue;
      if (!opening || check.value !== 1) return;
      matches.push({ stepIndex, checkIndex, opening, hook: match[1]! });
    }
  }
  const [before, after] = matches;
  if (matches.length !== 2 || !before || !after || after.opening.step <= before.stepIndex ||
      before.opening.node !== after.opening.node || before.opening.stage !== after.opening.stage || before.hook !== after.hook ||
      !savedAndReopened(workflow, before.stepIndex, after.opening.step)) return;
  const baseline = { node: before.opening.node, stage: before.opening.stage, hook: before.hook, key };
  return [
    { stepIndex: before.stepIndex, checkIndex: before.checkIndex, check: { type: 'capture-hook-graph' as const, ...baseline } },
    { stepIndex: after.stepIndex, checkIndex: after.checkIndex, check: { type: 'matches-hook-graph' as const, ...baseline } },
  ];
}

// The archive's accessibility tree lists cards before the execution graph. Only
// accept a unique card whose own identifier occurs in this drawer's graph.
function hookPresentInGraph(screen: string, { node, stage, hook }: HookGraphCheck): boolean {
  const lines = screen.split(/\r?\n/);
  const dialog = 'dialog ' + JSON.stringify(node + ' - ' + stage);
  const headings = lines.flatMap((line, index) => {
    const row = /^( +)#\S+ (.*)$/.exec(line);
    return row?.[2] === dialog ? [{ index, depth: row[1]!.length }] : [];
  });
  if (headings.length !== 1) return false;
  const { index, depth } = headings[0]!;
  let graph = false;
  const cards: string[] = [];
  const nodes: string[] = [];
  for (const line of lines.slice(index + 1)) {
    const row = /^( +)#\S+ (.*)$/.exec(line);
    if (!row || row[1]!.length <= depth) break;
    const text = row[2]!;
    if (text === 'text="执行顺序"') {
      if (graph) return false;
      graph = true;
    } else if (graph) {
      const id = /^text="([\w-]+)"$/.exec(text);
      if (id) nodes.push(id[1]!);
    } else {
      const card = /^text="([\w-]+) - ([^"]+)"$/.exec(text);
      if (card?.[2] === hook) cards.push(card[1]!);
    }
  }
  return cards.length === 1 && nodes.filter((id) => id === cards[0]).length === 1;
}

export function evidencedHookGraphRepair(workflow: Workflow, failedStep: number, checkIndex: number, observedCount: number | undefined, screen: string) {
  if (observedCount !== 0) return;
  const pair = hookGraphCheckPair(workflow);
  const failed = pair?.find(entry => entry.stepIndex === failedStep - 1 && entry.checkIndex === checkIndex);
  return failed && hookPresentInGraph(screen, failed.check) ? pair : undefined;
}
