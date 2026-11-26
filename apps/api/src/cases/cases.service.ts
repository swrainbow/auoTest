import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { PrismaService } from '../prisma/prisma.service';
import { PathsService } from '../paths/paths.service';
import { SettingsService } from '../settings/settings.service';
import { isSkillDirectoryName } from '../skills/skill-directory-name';
import { PlannerService, type RepairEvidence } from '../planner/planner.service';
import { compileWorkflow, digest, TUSK_SERVICE_PREREQUISITE, validateWorkflow, type Workflow } from '../planner/workflow';
import { cacheDir, cacheFingerprint } from '../runs/replay-assets';
import type { BusinessStep, CasePrerequisite, TestCaseDto, TestCaseVersionDto, SaveTestCaseInput } from '@autotest/shared';
import { Prisma, type TestCase, type TestCaseVersion } from '@prisma/client';

type LastRun = { id: number; status: string; createdAt: Date };
type SavedScript = { scriptPath: string; content: string; version: number };

export function toCaseDto(c: TestCase, lastRuns: LastRun[] = []): TestCaseDto & { lastRuns: LastRun[] } {
  return {
    id: c.id, code: c.code, name: c.name, description: c.description, module: c.module,
    originalRequirement: c.originalRequirement,
    tags: c.tags.split(',').filter(Boolean),
    priority: c.priority as TestCaseDto['priority'],
    status: c.status as TestCaseDto['status'],
    executionMode: c.executionMode as TestCaseDto['executionMode'],
    currentVersion: c.currentVersion, scriptPath: c.scriptPath, steps: JSON.parse(c.steps),
    skill: c.skill, taskId: c.taskId, zeroAiVerified: c.zeroAiVerified,
    prerequisite: c.prerequisite ? JSON.parse(c.prerequisite) as CasePrerequisite : undefined,
    createdAt: c.createdAt.toISOString(), updatedAt: c.updatedAt.toISOString(), lastRuns,
  };
}

@Injectable()
export class CasesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly paths: PathsService,
    private readonly settings: SettingsService,
    private readonly planner: PlannerService,
  ) {}

  async list() {
    const cases = await this.prisma.testCase.findMany({
      orderBy: { id: 'asc' },
      include: { runs: { orderBy: { id: 'desc' }, take: 3, select: { id: true, status: true, createdAt: true } } },
    });
    return cases.map((c) => toCaseDto(c, c.runs));
  }

  async get(id: number): Promise<TestCaseDto & { lastRuns: LastRun[]; versions: TestCaseVersionDto[] }> {
    const c = await this.prisma.testCase.findUnique({
      where: { id },
      include: {
        runs: { orderBy: { id: 'desc' }, take: 5, select: { id: true, status: true, createdAt: true } },
        versions: { orderBy: { version: 'desc' } },
      },
    });
    if (!c) throw new NotFoundException('用例不存在：' + id);
    return {
      ...toCaseDto(c, c.runs),
      versions: c.versions.map((v) => ({
        id: v.id, version: v.version, steps: JSON.parse(v.steps), changeNote: v.changeNote,
        skill: v.skill,
        prerequisite: v.prerequisite ? JSON.parse(v.prerequisite) as CasePrerequisite : undefined,
        scriptPath: v.scriptPath, publishedAt: v.publishedAt?.toISOString() ?? null, createdAt: v.createdAt.toISOString(),
      })),
    };
  }

  async create(input: SaveTestCaseInput): Promise<TestCaseDto> {
    const data = this.caseData(input);
    const { originalRequirement } = input;
    if (originalRequirement !== undefined &&
        (typeof originalRequirement !== 'string' || !originalRequirement.trim() || originalRequirement.length > 8000)) {
      throw new BadRequestException('原始自然语言输入须为 1 至 8000 字');
    }
    return this.prisma.$transaction(async (tx) => {
      const last = await tx.testCase.findFirst({ orderBy: { id: 'desc' }, select: { id: true, code: true } });
      const number = last ? Math.max(last.id, Number(last.code.slice(3)) || 0) + 1 : 1;
      const c = await tx.testCase.create({
        data: {
          ...data, originalRequirement, code: 'TC-' + String(number).padStart(3, '0'),
          versions: { create: {
            version: 1, steps: data.steps, skill: this.planner.skillFor(data), prerequisite: data.prerequisite, changeNote: '初始版本',
          } },
        },
      });
      return toCaseDto(c);
    });
  }

  async update(id: number, input: SaveTestCaseInput & { changeNote?: string }): Promise<TestCaseDto> {
    const c = await this.find(id);
    if (c.status === 'published' || c.status === 'deprecated') throw new BadRequestException('请先创建新版本再编辑');
    const data = this.caseData(input, c.prerequisite);
    const changed = (['name', 'description', 'module', 'skill', 'taskId', 'steps', 'prerequisite'] as const)
      .some((key) => data[key] !== c[key]);
    if (!changed) return toCaseDto(await this.prisma.testCase.update({
      where: { id, currentVersion: c.currentVersion, status: c.status },
      data: { priority: data.priority, tags: data.tags, executionMode: data.executionMode },
    }));
    return this.prisma.$transaction(async (tx) => {
      const version = await this.nextVersion(tx, c);
      const updated = await tx.testCase.update({
        where: { id, currentVersion: c.currentVersion, status: c.status },
        data: {
          ...data, scriptPath: null, currentVersion: version, zeroAiVerified: false, status: 'draft',
          versions: { create: {
            version, steps: data.steps, skill: this.planner.skillFor(data), prerequisite: data.prerequisite,
            changeNote: input.changeNote?.trim() || '更新用例配置',
          } },
        },
      });
      return toCaseDto(updated);
    });
  }

  async updateStatus(id: number, status: string): Promise<TestCaseDto> {
    const c = await this.find(id);
    if (status === 'draft' && ['published', 'deprecated'].includes(c.status)) {
      return this.prisma.$transaction(async (tx) => {
        const version = await this.nextVersion(tx, c);
        return toCaseDto(await tx.testCase.update({
          where: { id, currentVersion: c.currentVersion, status: c.status },
          data: {
            currentVersion: version, status: 'draft', scriptPath: null, zeroAiVerified: false, executionMode: 'explore',
            versions: { create: {
              version, steps: c.steps, skill: this.planner.skillFor(c), prerequisite: c.prerequisite, changeNote: '基于历史版本创建草稿',
            } },
          },
        }));
      });
    }
    if (status === 'deprecated' && c.status === 'published') {
      return toCaseDto(await this.prisma.testCase.update({
        where: { id, currentVersion: c.currentVersion, status: c.status }, data: { status },
      }));
    }
    if (status !== 'published' || c.status !== 'trial-passed' || !c.zeroAiVerified) {
      throw new BadRequestException('当前版本需通过严格回放验证后才能发布');
    }
    const version = await this.version(id, c.currentVersion);
    const { targetBaseUrl } = await this.settings.get();
    await this.checkSource(version);
    const workflow = validateWorkflow(JSON.parse(version.workflow ?? 'null'), (JSON.parse(version.steps) as BusinessStep[]).length);
    const fingerprint = await cacheFingerprint(
      this.paths, cacheDir(this.paths, id, version.version, targetBaseUrl), version.scriptHash!, targetBaseUrl,
      workflow, Boolean(version.prerequisite),
    );
    if (version.cacheFingerprint !== fingerprint) throw new BadRequestException('环境、依赖或缓存已变化，请重新验证严格回放');
    return this.prisma.$transaction(async (tx) => {
      const exploring = await tx.testRun.count({
        where: { testCaseId: id, version: c.currentVersion, mode: 'explore', status: { in: ['queued', 'running'] } },
      });
      if (exploring) throw new ConflictException('该版本还有探索执行，请等待结束后重新验证');
      await tx.testCaseVersion.update({ where: { id: version.id }, data: { publishedAt: new Date() } });
      const updated = await tx.testCase.update({
        where: { id, currentVersion: c.currentVersion, status: 'trial-passed', zeroAiVerified: true },
        data: { status: 'published', executionMode: 'strict' },
      });
      return toCaseDto(updated);
    });
  }

  async remove(id: number): Promise<{ ok: true }> {
    await this.find(id);
    await this.prisma.testCase.delete({ where: { id } });
    return { ok: true };
  }

  async readScript(id: number, number?: number): Promise<{ scriptPath: string; content: string }> {
    const c = await this.find(id);
    const version = await this.version(id, number ?? c.currentVersion);
    return { scriptPath: version.scriptPath!, content: await this.checkSource(version) };
  }

  async generationSource(id: number, expectedVersion?: number): Promise<TestCase> {
    if (expectedVersion !== undefined && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)) {
      throw new BadRequestException('用例版本无效');
    }
    const c = await this.find(id);
    if (expectedVersion !== undefined && c.currentVersion !== expectedVersion) {
      throw new ConflictException('用例版本已更新，请刷新后再生成脚本');
    }
    if (c.status === 'published' || c.status === 'deprecated') throw new BadRequestException('请先创建新版本');
    return c;
  }

  async generateScript(
    id: number, expectedVersion: number,
    onSaved: (tx: Prisma.TransactionClient, asset: SavedScript) => Promise<void>,
  ): Promise<SavedScript> {
    const c = await this.generationSource(id, expectedVersion);
    const version = await this.version(c.id, c.currentVersion);
    const steps = JSON.parse(version.steps) as BusinessStep[];
    const prerequisite = version.prerequisite ? JSON.parse(version.prerequisite) as CasePrerequisite : undefined;
    if (prerequisite) {
      const skillFile = this.paths.safeJoin(this.paths.skillsRoot, prerequisite.skill + '/SKILL.md');
      await access(skillFile).catch(() => { throw new BadRequestException('前置 Skill 不存在：' + prerequisite.skill); });
    }
    const { name, description, taskId } = c;
    const skill = version.skill ?? this.planner.skillFor(c);
    const result = await this.planner.generateWorkflow({ name, description, skill, taskId, steps, prerequisite });
    return this.saveScript(c, steps, skill, result, 'AI 生成测试流程', version.prerequisite, onSaved).catch((error: unknown) => {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        throw new ConflictException('生成期间用例版本或状态已变化，请在当前版本重新生成');
      }
      throw error;
    });
  }

  async repair<T>(id: number, versionNumber: number, targetBaseUrl: string, evidence: RepairEvidence,
    queueTrial: (tx: Prisma.TransactionClient, asset: SavedScript & { diagnosis: string }) => Promise<T>,
  ) {
    const c = await this.find(id);
    if (c.currentVersion !== versionNumber || c.status === 'deprecated') {
      throw new ConflictException('运行对应的版本已变化，请执行当前版本后修复');
    }
    const version = await this.version(id, versionNumber);
    if (!version.workflow) throw new BadRequestException('原版本缺少结构化测试流程');
    const steps = JSON.parse(version.steps) as BusinessStep[];
    const original = validateWorkflow(JSON.parse(version.workflow), steps.length);
    const { name, description, taskId } = c;
    const skill = version.skill ?? this.planner.skillFor(c);
    const prerequisite = version.prerequisite ? JSON.parse(version.prerequisite) as CasePrerequisite : undefined;
    const result = await this.planner.repairWorkflow({ name, description, skill, taskId, steps, prerequisite }, original, targetBaseUrl, evidence);
    const failedVersions = await this.prisma.testCaseVersion.findMany({
      where: { testCaseId: id, version: { in: evidence.priorFailures.map((failure) => failure.version) } },
      select: { workflow: true, steps: true, prerequisite: true },
    });
    const candidate = JSON.stringify(result.workflow);
    if (failedVersions.some((failed) =>
      failed.workflow === candidate && failed.steps === version.steps && failed.prerequisite === version.prerequisite,
    )) {
      throw new ConflictException('修复方案与近期同环境已失败的脚本相同，未重复试跑');
    }
    const changeNote = result.repairKind === 'check-locator'
      ? '修正断言定位，保留原业务预期'
      : result.repairKind === 'service-sync' ? '已有地图绑定也提交同步，并等待读回两个服务的结果'
      : 'AI 修复测试操作，保留原业务断言';
    const asset = await this.saveScript(c, steps, skill, result, changeNote, version.prerequisite,
      (tx, saved) => queueTrial(tx, { ...saved, diagnosis: result.diagnosis }),
    );
    return { ...asset, savedResult: asset.savedResult! };
  }

  async version(id: number, version: number) {
    const result = await this.prisma.testCaseVersion.findUnique({
      where: { testCaseId_version: { testCaseId: id, version } },
    });
    if (!result) throw new NotFoundException('用例版本不存在');
    return result;
  }

  async checkSource(version: TestCaseVersion): Promise<string> {
    if (!version.scriptPath || !version.scriptHash) throw new BadRequestException('请先生成当前版本的执行脚本');
    const file = this.paths.safeJoin(this.paths.e2eProject, version.scriptPath);
    const content = await readFile(file, 'utf8').catch(() => '');
    if (digest(content) !== version.scriptHash) throw new BadRequestException('用例脚本缺失或被修改，请生成新版本');
    return content;
  }

  private async find(id: number) {
    const c = await this.prisma.testCase.findUnique({ where: { id } });
    if (!c) throw new NotFoundException('用例不存在：' + id);
    return c;
  }

  private async nextVersion(db: Prisma.TransactionClient, c: TestCase): Promise<number> {
    const { _max } = await db.testCaseVersion.aggregate({ where: { testCaseId: c.id }, _max: { version: true } });
    return Math.max(c.currentVersion, _max.version ?? 0) + 1;
  }

  private async saveScript<T = undefined>(
    c: TestCase, steps: BusinessStep[], skill: string, { workflow, knowledgeHash }: { workflow: Workflow; knowledgeHash: string }, changeNote: string,
    prerequisite: string | null, onSaved?: (tx: Prisma.TransactionClient, asset: SavedScript) => Promise<T>,
  ) {
    const version = await this.nextVersion(this.prisma, c);
    const scriptPath = 'tests/generated/' + c.code + '/v' + version + '-' + randomUUID().slice(0, 8) + '.e2e.ts';
    const content = compileWorkflow(c.code + ' ' + c.name, steps, workflow,
      prerequisite ? JSON.parse(prerequisite) as CasePrerequisite : undefined);
    const full = this.paths.safeJoin(this.paths.e2eProject, scriptPath);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, { encoding: 'utf8', flag: 'wx' });
    const asset = { scriptPath, content, version };
    const savedResult = await this.prisma.$transaction(async (tx) => {
      await tx.testCase.update({
        where: { id: c.id, currentVersion: c.currentVersion, status: c.status },
        data: {
          currentVersion: version, steps: JSON.stringify(steps), scriptPath, zeroAiVerified: false, status: 'trial-pending', executionMode: 'explore',
          versions: {
            create: { version, steps: JSON.stringify(steps), skill, prerequisite, scriptPath, scriptHash: digest(content), workflow: JSON.stringify(workflow), knowledgeHash, changeNote },
          },
        },
      });
      return onSaved?.(tx, asset);
    }).catch(async (error) => {
      await unlink(full).catch(() => undefined);
      throw error;
    });
    return { ...asset, savedResult };
  }

  private caseData(input: SaveTestCaseInput, savedPrerequisite: string | null = null) {
    if (typeof input?.name !== 'string' || !input.name.trim()) throw new BadRequestException('请输入用例名称');
    if (!Array.isArray(input.steps) || input.steps.length < 1 || input.steps.length > 30 ||
        input.steps.some((step) => typeof step?.action !== 'string' || !step.action.trim() ||
          typeof step.expected !== 'string' || !step.expected.trim())) {
      throw new BadRequestException('请输入 1 至 30 条完整的动作与预期');
    }
    const steps = input.steps.map((step, i): BusinessStep => {
      const { skill } = step;
      if (skill !== undefined && skill !== '' && !isSkillDirectoryName(skill)) {
        throw new BadRequestException(`第 ${i + 1} 步的业务 Skill 目录名无效`);
      }
      return { order: i + 1, action: step.action.trim(), expected: step.expected.trim(), ...(skill ? { skill } : {}) };
    });
    if (input.skill != null && input.skill !== '' && !isSkillDirectoryName(input.skill)) {
      throw new BadRequestException('Skill 目录名无效');
    }
    if (input.taskId && !/^[\p{L}\p{N}_-]{1,100}$/u.test(input.taskId)) throw new BadRequestException('任务 ID 格式无效');
    if (input.priority && !['P0', 'P1', 'P2', 'P3'].includes(input.priority)) throw new BadRequestException('优先级无效');
    if (input.executionMode && !['explore', 'replay', 'strict'].includes(input.executionMode)) throw new BadRequestException('执行模式无效');
    return {
      name: input.name.trim(), description: input.description ?? '', module: input.module?.trim() || '通用',
      skill: input.skill ?? '', taskId: input.taskId ?? '',
      prerequisite: input.prerequisite === undefined ? savedPrerequisite : serializePrerequisite(input.prerequisite),
      tags: (input.tags ?? []).join(','), priority: input.priority ?? 'P1',
      executionMode: input.executionMode ?? 'explore', steps: JSON.stringify(steps),
    };
  }
}

function serializePrerequisite(value: CasePrerequisite | null): string | null {
  if (value === null) return null;
  if (value?.skill !== TUSK_SERVICE_PREREQUISITE) throw new BadRequestException('不支持所选前置 Skill');
  if (typeof value.mapName !== 'string' || !value.mapName.trim() || value.mapName.length > 200 || /[\r\n\0]/.test(value.mapName)) {
    throw new BadRequestException('请填写有效的地图名称（最多 200 个字符）');
  }
  if (value.serviceName !== undefined && (typeof value.serviceName !== 'string' || value.serviceName.length > 200 ||
      /[\r\n\0]/.test(value.serviceName) || (value.serviceName.trim() && !/^paladin/i.test(value.serviceName.trim())))) {
    throw new BadRequestException('Paladin 服务名称须以 paladin 开头（最多 200 个字符）');
  }
  const serviceName = value.serviceName?.trim();
  return JSON.stringify({ skill: value.skill, mapName: value.mapName.trim(), ...(serviceName ? { serviceName } : {}) });
}
