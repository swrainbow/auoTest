const assert = require('node:assert/strict');
const { test } = require('node:test');
const { evidencedHookGraphRepair } = require('../src/planner/hook-graph-repair');
const { PlannerService } = require('../src/planner/planner.service');
const { validateWorkflow } = require('../src/planner/workflow');
const { RunsService } = require('../src/runs/runs.service');

const locator = value => ({ kind: 'css', value });
const openStage = { type: 'click', locator: locator('.vue-flow__node-llm:has(.node-header > div:text-is("取货")) .node-item > div:text-is("离开后")') };
const graph = { type: 'count', value: 1, locator: locator('.el-drawer:visible .vue-flow__node:has-text("回调")') };
const unrelated = { type: 'count', testId: 'callback-card', value: 1 };
const save = { type: 'click', locator: locator('[role="dialog"][aria-label="任务配置"] button[name="确定"]') };
const reopen = { type: 'press', key: 'Enter', locator: locator('.el-table__body tr:has(td :text-is("test")) button[title="修改"]') };
const original = [
  { operations: [{ type: 'open', path: '/task/taskLego' }, openStage], checks: [unrelated, graph] },
  { operations: [save, { type: 'filter-task-config', value: 'test' }, reopen], checks: [unrelated] },
  { operations: [openStage], checks: [graph, unrelated] },
];
const steps = original.map((_, i) => ({ order: i + 1, action: '查看回调', expected: '执行顺序与保存前一致' }));
const screen = [
  ' #n0 dialog "取货 - 离开后"',
  '  #n1 text="abc45 - 回调"',
  '  #n2 text="执行顺序"',
  '  #n3 text="abc45"',
].join('\n');

test('an evidenced callback graph locator is repairable automatically and manually without a configured model', async () => {
  const planner = new PlannerService({}, {});
  const summary = { failedBusinessStep: 1, failedCallKind: 'check', failedCallType: 'count', failedCallIndex: 1, failedObservedCount: 0 };
  const targetBaseUrl = 'http://example.invalid';
  const run = {
    id: 1, testCase: { id: 1, currentVersion: 2 }, targetBaseUrl, version: 2,
    target: 'test.e2e.ts', summary: JSON.stringify(summary),
  };
  const version = { workflow: JSON.stringify(original), steps: JSON.stringify(steps), skill: 'task-config', scriptPath: run.target };
  const runs = new RunsService({ testRun: { findFirst: async () => null } }, {}, {}, planner, { version: async () => version }, {});
  runs.readFailureScreen = async () => screen;
  for (const automatic of [true, false]) {
    const { availability, target } = await runs.prepareRepair(run, automatic);
    assert.equal(availability.canStart, true);
    const repaired = await planner.repairWorkflow({ skill: version.skill, steps }, original, targetBaseUrl, {
      ...target, failure: 'count 0', screen, logTail: '', priorFailures: [],
    });
    const baseline = { node: '取货', stage: '离开后', hook: '回调', key: 'hookGraphBeforeSave' };
    assert.deepEqual(repaired.workflow, [
      { operations: original[0].operations, checks: [unrelated, { type: 'capture-hook-graph', ...baseline }] },
      original[1],
      { operations: original[2].operations, checks: [{ type: 'matches-hook-graph', ...baseline }, unrelated] },
    ]);
  }
  runs.readFailureScreen = async () => screen.replace('#n3 text="abc45"', '#n3 text="different"');
  for (const automatic of [true, false]) assert.equal((await runs.prepareRepair(run, automatic)).availability.canStart, false);
});

test('a graph correction needs the same card and node in the target stage, and a pair of checks in distinct openings', () => {
  for (const value of [
    screen.replace('取货 - 离开后', '放货 - 离开后'),
    screen.replace('abc45 - 回调', 'other - 回调'),
    screen.replace('执行顺序', '默认顺序'),
    screen + '\n  #n4 text="abc45"',
    screen.replace('  #n2', '  #n4 text="cde56 - 回调"\n  #n2'),
    screen.replace('  #n3', ' #n3'),
  ]) assert.equal(evidencedHookGraphRepair(original, 1, 1, 0, value), undefined);
  for (const [step, index, observed] of [[1, 0, 0], [1, 1, 1], [1, 1, undefined]]) {
    assert.equal(evidencedHookGraphRepair(original, step, index, observed, screen), undefined);
  }
  for (const modified of [
    original.slice(0, 2),
    [original[0], { ...original[1], operations: original[1].operations.slice(1) }, original[2]],
    [original[0], { ...original[1], operations: original[1].operations.slice(0, 2) }, original[2]],
    [original[0], { ...original[1], operations: [save, { type: 'filter-task-config', value: 'other' }, reopen] }, original[2]],
    [original[0], original[1], { ...original[2], operations: [] }],
    [original[0], original[1], { ...original[2], operations: [{ ...openStage, locator: locator(openStage.locator.value.replace('取货', '放货')) }] }],
    [{ ...original[0], checks: [{ ...graph, value: 0 }] }, ...original.slice(1)],
  ]) assert.equal(evidencedHookGraphRepair(modified, 1, 1, 0, screen), undefined);
});

test('a stage and hook taken from a different task graph need matching drawer evidence', () => {
  const replace = text => text.replaceAll('取货', '放货').replaceAll('离开后', '到达时').replaceAll('回调', '流程');
  const workflow = JSON.parse(replace(JSON.stringify(original)));
  assert.equal(evidencedHookGraphRepair(workflow, 1, 1, 0, screen), undefined);
  const pair = evidencedHookGraphRepair(workflow, 1, 1, 0, replace(screen));
  assert.deepEqual(pair[0].check, {
    type: 'capture-hook-graph', node: '放货', stage: '到达时', hook: '流程', key: 'hookGraphBeforeSave',
  });
});

test('verified graph learning records the typed checks and requires the full capture and readback pair', async () => {
  const recorded = [];
  const prior = { steps: JSON.stringify(steps), skill: 'task-config', workflow: JSON.stringify(original) };
  const runs = new RunsService({
    testRun: { findUnique: async () => ({ version: 2 }) },
    testCase: { findUnique: async () => ({ currentVersion: 3 }) },
  }, {}, {}, {}, { version: async () => prior }, {
    recordVerifiedRepair: async (skill, url, runId, rules) => {
      recorded.push({ skill, url, runId, rules });
      return 'task-config/references/verified-repairs/fixture.json';
    },
  });
  const pair = evidencedHookGraphRepair(original, 1, 1, 0, screen);
  const repaired = validateWorkflow(original, steps.length);
  for (const { stepIndex, checkIndex, check } of pair) repaired[stepIndex].checks[checkIndex] = check;
  const target = 'http://example.invalid';
  const learn = () => runs.learnVerifiedRepair({ id: 42, repairOf: 41 }, { ...prior, testCaseId: 1, version: 3 }, target, { workflow: repaired, steps });
  assert.equal((await learn()).skillLearning.status, 'recorded');
  assert.deepEqual(recorded, [{
    skill: prior.skill, url: target, runId: 42, rules: pair.map(({ check }) => ({
      page: '/task/taskLego', checks: [{ type: 'count', from: graph.locator.value, replacement: check }],
    })),
  }]);
  repaired[2].checks[0] = graph;
  assert.equal(await learn(), undefined);
  assert.equal(recorded.length, 1);
});
