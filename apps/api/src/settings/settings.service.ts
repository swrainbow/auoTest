import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PathsService } from '../paths/paths.service';
import type { PlatformSettings, ScriptReasoning, UpdateSettingsInput } from '@autotest/shared';

const SCRIPT_REASONING_MODES: ReadonlySet<string> = new Set<ScriptReasoning>(['auto', 'off', 'low', 'high', 'max', 'provider']);
const DEFAULT_SCRIPT_TIMEOUT_SECONDS = 120;

function isScriptTimeout(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 30 && value <= 300;
}

function isScriptReasoning(value: unknown): value is ScriptReasoning {
  return typeof value === 'string' && SCRIPT_REASONING_MODES.has(value);
}

export function supportsScriptReasoning(baseUrl: string, name: string): boolean {
  const url = URL.parse(baseUrl);
  return Boolean(url && url.origin === 'https://api.deepseek.com' && /^\/(?:v1\/?)?$/.test(url.pathname) &&
    !url.username && !url.password && !url.search && !url.hash &&
    (name.trim() === 'deepseek-flash' || name.trim() === 'deepseek-v4-pro'));
}

function httpUrl(value: string): string {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) {
      throw new Error();
    }
    return url.href.replace(/\/$/, '');
  } catch {
    throw new BadRequestException('请输入有效的 HTTP(S) 基地址');
  }
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new BadRequestException(label + '须为文本');
  return value;
}

function optionalNumber(value: string | undefined): number | null {
  return value === undefined || value === '' ? null : Number(value);
}

@Injectable()
export class SettingsService {
  constructor(private readonly prisma: PrismaService, private readonly paths: PathsService) {}

  async get(): Promise<PlatformSettings> {
    const rows = await this.rows();
    const model = this.model(rows);
    const savedKey = rows.get('modelApiKey');
    return {
      targetBaseUrl: rows.get('targetBaseUrl') || 'http://127.0.0.1:' + (process.env.PORT || '3211'),
      runTimeoutMinutes: Number(rows.get('runTimeoutMinutes')) || 10,
      showBrowser: rows.get('showBrowser') !== 'false',
      targetLogin: {
        username: rows.get('targetUsername') ?? '',
        password: rows.get('targetPassword') ?? '',
      },
      model: {
        ...model,
        apiKey: savedKey ?? '',
        apiKeyFromEnvironment: savedKey === undefined && Boolean(model.apiKey),
      },
      paths: {
        skillsRoot: this.paths.skillsRoot,
        e2eProject: this.paths.e2eProject,
        artifactsRoot: this.paths.artifactsRoot,
      },
    };
  }

  async getModelConfig() {
    return this.model(await this.rows());
  }

  async update(input: UpdateSettingsInput): Promise<PlatformSettings> {
    const entries: Array<[string, string]> = [];
    if (input.targetBaseUrl !== undefined) entries.push(['targetBaseUrl', httpUrl(input.targetBaseUrl)]);
    if (input.runTimeoutMinutes !== undefined) {
      const minutes = Number(input.runTimeoutMinutes);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 120) {
        throw new BadRequestException('运行超时须为 1 到 120 分钟的整数');
      }
      entries.push(['runTimeoutMinutes', String(minutes)]);
    }
    if (input.showBrowser !== undefined) {
      if (typeof input.showBrowser !== 'boolean') throw new BadRequestException('执行时显示浏览器须为布尔值');
      entries.push(['showBrowser', String(input.showBrowser)]);
    }
    if (input.targetLogin?.username !== undefined) {
      entries.push(['targetUsername', text(input.targetLogin.username, '测试账号')]);
    }
    if (input.targetLogin?.password !== undefined) {
      entries.push(['targetPassword', text(input.targetLogin.password, '测试密码')]);
    }
    if (input.model) {
      if (input.model.baseUrl !== undefined) {
        entries.push(['modelBaseUrl', input.model.baseUrl ? httpUrl(input.model.baseUrl) : '']);
      }
      if (input.model.name !== undefined) entries.push(['modelName', text(input.model.name, '模型名称').trim()]);
      if (input.model.apiKey !== undefined) entries.push(['modelApiKey', text(input.model.apiKey, 'API Key').trim()]);
      const { temperature, maxOutputTokens, scriptReasoning, scriptTimeoutSeconds } = input.model;
      if (temperature !== undefined) {
        if (temperature !== null && (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)) {
          throw new BadRequestException('Temperature 须在 0 到 2 之间');
        }
        entries.push(['modelTemperature', temperature === null ? '' : String(temperature)]);
      }
      if (maxOutputTokens !== undefined) {
        if (maxOutputTokens !== null && (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0)) {
          throw new BadRequestException('最大输出 Token 须为正整数');
        }
        entries.push(['modelMaxOutputTokens', maxOutputTokens === null ? '' : String(maxOutputTokens)]);
      }
      if (scriptReasoning !== undefined) {
        if (!isScriptReasoning(scriptReasoning)) throw new BadRequestException('脚本生成推理模式无效');
        entries.push(['modelScriptReasoning', scriptReasoning]);
      }
      if (scriptTimeoutSeconds !== undefined) {
        if (!isScriptTimeout(scriptTimeoutSeconds)) throw new BadRequestException('脚本生成超时须为 30 至 300 秒之间的整数');
        entries.push(['modelScriptTimeoutSeconds', String(scriptTimeoutSeconds)]);
      }
    }
    await this.prisma.$transaction(async (tx) => {
      if (input.model && entries.some(([key]) => ['modelBaseUrl', 'modelName', 'modelScriptReasoning'].includes(key))) {
        const rows = await tx.setting.findMany({ where: { key: { in: ['modelBaseUrl', 'modelName', 'modelScriptReasoning'] } } });
        const next = this.model(new Map([...rows.map(({ key, value }) => [key, value] as const), ...entries]));
        if (next.scriptReasoning !== 'auto' && next.scriptReasoning !== 'provider' && !supportsScriptReasoning(next.baseUrl, next.name)) {
          throw new BadRequestException('当前接口不支持手动控制推理。请选择「自动」或「使用服务商默认」，或切换到 DeepSeek 官方 Flash／Pro。');
        }
      }
      for (const [key, value] of entries) {
        await tx.setting.upsert({ where: { key }, update: { value }, create: { key, value } });
      }
    });
    return this.get();
  }

  private async rows(): Promise<Map<string, string>> {
    const rows = await this.prisma.setting.findMany();
    return new Map(rows.map((row) => [row.key, row.value]));
  }

  private model(rows: Map<string, string>) {
    const baseUrl = rows.get('modelBaseUrl') || process.env.MODEL_BASE_URL || '';
    const apiKey = rows.get('modelApiKey') ?? process.env.MODEL_API_KEY ?? '';
    const name = rows.get('modelName') || process.env.MODEL_NAME || '';
    const savedReasoning = rows.get('modelScriptReasoning');
    const savedTimeout = optionalNumber(rows.get('modelScriptTimeoutSeconds'));
    return {
      configured: Boolean(baseUrl && apiKey && name), baseUrl, apiKey, name,
      temperature: optionalNumber(rows.get('modelTemperature')),
      maxOutputTokens: optionalNumber(rows.get('modelMaxOutputTokens')),
      scriptReasoning: isScriptReasoning(savedReasoning) ? savedReasoning : 'auto' as const,
      scriptTimeoutSeconds: isScriptTimeout(savedTimeout) ? savedTimeout : DEFAULT_SCRIPT_TIMEOUT_SECONDS,
    };
  }
}
