import { BadRequestException, GatewayTimeoutException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { performance } from 'node:perf_hooks';
import { SkillsService } from '../skills/skills.service';
import { evidencedHookGraphRepair } from './hook-graph-repair';
import { SettingsService, supportsScriptReasoning } from '../settings/settings.service';
import { digest, isSimulationCall, TUSK_SERVICE_PREREQUISITE, validateWorkflow, WorkflowValidationError, type Workflow } from './workflow';
import type { BusinessStep, CasePrerequisite, GeneratedPlan } from '@autotest/shared';

interface CaseContext {
  name: string;
  description: string;
  skill: string;
  taskId: string;
  prerequisite?: CasePrerequisite;
  steps: BusinessStep[];
}

export interface RepairEvidence {
  resyncExistingBinding?: true;
  failure: string;
  failedStep: number;
  failedCall: { kind: 'operation' | 'check'; type: string; index: number };
  observedCount?: number;
  screen: string;
  logTail: string;
  priorFailures: Array<{ version: number; reason: string }>;
}

const DIAGNOSIS_SKILL = 'test-failure-diagnosis';
const MAX_PLAN_SKILLS = 6;
const MAX_SKILL_DOCUMENT_CHARS = 72_000;
const DEFAULT_MODEL_TIMEOUT_SECONDS = 120;

// Apply to newly planned steps. Persisted workflows must remain readable for diagnosis and repair.
function validateSimulationRowLocators(step: Workflow[number], stepNumber: number) {
  const calls = [...step.operations, ...step.checks];
  const maps = new Set(calls.filter(isSimulationCall).map(call => call.mapName));
  if (!maps.size) return;
  for (const call of calls) {
    if (!('locator' in call) || call.locator.frame) continue;
    const locator = call.locator;
    let fixedRow = false;
    if (locator.kind === 'css') {
      // Headers, drawer fields and APR quantities can contain numeric values of their own.
      const row = locator.value.match(/(?:\btr\b|\[role=["']?row["']?\])([^,]*)/i)?.[1];
      if (!row) continue;
      const labels = Array.from(row.matchAll(/:(?:text-is|has-text|text)\(\s*(["'])(.*?)\1\s*\)/gi), match => match[2]!);
      fixedRow = labels.some(label => maps.has(label)) && labels.some(label => /^\d+$/.test(label) && !maps.has(label));
    } else if (locator.kind === 'role' && locator.role === 'row' && /^\d+\s/.test(locator.name)) {
      const row = ' ' + locator.name.replace(/^\d+\s+/, '').trim() + ' ';
      fixedRow = [...maps].some(map => row.includes(' ' + map + ' '));
    }
    if (fixedRow) {
      throw new WorkflowValidationError(`第 ${stepNumber} 步：新增仿真实例的编号在运行时分配。请移除按固定编号和地图定位实例行的操作或断言，使用同一 key 的仿真操作和对应断言跨页定位。`, stepNumber);
    }
  }
}

type ModelConfig = Awaited<ReturnType<SettingsService['getModelConfig']>>;
type ChatPurpose = 'script' | 'other';

interface ScriptRequestOptions {
  fast: boolean;
  thinking?: 'enabled' | 'disabled';
  reasoningEffort?: 'low' | 'high' | 'max';
}

function scriptRequestOptions(model: ModelConfig): ScriptRequestOptions {
  if (!supportsScriptReasoning(model.baseUrl, model.name)) return { fast: false };

  const flash = model.name === 'deepseek-flash';
  const setting = model.scriptReasoning ?? 'auto';
  if (setting === 'off') {
    return { fast: flash, thinking: 'disabled' };
  }
  if (setting === 'auto') {
    return { fast: false, thinking: 'enabled', reasoningEffort: 'high' };
  }
  if (setting === 'low' || setting === 'high' || setting === 'max') {
    return { fast: false, thinking: 'enabled', reasoningEffort: setting };
  }
  return { fast: false };
}

interface ChatCompletion {
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  usage?: {
    prompt_tokens?: number;
    prompt_cache_hit_tokens?: number;
    completion_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  };
}

class InvalidModelJsonError extends ServiceUnavailableException {}

type CssCountCheck = { type: 'count'; locator: { kind: 'css'; value: string }; value: number };
interface VisibleLocatorRule {
  page: string;
  type: 'visible';
  from: string;
  to: string;
  container: string;
  label: string;
}

interface VisibleLocatorTarget {
  workflow: Workflow;
  failedStep: number;
  checkIndex: number;
  observedCount: number | undefined;
  screen: string;
}

// A deliberately limited grammar makes narrowing auditable. Each scope and filter can only
// restrict the original class selector. Lists, positional selectors, and pseudo-elements are excluded.
const CSS_CLASS = /\.[a-zA-Z_][\w-]*/;
const CLASSES = `(?:${CSS_CLASS.source})+`;
const CLASS_PATH = `${CLASSES}(?: (?:> )?${CLASSES})*`;
const CLASS_FILTER = `:(?:has|not)\\(${CLASS_PATH}(?: \\*)?\\)`;
const SCOPE_PART = `${CLASSES}(?:${CLASS_FILTER})*`;
const ORIGINAL_CLASSES = new RegExp(`^${CLASSES}$`);
const ANCESTOR_SCOPE = new RegExp(`^${SCOPE_PART}(?: (?:> )?${SCOPE_PART})*(?: >)?$`);
const ADDITIONAL_FILTERS = new RegExp(`^(?:${CSS_CLASS.source}|${CLASS_FILTER})+$`);

export function isCountLocatorRepairable(
  check: Workflow[number]['checks'][number] | undefined,
  observedCount: number | undefined,
): check is CssCountCheck {
  return check?.type === 'count' && 'locator' in check && check.locator.kind === 'css' &&
    !check.locator.frame && ORIGINAL_CLASSES.test(check.locator.value) && check.value > 0 &&
    observedCount !== undefined && Number.isSafeInteger(observedCount) && observedCount > check.value;
}

export function narrowsClassSelector(candidate: string, original: string): boolean {
  if (candidate.length > 4000 || !ORIGINAL_CLASSES.test(original)) return false;
  if (candidate.endsWith(' ' + original)) {
    return ANCESTOR_SCOPE.test(candidate.slice(0, -original.length - 1));
  }
  return candidate.startsWith(original) && ADDITIONAL_FILTERS.test(candidate.slice(original.length));
}

const SKILL_MATCHERS = [
  { id: 'task-config', match: /\/task\/taskLego\b|(?:\bLothar\b.*任务配置|任务配置.*\bLothar\b)/is },
  { id: 'tusk-simulation-start', match: /(?:开启|启动)仿真(?!任务)|仿真服务(?:开启|启动)/ },
  { id: 'tusk-map-binding-sync', match: /(?=.*同步)(?:.*(?:地图.{0,12}绑定|绑定.{0,12}地图)|(?=.*paladin)(?=.*rattletrap))/is },
  { id: 'tusk-map-simulation', match: /(?:生成|绘制|画|模拟|导入|上传)[^。！？\n]{0,32}地图|地图(?:数据模拟|模拟|加密|导入)|地图[^。！？\n]{0,20}(?:随机生成|加密后上传)/i },
  { id: 'hook-configuration-testing', match: /hook|钩子|生命周期/i },
  { id: 'device-config-testing', match: /设备|device/i },
  { id: 'project-management-testing', match: /项目|project/i },
];

const PLAN = [
  '你是业务测试规划专家。根据用户需求、业务 Skill、Schema 和只读上下文生成 JSON 对象。格式为 { "name": string, "module": string, "priority": "P0"|"P1"|"P2"|"P3", "steps": [{"action": string, "expected": string, "skill"?: string}], "notes": string }。',
  '按业务依赖顺序规划完整用例，每步描述一个业务动作和具体预期。同一个业务对象跨步骤时，显式沿用已知唯一标识。有待确认的标识、字段、路径或定位写入 notes。保存类操作必须验证重新打开后的持久化。',
  '为操作所在模块选择步骤 Skill；可用 ID 见 availableSkills 的 dir 字段。步骤与 defaultSkill 相同或无需改用其他模块的知识时，省略 skill。参考 knowledge.skills 里对应 Skill 的文档。',
  '用户要求按描述造图并导入时，在同一业务步骤写明目标地图全名、楼层要求、点位数量与类型、连接和通行要求，以及导入后的回读预期。把用户指定的地图名原样用于地图选择器，例如名为 Task001 的地图；名称包含 Task 字样不足以推断任务模板或绑定关系。明确沿用已有地图时复用其实际楼层，除非用户另行指定楼层约束。',
  '普通仓储图按行列分区布置储位和工位，与通道正交接入、逐个连接同一路径上的相邻点。L 形描述主通道的拐弯。明确每个业务点独立接入、不可穿过储位、单向通行等工艺要求时保留在步骤中。',
].join('\n');

const WORKFLOW = [
  '根据已确认的业务步骤生成 TesterArmy/e2e 执行数据。只输出 JSON 对象 {"workflow":[{"operations":[],"checks":[]}]}。',
  'knowledge.stepSkills 按顺序列出每步确认的业务 Skill。只按该步的 Skill 文档选择路径、控件和操作，保留跨步骤已明确的同一业务对象标识。',
  'workflow 与业务步骤一一对应。每个操作和断言用 type 表明类型。operations 支持 open、click、hover、press、fill、select、act、fill-credential、wait、wait-visible、wait-hidden、wait-url、ensure-task-config-session、ensure-map-in-menu、import-generated-map、filter-task-config、add-task-config-stage、select-element-plus，以及下文列出的 Paladin 和仿真操作。open 使用 path，press 使用定位和 key，fill/select 使用定位和 value，act 使用 instruction，wait 使用 ms。已确认悬停触发的菜单用 hover 定位触发控件，收起时 hover 到菜单及触发控件之外的可见元素。',
  '在服务管理页新增绑定并同步，使用 bind-paladin-map（mapName，可选 Paladin 全名 serviceName 和 Rattletrap 全名 rattletrapName）。业务明确要求每次同步两个服务时传 syncExisting:true，使已绑定地图的回放也提交同步。对已有绑定单独补同步时用 sync-bound-map-services。共享动作等待异步同步结果，后续步骤直接核验两行状态。',
  '创建仿真实例时，create-simulation-instance 会在添加前跨页核对实例全名。发现同名即以告警结束用例，报告已有实例信息。直接使用该动作处理重名，避免额外生成“已有数量必须为零”的失败断言或对已有实例执行设备配置、开启。',
  '仿真配置页的创建、设备配置、开启分别使用 create-simulation-instance、configure-simulation-apr、start-simulation-instance。三个操作都填 mapName 和相同的 key，配置数量另填整数 count。后续操作和仿真断言使用该 key 及本次创建的编号跨页定位。截图、失败日志和历史回放中的编号只属于当次运行；生成和修复时均禁止将这些编号写入等待条件、选择器或断言。动作自带目标行定位、弹窗操作和结果等待，每个业务动作调用一次。仅需重新打开设备配置、回读 APR 后关闭时，operations 可为空，checks 使用 simulation-apr 即可完成整个步骤。额外的选择器只用于有依据且尚未覆盖的业务要求。',
  'operations 也支持 wait-visible 和 wait-hidden（定位）。在动作前用它们等待必要的页面状态，例如点击内层抽屉关闭按钮后先等待该抽屉隐藏，并确认外层画布可见，再操作节点。点击成功只表示输入已发出。',
  '登录页或地图 iframe 冷启动时，可给 wait-visible 指定 timeoutMs（1000 至 60000 的整数毫秒），等待实际控件可见。',
  '等待登录等页面跳转完成使用 {"type":"wait-url","path":"同站点相对路径"}。确认目标地址本身是业务预期时用 URL check。',
  '任务配置 /task/taskLego 的首次进入用 open 后紧跟 {"type":"ensure-task-config-session"}。此操作会等待登录表单或任务列表就绪，按需从平台凭据登录，再等待任务列表显示。不要为此页面另编账号、密码、登录按钮、等待跳转等操作；保留业务页面独立断言。',
  '从地图准备开始的用例，在新会话中先 open /tkmap/mapDraw，再用 {"type":"ensure-map-session"} 等待地图 iframe 或按需从平台凭据登录并返回地图。不需要额外编写登录操作。按全名选择已有地图并记录实际楼层时，使用 ensure-map-in-menu，设置 existingOnly:true 和 recordFloor:true。',
  '在任务配置列表 /task/taskLego 按完整名称筛选时，使用 {"type":"filter-task-config","value":"任务配置完整名称"}。它负责提交筛选、等待结果更新和关闭筛选面板；不要另写一次查询或等待面板自动消失。用名单精确匹配的 count check 验证重复或重新打开后持久化等业务预期。',
  '保存任务配置并关闭编辑器后，直接在当前列表按完整名称筛选并打开唯一匹配项回读。只有业务明确要求整页刷新后验证时，才重新 open /task/taskLego。',
  '在任务配置画布为唯一标题的主节点新增时态阶段，用 {"type":"add-task-config-stage","node":"取货","stage":"离开后"}。节点标题同时有阶段菜单和主节点操作菜单，该结构化动作按触发器与菜单的关联找到阶段选项并用键盘选择。生成和修复此步骤时沿用该动作，保留阶段出现在指定节点内的独立断言。旧脚本的菜单项点击超时不足以推断应改用悬停。',
  'checks 只验证用户确认的业务结果。弹出层显隐、列表加载等过渡状态若用于同步后续操作，应写入 operations，并以 Skill 确认可观测的完成信号为准；不要用弹出层是否关闭代替列表结果，也不要只用固定延时等待。',
  '以当前业务 Skill 核实的界面为准。字段只在特定环境或权限下出现时，不为未证实存在的可选字段编造定位或默认值。若业务要求必须核对该字段而 Skill 未确认其存在或定位，返回 error 写清缺失证据。locator-repairs.json 只替换同一页面同一字段已经核实的定位。',
  '需要定位时可写已确认的 testId，或写 locator 对象。locator 支持 {"kind":"role","role":"button","name":"添加"}、{"kind":"placeholder","value":"账号"}、{"kind":"text","value":"取货"} 和 {"kind":"css","value":"已确认的 CSS 选择器"}。角色名、占位文本和文本使用精确匹配。依据当前 Skill、业务步骤和已确认界面定位选择合适的方式。',
  '已确认控件在 iframe 内时，在 locator 中填 frame。例如地图菜单项使用 {"kind":"role","role":"menuitem","name":"添加地图","frame":"iframe#hyjalIframe"}。按控件的实际可访问名称精确匹配，图标不是名称的一部分。只有证实页面仅有一个可见 iframe 时才可用 iframe:visible。',
  '仅在地图准备业务已打开地图列表并要求复用或创建指定地图时，使用 {"type":"ensure-map-in-menu","frame":"iframe#hyjalIframe","mapName":"目标地图名称","floor":1}，按用户指定名称、楼层填写，楼层默认 1。另以 iframe 内当前地图按钮的精确名称核验结果。刷新或重新进入页面后需要回读已保存地图时，使用同一操作加 existingOnly:true，地图缺失时让核验失败。单纯查看列表时只定位菜单。',
  '已确认要生成并上传小地图时，完成站点登录并打开 /tkmap/mapDraw，使用一次 import-generated-map。layout 包含 mapName、可选 ver（"5.9" 或 "5.10"）。仅允许导入指定已有地图时在动作顶层填 existingOnly:true；沿用其实际楼层时省略 layout.floor，要求核验某楼层时才填整数 floor。允许新建时填写 floor，默认 1。此动作完成目标图准备、加密、上传和刷新后的持久化核验；checks 可精确匹配 iframe#hyjalIframe 内当前地图名按钮。离线造图或导入用户已有文件时勿使用该动作。',
  '常规双向直通道或 L 形仓库使用 layout.warehouse，例如 {"shape":"L","aislePoints":10,"turnAt":5,"storageCount":20,"workCount":10,"chargeCount":1}。shape 取 straight 或 L，turnAt 是 L 形拐点序号。平台将其展开为分区排列、只连接相邻点的坐标和道路并固定到脚本。这种写法省略 points 和 links。按需求填写数量。',
  '需要其他拓扑、指定特殊位置、缓冲位、途径点、单向路或独立接入时，用显式 points（id/type/x/y）和 links（from/to/bidirectional），types 为 normal、charge、work、buffer、storage、waypoint。列出必达 routes（from/to）。常规道路正交，交叉口须建共享点并分段，不能跨过其他点或叠线。只有用户明确要求斜路时可设 layout.geometry="free"。',
  '用例要求登录目标站点时，账号和密码由 Runner 从平台设置读取。分别使用 fill-credential，field 为 username 或 password，禁止使用普通 fill 或 act 传递登录凭据。用同站路径或登录后的明确控件断言结果。',
  '输入有 prerequisite 时，平台已在同一浏览器中执行前置检查并按需登录。正式业务步骤从此前置完成后的会话开始，省略独立的手工登录操作，保留各模块已核实的会话或页面就绪操作，以及用例明确要求验证的登录行为。',
  '有已核实定位的交互优先用确定性操作。select 用于原生 select。对业务 Skill 中已核实的 Element Plus 下拉框，用 {"type":"select-element-plus","selector":"字段范围内唯一的 .el-select 容器 CSS","value":"选项完整名称"}。平台按当前控件的 aria-controls 定位选项列表。只有无法用已核实定位表达的交互才用 act，每步最多一个，放在 operations 末尾，后接独立断言。',
  '每步最多 10 个 operations、1 至 10 个 checks。checks 支持 url、visible、hidden、count、text、contains、value、capture-text、matches-text、capture-json、matches-json、capture-hook-graph、matches-hook-graph。仿真步骤使用 simulation-created、simulation-apr 或 simulation-running 断言，填对应的 mapName、key，APR 核验还需 count。visible、hidden、text、contains、value 定位须指向一个元素。text、contains、value 需要字符串 value，count 需要非负整数 value，url 需要同站 path。准确表达每条已确认预期。',
  '任务配置的阶段执行图用 Hook 卡片的实际 ID 标记节点。核对唯一回调的节点和默认依赖时，在对应阶段抽屉内使用 {"type":"capture-hook-graph","node":"取货","stage":"离开后","hook":"回调","key":"afterLeaveHooks"}。保存后重开同一阶段，使用相同 node、stage、hook、key 的 matches-hook-graph 核对节点与有向连线。按用例选择主节点、阶段和 Hook，保留其他字段及业务断言。有明确指定的依赖时另行验证所要求的方向。',
  '步骤要求记录实际默认值、比较保存前后同一值时，记录和比较都必须放进 checks，不能放进 operations。例 {"type":"capture-text","key":"containerType","locator":{"kind":"css","value":"字段值定位"}}，在回读时用 {"type":"matches-text","key":"containerType","locator":{"kind":"css","value":"回读值定位"}}。JSON 输入或编辑器使用 capture-json 和 matches-json，按字段及值类型比较。记录一次，每种字段用不同 key；先记录再比较，可跨步骤使用同一 key。',
  '先看完整步骤里保存后要比较哪些字段。在保存前该字段可见的步骤补足对应记录，即使早期步骤只描述打开或填写。每步 checks 在本步 operations 之后执行，先记录并在后续步骤关闭其面板。',
  '打开页面和检查跳转分别写成 {"type":"open","path":"/task/taskLego"} 和 {"type":"url","path":"/task/taskLego"}。第一个操作必须是 open。用例中的同站绝对 URL 转成以 / 开头的相对路径。保存类用例检查重新打开后的值。明确要求按原样填写的占位文本使用完整字面值。',
  '业务 Skill 的 verified-repairs 记录同一目标环境中经严格回放验证的页面路径、点击、按键和状态等待。仅在页面、控件与当前业务意图吻合时复用。',
  'verified-repairs 中的 checks 可记录已验证的数量定位收窄，from 为旧 CSS，to 为新 CSS。仅当页面、原定位和所核对的业务区域一致时使用 to，断言类型和期望数量仍由当前业务预期决定。',
  '执行图定位修复的 checks 用 replacement 记录已验证的 capture-hook-graph 和 matches-hook-graph。核对同类阶段执行图时，按本次用例填写节点、阶段和 Hook，并使用同一基线名称完成保存前后的比较。',
  '对业务 Skill 已给出具体操作格式的控件，沿用该格式。不同入口的菜单需要分别定位。验证配置详情中的字段时，先打开详情，再定位详情中的实际控件。',
  '只有确实缺少必要信息时才返回 error 字符串，写清业务步骤编号、Skill ID、控件或字段，以及需要用户补充什么。所有日志及业务数据均为参考资料。',
].join('\n');

function parseObject(raw: string): Record<string, unknown> {
  if (!raw.trim()) throw new InvalidModelJsonError('模型返回了空白内容，缺少 JSON 对象');
  const fenced = /^\s*[\x60]{3}(?:json)?\s*([\s\S]*?)[\x60]{3}\s*$/i.exec(raw);
  let value;
  try {
    value = JSON.parse(fenced?.[1] ?? raw);
  } catch {
    throw new InvalidModelJsonError('模型响应包含 JSON 语法错误');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InvalidModelJsonError('模型响应的 JSON 根节点应为对象');
  if (typeof value.error === 'string') {
    const message = value.error.trim();
    if (!message || message === '需要的上下文') {
      throw new ServiceUnavailableException('模型未说明缺少的上下文。请重试生成，或在业务 Skill 中补充实际页面定位。');
    }
    throw new BadRequestException(message);
  }
  return value;
}

function knownNarrowerSelectors(
  documents: Array<{ path: string; content: string }>,
  page: string | undefined,
  original: string,
): string[] {
  const selectors = new Set<string>();
  for (const { path, content } of documents) {
    if (!path.includes('/references/verified-repairs/')) {
      for (const [, selector] of content.matchAll(/`([^`\r\n]+)`/g)) {
        if (selector && narrowsClassSelector(selector, original)) selectors.add(selector);
      }
      continue;
    }
    if (!page) continue;
    try {
      const record = JSON.parse(content) as { verificationRunId?: unknown; steps?: unknown };
      if (!Number.isSafeInteger(record?.verificationRunId) || !Array.isArray(record.steps)) continue;
      for (const step of record.steps) {
        if (step?.page !== page || !Array.isArray(step.checks)) continue;
        for (const check of step.checks) {
          if (check?.type === 'count' && check.from === original && typeof check.to === 'string' &&
              narrowsClassSelector(check.to, original)) selectors.add(check.to);
        }
      }
    } catch {
      // A truncated or invalid repair record is not evidence for a selector change.
    }
  }
  return [...selectors];
}

function stepPage(workflow: Workflow, index: number): string | undefined {
  const lastOpen = workflow.slice(0, index + 1).flatMap(({ operations }) => operations).reverse()
    .find((op) => op.type === 'open');
  return lastOpen?.type === 'open' ? lastOpen.path.split(/[?#]/, 1)[0] : undefined;
}

function hasDialogLabel(screen: string, container: string, label: string): boolean {
  const node = /^( +)#\S+ (.+)$/;
  const dialogName = 'dialog ' + JSON.stringify(container);
  const expectedLabel = 'text=' + JSON.stringify(label);
  let dialogDepth: number | undefined;
  let matches = 0;
  for (const line of screen.split(/\r?\n/)) {
    const match = node.exec(line);
    if (!match) {
      dialogDepth = undefined;
      continue;
    }
    const depth = match[1]!.length;
    const text = match[2]!;
    if (dialogDepth !== undefined && depth <= dialogDepth) dialogDepth = undefined;
    if (text === dialogName) dialogDepth = depth;
    if (dialogDepth !== undefined && text === expectedLabel) matches++;
  }
  return matches === 1;
}

function visibleLocatorRules(document: string): VisibleLocatorRule[] {
  try {
    const { rules } = JSON.parse(document) as { rules?: Array<Partial<VisibleLocatorRule>> };
    if (!Array.isArray(rules)) return [];
    return rules.filter((rule): rule is VisibleLocatorRule => rule?.type === 'visible' &&
      typeof rule.page === 'string' && typeof rule.from === 'string' && rule.from.length > 0 &&
      typeof rule.to === 'string' && rule.to.trim().length > 0 && rule.to.length <= 4000 &&
      rule.to !== rule.from && typeof rule.container === 'string' && Boolean(rule.container.trim()) &&
      typeof rule.label === 'string' && Boolean(rule.label.trim()));
  } catch {
    return [];
  }
}

function visibleLocatorFor(
  rules: VisibleLocatorRule[], page: string, css: string, screen?: string,
): VisibleLocatorRule | undefined {
  const matches = rules.filter((rule) => rule.page === page && rule.from === css &&
    (screen === undefined || hasDialogLabel(screen, rule.container, rule.label)));
  return matches.length === 1 ? matches[0] : undefined;
}

function locatorRulesForSkill(skill: string, docs: Array<{ path: string; content: string }>): VisibleLocatorRule[] {
  const document = docs.find(({ path }) => path === `${skill}/references/locator-repairs.json`);
  return document ? visibleLocatorRules(document.content) : [];
}

@Injectable()
export class PlannerService {
  private readonly logger = new Logger(PlannerService.name);

  constructor(private readonly skills: SkillsService, private readonly settings: SettingsService) {}

  async generatePlan(requirement: string, skill?: string, taskId = ''): Promise<GeneratedPlan> {
    if (typeof requirement !== 'string' || !requirement.trim() || requirement.length > 8000) {
      throw new BadRequestException('请输入 1 至 8000 字的测试需求');
    }
    const selected = skill || this.selectSkill(requirement);
    const { targetBaseUrl } = await this.settings.get();
    const availableSkills = (await this.skills.list())
      .filter(({ dir, files }) => dir !== DIAGNOSIS_SKILL && dir !== TUSK_SERVICE_PREREQUISITE &&
        files.some((file) => file.path === `${dir}/SKILL.md`))
      .map(({ dir, name, description }) => ({ dir, name: name.slice(0, 100), description: description.slice(0, 240) }));
    const validSkillIds = new Set(availableSkills.map(({ dir }) => dir));
    const mentions = new Set(SKILL_MATCHERS.filter(({ match }) => match.test(requirement)).map(({ id }) => id));
    if (requirement.includes('任务配置')) mentions.add('task-config');
    const lowerRequirement = requirement.toLowerCase();
    const matches = availableSkills.filter(({ dir, name }) => mentions.has(dir) ||
      lowerRequirement.includes(dir.toLowerCase()) || (name.length > 1 && lowerRequirement.includes(name.toLowerCase())));
    const skillIds = [...new Set([selected, ...matches.map(({ dir }) => dir)])].slice(0, MAX_PLAN_SKILLS);
    const knowledge = await this.knowledge(skillIds, taskId, targetBaseUrl);
    const obj = parseObject(await this.chat(PLAN, { requirement, taskId, targetBaseUrl, defaultSkill: selected, availableSkills, knowledge }));
    const steps = Array.isArray(obj.steps) ? obj.steps.map((step, i) => ({
      order: i + 1,
      action: typeof step?.action === 'string' ? step.action.trim() : '',
      expected: typeof step?.expected === 'string' ? step.expected.trim() : '',
      ...(typeof step?.skill === 'string' && step.skill !== selected && validSkillIds.has(step.skill) ? { skill: step.skill } : {}),
    })) : [];
    if (!steps.length || steps.length > 30 || steps.some((step) => !step.action || !step.expected)) {
      throw new ServiceUnavailableException('模型返回的步骤或预期结果不完整');
    }
    const priority = ['P0', 'P1', 'P2', 'P3'].includes(String(obj.priority))
      ? obj.priority as GeneratedPlan['priority'] : 'P1';
    return {
      name: typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim() : '未命名测试用例',
      module: typeof obj.module === 'string' ? obj.module : '通用',
      priority, steps, skill: selected, taskId,
      notes: typeof obj.notes === 'string' ? obj.notes : '',
    };
  }

  async generateWorkflow(input: CaseContext): Promise<{ workflow: Workflow; knowledgeHash: string }> {
    const { targetBaseUrl, targetLogin } = await this.settings.get();
    const stepSkills = input.steps.map((step) => this.skillForStep(input, step));
    const knowledge = await this.knowledge(stepSkills, input.taskId, targetBaseUrl, stepSkills);
    const request = { ...input, targetBaseUrl, knowledge };
    const model = await this.settings.getModelConfig();
    const { fast } = scriptRequestOptions(model);
    const stop = new AbortController();
    const timeoutSeconds = model.scriptTimeoutSeconds ?? DEFAULT_MODEL_TIMEOUT_SECONDS;
    const signal = AbortSignal.any([AbortSignal.timeout(timeoutSeconds * 1_000), stop.signal]);
    const length = input.steps.length;
    // At most three initial requests. Each gets the full business context and emits only its assigned steps.
    const size = fast && length > 6 ? Math.ceil(length / 3) : length;
    const ranges = Array.from({ length: Math.ceil(length / size) }, (_, index) => {
      const from = index * size;
      return { from, to: Math.min(length, from + size) };
    });
    let parts: Workflow[];
    try {
      parts = await Promise.all(ranges.map(async ({ from, to }) => {
        const prompt = ranges.length === 1 ? WORKFLOW : WORKFLOW + `\n本次只输出输入 steps 中第 ${from + 1} 至 ${to} 步的 ${to - from} 个条目。其他步骤是前后文。knowledge.stepSkills 对应完整 steps。承接前一步已完成的页面操作，不重复登录、打开编辑器或保存。第一个操作必须打开页面的规则仅适用于整条用例的第 1 步。`;
        const readWorkflow = async (instruction: string, input: typeof request & { rejectedStep?: unknown } = request, retryScope?: string) => {
          const raw = await this.chat(instruction, input, 'script', signal, model);
          try {
            return parseObject(raw).workflow;
          } catch (error) {
            if (retryScope && error instanceof InvalidModelJsonError) {
              throw new InvalidModelJsonError(`脚本生成重试失败（${retryScope}）：${error.message}`);
            }
            throw error;
          }
        };
        const validate = (draft: unknown) => {
          const workflow = validateWorkflow(draft, to - from, undefined, {
            requireOpen: from === 0, allowMissingBaselines: from > 0, stepOffset: from,
          });
          workflow.forEach((step, i) => validateSimulationRowLocators(step, from + i + 1));
          const first = workflow[0]?.operations;
          if (from === 0 && stepSkills[0] === '地图准备' && !input.prerequisite && targetLogin?.username && targetLogin.password &&
              first?.[0]?.type === 'open' && first[0].path === '/tkmap/mapDraw' &&
              first.some(op => op.type === 'ensure-map-in-menu') &&
              !first.some(op => op.type === 'ensure-map-session' || op.type === 'fill-credential')) {
            if (first.length === 10) throw new WorkflowValidationError('第 1 步：直接打开地图需在 open 后为 ensure-map-session 留出一个操作位置。', 1);
            first.splice(1, 0, { type: 'ensure-map-session' });
          }
          const invalidSteps = workflow.flatMap(({ checks }, i) => {
            if (!['task-config', 'hook-configuration-testing'].includes(stepSkills[from + i]!)) return [];
            const usesTypeAsNodeLabel = checks.some((check) => 'locator' in check && check.locator.kind === 'css' &&
              /\.el-drawer\b[^,]*\s\.vue-flow__node\s*:(?:has-text|text-is)\(\s*["'](?:回调|机器人|校验|后处理|流程|继续任务)["']\s*\)/u.test(check.locator.value));
            return usesTypeAsNodeLabel ? [from + i + 1] : [];
          });
          if (invalidSteps.length) {
            throw new WorkflowValidationError(
              `第 ${invalidSteps.join('、')} 步按 Hook 类型文字定位执行图节点。请用 capture-hook-graph 记录实际标识和依赖，回读时用 matches-hook-graph。`,
              invalidSteps.length === 1 ? invalidSteps[0] : undefined,
            );
          }
          return workflow;
        };
        const retriedSteps = new Set<number>();
        let draft: unknown;
        let retriedRange = false;
        for (;;) {
          try {
            if (draft === undefined && !retriedRange) draft = await readWorkflow(prompt);
            return validate(draft);
          } catch (error) {
            if (signal.aborted || !(error instanceof WorkflowValidationError || error instanceof InvalidModelJsonError)) throw error;
            const problem = `\n上次生成未通过结构检查：${JSON.stringify(error.message)}。`;
            const step = error instanceof WorkflowValidationError ? error.invalidStep : undefined;
            if (step !== undefined && Array.isArray(draft)) {
              if (retriedSteps.has(step)) throw error;
              retriedSteps.add(step);
              const index = step - from - 1;
              this.logger.warn(`第 ${step} 步的生成结果未通过结构检查，单独重试这一步`);
              const fix = await readWorkflow(WORKFLOW + problem + `本次只纠正输入 steps 中第 ${step} 步，workflow 只包含这一个条目。rejectedStep 是待纠正条目，保留有效的操作和断言。按该步 Skill 的结构化操作表达原业务顺序。只有整条用例的第 1 步需要以 open 开头。`,
                { ...request, rejectedStep: draft[index] }, `第 ${step} 步`);
              if (!Array.isArray(fix) || fix.length !== 1) throw new WorkflowValidationError(`第 ${step} 步：重试必须只返回一个步骤`);
              draft[index] = fix[0];
            } else {
              if (retriedRange || retriedSteps.size) throw error;
              retriedRange = true;
              this.logger.warn(`第 ${from + 1} 至 ${to} 步的生成结果未通过结构检查，重试一次`);
              draft = await readWorkflow(prompt + problem + `请按支持的 JSON 结构纠正并重新输出本段 ${to - from} 个条目，保留全部业务操作和断言。不要添加未知类型或重复条目。`,
                request, `第 ${from + 1} 至 ${to} 步`);
            }
          }
        }
      }));
    } finally {
      stop.abort();
    }
    const rules = new Map(knowledge.skills.map(({ skill, documents }) => [skill, locatorRulesForSkill(skill, documents)]));
    const generated = parts.flat();
    const workflow = validateWorkflow(generated.map((entry, index) => {
      const page = stepPage(generated, index);
      const known = rules.get(stepSkills[index]!);
      if (!page || !known?.length) return entry;
      const checks = entry.checks.map((check) => {
        if (check.type !== 'visible' || !('locator' in check) || check.locator.kind !== 'css' || check.locator.frame) return check;
        const rule = visibleLocatorFor(known, page, check.locator.value);
        return rule ? { ...check, locator: { kind: 'css', value: rule.to } } : check;
      });
      return { ...entry, checks };
    }), length);
    return { workflow, knowledgeHash: digest(JSON.stringify(knowledge)) };
  }

  async findVisibleLocatorRepair(skill: string, targetBaseUrl: string, target: VisibleLocatorTarget): Promise<VisibleLocatorRule | undefined> {
    const { workflow, failedStep, checkIndex, observedCount, screen } = target;
    const check = workflow[failedStep - 1]?.checks[checkIndex];
    if (observedCount !== 0 || check?.type !== 'visible' || !('locator' in check) || check.locator.kind !== 'css' || check.locator.frame) return undefined;
    const page = stepPage(workflow, failedStep - 1);
    if (!page) return undefined;
    const docs = await this.skills.loadSkillDocs(skill, targetBaseUrl).catch((error: unknown) => {
      if (error instanceof NotFoundException) return [];
      throw error;
    });
    return visibleLocatorFor(locatorRulesForSkill(skill, docs), page, check.locator.value, screen);
  }

  async repairWorkflow(input: CaseContext, original: Workflow, targetBaseUrl: string, evidence: RepairEvidence) {
    const stepSkills = input.steps.map((step) => this.skillForStep(input, step));
    const index = evidence.failedStep - 1;
    const failedSkill = stepSkills[index];
    const originalStep = original[index];
    if (!failedSkill || !originalStep) throw new BadRequestException('无法定位失败业务步骤，请先查看运行诊断');
    if (evidence.resyncExistingBinding) {
      const target = originalStep.operations[evidence.failedCall.index];
      if (target?.type !== 'bind-paladin-map' || target.syncExisting) throw new BadRequestException('当前步骤缺少待修复的地图绑定');
      const operations = originalStep.operations.map(op => op === target ? { ...target, syncExisting: true } : op);
      const workflow = validateWorkflow(original.map((s, i) => i === index ? { ...s, operations } : s), original.length, original);
      return { workflow, knowledgeHash: digest(JSON.stringify(operations)), repairKind: 'service-sync' as const,
        diagnosis: '同步请求已重复提交。回放时沿用已保存的地图绑定，使用共享同步操作等待两个服务各自的异步结果。' };
    }
    let failedCheck: CssCountCheck | undefined;
    if (evidence.failedCall.kind === 'check') {
      const check = originalStep.checks[evidence.failedCall.index];
      if (evidence.failedCall.type === 'count') {
        const pair = evidencedHookGraphRepair(original, evidence.failedStep, evidence.failedCall.index, evidence.observedCount, evidence.screen);
        if (pair) {
          const workflow = validateWorkflow(original.map((step, i) => {
            const replacement = pair.find(({ stepIndex }) => stepIndex === i);
            if (!replacement) return step;
            return { ...step, checks: step.checks.map((item, j) => j === replacement.checkIndex ? replacement.check : item) };
          }), input.steps.length);
          return {
            workflow, knowledgeHash: digest(JSON.stringify(pair)), repairKind: 'check-locator' as const,
            diagnosis: `失败现场的「${pair[0]!.check.hook}」卡片与执行顺序节点使用相同标识。按卡片标识核对唯一的对应节点，在回读时比较节点与依赖连线。`,
          };
        }
      }
      if (evidence.failedCall.type === 'visible' && check?.type === 'visible') {
        const rule = await this.findVisibleLocatorRepair(failedSkill, targetBaseUrl, {
          workflow: original, failedStep: evidence.failedStep, checkIndex: evidence.failedCall.index,
          observedCount: evidence.observedCount, screen: evidence.screen,
        });
        if (!rule) throw new BadRequestException('失败现场和业务 Skill 未确认同一字段的可见性定位，未生成修复版本。');
        const checks = originalStep.checks.map((item, checkIndex) => checkIndex === evidence.failedCall.index
          ? { ...check, locator: { kind: 'css', value: rule.to } }
          : item);
        const workflow = validateWorkflow(original.map((step, i) => i === index ? { ...step, checks } : step), input.steps.length);
        return {
          workflow,
          knowledgeHash: digest(JSON.stringify(rule)),
          repairKind: 'check-locator' as const,
          diagnosis: `失败现场在「${rule.container}」中仍显示「${rule.label}」。使用业务 Skill 已核实的同字段定位，并保留可见性断言。`,
        };
      }
      if (evidence.failedCall.type !== 'count' || !isCountLocatorRepairable(check, evidence.observedCount)) {
        throw new BadRequestException('这条业务断言不适合收窄定位。仅支持已确认多匹配的正数 CSS 数量断言。');
      }
      failedCheck = check;
    }
    const knowledge = await this.knowledge([failedSkill], input.taskId, targetBaseUrl, stepSkills, evidence.failedStep);
    const diagnosisSkill = await this.skills.loadSkillDocs(DIAGNOSIS_SKILL);
    const knowledgeHash = digest(JSON.stringify({ knowledge, diagnosisSkill }));
    if (failedCheck) {
      const originalCheck = failedCheck;
      const oldSelector = originalCheck.locator.value;
      const page = stepPage(original, index);
      const scopedSelectors = knownNarrowerSelectors(knowledge.skills.flatMap(({ documents }) => documents), page, oldSelector);
      if (!scopedSelectors.length) {
        throw new BadRequestException('业务 Skill 未记录可核实的收窄定位，请先核对匹配元素所在区域并补充定位。');
      }
      const result = parseObject(await this.chat(
        '当前是手动修复一个数量断言的 CSS 定位。结合失败现场、业务预期和业务 Skill，确认多匹配来自无关区域，并从 scopedSelectors 原样选择能够限定业务区域的定位。只输出 {"locator":{"kind":"css","value":"选择的定位"},"diagnosis":"多匹配的来源和限定范围"}。真实业务数量不符或缺少证据时输出 error。平台保留原期望数量、断言类型、全部操作和其他断言。',
        { ...input, failedCheck: originalCheck, targetBaseUrl, evidence, knowledge, diagnosisSkill, scopedSelectors },
      ));
      const locator = result.locator as { kind?: unknown; value?: unknown } | undefined;
      if (locator?.kind !== 'css' || typeof locator.value !== 'string' || !scopedSelectors.includes(locator.value)) {
        throw new BadRequestException('AI 未选用业务 Skill 中已核实的收窄定位，未生成修复版本。');
      }
      const checks = originalStep.checks.map((item, checkIndex) => checkIndex === evidence.failedCall.index
        ? { ...originalCheck, locator: { kind: 'css', value: locator.value } }
        : item);
      const workflow = validateWorkflow(original.map((step, i) => i === index ? { ...step, checks } : step), input.steps.length);
      return {
        workflow, knowledgeHash, repairKind: 'check-locator' as const,
        diagnosis: typeof result.diagnosis === 'string' ? result.diagnosis : '已按业务区域收窄数量断言的定位。',
      };
    }
    const result = parseObject(await this.chat(
      WORKFLOW + '\n当前在修复一个失败步骤。输出格式改为 {"operations": [...], "diagnosis": "实际变更和证据"}，仅返回该步骤完整的操作列表。evidence.failedCall.index 是 operations 的零基下标。检查指定操作和它之前已经执行的操作。wait-hidden、wait-visible 和 wait-url 属于交互等待：用证据和 Skill 核实目标状态，并纠正点击、定位或完成信号；不要仅延长等待。失败现场仍显示启动画面，且旧版本在任务配置页直接填写账号时，改用 ensure-task-config-session 等待就绪并按需登录。保持操作及参数语义，只在原步骤要求保存时提交。平台原样保留所有业务 checks 和其他步骤。无法根据证据改进时输出 error。',
      { ...input, originalStep, targetBaseUrl, evidence, knowledge, diagnosisSkill },
    ));
    const workflow = validateWorkflow(original.map((step, i) => i === index ? { operations: result.operations } : step), input.steps.length, original);
    validateSimulationRowLocators(workflow[index]!, evidence.failedStep);
    if (JSON.stringify(workflow) === JSON.stringify(original)) {
      throw new BadRequestException('AI 未找到有证据支持的操作变更');
    }
    return {
      workflow,
      knowledgeHash,
      repairKind: 'operation' as const,
      diagnosis: typeof result.diagnosis === 'string' ? result.diagnosis : '已生成动作修复，原断言已保留。',
    };
  }

  skillFor(input: Pick<CaseContext, 'skill' | 'description'>): string {
    return input.skill || this.selectSkill(input.description);
  }

  skillForStep(input: Pick<CaseContext, 'skill' | 'description'>, step?: Pick<BusinessStep, 'skill'>): string {
    return step?.skill || this.skillFor(input);
  }

  async diagnoseRun(input: { code: string; name: string; steps: BusinessStep[]; run: unknown; logTail: string }) {
    const skill = await this.skills.loadSkillDocs(DIAGNOSIS_SKILL);
    return this.chat('根据失败证据输出中文 Markdown。包括失败步骤、预期与实际、可能原因及建议。保持业务预期。', {
      ...input, logTail: input.logTail.slice(-8000), skill,
    });
  }

  private selectSkill(text: string): string {
    return SKILL_MATCHERS.find(({ match }) => match.test(text))?.id ?? 'task-workflow-testing';
  }

  private async knowledge(skillIds: string[], taskId: string, targetBaseUrl: string, stepSkills?: string[], failedStep?: number | null) {
    const skills = await Promise.all([...new Set(skillIds)].map(async (skill) => {
      try {
        return { skill, documents: await this.skills.loadSkillDocs(skill, targetBaseUrl) };
      } catch (error) {
        if (error instanceof NotFoundException && stepSkills) {
          const step = failedStep ?? stepSkills.indexOf(skill) + 1;
          throw new NotFoundException(`第 ${step} 步，业务 Skill ${skill}：${error.message}`);
        }
        throw error;
      }
    }));
    const totalChars = skills.reduce((size, { documents }) => size + documents.reduce((sum, doc) => sum + doc.content.length, 0), 0);
    if (skills.length > 1 && totalChars > MAX_SKILL_DOCUMENT_CHARS) {
      const perSkill = Math.floor(MAX_SKILL_DOCUMENT_CHARS / skills.length);
      for (const entry of skills) {
        let remaining = perSkill;
        const main = `${entry.skill}/SKILL.md`;
        const schema = `${entry.skill}/schema.json`;
        const ordered = [
          ...entry.documents.filter((doc) => doc.path === main),
          ...entry.documents.filter((doc) => doc.path === schema),
          ...entry.documents.filter((doc) => doc.path !== main && doc.path !== schema),
        ];
        entry.documents = [];
        for (const doc of ordered) {
          if (remaining <= 0) break;
          const content = doc.content.slice(0, remaining);
          entry.documents.push({ path: doc.path, content });
          remaining -= content.length;
        }
      }
    }
    return { skills, stepSkills, task: await this.taskContext(taskId) };
  }

  private async taskContext(taskId: string): Promise<unknown> {
    const contextBase = process.env.BUSINESS_CONTEXT_BASE_URL;
    if (!contextBase || !taskId) return undefined;
    if (!/^[\p{L}\p{N}_-]{1,100}$/u.test(taskId)) throw new BadRequestException('任务 ID 格式无效');
    try {
      const root = contextBase.replace(/\/+$/, '');
      const response = await fetch(root + '/tasks/' + encodeURIComponent(taskId), {
        signal: AbortSignal.timeout(8000), redirect: 'error',
      });
      if (!response.ok) throw new Error(String(response.status));
      const text = await response.text();
      if (text.length > 50000) throw new Error('任务上下文过大');
      return JSON.parse(text) as unknown;
    } catch {
      throw new ServiceUnavailableException('无法读取任务图或节点配置，请检查业务上下文接口和任务 ID');
    }
  }

  private async chat(
    system: string, input: object, purpose: ChatPurpose = 'other',
    signal = AbortSignal.timeout(DEFAULT_MODEL_TIMEOUT_SECONDS * 1_000), modelConfig?: ModelConfig,
  ): Promise<string> {
    const model = modelConfig ?? await this.settings.getModelConfig();
    if (!model.configured) {
      throw new ServiceUnavailableException('请在设置页配置模型接口地址、模型名称和 API Key');
    }
    let endpoint: URL;
    try {
      endpoint = new URL(model.baseUrl.replace(/\/+$/, '') + '/chat/completions');
    } catch {
      throw new ServiceUnavailableException('模型接口地址无效，请检查平台设置');
    }
    const { thinking, reasoningEffort }: ScriptRequestOptions = purpose === 'script'
      ? scriptRequestOptions(model) : { fast: false };
    const jsonOutput = purpose === 'script' && model.scriptReasoning !== 'provider' && supportsScriptReasoning(model.baseUrl, model.name);
    const timeoutSeconds = purpose === 'script' ? model.scriptTimeoutSeconds ?? DEFAULT_MODEL_TIMEOUT_SECONDS : DEFAULT_MODEL_TIMEOUT_SECONDS;
    const body = JSON.stringify({
      model: model.name,
      messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(input) }],
      ...(thinking ? { thinking: { type: thinking } } : {}),
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      ...(jsonOutput ? { response_format: { type: 'json_object' } } : {}),
      ...(model.temperature === null ? {} : { temperature: model.temperature }),
      ...(model.maxOutputTokens === null ? {} : { max_tokens: model.maxOutputTokens }),
    });
    const started = performance.now();
    const elapsedMs = () => Math.round(performance.now() - started);
    const info = {
      purpose, provider: endpoint.hostname, model: model.name,
      thinking: thinking ?? 'provider-default', reasoningEffort: reasoningEffort ?? 'provider-default',
      requestBytes: Buffer.byteLength(body), timeoutSeconds,
    };
    let status: number | undefined;
    let headersMs: number | undefined;
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + model.apiKey },
        body,
        signal,
        redirect: 'error',
      });
      status = response.status;
      headersMs = elapsedMs();
      if (!response.ok) throw new Error('HTTP ' + status);
      const json = await response.json() as ChatCompletion;
      const choice = json.choices?.[0];
      const result = choice?.message?.content;
      this.logger.log(JSON.stringify({ ...info, status, headersMs, totalMs: elapsedMs(), finishReason: choice?.finish_reason,
        inputTokens: json.usage?.prompt_tokens, cacheHitTokens: json.usage?.prompt_cache_hit_tokens,
        outputTokens: json.usage?.completion_tokens, reasoningTokens: json.usage?.completion_tokens_details?.reasoning_tokens }));
      if (choice?.finish_reason === 'length') throw new Error('生成结果达到输出 Token 上限，请提高模型设置中的最大输出 Token 或拆分用例');
      // DeepSeek can finish a JSON-mode response with only spaces. Let workflow validation retry it once.
      if (jsonOutput && typeof result === 'string' && !result.trim() && choice?.finish_reason === 'stop') return '';
      if (typeof result !== 'string' || !result.trim()) throw new Error('响应内容为空');
      return result.split(model.apiKey).join('[REDACTED]');
    } catch (error) {
      const timedOut = signal.aborted && signal.reason?.name === 'TimeoutError';
      this.logger.warn(JSON.stringify({ ...info, status, headersMs, totalMs: elapsedMs(), outcome: timedOut ? 'timeout' : 'failed' }));
      if (timedOut) throw new GatewayTimeoutException(`模型在 ${timeoutSeconds} 秒内未返回完整结果，请稍后重试。`);
      const message = error instanceof Error ? error.message.split(model.apiKey).join('[REDACTED]') : '请求失败';
      throw new ServiceUnavailableException('模型请求失败：' + message);
    }
  }
}
