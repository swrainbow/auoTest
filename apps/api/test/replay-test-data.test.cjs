const assert = require('node:assert/strict');
const { test } = require('node:test');
const { taskConfigExactRowSelector } = require('../src/planner/workflow');
const { simulationCreationGuard, taskConfigCreationGuard, taskConfigGuardAtStep } = require('../src/runs/replay-test-data');

const name = 'legoTask2';
const filter = { type: 'filter-task-config', value: name };
const count = (value, configName = name) => ({
  type: 'count', locator: { kind: 'css', value: taskConfigExactRowSelector(configName) }, value,
});
const workflowStep = (operations, ...checks) => ({ operations, checks });
const open = workflowStep([{ type: 'open', path: '/task/taskLego' }], { type: 'url', path: '/task/taskLego' });
const initialGuard = workflowStep([filter], count(0));
const created = workflowStep([], count(1));

test('a fixed-name guard followed by verified presence identifies data required for replay', () => {
  const workflow = [open, initialGuard, created];
  assert.deepEqual(taskConfigCreationGuard(workflow), { step: 2, name });
  assert.deepEqual(taskConfigGuardAtStep(workflow, 1, 0), { name });
  assert.equal(taskConfigGuardAtStep(workflow, 2, 0), undefined);
});

test('read-only checks and verified cleanup do not suppress automatic replay', () => {
  assert.equal(taskConfigCreationGuard([open, initialGuard]), undefined);
  assert.equal(taskConfigCreationGuard([open, initialGuard, workflowStep([], count(1, 'other'))]), undefined);
  assert.equal(taskConfigCreationGuard([open, initialGuard, created, workflowStep([filter], count(0))]), undefined);
});

test('a missing or mismatched filter and a non-exact guard are not inferred as test data requirements', () => {
  for (const guard of [
    workflowStep([], count(0)),
    workflowStep([filter], count(0, 'another')),
    workflowStep([filter], { type: 'count', locator: { kind: 'css', value: '.el-table__row' }, value: 0 }),
  ]) {
    const workflow = [open, guard, created];
    assert.equal(taskConfigGuardAtStep(workflow, 1, 0), undefined);
    assert.equal(taskConfigCreationGuard(workflow), undefined);
  }
});

const createSim = mapName => ({ type: 'create-simulation-instance', key: 'sim', mapName });

test('only explicit simulation creation defers replay and each map is listed once', () => {
  assert.deepEqual(simulationCreationGuard([workflowStep([createSim('A'), createSim('B'), createSim('A')])]),
    { kind: 'simulation-instance', name: 'A、B' });
  assert.equal(simulationCreationGuard([workflowStep([], { type: 'simulation-running', mapName: 'A', key: 'sim' })]), undefined);
});

test('exploration defers replay; duplicate names end exploration, strict verification and repair trials as warnings', async t => {
  const { mkdtemp, mkdir, writeFile, rm } = require('node:fs/promises');
  const { tmpdir } = require('node:os');
  const { join } = require('node:path');
  const { RunsService } = require('../src/runs/runs.service');
  const { SIMULATION_FINISHED_URL } = require('../src/planner/workflow');
  const root = await mkdtemp(join(tmpdir(), 'autotest-verification-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = { root, artifactsRoot: join(root, 'artifacts'), e2eProject: join(root, 'e2e-project') };
  const run = { id: 31, testCaseId: 12, target: 'case.e2e.ts', targetBaseUrl: 'http://localhost', mode: 'explore', version: 1 };
  const workflow = [
    workflowStep([{ type: 'open', path: '/task/simConfig' }, createSim('Map02')], { type: 'simulation-created', key: 'sim', mapName: 'Map02' }),
    workflowStep([{ type: 'act', instruction: '读取表格' }], { type: 'url', path: '/task/simConfig' }),
  ];
  const steps = workflow.map((_, i) => ({ order: i + 1, action: '测试' }));
  const version = { version: 1, scriptPath: run.target, workflow: JSON.stringify(workflow), steps: JSON.stringify(steps) };
  let finished;
  let parentRepair;
  let caseUpdates = 0;
  const transaction = {
    testRun: { updateMany: async ({ where, data }) => {
      if (where.status === 'running') finished = data;
      else parentRepair = data;
      return { count: 1 };
    },
      create: async () => assert.fail('unexpected verification enqueue') },
    testCase: { updateMany: async () => { caseUpdates++; return { count: 1 }; } },
  };
  const service = new RunsService({
    testRun: { updateMany: async () => ({ count: 1 }),
      findUnique: async () => ({ repairOf: null }) },
    $transaction: callback => callback(transaction),
  }, paths, {
    get: async () => ({ targetLogin: { username: '', password: '' }, runTimeoutMinutes: 1 }),
    getModelConfig: async () => ({}),
  }, {}, { version: async () => version, checkSource: async () => {} }, {});
  service.runProcess = async (_id, args) => {
    const output = args[args.indexOf('--output') + 1];
    await mkdir(output, { recursive: true });
    const marker = { api: 'browser.waitForURL', label: String(SIMULATION_FINISHED_URL), status: 'passed' };
    const steps = [{ api: 'app.open', status: 'passed' }, marker, marker, { api: 'agent.act', status: 'passed' },
      { api: 'expect.toHaveURL', status: 'passed' }];
    await writeFile(join(output, 'report.json'), JSON.stringify({ schemaVersion: 'report-1',
      run: { results: [{ selected: true, status: 'passed', attempts: [{ status: 'passed', steps }] }] } }));
    return { code: 0 };
  };
  await service.execute(run);
  assert.equal(finished.status, 'passed');
  assert.deepEqual(JSON.parse(finished.summary).verificationDeferred, { kind: 'simulation-instance', name: 'Map02' });
  const duplicate = { code: 'ERROR', message: '仿真实例重名告警：名称「Map02」已存在，实例 22（地图「Map02」，创建）。已跳过新增及后续步骤。' };
  let outcome = { code: 1 };
  service.runProcess = async (_id, args) => {
    const output = args[args.indexOf('--output') + 1];
    await mkdir(output, { recursive: true });
    const steps = [{ api: 'app.open', status: 'passed' }, { api: 'browser.evaluate', status: 'passed' }];
    await writeFile(join(output, 'report.json'), JSON.stringify({ schemaVersion: 'report-1',
      run: { results: [{ selected: true, status: 'failed', attempts: [{ status: 'failed', steps, error: duplicate }] }] } }));
    return outcome;
  };
  service.repair = async () => assert.fail('unexpected repair');
  service.learnVerifiedRepair = async () => assert.fail('unexpected skill learning');
  for (const trial of [{ id: 32 }, { id: 33, mode: 'strict', summary: JSON.stringify({ verificationOf: run.id }) }, { id: 34, repairOf: 7 }]) {
    await service.execute({ ...run, autoRepair: true, ...trial });
    assert.equal(finished.status, 'warning');
    assert.equal(finished.error, null);
    assert.equal(finished.exitCode, 1);
    assert.equal(finished.repairState, null);
    const summary = JSON.parse(finished.summary);
    assert.deepEqual(summary.warning, { step: 1, message: duplicate.message });
    assert.equal(summary.failed, 0);
    if (trial.mode === 'strict') assert.equal(summary.verificationOf, run.id);
    if (trial.repairOf) assert.equal(summary.skillLearning.status, 'skipped');
  }
  assert.deepEqual(parentRepair, { repairState: 'warning' });
  assert.equal(caseUpdates, 1, 'only the original passing exploration may update the case');
  outcome = { code: 1, error: 'process error' };
  await service.execute({ ...run, id: 35 });
  assert.equal(finished.status, 'error');
  assert.equal(finished.error, 'process error');
  assert.equal(JSON.parse(finished.summary).warning, undefined);
  assert.equal(JSON.parse(finished.summary).failed, 1);
});

test('a source failure reflects the warning from strict verification of its repair trial', async () => {
  const { RunsService } = require('../src/runs/runs.service');
  const skipped = { status: 'skipped', reason: '遇到同名仿真实例，已跳过后续验证。' };
  const records = {
    1: { id: 1, status: 'failed', repairRunId: 2, createdAt: new Date(), summary: null },
    2: { status: 'passed', verificationRunId: 3, summary: JSON.stringify({ skillLearning: { status: 'pending-verification' } }) },
    3: { status: 'warning', summary: JSON.stringify({ warnings: 1, skillLearning: skipped }) },
  };
  const service = new RunsService({ testRun: { findUnique: async ({ where }) => records[where.id] } });
  const source = await service.get(1);
  assert.equal(source.status, 'failed');
  assert.deepEqual(source.summary.skillLearning, skipped);
});
