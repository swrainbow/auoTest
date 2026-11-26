import { test, type Browser } from '@e2e-dev/web';
import { expect } from 'e2e';
import { bindPaladinMap, syncBoundMapServices } from '../../support/tusk-service-preflight.ts';

const original = ['CC', '33', '仿真test', 'Task001'];
const target = 'Task002';

type TestState = { syncTime: number; syncStatus: string };
async function serveServiceManagement(browser: Browser, maps: string[], multipleRattletraps = false,
  stateAfterRead?: (id: number, submissions: number, reads: number) => TestState) {
  const history = { loads: 0, requests: [] as string[], reads: new Map<number, number>(), readsAtSubmit: new Map<number, number>() };
  const submissions = new Map<number, number>();
  await browser.route(/\/prod-api\/basic\/tuskService\/\d+\/syncInfo$/, route => {
    const path = new URL(route.request.url).pathname;
    const id = Number(path.split('/').at(-2));
    history.requests.push(path);
    history.readsAtSubmit.set(id, history.reads.get(id) ?? 0);
    submissions.set(id, (submissions.get(id) ?? 0) + 1);
    history.reads.set(id, 0);
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ code: 200 }) });
  });
  await browser.route(/\/prod-api\/basic\/tuskService$/, route => {
    const services = [{id: 1, name: 'gamon'}, {id: 2, name: 'paladin-1'}, {id: 5, name: 'rattletrap'},
      {id: 8, name: 'paladin-2'}, ...(multipleRattletraps ? [{id: 9, name: 'rattletrap-2'}] : [])];
    const data = services.map(({ id, name }) => {
      const requests = submissions.get(id) ?? 0;
      const reads = (history.reads.get(id) ?? 0) + 1;
      history.reads.set(id, reads);
      const state = stateAfterRead?.(id, requests, reads) ?? { syncTime: 1 + requests, syncStatus: 'sync_success' };
      return { id, name, ...state };
    });
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ code: 200, data }) });
  });
  await browser.route(/\/config\/tuskService$/, route => {
    history.loads++;
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `
      <style>
        .el-select__wrapper { display: flex; align-items: center; height: 36px; width: 380px; border: 1px solid; }
        .el-select__selection { display: flex; flex: 1; }
        .el-tag { flex: 1; text-align: center; background: #eee; padding: 6px 0; }
        .el-select__input { width: 10px; }
        .el-select__suffix { padding: 8px; }
      </style>
      <div class="el-table">
        <table class="el-table__header"><tr><th>编号</th><th>名称</th><th>类型</th><th>地图</th><th>同步状态</th><th>操作</th></tr></table>
        <table class="el-table__body"><tbody>
          <tr><td>8</td><td>paladin-2</td><td>paladin</td><td>其他地图</td><td>同步成功</td><td><button>同步</button></td></tr>
          <tr><td>5</td><td>rattletrap</td><td>rattletrap</td><td>--</td><td>同步成功</td><td><button>同步</button></td></tr>
          ${multipleRattletraps ? '<tr><td>9</td><td>rattletrap-2</td><td>rattletrap</td><td>--</td><td>同步成功</td><td><button>同步</button></td></tr>' : ''}
          <tr><td>2</td><td>paladin-1</td><td>paladin</td><td id="maps"></td><td>同步成功</td><td><button id="edit">修改</button><button>同步</button></td></tr>
          <tr><td>1</td><td>gamon</td><td>gamon</td><td>--</td><td>同步成功</td><td><button>同步</button></td></tr>
        </tbody></table>
      </div>
      <section hidden role="dialog" aria-label="修改服务">
        <div class="tk-form-dynamic-item"><label>地图</label><div class="el-select"><div class="el-select__wrapper">
          <div class="el-select__selection"></div><input readonly tabindex="0" class="el-select__input" role="combobox" aria-haspopup="listbox" aria-controls="maps-list" aria-expanded="false">
          <span class="el-select__suffix"><i class="el-select__caret">⌄</i></span>
        </div></div></div>
        <button id="save">确定</button>
      </section>
      <section hidden role="alertdialog" aria-label="警告"><button id="confirm">确定</button></section>
      <div id="maps-list" role="listbox" hidden></div>
      <script>
        const initial = ${JSON.stringify(maps)}, options = [...new Set([...initial, '${target}0', '${target}'])];
        const stored = () => JSON.parse(localStorage.getItem('maps') || JSON.stringify(initial));
        const read = selector => document.querySelector(selector);
        const dialog = read('[role=dialog]'), combo = read('[role=combobox]'), list = read('[role=listbox]');
        const record = (event) => {
          const events = JSON.parse(localStorage.getItem('events') || '[]');
          localStorage.setItem('events', JSON.stringify([...events, event]));
        };
        const confirmation = read('[role=alertdialog]');
        fetch('/prod-api/basic/tuskService').then(r => r.json()).then(result => {
          for (const row of document.querySelectorAll('.el-table__body tbody tr')) {
            const service = result.data.find(s => String(s.id) === row.cells[0].textContent);
            row.cells[4].textContent = {syncing:'同步中',sync_success:'同步成功',sync_fail:'同步失败'}[service.syncStatus];
          }
        });
        for (const button of document.querySelectorAll('.el-table__body tr button:last-child')) {
          button.onclick = () => {
            const row = button.closest('tr');
            const service = row.cells[1].textContent;
            record('click:' + service);
            confirmation.hidden = false;
            read('#confirm').onclick = async () => {
              await fetch('/prod-api/basic/tuskService/' + row.cells[0].textContent + '/syncInfo', { method: 'POST' });
              record('sync:' + service);
              confirmation.hidden = true;
            };
          };
        }
        let selected;
        read('#maps').textContent = stored().join(',');
        function expand(open) {
          list.hidden = !open;
          combo.setAttribute('aria-expanded', String(open));
        }
        function render() {
          read('.el-select__selection').replaceChildren(...selected.map(name => {
            const tag = document.createElement('span');
            tag.className = 'el-tag';
            const label = document.createElement('span'), remove = document.createElement('span');
            label.className = 'el-tag__content';
            label.textContent = name;
            remove.className = 'el-tag__close';
            remove.textContent = '×';
            remove.onclick = () => { selected = selected.filter(value => value !== name); render(); };
            tag.append(label, remove);
            tag.onclick = event => event.stopPropagation();
            return tag;
          }));
          list.replaceChildren(...options.map(name => {
            const option = document.createElement('div');
            option.setAttribute('role', 'option');
            option.setAttribute('aria-selected', String(selected.includes(name)));
            option.textContent = name;
            option.onclick = () => {
              selected = selected.includes(name) ? selected.filter(value => value !== name) : [...selected, name];
              render();
            };
            return option;
          }));
        }
        read('#edit').onclick = () => { selected = stored(); dialog.hidden = false; render(); };
        read('.el-select__wrapper').onclick = () => expand(list.hidden);
        combo.onkeydown = event => {
          if (event.key === 'ArrowDown' || event.key === 'Enter') expand(true);
          if (event.key === 'Escape') expand(false);
        };
        read('#save').onclick = () => {
          localStorage.setItem('maps', JSON.stringify(selected));
          record('save');
          read('#maps').textContent = selected.join(',');
          expand(false);
          dialog.hidden = true;
        };
      </script>` });
  });
  return history;
}

test('有效期通知挡住操作列时，仍可追加地图并分别同步 Paladin 和 Rattletrap', async ({ app, browser, screen }) => {
  const history = await serveServiceManagement(browser, original);
  await browser.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => {
      const edit = document.querySelector('#edit');
      if (!edit) return;
      const table = document.querySelector('.el-table__body')!.getBoundingClientRect();
      const warning = document.createElement('div');
      warning.id = 'notification_1';
      warning.className = 'el-notification right';
      warning.setAttribute('role', 'alert');
      warning.style.cssText = 'position:fixed; z-index:3000; width:330px; background:white';
      warning.style.left = edit.getBoundingClientRect().left + 'px';
      warning.style.top = table.top + 'px';
      warning.style.height = table.height + 'px';
      warning.innerHTML = '<h2 class="el-notification__title">警告</h2><div class="el-notification__content">Lothar使用有效期只剩23时59分</div><i class="el-icon el-notification__closeBtn">×</i>';
      warning.querySelector('.el-notification__closeBtn')!.addEventListener('click', () => {
        localStorage.setItem('warningsClosed', String(Number(localStorage.getItem('warningsClosed')) + 1));
        warning.remove();
      });
      document.body.append(warning);
    });
  });
  await app.open('/config/tuskService');
  await bindPaladinMap(browser, screen, target, 'paladin-1');
  expect(history.loads >= 2).toBe(true);
  // The page raises the persistent notice again when each service is reloaded for sync.
  expect(await browser.evaluate(() => Number(localStorage.getItem('warningsClosed'))) >= 3).toBe(true);
  await expect(browser.locator('#maps')).toHaveText([...original, target].join(','));
  const events = await browser.evaluate(() => JSON.parse(localStorage.getItem('events') || '[]') as string[]);
  expect(events).toEqual(['save', 'click:paladin-1', 'sync:paladin-1', 'click:rattletrap', 'sync:rattletrap']);
  expect(history.requests).toEqual(['/prod-api/basic/tuskService/2/syncInfo', '/prod-api/basic/tuskService/5/syncInfo']);
});

test('已绑定地图可以补同步，并按服务全名选中多个 Rattletrap 中的一条', async ({ app, browser, screen }) => {
  const maps = [...original, target];
  const history = await serveServiceManagement(browser, maps, true);
  await app.open('/config/tuskService');
  await syncBoundMapServices(browser, screen, target, 'paladin-1', 'rattletrap-2');
  await expect(browser.locator('#maps')).toHaveText(maps.join(','));
  const events = await browser.evaluate(() => JSON.parse(localStorage.getItem('events') || '[]') as string[]);
  expect(events).toEqual(['click:paladin-1', 'sync:paladin-1', 'click:rattletrap-2', 'sync:rattletrap-2']);
  expect(history.requests).toEqual(['/prod-api/basic/tuskService/2/syncInfo', '/prod-api/basic/tuskService/9/syncInfo']);
});

test('旧成功和随后多次同步中均等待，绑定续跑只提交一次且无重复写地图', async ({ app, browser, screen }) => {
  const history = await serveServiceManagement(browser, [...original, target], false, (id, requests, reads) => {
    if (id === 5 && requests) {
      if (reads === 1) return { syncTime: 1, syncStatus: 'sync_success' };
      if (reads <= 4) return { syncTime: 2, syncStatus: 'syncing' };
    }
    return { syncTime: 1 + requests, syncStatus: 'sync_success' };
  });
  await app.open('/config/tuskService');
  await bindPaladinMap(browser, screen, target, 'paladin-1', undefined, true);
  expect(history.reads.get(5)! >= 5).toBe(true);
  const events = await browser.evaluate(() => JSON.parse(localStorage.getItem('events') || '[]') as string[]);
  expect(events).toEqual(['click:paladin-1', 'sync:paladin-1', 'click:rattletrap', 'sync:rattletrap']);
});

test('目标服务已在同步时跟踪原任务', async ({ app, browser, screen }) => {
  const history = await serveServiceManagement(browser, [...original, target], false, (id, submissions, reads) => ({
    syncTime: 1 + submissions,
    syncStatus: id === 2 && reads <= 2 ? 'syncing' : 'sync_success',
  }));
  await app.open('/config/tuskService');
  await syncBoundMapServices(browser, screen, target, 'paladin-1');
  expect(history.requests).toEqual(['/prod-api/basic/tuskService/5/syncInfo']);
});

test('新增地图时先等旧任务结束，再提交新绑定的同步', async ({ app, browser, screen }) => {
  const history = await serveServiceManagement(browser, original, false, (id, submissions, reads) => ({
    syncTime: 1 + submissions,
    syncStatus: id === 2 && !submissions && reads <= 3 ? 'syncing' : 'sync_success',
  }));
  await app.open('/config/tuskService');
  await bindPaladinMap(browser, screen, target, 'paladin-1');
  expect(history.readsAtSubmit.get(2)! > 3).toBe(true);
  expect(history.requests).toEqual(['/prod-api/basic/tuskService/2/syncInfo', '/prod-api/basic/tuskService/5/syncInfo']);
});

test('本轮服务明确失败时报告该行并停止提交', async ({ app, browser, screen }) => {
  const history = await serveServiceManagement(browser, [...original, target], false, (id, submissions) => ({
    syncTime: 1 + submissions,
    syncStatus: id === 5 && submissions ? 'sync_fail' : 'sync_success',
  }));
  await app.open('/config/tuskService');
  let failure = '';
  try {
    await syncBoundMapServices(browser, screen, target, 'paladin-1');
  } catch (error) {
    failure = String(error);
  }
  expect(failure).toContain('服务「rattletrap」：同步失败');
  expect(history.requests).toEqual(['/prod-api/basic/tuskService/2/syncInfo', '/prod-api/basic/tuskService/5/syncInfo']);
});
