import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { BusinessStep, CasePrerequisite } from '@autotest/shared';
import { readHookGraph } from './hook-graph';
import { findTaskStageMenu } from './task-stage-menu';
import { readGeneratedMapLayout, type GeneratedMapLayout } from './map-layout';

export const TUSK_SERVICE_PREREQUISITE = 'tusk-service-preflight';
export const TUSK_SERVICE_PREREQUISITE_MODULE = 'support/tusk-service-preflight.ts';
export const PALADIN_BIND_FINISHED_URL = /\/config\/tuskService\/?(?:[?#].*)?$/;

export const ENSURE_MAP_MODULE = 'support/ensure-map.ts';
export const IMPORT_GENERATED_MAP_MODULE = 'support/import-generated-map.ts';
export const SIMULATION_START_MODULE = 'support/simulation-start.ts';
export const SIMULATION_FINISHED_URL = /\/task\/simConfig\/?(?:[?#].*)?$/;
// Distinct from ensureMap's own URL check so the report can delimit the complete import.
export const GENERATED_MAP_FINISHED_URL = /\/tkmap\/mapDraw\/?(?:[?#].*)?$/;

const TASK_CONFIG_STAGES = ['创建时', '进入前', '到达时', '离开前', '离开后'] as const;
type TaskConfigStage = typeof TASK_CONFIG_STAGES[number];

const sessionPages = {
  'ensure-task-config-session': { path: '/task/taskLego', name: '任务配置', readyName: 'list', readySelector: '.el-table:visible:has(.header-text:text-is("名称")) .el-table__body:visible' },
  'ensure-map-session': { path: '/tkmap/mapDraw', name: '地图', readyName: 'editorFrame', readySelector: 'iframe#hyjalIframe:visible' },
} as const;
export type SessionOperationType = keyof typeof sessionPages;
export function isSessionOperation(type: string): type is SessionOperationType {
  return Object.prototype.hasOwnProperty.call(sessionPages, type);
}

type Locator = { frame?: string } & (
  | { kind: 'placeholder' | 'text' | 'css'; value: string }
  | { kind: 'role'; role: string; name: string }
);
type Target = { testId: string } | { locator: Locator };

type SimulationTarget = { mapName: string; key: string };
type SimulationOperation = SimulationTarget & (
  { type: 'create-simulation-instance' | 'start-simulation-instance' }
  | { type: 'configure-simulation-apr'; count: number }
);
type SimulationCheck = SimulationTarget & (
  { type: 'simulation-created' | 'simulation-running' }
  | { type: 'simulation-apr'; count: number }
);
const simulationFunctions = {
  'create-simulation-instance': 'createSimulationInstance',
  'configure-simulation-apr': 'configureSimulationApr',
  'start-simulation-instance': 'startSimulationInstance',
  'simulation-created': 'verifySimulationCreated',
  'simulation-apr': 'verifySimulationApr',
  'simulation-running': 'verifySimulationRunning',
} as const;

export function isSimulationCall(item: Operation | Check): item is SimulationOperation | SimulationCheck {
  return Object.prototype.hasOwnProperty.call(simulationFunctions, item.type);
}

export type Operation =
  | SimulationOperation
  | { type: 'open'; path: string }
  | { type: SessionOperationType }
  | { type: 'ensure-map-in-menu'; frame: string; mapName: string; floor: number; existingOnly?: true; recordFloor?: true }
  | { type: 'import-generated-map'; layout: GeneratedMapLayout; existingOnly?: true }
  | { type: 'wait-url'; path: string }
  | { type: 'act'; instruction: string }
  | { type: 'wait'; ms: number }
  | { type: 'select-element-plus'; selector: string; value: string }
  | { type: 'filter-task-config'; value: string }
  | { type: 'bind-paladin-map'; mapName: string; serviceName?: string; rattletrapName?: string; syncExisting?: true }
  | { type: 'sync-bound-map-services'; mapName: string; serviceName?: string; rattletrapName?: string }
  | { type: 'add-task-config-stage'; node: string; stage: TaskConfigStage }
  | ({ type: 'wait-visible'; timeoutMs?: number } & Target)
  | ({ type: 'wait-hidden' } & Target)
  | ({ type: 'click' | 'hover' } & Target)
  | ({ type: 'press'; key: string } & Target)
  | ({ type: 'fill-credential'; field: 'username' | 'password' } & Target)
  | ({ type: 'fill' | 'select'; value: string } & Target);

export type HookGraphCheck = {
  type: 'capture-hook-graph' | 'matches-hook-graph';
  node: string; stage: TaskConfigStage; hook: string; key: string;
};

type Check =
  | SimulationCheck
  | { type: 'url'; path: string }
  | HookGraphCheck
  | (Target & (
      { type: 'visible' | 'hidden' }
      | { type: 'count'; value: number }
      | { type: 'text' | 'contains' | 'value'; value: string }
      | { type: 'capture-text' | 'matches-text' | 'capture-json' | 'matches-json'; key: string }
    ));
export type Workflow = Array<{ operations: Operation[]; checks: Check[] }>;

export function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export class WorkflowValidationError extends BadRequestException {
  constructor(message: string, readonly invalidStep?: number) {
    super(message);
  }
}

function invalid(message: string): never {
  throw new WorkflowValidationError(message);
}

function withValidationContext<T>(context: string, validate: () => T, stepNumber?: number): T {
  try {
    return validate();
  } catch (error) {
    if (error instanceof WorkflowValidationError) throw new WorkflowValidationError(`${context}：${error.message}`, stepNumber);
    throw error;
  }
}

function unsupportedType(type: unknown, label: string): never {
  if (type === undefined) invalid(`${label}缺少 type`);
  const name = typeof type === 'string' && /^[a-z][a-z0-9_-]{0,39}$/i.test(type) ? `「${type}」` : '';
  return invalid(`未知${label}${name}`);
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('测试流程必须使用 JSON 对象');
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || value.length > 4000) {
    invalid(label + '格式无效');
  }
  return value;
}

function sameSitePath(value: unknown): string {
  const path = string(value, '页面路径');
  if (!/^\/(?![\\/])/.test(path) || /[\\\x00-\x20]/.test(path)) invalid('页面路径必须是同站点相对路径');
  return path;
}

function baselineKey(value: unknown): string {
  const key = string(value, '基线名称');
  if (!/^[\p{L}\p{N}_-]{1,64}$/u.test(key)) invalid('基线名称格式无效');
  return key;
}

function simulationTarget(item: Record<string, unknown>): SimulationTarget {
  return { mapName: string(item.mapName, '地图名称'), key: baselineKey(item.key) };
}

function aprCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) invalid('APR 数量必须为正整数');
  return value;
}

function frameSelector(value: unknown): string {
  const selector = string(value, 'iframe 选择器');
  if (selector.length > 256 || !/^iframe(?:[.#][a-zA-Z_][a-zA-Z0-9_-]*)*(?::visible)?$/.test(selector)) {
    invalid('iframe 选择器仅支持 iframe 标签、ID、类和 :visible');
  }
  return selector;
}

function target(item: Record<string, unknown>): Target {
  if (item.locator === undefined) return { testId: string(item.testId, 'Test ID') };
  const locator = record(item.locator);
  const scope = locator.frame === undefined ? {} : { frame: frameSelector(locator.frame) };
  switch (locator.kind) {
    case 'placeholder':
    case 'text':
    case 'css':
      return { locator: { kind: locator.kind, value: string(locator.value, '控件定位值'), ...scope } };
    case 'role':
      return { locator: { kind: 'role', role: string(locator.role, '控件角色'), name: string(locator.name, '控件可访问名称'), ...scope } };
    default: return invalid('未知控件定位方式');
  }
}

function operation(value: unknown): Operation {
  const item = record(value);
  switch (item.type) {
    case 'create-simulation-instance':
    case 'start-simulation-instance':
      return { type: item.type, ...simulationTarget(item) };
    case 'configure-simulation-apr':
      return { type: item.type, ...simulationTarget(item), count: aprCount(item.count) };
    case 'open': return { type: 'open', path: sameSitePath(item.path) };
    case 'import-generated-map': {
      if (item.existingOnly !== undefined && typeof item.existingOnly !== 'boolean') invalid('existingOnly 必须是布尔值');
      try {
        return { type: item.type, layout: readGeneratedMapLayout(item.layout, item.existingOnly === true), ...(item.existingOnly ? { existingOnly: true as const } : {}) };
      } catch (error) {
        return invalid('模拟地图布局无效：' + (error instanceof Error ? error.message : String(error)));
      }
    }
    case 'ensure-map-in-menu': {
      const mapName = string(item.mapName, '地图名称');
      const floor = item.floor === undefined ? 1 : item.floor;
      if (typeof floor !== 'number' || !Number.isSafeInteger(floor)) invalid('地图楼层必须是整数');
      if (item.existingOnly !== undefined && typeof item.existingOnly !== 'boolean') invalid('existingOnly 必须是布尔值');
      if (item.recordFloor !== undefined && typeof item.recordFloor !== 'boolean') invalid('recordFloor 必须是布尔值');
      return { type: item.type, frame: frameSelector(item.frame), mapName, floor,
        ...(item.existingOnly ? { existingOnly: true as const } : {}), ...(item.recordFloor ? { recordFloor: true as const } : {}) };
    }
    case 'ensure-task-config-session':
    case 'ensure-map-session': return { type: item.type };
    case 'wait-url': return { type: 'wait-url', path: sameSitePath(item.path) };
    case 'filter-task-config': return { type: item.type, value: string(item.value, '任务配置完整名称') };
    case 'bind-paladin-map':
    case 'sync-bound-map-services': {
      const mapName = string(item.mapName, '地图名称');
      const serviceName = item.serviceName === undefined ? undefined : string(item.serviceName, '服务全名');
      if (serviceName && !/^paladin/i.test(serviceName)) invalid('请输入 Paladin 服务全名');
      const rattletrapName = item.rattletrapName === undefined ? undefined : string(item.rattletrapName, 'Rattletrap 服务全名');
      if (item.syncExisting !== undefined && (item.type !== 'bind-paladin-map' || typeof item.syncExisting !== 'boolean')) {
        invalid('syncExisting 仅适用于 bind-paladin-map，值必须为布尔值');
      }
      return { type: item.type, mapName, ...(serviceName && { serviceName }), ...(rattletrapName && { rattletrapName }),
        ...(item.syncExisting ? { syncExisting: true as const } : {}) };
    }
    case 'add-task-config-stage': {
      const node = string(item.node, '任务配置主节点标题');
      if (node.length > 128 || /[\x00-\x1f\x7f]/.test(node)) invalid('任务配置主节点标题格式无效');
      const stage = TASK_CONFIG_STAGES.find((stage) => stage === item.stage);
      if (!stage) invalid('未知任务配置时态阶段');
      return { type: item.type, node, stage };
    }
    case 'act': return { type: 'act', instruction: string(item.instruction, 'Agent 动作') };
    case 'wait': {
      const ms = item.ms;
      if (typeof ms !== 'number' || !Number.isInteger(ms) || ms < 1 || ms > 2000) invalid('等待时间必须为 1 至 2000 毫秒');
      return { type: 'wait', ms };
    }
    case 'click':
    case 'hover': return { type: item.type, ...target(item) };
    case 'select-element-plus':
      return { type: item.type, selector: string(item.selector, '下拉框定位值'), value: string(item.value, '选项名称') };
    case 'wait-visible': {
      const timeoutMs = item.timeoutMs;
      if (timeoutMs === undefined) return { type: item.type, ...target(item) };
      if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) {
        invalid('等待控件可见的 timeoutMs 必须为 1000 至 60000 毫秒的整数');
      }
      return { type: item.type, ...target(item), timeoutMs };
    }
    case 'wait-hidden':
      return { type: item.type, ...target(item) };
    case 'press': return { type: 'press', ...target(item), key: string(item.key, '键盘按键') };
    case 'fill-credential': {
      if (item.field !== 'username' && item.field !== 'password') invalid('登录凭据字段无效');
      return { type: 'fill-credential', ...target(item), field: item.field };
    }
    case 'fill':
    case 'select':
      return { type: item.type, ...target(item), value: string(item.value, '输入值', true) };
    default: return unsupportedType(item.type, '测试动作');
  }
}

function check(value: unknown): Check {
  const item = record(value);
  switch (item.type) {
    case 'simulation-created':
    case 'simulation-running':
      return { type: item.type, ...simulationTarget(item) };
    case 'simulation-apr':
      return { type: item.type, ...simulationTarget(item), count: aprCount(item.count) };
    case 'url': return { type: 'url', path: sameSitePath(item.path ?? item.value) };
    case 'capture-hook-graph':
    case 'matches-hook-graph': {
      const node = string(item.node, '任务配置主节点标题');
      const stage = TASK_CONFIG_STAGES.find(stage => stage === item.stage);
      if (!stage) invalid('未知任务配置时态阶段');
      return { type: item.type, node, stage, hook: string(item.hook, 'Hook 类型'), key: baselineKey(item.key) };
    }
    case 'visible':
    case 'hidden':
      return { type: item.type, ...target(item) };
    case 'count': {
      const value = item.value;
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid('断言数量必须为非负整数');
      return { type: 'count', ...target(item), value };
    }
    case 'text':
    case 'contains':
    case 'value':
      return { type: item.type, ...target(item), value: string(item.value, '断言值', item.type !== 'contains') };
    case 'capture-text':
    case 'matches-text':
    case 'capture-json':
    case 'matches-json': {
      return { type: item.type, ...target(item), key: baselineKey(item.key) };
    }
    default: return unsupportedType(item.type, '断言类型');
  }
}

function validateStep(entry: unknown, old?: Workflow[number]): Workflow[number] {
  const item = record(entry);
  if (!Array.isArray(item.operations) || item.operations.length > 10) invalid('每步最多 10 个操作');
  const operations = item.operations.map((value, index) =>
    withValidationContext(`操作 ${index + 1}`, () => operation(value)));
  if (old && JSON.stringify(operations.filter(op => op.type === 'import-generated-map')) !==
    JSON.stringify(old.operations.filter(op => op.type === 'import-generated-map'))) {
    invalid('修复必须保留原步骤已确认的地图布局及导入次数');
  }
  if (operations.filter((op) => op.type === 'act').length > 1 ||
      (operations.some((op) => op.type === 'act') && operations.at(-1)?.type !== 'act')) {
    invalid('每步最多一个 Agent 动作，且必须紧接断言');
  }
  if (!old && (!Array.isArray(item.checks) || item.checks.length < 1 || item.checks.length > 10)) {
    invalid('每个业务步骤需要 1 至 10 条确定性断言');
  }
  const checks = old?.checks ?? (item.checks as unknown[]).map((value, index) =>
    withValidationContext(`断言 ${index + 1}`, () => check(value)));
  if (old && old.operations.some(isAction) && !operations.some(isAction)) invalid('修复不能移除整个业务动作');
  if (old && JSON.stringify(operations.filter(isSimulationCall)) !== JSON.stringify(old.operations.filter(isSimulationCall))) {
    invalid('修复必须保留已确认的仿真实例操作、地图和数量');
  }
  return { operations, checks };
}

function isAction(op: Operation): boolean {
  return op.type !== 'wait' && op.type !== 'wait-url' && op.type !== 'wait-visible' && op.type !== 'wait-hidden';
}

export function validateWorkflow(value: unknown, count: number, original?: Workflow, {
  requireOpen = true, allowMissingBaselines = false, stepOffset = 0,
} = {}): Workflow {
  if (!Array.isArray(value) || value.length !== count || count < 1 || count > 30) {
    invalid('执行流程的步数必须与确认的业务步骤一致（最多 30 步）');
  }
  const workflow = value.map((entry, index) => {
    const stepNumber = stepOffset + index + 1;
    return withValidationContext(`第 ${stepNumber} 步`, () => validateStep(entry, original?.[index]), stepNumber);
  });
  if (requireOpen && workflow[0]?.operations[0]?.type !== 'open') invalid('测试的第一个操作必须打开页面');
  const baselines = new Map<string, string>();
  const simulationMaps = new Map<string, string>();
  for (const [stepIndex, step] of workflow.entries()) {
    const stepNumber = stepOffset + stepIndex + 1;
    const { operations } = step;
    for (const item of [...operations, ...step.checks].filter(isSimulationCall)) {
      withValidationContext(`第 ${stepNumber} 步`, () => {
        if (item.type === 'create-simulation-instance') {
          if (simulationMaps.has(item.key)) invalid(`仿真实例 key「${item.key}」不能重复创建`);
          simulationMaps.set(item.key, item.mapName);
        } else if (!simulationMaps.has(item.key)) {
          if (!allowMissingBaselines) invalid(`请先创建 key 为「${item.key}」的仿真实例`);
        } else if (simulationMaps.get(item.key) !== item.mapName) {
          invalid(`仿真实例 key「${item.key}」的地图与创建时不一致`);
        }
      }, stepNumber);
    }
    operations.forEach((op, index) => {
      if (!isSessionOperation(op.type)) return;
      const page = sessionPages[op.type];
      const prior = operations[index - 1];
      if (prior?.type !== 'open' || prior.path !== page.path) {
        invalid(`第 ${stepNumber} 步：操作 ${index + 1}：${page.name}会话检查必须紧跟打开 ${page.path}`);
      }
    });
    for (const [checkIndex, check] of step.checks.entries()) {
      if (!('key' in check) || isSimulationCall(check)) continue;
      const format = 'hook' in check ? JSON.stringify([check.node, check.stage, check.hook])
        : check.type === 'capture-json' || check.type === 'matches-json' ? 'json' : 'text';
      if (check.type.startsWith('capture-')) {
        if (baselines.has(check.key)) invalid(`第 ${stepNumber} 步：断言 ${checkIndex + 1}：基线「${check.key}」不能重复记录`);
        baselines.set(check.key, format);
      } else if (baselines.get(check.key) !== format && (baselines.has(check.key) || !allowMissingBaselines)) {
        invalid(`第 ${stepNumber} 步：断言 ${checkIndex + 1}：请先记录同类型的基线「${check.key}」`);
      }
    }
  }
  return workflow;
}

function loc(target: Target): string {
  if ('testId' in target) return 'screen.getByTestId(' + JSON.stringify(target.testId) + ')';
  const { locator } = target;
  const scope = locator.frame ? 'browser.frameLocator(' + JSON.stringify(locator.frame) + ')' : undefined;
  if (locator.kind === 'role') {
    return (scope ?? 'screen') + '.getByRole(' + JSON.stringify(locator.role) + ', ' + JSON.stringify({ name: locator.name, exact: true }) + ')';
  }
  const value = JSON.stringify(locator.value);
  if (locator.kind === 'css') return (scope ?? 'browser') + '.locator(' + value + ')';
  const method = locator.kind === 'placeholder' ? 'getByPlaceholder' : 'getByText';
  return (scope ?? 'screen') + '.' + method + '(' + value + ', { exact: true })';
}

export function usesTargetLogin(workflow: Workflow): boolean {
  return workflow.some((step) => step.operations.some((op) =>
    op.type === 'fill-credential' || isSessionOperation(op.type),
  ));
}

export function taskConfigExactRowSelector(name: string): string {
  return `.el-table__body tr:has(td :text-is(${JSON.stringify(name)}))`;
}

export function compileWorkflow(title: string, steps: BusinessStep[], workflow: Workflow, prerequisite?: CasePrerequisite): string {
  const parts = workflow.flatMap(({ operations, checks }) => [...operations, ...checks]);
  const simImports = [...new Set(parts.filter(isSimulationCall).map(item => simulationFunctions[item.type]))];
  const fixtures = ['app'];
  const serviceImports = [];
  if (prerequisite) serviceImports.push('runTuskServicePreflight');
  if (parts.some(item => item.type === 'bind-paladin-map')) serviceImports.push('bindPaladinMap');
  if (parts.some(item => item.type === 'sync-bound-map-services')) serviceImports.push('syncBoundMapServices');
  if (parts.some((item) => item.type === 'act')) fixtures.push('agent');
  if (serviceImports.length || parts.some((item) => item.type === 'url' || item.type === 'wait-url' || item.type === 'wait' ||
    item.type === 'select-element-plus' || item.type === 'filter-task-config' || isSessionOperation(item.type) ||
    item.type === 'add-task-config-stage' || item.type === 'ensure-map-in-menu' || item.type === 'import-generated-map' || 'key' in item ||
    ('locator' in item && (item.locator.kind === 'css' || item.locator.frame)))) fixtures.push('browser');
  if (serviceImports.length || parts.some((item) => 'testId' in item || ('locator' in item && !item.locator.frame && item.locator.kind !== 'css'))) fixtures.push('screen');
  const lines = [
    "import { test } from '@e2e-dev/web';",
    prerequisite || usesTargetLogin(workflow) ? "import { credentials, expect } from 'e2e';" : "import { expect } from 'e2e';",
    ...(parts.some((item) => item.type === 'ensure-map-in-menu') ? [`import { ensureMap } from '../../../${ENSURE_MAP_MODULE}';`] : []),
    ...(parts.some((item) => item.type === 'import-generated-map') ? [`import { importGeneratedMap } from '../../../${IMPORT_GENERATED_MAP_MODULE}';`] : []),
    ...(simImports.length ? [`import { ${simImports.join(', ')} } from '../../../${SIMULATION_START_MODULE}';`] : []),
    ...(serviceImports.length ? [`import { ${serviceImports.join(', ')} } from '../../../${TUSK_SERVICE_PREREQUISITE_MODULE}';`] : []),
    '',
    'test(' + JSON.stringify(title) + ', async ({ ' + fixtures.join(', ') + ' }) => {',
  ];
  if (parts.some((part) => 'hook' in part)) {
    lines.push('  const hookGraphs = new Map<string, string>();',
      '  const readHookGraph: (input: { node: string; stage: string; hook: string; compare: boolean; expected: string | null }) => Promise<string> = ' +
      readHookGraph.toString() + ';');
  }
  if (parts.some((part) => 'key' in part && !('hook' in part) && !isSimulationCall(part))) {
    lines.push(
      '  const baselines = new Map<string, unknown>();',
      '  async function checkBaseline(locator: { textContent(): Promise<string | null>; inputValue(): Promise<string> },',
      '    key: string, isJson: boolean, capture: boolean) {',
      '    let failure: string | null = null;',
      '    try {',
      '      const raw = isJson ? await locator.inputValue() : await locator.textContent();',
      '      if (raw === null) throw new Error("未读取到控件文本");',
      '      const current = isJson ? JSON.parse(raw) : raw;',
      '      if (capture) baselines.set(key, current);',
      '      else if (!baselines.has(key)) failure = "缺少保存前基线";',
      '      else {',
      '        try { expect(current).toEqual(baselines.get(key)); }',
      '        catch { failure = "回读值与保存前基线不同"; }',
      '      }',
      '    } catch (error) {',
      '      failure = error instanceof SyntaxError ? "控件内容不是有效 JSON" : "无法读取控件内容";',
      '    }',
      '    await browser.evaluate((problem) => { if (problem) throw new Error(problem); return null; },',
      '      failure === null ? null : key + "：" + failure);',
      '  }',
    );
  }
  if (prerequisite) {
    const { mapName, serviceName } = prerequisite;
    lines.push(
      '  // 前置检查：同步所有服务并验证 Paladin 地图绑定',
      '  await runTuskServicePreflight({ browser, screen, open: (path) => app.open(path), credentials: () => credentials.user("target") }, ' +
        JSON.stringify({ mapName, serviceName }) + ');',
      '  await browser.waitForURL(/\\/config\\/tuskService\\/?(?:[?#]|$)/);',
    );
  }
  const instanceVariables = new Map<string, string>();
  function emitSimulationCall(item: SimulationOperation | SimulationCheck) {
    const map = JSON.stringify(item.mapName);
    if (item.type === 'create-simulation-instance') {
      const variable = 'simulationInstanceId' + (instanceVariables.size + 1);
      instanceVariables.set(item.key, variable);
      lines.push(`  const ${variable} = await createSimulationInstance(browser, ${map});`);
    } else {
      const variable = instanceVariables.get(item.key);
      if (!variable) invalid('无法编译未创建的仿真实例：' + item.key);
      const count = 'count' in item ? ', ' + item.count : '';
      lines.push(`  await ${simulationFunctions[item.type]}(browser, ${variable}, ${map}${count});`);
    }
    lines.push(`  await browser.waitForURL(${SIMULATION_FINISHED_URL});`);
  }
  for (const [index, step] of workflow.entries()) {
    lines.push('  // ' + (index + 1) + '. ' + steps[index]!.action.replace(/[\r\n\u2028\u2029]/g, ' '));
    for (const op of step.operations) {
      if (isSimulationCall(op)) {
        emitSimulationCall(op);
        continue;
      }
      switch (op.type) {
        case 'open': lines.push('  await app.open(' + JSON.stringify(op.path) + ');'); break;
        case 'import-generated-map':
          lines.push(`  await importGeneratedMap(browser, ${JSON.stringify(op.layout)}${op.existingOnly ? ', true' : ''});`);
          lines.push(`  await browser.waitForURL(${GENERATED_MAP_FINISHED_URL});`);
          break;
        case 'ensure-map-in-menu': {
          const options = op.recordFloor ? [Boolean(op.existingOnly), true] : op.existingOnly ? [true] : [];
          lines.push(`  await ensureMap(browser, ${[op.frame, op.mapName, op.floor, ...options].map(arg => JSON.stringify(arg)).join(', ')});`);
          break;
        }
        case 'ensure-task-config-session':
        case 'ensure-map-session': {
          const { path, readyName, readySelector } = sessionPages[op.type];
          lines.push(
            '  {',
            '    const loginForm = browser.locator(\'body:has(input[placeholder="账号"]:visible):has(input[placeholder="密码"]:visible)\');',
            '    const login = loginForm.getByRole("button", { name: /^登\\s*录$/ });',
            `    const ${readyName} = browser.locator('${readySelector}');`,
            `    await expect(login.or(${readyName})).toBeVisible({ timeout: 30000 });`,
            '    if (await login.isVisible()) {',
            '      const account = credentials.user("target");',
            '      await loginForm.getByPlaceholder("账号", { exact: true }).fill(account.username);',
            '      await loginForm.getByPlaceholder("密码", { exact: true }).fill(account.password);',
            '      await login.click();',
            '    }',
            `    await expect(browser).toHaveURL(${JSON.stringify(path)}, { timeout: 30000 });`,
            `    await expect(${readyName}).toBeVisible({ timeout: 30000 });`,
            '  }',
          );
          break;
        }
        case 'wait-url': lines.push('  await expect(browser).toHaveURL(' + JSON.stringify(op.path) + ', { timeout: 15000 });'); break;
        case 'act': lines.push('  await agent.act(' + JSON.stringify(op.instruction) + ');'); break;
        case 'wait': lines.push('  await browser.evaluate((ms) => new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)), ' + op.ms + ');'); break;
        case 'wait-visible':
        case 'wait-hidden': {
          const matcher = op.type === 'wait-visible' ? 'toBeVisible' : 'toBeHidden';
          const options = op.type === 'wait-visible' && op.timeoutMs !== undefined ? `{ timeout: ${op.timeoutMs} }` : '';
          lines.push('  await expect(' + loc(op) + ').' + matcher + '(' + options + ');');
          break;
        }
        case 'click':
        case 'hover': lines.push('  await ' + loc(op) + '.' + op.type + '();'); break;
        case 'press': lines.push('  await ' + loc(op) + '.press(' + JSON.stringify(op.key) + ');'); break;
        case 'fill-credential': lines.push('  await ' + loc(op) + '.fill(credentials.user("target").' + op.field + ');'); break;
        case 'fill': lines.push('  await ' + loc(op) + '.fill(' + JSON.stringify(op.value) + ');'); break;
        case 'select': lines.push('  await ' + loc(op) + '.selectOption({ value: ' + JSON.stringify(op.value) + ' });'); break;
        case 'add-task-config-stage': {
          const node = `.vue-flow__node-llm:has(.node-header > div:text-is(${JSON.stringify(op.node)}))`;
          const trigger = node + ' .node-header [role="button"][aria-haspopup="menu"][aria-controls=';
          const choice = JSON.stringify({ name: op.stage, exact: true });
          lines.push(
            '  {',
            '    await expect(browser.locator(' + JSON.stringify(node) + ')).toHaveCount(1);',
            '    const menuId = await browser.evaluate(' + findTaskStageMenu.toString() + ', ' +
              JSON.stringify({ node: op.node, stage: op.stage }) + ');',
            '    await browser.locator(' + JSON.stringify(trigger) + ' + JSON.stringify(menuId) + "]").press("ArrowDown");',
            '    const choice = browser.locator(\'[role="menu"][id=\' + JSON.stringify(menuId) + "]").getByRole("menuitem", ' + choice + ');',
            '    await expect(choice).toBeVisible();',
            '    await choice.press("Enter");',
            '  }',
          );
          break;
        }
        case 'bind-paladin-map':
        case 'sync-bound-map-services': {
          const helper = op.type === 'bind-paladin-map' ? 'bindPaladinMap' : 'syncBoundMapServices';
          const args = [JSON.stringify(op.mapName)];
          const syncExisting = op.type === 'bind-paladin-map' && op.syncExisting;
          if (op.serviceName || op.rattletrapName || syncExisting) args.push(JSON.stringify(op.serviceName) ?? 'undefined');
          if (op.rattletrapName || syncExisting) args.push(JSON.stringify(op.rattletrapName) ?? 'undefined');
          if (syncExisting) args.push('true');
          lines.push(`  await ${helper}(browser, screen, ${args.join(', ')});`,
            `  await browser.waitForURL(${PALADIN_BIND_FINISHED_URL});`);
          break;
        }
        case 'filter-task-config': {
          // The search result settles independently of the popover. Read the matching list response,
          // then wait for its total to render before checking exact names in the business step.
          lines.push(
            '  {',
            '    const name = ' + JSON.stringify(op.value) + ';',
            '    const trigger = browser.locator(\'.el-table__header th:has(.header-text:text-is("名称")) button\');',
            '    const popup = browser.locator(\'.el-popover:visible:has(input[placeholder="请输入名称"])\');',
            '    await trigger.click();',
            '    await popup.getByPlaceholder("请输入名称", { exact: true }).fill(name);',
            '    const [response] = await Promise.all([',
            '      browser.waitForResponse(/\\/prod-api\\/task\\/taskLego\\/data(?:\\?|$)/, { timeout: 15000 }),',
            '      popup.getByRole("button", { name: "确定", exact: true }).click(),',
            '    ]);',
            '    if (response.status !== 200) throw new Error("任务配置筛选请求失败：HTTP " + response.status);',
            '    const { content, totalElements, totalPages } = await response.json<{ content: Array<{ name: string }>; totalElements: number; totalPages: number }>();',
            '    if (!Number.isSafeInteger(totalElements) || totalElements < 0 || !Number.isSafeInteger(totalPages) ||',
            '        totalPages < 0 || !Array.isArray(content) ||',
            '        content.some((row) => typeof row?.name !== "string" || !row.name.toLowerCase().includes(name.toLowerCase()))) {',
            '      throw new Error("任务配置筛选没有返回有效的列表结果");',
            '    }',
            '    if (totalPages > 1 || content.length !== totalElements) {',
            '      throw new Error("任务配置筛选结果超过一页，无法核对完整名称的匹配数");',
            '    }',
            '    await expect(browser.locator(".el-pagination__total")).toHaveText("共 " + totalElements + " 条");',
            '    const matchingRows = browser.locator(' + JSON.stringify(taskConfigExactRowSelector(op.value)) + ');',
            '    await expect(matchingRows).toHaveCount(content.filter((row) => row.name === name).length);',
            '    await trigger.click();',
            '    await expect(popup).toBeHidden();',
            '  }',
          );
          break;
        }
        case 'select-element-plus': {
          const trigger = 'browser.locator(' + JSON.stringify(op.selector) + ')';
          const input = 'browser.locator(' + JSON.stringify(op.selector + ' input.el-select__input[aria-expanded="true"]') + ')';
          const option = JSON.stringify({ name: op.value, exact: true, visible: true });
          lines.push(
            '  {',
            '    await ' + trigger + '.click();',
            '    await expect(' + input + ').toBeVisible();',
            '    const listboxId = await ' + input + '.getAttribute("aria-controls");',
            '    if (!listboxId) throw new Error("下拉框缺少 aria-controls，无法定位对应选项列表");',
            '    await browser.locator("[id=" + JSON.stringify(listboxId) + "]").getByRole("option", ' + option + ').click();',
            '  }',
          );
          break;
        }
      }
    }
    for (const assert of step.checks) {
      if (isSimulationCall(assert)) {
        emitSimulationCall(assert);
        continue;
      }
      if ('hook' in assert) {
        const { node, stage, hook, key } = assert;
        const options = JSON.stringify({ node, stage, hook });
        const id = JSON.stringify(key);
        if (assert.type === 'capture-hook-graph') {
          lines.push('  hookGraphs.set(' + id + ', await browser.evaluate(readHookGraph, { ...' + options + ', compare: false, expected: null }));');
        } else {
          lines.push('  await browser.evaluate(readHookGraph, { ...' + options + ', compare: true, expected: hookGraphs.get(' + id + ') ?? null });');
        }
        continue;
      }
      if (assert.type === 'url') {
        lines.push('  await expect(browser).toHaveURL(' + JSON.stringify(assert.path) + ');');
        continue;
      }
      if ('key' in assert) {
        const isJson = assert.type === 'capture-json' || assert.type === 'matches-json';
        const capture = assert.type === 'capture-text' || assert.type === 'capture-json';
        lines.push('  await expect(' + loc(assert) + ').toBeVisible();');
        lines.push('  await checkBaseline(' + loc(assert) + ', ' + JSON.stringify(assert.key) + ', ' + isJson + ', ' + capture + ');');
        continue;
      }
      const matcher = { visible: 'toBeVisible', hidden: 'toBeHidden', count: 'toHaveCount', text: 'toHaveText', contains: 'toContainText', value: 'toHaveValue' }[assert.type];
      const argument = 'value' in assert ? JSON.stringify(assert.value) : '';
      lines.push('  await expect(' + loc(assert) + ').' + matcher + '(' + argument + ');');
    }
  }
  return [...lines, '});', ''].join('\n');
}
