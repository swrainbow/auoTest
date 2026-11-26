// Operate on coordinates rounded to the same Float precision as Lothar.
function side(a, b, point) {
  return Math.sign((b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x));
}

function insideBounds(point, a, b) {
  return point.x >= Math.min(a.x, b.x) && point.x <= Math.max(a.x, b.x) &&
    point.y >= Math.min(a.y, b.y) && point.y <= Math.max(a.y, b.y);
}

export function checkGeometry(points, connections, geometry) {
  const checked = [];
  for (const { from, to } of connections) {
    const a = points.get(from);
    const b = points.get(to);
    if (geometry === 'orthogonal' && a.x !== b.x && a.y !== b.y) {
      throw new Error(`连线 ${from} → ${to} 为斜线；请将点位按行列对齐，或增设拐点分段连接`);
    }
    for (const [id, point] of points) {
      if (id !== from && id !== to && insideBounds(point, a, b) && side(a, b, point) === 0) {
        throw new Error(`连线 ${from} → ${to} 跨过点位 ${id}；请沿线按相邻点分段连接`);
      }
    }
    // Collinear overlaps and T-junctions already have a point inside a segment.
    // What remains is a crossing strictly inside both segments.
    for (const previous of checked) {
      if (side(a, b, previous.a) * side(a, b, previous.b) < 0 &&
          side(previous.a, previous.b, a) * side(previous.a, previous.b, b) < 0) {
        throw new Error(`连线 ${from} → ${to} 与 ${previous.from} → ${previous.to} 在端点以外交叉；请绕行或在交叉处建点并拆分两条线`);
      }
    }
    checked.push({ from, to, a, b });
  }
}
