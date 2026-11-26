const assert = require('node:assert/strict');
const { test } = require('node:test');
const { setImmediate: nextTurn } = require('node:timers/promises');
const { ScriptGenerationsService } = require('../src/cases/script-generations.service');

const source = { id: 10, currentVersion: 4, code: 'TC-010', name: '回读任务配置' };
const asset = { version: 5, scriptPath: 'tests/generated/TC-010/v5.e2e.ts' };
const date = new Date('2026-11-17T00:00:00.000Z');

function store(seed = []) {
  const rows = seed.map((row) => ({ ...row }));
  const matches = (row, where) => Object.entries(where).every(([key, value]) => row[key] === value);
  return { scriptGeneration: {
    upsert: async ({ where, create }) => {
      const existing = rows.find((row) => matches(row, where));
      if (existing) return { ...existing };
      const row = {
        id: rows.length + 1, status: 'queued', resultVersion: null, scriptPath: null, error: null,
        createdAt: date, updatedAt: date, ...create,
      };
      rows.push(row);
      return { ...row };
    },
    findUnique: async ({ where }) => rows.find((row) => matches(row, where)),
    findFirst: async ({ where }) => rows.findLast((row) => matches(row, where)),
    findMany: async ({ where }) => rows.filter((row) => matches(row, where)),
    updateMany: async ({ where, data }) => {
      const matching = rows.filter((row) => matches(row, where));
      for (const row of matching) Object.assign(row, data);
      return { count: matching.length };
    },
    update: async ({ where, data }) => {
      const row = rows.find((row) => matches(row, where));
      assert.ok(row, 'save callback must update only the claimed job');
      return Object.assign(row, data);
    },
  } };
}

test('generation accepts and deduplicates submissions before the provider returns', async (t) => {
  const prisma = store();
  const provider = Promise.withResolvers();
  const calls = [];
  const service = new ScriptGenerationsService(prisma, {
    generationSource: async () => source,
    generateScript: async (id, version, onSaved) => {
      calls.push({ id, version });
      await provider.promise;
      await onSaved(prisma, asset);
    },
  });
  t.after(() => { service.onModuleDestroy(); provider.resolve(); });

  const [a, b] = await Promise.all([service.enqueue(source.id, 4), service.enqueue(source.id, 4)]);
  assert.equal(a.status, 'queued');
  assert.equal(a.id, b.id);
  assert.equal(calls.length, 0);

  await nextTurn();
  assert.equal((await service.latest(source.id)).status, 'running');
  assert.equal((await service.enqueue(source.id, 4)).id, a.id);
  assert.deepEqual(calls, [{ id: source.id, version: 4 }]);

  provider.resolve();
  await nextTurn();
  const saved = await service.latest(source.id);
  assert.equal(saved.id, a.id);
  assert.equal(saved.status, 'succeeded');
  assert.equal(saved.sourceVersion, 4);
  assert.equal(saved.resultVersion, 5);
  assert.equal(saved.scriptPath, asset.scriptPath);
  assert.equal((await prisma.scriptGeneration.findUnique({ where: { id: a.id } })).activeKey, null);
});

test('startup resumes queued work and marks interrupted provider calls as failed', async (t) => {
  const common = {
    testCaseId: source.id, caseCode: source.code, caseName: source.name, error: null,
    resultVersion: null, scriptPath: null, createdAt: date, updatedAt: date,
  };
  const prisma = store([
    { ...common, id: 1, sourceVersion: 3, activeKey: '10:3', status: 'running' },
    { ...common, id: 2, sourceVersion: 4, activeKey: '10:4', status: 'queued' },
  ]);
  const versions = [];
  const service = new ScriptGenerationsService(prisma, {
    generateScript: async (_id, version, onSaved) => {
      versions.push(version);
      await onSaved(prisma, asset);
    },
  });
  t.after(() => service.onModuleDestroy());

  await service.onApplicationBootstrap();
  const interrupted = await prisma.scriptGeneration.findUnique({ where: { id: 1 } });
  assert.equal(interrupted.status, 'failed');
  assert.equal(interrupted.activeKey, null);
  assert.match(interrupted.error, /平台重启/);
  await nextTurn();
  assert.deepEqual(versions, [4]);
  assert.equal((await service.latest(source.id)).status, 'succeeded');
});
