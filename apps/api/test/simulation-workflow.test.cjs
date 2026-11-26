const assert = require('node:assert/strict');
const { test } = require('node:test');
const { compileWorkflow, validateWorkflow } = require('../src/planner/workflow');
const { PlannerService } = require('../src/planner/planner.service');

const target = { key: 'new-instance', mapName: 'Task002' };
const open = { type: 'open', path: '/task/simConfig' };
const create = { type: 'create-simulation-instance', ...target };
const configure = { type: 'configure-simulation-apr', ...target, count: 3 };
const start = { type: 'start-simulation-instance', ...target };
const created = { type: 'simulation-created', ...target };
const apr = { type: 'simulation-apr', ...target, count: 3 };
const running = { type: 'simulation-running', ...target };
const workflow = [
  { operations: [open, create], checks: [created] },
  { operations: [configure], checks: [apr] },
  { operations: [start], checks: [running] },
];
const steps = ['创建', '设置 APR', '开启'].map(action => ({ action }));

test('post-binding sync selects its skill and passes the intended services through compilation', () => {
  const planner = new PlannerService();
  for (const description of ['绑定地图后同步', '同步 Task002 对应的 Paladin 和 Rattletrap']) {
    assert.equal(planner.skillFor({ description }), 'tusk-map-binding-sync');
  }
  const path = '/config/tuskService';
  const compile = op => compileWorkflow('同步', [{ action: '同步服务' }], validateWorkflow([{
    operations: [{ type: 'open', path }, op], checks: [{ type: 'url', path }],
  }], 1));
  assert.ok(compile({ type: 'bind-paladin-map', mapName: 'M', serviceName: 'paladin-2' })
    .includes('await bindPaladinMap(browser, screen, "M", "paladin-2");'));
  assert.ok(compile({ type: 'sync-bound-map-services', mapName: 'M', rattletrapName: 'rattletrap-2' })
    .includes('await syncBoundMapServices(browser, screen, "M", undefined, "rattletrap-2");'));
});

test('generated simulation script passes the live created ID into every operation and independent check', () => {
  const source = compileWorkflow('仿真', steps, validateWorkflow(workflow, 3));
  const id = /const (\w+) = await createSimulationInstance\(browser, "Task002"\)/.exec(source)?.[1];
  assert.ok(id);
  for (const [helper, count] of [
    ['verifySimulationCreated', ''], ['configureSimulationApr', ', 3'], ['verifySimulationApr', ', 3'],
    ['startSimulationInstance', ''], ['verifySimulationRunning', ''],
  ]) {
    assert.ok(source.includes(`await ${helper}(browser, ${id}, "Task002"${count})`), helper);
  }
  assert.ok(!source.includes('agent.act'));
});

test('rejects missing or duplicate simulation keys, map changes and non-positive APR counts', () => {
  function replaceStep(index, operations, checks = workflow[index].checks) {
    return workflow.map((step, i) => i === index ? { operations, checks } : step);
  }
  assert.throws(() => validateWorkflow(replaceStep(0, [open]), 3), /先创建/);
  assert.throws(() => validateWorkflow(replaceStep(1, [create]), 3), /重复创建/);
  assert.throws(() => validateWorkflow(replaceStep(1, [{ ...configure, key: undefined }]), 3), /格式无效/);
  assert.throws(() => validateWorkflow(replaceStep(1, [{ ...configure, mapName: 'wrong' }]), 3), /地图与创建时不一致/);
  assert.throws(() => validateWorkflow(replaceStep(2, [start], [{ ...running, key: 'other' }]), 3), /先创建/);
  assert.throws(() => validateWorkflow(replaceStep(1, [{ ...configure, count: 0 }]), 3), /正整数/);
  assert.throws(() => validateWorkflow(replaceStep(1, [configure], [{ ...apr, count: 1.5 }]), 3), /正整数/);
  assert.throws(() => validateWorkflow(replaceStep(1, [{ ...configure, count: 4 }]), 3, workflow), /修复必须保留/);
  assert.doesNotThrow(() => validateWorkflow(workflow.slice(1), 2, undefined,
    { requireOpen: false, allowMissingBaselines: true, stepOffset: 1 }));
});

const oldInstanceRow = {
  type: 'wait-visible',
  locator: { kind: 'css', value: '.el-table__body tr:has(td :text-is("15")):has(td :text-is("Task002"))' },
};
const pageReady = { type: 'wait-visible', locator: { kind: 'role', role: 'columnheader', name: '编号' } };
const simulationCase = {
  name: '开启仿真', description: '', skill: 'tusk-simulation-start', taskId: '',
  steps: steps.map(({ action }, i) => ({ order: i + 1, action, expected: '操作完成' })),
};
const repairEvidence = {
  failedStep: 3, failedCall: { kind: 'operation', type: 'wait-visible', index: 1 },
  failure: '列表找不到实例行', screen: '', logTail: '', priorFailures: [],
};
const startWith = (...waits) => ({ operations: [open, ...waits, start], checks: [running] });

test('generation retries the simulation step that pinned a historical instance row', async () => {
  const planner = new PlannerService({ loadSkillDocs: async () => [] }, {
    get: async () => ({ targetBaseUrl: 'http://example.invalid' }),
    getModelConfig: async () => ({}),
  });
  let calls = 0;
  planner.chat = async (_prompt, request) => {
    calls++;
    if (request.rejectedStep) {
      assert.deepEqual(request.rejectedStep, startWith(oldInstanceRow));
      return JSON.stringify({ workflow: [startWith(pageReady)] });
    }
    return JSON.stringify({ workflow: [...workflow.slice(0, 2), startWith(oldInstanceRow)] });
  };
  const result = await planner.generateWorkflow(simulationCase);
  assert.equal(calls, 2);
  assert.deepEqual(result.workflow[2], startWith(pageReady));
});

test('simulation repair rejects a snapshot row number, keeps page waits and can repair a legacy pinned step', async () => {
  const planner = new PlannerService({ loadSkillDocs: async () => [] }, {});
  const original = [...workflow.slice(0, 2), startWith(pageReady)];
  const legacy = [...workflow.slice(0, 2), startWith(oldInstanceRow)];
  const repair = async (original, operations) => {
    planner.chat = async () => JSON.stringify({ operations });
    return planner.repairWorkflow(simulationCase, validateWorkflow(original, 3), 'http://example.invalid', repairEvidence);
  };
  for (const wait of [oldInstanceRow, { type: 'wait-visible', locator: { kind: 'role', role: 'row', name: '178 Task002 创建 Task002' } }]) {
    await assert.rejects(repair(original, startWith(wait).operations), /第 3 步.*固定编号/);
  }
  const repaired = await repair(legacy, startWith(pageReady).operations);
  assert.deepEqual(repaired.workflow, [...workflow.slice(0, 2), startWith(pageReady)]);
});

test('numeric map names and APR quantities are valid independent checks', async () => {
  const planner = new PlannerService({ loadSkillDocs: async () => [] }, {
    get: async () => ({ targetBaseUrl: 'http://example.invalid' }),
    getModelConfig: async () => ({}),
  });
  const mapName = '33';
  const draft = [{
    operations: [open, { ...create, mapName }],
    checks: [{ ...created, mapName }, { type: 'visible', locator: { kind: 'css', value: 'tr:has(td:text-is("33"))' } }],
  }, {
    operations: [{ ...configure, mapName }],
    checks: [{ ...apr, mapName }, {
      type: 'visible', locator: { kind: 'css', value: '.el-drawer:has(:text-is("33")) tr:has(td:text-is("APR")) td:text-is("3")' },
    }],
  }];
  planner.chat = async () => JSON.stringify({ workflow: draft });
  const result = await planner.generateWorkflow({ ...simulationCase, steps: simulationCase.steps.slice(0, 2) });
  assert.deepEqual(result.workflow, draft);
});
