import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rename } from 'node:fs/promises';
import { finished } from 'node:stream/promises';
import * as path from 'node:path';
import { createInterface } from 'node:readline';
import { PrismaService } from '../prisma/prisma.service';
import { PathsService } from '../paths/paths.service';
import { SettingsService } from '../settings/settings.service';
import { isCountLocatorRepairable, narrowsClassSelector, PlannerService, type RepairEvidence } from '../planner/planner.service';
import { evidencedHookGraphRepair, hookGraphCheckPair } from '../planner/hook-graph-repair';
import { CasesService } from '../cases/cases.service';
import { SkillsService } from '../skills/skills.service';
import { isSessionOperation, TUSK_SERVICE_PREREQUISITE, usesTargetLogin, validateWorkflow, type Workflow } from '../planner/workflow';
import { cacheDir, cacheFingerprint, PROXY_CONFIG, RUNTIME_CONFIG, RUN_TIMEOUT_CONFIG, usesGeneratedMap, usesRunTimeout } from './replay-assets';
import { runnerEnvironment, stopRunner } from './runner-process';
import { needsTargetProxy, startTargetProxy } from './target-proxy';
import { isRepairableUiFailure, prerequisiteFailureMessage, readE2eReport } from './e2e-report';
import { simulationCreationGuard, taskConfigCreationGuard, taskConfigGuardAtStep } from './replay-test-data';
import { mapReadbackFailureStep, mapReadbackPractice, verifiedMapReadback } from './map-readback-repair';
import { repeatedBindingSync, serviceSyncPractice, shouldResyncBinding, verifiedBindingSync } from './service-sync-repair';
import type { BusinessStep, CreateRunInput, ExecutionMode, RepairAvailability, RunSummary, TestRunDto, TestRunPage, TestRunPageQuery } from '@autotest/shared';
import type { Prisma, TestRun, TestCase, TestCaseVersion } from '@prisma/client';

const FAILED = ['failed', 'timeout', 'error'];
const EXPLORE_REPORT_GRACE_MS = 30_000;
const REUSABLE_OPERATIONS = new Set(['click', 'press', 'wait-visible', 'wait-hidden']);
type VerifiedCountScope = { type: 'count'; from: string; to: string };
type VerifiedCheck = VerifiedCountScope | { type: 'visible'; from: string; to: string } |
  { type: 'count'; from: string; replacement: NonNullable<ReturnType<typeof hookGraphCheckPair>>[number]['check'] };
type VerifiedRepair = { page: string; operations?: Workflow[number]['operations']; checks?: VerifiedCheck[] } | typeof serviceSyncPractice;
type ReportSummary = Awaited<ReturnType<typeof readE2eReport>>['summary'];
type RunWithCase = TestRun & { testCase: TestCase | null };
type RepairTarget = Pick<RepairEvidence, 'failedStep' | 'failedCall' | 'observedCount' | 'resyncExistingBinding'> & { summary: ReportSummary; mapReadback?: true };

function testDataConflict(workflow: Workflow, summary?: ReportSummary): RunSummary['testDataConflict'] {
  const step = summary?.failedBusinessStep;
  const observedCount = summary?.failedObservedCount;
  if (step == null || observedCount == null || observedCount < 1 || summary?.failedCallKind !== 'check' ||
      summary.failedCallType !== 'count' || summary.failedCallIndex == null) return;
  const guard = taskConfigGuardAtStep(workflow, step - 1, summary.failedCallIndex);
  return guard ? { step, name: guard.name, observedCount } : undefined;
}

function failureStep(summary: ReportSummary | null): number | null {
  if (summary?.failedBusinessStep !== undefined) return summary.failedBusinessStep;
  return summary?.steps?.find((step) => step.error)?.business?.order ?? null;
}

export function toRunDto(r: TestRun & { testCase?: TestCase | null }): TestRunDto {
  const summary: RunSummary | null = r.summary ? JSON.parse(r.summary) : null;
  return {
    id: r.id, testCaseId: r.testCaseId, testCaseCode: r.testCase?.code ?? null, testCaseName: r.testCase?.name ?? null,
    version: r.version, repairOf: r.repairOf, repairRunId: r.repairRunId, verificationRunId: r.verificationRunId,
    repairState: r.repairState, autoRepair: r.autoRepair, verificationOf: summary?.verificationOf,
    target: r.target, mode: r.mode as ExecutionMode, status: r.status as TestRunDto['status'],
    exitCode: r.exitCode, durationMs: r.durationMs, aiCalls: r.aiCalls, cacheHits: r.cacheHits,
    logPath: r.logPath, artifactDir: r.artifactDir, summary,
    error: r.error, diagnosis: r.diagnosis, createdAt: r.createdAt.toISOString(),
    startedAt: r.startedAt?.toISOString() ?? null, finishedAt: r.finishedAt?.toISOString() ?? null,
  };
}

@Injectable()
export class RunsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RunsService.name);
  private readonly children = new Map<number, ChildProcess>();
  private readonly linkingVerifications = new Map<number, Promise<RunWithCase>>();
  private processing = false;
  private stopping = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly paths: PathsService,
    private readonly settings: SettingsService,
    private readonly planner: PlannerService,
    private readonly cases: CasesService,
    private readonly skills: SkillsService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.prisma.testRun.updateMany({
      where: { status: 'running' },
      data: { status: 'error', error: '平台重启，原执行已中断', finishedAt: new Date() },
    });
    await this.prisma.testRun.updateMany({ where: { repairState: { in: ['pending', 'running'] } }, data: { repairState: 'failed' } });
    this.schedule();
  }

  onModuleDestroy(): void {
    this.stopping = true;
    for (const child of this.children.values()) stopRunner(child);
  }

  async create(input: CreateRunInput): Promise<TestRunDto> {
    if (!Number.isInteger(input.testCaseId)) throw new BadRequestException('请选择一个已有脚本的测试用例');
    const c = await this.prisma.testCase.findUnique({ where: { id: input.testCaseId! } });
    if (!c) throw new NotFoundException('用例不存在');
    if (c.status === 'deprecated') throw new BadRequestException('用例已停用');
    const version = await this.cases.version(c.id, input.version ?? c.currentVersion);
    if (version.version !== c.currentVersion && !version.publishedAt) throw new BadRequestException('仅可回放已发布的历史版本');
    const mode = input.mode ?? (c.zeroAiVerified || version.publishedAt ? 'strict' : c.executionMode);
    if (mode !== 'explore' && mode !== 'replay' && mode !== 'strict') throw new BadRequestException('执行模式无效');
    if (version.publishedAt && mode === 'explore') throw new BadRequestException('已发布版本使用回放，重新探索前请创建新版本');
    await this.cases.checkSource(version);
    const settings = await this.settings.get();
    const result = input.verificationOf === undefined
      ? await this.enqueue(c.id, version.version, version.scriptPath!, settings.targetBaseUrl, mode, mode !== 'strict' && input.autoRepair === true)
      : await this.enqueueVerification(input.verificationOf, c, version, settings.targetBaseUrl, mode);
    this.schedule();
    return toRunDto(result);
  }

  async list(status?: string): Promise<TestRunDto[]> {
    const runs = await this.prisma.testRun.findMany({
      where: status ? { status } : undefined, include: { testCase: true }, orderBy: { id: 'desc' }, take: 100,
    });
    return runs.map(toRunDto);
  }

  async listPage(query: TestRunPageQuery): Promise<TestRunPage> {
    const { status, module, testCaseId, pageSize } = query;
    const where: Prisma.TestRunWhereInput = { status, testCaseId };
    if (module === '') {
      where.OR = [{ testCaseId: null }, { testCase: { module: '' } }];
    } else if (module !== undefined) {
      where.testCase = { module };
    }

    return this.prisma.$transaction(async (tx) => {
      const total = await tx.testRun.count({ where });
      const page = Math.min(query.page, Math.max(1, Math.ceil(total / pageSize)));
      const runs = await tx.testRun.findMany({
        where,
        include: { testCase: true },
        orderBy: { id: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      });
      const active = await tx.testRun.findFirst({
        where: { status: { in: ['queued', 'running'] } },
        select: { id: true },
      });
      return {
        items: runs.map((run) => ({ ...toRunDto(run), testCaseModule: run.testCase?.module || null })),
        total,
        page,
        hasActive: active !== null,
      };
    });
  }

  async get(id: number): Promise<TestRunDto> {
    const run = await this.find(id);
    const dto = toRunDto(run);
    if (!dto.verificationOf && run.mode === 'strict') {
      const source = await this.prisma.testRun.findFirst({ where: { verificationRunId: id }, select: { id: true } });
      if (source) dto.verificationOf = source.id;
    }
    if (run.mode === 'explore' && run.status === 'passed' && run.verificationRunId && !dto.summary?.verificationDeferred) {
      const linked = await this.prisma.testRun.findUnique({ where: { id: run.verificationRunId } });
      const deferred = await this.legacyVerificationConflict(run, linked);
      if (deferred) dto.summary = { ...dto.summary, verificationDeferred: deferred };
    }
    dto.summary = await this.resolveVerificationLearning(dto.summary, run.verificationRunId);
    if ((!dto.summary?.skillLearning || (run.repairRunId && dto.summary.skillLearning.status === 'skipped')) &&
        !dto.summary?.skillFile && !dto.summary?.skillFiles?.length) {
      if (!run.repairRunId && run.repairOf && FAILED.includes(run.status)) {
        dto.summary = { ...dto.summary, skillLearning: { status: 'skipped', reason: '修复试跑未通过，未写回 Skill。' } };
      } else if (run.repairOf && run.status === 'canceled') {
        dto.summary = { ...dto.summary, skillLearning: { status: 'skipped', reason: '修复试跑已取消，未写回 Skill。' } };
      } else if (run.repairRunId) {
        const child = await this.prisma.testRun.findUnique({ where: { id: run.repairRunId }, select: { status: true, summary: true, verificationRunId: true } });
        const learned = child?.summary ? await this.resolveVerificationLearning(JSON.parse(child.summary) as RunSummary, child.verificationRunId) : null;
        if (child && ['canceled', ...FAILED].includes(child.status)) {
          const reason = child.status === 'canceled' ? '修复试跑已取消' : '修复试跑未通过';
          dto.summary = { ...dto.summary, skillLearning: { status: 'skipped', reason: `#${run.repairRunId} ${reason}，未写回 Skill。` } };
        } else if (learned?.skillLearning || learned?.skillFile || learned?.skillFiles) {
          dto.summary = { ...dto.summary, skillLearning: learned.skillLearning, skillFile: learned.skillFile, skillFiles: learned.skillFiles };
        }
      } else if (run.repairState === 'failed' && FAILED.includes(run.status)) {
        const reason = run.diagnosis?.startsWith('修复未执行：')
          ? run.diagnosis
          : '未生成或完成修复试跑，没有可写回的验证结果。';
        dto.summary = { ...dto.summary, skillLearning: { status: 'skipped', reason } };
      } else if (FAILED.includes(run.status) && dto.summary?.failedCallKind === 'check') {
        dto.summary = { ...dto.summary, skillLearning: { status: 'skipped', reason: '此运行没有通过验证的修复试跑，未写回 Skill。' } };
      }
    }
    if (!FAILED.includes(run.status)) return dto;
    const { availability } = await this.prepareRepair(run);
    return { ...dto, repairAvailability: availability };
  }

  private async resolveVerificationLearning(summary: RunSummary | null, verificationRunId: number | null) {
    if (summary?.skillLearning?.status !== 'pending-verification' || !verificationRunId) return summary;
    const linked = await this.prisma.testRun.findUnique({ where: { id: verificationRunId }, select: { status: true, summary: true } });
    const result = linked?.summary ? JSON.parse(linked.summary) as RunSummary : null;
    if (result?.skillLearning) return { ...summary, skillLearning: result.skillLearning, skillFile: result.skillFile, skillFiles: result.skillFiles };
    if (linked && (linked.status === 'canceled' || FAILED.includes(linked.status))) return {
      ...summary, skillLearning: { status: 'skipped' as const, reason: '严格验证未通过或已取消，未写回 Skill。' },
    };
    return summary;
  }

  private async legacyVerificationConflict(source: TestRun, linked: TestRun | null): Promise<RunSummary['verificationDeferred']> {
    if (!linked?.summary || !source.testCaseId || source.version === null || linked.status !== 'failed' || linked.mode !== 'strict' ||
        linked.version !== source.version || linked.testCaseId !== source.testCaseId || linked.target !== source.target ||
        linked.targetBaseUrl !== source.targetBaseUrl) return;
    const { testDataConflict: conflict } = JSON.parse(linked.summary) as RunSummary;
    const version = await this.cases.version(source.testCaseId, source.version);
    if (!version.workflow) return;
    const workflow = validateWorkflow(JSON.parse(version.workflow), (JSON.parse(version.steps) as BusinessStep[]).length);
    const simulation = simulationCreationGuard(workflow);
    if (simulation) return simulation;
    if (!conflict) return;
    const guard = taskConfigCreationGuard(workflow);
    if (guard?.step === conflict.step && guard.name === conflict.name) return { name: guard.name };
  }

  private async enqueueVerification(sourceId: number, c: TestCase, version: TestCaseVersion, targetBaseUrl: string, mode: ExecutionMode) {
    if (!Number.isSafeInteger(sourceId) || sourceId < 1 || mode !== 'strict') throw new BadRequestException('请选择有效的探索记录执行严格回放');
    const source = await this.find(sourceId);
    if (source.mode !== 'explore' || source.status !== 'passed' || source.testCaseId !== c.id || source.version !== version.version ||
        c.currentVersion !== version.version || source.targetBaseUrl !== targetBaseUrl || source.target !== version.scriptPath) {
      throw new ConflictException('探索版本或目标站点已变化，请从当前版本重新发起验证');
    }
    const summary = (source.summary ? JSON.parse(source.summary) : {}) as RunSummary;
    const previous = source.verificationRunId ? await this.prisma.testRun.findUnique({ where: { id: source.verificationRunId }, include: { testCase: true } }) : null;
    const deferred = summary.verificationDeferred ?? await this.legacyVerificationConflict(source, previous);
    if (!deferred) throw new BadRequestException('该探索记录没有等待测资的回放验证');
    if (previous && ['queued', 'running', 'passed'].includes(previous.status)) return previous;

    const pending = this.linkingVerifications.get(sourceId);
    if (pending) return pending;
    const link = this.prisma.$transaction(async (tx) => {
      const current = await tx.testCase.findUnique({ where: { id: c.id }, select: { currentVersion: true, status: true } });
      if (!current || current.currentVersion !== version.version || current.status === 'deprecated') {
        throw new ConflictException('用例版本已更新，请刷新后重试');
      }
      const fresh = await tx.testRun.findUniqueOrThrow({ where: { id: source.id }, select: { verificationRunId: true } });
      if (fresh.verificationRunId !== source.verificationRunId) {
        if (!fresh.verificationRunId) throw new ConflictException('验证记录已变化，请刷新后重试');
        return tx.testRun.findUniqueOrThrow({ where: { id: fresh.verificationRunId }, include: { testCase: true } });
      }
      if (previous) {
        const previousSummary = previous.summary ? JSON.parse(previous.summary) as RunSummary : {};
        if (!previousSummary.verificationOf) await tx.testRun.update({
          where: { id: previous.id }, data: { summary: JSON.stringify({ ...previousSummary, verificationOf: source.id }) },
        });
      }
      const verification = await tx.testRun.create({
        data: { testCaseId: c.id, version: version.version, target: source.target, targetBaseUrl, mode: 'strict',
          summary: JSON.stringify({ verificationOf: source.id }) },
        include: { testCase: true },
      });
      await tx.testRun.update({ where: { id: source.id }, data: { verificationRunId: verification.id,
        summary: JSON.stringify({ ...summary, verificationDeferred: deferred }) } });
      return verification;
    });
    this.linkingVerifications.set(sourceId, link);
    try {
      return await link;
    } finally {
      this.linkingVerifications.delete(sourceId);
    }
  }

  async cancel(id: number): Promise<TestRunDto> {
    await this.find(id);
    const changed = await this.prisma.testRun.updateMany({
      where: { id, status: { in: ['queued', 'running'] } },
      data: { status: 'canceled', finishedAt: new Date() },
    });
    const child = this.children.get(id);
    if (changed.count && child) stopRunner(child);
    return this.get(id);
  }

  async readLogTail(id: number, lines = 400): Promise<string> {
    const run = await this.find(id);
    if (!run.logPath) return '';
    const collected: string[] = [];
    try {
      const rl = createInterface({ input: createReadStream(run.logPath, { encoding: 'utf8' }), crlfDelay: Infinity });
      for await (const line of rl) {
        collected.push(line.slice(0, 4000));
        if (collected.length > lines) collected.shift();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return collected.join('\n');
  }

  async listArtifacts(id: number): Promise<string[]> {
    const { artifactDir } = await this.find(id);
    if (!artifactDir) return [];
    const files: string[] = [];
    const walk = async (relative: string): Promise<void> => {
      const entries = await readdir(path.join(artifactDir, relative), { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT' && !relative) return [];
        throw error;
      });
      for (const entry of entries) {
        const file = relative + entry.name;
        if (entry.isDirectory()) await walk(file + '/');
        if (entry.isFile()) files.push(file);
      }
    };
    await walk('');
    return files.sort();
  }

  async diagnose(id: number): Promise<TestRunDto> {
    const run = await this.findFailed(id);
    const version = await this.cases.version(run.testCase.id, run.version);
    const diagnosis = await this.planner.diagnoseRun({
      code: run.testCase.code, name: run.testCase.name, steps: JSON.parse(version.steps), run: {
        mode: run.mode, error: run.error, summary: run.summary ? JSON.parse(run.summary) : null,
      },
      logTail: await this.readLogTail(id),
    });
    await this.prisma.testRun.update({ where: { id }, data: { diagnosis } });
    return this.get(id);
  }

  async repair(id: number, automatic = false): Promise<TestRunDto> {
    const run = await this.findFailed(id);
    if (run.repairRunId) return this.get(run.repairRunId);
    const { availability, target } = await this.prepareRepair(run, automatic);
    if (!target) throw new ConflictException(availability.reason);
    const { summary, failedStep, failedCall, observedCount } = target;
    const previousRepairStates = automatic ? ['pending'] : ['failed'];
    const claimed = await this.prisma.testRun.updateMany({
      where: { id, repairRunId: null, OR: [{ repairState: null }, { repairState: { in: previousRepairStates } }] },
      data: { repairState: 'running' },
    });
    if (!claimed.count) {
      const latest = await this.find(id);
      if (latest.repairRunId) return this.get(latest.repairRunId);
      throw new ConflictException('该失败正在生成修复版本');
    }
    try {
      const queueTrial = async (tx: Prisma.TransactionClient, asset: { version: number; scriptPath: string; diagnosis: string }) => {
        const newerPass = await tx.testRun.findFirst({
          where: { testCaseId: run.testCase.id, version: run.version, targetBaseUrl: run.targetBaseUrl, status: 'passed', id: { gt: id } },
          select: { id: true },
        });
        if (newerPass) throw new ConflictException(`用例 v${run.version} 已在运行 #${newerPass.id} 通过，本次修复已停止`);
        const next = await tx.testRun.create({
          data: {
            testCaseId: run.testCase.id, version: asset.version, target: asset.scriptPath, targetBaseUrl: run.targetBaseUrl,
            mode: target.mapReadback ? 'strict' : 'explore', repairOf: id,
            autoRepair: !target.mapReadback && failedCall.kind === 'operation' && run.autoRepair && !run.repairOf,
          },
          include: { testCase: true },
        });
        await tx.testRun.update({
          where: { id, repairRunId: null, repairState: 'running' },
          data: { repairRunId: next.id, repairState: 'queued', diagnosis: asset.diagnosis },
        });
        return next;
      };
      if (target.mapReadback) {
        const child = await this.prisma.$transaction(async tx => {
          const current = await tx.testCase.findFirst({ where: {
            id: run.testCase.id, currentVersion: run.version, status: { not: 'deprecated' }, scriptPath: run.target,
          } });
          if (!current) throw new ConflictException('用例版本已变化，请使用当前版本');
          return queueTrial(tx, { version: run.version, scriptPath: run.target,
            diagnosis: '刷新时地图菜单项已隐藏，导致目标详情监听未收尾。使用已修正的地图回读操作，按原版本和原布局严格试跑。' });
        });
        this.schedule();
        return toRunDto(child);
      }
      const calls = summary.steps ?? [];
      const failedIndex = calls.findIndex((step) => step.error && step.business?.order === failedStep);
      const nearbyCalls = failedIndex < 0 ? [] : calls.slice(Math.max(0, failedIndex - 3), failedIndex + 3).map(
        ({ api, label, status, error }) => ({ api, label, status, error }),
      );
      const [logTail, screen, settings, model, priorFailures] = await Promise.all([
        this.readLogTail(id), this.readFailureScreen(run), this.settings.get(), this.settings.getModelConfig(),
        this.prisma.testRun.findMany({
          where: { testCaseId: run.testCase.id, targetBaseUrl: run.targetBaseUrl, id: { lt: id }, status: { in: FAILED }, version: { not: null } },
          orderBy: { id: 'desc' },
          take: 8,
          select: { version: true, error: true },
        }),
      ]);
      const secrets = [settings.targetLogin.password, model.apiKey].filter(Boolean);
      const redact = (value: string) => secrets.reduce((text, secret) => text.replaceAll(secret, '[REDACTED]'), value);
      const { savedResult: child } = await this.cases.repair(run.testCase.id, run.version, run.targetBaseUrl!, {
        resyncExistingBinding: target.resyncExistingBinding,
        failure: redact(JSON.stringify({ error: run.error, failed: calls[failedIndex], nearbyCalls })).slice(0, 4000),
        failedStep,
        failedCall,
        observedCount,
        screen: redact(screen),
        logTail: redact(logTail.slice(-4000)),
        priorFailures: priorFailures.flatMap(({ version, error }) =>
          version !== null && error ? [{ version, reason: redact(error).slice(0, 600) }] : [],
        ),
      }, queueTrial);
      this.schedule();
      return toRunDto(child);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.prisma.testRun.updateMany({
        where: { id, repairState: 'running', repairRunId: null },
        data: { repairState: 'failed', diagnosis: '修复未执行：' + message },
      });
      throw error;
    }
  }

  private async prepareRepair(run: RunWithCase, automatic = false): Promise<{
    availability: RepairAvailability; target?: RepairTarget;
  }> {
    const { testCase, version: failedVersion, targetBaseUrl } = run;
    const currentVersion = testCase?.currentVersion;
    const unavailable = (reason: string, currentRunId?: number) => ({
      availability: { canStart: false, reason, currentVersion, currentRunId },
    });
    if (!testCase || failedVersion === null || !targetBaseUrl) return unavailable('该运行没有关联可修复的用例版本');
    if (testCase.status === 'deprecated') return unavailable('该用例已停用');
    if (run.repairRunId) return unavailable('此运行已有修复试跑，可查看试跑结果');
    if (run.repairState === 'running' || (!automatic && run.repairState === 'pending')) {
      return unavailable('此运行已有修复请求正在处理');
    }
    if (run.repairState === 'regressed') return unavailable('修复试跑在更早的步骤失败，已停止本轮修复');

    const isCurrent = failedVersion === currentVersion;
    const passed = await this.prisma.testRun.findFirst({
      where: {
        testCaseId: testCase.id, version: currentVersion, targetBaseUrl, status: 'passed',
        ...(isCurrent ? { id: { gt: run.id } } : {}),
      },
      orderBy: { id: 'desc' }, select: { id: true },
    });
    if (passed) return unavailable(`当前用例 v${currentVersion} 已在运行 #${passed.id} 通过，此失败记录已无需修复`, passed.id);
    if (!isCurrent) return unavailable(`此运行使用 v${failedVersion}，当前用例为 v${currentVersion}。请从当前版本的运行发起修复`);

    const version = await this.cases.version(testCase.id, failedVersion);
    if (!version.workflow || version.scriptPath !== run.target) return unavailable('此运行缺少匹配的结构化脚本');
    const business = JSON.parse(version.steps) as BusinessStep[];
    const workflow = validateWorkflow(JSON.parse(version.workflow), business.length);
    let summary = run.summary ? JSON.parse(run.summary) as ReportSummary : null;
    if ((summary?.failedCallIndex === undefined ||
      (summary.failedCallKind === 'check' && ['count', 'visible'].includes(summary.failedCallType ?? '') && summary.failedObservedCount == null)) &&
      run.artifactDir) {
      // Existing records may need the original report to recover the failed call and observed count.
      const report = await readE2eReport(this.paths.safeJoin(run.artifactDir, 'e2e/report.json'), workflow, business, version.prerequisite != null, false)
        .catch(() => null);
      if (report) summary = report.summary;
    }
    if (version.prerequisite != null && summary?.prerequisite?.status !== 'passed') {
      return unavailable('用例前置条件未通过，请检查前置条件后重新运行');
    }
    const failedStep = summary?.failedBusinessStep;
    if (failedStep == null || !summary?.failedCallKind || !summary.failedCallType || summary.failedCallIndex == null) {
      return unavailable('运行报告无法定位具体失败操作或断言，可使用 AI 诊断查看原因');
    }
    const failedCall = { kind: summary.failedCallKind, type: summary.failedCallType, index: summary.failedCallIndex };
    if (failedCall.type === 'create-simulation-instance' && run.error?.startsWith('仿真实例创建冲突：')) {
      return unavailable('该地图已有同名仿真实例，请核对现有实例并准备独立测资后再验证。');
    }
    if (failedCall.type === 'start-simulation-instance' && /^开启实例 \d+\s*失败[：:]/.test(run.error ?? '')) {
      return unavailable('仿真服务已收到开启请求并返回失败。请查看原始错误并核对该实例的状态。');
    }
    const observedCount = summary.failedObservedCount ?? undefined;
    if (failedCall.type && isSessionOperation(failedCall.type)) {
      const page = failedCall.type === 'ensure-map-session' ? '地图' : '任务配置';
      return unavailable(page + '页面未就绪，请核对目标站点和登录状态后重新运行');
    }
    const target = { summary, failedStep, failedCall, observedCount };
    if (repeatedBindingSync(summary, run.error) && shouldResyncBinding(workflow, business, failedStep, failedCall.index)) {
      return { availability: { canStart: true, currentVersion, label: '验证异步同步修复' }, target: { ...target, resyncExistingBinding: true } };
    }
    if (!version.publishedAt && mapReadbackFailureStep(workflow, summary)) {
      if (run.mode === 'strict' && run.repairOf) return unavailable('地图回读修复试跑仍然失败，请核对原始错误');
      return { availability: { canStart: true, currentVersion, label: '验证地图回读修复' }, target: { ...target, mapReadback: true } };
    }
    if (failedCall.kind === 'check') {
      if (failedCall.type === 'count' && observedCount === 0 &&
          evidencedHookGraphRepair(workflow, failedStep, failedCall.index, observedCount, await this.readFailureScreen(run))) {
        return { availability: { canStart: true, currentVersion, label: '修复执行顺序节点定位并试跑' }, target };
      }
      if (!automatic && failedCall.type === 'visible' && observedCount === 0) {
        const defaultSkill = version.skill ?? this.planner.skillFor(testCase);
        const skill = business[failedStep - 1]?.skill ?? defaultSkill;
        const view = await this.planner.findVisibleLocatorRepair(skill, targetBaseUrl, {
          workflow, failedStep, checkIndex: failedCall.index, observedCount, screen: await this.readFailureScreen(run),
        }).catch(() => undefined);
        if (view) return { availability: { canStart: true, currentVersion, label: '应用 Skill 定位修复并试跑' }, target };
      }
      if (automatic || !isCountLocatorRepairable(workflow[failedStep - 1]?.checks[failedCall.index], observedCount)) {
        return unavailable('没有与失败现场匹配的已验证定位修复，可使用 AI 诊断查看原因');
      }
    }
    if (!(await this.settings.getModelConfig()).configured) return unavailable('请在设置中配置可用的 AI 模型后再发起修复');
    return { availability: { canStart: true, currentVersion }, target };
  }

  private async readFailureScreen(run: TestRun): Promise<string> {
    const artifacts = run.artifactDir;
    if (!artifacts) return '';
    const file = (await this.listArtifacts(run.id)).find((name) => /^e2e\/results\/[^/]+\/attempt-1\/screen-at-failure\.txt$/.test(name));
    if (!file) return '';
    const screen = await readFile(this.paths.safeJoin(artifacts, file), 'utf8').catch(() => '');
    return screen.length <= 6000 ? screen : screen.slice(0, 3000) + '\n[…]\n' + screen.slice(-3000);
  }

  private async find(id: number) {
    const run = await this.prisma.testRun.findUnique({ where: { id }, include: { testCase: true } });
    if (!run) throw new NotFoundException('执行记录不存在：' + id);
    return run;
  }

  private async findFailed(id: number) {
    const run = await this.find(id);
    if (!FAILED.includes(run.status) || !run.testCase || run.version === null || !run.targetBaseUrl) {
      throw new BadRequestException('该执行未关联可修复的失败版本');
    }
    return { ...run, testCase: run.testCase, version: run.version };
  }

  private enqueue(testCaseId: number, version: number, target: string, targetBaseUrl: string, mode: ExecutionMode, autoRepair = false) {
    return this.prisma.testRun.create({
      data: { testCaseId, version, target, targetBaseUrl, mode, autoRepair },
      include: { testCase: true },
    });
  }

  private schedule(): void {
    if (this.processing || this.stopping) return;
    this.processing = true;
    void this.processQueue().catch((error) => this.logger.error(error)).finally(() => {
      this.processing = false;
      if (!this.stopping) {
        void this.prisma.testRun.count({ where: { status: 'queued' } })
          .then((count) => { if (count) this.schedule(); })
          .catch((error) => this.logger.error(error));
      }
    });
  }

  private async processQueue(): Promise<void> {
    while (!this.stopping) {
      const run = await this.prisma.testRun.findFirst({ where: { status: 'queued' }, orderBy: { id: 'asc' } });
      if (!run) return;
      try {
        await this.execute(run);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.prisma.testRun.updateMany({
          where: { id: run.id, status: { in: ['queued', 'running'] } },
          data: { status: 'error', error: message, finishedAt: new Date() },
        });
      }
    }
  }

  private async execute(run: TestRun): Promise<void> {
    const { id, testCaseId, version: number, target, targetBaseUrl, mode } = run;
    if (!testCaseId || number === null || !targetBaseUrl) throw new BadRequestException('缺少执行版本或目标环境');
    const version = await this.cases.version(testCaseId, number);
    if (target !== version.scriptPath || !version.workflow) throw new BadRequestException('执行版本与脚本不匹配');
    await this.cases.checkSource(version);
    const steps = JSON.parse(version.steps) as BusinessStep[];
    const workflow = validateWorkflow(JSON.parse(version.workflow), steps.length);
    const usesLogin = usesTargetLogin(workflow);
    const hasPrerequisite = version.prerequisite != null;
    // A deterministic workflow can verify zero-model execution on its first run.
    const readOnly = mode !== 'explore' || !workflow.some(({ operations }) => operations.some((op) => op.type === 'act'));
    if (mode === 'explore' && version.publishedAt) throw new BadRequestException('发布快照不可重新录制');
    const cache = cacheDir(this.paths, testCaseId, number, targetBaseUrl);
    if (version.publishedAt && version.cacheFingerprint !== await cacheFingerprint(this.paths, cache, version.scriptHash!, targetBaseUrl, workflow, hasPrerequisite)) {
      throw new BadRequestException('发布版本的环境、依赖或缓存已变化，请创建新版本或修复');
    }
    const [settings, model] = await Promise.all([this.settings.get(), this.settings.getModelConfig()]);
    const { username, password } = settings.targetLogin;
    const hasCredentials = Boolean(username.trim()) && [...password].length >= 6;
    if (usesLogin && settings.targetBaseUrl !== targetBaseUrl) {
      throw new BadRequestException('测试站点已更改，请确认账号后重新发起运行');
    }
    if (usesLogin && !hasCredentials) {
      throw new BadRequestException('请在设置中填写测试账号和至少 6 个字符的测试密码');
    }

    const artifactDir = path.join(this.paths.artifactsRoot, 'run-' + id);
    const logPath = path.join(artifactDir, 'run.log');
    const output = path.join(artifactDir, 'e2e');
    const runOutput = path.join(this.paths.e2eProject, '.e2e', 'runs', 'run-' + id + '-' + randomUUID());
    await mkdir(artifactDir, { recursive: true });
    const environment: NodeJS.ProcessEnv = runnerEnvironment();
    const simulation = simulationCreationGuard(workflow);
    let verificationOf = run.summary ? (JSON.parse(run.summary) as RunSummary).verificationOf : undefined;
    if (!verificationOf && simulation && mode === 'strict') {
      verificationOf = (await this.prisma.testRun.findFirst({ where: { verificationRunId: id }, select: { id: true } }))?.id;
    }
    if (usesGeneratedMap(workflow)) {
      const mapDirectory = path.join(artifactDir, 'maps');
      await mkdir(mapDirectory, { recursive: true });
      environment.AUTOTEST_MAP_ARTIFACT_DIR = mapDirectory;
      if (process.env.TUSK_MAP_KEY) environment.TUSK_MAP_KEY = process.env.TUSK_MAP_KEY;
    }
    Object.assign(environment, {
      AUTOTEST_RUN_MODE: mode === 'explore' && readOnly ? 'strict' : mode,
      TARGET_BASE_URL: targetBaseUrl, E2E_TELEMETRY_DISABLED: '1', NO_COLOR: '1',
      CI: '1',
    });
    const runTimeoutMs = settings.runTimeoutMinutes * 60_000;
    const exploringWithAi = mode === 'explore' && !readOnly;
    const useRunTimeoutConfig = exploringWithAi || usesRunTimeout(workflow, hasPrerequisite);
    if (useRunTimeoutConfig) environment.AUTOTEST_EXPLORE_TIMEOUT_MS = String(runTimeoutMs);
    if (!readOnly && model.configured) Object.assign(environment, {
      MODEL_BASE_URL: model.baseUrl, MODEL_API_KEY: model.apiKey, MODEL_NAME: model.name,
      MODEL_TEMPERATURE: model.temperature?.toString(),
      MODEL_MAX_OUTPUT_TOKENS: model.maxOutputTokens?.toString(),
    });
    if (usesLogin || (hasPrerequisite && hasCredentials && settings.targetBaseUrl === targetBaseUrl)) {
      Object.assign(environment, { AUTOTEST_TARGET_USERNAME: username, AUTOTEST_TARGET_PASSWORD: password });
    }

    const start = Date.now();
    const cli = path.join(this.paths.e2eProject, 'node_modules', 'e2e', 'dist', 'cli', 'bin.js');
    const args = [cli, 'run', target, '--output', runOutput, '--cache-dir', cache, '--trace', 'on'];
    if (settings.showBrowser !== false) args.push('--headed');
    const proxy = needsTargetProxy(targetBaseUrl) ? await startTargetProxy(targetBaseUrl) : undefined;
    let outcome: Awaited<ReturnType<RunsService['runProcess']>>;
    try {
      if (proxy) {
        environment.TARGET_BASE_URL = proxy.url;
        environment.AUTOTEST_TARGET_IDENTITY = targetBaseUrl;
      }
      if (useRunTimeoutConfig) {
        args.push('--config', RUN_TIMEOUT_CONFIG);
      } else if (proxy) {
        args.push('--config', PROXY_CONFIG);
      } else if (usesLogin || environment.MODEL_TEMPERATURE !== undefined || environment.MODEL_MAX_OUTPUT_TOKENS !== undefined) {
        args.push('--config', RUNTIME_CONFIG);
      }
      if (readOnly) args.push('--strict-cache');
      const claimed = await this.prisma.testRun.updateMany({
        where: { id, status: 'queued' }, data: { status: 'running', startedAt: new Date(), artifactDir, logPath },
      });
      if (!claimed.count || this.stopping) return;
      const processTimeoutMs = runTimeoutMs + (useRunTimeoutConfig ? EXPLORE_REPORT_GRACE_MS : 0);
      outcome = await this.runProcess(id, args, environment, logPath, processTimeoutMs);
    } finally {
      proxy?.close();
    }
    await rename(runOutput, output).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    const normalTestFailure = outcome.code === 1 && !outcome.error && !outcome.timedOut;
    const report = await readE2eReport(path.join(output, 'report.json'), workflow, steps, hasPrerequisite, normalTestFailure).catch(() => null);
    const passed = outcome.code === 0 && report?.fullyPassed && (!readOnly || report.zeroAi);
    const status = outcome.timedOut || report?.timedOut ? 'timeout' : outcome.error ? 'error'
      : report?.summary.warning ? 'warning' : passed ? 'passed' : 'failed';
    const runError = (outcome.timedOut ? '运行器进程超时，已终止执行' : outcome.error ?? report?.error?.message) ??
      (status === 'passed' || status === 'warning' ? null : report && readOnly && outcome.code === 0
        ? '严格验证要求所有 Agent 动作都完整回放，且模型调用数为 0'
        : status === 'timeout' ? '本次执行已超时' : '执行失败，请查看日志和报告');
    const prerequisiteFailed = hasPrerequisite && report?.summary.prerequisite?.status !== 'passed';
    const error = prerequisiteFailed ? prerequisiteFailureMessage(runError ?? undefined) : runError;
    const conflict = status === 'failed' ? testDataConflict(workflow, report?.summary) : undefined;
    let deferred: RunSummary['verificationDeferred'];
    if (status === 'passed' && !readOnly) {
      const taskConfig = !simulation && taskConfigCreationGuard(workflow);
      deferred = simulation ?? (taskConfig ? { name: taskConfig.name } : undefined);
    }
    const repairVerification = verificationOf ? await this.prisma.testRun.findUnique({
      where: { id: verificationOf }, select: { repairOf: true },
    }) : null;
    const verifiesRepair = Boolean(run.repairOf || repairVerification?.repairOf);
    const skillLearning: RunSummary['skillLearning'] = verifiesRepair && status === 'passed'
      ? { status: 'pending-verification', reason: readOnly ? '严格验证已通过，正在写回 Skill。' : '修复试跑已通过，严格验证通过后才会写回 Skill。' }
      : verifiesRepair ? { status: 'skipped', reason: status === 'warning' ? '遇到同名仿真实例，已跳过后续验证。' : '修复试跑或严格验证未通过。' } : undefined;
    const summary = {
      ...(report?.summary ?? (prerequisiteFailed ? {
        prerequisite: { skill: TUSK_SERVICE_PREREQUISITE, status: 'failed', message: error },
      } : {})),
      ...(conflict ? { testDataConflict: conflict } : {}),
      ...(deferred ? { verificationDeferred: deferred } : {}),
      ...(verificationOf ? { verificationOf } : {}),
      ...(skillLearning ? { skillLearning } : {}),
    };
    const verified = status === 'passed' && readOnly;
    const fingerprint = verified ? await cacheFingerprint(this.paths, cache, version.scriptHash!, targetBaseUrl, workflow, hasPrerequisite) : null;
    const failure = report?.summary;
    const repairRequested = status === 'failed' && run.autoRepair && !prerequisiteFailed;
    const graphRepair = repairRequested && failure?.failedCallKind === 'check' && failure.failedCallType === 'count' &&
      failure.failedBusinessStep != null && failure.failedCallIndex != null && failure.failedObservedCount === 0 &&
      evidencedHookGraphRepair(workflow, failure.failedBusinessStep, failure.failedCallIndex, 0,
        await this.readFailureScreen({ ...run, artifactDir }).catch(() => ''));

    const recorded = await this.prisma.$transaction(async (tx) => {
      const failedStep = report?.summary.failedBusinessStep ?? null;
      const parent = run.repairOf && FAILED.includes(status) && failedStep !== null
        ? await tx.testRun.findFirst({
          where: { id: run.repairOf, testCaseId, targetBaseUrl, repairRunId: id },
          select: { version: true, target: true, summary: true },
        })
        : null;
      const previousStep = failureStep(parent?.summary ? JSON.parse(parent.summary) as ReportSummary : null);
      const regressed = failedStep !== null && previousStep !== null && failedStep < previousStep;
      const callKind = report?.summary.failedCallKind;
      const mapReadback = !run.repairOf && !version.publishedAt && mapReadbackFailureStep(workflow, failure);
      const syncFailure = repeatedBindingSync(failure, error);
      const resync = syncFailure && shouldResyncBinding(workflow, steps, syncFailure.step, syncFailure.index);
      const shouldRepair = repairRequested && !regressed && failedStep !== null &&
        (Boolean(mapReadback || graphRepair || resync) || isRepairableUiFailure(callKind, report?.summary.failedCallType, report?.error?.code));
      const errorMessage = conflict
        ? `第 ${conflict.step} 步发现 ${conflict.observedCount} 条同名配置「${conflict.name}」，已停止新增。\n${error}`
        : regressed
        ? `修复试跑在第 ${failedStep} 步提前失败。原运行 #${run.repairOf} 已到达第 ${previousStep} 步，本轮自动修复已停止。\n${error}`
        : repairRequested && !shouldRepair && callKind === 'check'
          ? `业务结果断言未通过，已停止自动修复。\n${error}`
          : repairRequested && failedStep === null
            ? `运行报告无法定位失败操作，已停止自动修复。\n${error}`
            : error;
      const finished = await tx.testRun.updateMany({
        where: { id, status: 'running' }, data: {
          status, exitCode: outcome.code, durationMs: Date.now() - start, aiCalls: report?.aiCalls ?? null,
          cacheHits: report?.cacheHits ?? null, summary: Object.keys(summary).length ? JSON.stringify(summary) : null, error: errorMessage, finishedAt: new Date(),
          repairState: regressed ? 'regressed' : shouldRepair ? 'pending' : null,
        },
      });
      if (!finished.count) return null;
      if (regressed && parent?.version != null && !version.publishedAt) {
        const previous = await tx.testCaseVersion.findUnique({
          where: { testCaseId_version: { testCaseId, version: parent.version } },
          select: { scriptPath: true, steps: true, prerequisite: true, publishedAt: true },
        });
        if (previous?.scriptPath === parent.target && previous.steps === version.steps && previous.prerequisite === version.prerequisite) {
          const published = Boolean(previous.publishedAt);
          await tx.testCase.updateMany({
            where: { id: testCaseId, currentVersion: number, status: 'trial-pending', scriptPath: target, steps: version.steps },
            data: {
              currentVersion: parent.version, scriptPath: previous.scriptPath,
              status: published ? 'published' : 'trial-pending', zeroAiVerified: false,
              executionMode: published ? 'strict' : 'explore',
            },
          });
        }
      }
      if (fingerprint && !version.publishedAt) {
        await tx.testCaseVersion.update({ where: { id: version.id }, data: { cacheFingerprint: fingerprint } });
      }
      if (verified || status === 'passed') {
        await tx.testCase.updateMany({
          where: { id: testCaseId, currentVersion: number, status: { notIn: ['published', 'deprecated'] } },
          data: { status: 'trial-passed', zeroAiVerified: verified, executionMode: verified ? 'strict' : 'explore' },
        });
      } else if (readOnly && status !== 'warning') {
        await tx.testCase.updateMany({
          where: { id: testCaseId, currentVersion: number }, data: { zeroAiVerified: false },
        });
      }
      if (status === 'passed' && !readOnly && !deferred) {
        const verification = await tx.testRun.create({
          data: { testCaseId, version: number, target, targetBaseUrl, mode: 'strict', summary: JSON.stringify({ verificationOf: id }) },
        });
        await tx.testRun.update({ where: { id }, data: { verificationRunId: verification.id } });
      }
      if (run.repairOf) await tx.testRun.updateMany({
        where: { id: run.repairOf }, data: { repairState: status === 'passed' ? 'trial-passed' : status === 'warning' ? 'warning' : 'failed' },
      });
      return { shouldRepair };
    });
    if (!recorded) return;
    if (verified && report) {
      let learning: Pick<RunSummary, 'skillLearning' | 'skillFile' | 'skillFiles'> | undefined;
      try {
        learning = await this.learnVerifiedRepair(run, version, targetBaseUrl, { workflow, steps, report });
      } catch (error) {
        this.logger.warn(`Skill 更新失败：${error instanceof Error ? error.message : String(error)}`);
        learning = { skillLearning: { status: 'failed', reason: '验证已通过，保存 Skill 时出错。' } };
      }
      if (learning || verifiesRepair) await this.prisma.testRun.update({
        where: { id }, data: { summary: JSON.stringify({ ...summary, ...(learning ?? {
          skillLearning: { status: 'skipped', reason: '未找到可复用且已验证的操作或定位变更。' },
        }) }) },
      });
    }
    if (recorded.shouldRepair) {
      await this.repair(id, true).catch(async (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        await this.prisma.testRun.updateMany({
          where: { id, repairState: 'pending' },
          data: { repairState: 'failed', diagnosis: '修复未执行：' + message },
        });
        this.logger.warn('修复未执行：' + message);
      });
    }
  }

  private async learnVerifiedRepair(
    run: TestRun,
    version: TestCaseVersion,
    targetBaseUrl: string,
    { workflow, steps, report }: { workflow: Workflow; steps: BusinessStep[]; report: Awaited<ReturnType<typeof readE2eReport>> },
  ): Promise<Pick<RunSummary, 'skillLearning' | 'skillFile' | 'skillFiles'> | undefined> {
    const { testCaseId, version: number } = version;
    const trial = run.repairOf ? run : await this.prisma.testRun.findFirst({
      where: { testCaseId, version: number, targetBaseUrl, status: 'passed', repairOf: { not: null } },
    });
    if (!trial?.repairOf) return;
    let source = await this.prisma.testRun.findUnique({ where: { id: trial.repairOf } });
    if (source?.version === number) {
      if (run.mode !== 'strict' || run.repairOf !== source.id || source.repairRunId !== run.id ||
          source.target !== run.target || source.targetBaseUrl !== targetBaseUrl || source.testCaseId !== testCaseId) return;
      const failedStep = mapReadbackFailureStep(workflow, source.summary ? JSON.parse(source.summary) as ReportSummary : null);
      if (!failedStep || !verifiedMapReadback(report, failedStep)) return;
      const testCase = await this.prisma.testCase.findUnique({ where: { id: testCaseId } });
      if (!testCase || testCase.currentVersion !== number) return;
      const skill = steps[failedStep - 1]!.skill ?? version.skill ?? this.planner.skillFor(testCase);
      const file = await this.skills.recordVerifiedRepair(skill, targetBaseUrl, run.id, [mapReadbackPractice]);
      if (file) return { skillFile: file, skillLearning: { status: 'recorded' } };
      return;
    }
    // Runtime verification belongs to the directly repaired failure. Earlier
    // trials in the chain may have failed in a completely different step.
    const syncFailure = source?.repairRunId === trial.id && source?.targetBaseUrl === targetBaseUrl && source?.testCaseId === testCaseId
      ? repeatedBindingSync(source.summary ? JSON.parse(source.summary) as ReportSummary : null, source.error) : undefined;
    while (source?.repairOf && source.repairOf < source.id) {
      source = await this.prisma.testRun.findUnique({ where: { id: source.repairOf } });
    }
    const testCase = await this.prisma.testCase.findUnique({ where: { id: testCaseId } });
    if (source?.version == null || testCase?.currentVersion !== number) return;
    const previous = await this.cases.version(testCaseId, source.version);
    if (!previous.workflow || previous.steps !== version.steps || previous.prerequisite !== version.prerequisite ||
        (previous.skill !== null && previous.skill !== version.skill)) return;
    const original = validateWorkflow(JSON.parse(previous.workflow), workflow.length);
    const graphPair = hookGraphCheckPair(original);
    const graphVerified = graphPair?.every(({ stepIndex, checkIndex, check }) => {
      const result = workflow[stepIndex]?.checks[checkIndex];
      return result?.type === check.type && result.key === check.key && result.hook === check.hook &&
        result.node === check.node && result.stage === check.stage;
    });
    const sourceSummary = source.summary ? JSON.parse(source.summary) as RunSummary : null;
    const defaultSkill = version.skill ?? this.planner.skillFor(testCase);
    const repairsBySkill = new Map<string, VerifiedRepair[]>();
    if (syncFailure && verifiedBindingSync(report, syncFailure)) {
      const op = workflow[syncFailure.step - 1]?.operations[syncFailure.index];
      if (op?.type === 'bind-paladin-map' && op.syncExisting) {
        repairsBySkill.set(steps[syncFailure.step - 1]!.skill ?? defaultSkill, [serviceSyncPractice]);
      }
    }
    let page = '';
    for (const [index, { operations, checks }] of workflow.entries()) {
      for (const op of operations) {
        if (op.type === 'open') page = op.path.split(/[?#]/, 1)[0]!;
      }
      const navigation = operations.filter((op) => REUSABLE_OPERATIONS.has(op.type));
      const previousNavigation = original[index]!.operations.filter((op) => REUSABLE_OPERATIONS.has(op.type));
      const changedNavigation = navigation.length > 0 && JSON.stringify(navigation) !== JSON.stringify(previousNavigation);
      const changedChecks: VerifiedCheck[] = [];
      const skill = steps[index]!.skill ?? defaultSkill;
      for (const [checkIndex, check] of checks.entries()) {
        const old = original[index]!.checks[checkIndex];
        const graphEntry = graphVerified && graphPair?.find((entry) => entry.stepIndex === index && entry.checkIndex === checkIndex);
        if (graphEntry && old?.type === 'count' && 'locator' in old && old.locator.kind === 'css') {
          changedChecks.push({ type: 'count', from: old.locator.value, replacement: graphEntry.check });
          continue;
        }
        if (!old || !('locator' in old) || old.locator.kind !== 'css' || !('locator' in check) || check.locator.kind !== 'css') continue;
        if (check.type === 'count' && old.type === 'count' && check.value > 0 && old.value === check.value &&
            narrowsClassSelector(check.locator.value, old.locator.value)) {
          changedChecks.push({ type: 'count', from: old.locator.value, to: check.locator.value });
        }
        if (check.type === 'visible' && old.type === 'visible' && check.locator.value !== old.locator.value &&
            sourceSummary?.failedBusinessStep === index + 1 && sourceSummary.failedCallIndex === checkIndex) {
          const rule = await this.planner.findVisibleLocatorRepair(skill, targetBaseUrl, {
            workflow: original, failedStep: index + 1, checkIndex, observedCount: 0, screen: await this.readFailureScreen(source),
          });
          if (rule?.to === check.locator.value) changedChecks.push({ type: 'visible', from: rule.from, to: rule.to });
        }
      }
      if (!changedNavigation && !changedChecks.length) continue;
      const repairs = repairsBySkill.get(skill) ?? [];
      repairs.push({ page, ...(changedNavigation ? { operations: navigation } : {}),
        ...(changedChecks.length ? { checks: changedChecks } : {}) });
      repairsBySkill.set(skill, repairs);
    }
    const skillFiles: string[] = [];
    let failed = false;
    for (const [skill, repairs] of repairsBySkill) {
      const file = await this.skills.recordVerifiedRepair(skill, targetBaseUrl, run.id, repairs).catch((error: unknown) => {
        failed = true;
        this.logger.warn(`Skill ${skill} 更新失败：${error instanceof Error ? error.message : String(error)}`);
      });
      if (file) skillFiles.push(file);
    }
    if (failed) return { skillFiles, skillLearning: { status: 'failed', reason: '一个或多个 Skill 文件写入失败。' } };
    if (!skillFiles.length) return;
    const learned = skillFiles.length === 1 ? { skillFile: skillFiles[0] } : { skillFiles };
    return { ...learned, skillLearning: { status: 'recorded' } };
  }

  private async runProcess(id: number, args: string[], env: NodeJS.ProcessEnv, logPath: string, timeout: number) {
    const child = spawn(process.execPath, args, {
      cwd: this.paths.e2eProject, env, windowsHide: true, detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.children.set(id, child);
    const log = createWriteStream(logPath);
    const logFinished = finished(log);
    void logFinished.catch(() => undefined);
    const secrets = [env.MODEL_API_KEY, env.AUTOTEST_TARGET_PASSWORD].filter((value): value is string => Boolean(value));
    for (const stream of [child.stdout, child.stderr]) {
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      lines.on('line', (line) => {
        for (const secret of secrets) line = line.replaceAll(secret, '[REDACTED]');
        log.write(line + '\n');
      });
    }
    let timedOut = false;
    let error: string | undefined;
    const timer = setTimeout(() => { timedOut = true; stopRunner(child); }, timeout);
    const code = await new Promise<number | null>((resolve) => {
      child.once('error', (err) => { error = err.message; });
      child.once('close', resolve);
    });
    clearTimeout(timer);
    this.children.delete(id);
    log.end();
    await logFinished;
    return { code, timedOut, error };
  }


}
