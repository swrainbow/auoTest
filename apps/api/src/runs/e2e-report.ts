import { readFile } from 'node:fs/promises';
import type { BusinessStep } from '@autotest/shared';
import { GENERATED_MAP_FINISHED_URL, isSessionOperation, PALADIN_BIND_FINISHED_URL, SIMULATION_FINISHED_URL, TUSK_SERVICE_PREREQUISITE, type SessionOperationType, type Workflow } from '../planner/workflow';

interface ReportStep {
  api: string;
  label: string;
  status: string;
  durationMs: number;
  metrics?: { modelCalls: number };
  cache?: { mode?: string; reason?: string };
  error?: ReportError;
}
interface ReportError { code?: string; message?: string; details?: { matches?: number } }

// The runner records both browser.waitForURL and its inner assertion with the same URL label.
function hasInnerUrlAssertion(steps: ReportStep[], index: number): boolean {
  const outer = steps[index];
  const inner = steps[index + 1];
  return outer?.api === 'browser.waitForURL' && inner?.api === 'expect.toHaveURL' && inner.label === outer.label;
}

type WorkflowCall = {
  business: BusinessStep;
  kind: 'operation' | 'check';
  type: Workflow[number]['operations'][number]['type'] | Workflow[number]['checks'][number]['type'];
  index: number;
  api: string;
};

const HELPER_END_URL = {
  'import-generated-map': GENERATED_MAP_FINISHED_URL,
  'bind-paladin-map': PALADIN_BIND_FINISHED_URL,
  'sync-bound-map-services': PALADIN_BIND_FINISHED_URL,
  'create-simulation-instance': SIMULATION_FINISHED_URL,
  'configure-simulation-apr': SIMULATION_FINISHED_URL,
  'start-simulation-instance': SIMULATION_FINISHED_URL,
  'simulation-created': SIMULATION_FINISHED_URL,
  'simulation-apr': SIMULATION_FINISHED_URL,
  'simulation-running': SIMULATION_FINISHED_URL,
} as const;
function isDelimitedHelper(type: string): type is keyof typeof HELPER_END_URL {
  return Object.prototype.hasOwnProperty.call(HELPER_END_URL, type);
}

const CHECK_APIS: Record<Exclude<Workflow[number]['checks'][number]['type'], keyof typeof HELPER_END_URL>, string[]> = {
  url: ['expect.toHaveURL'],
  visible: ['expect.toBeVisible'],
  hidden: ['expect.toBeHidden'],
  count: ['expect.toHaveCount'],
  text: ['expect.toHaveText'],
  contains: ['expect.toContainText'],
  value: ['expect.toHaveValue'],
  'capture-text': ['expect.toBeVisible', 'browser.evaluate'],
  'matches-text': ['expect.toBeVisible', 'browser.evaluate'],
  'capture-json': ['expect.toBeVisible', 'browser.evaluate'],
  'matches-json': ['expect.toBeVisible', 'browser.evaluate'],
  'capture-hook-graph': ['browser.evaluate'],
  'matches-hook-graph': ['browser.evaluate'],
};

const OPERATION_APIS: Record<Exclude<Workflow[number]['operations'][number]['type'], SessionOperationType | 'ensure-map-in-menu' | keyof typeof HELPER_END_URL>, string[]> = {
  open: ['app.open'],
  act: ['agent.act'],
  wait: ['browser.evaluate'],
  'wait-url': ['expect.toHaveURL'],
  'wait-visible': ['expect.toBeVisible'],
  'wait-hidden': ['expect.toBeHidden'],
  click: ['locator.click'],
  hover: ['locator.hover'],
  press: ['locator.press'],
  'fill-credential': ['locator.fill'],
  fill: ['locator.fill'],
  select: ['locator.selectOption'],
  // Reading aria-controls does not create a report step.
  'select-element-plus': ['locator.click', 'expect.toBeVisible', 'locator.click'],
  'add-task-config-stage': ['expect.toHaveCount', 'browser.evaluate', 'locator.press', 'expect.toBeVisible', 'locator.press'],
  'filter-task-config': [
    'locator.click', 'locator.fill', 'browser.waitForResponse', 'locator.click',
    'expect.toHaveText', 'expect.toHaveCount', 'locator.click', 'expect.toBeHidden',
  ],
};

export function isRepairableUiFailure(
  kind: 'operation' | 'check' | null | undefined,
  type: string | null | undefined,
  code: string | undefined,
): boolean {
  if (kind !== 'operation' || !type || isSessionOperation(type) || type === 'ensure-map-in-menu' || isDelimitedHelper(type)) return false;
  if (/^(LOCATOR_|ACTION_FAILED$)/.test(code ?? '')) return true;
  return code === 'ASSERTION_FAILED' && (
    type === 'wait-visible' || type === 'wait-hidden' || type === 'wait-url' || type === 'filter-task-config'
  );
}

export function prerequisiteFailureMessage(message = '未完成服务管理检查'): string {
  return /^(?:用例)?前置条件失败/.test(message) ? message : `用例前置条件失败：${message}`;
}

export async function readE2eReport(file: string, workflow: Workflow, business: BusinessStep[], hasPrerequisite = false, allowBusinessWarning = true) {
  const raw = JSON.parse(await readFile(file, 'utf8')) as {
    schemaVersion?: string;
    run?: {
      errors?: ReportError[];
      results?: Array<{
        selected: boolean; status: string;
        attempts: Array<{ status: string; steps: ReportStep[]; error?: ReportError }>;
      }>;
    };
  };
  if (raw.schemaVersion !== 'report-1' || !Array.isArray(raw.run?.results)) throw new Error('e2e 报告结构无效');
  const results = raw.run.results.filter((item) => item.selected);
  const attempts = results.flatMap((item) => item.attempts);
  const steps = attempts.flatMap((attempt) => attempt.steps);
  // The generated script waits for the service page only after the prerequisite is complete.
  const prerequisiteEnd = hasPrerequisite && attempts.length === 1
    ? steps.findIndex((step) => step.api === 'browser.waitForURL' && step.status === 'passed' && !step.error)
    : -1;
  const prerequisiteFailed = hasPrerequisite && prerequisiteEnd < 0;
  const businessStart = prerequisiteFailed ? steps.length : prerequisiteEnd + (hasInnerUrlAssertion(steps, prerequisiteEnd) ? 2 : 1);
  const expectedActs = workflow.flatMap((step) => step.operations).filter((op) => op.type === 'act').length;
  const businessForCall: WorkflowCall[] = [];
  let helperFailureBetweenCalls: WorkflowCall | undefined;
  if (!prerequisiteFailed && results.length === 1 && attempts.length === 1) {
    const reported = steps.slice(businessStart);
    const expectedCalls: WorkflowCall[] = [];
    // Helpers perform a variable number of UI calls. The compiler appends a URL check on return.
    const appendHelper = (call: Omit<WorkflowCall, 'api'>, marker: RegExp) => {
      const start = expectedCalls.length;
      const end = reported.findIndex((step, i) => i >= start && step.api === 'browser.waitForURL' && step.label === String(marker));
      const after = end < 0 ? reported.length : end + (hasInnerUrlAssertion(reported, end) ? 2 : 1);
      for (const step of reported.slice(start, after)) {
        if (!/^(?:browser|expect|locator)\./.test(step.api)) return false;
        expectedCalls.push({ ...call, api: step.api });
      }
      if (end < 0 && attempts[0].error) helperFailureBetweenCalls = { ...call, api: '' };
      return end >= 0;
    };
    workflowSteps: for (const [stepIndex, step] of workflow.entries()) {
      const businessStep = business[stepIndex]!;
      for (const [index, { type }] of step.operations.entries()) {
        if (isDelimitedHelper(type)) {
          if (!appendHelper({ business: businessStep, kind: 'operation', type, index }, HELPER_END_URL[type])) break workflowSteps;
          continue;
        }
        if (type === 'ensure-map-in-menu') {
          const call = { business: businessStep, kind: 'operation' as const, type, index };
          // Create, switch, and reuse emit different numbers of locator actions.
          // Only the helper's final URL check permits mapping the following workflow call.
          const op = step.operations[index];
          const floorReadApis = op.type === 'ensure-map-in-menu' && op.recordFloor
            ? ['browser.waitForResponse', 'browser.reload'] : [];
          while (reported[expectedCalls.length]?.api.startsWith('locator.') || floorReadApis.includes(reported[expectedCalls.length]?.api)) {
            expectedCalls.push({ ...call, api: reported[expectedCalls.length]!.api });
          }
          if (reported[expectedCalls.length]?.api !== 'browser.waitForURL') {
            if (reported.length === expectedCalls.length && attempts[0].error) {
              helperFailureBetweenCalls = { ...call, api: '' };
            }
            break workflowSteps;
          }
          const markerIndex = expectedCalls.length;
          expectedCalls.push({ ...call, api: 'browser.waitForURL' });
          if (hasInnerUrlAssertion(reported, markerIndex)) expectedCalls.push({ ...call, api: 'expect.toHaveURL' });
          continue;
        }
        // The optional login sequence starts immediately after the readiness check.
        const apis = isSessionOperation(type)
          ? ['expect.toBeVisible',
            ...(reported[expectedCalls.length + 1]?.api === 'locator.fill'
              ? ['locator.fill', 'locator.fill', 'locator.click'] : []),
            'expect.toHaveURL', 'expect.toBeVisible']
          // Earlier scripts clicked the header and then a global menu item.
          : type === 'add-task-config-stage' && reported[expectedCalls.length + 1]?.api === 'locator.click'
            ? ['expect.toHaveCount', 'locator.click', 'locator.click'] : OPERATION_APIS[type];
        for (const api of apis) expectedCalls.push({ business: businessStep, kind: 'operation', type, index, api });
      }
      for (const [index, { type }] of step.checks.entries()) {
        if (isDelimitedHelper(type)) {
          if (!appendHelper({ business: businessStep, kind: 'check', type, index }, HELPER_END_URL[type])) break workflowSteps;
          continue;
        }
        for (const api of CHECK_APIS[type]) expectedCalls.push({ business: businessStep, kind: 'check', type, index, api });
      }
    }
    // Only a matching report prefix can safely identify which instruction failed.
    for (const [index, actual] of reported.entries()) {
      const expected = expectedCalls[index];
      if (!expected || actual.api !== expected.api) break;
      businessForCall.push(expected);
    }
    if (businessForCall.length !== reported.length) helperFailureBetweenCalls = undefined;
  }
  const acts = steps.filter((step) => step.api === 'agent.act');
  const aiCalls = steps.reduce((count, step) => count + (step.metrics?.modelCalls ?? 0), 0);
  const cacheHits = acts.filter((step) => step.cache?.mode === 'self-finalized').length;
  const businessCalls = steps.slice(businessStart);
  const attemptError = attempts.find((attempt) => attempt.error)?.error;
  let failedStep = businessCalls.find((step) => step.error);
  // Parallel steps are listed in start order. A response listener can be
  // abandoned when a later click throws; the attempt records the triggering error.
  if ((failedStep?.error?.code === 'STEP_NOT_AWAITED' || failedStep?.api === 'browser.waitForResponse') && attempts.length === 1 &&
      attemptError?.message && attemptError.code !== 'STEP_NOT_AWAITED') {
    failedStep = businessCalls.find((step) => step.error?.code === attemptError.code &&
      step.error?.message === attemptError.message) ?? failedStep;
  }
  // A duplicate is raised between successful browser calls during the creation precheck.
  // Preserve failures from other calls, attempts, process errors, and the runner itself.
  const lastCall = businessForCall.at(-1);
  const warning = allowBusinessWarning && helperFailureBetweenCalls?.type === 'create-simulation-instance' &&
    lastCall?.type === 'create-simulation-instance' && lastCall.business === helperFailureBetweenCalls.business &&
    lastCall.index === helperFailureBetweenCalls.index && results[0].status === 'failed' && attempts[0].status === 'failed' &&
    attemptError?.code === 'ERROR' && attemptError.message?.startsWith('仿真实例重名告警：') &&
    steps.every(step => step.status === 'passed' && !step.error) && !raw.run.errors?.length
    ? { step: helperFailureBetweenCalls.business.order, message: attemptError.message } : undefined;
  const failedCall = warning ? undefined : failedStep ? businessForCall[steps.indexOf(failedStep) - businessStart] : helperFailureBetweenCalls;
  const matches = failedStep?.error?.details?.matches;
  const failedObservedCount = failedCall?.kind === 'check' && (failedCall.type === 'count' || failedCall.type === 'visible') &&
    failedStep?.error?.code === 'ASSERTION_FAILED' && typeof matches === 'number' && Number.isSafeInteger(matches) && matches >= 0
    ? matches : null;
  const failedBusinessStep = failedCall?.business.order ?? null;
  const failedCallKind = failedCall?.kind ?? null;
  const runError = raw.run.errors?.[0];
  const timeoutError = [...attempts.map((attempt) => attempt.error), ...(raw.run.errors ?? [])]
    .find((error) => error?.code === 'TEST_TIMEOUT');
  const timedOut = Boolean(timeoutError) || results.some((item) => item.status === 'timed-out');
  const error = timedOut
    ? timeoutError ?? { code: 'TEST_TIMEOUT', message: '用例执行超时' }
    : prerequisiteFailed ? attemptError ?? runError ?? steps.find((step) => step.error)?.error
      : failedStep?.error ?? runError ?? attemptError;
  const reportedError = prerequisiteFailed ? { ...error, message: prerequisiteFailureMessage(error?.message) } : error;
  const prerequisite = hasPrerequisite ? {
    skill: TUSK_SERVICE_PREREQUISITE,
    status: prerequisiteFailed ? 'failed' as const : 'passed' as const,
    ...(prerequisiteFailed ? { message: reportedError?.message } : {}),
  } : undefined;
  const passed = results.filter((item) => item.status === 'passed').length;
  const fullyPassed = !prerequisiteFailed && passed === 1 && results.length === 1 && attempts.length === 1 && attempts[0]?.status === 'passed';
  return {
    aiCalls, cacheHits, fullyPassed, timedOut,
    zeroAi: fullyPassed && aiCalls === 0 && acts.length === expectedActs && cacheHits === expectedActs &&
      acts.every((step) => step.status === 'passed' && !['gap', 'truncated'].includes(step.cache?.reason ?? '')),
    error: warning ? undefined : reportedError,
    summary: {
      total: results.length, passed, failed: results.length - passed - (warning ? 1 : 0),
      ...(warning ? { warnings: 1, warning } : {}),
      errorCode: warning ? undefined : error?.code,
      failedBusinessStep,
      failedCallKind,
      failedCallType: failedCall?.type ?? null,
      failedCallIndex: failedCall?.index ?? null,
      failedObservedCount,
      ...(prerequisite ? { prerequisite } : {}),
      steps: steps.map(({ api, label, status, durationMs, cache, error }, index) => {
        const call = businessForCall[index - businessStart];
        return { api, label, status, durationMs, cache, error, business: call?.business, callKind: call?.kind, callType: call?.type };
      }),
    },
  };
}
