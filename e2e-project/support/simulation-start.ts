import { setTimeout as delay } from 'node:timers/promises';
import type { Browser } from '@e2e-dev/web';

type Instance = { id: string; name: string; map: string; status: string; selected: boolean };
type InstanceData = { id: number; deviceData?: { devType: string; devNum: number | null }[] };
type PageData = { content: InstanceData[]; number: number; totalElements: number; totalPages: number };

const listUrl = /\/sims\/instances\/data\/?(?:[?#]|$)/;
const pageUrl = /\/task\/simConfig\/?(?:[?#]|$)/;
const table = '.el-table:visible:has(.el-table__header th :text-is("实例名称"))';
const tableRows = table + ' .el-table__body tbody tr';
const aprTable = '.el-drawer:visible .el-table:has(th :text-is("物理属性")):has(th :text-is("APR")):has(th :text-is("数量"))';
const body = (browser: Browser) => browser.locator('body');

// Read the table the UI requested. Match its IDs to the rendered page before using
// labels or checkboxes. During loading Element Plus also displays an empty table.
async function loadPage(browser: Browser, trigger: () => Promise<void>) {
  const [response] = await Promise.all([browser.waitForResponse(listUrl, { timeout: 20000 }), trigger()]);
  const page = await response.json<PageData>();
  if (response.status !== 200 || !Array.isArray(page?.content) || !Number.isSafeInteger(page.totalElements)
      || !Number.isSafeInteger(page.totalPages) || !Number.isSafeInteger(page.number)) {
    throw new Error('仿真实例分页读取失败');
  }
  await browser.locator(table).waitFor();
  const ids = page.content.map(({ id }) => String(id));
  const deadline = Date.now() + 10000;
  do {
    const rendered = await browser.evaluate(() => {
      const text = (el?: HTMLElement) => el?.innerText.trim() ?? '';
      const tables = [...document.querySelectorAll<HTMLElement>('.el-table')].filter(t =>
        t.getClientRects().length && [...t.querySelectorAll<HTMLElement>('.el-table__header th')].some(h => text(h) === '实例名称'));
      if (tables.length !== 1) throw new Error('无法确定仿真实例列表');
      const headers = [...tables[0].querySelectorAll<HTMLElement>('.el-table__header th')].map(text);
      const columns = ['编号', '实例名称', '绑定地图', '状态'].map(label => headers.indexOf(label));
      if (columns.includes(-1)) throw new Error('仿真实例列表缺少编号、实例名称、绑定地图或状态');
      const rows = [...tables[0].querySelectorAll<HTMLTableRowElement>('.el-table__body tbody tr')].map(row => {
        const [id, name, map, status] = columns.map(n => text(row.cells[n]));
        return { id, name, map, status, selected: !!row.querySelector('input[type=checkbox]:checked') };
      });
      return { rows, idColumn: columns[0] + 1 };
    });
    if (rendered.rows.length === ids.length && rendered.rows.every((r, i) =>
      r.id === ids[i] && r.map && r.map !== '--' && r.status)) return { ...rendered, page };
    await delay(150);
  } while (Date.now() < deadline);
  throw new Error('仿真实例表格尚未显示与分页响应一致的编号和地图');
}

async function loadFirstPage(browser: Browser) {
  const listPage = await browser.url();
  if (pageUrl.test(listPage)) {
    // Saving or starting also refreshes the outgoing document's table. Leave
    // that document before subscribing so only the fresh page can satisfy the wait.
    await browser.goto('about:blank');
    return loadPage(browser, () => browser.goto(listPage));
  }
  const menu = body(browser).getByRole('menuitem', { name: '任务', exact: true });
  const entry = body(browser).getByRole('link', { name: '仿真配置', exact: true });
  if (!await entry.isVisible()) await menu.click();
  return loadPage(browser, () => entry.click());
}

// Each scan starts with a fresh unfiltered list and selection. A short scan
// leaves the matching row on screen. Full scans cover duplicates and conflicts.
async function* instancePages(browser: Browser) {
  let current = await loadFirstPage(browser);
  const total = current.page.totalElements;
  const seen = new Set<string>();
  for (let index = 0; ; index++) {
    if (current.page.number !== index || current.page.totalElements !== total) throw new Error('仿真实例列表在分页期间发生变化');
    for (const { id } of current.rows) {
      if (seen.has(id)) throw new Error('仿真实例列表出现重复编号 ' + id);
      seen.add(id);
    }
    yield current;
    if (index + 1 >= current.page.totalPages) break;
    current = await loadPage(browser, () => browser.locator('.el-pagination:visible .btn-next').click());
  }
  if (seen.size !== total) throw new Error('仿真实例分页未覆盖全部记录');
}

async function allInstances(browser: Browser) {
  const rows: Instance[] = [];
  for await (const page of instancePages(browser)) rows.push(...page.rows);
  return rows;
}

async function submit(browser: Browser, endpoint: RegExp, click: () => Promise<void>, operation: string) {
  const [response] = await Promise.all([browser.waitForResponse(endpoint, { timeout: 20000 }), click()]);
  const result = await response.json<{
    code?: number | string; msg?: string; message?: string; data?: { key?: string; args?: unknown[] };
  }>();
  if (response.status !== 200 || Number(result.code) !== 200) {
    const alarm = result.data;
    const args = Array.isArray(alarm?.args) ? alarm.args.filter((arg): arg is string => typeof arg === 'string' && !!arg.trim()) : [];
    const details = [result.msg, result.message, alarm?.key, ...args].filter(Boolean);
    throw new SimulationRequestError(operation + '失败：' + [...new Set(details)].join(' · ') +
      '（HTTP ' + response.status + '，业务码 ' + (result.code ?? '缺失') + '）');
  }
}

class SimulationRequestError extends Error {}

async function targetRow(browser: Browser, id: string, mapName: string) {
  for await (const { rows, idColumn, page } of instancePages(browser)) {
    const index = rows.findIndex(row => row.id === id);
    if (index < 0) continue;
    const instance = rows[index]!;
    if (instance.map !== mapName || instance.name !== mapName) throw new Error('编号 ' + id + ' 的实例名称或绑定地图与 ' + mapName + ' 不符');
    const cell = 'td:nth-child(' + idColumn + ')';
    const exact = ':text-is(' + JSON.stringify(id) + ')';
    const selector = tableRows + ':has(> ' + cell + exact + ', > ' + cell + ' ' + exact + ')';
    const row = browser.locator(selector);
    await row.waitFor();
    return { row, selector, instance, deviceData: page.content[index]!.deviceData };
  }
  throw new Error('找不到仿真实例编号 ' + id);
}

export async function createSimulationInstance(browser: Browser, mapName: string): Promise<string> {
  const existing = await allInstances(browser);
  const matches = existing.filter(row => row.name === mapName);
  if (matches.length) {
    const details = matches.map(row => row.id + '（地图「' + row.map + '」，' + row.status + '）').join('、');
    throw new Error('仿真实例重名告警：名称「' + mapName + '」已存在，实例 ' + details + '。已跳过新增及后续步骤。');
  }
  const before = new Set(existing.map(row => row.id));
  await body(browser).getByRole('button', { name: '添加', exact: true }).click();
  const dialog = body(browser).getByRole('dialog', { name: '添加仿真实例', exact: true });
  const mapSelect = browser.locator('[role="dialog"]:visible .tk-form-dynamic-item:has(:text-is("绑定地图")) .el-select');
  await mapSelect.click();
  const popup = await mapSelect.getByRole('combobox').getAttribute('aria-controls');
  if (!popup) throw new Error('绑定地图缺少选项列表');
  await browser.locator('[id=' + JSON.stringify(popup) + ']').getByRole('option', { name: mapName, exact: true }).click();
  await mapSelect.getByText(mapName, { exact: true }).waitFor();
  await dialog.getByPlaceholder('请输入实例名称', { exact: true }).fill(mapName);
  await submit(browser, /\/sims\/instances\/?(?:[?#]|$)/,
    () => dialog.getByRole('button', { name: '确定', exact: true }).click(), '创建仿真实例');
  await dialog.waitFor({ state: 'hidden' });
  const added = (await allInstances(browser)).filter(row => !before.has(row.id) && row.name === mapName && row.map === mapName);
  if (added.length !== 1) throw new Error('保存后按编号差集找到 ' + added.length + ' 个「' + mapName + '」同名同图新增实例');
  return added[0].id;
}

export async function verifySimulationCreated(browser: Browser, id: string, mapName: string) {
  const { instance } = await targetRow(browser, id, mapName);
  if (instance.status === '运行中') throw new Error('新建实例 ' + id + ' 已在运行');
}

async function openApr(browser: Browser, { row }: Awaited<ReturnType<typeof targetRow>>) {
  await row.getByRole('button', { name: '设备配置', exact: true }).click();
  const drawer = body(browser).getByRole('dialog', { name: '设备配置', exact: true });
  await drawer.waitFor();
  // The drawer also contains a charger table and its pagination has numeric inputs.
  await browser.locator(aprTable).waitFor();
  const headers = (await browser.locator(aprTable + ' .el-table__header th').allTextContents()).map(text => text.trim());
  const apr = 'td:nth-child(' + (headers.indexOf('APR') + 1) + ')';
  const rows = aprTable + ' .el-table__body tbody tr:has(> ' + apr + ':text-is("APR"), > ' + apr + ' :text-is("APR"))';
  const quantity = browser.locator(rows + ' > td:nth-child(' + (headers.indexOf('数量') + 1) + ')').getByRole('spinbutton');
  await quantity.waitFor();
  return { drawer, quantity };
}

export async function configureSimulationApr(browser: Browser, id: string, mapName: string, count: number) {
  const { drawer, quantity } = await openApr(browser, await targetRow(browser, id, mapName));
  const value = await quantity.inputValue();
  if (!/^\d+$/.test(value) || Number(value) > count) throw new Error('APR 当前数量为 ' + value + '，无法通过增加数量设置为 ' + count);
  if (Number(value) < count) {
    await quantity.fill(String(count));
    await quantity.press('Tab');
    if (await quantity.inputValue() !== String(count)) throw new Error('设备配置未接受 APR 数量 ' + count);
  }
  await submit(browser, new RegExp('/sims/instances/' + id + '/?(?:[?#]|$)'),
    () => drawer.getByRole('button', { name: '确定', exact: true }).click(), '保存实例 ' + id + ' 的 APR 配置');
  await drawer.waitFor({ state: 'hidden' });
}

export async function verifySimulationApr(browser: Browser, id: string, mapName: string, count: number) {
  const target = await targetRow(browser, id, mapName);
  if (target.instance.status === '运行中') {
    // Running instances expose device management. The same fresh list response
    // contains the persisted APR configuration for the ID matched against the UI.
    const apr = target.deviceData?.filter(device => device.devType === 'APR');
    if (apr?.length !== 1) throw new Error('运行中实例 ' + id + ' 的分页详情缺少唯一的 APR 配置行');
    if (apr[0]!.devNum !== count) throw new Error('实例 ' + id + ' APR 配置回读数量为 ' + apr[0]!.devNum + '，期望 ' + count);
    return;
  }
  const { drawer, quantity } = await openApr(browser, target);
  const value = await quantity.inputValue();
  if (value !== String(count)) throw new Error('实例 ' + id + ' APR 配置回读数量为 ' + value + '，期望 ' + count);
  await drawer.getByRole('button', { name: '取消', exact: true }).click();
  await drawer.waitFor({ state: 'hidden' });
}

export async function startSimulationInstance(browser: Browser, id: string, mapName: string) {
  const rows = await allInstances(browser);
  const conflict = rows.find(r => r.map === mapName && r.id !== id && r.status === '运行中');
  if (conflict) throw new Error('地图「' + mapName + '」已由实例 ' + conflict.id + '「' + conflict.name + '」占用，已停止开启');
  if (rows.some(r => r.selected && r.id !== id)) throw new Error('列表中另有已勾选实例，已停止开启');
  const { row, selector, instance } = await targetRow(browser, id, mapName);
  if (instance.status === '运行中') return;
  // Element Plus hides the native checkbox and gives its label the hit target.
  if (!await row.getByRole('checkbox').isChecked()) await browser.locator(selector + ' label.el-checkbox').click();
  if (await browser.locator(tableRows + ' input[type="checkbox"]:checked').count() !== 1 || !await row.getByRole('checkbox').isChecked()) {
    throw new Error('勾选的实例与目标编号不符，已停止开启');
  }
  const start = body(browser).getByRole('button', { name: '开启', exact: true });
  if (await start.isDisabled()) throw new Error('仿真实例 ' + id + ' 的开启按钮不可用');
  try {
    await submit(browser, /\/sims\/instances\/(?:\d+\/)?action\/?(?:[?#]|$)/, () => start.click(), '开启实例 ' + id);
  } catch (error) {
    if (!(error instanceof SimulationRequestError)) throw error;
    // The backend may have changed state since selection. Read it once before
    // reporting the refusal, without submitting the action a second time.
    const latest = await allInstances(browser).catch(() => undefined);
    const target = latest?.find(r => r.id === id && r.name === mapName && r.map === mapName);
    const owner = latest?.find(r => r.id !== id && r.map === mapName && r.status === '运行中');
    const state = target ? '实例 ' + id + ' 回读状态为「' + target.status + '」'
      : latest ? '刷新后找不到目标实例 ' + id : '目标实例状态回读失败';
    throw new Error(error.message + '。' + state + (owner ? '，地图正由实例 ' + owner.id + '「' + owner.name + '」占用' : ''));
  }
}

export async function verifySimulationRunning(browser: Browser, id: string, mapName: string) {
  const deadline = Date.now() + 20000;
  let status: string;
  do {
    const { instance } = await targetRow(browser, id, mapName);
    status = instance.status;
    if (status === '运行中') return;
    await delay(500);
  } while (Date.now() < deadline);
  throw new Error('仿真实例 ' + id + ' 刷新回读状态为「' + status + '」，期望「运行中」');
}
