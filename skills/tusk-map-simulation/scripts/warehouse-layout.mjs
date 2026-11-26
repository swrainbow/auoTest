function count(value, name, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`warehouse.${name} 必须为大于等于 ${minimum} 的整数`);
  }
  return value;
}

// Expand only the compact warehouse recipe. Explicit layouts use the same downstream checks.
export function expandWarehouseLayout(spec) {
  if (!spec || typeof spec !== 'object' || !('warehouse' in spec)) return spec;
  const { warehouse, ...metadata } = spec;
  if ('points' in metadata || 'links' in metadata || (metadata.geometry !== undefined && metadata.geometry !== 'orthogonal')) {
    throw new Error('warehouse 使用正交布局；自定义 points、links 或自由几何请使用显式布局');
  }
  if (!warehouse || typeof warehouse !== 'object' || Array.isArray(warehouse)) {
    throw new Error('warehouse 必须为布局参数对象');
  }
  const allowed = ['shape', 'aislePoints', 'turnAt', 'storageCount', 'workCount', 'chargeCount', 'spacing'];
  for (const field of Object.keys(warehouse)) {
    if (!allowed.includes(field)) throw new Error(`不支持 warehouse.${field}，其他布局要求可使用显式点线`);
  }
  const { shape, spacing = 2, chargeCount: requestedCharges = 0 } = warehouse;
  if (shape !== 'straight' && shape !== 'L') throw new Error('warehouse.shape 应为 straight 或 L');
  if (!Number.isFinite(spacing) || spacing <= 0) throw new Error('warehouse.spacing 必须是正数（米）');
  const aisleCount = count(warehouse.aislePoints, 'aislePoints', shape === 'L' ? 3 : 1);
  const storageCount = count(warehouse.storageCount, 'storageCount');
  const workCount = count(warehouse.workCount, 'workCount');
  const chargeCount = count(requestedCharges, 'chargeCount');
  const total = aisleCount + storageCount + workCount + chargeCount;
  if (total + 2 * (total - 1) >= 100_000) throw new Error('点线总数超过 Tusk 地图的五位编号号段');
  const { turnAt = Math.ceil(aisleCount / 2) } = warehouse;
  if (shape === 'straight' && warehouse.turnAt !== undefined) throw new Error('直通道不使用 turnAt');
  if (shape === 'L' && (!Number.isInteger(turnAt) || turnAt <= 1 || turnAt >= aisleCount)) {
    throw new Error('L 形的 turnAt 使用从 1 开始的通道点序号，转角应位于两个端点之间');
  }

  const points = [];
  const links = [];
  function addPoint(id, type, col, row, neighbor) {
    points.push({ id, type, x: col * spacing, y: row * spacing });
    if (neighbor) links.push({ from: neighbor, to: id, bidirectional: true });
  }
  const aisle = [];
  for (let i = 1; i <= aisleCount; i++) {
    const col = shape === 'L' ? Math.min(i, turnAt) - 1 : 0;
    const row = shape === 'L' ? Math.max(i - turnAt, 0) : i - 1;
    const id = 'A' + i;
    addPoint(id, 'normal', col, row, aisle.at(-1)?.id);
    aisle.push({ id, col, row });
  }

  // Fill the nearest bay at every aisle position before adding another column in depth.
  // The previous bay is the only parent of the next bay, so a line never skips a point.
  function fillBays(totalBays, prefix, type, anchors, direction) {
    const tips = anchors.map(anchor => anchor.id);
    for (let i = 0; i < totalBays; i++) {
      const index = i % anchors.length;
      const anchor = anchors[index];
      const depth = Math.floor(i / anchors.length) + 1;
      const [dx, dy] = direction(index);
      const id = prefix + String(i + 1).padStart(2, '0');
      addPoint(id, type, anchor.col + dx * depth, anchor.row + dy * depth, tips[index]);
      tips[index] = id;
    }
  }
  if (shape === 'straight') {
    fillBays(storageCount, 'S', 'storage', aisle, () => [-1, 0]);
    fillBays(workCount, 'W', 'work', aisle, () => [1, 0]);
  } else {
    // Storage stays below the first leg. Work bays before the turn point up;
    // work bays at the corner and beyond point right and occupy a disjoint block.
    fillBays(storageCount, 'S', 'storage', aisle.slice(0, turnAt), () => [0, -1]);
    fillBays(workCount, 'W', 'work', aisle, i => i < turnAt - 1 ? [0, 1] : [1, 0]);
  }
  for (let i = 1; i <= chargeCount; i++) {
    addPoint('C' + i, 'charge', shape === 'L' ? -i : 0, shape === 'L' ? 0 : -i, i === 1 ? 'A1' : 'C' + (i - 1));
  }
  // All links in this recipe are bidirectional. Connectivity proves reachability
  // from A1 to every bay; callers can supply additional named route assertions.
  return { ...metadata, points, links, routes: metadata.routes === undefined ? [] : metadata.routes };
}
