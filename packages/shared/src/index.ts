/**
 * 平台前后端共享类型（types-only 包，无需构建）。
 * 注意：本包只导出类型，不导出运行时值。
 */

// ---------- 用例 ----------

export type TestCaseStatus =
  | 'draft' // 草稿
  | 'trial-pending' // 待试运行
  | 'trial-passed' // 试运行通过
  | 'published' // 已发布
  | 'deprecated'; // 已停用

export type ExecutionMode = 'explore' | 'replay' | 'strict';

export type CasePriority = 'P0' | 'P1' | 'P2' | 'P3';

export interface BusinessStep {
  order: number;
  /** 业务动作描述，如：在“创建时”阶段添加校验 Hook */
  action: string;
  /** 预期结果 / 检查点 */
  expected: string;
  /** 覆盖用例默认 Skill 的业务 Skill 目录名 */
  skill?: string;
}

export interface CasePrerequisite {
  skill: string;
  mapName: string;
  serviceName?: string;
}

export interface TestCaseDto {
  id: number;
  code: string;
  name: string;
  description: string;
  /** 创建用例时保存的自然语言原文 */
  originalRequirement: string | null;
  module: string;
  tags: string[];
  priority: CasePriority;
  status: TestCaseStatus;
  executionMode: ExecutionMode;
  currentVersion: number;
  scriptPath: string | null;
  skill: string;
  taskId: string;
  prerequisite?: CasePrerequisite;
  steps: BusinessStep[];
  /** 已通过一次严格回放（无凭据试跑）验证，满足零 AI 发布准入 */
  zeroAiVerified: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TestCaseVersionDto {
  id: number;
  version: number;
  steps: BusinessStep[];
  skill?: string | null;
  prerequisite?: CasePrerequisite;
  changeNote: string;
  scriptPath?: string | null;
  publishedAt?: string | null;
  createdAt: string;
}

export interface ScriptGenerationJob {
  id: number;
  testCaseId: number;
  caseCode: string;
  caseName: string;
  sourceVersion: number;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  resultVersion: number | null;
  scriptPath: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SaveTestCaseInput {
  name: string;
  description?: string;
  /** 仅在创建用例时写入 */
  originalRequirement?: string;
  module?: string;
  tags?: string[];
  priority?: CasePriority;
  executionMode?: ExecutionMode;
  skill?: string;
  taskId?: string;
  prerequisite?: CasePrerequisite | null;
  steps: BusinessStep[];
}

/** AI 生成的测试计划（未保存前的草稿） */
export interface GeneratedPlan {
  name: string;
  module: string;
  priority: CasePriority;
  steps: BusinessStep[];
  notes?: string;
  skill: string;
  taskId: string;
}

// ---------- 执行 ----------

export type RunStatus =
  | 'queued' // 排队中
  | 'running' // 执行中
  | 'passed' // 通过
  | 'warning' // 业务告警，提前结束
  | 'failed' // 失败
  | 'canceled' // 已取消
  | 'timeout' // 超时
  | 'error'; // 执行器错误

export interface RunSummary {
  total?: number;
  passed?: number;
  failed?: number;
  warnings?: number;
  warning?: { step: number; message: string };
  flaky?: number;
  failedBusinessStep?: number | null;
  failedCallKind?: 'operation' | 'check' | null;
  failedCallType?: string | null;
  failedCallIndex?: number | null;
  failedObservedCount?: number | null;
  testDataConflict?: { step: number; name: string; observedCount: number };
  verificationDeferred?: { name: string; kind?: 'simulation-instance' };
  verificationOf?: number;
  skillFile?: string;
  skillFiles?: string[];
  skillLearning?: { status: 'recorded' | 'pending-verification' | 'skipped' | 'failed'; reason?: string };
  prerequisite?: { skill: string; status: 'passed' | 'failed'; message?: string };
  [key: string]: unknown;
}

export interface RepairAvailability {
  canStart: boolean;
  label?: string;
  reason?: string;
  currentVersion?: number;
  currentRunId?: number;
}

export interface TestRunDto {
  id: number;
  testCaseId: number | null;
  testCaseCode: string | null;
  testCaseName: string | null;
  version: number | null;
  repairOf: number | null;
  repairRunId: number | null;
  verificationRunId: number | null;
  verificationOf?: number;
  repairState: string | null;
  repairAvailability?: RepairAvailability;
  target: string;
  mode: ExecutionMode;
  autoRepair?: boolean;
  status: RunStatus;
  exitCode: number | null;
  durationMs: number | null;
  aiCalls: number | null;
  cacheHits: number | null;
  logPath: string | null;
  artifactDir: string | null;
  summary: RunSummary | null;
  error: string | null;
  /** AI 失败诊断（markdown），diagnose 后写入 */
  diagnosis: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface TestRunPageQuery {
  page: number;
  pageSize: number;
  status?: string;
  module?: string;
  testCaseId?: number;
}

export interface TestRunPage {
  items: Array<TestRunDto & { testCaseModule: string | null }>;
  total: number;
  page: number;
  hasActive: boolean;
}

export interface CreateRunInput {
  testCaseId?: number | null;
  version?: number;
  mode?: ExecutionMode;
  autoRepair?: boolean;
  verificationOf?: number;
}

// ---------- Skill ----------

export interface SkillFileInfo {
  /** 相对 skills/ 根目录的 posix 路径 */
  path: string;
  size: number;
  updatedAt: string;
}

export interface SkillDto {
  /** 目录名（唯一标识） */
  dir: string;
  /** frontmatter 中的 name */
  name: string;
  description: string;
  files: SkillFileInfo[];
}

export interface SaveSkillFileInput {
  path: string;
  content: string;
}

// ---------- 设置 / 仪表盘 ----------

export type ScriptReasoning = 'auto' | 'off' | 'low' | 'high' | 'max' | 'provider';

export interface ModelConfigView {
  configured: boolean;
  baseUrl: string;
  name: string;
  apiKey: string;
  apiKeyFromEnvironment: boolean;
  temperature: number | null;
  maxOutputTokens: number | null;
  scriptReasoning: ScriptReasoning;
  scriptTimeoutSeconds: number;
}

export interface UpdateModelInput {
  baseUrl?: string;
  name?: string;
  apiKey?: string;
  temperature?: number | null;
  maxOutputTokens?: number | null;
  scriptReasoning?: ScriptReasoning;
  scriptTimeoutSeconds?: number;
}

export interface TargetLogin {
  username: string;
  password: string;
}

export type PreparationSkillId = 'service-sync' | 'map-binding' | 'readiness-check';
export type PreparationSelection = 'unique' | 'explicit';

export interface PreparationSkill {
  id: PreparationSkillId;
  name: string;
  description: string;
  requires?: PreparationSkillId;
}

export interface PreparationRule {
  version: number;
  selection: PreparationSelection;
  status: 'draft' | 'verified';
  createdAt: string;
}

export interface PreparationFlow {
  id: string;
  name: string;
  steps: PreparationSkillId[];
  ruleVersion: number;
  createdAt: string;
}

export interface PreparationEvidence {
  serviceName?: string;
  mapsBefore?: string[];
  mapsAfter?: string[];
  wroteBinding?: boolean;
  services?: Array<{ name: string; status: string; attempts?: number }>;
}

export interface PreparationStepResult {
  skillId: PreparationSkillId;
  name: string;
  status: 'pending' | 'running' | 'passed' | 'failed' | 'skipped';
  evidence: string;
}

export interface PreparationRun {
  id: string;
  flowId: string;
  flowName: string;
  ruleVersion: number;
  selection: PreparationSelection;
  targetBaseUrl: string;
  mapName: string;
  serviceName: string;
  status: 'queued' | 'running' | 'passed' | 'failed';
  createdAt: string;
  finishedAt: string | null;
  error: string | null;
  steps: PreparationStepResult[];
  evidence?: PreparationEvidence;
}

export interface PreparationWorkspace {
  targetBaseUrl: string;
  skills: PreparationSkill[];
  rules: PreparationRule[];
  flows: PreparationFlow[];
  runs: PreparationRun[];
}

export interface UpdateSettingsInput {
  targetBaseUrl?: string;
  runTimeoutMinutes?: number;
  showBrowser?: boolean;
  targetLogin?: Partial<TargetLogin>;
  model?: UpdateModelInput;
}

export interface PlatformSettings {
  targetBaseUrl: string;
  runTimeoutMinutes: number;
  showBrowser: boolean;
  targetLogin: TargetLogin;
  model: ModelConfigView;
  paths: {
    skillsRoot: string;
    e2eProject: string;
    artifactsRoot: string;
  };
}

export interface KpiTrend {
  /** 相对上一统计窗口的变化比例，如 0.08 表示 +8%；无对比数据时为 null */
  delta: number | null;
}

export interface DashboardSummary {
  days: number;
  kpis: {
    totalCases: number;
    assessedRuns: number;
    passRate: number; // 0-100
    reliabilityScore: number; // 0-100
    avgDurationMs: number | null;
    trends: {
      totalCases: KpiTrend;
      passRate: KpiTrend;
      reliabilityScore: KpiTrend;
      avgDurationMs: KpiTrend;
    };
  };
  moduleSummary: Array<{
    module: string;
    runs: number;
    lastRunAt: string | null;
    passRate: number;
    status: 'passed' | 'failed' | 'warning' | 'none';
  }>;
  flakyTests: Array<{
    testCaseId: number;
    code: string;
    name: string;
    module: string;
    runs: number;
    failures: number;
    flakyScore: number; // 0-100
  }>;
  trend: Array<{
    runId: number;
    label: string;
    passed: number;
    failed: number;
    warnings: number;
    total: number;
    caseName: string | null;
    status: 'passed' | 'failed' | 'warning';
    durationMs: number | null;
    createdAt: string;
  }>;
}
