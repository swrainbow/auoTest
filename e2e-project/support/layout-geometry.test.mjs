import assert from 'node:assert/strict';
import test from 'node:test';
import { checkLayout } from '../../skills/tusk-map-simulation/scripts/check-layout.mjs';

function layout(points, edges) {
  return {
    mapName: '几何检验',
    floor: 1,
    points: Object.entries(points).map(([id, [x, y]]) => ({ id, x, y, type: 'normal' })),
    links: edges.map(([from, to]) => ({ from, to, bidirectional: true })),
  };
}

test('warehouse geometry rejects a diagonal spur unless explicitly requested', () => {
  const plan = layout({ A: [0, 0], B: [1, 0], W: [1.5, 1] }, [['A', 'B'], ['B', 'W']]);
  assert.throws(() => checkLayout(plan), /B → W 为斜线/);
  assert.equal(checkLayout({ ...plan, geometry: 'free' }).physicalConnectionCount, 2);
  assert.throws(() => checkLayout({ ...plan, geometry: 'skip' }), /geometry/);
});

test('a physical connection cannot skip an intermediate point or overlap its neighbor', () => {
  const plan = layout({ A: [0, 0], S1: [1, 0], S2: [2, 0] }, [['A', 'S1'], ['A', 'S2']]);
  assert.throws(() => checkLayout(plan), /A → S2 跨过点位 S1/);
  plan.links[1].from = 'S1';
  assert.equal(checkLayout(plan).directedEdgeCount, 4);
  plan.links = [{ from: 'A', to: 'S1', bidirectional: false }, { from: 'S1', to: 'A', bidirectional: false }, plan.links[1]];
  assert.equal(checkLayout(plan).physicalConnectionCount, 2);
});

test('a crossing has to share a point and split both segments', () => {
  const points = { W: [0, 1], E: [2, 1], N: [1, 0], S: [1, 2], NW: [0, 0] };
  const crossing = layout(points, [['W', 'E'], ['N', 'S'], ['W', 'NW'], ['NW', 'N']]);
  assert.throws(() => checkLayout(crossing), /N → S 与 W → E 在端点以外交叉/);
  const junction = layout({ ...points, J: [1, 1] }, [
    ['W', 'J'], ['J', 'E'], ['N', 'J'], ['J', 'S'], ['W', 'NW'], ['NW', 'N'],
  ]);
  assert.equal(checkLayout(junction).pointCount, 6);
});

test('free geometry allows a diagonal and still rejects a crossing or a skipped point', () => {
  const grid = layout({ A: [0, 0], B: [2, 2], C: [0, 2], D: [2, 0] }, [['A', 'B'], ['B', 'C'], ['C', 'D']]);
  assert.throws(() => checkLayout({ ...grid, geometry: 'free' }), /C → D 与 A → B/);
  const overlap = layout({ A: [0, 0], W: [1, 1], B: [2, 2] }, [['A', 'B'], ['W', 'B']]);
  assert.throws(() => checkLayout({ ...overlap, geometry: 'free' }), /跨过点位 W/);
});

test('checks alignments in the same coordinate precision as map storage', () => {
  const plan = layout({ A: [0, 1], B: [2, 1 + 1e-9] }, [['A', 'B']]);
  assert.equal(checkLayout(plan).physicalConnectionCount, 1);
});
