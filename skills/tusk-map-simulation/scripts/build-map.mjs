import { readFile } from 'node:fs/promises';
import { checkLayout } from './check-layout.mjs';
import { expandWarehouseLayout } from './warehouse-layout.mjs';
import { writeNewFile } from './write-new-file.mjs';

const dataTypes = { normal: 1, charge: 10, work: 40, buffer: 41, storage: 42, waypoint: 50 };

export function buildMap(input, mapIdText) {
  const layout = expandWarehouseLayout(input);
  const report = checkLayout(layout);
  const tkMapId = Number(mapIdText);
  if (!/^[1-9]\d*$/.test(mapIdText) || !Number.isSafeInteger(tkMapId)) {
    throw new Error('tkMapId 必须为正整数');
  }
  const segmentSize = 100_000;
  const baseCode = tkMapId * segmentSize;
  const codesNeeded = report.pointCount + 2 * report.physicalConnectionCount;
  // Tusk 的点线编号带五位后缀，空地图起号时使用 Java Integer 运算。
  if (codesNeeded >= segmentSize || baseCode + codesNeeded > 2_147_483_647) {
    throw new Error('点线编号超出该地图的五位号段或 32 位正整数范围');
  }

  const pointCodes = new Map();
  let nextStorageId = baseCode + 1;
  let nextChargerId = baseCode + 1;
  const mapDataList = layout.points.map(({ id, x, y, type }, index) => {
    const dataCode = String(baseCode + index + 1);
    pointCodes.set(id, dataCode);
    const dataType = dataTypes[type];
    const storageList = dataType >= 40 ? [{
      id: nextStorageId++, dataCode, name: dataCode, tkMapId, carrierId: null, lockStatus: 'unlock', height: 0,
    }] : null;
    return {
      dataCode, tkMapId, x, y, dataType, storageList,
      chargerId: type === 'charge' ? String(nextChargerId++) : null,
      generalConfig: type === 'normal' ? null : '{}',
      robotConstrains: null, containerConstrains: null,
      customMerlin: '', customOrion: '', customLothar: '', stoTheta: null,
    };
  });

  // 两条相向的单向输入与一条双向输入表示同一组物理连接。
  const connections = new Map();
  for (const link of layout.links) {
    const key = JSON.stringify([link.from, link.to].sort());
    const existing = connections.get(key);
    if (existing) existing.bidirectional = true;
    else connections.set(key, { ...link });
  }
  let nextLineCode = baseCode + mapDataList.length + 1;
  const mapLineList = [];
  for (const { from, to, bidirectional } of connections.values()) {
    const lineCode = String(nextLineCode++);
    const reverseLineCode = String(nextLineCode++);
    const forward = {
      lineCode, reverseLineCode, tkMapId, nodeStart: pointCodes.get(from), nodeEnd: pointCodes.get(to),
      controlPoints: null, generalConfig: null, robotConstrains: null, containerConstrains: null,
      customMerlin: null, customOrion: null, customLothar: null, isDelete: false,
    };
    // Hyjal 在单向连接上保留反向记录，isDelete 控制该方向的通行。
    const reverse = {
      ...forward, lineCode: reverseLineCode, reverseLineCode: lineCode,
      nodeStart: forward.nodeEnd, nodeEnd: forward.nodeStart, isDelete: !bidirectional,
    };
    mapLineList.push(forward, reverse);
  }
  return {
    map: { ver: layout.ver ?? '5.10', id: tkMapId, mapName: layout.mapName, floor: layout.floor, mapDataList, mapLineList, mapAreaList: [], decorateList: [] },
    summary: { ...report, tkMapId, lineRecordCount: mapLineList.length, pointCodes: Object.fromEntries(pointCodes) },
  };
}

async function main() {
  const [source, mapIdText, destination, ...extra] = process.argv.slice(2);
  if (!source || !mapIdText || !destination || extra.length) {
    throw new Error('用法：node build-map.mjs <layout.json> <tkMapId> <new-output.json>');
  }
  const input = await readFile(source, 'utf8');
  const { map, summary } = buildMap(JSON.parse(input.replace(/^\uFEFF/, '')), mapIdText);
  const payload = JSON.stringify(map, null, 2) + '\n';
  await writeNewFile(destination, payload);
  console.log(JSON.stringify({ output: destination, ...summary }, null, 2));
}

if (import.meta.main) main().catch(error => {
  console.error(`地图构建失败：${error.message}`);
  process.exitCode = 1;
});
