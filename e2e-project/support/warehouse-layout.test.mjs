import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMap } from '../../skills/tusk-map-simulation/scripts/build-map.mjs';
import { checkLayout } from '../../skills/tusk-map-simulation/scripts/check-layout.mjs';
import { expandWarehouseLayout } from '../../skills/tusk-map-simulation/scripts/warehouse-layout.mjs';

const tc013 = {
  shape: 'L', aislePoints: 10, turnAt: 5, storageCount: 20, workCount: 10, chargeCount: 1,
};
const straight = { shape: 'straight', aislePoints: 4, storageCount: 8, workCount: 4 };

function assertGridLinks(plan, spacing) {
  const byId = new Map(plan.points.map(point => [point.id, point]));
  for (const link of plan.links) {
    const start = byId.get(link.from);
    const end = byId.get(link.to);
    assert.ok(start.x === end.x || start.y === end.y);
    assert.equal(Math.abs(start.x - end.x) + Math.abs(start.y - end.y), spacing);
    assert.equal(link.bidirectional, true);
  }
}

test('TC-013 keeps the L aisle, a complete storage block, ten direct work bays and an entrance charger', () => {
  const routes = [{ from: 'C1', to: 'S20' }, { from: 'W10', to: 'S01' }];
  const input = { mapName: 'Task001', ver: '5.9', routes, warehouse: tc013 };
  const plan = expandWarehouseLayout(input);
  assert.equal(Object.hasOwn(plan, 'floor'), false);
  assert.equal(Object.hasOwn(plan, 'warehouse'), false);
  assert.deepEqual(plan, expandWarehouseLayout(input));
  assert.deepEqual(plan.routes, routes);
  const byId = new Map(plan.points.map(point => [point.id, point]));
  assert.deepEqual(byId.get('A5'), { id: 'A5', type: 'normal', x: 8, y: 0 });
  assert.deepEqual(byId.get('A10'), { id: 'A10', type: 'normal', x: 8, y: 10 });
  assert.deepEqual(byId.get('C1'), { id: 'C1', type: 'charge', x: -2, y: 0 });
  assert.ok(plan.links.some(({ from, to }) => from === 'A1' && to === 'C1'));
  const storage = plan.points.filter(point => point.type === 'storage');
  assert.equal(new Set(storage.map(p => p.x)).size, 5);
  assert.equal(new Set(storage.map(p => p.y)).size, 4);
  assert.ok(storage.every(p => p.y < 0 && p.x >= 0 && p.x <= 8));
  const workLinks = plan.links.filter(link => byId.get(link.to).type === 'work');
  assert.equal(new Set(workLinks.map(link => link.from)).size, 10);
  assert.ok(workLinks.every(link => byId.get(link.from).type === 'normal'));
  assertGridLinks(plan, 2);
  const { map, summary } = buildMap({ ...input, floor: 3 }, '8');
  assert.equal(map.floor, 3);
  assert.equal(map.ver, '5.9');
  assert.equal(map.mapName, 'Task001');
  assert.equal(summary.pointCount, 41);
  assert.equal(summary.routeCount, routes.length);
  assert.equal(summary.physicalConnectionCount, 40);
  assert.equal(map.mapLineList.length, 80);
  assert.ok(map.mapLineList.every(line => line.isDelete === false));
  assert.ok(map.mapDataList.find(point => point.dataType === 10).chargerId);
});

test('straight aisle aligns two storage columns and one work column on opposite sides', () => {
  const input = { mapName: 'Straight', floor: 1, warehouse: { ...straight, spacing: 1.5 } };
  const plan = expandWarehouseLayout(input);
  const storage = plan.points.filter(p => p.type === 'storage');
  const work = plan.points.filter(p => p.type === 'work');
  assert.deepEqual([...new Set(storage.map(p => p.x))], [-1.5, -3]);
  assert.deepEqual(work.map(p => p.x), [1.5, 1.5, 1.5, 1.5]);
  assert.equal(checkLayout(plan).pointCount, 16);
  assertGridLinks(plan, 1.5);
});

test('empty and partial rows and off-center L turns remain connected', () => {
  for (const aisle of [
    { shape: 'straight', aislePoints: 1 },
    { shape: 'straight', aislePoints: 3 },
    { shape: 'L', aislePoints: 3 },
    { shape: 'L', aislePoints: 8, turnAt: 2 },
    { shape: 'L', aislePoints: 8, turnAt: 7 },
  ]) {
    for (const [storageCount, workCount, chargeCount] of [[0, 0, 0], [1, 2, 0], [7, 0, 1], [5, 13, 2]]) {
      const plan = expandWarehouseLayout({ mapName: 'small', floor: 1, warehouse: { ...aisle, storageCount, workCount, chargeCount } });
      const counts = checkLayout(plan);
      assert.deepEqual(counts.typeCounts, { normal: aisle.aislePoints, storage: storageCount, work: workCount, charge: chargeCount, buffer: 0, waypoint: 0 });
      assert.equal(counts.physicalConnectionCount, counts.pointCount - 1);
      assertGridLinks(plan, 2);
    }
  }
});

test('explicit geometry is passed through and compact parameters are validated', () => {
  const explicit = { points: [], links: [], geometry: 'free' };
  assert.equal(expandWarehouseLayout(explicit), explicit);
  for (const conflict of [{ points: [] }, { links: [] }, { geometry: 'free' }]) {
    assert.throws(() => expandWarehouseLayout({ warehouse: tc013, ...conflict }), /显式布局/);
  }
  for (const [changes, message] of [
    [{ turnAt: 10 }, /turnAt/], [{ aislePoints: 2 }, /aislePoints/],
    [{ storageCount: -1 }, /storageCount/], [{ chargeCount: null }, /chargeCount/],
    [{ workCount: 0.8 }, /workCount/], [{ spacing: 0 }, /spacing/],
    [{ shape: 'U' }, /shape/], [{ aisles: 3 }, /aisles/], [{ storageCount: 34000 }, /号段/],
  ]) {
    assert.throws(() => expandWarehouseLayout({ warehouse: { ...tc013, ...changes } }), message);
  }
  assert.throws(() => expandWarehouseLayout({ warehouse: { ...straight, turnAt: 2 } }), /turnAt/);
  assert.throws(() => buildMap({ mapName: 'invalid route', floor: 1, warehouse: straight, routes: [{ from: 'A1', to: 'W10' }] }, '8'), /W10/);
});
