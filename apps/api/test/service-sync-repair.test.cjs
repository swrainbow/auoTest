const assert = require('node:assert/strict');
const { test } = require('node:test');
const { PlannerService } = require('../src/planner/planner.service');
const { validateWorkflow, compileWorkflow } = require('../src/planner/workflow');
const { repeatedBindingSync, shouldResyncBinding, verifiedBindingSync } = require('../src/runs/service-sync-repair');
const { RunsService } = require('../src/runs/runs.service');

const targetBaseUrl = 'http://example.invalid';
const op = { type: 'bind-paladin-map', mapName: '站点图', serviceName: 'paladin-test' };
const business = [{ order: 1, action: '绑定地图并同步两个服务', skill: 'tusk-map-binding-sync' }];
const check = { type: 'url', path: '/config/tuskService' };
const original = [{ operations: [{ type: 'open', path: check.path }, op], checks: [check] }];
const call = { business: business[0], callKind: 'operation', callType: op.type, api: 'browser.waitForResponse', status: 'passed' };
const sync = id => ({ ...call, label: String(new RegExp('/basic/tuskService/' + id + '/syncInfo/?(?:[?#]|$)')) });
const read = { ...call, label: String(/\/basic\/tuskService\/?(?:[?#]|$)/) };
const failed = { failedBusinessStep: 1, failedCallKind: 'operation', failedCallType: op.type,
  failedCallIndex: 1, steps: [sync(2), read, sync(5), read, sync(5)] };
const message = '服务「rattletrap」第 2 次同步操作失败：error';

test('retry detection requires the duplicate submit and a business requirement to sync', () => {
  assert.deepEqual(repeatedBindingSync(failed, message), { step: 1, index: 1, services: ['2', '5'] });
  assert.equal(repeatedBindingSync({ ...failed, steps: failed.steps.slice(0, -1) }, message), undefined);
  assert.equal(repeatedBindingSync(failed, '服务离线'), undefined);
  assert.equal(shouldResyncBinding(original, business, 1, 1), true);
  assert.equal(shouldResyncBinding(original, [{ ...business[0], action: '追加地图' }], 1, 1), false);
  assert.equal(shouldResyncBinding(original, [{ ...business[0], action: '已有绑定时无需同步' }], 1, 1), false);
  assert.equal(shouldResyncBinding([...original, { operations: [{ ...op, type: 'sync-bound-map-services' }], checks: [check] }], business, 1, 1), false);
});

test('deterministic sync repair preserves every argument and check, and emits the optional runtime flag', async () => {
  const planner = new PlannerService({}, {});
  const { workflow } = await planner.repairWorkflow({ steps: business, skill: business[0].skill },
    original, targetBaseUrl, { failedStep: 1, failedCall: { index: 1, type: op.type, kind: 'operation' }, resyncExistingBinding: true });
  const expected = [{ ...original[0], operations: [original[0].operations[0], { ...op, syncExisting: true }] }];
  assert.deepEqual(workflow, expected);
  assert.ok(compileWorkflow('同步', business, workflow).includes('bindPaladinMap(browser, screen, "站点图", "paladin-test", undefined, true)'));
  assert.ok(compileWorkflow('绑定', business, original).includes('bindPaladinMap(browser, screen, "站点图", "paladin-test")'));
  assert.throws(() => validateWorkflow([{ ...original[0], operations: [original[0].operations[0], { ...op, syncExisting: 'true' }] }], 1));
});

test('only a zero-model pass that actually submitted to both original services and read their result writes back', async () => {
  const failure = repeatedBindingSync(failed, message);
  const pass = { fullyPassed: true, zeroAi: true, summary: { steps: [sync(2), read, sync(5), read] } };
  assert.equal(verifiedBindingSync(pass, failure), true);
  for (const steps of [[read], [sync(2), read], [sync(2), sync(7), read], [sync(2), read, sync(5)], [...pass.summary.steps, sync(5), read]]) {
    assert.equal(verifiedBindingSync({ ...pass, summary: { steps } }, failure), false);
  }
  assert.equal(verifiedBindingSync({ ...pass, zeroAi: false }, failure), false);
  const recorded = [];
  const source = { id: 5, version: 3, testCaseId: 4, targetBaseUrl, repairRunId: 6, summary: JSON.stringify(failed), error: message };
  const base = { steps: JSON.stringify(business), skill: 'default', prerequisite: null };
  const runs = new RunsService({
    testRun: { findUnique: async () => source }, testCase: { findUnique: async () => ({ currentVersion: 4 }) },
  }, {}, {}, {}, { version: async () => ({ ...base, workflow: JSON.stringify(original) }) },
  { recordVerifiedRepair: async (...args) => { recorded.push(args); return 'skill.json'; } });
  const workflow = [{ ...original[0], operations: [original[0].operations[0], { ...op, syncExisting: true }] }];
  const run = { ...source, id: 6, version: 4, repairOf: 5 };
  const learn = report => runs.learnVerifiedRepair(run, { ...base, version: 4, testCaseId: 4 },
    targetBaseUrl, { workflow, steps: business, report });
  assert.equal(await learn({ ...pass, fullyPassed: false }), undefined);
  assert.equal((await learn(pass)).skillLearning.status, 'recorded');
  assert.equal(recorded.length, 1);
  assert.deepEqual(recorded[0].slice(0, 3), [business[0].skill, targetBaseUrl, run.id]);
  assert.equal(recorded[0][3][0].syncExisting, true);
  assert.ok(!JSON.stringify(recorded).includes(op.mapName));
});
