import { BadRequestException, Injectable } from '@nestjs/common';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import * as path from 'node:path';

/**
 * 平台目录解析：skills / e2e-project / storage 等根路径统一从这里取。
 * root 默认推断为 monorepo 根（apps/api 的上两级），可用 AUTOTEST_ROOT 覆盖。
 */
@Injectable()
export class PathsService {
  readonly root: string;
  readonly skillsRoot: string;
  readonly e2eProject: string;
  readonly artifactsRoot: string;

  constructor() {
    const envRoot = process.env.AUTOTEST_ROOT;
    const candidates = envRoot
      ? [path.resolve(envRoot)]
      : [path.resolve(process.cwd(), '..', '..'), path.resolve(process.cwd())];
    this.root = candidates.find((c) => existsSync(path.join(c, 'pnpm-workspace.yaml'))) ?? candidates[0]!;
    this.skillsRoot = path.join(this.root, 'skills');
    this.e2eProject = path.join(this.root, 'e2e-project');
    this.artifactsRoot = path.join(this.root, 'storage', 'artifacts');
  }

  async ensureArtifactsDir(): Promise<void> {
    await mkdir(this.artifactsRoot, { recursive: true });
  }

  /** 限制在 base 目录内的安全路径拼接，防目录穿越 */
  safeJoin(base: string, relative: string): string {
    const normalized = path.normalize(relative).replace(/\\/g, '/');
    if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized) || normalized.includes('..')) {
      throw new BadRequestException(`非法路径: ${relative}`);
    }
    const full = path.resolve(base, normalized);
    if (!full.startsWith(path.resolve(base) + path.sep)) {
      throw new BadRequestException(`路径越界: ${relative}`);
    }
    return full;
  }
}
