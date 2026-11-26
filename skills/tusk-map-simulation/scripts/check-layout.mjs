import { readFile } from 'node:fs/promises';
import { checkGeometry } from './check-geometry.mjs';
import { expandWarehouseLayout } from './warehouse-layout.mjs';

const pointTypes = ['normal', 'work', 'storage', 'buffer', 'charge', 'waypoint'];

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonBlank(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function reachable(start, neighbors) {
  const visited = new Set([start]);
  const queue = [start];
  for (let i = 0; i < queue.length; i++) {
    for (const next of neighbors.get(queue[i])) {
      if (visited.has(next)) continue;
      visited.add(next);
      queue.push(next);
    }
  }
  return visited;
}

export function checkLayout(layout) {
  requireValue(isObject(layout), '地图根节点必须为对象');
  const { mapName, floor, points, links, routes = [], geometry = 'orthogonal' } = layout;
  requireValue(['orthogonal', 'free'].includes(geometry), 'geometry 应为 orthogonal 或 free');
  requireValue(layout.ver === undefined || ['5.9', '5.10'].includes(layout.ver), 'ver 应为目标地图格式 5.9 或 5.10');
  requireValue(nonBlank(mapName), 'mapName 必须为非空字符串');
  requireValue(Number.isInteger(floor), 'floor 必须为整数');
  requireValue(Array.isArray(points) && points.length > 0, 'points 必须为非空数组');
  requireValue(Array.isArray(links), 'links 必须为数组');
  requireValue(Array.isArray(routes), 'routes 必须为数组');

  const typeCounts = Object.fromEntries(pointTypes.map(type => [type, 0]));
  const coordinates = new Set();
  const positions = new Map();
  const undirected = new Map();
  const outgoing = new Map();
  for (const [index, point] of points.entries()) {
    const path = `points[${index}]`;
    requireValue(isObject(point), `${path} 必须为对象`);
    const { id, type, x, y } = point;
    requireValue(nonBlank(id), `${path}.id 必须为非空字符串`);
    requireValue(!outgoing.has(id), `${path}.id 与已有点位编号重复：${id}`);
    requireValue(pointTypes.includes(type), `${path}.type 应为 ${pointTypes.join(' / ')}`);
    requireValue(Number.isFinite(x) && Number.isFinite(y), `${path} 的 x 和 y 必须为有限数值（米）`);
    // Lothar reads both coordinates as Java Float before checking for duplicates.
    const storedX = Math.fround(x);
    const storedY = Math.fround(y);
    requireValue(Number.isFinite(storedX) && Number.isFinite(storedY), `${path} 超出地图坐标范围`);
    const location = JSON.stringify([storedX, storedY]);
    requireValue(!coordinates.has(location), `${path} 在后端精度下与已有点位坐标重合：${location}`);
    coordinates.add(location);
    positions.set(id, { x: storedX, y: storedY });
    undirected.set(id, new Set());
    outgoing.set(id, new Set());
    typeCounts[type]++;
  }

  function checkEndpoints(entry, path) {
    requireValue(isObject(entry), `${path} 必须为对象`);
    for (const key of ['from', 'to']) {
      requireValue(outgoing.has(entry[key]), `${path}.${key} 引用了不存在的点位：${entry[key]}`);
    }
  }

  function addDirection(from, to, path) {
    requireValue(!outgoing.get(from).has(to), `${path} 产生重复的有向边：${from} → ${to}`);
    outgoing.get(from).add(to);
  }

  let directedEdgeCount = 0;
  const physicalConnections = new Map();
  for (const [index, link] of links.entries()) {
    const path = `links[${index}]`;
    checkEndpoints(link, path);
    const { from, to, bidirectional } = link;
    requireValue(from !== to, `${path} 不允许自环：${from}`);
    requireValue(typeof bidirectional === 'boolean', `${path}.bidirectional 必须为布尔值`);
    addDirection(from, to, path);
    if (bidirectional) addDirection(to, from, path);
    directedEdgeCount += bidirectional ? 2 : 1;
    undirected.get(from).add(to);
    undirected.get(to).add(from);
    physicalConnections.set(JSON.stringify([from, to].sort()), link);
  }

  checkGeometry(positions, physicalConnections.values(), geometry);
  requireValue(reachable(points[0].id, undirected).size === points.length, '点位未全部连通，请检查孤立点或断开的子图');
  for (const [index, route] of routes.entries()) {
    const path = `routes[${index}]`;
    checkEndpoints(route, path);
    requireValue(reachable(route.from, outgoing).has(route.to), `${path} 按通行方向不可达：${route.from} → ${route.to}`);
  }

  return {
    mapName,
    floor,
    pointCount: points.length,
    typeCounts,
    physicalConnectionCount: physicalConnections.size,
    directedEdgeCount,
    routeCount: routes.length,
  };
}

async function main() {
  const [file, ...extra] = process.argv.slice(2);
  requireValue(file && !extra.length, '用法：node check-layout.mjs <layout.json>');
  const input = await readFile(file, 'utf8');
  const plan = JSON.parse(input.replace(/^\uFEFF/, ''));
  const report = checkLayout(expandWarehouseLayout(plan));
  console.log(JSON.stringify(report, null, 2));
}

if (import.meta.main) main().catch(error => {
  console.error(`地图校验失败：${error.message}`);
  process.exitCode = 1;
});
