export interface GeneratedMapLayout {
  mapName: string;
  floor?: number;
  ver?: '5.9' | '5.10';
  geometry?: 'orthogonal' | 'free';
  points: Array<{ id: string; type: 'normal' | 'charge' | 'work' | 'buffer' | 'storage' | 'waypoint'; x: number; y: number }>;
  links: Array<{ from: string; to: string; bidirectional: boolean }>;
  routes?: Array<{ from: string; to: string }>;
}

export function readGeneratedMapLayout(input: unknown, existingOnly = false): GeneratedMapLayout {
  const { checkLayout } = require('../../../../skills/tusk-map-simulation/scripts/check-layout.mjs');
  const { expandWarehouseLayout } = require('../../../../skills/tusk-map-simulation/scripts/warehouse-layout.mjs');
  const expanded = expandWarehouseLayout(input);
  // An existing map supplies its floor at execution. Validate the remaining layout now.
  checkLayout(existingOnly && expanded && typeof expanded === 'object' ? { floor: 1, ...expanded } : expanded);
  const { mapName, floor, geometry, points, links, routes, ver = '5.10' } = expanded as GeneratedMapLayout;
  if (ver !== '5.9' && ver !== '5.10') throw new Error('地图格式版本须为 5.9 或 5.10');
  return {
    mapName, ...(floor === undefined ? {} : { floor }), ver, ...(geometry ? { geometry } : {}),
    points: points.map(({ id, type, x, y }) => ({ id, type, x, y })),
    links: links.map(({ from, to, bidirectional }) => ({ from, to, bidirectional })),
    ...(routes ? { routes: routes.map(({ from, to }) => ({ from, to })) } : {}),
  };
}
