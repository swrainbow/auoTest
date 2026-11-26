import type { Browser } from '@e2e-dev/web';

// The runner tracks both calls. An early UI failure must not leave a pending
// response wait behind or replace the error from the action which triggered it.
export async function observeMapResponse<T>(browser: Browser, endpoint: RegExp, action: () => Promise<T>) {
  const [response, result] = await Promise.allSettled([
    browser.waitForResponse(endpoint, { timeout: 30_000 }), action(),
  ]);
  if (result.status === 'rejected') throw result.reason;
  if (response.status === 'rejected') throw response.reason;
  return [response.value, result.value] as const;
}

export async function waitForMapIdle(browser: Browser, frame: string) {
  await browser.frameLocator(frame).locator('.root-container > .el-loading-mask').waitFor({ state: 'hidden', timeout: 60_000 });
}

async function selectMap(browser: Browser, frame: string, mapName: string, floor: number, existingOnly: boolean) {
  const editor = browser.frameLocator(frame);
  // Startup publishes the default map ID before painting its points. Switching
  // during that load lets the default response populate the target's canvas.
  const switcher = editor.locator('.show-circle-btn[role="button"][aria-haspopup="menu"][tkmapid]:not([tkmapid=""])');
  await switcher.waitFor({ timeout: 60_000 });
  await waitForMapIdle(browser, frame);
  if (await switcher.getAttribute('aria-expanded') !== 'true') await switcher.press('ArrowDown');
  const menu = editor.locator('.map-dropdown-menu[role="menu"]');
  // The disabled current row is rendered from the loaded list. The add action can appear earlier.
  await menu.getByRole('menuitem', { disabled: true }).waitFor();
  const item = menu.getByRole('menuitem', { name: mapName, exact: true });
  if (existingOnly) {
    try {
      await item.first().waitFor();
    } catch (error) {
      throw new Error('持久化回读失败：未等到完整名称为「' + mapName + '」的地图选项', { cause: error });
    }
  }
  const matches = await item.count();
  if (matches > 1) throw new Error(`地图列表中有多个完整名称为「${mapName}」的条目`);
  if (matches === 1) {
    if (await item.isDisabled()) {
      const previous = (await switcher.textContent())?.trim();
      if (previous !== mapName) throw new Error(`地图「${mapName}」不可选，当前地图为「${previous}」`);
      // ArrowDown on the trigger toggles this Element Plus dropdown.
      await switcher.press('ArrowDown');
    } else {
      // Element Plus supports Enter on the exact menu item. Moving the pointer
      // to a lower row can dismiss the hover menu before a click lands.
      await item.press('Enter');
    }
  } else {
    if (existingOnly) throw new Error(`持久化回读失败：地图列表中找不到「${mapName}」`);
    await menu.getByRole('menuitem', { name: '添加地图', exact: true }).press('Enter');
    const dialog = editor.getByRole('dialog', { name: '添加地图', exact: true });
    await dialog.waitFor();
    await dialog.getByPlaceholder('请输入名称', { exact: true }).fill(mapName);
    await dialog.getByPlaceholder('请输入楼层', { exact: true }).fill(String(floor));
    await dialog.getByRole('button', { name: '确定', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
  }
  await menu.waitFor({ state: 'hidden' });
  await editor.getByRole('button', { name: mapName, exact: true }).waitFor();
  await waitForMapIdle(browser, frame);
  if ((await switcher.textContent())?.trim() !== mapName) {
    throw new Error(`地图选择器未显示目标地图「${mapName}」`);
  }
  return switcher;
}

/** Select the exact map in the editor and optionally record its persisted floor in the run log. */
export async function ensureMap(browser: Browser, frame: string, mapName: string, floor = 1, existingOnly = false, recordFloor = false): Promise<void> {
  const switcher = await selectMap(browser, frame, mapName, floor, existingOnly);
  if (recordFloor) {
    const id = await switcher.getAttribute('tkmapid');
    if (!id || !/^[1-9]\d*$/.test(id)) throw new Error(`地图「${mapName}」尚无有效的地图 ID`);
    // Subscribe before reopening. Reload can select the site's default map before our target.
    const [response, selected] = await observeMapResponse(browser,
      new RegExp('/tkmap/map/getById/' + id + '/?(?:[?#]|$)'), async () => {
        await browser.reload();
        return selectMap(browser, frame, mapName, floor, true);
      });
    if (response.status !== 200) throw new Error(`地图「${mapName}」楼层回读返回 HTTP ${response.status}`);
    const body = await response.json<{ code: number | string; data?: { id: number | string; mapName: string; floor: number } }>();
    const map = body?.data;
    if (Number(body?.code) !== 200 || !map || String(map.id) !== id || map.mapName !== mapName ||
      !Number.isSafeInteger(map.floor) || await selected.getAttribute('tkmapid') !== id) {
      throw new Error(`无法从地图「${mapName}」的详情核实地图 ID ${id} 和实际楼层`);
    }
    console.log(`地图「${mapName}」（ID ${id}）实际楼层为 ${map.floor}`);
  }
  // This last check also marks the end of the conditional operation in the e2e report.
  await browser.waitForURL(/\/tkmap\/mapDraw\/?(?:[?#]|$)/);
}
