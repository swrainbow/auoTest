const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { setTimeout: wait } = require('node:timers/promises');
const { PrismaClient } = require('@prisma/client');
const { PreparationsService } = require('../src/preparations/preparations.service');

test('preparation rules are versioned, trial runs respect dependencies and interrupted work is recoverable', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'preparation-db-'));
  const db = path.join(directory, 'test.db');
  const schema = await readFile(path.join(__dirname, '../prisma/schema.prisma'), 'utf8');
  const schemaFile = path.join(directory, 'schema.prisma');
  await writeFile(schemaFile, schema.replace('file:../../../storage/app.db', 'file:./test.db'));
  await writeFile(db, '');
  execFileSync(process.execPath, [require.resolve('prisma'), 'db', 'push', '--schema', schemaFile, '--skip-generate'], { stdio: 'pipe' });
  const prisma = new PrismaClient({ datasourceUrl: 'file:' + db.replaceAll('\\', '/') });
  let failedAt;
  let executing = 0;
  let peak = 0;
  const runner = {
    onModuleDestroy() {},
    async execute() {
      peak = Math.max(peak, ++executing);
      await wait(12);
      executing--;
      if (failedAt) throw new Error('进程退出');
    },
    async result(run) {
      const steps = run.steps.map((step) => ({ ...step, status: 'passed', evidence: '已回读' }));
      if (failedAt) Object.assign(steps.find((step) => step.skillId === failedAt), { status: 'failed', evidence: '地图不存在' });
      return { steps, evidence: { serviceName: 'paladin-1', wroteBinding: false, mapsBefore: ['测试图'], mapsAfter: ['测试图'],
        services: [{ name: 'paladin-1', status: '同步成功' }] } };
    },
  };
  const targetBaseUrl = 'http://127.0.0.1:8499';
  const settings = { get: async () => ({ targetBaseUrl }) };
  const service = new PreparationsService(prisma, settings, runner);
  t.after(async () => {
    await service.onModuleDestroy();
    await prisma.$disconnect();
    await rm(directory, { recursive: true, force: true });
  });
  const waitDone = async (id) => {
    for (let i = 0; i < 150; i++) {
      const run = await service.get(id);
      if (run.finishedAt) return run;
      await wait(20);
    }
    throw new Error('queue failed to drain');
  };
  const initial = await service.workspace();
  assert.equal(initial.rules.length, 1);
  const rule = await service.saveRule({ selection: 'explicit' });
  assert.equal(rule.version, 2);
  assert.equal(rule.status, 'draft');
  const valid = initial.flows[0].steps;
  const create = (steps) => service.saveFlow({ name: '试跑', steps, ruleVersion: rule.version });
  await assert.rejects(create(['service-sync', 'readiness-check']), /先添加“绑定地图”/);
  await assert.rejects(create(['service-sync', 'service-sync']), /重复/);
  await assert.rejects(create(['unknown']), /未知/);
  const short = await create(valid.slice(0, 1));
  const full = await create(valid);
  await assert.rejects(service.enqueue({ flowId: full.id, mapName: '测试图' }), /服务全名/);
  await assert.rejects(service.enqueue({ flowId: short.id, targetBaseUrl: 'http://wrong.local' }), /目标站点已变化/);
  const shortRun = await service.enqueue({ flowId: short.id });
  assert.equal((await waitDone(shortRun.id)).status, 'passed');
  assert.equal((await service.workspace()).rules[0].status, 'draft');
  const input = { flowId: full.id, mapName: '测试图', serviceName: 'paladin-1' };
  failedAt = 'map-binding';
  const failure = await waitDone((await service.enqueue(input)).id);
  assert.equal(failure.error, '地图不存在');
  assert.deepEqual(failure.steps.map((step) => step.status), ['passed', 'failed', 'skipped']);
  assert.equal((await service.workspace()).rules[0].status, 'draft');
  failedAt = undefined;
  const batch = await Promise.all([service.enqueue(input), service.enqueue(input)]);
  for (const run of batch) assert.equal((await waitDone(run.id)).evidence.serviceName, 'paladin-1');
  assert.equal(peak, 1);
  assert.deepEqual((await service.workspace()).rules.map((r) => [r.version, r.status]), [[2, 'verified'], [1, 'draft']]);
  await service.onModuleDestroy();
  const interrupted = await prisma.preparationRun.update({ where: { id: shortRun.id }, data: { status: 'running', finishedAt: null } });
  const restored = new PreparationsService(prisma, settings, {
    ...runner, result: async (run) => ({ steps: run.steps.map((step) => ({ ...step, status: 'running', evidence: '执行中' })) }),
  });
  try {
    await restored.onApplicationBootstrap();
    const recovered = await restored.get(interrupted.id);
    assert.equal(recovered.status, 'failed');
    assert.match(recovered.steps[0].evidence, /平台重启/);
  } finally {
    await restored.onModuleDestroy();
  }
});
