import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { web } from '@e2e-dev/web';
import { openHost } from 'e2e/runner';
import { decodeMap } from '../../skills/tusk-map-simulation/scripts/map-codec.mjs';
import { importGeneratedMap } from './import-generated-map.ts';

const layout = {
  mapName: '本地导入测试', floor: 1,
  points: [
    { id: 'A', type: 'normal', x: 0, y: 0 },
    { id: 'C', type: 'charge', x: 3, y: 0 },
    { id: 'W', type: 'work', x: 3, y: 2 },
  ],
  links: [{ from: 'A', to: 'C', bidirectional: true }, { from: 'C', to: 'W', bidirectional: false }],
  routes: [{ from: 'A', to: 'W' }],
};
const emptyMap = () => ({ id: 8, mapName: layout.mapName, floor: 1, mapDataList: [], mapLineList: [], mapAreaList: [] });
const editor = `<!doctype html><meta charset="utf-8"><style>#settings {margin-left:200px}</style>
<div class="root-container">
<div id="mask" class="el-loading-mask" hidden>地图加载中</div>
<button id="current" class="show-circle-btn" role="button" aria-expanded="false" aria-haspopup="menu">--</button>
<button id="settings">打开设置</button>
<div class="bar-tools"><button id="refresh" class="svg-icon" aria-label="还原"><svg width="16" height="16"><use xlink:href="#icon-refresh"></use></svg></button></div>
<div id="maps" class="map-dropdown-menu" role="menu" hidden><button id="selected" role="menuitem" disabled></button></div>
<div id="actions" hidden><button id="group">导入</button><button id="upload" hidden>导入地图</button></div>
<output id="canvasPoints">previous-map-point</output>
</div>
<script>
fetch('/tkmap/map/getById/8').then(r => r.json()).then(({data}) => {
  current.textContent = selected.textContent = data.mapName;
  current.setAttribute('tkmapid', data.id);
});
refresh.onclick = async () => {
  mask.hidden = false;
  const response = await fetch('/tkmap/map/getById/' + current.getAttribute('tkmapid'));
  const { data } = await response.json();
  // The response arrives before the editor replaces the previous canvas contents.
  setTimeout(() => {
    canvasPoints.textContent = data.mapDataList.map(point => point.dataCode).join(',');
    mask.hidden = true;
  }, 400);
};
current.onmouseenter = () => { maps.hidden = false; current.setAttribute('aria-expanded', 'true'); };
current.onkeydown = e => {
  if (e.code === 'ArrowDown') {
    e.preventDefault(); maps.hidden = !maps.hidden; current.setAttribute('aria-expanded', String(!maps.hidden));
  }
};
settings.onmouseenter = () => { maps.hidden = true; current.setAttribute('aria-expanded', 'false'); };
current.oncontextmenu = e => { e.preventDefault(); maps.hidden = true; actions.hidden = false; };
group.onmouseenter = () => { upload.hidden = false; };
upload.onclick = () => {
  if (!mask.hidden || canvasPoints.textContent) {
    const warning = document.createElement('div');
    warning.className = 'el-notification';
    warning.textContent = '地图已经初始化，无法导入';
    document.body.appendChild(warning);
    return;
  }
  const input = document.createElement('input');
  input.type = 'file';
  input.onchange = () => {
    const data = new FormData();
    data.append('tkMapId', current.getAttribute('tkmapid'));
    data.append('file', input.files[0]);
    fetch('/tkmap/map/importMap', {method: 'POST', body: data}).then(response => response.json());
  };
  input.click();
};
</script>`;

test('generated maps use the iframe file chooser and verify the persisted topology', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'map-upload-test-'));
  const previous = { TUSK_MAP_KEY: process.env.TUSK_MAP_KEY, AUTOTEST_MAP_ARTIFACT_DIR: process.env.AUTOTEST_MAP_ARTIFACT_DIR };
  process.env.TUSK_MAP_KEY = 'offline-map-fixture';
  process.env.AUTOTEST_MAP_ARTIFACT_DIR = directory;
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  });
  let saved = emptyMap();
  let importMode = 'save';
  let reads = 0;
  let editorLoads = 0;
  const uploads = [];
  const server = createServer(async (request, response) => {
    response.setHeader('cache-control', 'no-store');
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/tkmap/mapDraw' || url.pathname === '/editor') {
      if (url.pathname === '/editor') editorLoads++;
      response.setHeader('content-type', 'text/html;charset=utf-8');
      response.end(url.pathname === '/editor' ? editor : '<iframe id="hyjalIframe" width="800" height="400" src="/editor"></iframe>');
      return;
    }
    response.setHeader('content-type', 'application/json;charset=utf-8');
    if (url.pathname === '/tkmap/map/getById/8') {
      reads++;
      response.end(JSON.stringify({ code: 200, data: saved }));
    } else if (request.method === 'POST' && url.pathname === '/tkmap/map/importMap') {
      try {
        const parts = await new Response(request, { headers: request.headers }).formData();
        const file = parts.get('file');
        const encoded = await file.text();
        const map = JSON.parse(decodeMap(Buffer.from(encoded)));
        uploads.push({ target: parts.get('tkMapId'), name: file.name, encoded });
        if (importMode !== 'reject') saved = map;
        if (importMode === 'dropLine') saved.mapLineList.pop();
        response.end(JSON.stringify(importMode === 'reject' ? { code: 500, msg: 'fixture rejection' } : { code: 200 }));
      } catch (error) {
        response.writeHead(400).end(JSON.stringify({ message: error.message }));
      }
    } else response.writeHead(404).end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/tkmap/mapDraw`;
  const host = await openHost({ cwd: directory, config: { targets: [{ engine: web(), app: { url } }] } });
  let session;
  try {
    session = await host.openSession({ name: 'map-import' });
    const { browser } = session.fixtures;
    await browser.goto(url);
    const { floor, ...siteLayout } = layout;
    saved.floor = 3;
    await assert.rejects(importGeneratedMap(browser, layout, true), /回读楼层 3，期望 1/);
    assert.equal(uploads.length, 0);
    // Recreate the reported state: the header identifies the target but the
    // editor still shows the previous map's points.
    await browser.goto(url);
    const canvas = browser.frameLocator('iframe#hyjalIframe').locator('#canvasPoints');
    assert.equal(await canvas.textContent(), 'previous-map-point');
    const loadsBeforeImport = editorLoads;
    const imported = await importGeneratedMap(browser, siteLayout, true);
    assert.equal(imported.status, 'imported');
    assert.equal(imported.tkMapId, 8);
    assert.equal(uploads.length, 1);
    assert.equal(editorLoads, loadsBeforeImport);
    assert.equal(await canvas.textContent(), saved.mapDataList.map(point => point.dataCode).join(','));
    const encoded = await readFile(join(imported.artifactDirectory, 'map.import.json'), 'utf8');
    assert.deepEqual(uploads[0], { target: '8', name: 'map.import.json', encoded });
    assert.match(encoded, /^[A-Za-z0-9+/]+=*$/);
    assert.deepEqual(saved, JSON.parse(await readFile(join(imported.artifactDirectory, 'map.json'), 'utf8')));
    assert.equal(saved.floor, 3);
    assert.equal(JSON.parse(await readFile(join(imported.artifactDirectory, 'layout.json'), 'utf8')).floor, 3);
    assert.ok(saved.mapDataList.find(p => p.dataType === 10)?.chargerId);
    assert.equal(saved.mapLineList.length, 4);
    assert.equal(saved.mapLineList.filter(l => l.isDelete).length, 1);
    assert.ok(reads >= 3);

    const reused = await importGeneratedMap(browser, siteLayout, true);
    assert.equal(reused.status, 'reused');
    assert.equal(uploads.length, 1);
    saved.mapDataList.find(p => p.dataType === 10).chargerId = null;
    await assert.rejects(importGeneratedMap(browser, siteLayout, true), /已有不同的点、线或区域/);
    saved = { ...emptyMap(), mapAreaList: [{}] };
    await assert.rejects(importGeneratedMap(browser, layout), /已有不同的点、线或区域/);
    assert.equal(uploads.length, 1);

    saved = emptyMap();
    importMode = 'dropLine';
    await assert.rejects(importGeneratedMap(browser, layout), /回读的点位或正反向线与生成数据不符/);
    assert.equal(uploads.length, 2);
    saved = emptyMap();
    importMode = 'reject';
    const readsBefore = reads;
    await assert.rejects(importGeneratedMap(browser, layout), /fixture rejection/);
    assert.equal(uploads.length, 3);
    assert.ok(reads >= readsBefore + 2);
  } finally {
    await session?.close();
    await host.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
