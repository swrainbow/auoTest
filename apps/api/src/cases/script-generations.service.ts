import { HttpException, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Prisma, type ScriptGeneration } from '@prisma/client';
import type { ScriptGenerationJob } from '@autotest/shared';
import { PrismaService } from '../prisma/prisma.service';
import { CasesService } from './cases.service';

const ACTIVE = ['queued', 'running'];

function toJob({ activeKey: _activeKey, status, createdAt, updatedAt, ...job }: ScriptGeneration): ScriptGenerationJob {
  return {
    ...job,
    status: status as ScriptGenerationJob['status'],
    createdAt: createdAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
  };
}

@Injectable()
export class ScriptGenerationsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ScriptGenerationsService.name);
  private readonly scheduled = new Set<number>();
  private stopping = false;

  constructor(private readonly prisma: PrismaService, private readonly cases: CasesService) {}

  async onApplicationBootstrap(): Promise<void> {
    // As with test runs, an interrupted provider call requires an explicit retry.
    await this.prisma.scriptGeneration.updateMany({
      where: { status: 'running' },
      data: { status: 'failed', activeKey: null, error: '平台重启，脚本生成已中断，请重新生成。' },
    });
    const queued = await this.prisma.scriptGeneration.findMany({
      where: { status: 'queued' }, select: { id: true }, orderBy: { id: 'asc' },
    });
    for (const { id } of queued) this.schedule(id);
  }

  onModuleDestroy(): void {
    this.stopping = true;
  }

  async enqueue(caseId: number, expectedVersion?: number): Promise<ScriptGenerationJob> {
    const source = await this.cases.generationSource(caseId, expectedVersion);
    const activeKey = `${source.id}:${source.currentVersion}`;
    const job = await this.prisma.scriptGeneration.upsert({
      where: { activeKey },
      update: {},
      create: {
        activeKey, testCaseId: source.id, caseCode: source.code, caseName: source.name,
        sourceVersion: source.currentVersion,
      },
    }).catch(async (error: unknown) => {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
      const duplicate = await this.prisma.scriptGeneration.findFirst({
        where: { testCaseId: source.id, sourceVersion: source.currentVersion }, orderBy: { id: 'desc' },
      });
      if (!duplicate) throw error;
      return duplicate;
    });
    if (job.status === 'queued') this.schedule(job.id);
    return toJob(job);
  }

  async latest(caseId: number): Promise<ScriptGenerationJob | null> {
    const job = await this.prisma.scriptGeneration.findFirst({ where: { testCaseId: caseId }, orderBy: { id: 'desc' } });
    if (job?.status === 'queued') this.schedule(job.id);
    return job ? toJob(job) : null;
  }

  async list(): Promise<ScriptGenerationJob[]> {
    const [active, completed] = await this.prisma.$transaction([
      this.prisma.scriptGeneration.findMany({ where: { status: { in: ACTIVE } } }),
      this.prisma.scriptGeneration.findMany({ where: { status: { notIn: ACTIVE } }, orderBy: { id: 'desc' }, take: 20 }),
    ]);
    for (const job of active) {
      if (job.status === 'queued') this.schedule(job.id);
    }
    return [...active, ...completed].sort((a, b) => b.id - a.id).map(toJob);
  }

  private schedule(id: number): void {
    if (this.stopping || this.scheduled.has(id)) return;
    this.scheduled.add(id);
    setImmediate(() => {
      if (this.stopping) {
        this.scheduled.delete(id);
        return;
      }
      void this.run(id).catch((error: unknown) => this.logger.error(error)).finally(() => this.scheduled.delete(id));
    });
  }

  private async run(id: number): Promise<void> {
    const { count } = await this.prisma.scriptGeneration.updateMany({ where: { id, status: 'queued' }, data: { status: 'running' } });
    if (count === 0) return;
    try {
      const job = await this.prisma.scriptGeneration.findUnique({ where: { id } });
      if (!job) return;
      await this.cases.generateScript(job.testCaseId, job.sourceVersion, async (tx, asset) => {
        await tx.scriptGeneration.update({
          where: { id, status: 'running' },
          data: { status: 'succeeded', activeKey: null, resultVersion: asset.version, scriptPath: asset.scriptPath },
        });
      });
    } catch (error) {
      if (!(error instanceof HttpException)) this.logger.error(error);
      await this.prisma.scriptGeneration.updateMany({
        where: { id, status: 'running' },
        data: { status: 'failed', activeKey: null, error: error instanceof HttpException ? error.message : '保存生成结果时出错，请重新生成。' },
      });
    }
  }
}
