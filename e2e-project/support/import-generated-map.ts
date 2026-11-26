import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { Browser, WebResponse } from '@e2e-dev/web';
import { buildMap } from '../../skills/tusk-map-simulation/scripts/build-map.mjs';
import { checkLayout } from '../../skills/tusk-map-simulation/scripts/check-layout.mjs';
import { encodeMap } from '../../skills/tusk-map-simulation/scripts/map-codec.mjs';
import { ensureMap, observeMapResponse, waitForMapIdle } from './ensure-map.ts';

type Route = { from: string; to: string };
export interface MapLayout {
  mapName: string;
  floor?: number;
  ver?: string;
  geometry?: 'orthogonal' | 'free';
  points: Array<{ id: string; type: string; x: number; y: number }>;
  links: Array<Route & { bidirectional: boolean }>;
  routes?: Route[];
}

interface SiteMap {
  id: number;
  mapName: string;
  floor: number;
  mapDataList: Array<{ dataCode: string; x: number; y: number; dataType: number; chargerId?: string; storageList?: unknown[] }>;
  mapLineList: Array<{ lineCode: string; reverseLineCode: string; nodeStart: string; nodeEnd: string; isDelete?: boolean; controlPoints?: unknown[] }>;
  mapAreaList: unknown[];
}

const frame = 'iframe#hyjalIframe';
const switcher = '.show-circle-btn[role="button"][tkmapid]:not([tkmapid=""])';
const networkTimeout = { timeout: 30_000 };

async function responseData(response: WebResponse) {
  if (response.status !== 200) throw new Error(`地图请求返回 HTTP ${response.status}`);
  const body = await response.json<{ code: number | string; data?: SiteMap; msg?: string; message?: string }>();
  if (Number(body?.code) !== 200) {
    throw new Error(`地图请求失败（${body?.code}）${body?.msg ?? body?.message ?? ''}`);
  }
  return body.data;
}

// The toolbar refresh clears the canvas and loads the selected map into it.
// A page reload would first start drawing the site's default map again.
async function readSavedMap(browser: Browser, layout: MapLayout, id: string): Promise<SiteMap> {
  const editor = browser.frameLocator(frame);
  await waitForMapIdle(browser, frame);
  const target = editor.locator(`${switcher}[tkmapid="${id}"]`);
  if (await target.count() !== 1 || (await target.textContent())?.trim() !== layout.mapName) {
    throw new Error(`回读前当前地图与目标「${layout.mapName}」ID ${id} 不符`);
  }
  const [response] = await observeMapResponse(browser,
    new RegExp('/tkmap/map/getById/' + id + '/?(?:[?#]|$)'),
    () => editor.locator('.bar-tools .svg-icon:has(use[*|href="#icon-refresh"])').click(networkTimeout));
  const map = await responseData(response);
  await waitForMapIdle(browser, frame);
  if (!map || await target.count() !== 1 || (await target.textContent())?.trim() !== layout.mapName ||
      String(map.id) !== id || map.mapName !== layout.mapName) {
    throw new Error(`地图回读与目标不符，请核对「${layout.mapName}」的地图 ID ${id}`);
  }
  if (!Number.isSafeInteger(map.floor) || (layout.floor !== undefined && map.floor !== layout.floor)) {
    throw new Error(`地图「${layout.mapName}」回读楼层 ${map.floor}，期望 ${layout.floor ?? '有效整数'}`);
  }
  if (![map.mapDataList, map.mapLineList, map.mapAreaList].every(Array.isArray)) {
    throw new Error('地图回读缺少点、线或区域数组，无法确认目标内容');
  }
  return map;
}

function topology(map: SiteMap) {
  const points = map.mapDataList.map(point => ({
    id: point.dataCode,
    type: point.dataType,
    x: typeof point.x === 'number' ? Math.fround(point.x) : null,
    y: typeof point.y === 'number' ? Math.fround(point.y) : null,
    // Lothar may rename colliding charger IDs and allocate new storage IDs.
    charger: typeof point.chargerId === 'string' && point.chargerId.trim() !== '',
    storages: point.storageList?.length ?? 0,
  })).sort((a, b) => a.id.localeCompare(b.id));
  const directions = map.mapLineList.map(line => ({
    id: line.lineCode,
    reverse: line.reverseLineCode,
    from: line.nodeStart,
    to: line.nodeEnd,
    disabled: line.isDelete ?? false,
    controlPoints: line.controlPoints ?? [],
  })).sort((a, b) => a.id.localeCompare(b.id));
  return { points, directions, areas: map.mapAreaList.length };
}

/** The caller has opened /tkmap/mapDraw in the authenticated target session. */
export async function importGeneratedMap(browser: Browser, requested: MapLayout, existingOnly = false) {
  if (!existingOnly) checkLayout(requested); // Validate before possibly creating a map.
  await ensureMap(browser, frame, requested.mapName, requested.floor, existingOnly);
  const editor = browser.frameLocator(frame);
  const current = editor.locator(switcher);
  const id = await current.getAttribute('tkmapid');
  if (!id || !/^[1-9]\d*$/.test(id)) throw new Error('目标地图尚无有效的 tkMapId');
  const before = await readSavedMap(browser, requested, id);
  const layout = { ...requested, floor: before.floor };
  const { map, summary } = buildMap(layout, id);
  const plain = Buffer.from(JSON.stringify(map, null, 2) + '\n', 'utf8');
  const encrypted = encodeMap(plain);
  const parent = resolve(process.env.AUTOTEST_MAP_ARTIFACT_DIR || tmpdir());
  await mkdir(parent, { recursive: true });
  const artifactDirectory = await mkdtemp(join(parent, `map-${id}-`));
  const file = join(artifactDirectory, 'map.import.json');
  await Promise.all([
    writeFile(join(artifactDirectory, 'layout.json'), JSON.stringify(layout, null, 2) + '\n'),
    writeFile(join(artifactDirectory, 'map.json'), plain),
    writeFile(file, encrypted),
  ]);
  const expected = topology(map);
  if (before.mapDataList.length || before.mapLineList.length || before.mapAreaList.length) {
    if (isDeepStrictEqual(topology(before), expected)) return { status: 'reused', artifactDirectory, ...summary };
    throw new Error(`目标地图「${layout.mapName}」已有不同的点、线或区域，需选用空图。已生成的整图包：${file}`);
  }

  await editor.locator(`${switcher}[tkmapid="${id}"]`).secondaryTap();
  await editor.getByText('导入', { exact: true }).hover();
  try {
    // On a menu item setInputFiles starts the native chooser listener, clicks once, and selects this file.
    const [response] = await observeMapResponse(browser, /\/tkmap\/map\/importMap\/?(?:[?#]|$)/,
      () => editor.getByText('导入地图', { exact: true }).setInputFiles(file, networkTimeout));
    await responseData(response);
  } catch (error) {
    let state: string;
    try {
      const observed = await readSavedMap(browser, layout, id);
      state = isDeepStrictEqual(topology(observed), expected) ? '目标拓扑已回读匹配' : '目标拓扑未匹配';
    } catch (readError) {
      state = `回读失败（${readError instanceof Error ? readError.message : readError}）`;
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`地图导入未获成功响应：${reason}。 ${state}。整图包：${file}`, { cause: error });
  }
  if (!isDeepStrictEqual(topology(await readSavedMap(browser, layout, id)), expected)) {
    throw new Error(`地图导入已返回成功，回读的点位或正反向线与生成数据不符。整图包：${file}`);
  }
  return { status: 'imported', artifactDirectory, ...summary };
}
