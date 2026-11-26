import type { ServiceRow } from './service-map-preparation.ts';
import { setTimeout as delay } from 'node:timers/promises';
import type { Browser } from '@e2e-dev/web';
import { expect, type Credential, type Locator, type Screen } from 'e2e';

interface Context {
  browser: Browser;
  screen: Screen;
  open: (path: string) => Promise<void>;
  credentials: () => Credential;
}

const serviceUrl = /\/config\/tuskService\/?(?:[?#]|$)/;
const synchronized = '同步成功';
const syncTimeoutMs = 120_000;
const syncPollMs = 2_000;
const table = '.el-table:visible:has(.el-table__header th :text-is("同步状态"), .el-table__header th:text-is("同步状态"))';
const bodyRows = `${table} .el-table__body tbody tr`;
const editDialog = ':is([role="dialog"][aria-label="修改服务"], [role="dialog"]:has(.el-dialog__title:text-is("修改服务"))):visible';
const mapField = `${editDialog} :is(.el-form-item, .tk-form-dynamic-item):has(:text-matches("^地图(?:项目)?\\\\s*\\\\*?$")) .el-select`;

async function openServicePage({ browser, screen, open, credentials }: Context): Promise<void> {
  await open('/index');
  const menu = screen.getByRole('menuitem', { name: '配置', exact: true });
  const username = screen.getByPlaceholder('账号', { exact: true });
  if (new URL(await browser.url()).pathname === '/login' || await username.isVisible()) {
    let account: Credential;
    try {
      account = credentials();
    } catch {
      throw new Error('请在平台设置中填写目标测试站点的登录账号和密码');
    }
    await username.fill(account.username);
    await screen.getByPlaceholder('密码', { exact: true }).fill(account.password);
    await screen.getByRole('button', { name: /^登\s*录$/ }).click();
  }
  const entry = screen.getByRole('link', { name: '服务管理', exact: true });
  await expect(menu).toBeVisible({ timeout: 15000 });
  if (!await entry.isVisible()) await menu.click();
  await entry.click();
  await waitForServiceList(browser);
}

async function waitForServiceList(browser: Browser): Promise<void> {
  await expect(browser).toHaveURL(serviceUrl);
  await expect(browser.locator(table)).toHaveCount(1);
  await expect(browser.locator(bodyRows).first()).toBeVisible({ timeout: 15000 });
}

async function readServices(browser: Browser) {
  const snapshot = await browser.evaluate(() => {
    const text = (element?: HTMLElement | null) => (element?.innerText ?? '').trim();
    const roots = Array.from(document.querySelectorAll<HTMLElement>('.el-table')).filter((element) =>
      element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden' &&
      Array.from(element.querySelectorAll<HTMLElement>('.el-table__header th')).some((cell) => text(cell) === '同步状态'));
    const root = roots.length === 1 ? roots[0] : undefined;
    const headers = Array.from(root?.querySelectorAll<HTMLElement>('.el-table__header th') ?? [], text);
    const rows = Array.from(root?.querySelectorAll<HTMLTableRowElement>('.el-table__body tbody tr') ?? [], (row) => {
      const maps = row.cells[headers.indexOf('地图')];
      const tags = Array.from(maps?.querySelectorAll<HTMLElement>('.el-tag__content') ?? [], text);
      return {
        id: text(row.cells[headers.indexOf('编号')]),
        name: text(row.cells[headers.indexOf('名称')]),
        type: text(row.cells[headers.indexOf('类型')]),
        status: text(row.cells[headers.indexOf('同步状态')]),
        maps: (tags.length ? tags : text(maps).split(/[,，、\n]+/)).map((item) => item.trim())
          .filter((item) => item && item !== '--' && item !== '—'),
      };
    });
    return { headers, rows };
  });
  const nameColumn = snapshot.headers.indexOf('名称') + 1;
  const operationColumn = snapshot.headers.indexOf('操作') + 1;
  if (!nameColumn || !operationColumn || !snapshot.headers.includes('地图')) {
    throw new Error('服务管理列表缺少名称、操作或地图列');
  }
  if (!snapshot.rows.length || snapshot.rows.some((row) => !row.name) ||
      new Set(snapshot.rows.map((row) => row.name)).size !== snapshot.rows.length) {
    throw new Error('服务管理列表没有可按名称唯一定位的服务条目');
  }
  return { rows: snapshot.rows, nameColumn, operationColumn };
}

async function findService(browser: Browser, name: string) {
  const { rows, nameColumn, operationColumn } = await readServices(browser);
  const row = rows.find((item) => item.name === name);
  if (!row) throw new Error(`服务「${name}」已不在列表中`);
  const nameCell = `td:nth-child(${nameColumn})`;
  const exactName = `:text-is(${JSON.stringify(name)})`;
  const actions = browser.locator(`${bodyRows}:has(> ${nameCell}${exactName}, > ${nameCell} ${exactName}) > td:nth-child(${operationColumn})`);
  return { row, actions };
}

async function clickServiceAction(browser: Browser, actions: Locator, name: '修改' | '同步') {
  // Lothar shows this persistent reminder over the action column on page entry.
  const warning = '.el-notification[role="alert"]:has-text("Lothar使用有效期只剩")';
  const notice = browser.locator(warning);
  if (await notice.isVisible()) {
    await browser.locator(`${warning} .el-notification__closeBtn`).click();
    await expect(notice).toBeHidden();
  }
  await actions.getByRole('button', { name, exact: true }).click();
}

export function getPaladin(rows: ServiceRow[], mapName: string, serviceName?: string): ServiceRow {
  const paladins = rows.filter(({ name }) => name.toLowerCase().startsWith('paladin'));
  if (serviceName) {
    const row = paladins.find(({ name }) => name === serviceName);
    if (!row) throw new Error(`服务列表中找不到指定的 Paladin 服务「${serviceName}」`);
    return row;
  }
  if (paladins.length === 1) return paladins[0]!;
  if (!paladins.length) throw new Error('服务列表中没有名称以 paladin 开头的条目');
  const bound = paladins.filter(({ maps }) => maps.includes(mapName));
  if (bound.length === 1) return bound[0]!;
  throw new Error(`无法确定地图「${mapName}」对应的 Paladin 服务，请在用例中填写完整服务名称（${paladins.map(({ name }) => name).join('、')}）`);
}

type ServicePage = Pick<Context, 'browser' | 'screen'>;

function selectRattletrap(rows: Awaited<ReturnType<typeof readServices>>['rows'], name?: string) {
  const candidates = rows.filter(row => row.type
    ? row.type.toLowerCase() === 'rattletrap' : row.name.toLowerCase().startsWith('rattletrap'));
  if (name) {
    const target = candidates.find(row => row.name === name);
    if (!target) throw new Error(`服务列表中找不到指定的 Rattletrap 服务「${name}」`);
    return target.name;
  }
  if (candidates.length === 1) return candidates[0]!.name;
  if (!candidates.length) throw new Error('服务列表中找不到 Rattletrap 服务');
  throw new Error(`请指定 Rattletrap 服务全名，候选有：${candidates.map(row => row.name).join('、')}`);
}

async function reloadServices(browser: Browser) {
  await browser.reload();
  await waitForServiceList(browser);
}

type SyncState = {
  id: number;
  name: string;
  syncTime: number | null;
  syncStatus: string;
  syncResult?: Array<{ name?: string; code?: number; msg?: string }>;
};

async function serviceResponse(browser: Browser, endpoint: RegExp, trigger: () => Promise<void>, timeout: number) {
  const [response, action] = await Promise.allSettled([browser.waitForResponse(endpoint, { timeout }), trigger()]);
  if (action.status === 'rejected') throw action.reason;
  if (response.status === 'rejected') throw response.reason;
  return response.value;
}

async function freshSyncState(browser: Browser, id: string, name: string, timeout = 15_000) {
  // The page requests the authenticated service list on entry. Leave the old
  // document before listening so its background requests cannot satisfy this read.
  const url = await browser.url();
  await browser.goto('about:blank');
  const response = await serviceResponse(browser, /\/basic\/tuskService\/?(?:[?#]|$)/, () => browser.goto(url), timeout);
  if (response.status !== 200) throw new Error(`读取服务列表返回 HTTP ${response.status}`);
  const body = await response.json<{ code?: number | string; data?: SyncState[] }>();
  if (Number(body?.code) !== 200 || !Array.isArray(body.data)) throw new Error('读取服务列表失败');
  const row = body.data.find(row => String(row.id) === id && row.name === name);
  if (!row || !row.syncStatus || !(row.syncTime === null || Number.isFinite(row.syncTime))) {
    throw new Error(`服务列表中缺少「${name}」编号 ${id} 的同步状态或同步时间`);
  }
  await waitForServiceList(browser);
  return row;
}

const syncStatusNames: Record<string, string> = {
  syncing: '同步中', sync_success: '同步成功', sync_fail: '同步失败', not_sync: '未同步',
};

async function waitForSync(browser: Browser, initial: SyncState, requireNewTime: boolean) {
  const deadline = Date.now() + syncTimeoutMs;
  let last = initial;
  while (Date.now() < deadline) {
    last = await freshSyncState(browser, String(initial.id), initial.name, Math.max(1, Math.min(15_000, deadline - Date.now())));
    // syncInfo changes syncTime when accepting work. An earlier green status
    // (or an earlier failure) must not settle the request we just submitted.
    const current = !requireNewTime || (last.syncTime !== null && last.syncTime > (initial.syncTime ?? 0));
    if (current && last.syncStatus === 'sync_success') return last;
    if (current && last.syncStatus === 'sync_fail') {
      const modules = last.syncResult?.filter(m => m.code != null && m.code !== 0 && m.code !== 200)
        .map(m => [m.name, m.msg].filter(Boolean).join(' ')).filter(Boolean) ?? [];
      throw new Error('同步失败' + (modules.length ? '：' + modules.join('、') : ''));
    }
    await delay(Math.max(0, Math.min(syncPollMs, deadline - Date.now())));
  }
  throw new Error(`等待同步结果超过 ${syncTimeoutMs / 1000} 秒，最后状态「${syncStatusNames[last.syncStatus] ?? last.syncStatus}」，同步时间 ${last.syncTime ?? '空'}`);
}

type SyncMode = 'if-needed' | 'explicit' | 'after-binding';

async function syncService({ browser, screen }: ServicePage, name: string, attempts: Map<string, number>, mode: SyncMode) {
  const { row, actions } = await findService(browser, name);
  if (mode === 'if-needed' && row.status === synchronized) return;
  try {
    if (!/^\d+$/.test(row.id)) throw new Error('无法读取服务编号');
    let initial = await freshSyncState(browser, row.id, name);
    if (initial.syncStatus === 'syncing') {
      console.info(`等待服务「${name}」正在执行的同步`);
      initial = await waitForSync(browser, initial, false);
      // A job accepted before the binding changed may have captured the old maps.
      if (mode !== 'after-binding') return;
    }
    if (mode === 'if-needed' && initial.syncStatus === 'sync_success') return;
    const dialog = screen.getByRole('dialog', { name: '警告', exact: true })
      .or(screen.getByRole('alertdialog', { name: '警告', exact: true }));
    const attempt = (attempts.get(name) ?? 0) + 1;
    console.info(`同步服务「${name}」第 ${attempt} 次`);
    await clickServiceAction(browser, actions, '同步');
    attempts.set(name, attempt);
    const response = await serviceResponse(browser, new RegExp('/basic/tuskService/' + row.id + '/syncInfo/?(?:[?#]|$)'),
      () => dialog.getByRole('button', { name: '确定', exact: true }).click(), 30_000);
    const result = await response.json<{ code?: number | string; msg?: string; message?: string; data?: { key?: string; args?: unknown[] } }>()
      .catch(() => undefined);
    if (response.status !== 200 || Number(result?.code) !== 200) {
      const args = Array.isArray(result?.data?.args) ? result.data.args.filter(arg => typeof arg === 'string') : [];
      const reason = [result?.msg, result?.message, result?.data?.key, ...args].filter(Boolean).join(' · ');
      throw new Error(`同步请求失败（HTTP ${response.status}，业务码 ${result?.code ?? '未知'}）${reason}`);
    }
    await waitForSync(browser, initial, true);
  } catch (error) {
    throw new Error(`服务「${name}」：${message(error)}`);
  }
}

async function syncServices(ctx: ServicePage, attempts: Map<string, number>): Promise<void> {
  for (const { name } of (await readServices(ctx.browser)).rows) {
    await syncService(ctx, name, attempts, 'if-needed');
  }
}

async function bindMap({ browser, screen }: Pick<Context, 'browser' | 'screen'>, name: string, mapName: string): Promise<boolean> {
  const { row, actions } = await findService(browser, name);
  if (row.maps.includes(mapName)) return false;
  console.info(`前置检查 · 给「${name}」添加地图「${mapName}」`);
  try {
    await clickServiceAction(browser, actions, '修改');
    const dialog = screen.getByRole('dialog', { name: '修改服务', exact: true });
    await expect(dialog).toBeVisible();
    const combo = browser.locator(`${mapField} input[role="combobox"]`);
    // Clicking the middle of a multi-select can remove the tag under the pointer.
    if (await combo.getAttribute('aria-expanded') !== 'true') await combo.press('ArrowDown');
    await expect(combo).toHaveAttribute('aria-expanded', 'true');
    const popupId = await combo.getAttribute('aria-controls');
    if (!popupId) throw new Error('地图项目下拉框缺少选项列表');
    const popup = browser.locator(`[id=${JSON.stringify(popupId)}]`);
    await expect(popup).toBeVisible();
    const choice = popup.getByRole('option', { name: mapName, exact: true });
    await expect(choice).toBeVisible();
    if (await choice.getAttribute('aria-selected') !== 'true') await choice.click();
    if (await combo.getAttribute('aria-expanded') !== 'true') {
      await combo.press('ArrowDown');
      await expect(combo).toHaveAttribute('aria-expanded', 'true');
      await expect(popup).toBeVisible();
    }
    for (const selected of [...row.maps, mapName]) {
      const option = popup.getByRole('option', { name: selected, exact: true });
      await expect(option).toHaveAttribute('aria-selected', 'true');
    }
    await combo.press('Escape');
    await expect(combo).toHaveAttribute('aria-expanded', 'false');
    await expect(popup).toBeHidden();
    await dialog.getByRole('button', { name: '确定', exact: true }).click();
    await expect(dialog).toBeHidden();
    const deadline = Date.now() + 10000;
    do {
      const { row: saved } = await findService(browser, name);
      if ([...row.maps, mapName].every((map) => saved.maps.includes(map))) return true;
      await delay(300);
    } while (Date.now() < deadline);
    throw new Error('保存后服务列表未显示目标地图和原有地图');
  } catch (error) {
    throw new Error(`服务「${name}」绑定地图「${mapName}」失败：${message(error)}`);
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function confirmMaps(row: ServiceRow, expectedMaps: string[]) {
  for (const name of expectedMaps) {
    if (!row.maps.includes(name)) throw new Error(`服务「${row.name}」回读缺少地图「${name}」`);
  }
}

async function syncBindingPair(ctx: ServicePage, paladin: string, rattletrap: string, maps: string[], attempts: Map<string, number>, mode: 'explicit' | 'after-binding') {
  const failures: string[] = [];
  for (const name of [paladin, rattletrap]) {
    try {
      // If the first action left a modal or a stale view, start the next action on the list.
      if (failures.length) await reloadServices(ctx.browser);
      await syncService(ctx, name, attempts, mode);
    } catch (error) {
      failures.push(message(error));
    }
  }
  if (failures.length) throw new Error(failures.join('\n'));
  const { rows } = await readServices(ctx.browser);
  for (const name of [paladin, rattletrap]) {
    const row = rows.find(row => row.name === name);
    if (row?.status !== synchronized) throw new Error(`服务「${name}」同步后回读状态为「${row?.status || '缺失'}」`);
    if (name === paladin) confirmMaps(row, maps);
  }
}

/** Explicitly sync both services for a map whose binding has already been saved. */
export async function syncBoundMapServices(browser: Browser, screen: Screen, mapName: string, serviceName?: string, rattletrapName?: string) {
  await waitForServiceList(browser);
  const { rows } = await readServices(browser);
  const paladin = getPaladin(rows, mapName, serviceName);
  confirmMaps(paladin, [mapName]);
  await syncBindingPair({ browser, screen }, paladin.name, selectRattletrap(rows, rattletrapName), paladin.maps, new Map(), 'explicit');
}

async function bindAndVerify(ctx: ServicePage, mapName: string, serviceName?: string, rattletrapName?: string, attempts = new Map<string, number>(), syncExisting = false) {
  const { browser } = ctx;
  await waitForServiceList(browser);
  const { rows } = await readServices(browser);
  const target = getPaladin(rows, mapName, serviceName);
  // Resolve the companion before editing. A verified existing binding needs no write.
  const missing = !target.maps.includes(mapName);
  const companion = missing || syncExisting ? selectRattletrap(rows, rattletrapName) : undefined;
  const wrote = missing && await bindMap(ctx, target.name, mapName);
  const maps = [...new Set([...target.maps, mapName])];
  await reloadServices(browser);
  confirmMaps((await findService(browser, target.name)).row, maps);
  if ((wrote || syncExisting) && companion !== undefined) {
    await syncBindingPair(ctx, target.name, companion, maps, attempts, wrote ? 'after-binding' : 'explicit');
  }
  return wrote;
}

/** Bind in the current session and sync Paladin and Rattletrap after a new binding. */
export async function bindPaladinMap(browser: Browser, screen: Screen, mapName: string, serviceName?: string, rattletrapName?: string, syncExisting = false) {
  await bindAndVerify({ browser, screen }, mapName, serviceName, rattletrapName, undefined, syncExisting);
}

export async function runTuskServicePreflight(ctx: Context, { mapName, serviceName, rattletrapName }: {
  mapName: string;
  serviceName?: string;
  rattletrapName?: string;
}): Promise<void> {
  try {
    await openServicePage(ctx);
    const attempts = new Map<string, number>();
    await syncServices(ctx, attempts);
    const target = getPaladin((await readServices(ctx.browser)).rows, mapName, serviceName);
    await bindAndVerify(ctx, mapName, target.name, rattletrapName, attempts);
    await syncServices(ctx, attempts);
    const final = await readServices(ctx.browser);
    const unsynced = final.rows.filter(({ status }) => status !== synchronized);
    if (unsynced.length) {
      throw new Error(`仍有服务未同步成功：${unsynced.map(({ name, status }) => `${name}（${status || '空'}）`).join('、')}`);
    }
    if (!final.rows.find(({ name }) => name === target.name)?.maps.includes(mapName)) {
      throw new Error(`服务「${target.name}」未显示已绑定的地图「${mapName}」`);
    }
    console.info(`前置检查通过 · 所有服务已同步，${target.name} 已绑定地图「${mapName}」`);
  } catch (error) {
    throw new Error(`用例前置条件失败：${message(error)}`);
  }
}

export function servicePreparationActions(ctx: Context) {
  return {
    open: () => openServicePage(ctx),
    select: getPaladin,
    read: async () => (await readServices(ctx.browser)).rows,
    sync: (attempts: Map<string, number>) => syncServices(ctx, attempts),
    bind: (name: string, mapName: string, attempts?: Map<string, number>) => bindAndVerify(ctx, mapName, name, undefined, attempts),
  };
}
