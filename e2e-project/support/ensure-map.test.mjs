import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { ensureMap, observeMapResponse } from './ensure-map.ts';

// Use the same Chromium executable and Playwright version as the installed web engine.
const { chromium } = createRequire(import.meta.resolve('@e2e-dev/web'))('playwright-core');
const selector = 'iframe#hyjalIframe';

test('地图编辑器按完整名称创建、复用并只读回查', async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(2000);
  const editorUrl = 'http://localhost/tkmap/mapDraw';
  await page.route(editorUrl, route => route.fulfill({
    contentType: 'text/html; charset=utf-8',
    body: '<button role="menuitem">添加地图</button><iframe id="hyjalIframe" name="editor"></iframe>',
  }));
  await page.goto(editorUrl);
  const frame = page.frame({ name: 'editor' });
  await frame.setContent(`
    <div class="root-container">
    <div class="el-loading-mask" hidden>地图加载中</div>
    <button class="show-circle-btn" role="button" aria-haspopup="menu" aria-expanded="false" tkmapid="">--</button>
    <button id="settings" style="float:right">打开设置</button>
    <div class="map-dropdown-menu" role="menu" hidden></div>
    <section role="dialog" aria-label="添加地图" hidden>
      <input placeholder="请输入名称"><input placeholder="请输入楼层"><input id="map-id" value="auto-id">
      <select id="mode"><option>默认模式</option><option>其他模式</option></select><button>确定</button>
    </section>
    </div>
  `);
  await frame.evaluate(() => {
    const switcher = document.querySelector('.show-circle-btn');
    const menu = document.querySelector('[role=menu]');
    const dialog = document.querySelector('[role=dialog]');
    const mask = document.querySelector('.el-loading-mask');
    const maps = ['原地图', 'Task0010'];
    function selectMap(name) {
      mask.hidden = false;
      switcher.setAttribute('tkmapid', String(maps.indexOf(name) + 1));
      switcher.textContent = name;
      setTimeout(() => {
        window.drawnMap = name;
        mask.hidden = true;
      }, 300);
    }
    window.coldStart = () => {
      mask.hidden = false;
      window.drawnMap = '';
      switcher.setAttribute('tkmapid', '');
      switcher.textContent = '--';
      render(false);
      setTimeout(() => { selectMap('原地图'); render(false); }, 250);
    };
    window.earlyHovers = 0;
    window.earlyMenuOpens = 0;
    window.saved = [];
    function render(open) {
      if (open && !mask.hidden) window.earlyMenuOpens++;
      menu.hidden = !open;
      switcher.setAttribute('aria-expanded', String(open));
      menu.setAttribute('aria-label', switcher.textContent);
      menu.replaceChildren();
      for (const name of ['添加地图', ...maps]) {
        const item = document.createElement('button');
        item.setAttribute('role', 'menuitem');
        item.textContent = name;
        item.disabled = name === switcher.textContent;
        // A pointer crossing from the trigger into a lower menu row can hide
        // the popup before a click. Keyboard activation leaves it open.
        if (name === 'Task0010') item.onpointerenter = () => render(false);
        item.onclick = () => {
          if (name === '添加地图') dialog.hidden = false;
          else selectMap(name);
          render(false);
        };
        // Add action appears first, then the disabled current item and the other maps.
        if (open && name !== '添加地图') {
          const delay = name === 'Task0010' ? 140 : 50;
          setTimeout(() => { if (!menu.hidden) menu.append(item); }, delay);
        } else {
          menu.append(item);
        }
      }
    }
    switcher.onmouseenter = () => {
      if (!switcher.getAttribute('tkmapid')) window.earlyHovers++;
      render(true);
    };
    switcher.onkeydown = e => {
      if (e.code === 'ArrowDown') { e.preventDefault(); render(menu.hidden); }
    };
    document.querySelector('#settings').onmouseenter = () => render(false);
    dialog.querySelector('button').onclick = () => {
      const [name, floor, id] = [...dialog.querySelectorAll('input')].map(input => input.value);
      window.saved.push([name, floor, id, dialog.querySelector('select').value]);
      maps.push(name);
      selectMap(name);
      dialog.hidden = true;
    };
    window.coldStart();
  });
  const saves = () => frame.evaluate(() => window.saved);
  const current = frame.locator('.show-circle-btn');

  await ensureMap(page, selector, 'Task0010', 1, true);
  assert.equal(await current.textContent(), 'Task0010');
  assert.equal(await frame.evaluate(() => window.earlyMenuOpens), 0);
  assert.equal(await frame.evaluate(() => window.drawnMap), 'Task0010');
  assert.equal((await saves()).length, 0);
  await ensureMap(page, selector, 'Task001');
  assert.deepEqual(await saves(), [['Task001', '1', 'auto-id', '默认模式']]);
  await ensureMap(page, selector, 'Task001', 1, true);
  assert.equal(await current.getAttribute('aria-expanded'), 'false');
  // Refresh restores the placeholder and discards any menu opened during initialization.
  await frame.evaluate(() => window.coldStart());
  await ensureMap(page, selector, 'Task001', 1, true);
  assert.equal(await current.textContent(), 'Task001');
  assert.equal(await frame.evaluate(() => window.earlyHovers), 0);
  assert.equal(await frame.evaluate(() => window.earlyMenuOpens), 0);
  assert.equal(await frame.evaluate(() => window.drawnMap), 'Task001');
  await ensureMap(page, selector, '原地图', 1, true);
  assert.equal(await current.textContent(), '原地图');
  assert.equal((await saves()).length, 1);
  await assert.rejects(ensureMap(page, selector, '另一个地图', 3, true), /持久化回读失败/);
  assert.equal((await saves()).length, 1);
  // Missing readback leaves the menu open. Explicit creation must work from this state too.
  await ensureMap(page, selector, '另一个地图', 3);
  assert.deepEqual((await saves())[1], ['另一个地图', '3', 'auto-id', '默认模式']);

  const map = { id: 2, mapName: 'Task0010', floor: -2 };
  const calls = [];
  const floorReader = {
    frameLocator: value => page.frameLocator(value),
    waitForResponse: async pattern => {
      assert.ok(pattern.test('/prod-api/tkmap/map/getById/2'));
      calls.push('read');
      return { status: 200, json: async () => ({ code: 200, data: map }) };
    },
    reload: async () => { calls.push('reload'); await frame.evaluate(() => window.coldStart()); },
    waitForURL: async pattern => { calls.push('end'); await page.waitForURL(pattern); },
  };
  const log = t.mock.method(console, 'log', () => {});
  await ensureMap(floorReader, selector, 'Task0010', 1, true, true);
  assert.deepEqual(calls, ['read', 'reload', 'end']);
  assert.match(log.mock.calls[0].arguments[0], /Task0010.*ID 2.*-2/);
  map.id = 42;
  await assert.rejects(ensureMap(floorReader, selector, 'Task0010', 1, true, true), /核实地图 ID/);
  assert.equal(log.mock.calls.length, 1);
  assert.equal((await saves()).length, 2);
});

test('地图读取在触发操作失败时等待监听结束，并保留原始操作错误', async () => {
  let rejectResponse;
  const response = new Promise((_, reject) => { rejectResponse = reject; });
  const failure = new Error('目标菜单项在激活时关闭');
  const action = observeMapResponse({ waitForResponse: () => response }, /getById/, async () => { throw failure; });
  let finished = false;
  const check = assert.rejects(action, error => error === failure).finally(() => { finished = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  rejectResponse(new Error('未收到目标详情'));
  await check;
});
