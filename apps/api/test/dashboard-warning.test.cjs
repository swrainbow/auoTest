const assert = require('node:assert/strict');
const { test } = require('node:test');
const { DashboardService } = require('../src/dashboard/dashboard.service');

test('warning runs appear in recent results without counting as passes or failures', async () => {
  const cases = ['mixed', 'only-warning'].map((module, index) => ({ id: index + 1, name: module, module }));
  const runs = ['passed', 'warning', 'warning'].map((status, index) => ({
    id: index + 1,
    testCaseId: index === 2 ? 2 : 1,
    testCase: cases[index === 2 ? 1 : 0],
    createdAt: new Date(),
    status,
    summary: null,
    durationMs: 100,
  }));
  const dashboard = new DashboardService({
    testCase: { findMany: async () => cases, count: async () => 0 },
    testRun: { findMany: async ({ select }) => select ? [] : runs },
  });
  const { trend, kpis, moduleSummary, flakyTests } = await dashboard.summary();
  assert.deepEqual(trend.map(({ status, passed, failed, warnings, total }) => [status, passed, failed, warnings, total]), [
    ['passed', 1, 0, 0, 1], ['warning', 0, 0, 1, 1], ['warning', 0, 0, 1, 1],
  ]);
  assert.equal(kpis.assessedRuns, 1);
  assert.equal(kpis.passRate, 100);
  assert.deepEqual(moduleSummary.map(({ status, runs, passRate }) => [status, runs, passRate]), [
    ['passed', 2, 100], ['warning', 1, 0],
  ]);
  assert.deepEqual(flakyTests, []);
});
