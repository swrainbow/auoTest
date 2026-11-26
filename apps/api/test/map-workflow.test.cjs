const assert = require('node:assert/strict');
const { test } = require('node:test');
const { compileWorkflow, usesTargetLogin, validateWorkflow } = require('../src/planner/workflow');
const { isCountLocatorRepairable, PlannerService } = require('../src/planner/planner.service');
const { usesGeneratedMap, usesMapMenu } = require('../src/runs/replay-assets');

const frame = 'iframe#hyjalIframe';
const open = { type: 'open', path: '/tkmap/mapDraw' };
const menu = { type: 'visible', locator: { kind: 'role', role: 'menuitem', name: '添加地图', frame } };
const ensure = { type: 'ensure-map-in-menu', frame, mapName: '地图"一' };
const steps = [{ order: 1, action: '准备地图', expected: '显示目标地图' }];
const validate = (operations, checks) => validateWorkflow([{ operations: [open, ...operations], checks }], 1);

test('hover targets the specified element in its frame', () => {
  const operation = { type: 'hover', locator: { kind: 'css', value: 'canvas', frame } };
  const script = compileWorkflow('地图', steps, validate([operation], [menu]));
  assert.ok(script.includes('await browser.frameLocator("iframe#hyjalIframe").locator("canvas").hover();'));
});

test('wait-visible accepts bounded timeouts and retains the default emitted call when omitted', () => {
  const wait = { type: 'wait-visible', locator: { kind: 'css', value: 'iframe#hyjalIframe' } };
  const source = (operation) => compileWorkflow('地图', steps, validate([operation], [menu]));
  const matcher = 'await expect(browser.locator("iframe#hyjalIframe")).toBeVisible';
  assert.ok(source(wait).includes(matcher + '();'));
  for (const timeoutMs of [1000, 30000, 60000]) {
    assert.ok(source({ ...wait, timeoutMs }).includes(matcher + `({ timeout: ${timeoutMs} });`));
  }
  for (const timeoutMs of [999, 60001, 5000.5, '60000', null]) {
    assert.throws(() => source({ ...wait, timeoutMs }), /timeoutMs/);
  }
});

test('iframe targets compile as browser frame queries while page targets retain their original scope', () => {
  const checks = [menu, { type: 'visible', locator: { kind: 'text', value: '地图一', frame: 'iframe:visible' } },
    { type: 'visible', locator: { kind: 'css', value: '.map', frame } },
    { type: 'visible', locator: { kind: 'text', value: '地图' } }];
  const script = compileWorkflow('地图', steps, validate([], checks));
  assert.ok(script.includes('browser.frameLocator("iframe#hyjalIframe").getByRole("menuitem", {"name":"添加地图","exact":true})'));
  assert.ok(script.includes('browser.frameLocator("iframe:visible").getByText("地图一", { exact: true })'));
  assert.ok(script.includes('browser.frameLocator("iframe#hyjalIframe").locator(".map")'));
  assert.ok(script.includes('screen.getByText("地图", { exact: true })'));
});

test('map preparation defaults floor to 1, honors explicit floor and can require an existing map', () => {
  const workflow = validate([ensure, { ...ensure, floor: 3, existingOnly: true }], [menu]);
  const script = compileWorkflow('地图', steps, workflow);
  assert.ok(script.includes("import { ensureMap } from '../../../support/ensure-map.ts';"));
  assert.ok(script.includes('async ({ app, browser })'));
  assert.ok(script.includes(`await ensureMap(browser, ${JSON.stringify(frame)}, ${JSON.stringify(ensure.mapName)}, 1);`));
  assert.ok(script.includes(`await ensureMap(browser, ${JSON.stringify(frame)}, ${JSON.stringify(ensure.mapName)}, 3, true);`));
  const readFloor = validate([{ ...ensure, existingOnly: true, recordFloor: true }], [menu]);
  assert.ok(compileWorkflow('地图', steps, readFloor).includes(`await ensureMap(browser, ${JSON.stringify(frame)}, ${JSON.stringify(ensure.mapName)}, 1, true, true);`));
  assert.throws(() => validate([{ ...ensure, recordFloor: 'true' }], [menu]), /recordFloor/);
  assert.ok(!compileWorkflow('地图', steps, validate([], [menu])).includes('support/ensure-map'));
});

test('a map session conditionally authenticates at the requested editor before reading its frame', () => {
  const op = { type: 'ensure-map-session' };
  const session = validate([op], [menu]);
  assert.equal(usesTargetLogin(session), true);
  assert.equal(usesTargetLogin(validate([], [menu])), false);
  const source = compileWorkflow('已有地图', steps, session);
  assert.ok(source.includes('async ({ app, browser })'));
  assert.ok(source.includes('await expect(login.or(editorFrame)).toBeVisible'));
  assert.ok(source.includes('if (await login.isVisible()) {\n      const account = credentials.user("target");'));
  assert.ok(source.includes('await expect(browser).toHaveURL("/tkmap/mapDraw"'));
  assert.ok(source.includes('await expect(editorFrame).toBeVisible'));
  assert.throws(() => validateWorkflow([{ operations: [{ type: 'open', path: '/task/taskLego' }, op], checks: [menu] }], 1), /必须紧跟打开 \/tkmap\/mapDraw/);
});

test('invalid frame selectors cannot cross frames or select other elements', () => {
  for (const selector of ['', null, 'body', 'iframe, body', 'iframe >> nth=0', 'iframe:has(*)']) {
    assert.throws(() => validate([], [{ ...menu, locator: { ...menu.locator, frame: selector } }]), /iframe/);
    assert.throws(() => validate([{ ...ensure, frame: selector }], [menu]), /iframe/);
  }
  assert.throws(() => validate([{ ...ensure, floor: '1' }], [menu]), /整数/);
  assert.throws(() => validate([{ ...ensure, existingOnly: 'true' }], [menu]), /布尔/);
  assert.throws(() => validate([{ ...ensure, mapName: ' ' }], [menu]), /地图名称/);
});

test('operation repairs retain iframe checks and page-level CSS repairs cannot rewrite framed counts', () => {
  const original = validate([ensure], [menu]);
  const repaired = validateWorkflow([{ operations: [open, { ...ensure, floor: 3 }] }], 1, original);
  assert.deepEqual(repaired[0].checks, [menu]);
  const count = { type: 'count', locator: { kind: 'css', value: '.map' }, value: 1 };
  assert.equal(isCountLocatorRepairable(count, 2), true);
  assert.equal(isCountLocatorRepairable({ ...count, locator: { ...count.locator, frame } }, 2), false);
});

const layout = {
  mapName: '测试"地图', floor: 2,
  points: [{ id: 'A', type: 'normal', x: 0, y: 0 }, { id: 'C', type: 'charge', x: 1, y: 0 }],
  links: [{ from: 'A', to: 'C', bidirectional: false }], routes: [{ from: 'A', to: 'C' }],
};
const importMap = (layout) => ({ type: 'import-generated-map', layout });

test('a generated map carries only the checked layout into the executable upload step', () => {
  const supplied = { ...layout, outputFile: '../out', points: layout.points.map(p => ({ ...p, chargerId: 'invented' })) };
  const workflow = validate([importMap(supplied)], [menu]);
  const normalized = workflow[0].operations[1].layout;
  assert.deepEqual(normalized, { ...layout, ver: '5.10' });
  const script = compileWorkflow('导入生成地图', steps, workflow);
  assert.match(script, /import \{ importGeneratedMap \} from '\.\.\/\.\.\/\.\.\/support\/import-generated-map\.ts';/);
  assert.ok(script.includes(`await importGeneratedMap(browser, ${JSON.stringify(normalized)});`));
  assert.ok(script.includes('async ({ app, browser })'));
  assert.equal(usesGeneratedMap(workflow), true);
  assert.equal(usesMapMenu(workflow), true);
  assert.equal(usesGeneratedMap(validate([ensure], [menu])), false);
  assert.equal(validate([importMap({ ...layout, ver: '5.9' })], [menu])[0].operations[1].layout.ver, '5.9');
});

test('generated maps require valid topology and repairs keep the confirmed map', () => {
  for (const invalid of [
    { ...layout, links: [{ from: 'A', to: 'Z', bidirectional: true }] },
    { ...layout, routes: [{ from: 'C', to: 'A' }] },
    { ...layout, ver: '4.8' },
  ]) assert.throws(() => validate([importMap(invalid)], [menu]), /模拟地图布局无效/);
  const original = validate([importMap(layout)], [menu]);
  const repaired = (operation) => validateWorkflow([{ operations: [open, operation] }], 1, original);
  assert.deepEqual(repaired(importMap(layout)), original);
  assert.throws(() => repaired(importMap({ ...layout, mapName: '另一张图' })), /保留原步骤已确认的地图/);
  assert.throws(() => repaired(ensure), /保留原步骤已确认的地图/);
});

test('importing into an existing map enforces lookup-only through compilation and repair', () => {
  const { floor, ...siteLayout } = layout;
  const op = { ...importMap(siteLayout), existingOnly: true };
  const workflow = validate([op], [menu]);
  const normalized = workflow[0].operations[1];
  assert.equal(normalized.existingOnly, true);
  assert.equal(Object.hasOwn(normalized.layout, 'floor'), false);
  assert.equal(validate([{ ...op, layout }], [menu])[0].operations[1].layout.floor, floor);
  assert.throws(() => validate([importMap(siteLayout)], [menu]), /floor 必须为整数/);
  assert.ok(compileWorkflow('导入已有地图', steps, workflow)
    .includes(`await importGeneratedMap(browser, ${JSON.stringify(normalized.layout)}, true);`));
  assert.throws(() => validate([{ ...op, existingOnly: 'true' }], [menu]), /existingOnly 必须是布尔值/);
  assert.throws(() => validateWorkflow([{ operations: [open, importMap(layout)] }], 1, workflow), /保留原步骤已确认的地图/);
});

test('natural-language map generation and import requests select the simulation skill', () => {
  const planner = new PlannerService();
  assert.equal(planner.skillFor({ description: '生成一张带工位和储位的小地图，然后加密上传' }), 'tusk-map-simulation');
  assert.equal(planner.skillFor({ description: '检查 Paladin 服务的地图绑定' }), 'task-workflow-testing');
});

test('warehouse parameters become fixed points in the script and preserve the existing map floor policy', () => {
  const spec = { mapName: 'Task001', ver: '5.9',
    warehouse: { shape: 'L', aislePoints: 10, turnAt: 5, storageCount: 20, workCount: 10, chargeCount: 1 } };
  const op = { ...importMap(spec), existingOnly: true };
  const workflow = validate([op], [menu]);
  const saved = workflow[0].operations[1].layout;
  assert.equal(saved.mapName, 'Task001');
  assert.equal(saved.ver, '5.9');
  assert.equal(saved.points.length, 41);
  assert.equal(saved.links.length, 40);
  assert.equal(Object.hasOwn(saved, 'floor'), false);
  assert.equal(Object.hasOwn(saved, 'warehouse'), false);
  assert.ok(compileWorkflow('整图导入', steps, workflow)
    .includes(`await importGeneratedMap(browser, ${JSON.stringify(saved)}, true);`));
});

test('explicit layouts validate drawn geometry before becoming executable workflows', () => {
  const diagonal = { ...layout, points: [layout.points[0], { ...layout.points[1], y: 1 }] };
  assert.throws(() => validate([importMap(diagonal)], [menu]), /斜线/);
  const intentional = { ...diagonal, geometry: 'free' };
  assert.equal(validate([importMap(intentional)], [menu])[0].operations[1].layout.geometry, 'free');
});
