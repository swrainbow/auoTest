import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import {
  createSimulationInstance, verifySimulationCreated, configureSimulationApr,
  verifySimulationApr, startSimulationInstance, verifySimulationRunning,
} from './simulation-start.ts';

const { chromium } = createRequire(import.meta.resolve('@e2e-dev/web'))('playwright-core');

// The created target lands on page two. All state and writes are local.
test('按新增编号跨页配置 APR，检查同图占用，只开启新实例并刷新回读', async t => {
  const chromiumBrowser = await chromium.launch();
  t.after(() => chromiumBrowser.close());
  const p = await chromiumBrowser.newPage();
  p.setDefaultTimeout(2500);
  const rows = [
    { id: 2, name: 'Task002', map: 'Task002', status: '结束', count: 8 },
    { id: 8, name: '其他', map: '其他', status: '运行中', count: 2 },
  ];
  const started = [];
  let startError;
  const html = `
  <button id="add">添加</button><button id="start" disabled>开启</button>
  <div class="el-table"><table class="el-table__header"><tr>` +
    ['', '编号', '实例名称', '状态', '绑定地图', '设备配置操作'].map(h => '<th><div>' + h + '</div></th>').join('') + `
  </tr></table><table class="el-table__body"><tbody></tbody></table></div>
  <div class="el-pagination"><button class="btn-next">下一页</button></div>
  <div role="dialog" aria-label="添加仿真实例" id="create" hidden>
    <input placeholder="请输入实例名称"><div class="tk-form-dynamic-item"><label>绑定地图</label>
    <div class="el-select"><input role="combobox" aria-controls="maps"><span id="selected"></span></div></div>
    <div id="maps" hidden><div role="option">Task002</div></div><button>确定</button>
  </div>
  <div class="el-drawer" role="dialog" aria-label="设备配置" hidden>
    <div class="el-table"><table class="el-table__header"><tr><th><div>物理属性</div></th><th><div>APR</div></th><th><div>数量</div></th></tr></table>
    <table class="el-table__body"><tbody><tr><td>789</td><td><span>APR</span></td><td><input type="number"></td></tr></tbody></table></div>
    <button>确定</button><button>取消</button>
  </div>
  <script>
    const one=s=>document.querySelector(s), drawer=one('.el-drawer');
    let page=0,editing;
    async function render() {
      const result=await (await fetch('/sims/instances/data?page='+page)).json();
      const tbody=one('.el-table__body tbody'); tbody.replaceChildren();
      for (const row of result.content) {
        const tr=tbody.insertRow(); tr.insertCell().innerHTML='<label class="el-checkbox"><input type="checkbox"></label>';
        for(const field of ['id','name','status','map']) tr.insertCell().textContent=row[field];
        tr.insertCell().innerHTML='<button>设备配置</button>';
        tr.querySelector('button').onclick=()=>{editing=row.id;drawer.querySelector('input').value=row.count;drawer.hidden=false;};
        tr.querySelector('input').onchange=()=>one('#start').disabled=!document.querySelector('tbody input:checked');
      }
    }
    one('#add').onclick=()=>one('#create').hidden=false;
    one('.el-select').onclick=()=>one('#maps').hidden=false;
    one('[role=option]').onclick=()=>{one('#selected').textContent='Task002';one('#maps').hidden=true;};
    one('#create button').onclick=async()=>{await fetch('/sims/instances',{method:'POST',body:one('#create input').value});one('#create').hidden=true;};
    drawer.querySelector('button').onclick=async()=>{await fetch('/sims/instances/'+editing,{method:'POST',body:drawer.querySelector('input').value});drawer.hidden=true;};
    drawer.querySelectorAll('button')[1].onclick=()=>drawer.hidden=true;
    one('.btn-next').onclick=()=>{page++;render();};
    one('#start').onclick=async()=>{
      const id=document.querySelector('tbody input:checked').closest('tr').cells[1].textContent;
      await fetch('/sims/instances/action',{method:'POST',body:id});
    };
    render();
  </script>`;
  await p.route('http://simulation.test/**', async route => {
    const u = new URL(route.request().url());
    const value = route.request().postData();
    if (u.pathname === '/task/simConfig') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
    if (u.pathname === '/sims/instances/data') {
      const number = Number(u.searchParams.get('page'));
      const content = rows.slice(number * 2, number * 2 + 2).map(row => ({
        ...row, deviceData: [{ devType: 'CSE', devNum: null }, { devType: 'APR', devNum: row.count }],
      }));
      return route.fulfill({ json: { number, totalPages: Math.ceil(rows.length / 2), totalElements: rows.length, content } });
    }
    if (u.pathname === '/sims/instances') rows.push({
      id: Math.max(...rows.map(row => row.id)) + 1, name: value, map: value, status: '创建', count: 1,
    });
    if (/^\/sims\/instances\/\d+$/.test(u.pathname)) rows.find(r => r.id === Number(u.pathname.split('/').pop())).count = Number(value);
    if (u.pathname === '/sims/instances/action') {
      started.push(Number(value));
      if (startError) return route.fulfill({ json: startError });
      rows.find(r => r.id === Number(value)).status = '运行中';
    }
    return route.fulfill({ json: { code: 200 } });
  });
  await p.goto('http://simulation.test/task/simConfig');
  let outgoingResponsePending = false;
  const browser = {
    locator: s => p.locator(s), url: () => p.url(), reload: () => p.reload(),
    async goto(url) {
      await p.goto(url);
      if (url === 'about:blank') outgoingResponsePending = false;
    },
    evaluate: fn => p.evaluate(fn),
    async waitForResponse(...args) {
      if (outgoingResponsePending && args[0].test('/sims/instances/data')) {
        return { status: 200, json: async () => { throw new Error('waitForResponse: response body could not be read: No resource with given identifier found'); } };
      }
      const response = await p.waitForResponse(...args);
      return { status: response.status(), json: () => response.json() };
    },
  };
  await assert.rejects(createSimulationInstance(browser, 'Task002'), /仿真实例重名告警：.*名称「Task002」.*2（地图「Task002」，结束）/);
  assert.equal(rows.length, 2);
  rows[0].name = 'Task002-old';
  const id = await createSimulationInstance(browser, 'Task002');
  assert.equal(id, '9');
  await verifySimulationCreated(browser, id, 'Task002');
  await configureSimulationApr(browser, id, 'Task002', 3);
  await verifySimulationApr(browser, id, 'Task002', 3);
  assert.equal(rows[0].count, 8);
  rows[0].status = '运行中';
  await assert.rejects(startSimulationInstance(browser, id, 'Task002'), /实例 2.*占用/);
  assert.deepEqual(started, []);
  rows[0].status = '结束';
  startError = { code: 400, msg: 'error', data: { key: 'simulation_operation_failed', args: ['测试站点拒绝开启'] } };
  await assert.rejects(startSimulationInstance(browser, id, 'Task002'), /开启实例 9失败.*测试站点拒绝开启.*业务码 400.*回读状态为「创建」/);
  assert.deepEqual(started, [9]);
  startError = undefined;
  await startSimulationInstance(browser, id, 'Task002');
  outgoingResponsePending = true;
  await verifySimulationRunning(browser, id, 'Task002');
  await verifySimulationApr(browser, id, 'Task002', 3);
  await assert.rejects(verifySimulationApr(browser, id, 'Task002', 4), /回读数量为 3，期望 4/);
  assert.equal(outgoingResponsePending, false);
  assert.deepEqual(started, [9, 9]);

  // Even on another map, a matching name on the second page prevents creation.
  rows[2].map = '另一张地图';
  await assert.rejects(createSimulationInstance(browser, 'Task002'), /重名告警：.*9（地图「另一张地图」，运行中）/);
  rows[0].name = 'Task002';
  rows[2].status = '创建';
  await assert.rejects(createSimulationInstance(browser, 'Task002'), /重名告警：.*2（地图「Task002」，结束）.*9（地图「另一张地图」，创建）/);
  assert.equal(rows.length, 3);
  assert.deepEqual(started, [9, 9]);
});
