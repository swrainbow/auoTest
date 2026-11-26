const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mapReadbackFailureStep } = require('../src/runs/map-readback-repair');
const { RunsService } = require('../src/runs/runs.service');

const page = '/tkmap/mapDraw';
const targetBaseUrl = 'http://example.invalid';
const op = { type: 'import-generated-map', layout: { mapName: '目标图', floor: 1,
  warehouse: { shape: 'straight', aislePoints: 4, storageCount: 2, workCount: 1, chargeCount: 1 } } };
const workflow = [
  { operations: [{ type: 'open', path: page }], checks: [{ type: 'url', path: page }] },
  { operations: [op], checks: [{ type: 'url', path: page }] },
];
const steps = [{ order: 1, action: '打开地图' }, { order: 2, action: '读取地图', skill: '地图准备' }];
const call = { business: steps[1], callKind: 'operation', callType: op.type };
const listener = { ...call, api: 'browser.waitForResponse', label: String(/\/tkmap\/map\/getById\/42\/?(?:[?#]|$)/),
  error: { code: 'STEP_NOT_AWAITED' } };
const click = { ...call, api: 'locator.click', label: '.map-dropdown-menu[role=menu] >> getByRole("menuitem", name: "目标图")',
  error: { code: 'ACTION_FAILED', message: 'element is not visible' } };
const failure = { failedBusinessStep: 2, failedCallKind: 'operation', failedCallIndex: 0, failedCallType: op.type, steps: [listener, click] };
const version = { version: 2, testCaseId: 5, workflow: JSON.stringify(workflow), steps: JSON.stringify(steps), scriptPath: 'case.e2e.ts', skill: 'tusk-map-simulation' };
const source = { id: 4, testCaseId: 5, targetBaseUrl, target: version.scriptPath, status: 'failed', version: 2, autoRepair: true,
  testCase: { id: 5, currentVersion: 2 }, summary: JSON.stringify(failure) };
const retry = { ...source, id: 6, repairOf: 4, mode: 'strict' };

test('recognizes both errors in the target map import before upload', () => {
  assert.equal(mapReadbackFailureStep(workflow, failure), 2);
  for (const evidence of [
    [listener], [click], [listener, { ...click, business: steps[0] }],
    [listener, { ...click, label: click.label.replace('目标图', '其他图') }],
    [{ ...click, api: 'locator.setInputFiles' }, listener, click],
  ]) assert.equal(mapReadbackFailureStep(workflow, { ...failure, steps: evidence }), undefined);
});

test('a matching runtime failure queues a single linked strict trial of the same version', async () => {
  let queued, linked;
  const transaction = {
    testCase: { findFirst: async () => source.testCase },
    testRun: {
      findFirst: async () => null,
      create: async ({ data }) => {
        queued = data;
        return { ...data, id: 6, testCase: source.testCase, createdAt: new Date() };
      },
      update: async ({ data }) => { linked = data.repairRunId; },
    },
  };
  const prisma = { testRun: { findFirst: async () => null, updateMany: async () => ({ count: 1 }) }, $transaction: fn => fn(transaction) };
  const runs = new RunsService(prisma, {}, {}, {}, { version: async () => version }, {});
  runs.findFailed = async () => source;
  runs.schedule = () => {};
  const trial = await runs.repair(source.id);
  assert.equal(queued.version, version.version);
  assert.equal(queued.target, source.target);
  assert.equal(queued.mode, 'strict');
  assert.equal(queued.repairOf, source.id);
  assert.equal(linked, trial.id);
  assert.equal(queued.autoRepair, false);
  assert.equal((await runs.prepareRepair(retry)).availability.canStart, false);
});

test('only a linked zero-model pass verifying this read records reusable instructions in the effective step skill', async () => {
  const recorded = [];
  const original = { ...source, repairRunId: retry.id };
  const runs = new RunsService({
    testRun: { findUnique: async () => original }, testCase: { findUnique: async () => source.testCase },
  }, {}, {}, {}, {}, { recordVerifiedRepair: async (...args) => { recorded.push(args); return 'skill.json'; } });
  const pass = { fullyPassed: true, zeroAi: true, summary: { steps: [{ ...listener, status: 'passed', error: undefined }] } };
  const learn = (report, run = retry) => runs.learnVerifiedRepair(run, version, targetBaseUrl, { workflow, steps, report });
  for (const report of [{ ...pass, zeroAi: false }, { ...pass, fullyPassed: false }, { ...pass, summary: { steps: [] } }]) {
    assert.equal(await learn(report), undefined);
  }
  assert.equal(await learn(pass, { ...retry, id: 100 }), undefined);
  assert.equal(recorded.length, 0);
  assert.equal((await learn(pass)).skillLearning.status, 'recorded');
  const [skill, url, runId, practice] = recorded[0];
  assert.equal(skill, steps[1].skill);
  assert.equal(url, targetBaseUrl);
  assert.equal(runId, retry.id);
  assert.ok(!/目标图|42/.test(JSON.stringify(practice)));
});
