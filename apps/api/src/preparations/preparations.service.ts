import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, OnApplicationBootstrap, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import type { PreparationFlow as FlowRow, PreparationRule as RuleRow, Prisma } from '@prisma/client';
import type { PreparationFlow, PreparationRule, PreparationRun, PreparationSkill, PreparationSkillId, PreparationWorkspace } from '@autotest/shared';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { PreparationRunner } from './preparation-runner';

const skills: PreparationSkill[] = [
  { id: 'service-sync', name: '同步服务', description: '读取服务清单并同步尚未就绪的服务。' },
  { id: 'map-binding', requires: 'service-sync', name: '绑定地图', description: '保留已有地图并绑定目标地图。新增绑定后，分别同步对应的 Paladin 和 Rattletrap 服务。' },
  { id: 'readiness-check', requires: 'map-binding', name: '复核就绪状态', description: '回读服务同步状态和地图绑定，记录交接结果。' },
];
const defaultSteps = skills.map((skill) => skill.id);
const includeFlow = { flow: { include: { rule: true } } } as const;
type RunRow = Prisma.PreparationRunGetPayload<{ include: typeof includeFlow }>;

function toRule(row: RuleRow): PreparationRule {
  return { version: row.version, selection: row.selection as PreparationRule['selection'],
    status: row.status as PreparationRule['status'], createdAt: row.createdAt.toISOString() };
}

function toFlow(row: FlowRow): PreparationFlow {
  return { id: row.id, name: row.name, steps: JSON.parse(row.steps), ruleVersion: row.ruleVersion, createdAt: row.createdAt.toISOString() };
}

function toRun(row: RunRow): PreparationRun {
  return { id: row.id, flowId: row.flowId, flowName: row.flow.name, ruleVersion: row.flow.ruleVersion,
    selection: row.flow.rule.selection as PreparationRule['selection'], targetBaseUrl: row.targetBaseUrl,
    mapName: row.mapName, serviceName: row.serviceName, status: row.status as PreparationRun['status'],
    createdAt: row.createdAt.toISOString(), finishedAt: row.finishedAt?.toISOString() ?? null, error: row.error,
    steps: JSON.parse(row.steps), evidence: row.evidence ? JSON.parse(row.evidence) : undefined };
}

function inputText(value: unknown, label: string, required = true): string {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string' || (required && !value.trim()) || value.length > 256) {
    throw new BadRequestException(label + '须为 256 字以内的文本' + (required ? '且不能为空' : ''));
  }
  return value.trim();
}

function validateSteps(value: unknown): PreparationSkillId[] {
  if (!Array.isArray(value) || !value.length) throw new BadRequestException('准备流程至少需要一个步骤');
  const selected = new Set<PreparationSkillId>();
  for (const id of value) {
    const skill = skills.find((item) => item.id === id);
    if (!skill) throw new BadRequestException('流程包含未知的准备 Skill');
    if (selected.has(skill.id)) throw new BadRequestException('流程中重复选择了“' + skill.name + '”');
    if (skill.requires && !selected.has(skill.requires)) {
      const prerequisite = skills.find((item) => item.id === skill.requires)!;
      throw new BadRequestException('请先添加“' + prerequisite.name + '”，再执行“' + skill.name + '”');
    }
    selected.add(skill.id);
  }
  return [...selected];
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

@Injectable()
export class PreparationsService implements OnApplicationBootstrap, OnModuleDestroy {
  private processing?: Promise<void>;
  private stopping = false;
  private readonly logger = new Logger(PreparationsService.name);
  private catalog?: Promise<void>;

  constructor(private readonly prisma: PrismaService, private readonly settings: SettingsService,
    private readonly runner: PreparationRunner) {}

  async onApplicationBootstrap(): Promise<void> {
    // Older installations continue serving business cases until the new tables are installed.
    try {
      const interrupted = await this.prisma.preparationRun.findMany({ where: { status: 'running' }, include: includeFlow });
      for (const row of interrupted) await this.finish(toRun(row), '平台重启，原运行中断，请核对已有配置后重试');
      this.schedule();
    } catch (error) {
      if ((error as { code?: string }).code !== 'P2021') throw error;
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    this.runner.onModuleDestroy();
    await this.processing;
  }

  private ensureCatalog(): Promise<void> {
    return this.catalog ??= this.seed().catch((error: unknown) => {
      this.catalog = undefined;
      if ((error as {code?: string}).code === 'P2021') {
        throw new ServiceUnavailableException('准备工作台数据表尚未初始化，请在 apps/api 目录执行 prisma db push');
      }
      throw error;
    });
  }

  private async seed(): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.preparationRule.upsert({ where: { version: 1 }, update: {}, create: { version: 1, selection: 'unique' } }),
      this.prisma.preparationFlow.upsert({ where: { id: 'service-map' }, update: {},
        create: { id: 'service-map', name: '服务同步与地图绑定', ruleVersion: 1, steps: JSON.stringify(defaultSteps) } }),
    ]);
  }

  async workspace(): Promise<PreparationWorkspace> {
    await this.ensureCatalog();
    const [settings, rules, flows, rows] = await Promise.all([
      this.settings.get(), this.prisma.preparationRule.findMany({ orderBy: { version: 'desc' } }),
      this.prisma.preparationFlow.findMany({ orderBy: { createdAt: 'desc' } }),
      this.prisma.preparationRun.findMany({ orderBy: { createdAt: 'desc' }, take: 100, include: includeFlow }),
    ]);
    const runs = await Promise.all(rows.map((row) => this.hydrate(toRun(row))));
    return { targetBaseUrl: settings.targetBaseUrl, skills, rules: rules.map(toRule), flows: flows.map(toFlow), runs };
  }

  async saveRule(input: { selection?: unknown }): Promise<PreparationRule> {
    if (input.selection !== 'unique' && input.selection !== 'explicit') throw new BadRequestException('请选择服务识别规则');
    await this.ensureCatalog();
    return toRule(await this.prisma.preparationRule.create({ data: { selection: input.selection } }));
  }

  async saveFlow(input: { name?: unknown; steps?: unknown; ruleVersion?: unknown }): Promise<PreparationFlow> {
    const name = inputText(input.name, '流程名称');
    const steps = validateSteps(input.steps);
    if (typeof input.ruleVersion !== 'number' || !Number.isSafeInteger(input.ruleVersion) || input.ruleVersion < 1) {
      throw new BadRequestException('请选择有效的规则版本');
    }
    await this.ensureCatalog();
    if (!await this.prisma.preparationRule.findUnique({ where: { version: input.ruleVersion } })) throw new BadRequestException('规则版本不存在');
    return toFlow(await this.prisma.preparationFlow.create({ data: { name, steps: JSON.stringify(steps), ruleVersion: input.ruleVersion } }));
  }

  async enqueue(input: {flowId?: unknown; mapName?: unknown; serviceName?: unknown; targetBaseUrl?: unknown}): Promise<PreparationRun> {
    await this.ensureCatalog();
    const flow = await this.prisma.preparationFlow.findUnique({ where: { id: inputText(input.flowId, '流程编号') }, include: { rule: true } });
    if (!flow) throw new NotFoundException('准备流程不存在');
    const ids = validateSteps(JSON.parse(flow.steps));
    const includesMap = ids.includes('map-binding');
    const mapName = inputText(input.mapName, '地图名称', includesMap);
    const serviceName = inputText(input.serviceName, 'Paladin 服务全名', includesMap && flow.rule.selection === 'explicit');
    const { targetBaseUrl } = await this.settings.get();
    if (input.targetBaseUrl !== undefined && input.targetBaseUrl !== targetBaseUrl) {
      throw new ConflictException('目标站点已变化，请刷新工作台后重新运行');
    }
    const steps = ids.map((id) =>
      ({ skillId: id, name: skills.find((skill) => skill.id === id)!.name, status: 'pending', evidence: '' }));
    const row = await this.prisma.preparationRun.create({
      data: { flowId: flow.id, targetBaseUrl, mapName, serviceName, steps: JSON.stringify(steps) }, include: includeFlow,
    });
    this.schedule();
    return toRun(row);
  }

  private async hydrate(run: PreparationRun): Promise<PreparationRun> {
    return run.status === 'running' ? { ...run, ...await this.runner.result(run) } : run;
  }

  async get(id: string): Promise<PreparationRun> {
    await this.ensureCatalog();
    const row = await this.prisma.preparationRun.findUnique({ where: { id }, include: includeFlow });
    if (!row) throw new NotFoundException('准备运行不存在');
    return this.hydrate(toRun(row));
  }

  private schedule(): void {
    if (this.processing || this.stopping) return;
    this.processing = this.processQueue().catch((error) => this.logger.error(error)).finally(() => {
      this.processing = undefined;
      if (!this.stopping) void this.prisma.preparationRun.count({ where: { status: 'queued' } })
        .then((count) => { if (count) this.schedule(); }).catch((error) => this.logger.error(error));
    });
  }

  private async processQueue(): Promise<void> {
    while (!this.stopping) {
      const row = await this.prisma.preparationRun.findFirst({ where: { status: 'queued' }, orderBy: { createdAt: 'asc' }, include: includeFlow });
      if (!row || this.stopping) return;
      const claim = await this.prisma.preparationRun.updateMany({ where: { id: row.id, status: 'queued' }, data: { status: 'running' } });
      if (!claim.count) continue;
      const run = toRun(row);
      let error: string | null = null;
      try {
        await this.runner.execute(run, await this.settings.get());
      } catch (cause) {
        error = message(cause);
      }
      await this.finish(run, error);
    }
  }

  private async finish(run: PreparationRun, error: string | null): Promise<void> {
    try {
      Object.assign(run, await this.runner.result(run));
    } catch (cause) {
      error ??= '无法读取步骤证据：' + message(cause);
    }
    const firstIncomplete = run.steps.find((step) => step.status !== 'passed');
    if (firstIncomplete) {
      const stepError = firstIncomplete.status === 'failed' ? firstIncomplete.evidence : '';
      error = stepError || error || '步骤缺少成功回读记录';
      Object.assign(firstIncomplete, { status: 'failed', evidence: error });
      for (const step of run.steps.slice(run.steps.indexOf(firstIncomplete) + 1)) {
        Object.assign(step, { status: 'skipped', evidence: '前序步骤未完成' });
      }
    }
    const status = error ? 'failed' : 'passed';
    const data = { status, error, finishedAt: new Date(), steps: JSON.stringify(run.steps), evidence: JSON.stringify(run.evidence) };
    await this.prisma.$transaction(async (tx) => {
      await tx.preparationRun.update({ where: { id: run.id }, data });
      if (status === 'passed' && run.steps.some((step) => step.skillId === 'readiness-check')) {
        await tx.preparationRule.update({ where: { version: run.ruleVersion }, data: { status: 'verified' } });
      }
    });
  }
}
