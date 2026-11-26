import assert from 'node:assert/strict';
import { test } from 'node:test';
import { preparationOrder, runPreparation } from './service-map-preparation.ts';
import { getPaladin } from './tusk-service-preflight.ts';

const input = { steps: [...preparationOrder], selection: 'unique', mapName: '新地图', serviceName: '' };
function fixture(rows = [
  {name: 'paladin-1', status: '待同步', maps: ['旧地图']},
  {name: 'rattletrap', status: '同步成功', maps: []},
]) {
  const saved = [], calls = [];
  return { rows, saved, calls, save: async report => { saved.push(structuredClone(report)); }, actions: {
    async open() { calls.push('open'); }, async read() { return structuredClone(rows); },
    async sync(attempts) {
      calls.push('sync');
      for (const row of rows) {
        if (row.status === '同步成功') continue;
        attempts.set(row.name, (attempts.get(row.name) ?? 0) + 1);
        row.status = '同步成功';
      }
    }, select: getPaladin,
    async bind(name, map, attempts) {
      calls.push('bind');
      rows.find(entry => entry.name === name).maps.push(map);
      for (const service of [name, 'rattletrap']) {
        attempts.set(service, (attempts.get(service) ?? 0) + 1);
      }
      return true;
    },
  }};
}

test('绑定后重新同步并回读，重跑复用已有绑定', async () => {
  const f = fixture();
  const first = await runPreparation(input, f.actions, f.save);
  assert.deepEqual(f.saved[0].steps.map(step => step.status), ['running', 'pending', 'pending']);
  assert.deepEqual(first.steps.map(step => step.status), ['passed', 'passed', 'passed']);
  assert.deepEqual(first.evidence, { services: [{name:'paladin-1',status:'同步成功', attempts:2},
    {name:'rattletrap',status:'同步成功', attempts:1}], serviceName:'paladin-1', mapsBefore:['旧地图'], mapsAfter:['旧地图','新地图'], wroteBinding:true });
  const second = await runPreparation(input, f.actions, f.save);
  assert.equal(second.evidence.wroteBinding, false);
  assert.deepEqual(f.calls, ['open','sync','bind','open','sync','open','sync','open','sync']);
});

test('含两步的准备流程在绑定阶段记录两项同步，复用时无需重复同步', async () => {
  const f = fixture();
  const twoSteps = { ...input, steps: ['service-sync', 'map-binding'] };
  const first = await runPreparation(twoSteps, f.actions, f.save);
  assert.deepEqual(first.steps.map(s => s.status), ['passed', 'passed']);
  assert.deepEqual(first.evidence.services.map(s => s.attempts), [2, 1]);
  assert.deepEqual(first.evidence.mapsAfter, ['旧地图', '新地图']);
  const second = await runPreparation(twoSteps, f.actions, f.save);
  assert.equal(second.evidence.wroteBinding, false);
  assert.ok(second.evidence.services.every(s => s.attempts === 0));
});

test('地图已保存但 Rattletrap 同步失败时记录已绑定地图、两行尝试次数和最后状态', async () => {
  const f = fixture();
  f.actions.bind = async (name, map, attempts) => {
    f.rows[0].maps.push(map);
    attempts.set(name, attempts.get(name) + 1);
    attempts.set('rattletrap', 1);
    f.rows[1].status = '同步失败';
    throw new Error('rattletrap 同步失败');
  };
  await assert.rejects(runPreparation(input, f.actions, f.save), /rattletrap 同步失败/);
  const report = f.saved.at(-1);
  assert.deepEqual(report.steps.map(step => step.status), ['passed', 'failed', 'skipped']);
  assert.deepEqual(report.evidence.mapsAfter, ['旧地图', '新地图']);
  assert.deepEqual(report.evidence.services, [
    { name: 'paladin-1', status: '同步成功', attempts: 2 },
    { name: 'rattletrap', status: '同步失败', attempts: 1 },
  ]);
});

test('重新进入服务管理页后原有地图丢失，复核失败并报告持久化结果', async () => {
  const f = fixture();
  const originalOpen = f.actions.open;
  f.actions.open = async () => {
    await originalOpen();
    if (f.calls.includes('bind')) f.rows[0].maps = ['新地图'];
  };
  await assert.rejects(runPreparation(input, f.actions, f.save), /原有地图/);
  const report = f.saved.at(-1);
  assert.deepEqual(report.steps.map(step => step.status), ['passed', 'passed', 'failed']);
  assert.deepEqual(report.evidence.mapsBefore, ['旧地图']);
  assert.deepEqual(report.evidence.mapsAfter, ['新地图']);
});

test('同步失败后保留各服务的真实尝试次数与可读的最新状态', async () => {
  const f = fixture([{name:'paladin-1',status:'待同步',maps:[]}, {name:'other',status:'同步成功',maps:[]}]);
  f.actions.sync = async (attempts) => {
    attempts.set('paladin-1', 3);
    f.rows[0].status = '同步异常';
    throw new Error('重试耗尽');
  };
  await assert.rejects(runPreparation(input, f.actions, f.save), /重试耗尽/);
  const report = f.saved.at(-1);
  assert.deepEqual(report.steps.map(step => step.status), ['failed','skipped','skipped']);
  assert.deepEqual(report.evidence.services, [
    {name:'paladin-1',status:'同步异常',attempts:3},
    {name:'other',status:'同步成功',attempts:0},
  ]);
});

test('服务歧义保留已完成步骤，显式名称则只操作该服务', async () => {
  const f = fixture(['paladin-a','paladin-b'].map(name => ({name, status:'同步成功', maps:[]})));
  await assert.rejects(runPreparation(input, f.actions, f.save), /无法确定/);
  assert.deepEqual(f.saved.at(-1).steps.map(step => step.status), ['passed','failed','skipped']);
  assert.deepEqual(f.calls, ['open','sync']);
  const result = await runPreparation({...input, selection:'explicit', serviceName:'paladin-b'}, f.actions, f.save);
  assert.equal(result.evidence.serviceName, 'paladin-b');
  assert.deepEqual(f.rows[0].maps, []);
  assert.equal((await runPreparation(input, f.actions, f.save)).evidence.serviceName, 'paladin-b');
});

test('单步同步不触及地图，非法顺序或缺少显式服务名在操作前失败', async () => {
  const f = fixture();
  await runPreparation({...input,steps:['service-sync'],mapName:''}, f.actions, f.save);
  await assert.rejects(runPreparation({...input,steps:['map-binding']}, f.actions, f.save), /顺序/);
  await assert.rejects(runPreparation({...input,selection:'explicit'}, f.actions, f.save), /服务名称/);
  assert.deepEqual(f.calls, ['open','sync']);
});

test('目标地图缺失时记录原因并跳过复核，保存后原有地图缺失也会失败', async () => {
  const f = fixture();
  f.actions.bind = async () => { throw new Error('地图选择列表缺少新地图'); };
  await assert.rejects(runPreparation(input, f.actions, f.save), /缺少新地图/);
  assert.deepEqual(f.saved.at(-1).steps.map(step => step.status), ['passed','failed','skipped']);
  f.actions.bind = async () => { f.rows[0].maps = ['新地图']; return true; };
  await assert.rejects(runPreparation(input, f.actions, f.save), /原有地图/);
  assert.deepEqual(f.saved.at(-1).evidence.mapsAfter, ['新地图']);
});
