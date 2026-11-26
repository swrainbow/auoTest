const assert = require('node:assert/strict');
const { test } = require('node:test');
const vm = require('node:vm');
const { validateWorkflow, compileWorkflow } = require('../src/planner/workflow');
const { readHookGraph } = require('../src/planner/hook-graph');

const capture = {
  type: 'capture-hook-graph', node: '取货', stage: '离开后', hook: '回调', key: 'afterLeave',
};
const compare = { ...capture, type: 'matches-hook-graph' };

function workflowWith(check) {
  return [
    { operations: [{ type: 'open', path: '/task/taskLego' }], checks: [capture] },
    { operations: [], checks: [check] },
  ];
}

test('graph baselines are limited to the same main node, stage, hook type, and key', () => {
  const workflow = workflowWith(compare);
  assert.deepEqual(validateWorkflow(workflow, 2), workflow);
  for (const field of [{ node: '放货' }, { stage: '到达时' }, { hook: '机器人' }, { key: '另一个' }]) {
    assert.throws(() => validateWorkflow(workflowWith({ ...compare, ...field }), 2), /先记录同类型/);
  }
  assert.throws(() => validateWorkflow(workflowWith({ ...compare, stage: '任意' }), 2), /未知任务配置时态阶段/);
  assert.throws(() => validateWorkflow(workflowWith({ type: 'matches-text', testId: 'field', key: capture.key }), 2), /先记录同类型/);
  assert.throws(() => validateWorkflow(workflowWith(capture), 2), /不能重复记录/);
});

test('generated scripts embed the graph reader and use one browser evaluation for each graph check', () => {
  const script = compileWorkflow('执行顺序', [{ action: '配置' }, { action: '回读' }], workflowWith(compare));
  assert.match(script, /async \(\{ app, browser \}\)/);
  assert.match(script, /const readHookGraph: .* = async function/);
  assert.equal(script.match(/await browser\.evaluate\(readHookGraph,/g)?.length, 2);
  assert.match(script, /compare: true, expected: hookGraphs\.get\("afterLeave"\)/);
});

// Reproduce the stage drawer's observed card titles, Vue Flow node labels, and SVG endpoint attributes.
function readFixture({ nodeIds, edge, labels = ['hEZ2m', 'uvghq'] }, expected = null) {
  const cards = ['hEZ2m - 机器人', 'uvghq - 回调'].map(textContent => ({
    querySelector: s => s === '.tk-form-dynamic-title' ? { textContent } : null,
  }));
  const nodes = labels.map((textContent, i) => ({
    textContent, getAttribute: name => name === 'data-id' ? nodeIds[i] : null,
  }));
  const edges = edge ? [{
    querySelector: s => s === '.vue-flow__edge-path' ? { getAttribute: name => edge[name] } : null,
  }] : [];
  const graph = { querySelectorAll: s => ({ '.vue-flow__node': nodes, '.vue-flow__edge': edges }[s]) };
  const drawer = {
    getClientRects: () => [{}],
    querySelector: s => s === '.el-drawer__title' ? { textContent: '取货 - 离开后' } : null,
    querySelectorAll: s => ({ '.hook-chain .vue-flow': [graph], '.tk-form-switcher-section': cards }[s]),
  };
  let now = 0;
  const page = {
    document: { querySelectorAll: s => s === '.el-drawer' ? [drawer] : [] },
    getComputedStyle: () => ({ visibility: 'visible' }),
    Date: { now: () => now },
    setTimeout: (fn, ms) => { now += ms; fn(); },
  };
  const run = vm.runInNewContext('(' + readHookGraph.toString() + ')', page);
  return run({ ...capture, compare: expected !== null, expected });
}

test('hook identity follows card labels while dependencies follow directed graph endpoints across a redraw', async () => {
  const baseline = await readFixture({ nodeIds: ['1', '2'], edge: { source: '1', target: '2' } });
  const nodeIds = ['9', '7'];
  assert.equal(await readFixture({ nodeIds, edge: { source: '9', target: '7' } }, baseline), baseline);
  await assert.rejects(readFixture({ nodeIds, edge: { source: '7', target: '9' } }, baseline), /依赖关系与保存前不同/);
  await assert.rejects(readFixture({ nodeIds }, baseline), /依赖关系与保存前不同/);
  await assert.rejects(readFixture({ nodeIds, edge: { source: '9', target: '404' } }), /连线没有对应/);
  await assert.rejects(readFixture({ nodeIds, labels: ['hEZ2m', '回调'] }), /节点与 Hook 卡片不能一一对应/);
});
