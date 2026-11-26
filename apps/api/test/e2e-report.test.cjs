const assert = require('node:assert/strict');
const { mkdtemp, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { test } = require('node:test');
const { readE2eReport, isRepairableUiFailure } = require('../src/runs/e2e-report');
const { GENERATED_MAP_FINISHED_URL, PALADIN_BIND_FINISHED_URL, SIMULATION_FINISHED_URL, validateWorkflow } = require('../src/planner/workflow');

const popover = { locator: { kind: 'css', value: '.filter-popover' } };
const workflow = [{
  operations: [{ type: 'open', path: '/list' }, { type: 'wait-hidden', ...popover }],
  checks: [{ type: 'count', testId: 'matching-row', value: 0 }],
}];
const business = [{ order: 1, action: '筛选名称', expected: '没有同名配置' }];
const passed = (api) => ({ api, label: api, status: 'passed', durationMs: 1 });
const failed = (api) => ({ ...passed(api), status: 'failed', error: { code: 'ASSERTION_FAILED' } });

async function readReport(steps, caseWorkflow = workflow, businessSteps = business, attemptError, hasPrerequisite = false, runErrors = []) {
  const dir = await mkdtemp(join(tmpdir(), 'autotest-report-'));
  try {
    const file = join(dir, 'report.json');
    await writeFile(file, JSON.stringify({
      schemaVersion: 'report-1',
      run: { errors: runErrors, results: [{ selected: true, status: 'failed', attempts: [{ status: 'failed', steps, error: attemptError }] }] },
    }));
    return await readE2eReport(file, caseWorkflow, businessSteps, hasPrerequisite);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('an assertion used as a transition wait can be repaired', async () => {
  const { summary, error } = await readReport([passed('app.open'), failed('expect.toBeHidden')]);
  assert.equal(summary.failedBusinessStep, 1);
  assert.equal(summary.failedCallIndex, 1);
  assert.equal(summary.failedCallType, 'wait-hidden');
  assert.equal(isRepairableUiFailure(summary.failedCallKind, summary.failedCallType, error.code), true);
});

test('an abandoned response wait does not mask the click error that ended the attempt', async () => {
  const map = [{ operations: [{ type: 'open', path: '/tkmap/mapDraw' }, { type: 'import-generated-map' }], checks: [] }];
  const pending = { ...failed('browser.waitForResponse'), error: { code: 'STEP_NOT_AWAITED', message: 'response still pending' } };
  const click = { ...failed('locator.click'), error: { code: 'ACTION_FAILED', message: 'map option is hidden' } };
  const { error, summary } = await readReport([passed('app.open'), pending, click], map, business, click.error);
  assert.deepEqual(error, click.error);
  assert.equal(summary.failedCallType, 'import-generated-map');
  const timedOutListener = { ...pending, error: { code: 'ACTION_FAILED', message: 'no response before timeout' } };
  const settled = await readReport([passed('app.open'), timedOutListener, click], map, business, click.error);
  assert.deepEqual(settled.error, click.error);
  const abandoned = await readReport([passed('app.open'), pending], map, business, pending.error);
  assert.deepEqual(abandoned.error, pending.error);
});

test('map import failure and subsequent assertions remain distinct across the nested map-switch URL check', async () => {
  const generatedMap = { operations: [workflow[0].operations[0], { type: 'import-generated-map' }], checks: workflow[0].checks };
  const prefix = [passed('app.open'), passed('browser.waitForURL'), passed('expect.toHaveURL')];
  const upload = await readReport([...prefix, failed('locator.setInputFiles')], [generatedMap]);
  assert.equal(upload.summary.failedCallType, 'import-generated-map');
  assert.equal(isRepairableUiFailure('operation', 'import-generated-map', 'ACTION_FAILED'), false);
  const betweenCalls = await readReport(prefix, [generatedMap], business, { code: 'ERROR', message: '读取结果不符' });
  assert.equal(betweenCalls.summary.failedCallType, 'import-generated-map');
  const label = String(GENERATED_MAP_FINISHED_URL);
  const complete = [...prefix, passed('locator.setInputFiles'), { ...passed('browser.waitForURL'), label },
    { ...passed('expect.toHaveURL'), label }];
  const checked = await readReport([...complete, failed('expect.toHaveCount')], [generatedMap]);
  assert.equal(checked.summary.failedCallKind, 'check');
  assert.equal(checked.summary.failedCallType, 'count');
});

test('a failed business check remains outside auto repair', async () => {
  const countError = failed('expect.toHaveCount');
  countError.error.details = { matches: 2 };
  const { summary, error } = await readReport([passed('app.open'), passed('expect.toBeHidden'), countError]);
  assert.equal(summary.failedCallKind, 'check');
  assert.equal(summary.failedCallType, 'count');
  assert.equal(summary.failedObservedCount, 2);
  assert.equal(isRepairableUiFailure(summary.failedCallKind, summary.failedCallType, error.code), false);
});

test('binding and simulation helper reports preserve the operation and readback boundaries', async () => {
  const target = { key: 'instance', mapName: 'warehouse' };
  const caseWorkflow = [
    { operations: [workflow[0].operations[0], { type: 'bind-paladin-map', mapName: target.mapName }],
      checks: [{ type: 'visible', testId: 'service' }] },
    { operations: [{ type: 'create-simulation-instance', ...target }], checks: [{ type: 'simulation-created', ...target }] },
  ];
  const businessSteps = [business[0], { order: 2, action: '创建仿真', expected: '目标地图的新实例可见' }];
  const marker = url => ['browser.waitForURL', 'expect.toHaveURL'].map(api => ({ ...passed(api), label: String(url) }));
  const prefix = [passed('app.open'), passed('locator.click'), ...marker(PALADIN_BIND_FINISHED_URL), passed('expect.toBeVisible')];
  const created = [...prefix, passed('locator.click'), ...marker(SIMULATION_FINISHED_URL)];
  const result = await readReport([...created, failed('expect.toHaveText')], caseWorkflow, businessSteps);
  assert.equal(result.summary.steps[1].callType, 'bind-paladin-map');
  assert.equal(result.summary.steps[prefix.length].callType, 'create-simulation-instance');
  assert.equal(result.summary.failedCallType, 'simulation-created');
  assert.equal(result.summary.failedCallKind, 'check');
  const threw = await readReport(prefix, caseWorkflow, businessSteps, { code: 'ERROR', message: '同名实例新增编号不唯一' });
  assert.equal(threw.summary.failedCallType, 'create-simulation-instance');
  assert.equal(isRepairableUiFailure('operation', 'start-simulation-instance', 'ACTION_FAILED'), false);
});

test('only the duplicate-name signal during the creation precheck is a business warning', async () => {
  const target = { key: 'instance', mapName: 'Map02' };
  const sim = [{ operations: [workflow[0].operations[0], { type: 'create-simulation-instance', ...target }],
    checks: [{ type: 'simulation-created', ...target }] }];
  const prefix = [passed('app.open'), passed('browser.waitForResponse'), passed('browser.reload'), passed('browser.evaluate')];
  const duplicate = { code: 'ERROR', message: '仿真实例重名告警：名称「Map02」已存在，实例 311（地图「Map03」，运行中）。已跳过新增及后续步骤。' };
  const result = await readReport(prefix, sim, business, duplicate);
  assert.deepEqual(result.summary.warning, { step: 1, message: duplicate.message });
  assert.deepEqual([result.summary.passed, result.summary.failed, result.summary.warnings, result.summary.total], [0, 0, 1, 1]);
  assert.equal(result.error, undefined);
  assert.equal(result.summary.failedBusinessStep, null);
  assert.equal(result.fullyPassed, false);
  assert.equal(result.zeroAi, false);

  const marker = { ...passed('browser.waitForURL'), label: String(SIMULATION_FINISHED_URL) };
  for (const other of [
    await readReport([...prefix, marker, passed('browser.evaluate')], sim, business, duplicate),
    await readReport([...prefix, failed('expect.toBeVisible')], sim, business, duplicate),
    await readReport(prefix, sim, business, { code: 'ERROR', message: '仿真实例创建冲突：历史记录' }),
    await readReport(prefix, sim, business, { ...duplicate, code: 'TEST_TIMEOUT' }),
    await readReport(prefix, sim, business, duplicate, false, [{ code: 'ERROR', message: 'teardown failed' }]),
    await readReport([passed('app.open')], sim, business, duplicate),
  ]) {
    assert.ok(other.error);
    assert.equal(other.summary.warning, undefined);
    assert.equal(other.summary.failed, 1);
  }
});

test('baseline differences remain mapped to their business check', async () => {
  const editor = { locator: { kind: 'css', value: '.editor' } };
  const withBaseline = [{ operations: [{ type: 'open', path: '/list' }], checks: [
    { type: 'capture-json', key: 'request', ...editor },
    { type: 'matches-json', key: 'request', ...editor },
  ] }];
  const { summary } = await readReport([
    passed('app.open'), passed('expect.toBeVisible'), passed('browser.evaluate'),
    passed('expect.toBeVisible'), failed('browser.evaluate'),
  ], withBaseline);
  assert.equal(summary.failedBusinessStep, 1);
  assert.equal(summary.failedCallKind, 'check');
  assert.equal(summary.failedCallType, 'matches-json');
  assert.equal(summary.failedCallIndex, 1);
});

test('matching a baseline requires an earlier capture of the same type', () => {
  const editor = { locator: { kind: 'css', value: '.editor' } };
  const capture = { type: 'capture-json', key: 'request', ...editor };
  const match = { type: 'matches-json', key: 'request', ...editor };
  const baselineWorkflow = (checks) => [{ operations: [{ type: 'open', path: '/' }], checks }];
  assert.throws(() => validateWorkflow(baselineWorkflow([match, capture]), 1), /请先记录同类型/);
  assert.throws(() => validateWorkflow(baselineWorkflow([{ ...capture, type: 'capture-text' }, match]), 1), /请先记录同类型/);
  assert.deepEqual(validateWorkflow(baselineWorkflow([capture, match]), 1), baselineWorkflow([capture, match]));
  assert.doesNotThrow(() => validateWorkflow([{ operations: [], checks: [match] }], 1, undefined,
    { requireOpen: false, allowMissingBaselines: true }));
});

test('a report that diverges from the compiled workflow does not authorize an automatic repair', async () => {
  const { summary } = await readReport([passed('browser.evaluate'), failed('expect.toBeHidden')]);
  assert.equal(summary.failedBusinessStep, null);
  assert.equal(summary.failedCallKind, null);
  assert.equal(isRepairableUiFailure(summary.failedCallKind, summary.failedCallType, 'ACTION_FAILED'), false);
});

test('filter row readiness and the subsequent business row count are classified separately', async () => {
  const filterWorkflow = [{
    operations: [{ type: 'open', path: '/task/taskLego' }, { type: 'filter-task-config', value: 'legoTask2' }],
    checks: workflow[0].checks,
  }];
  const search = [
    'app.open', 'locator.click', 'locator.fill', 'browser.waitForResponse', 'locator.click', 'expect.toHaveText',
  ].map(passed);
  const runtime = await readReport([...search, failed('expect.toHaveCount')], filterWorkflow);
  assert.equal(runtime.summary.failedCallType, 'filter-task-config');
  assert.equal(runtime.summary.failedObservedCount, null);
  assert.equal(isRepairableUiFailure(runtime.summary.failedCallKind, runtime.summary.failedCallType, runtime.error.code), true);

  const applied = ['expect.toHaveCount', 'locator.click', 'expect.toBeHidden'].map(passed);
  const check = await readReport([...search, ...applied, failed('expect.toHaveCount')], filterWorkflow);
  assert.equal(check.summary.failedCallKind, 'check');
  assert.equal(isRepairableUiFailure(check.summary.failedCallKind, check.summary.failedCallType, check.error.code), false);
});

for (const [sessionType, path] of [['ensure-task-config-session', '/task/taskLego'], ['ensure-map-session', '/tkmap/mapDraw']]) {
test(sessionType + ' maps both session states and never sends a login failure to auto repair', async () => {
  const sessionWorkflow = [{
    operations: [{ type: 'open', path }, { type: sessionType }],
    checks: workflow[0].checks,
  }];
  const start = ['app.open', 'expect.toBeVisible'].map(passed);
  const login = ['locator.fill', 'locator.fill', 'locator.click'].map(passed);
  const ready = ['expect.toHaveURL', 'expect.toBeVisible'].map(passed);
  for (const branch of [[], login]) {
    const { summary } = await readReport([...start, ...branch, ...ready, failed('expect.toHaveCount')], sessionWorkflow);
    assert.equal(summary.failedCallKind, 'check');
    assert.equal(summary.failedCallType, 'count');
  }
  const auth = await readReport([...start, ...login, failed('expect.toHaveURL')], sessionWorkflow);
  assert.equal(auth.summary.failedCallType, sessionType);
  assert.equal(isRepairableUiFailure(auth.summary.failedCallKind, auth.summary.failedCallType, 'LOCATOR_NOT_FOUND'), false);
});
}

test('task-config stage operations report their locator errors separately from business checks', async () => {
  const stageWorkflow = [{
    operations: [{ type: 'open', path: '/task/taskLego' }, { type: 'add-task-config-stage', node: '取货', stage: '离开后' }],
    checks: workflow[0].checks,
  }];
  const opened = ['app.open', 'expect.toHaveCount', 'locator.click'].map(passed);
  const operation = await readReport([...opened, failed('locator.click')], stageWorkflow);
  assert.equal(operation.summary.failedCallKind, 'operation');
  assert.equal(operation.summary.failedCallType, 'add-task-config-stage');
  const check = await readReport([...opened, passed('locator.click'), failed('expect.toHaveCount')], stageWorkflow);
  assert.equal(check.summary.failedCallKind, 'check');
  assert.equal(check.summary.failedCallType, 'count');

  const keyboard = ['app.open', 'expect.toHaveCount', 'browser.evaluate', 'locator.press'].map(passed);
  const menu = await readReport([...keyboard, failed('expect.toBeVisible')], stageWorkflow);
  assert.equal(menu.summary.failedCallType, 'add-task-config-stage');
  const afterEnter = await readReport([...keyboard, passed('expect.toBeVisible'), passed('locator.press'),
    failed('expect.toHaveCount')], stageWorkflow);
  assert.equal(afterEnter.summary.failedCallKind, 'check');
  assert.equal(afterEnter.summary.failedCallType, 'count');
});

test('map create and reuse branches end before the next business check', async () => {
  const mapOperation = { type: 'ensure-map-in-menu', frame: 'iframe#hyjalIframe', mapName: 'Task001', floor: 1 };
  const mapWorkflow = [
    { operations: [mapOperation], checks: [] },
    { operations: [], checks: [{ type: 'visible', testId: 'map-ready' }] },
  ];
  const mapSteps = [{ order: 1 }, { order: 2 }];
  for (const branch of [['locator.click'], ['locator.click', 'locator.fill', 'locator.fill', 'locator.click']]) {
    const calls = [...branch, 'browser.waitForURL'].map(passed);
    const result = await readReport([...calls, failed('expect.toBeVisible')], mapWorkflow, mapSteps);
    assert.equal(result.summary.failedBusinessStep, 2);
    assert.equal(result.summary.failedCallKind, 'check');
    assert.equal(result.summary.failedCallType, 'visible');
    assert.equal(result.summary.steps[0].callType, 'ensure-map-in-menu');
  }
  const stopped = await readReport([failed('locator.click')], mapWorkflow, mapSteps);
  assert.equal(stopped.summary.failedCallType, 'ensure-map-in-menu');
  assert.equal(isRepairableUiFailure('operation', stopped.summary.failedCallType, 'LOCATOR_NOT_FOUND'), false);

  // A read-only reuse can throw between instrumented calls when the target map is missing.
  const readback = await readReport([passed('locator.click')], mapWorkflow, mapSteps, { message: '回读缺少地图' });
  assert.equal(readback.summary.failedCallType, 'ensure-map-in-menu');
  assert.equal(readback.summary.failedBusinessStep, 1);
  const withoutMarker = await readReport([passed('locator.click'), failed('expect.toBeVisible')], mapWorkflow, mapSteps);
  assert.equal(withoutMarker.summary.failedCallType, null);
});

test('the nested URL assertion at the end of map creation preserves attribution of readback failures', async () => {
  const map = { type: 'ensure-map-in-menu', frame: 'iframe#hyjalIframe', mapName: 'Task001', floor: 1 };
  const mapWorkflow = [
    { operations: [map], checks: [{ type: 'text', testId: 'current', value: 'Task001' }] },
    { operations: [{ type: 'open', path: '/tkmap/mapDraw' }, { ...map, existingOnly: true }], checks: [] },
  ];
  const url = (api) => ({ ...passed(api), label: '/tkmap/mapDraw' });
  const { summary } = await readReport([
    passed('locator.click'), url('browser.waitForURL'), url('expect.toHaveURL'), passed('expect.toHaveText'),
    passed('app.open'), passed('locator.hover'), failed('locator.waitFor'),
  ], mapWorkflow, [{ order: 3 }, { order: 5 }]);
  assert.equal(summary.steps[2].callType, 'ensure-map-in-menu');
  assert.equal(summary.steps[3].callType, 'text');
  assert.equal(summary.failedBusinessStep, 5);
  assert.equal(summary.failedCallKind, 'operation');
  assert.equal(summary.failedCallType, 'ensure-map-in-menu');
  assert.equal(summary.failedCallIndex, 1);
});

test('reading a map floor attributes reload and response events up to the final map selection', async () => {
  const operation = { type: 'ensure-map-in-menu', mapName: '地图', frame: 'iframe#hyjalIframe', floor: 1, existingOnly: true, recordFloor: true };
  const steps = [{ operations: [operation], checks: [] }, { operations: [], checks: [{ type: 'visible', testId: 'map-ready' }] }];
  const progress = ['locator.click', 'browser.waitForResponse', 'browser.reload', 'locator.hover'].map(passed);
  const success = await readReport([...progress, passed('browser.waitForURL'), failed('expect.toBeVisible')], steps, [{ order: 1 }, { order: 2 }]);
  assert.equal(success.summary.steps[2].callType, 'ensure-map-in-menu');
  assert.equal(success.summary.failedBusinessStep, 2);
  const mismatch = await readReport(progress, steps, [{ order: 1 }, { order: 2 }], { message: '地图详情的楼层无效' });
  assert.equal(mismatch.summary.failedCallType, 'ensure-map-in-menu');
});

test('a prerequisite URL wait and its inner assertion both precede the first business operation', async () => {
  const marker = (api) => ({ ...passed(api), label: '/config/tuskService' });
  const { summary } = await readReport([
    marker('browser.waitForURL'), marker('expect.toHaveURL'), passed('app.open'), failed('expect.toBeHidden'),
  ], workflow, business, undefined, true);
  assert.equal(summary.prerequisite.status, 'passed');
  assert.equal(summary.steps[1].business, undefined);
  assert.equal(summary.failedBusinessStep, 1);
  assert.equal(summary.failedCallType, 'wait-hidden');
});
