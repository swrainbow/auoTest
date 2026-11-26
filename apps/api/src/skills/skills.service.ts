import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile, stat, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { PathsService } from '../paths/paths.service';
import { isSkillDirectoryName } from './skill-directory-name';
import type { SkillDto, SkillFileInfo } from '@autotest/shared';

const ALLOWED_EXT = new Set(['.md', '.txt', '.json', '.yaml', '.yml']);
const MAX_DEPTH = 3;
const MAX_FILE_BYTES = 512 * 1024;
const VERIFIED_REPAIRS = 'references/verified-repairs/';
const MAX_REPAIR_DOC_BYTES = 6000;
const MAX_REPAIR_DOCS = 4;

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export interface ParsedFrontmatter {
  name: string;
  description: string;
}

/** 极简 frontmatter 解析（--- 包裹的 key: value 行），SKILL.md 校验用 */
export function parseFrontmatter(content: string): ParsedFrontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!match) return { name: '', description: '' };
  const meta: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const kv = /^(name|description)\s*:\s*(.+)$/.exec(line.trim());
    if (kv) meta[kv[1]!] = kv[2]!.trim();
  }
  return { name: meta.name ?? '', description: meta.description ?? '' };
}

@Injectable()
export class SkillsService {
  constructor(private readonly paths: PathsService) {}

  /** 列出全部 Skill 目录及文件清单 */
  async list(): Promise<SkillDto[]> {
    const root = this.paths.skillsRoot;
    if (!existsSync(root)) return [];
    const dirs = (await readdir(root, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name)
      .sort();

    const result: SkillDto[] = [];
    for (const dir of dirs) {
      const files = await this.collectFiles(path.join(root, dir), dir, 1);
      const skillMd = files.find((f) => f.path === `${dir}/SKILL.md`);
      let name = dir;
      let description = '';
      if (skillMd) {
        const content = await readFile(path.join(root, skillMd.path), 'utf8');
        const fm = parseFrontmatter(content);
        name = fm.name || dir;
        description = fm.description;
      }
      result.push({ dir, name, description, files });
    }
    return result;
  }

  async read(relativePath: string): Promise<{ path: string; content: string }> {
    const full = this.paths.safeJoin(this.paths.skillsRoot, relativePath);
    if (!existsSync(full)) throw new NotFoundException(`文件不存在: ${relativePath}`);
    const s = await stat(full);
    if (!s.isFile()) throw new BadRequestException('只能读取文件');
    if (s.size > MAX_FILE_BYTES) throw new BadRequestException('文件过大，请在本地编辑器中修改');
    return { path: relativePath, content: await readFile(full, 'utf8') };
  }

  /** 新建或覆盖保存；SKILL.md 强制校验 frontmatter */
  async write(relativePath: string, content: string, create: boolean): Promise<{ path: string }> {
    const ext = path.extname(relativePath).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) {
      throw new BadRequestException(`仅支持编辑 ${[...ALLOWED_EXT].join(' / ')} 文件`);
    }
    const full = this.paths.safeJoin(this.paths.skillsRoot, relativePath);
    if (existsSync(full) && create) throw new BadRequestException(`文件已存在: ${relativePath}`);
    if (path.basename(full) === 'SKILL.md') {
      const fm = parseFrontmatter(content);
      if (!fm.name || !fm.description) {
        throw new BadRequestException('SKILL.md 必须包含 frontmatter，且 name 与 description 均不能为空');
      }
    }
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, 'utf8');
    return { path: relativePath };
  }

  async remove(relativePath: string): Promise<{ ok: true }> {
    const full = this.paths.safeJoin(this.paths.skillsRoot, relativePath);
    if (!existsSync(full)) throw new NotFoundException(`文件不存在: ${relativePath}`);
    const s = await stat(full);
    if (!s.isFile()) throw new BadRequestException('只能删除文件，请手动删除目录');
    await unlink(full);
    return { ok: true };
  }

  /** 新建 Skill 目录并生成 SKILL.md 模板 */
  async createSkill(dirName: string): Promise<SkillDto['files']> {
    if (!isSkillDirectoryName(dirName)) {
      throw new BadRequestException('目录名可使用汉字、小写英文字母和数字，词之间可用短横线连接，例如“地图准备”或“地图-v2”。');
    }
    const full = path.join(this.paths.skillsRoot, dirName);
    if (existsSync(full)) throw new BadRequestException(`Skill 已存在: ${dirName}`);
    const template = [
      '---',
      `name: ${dirName}`,
      `description: ${dirName} 业务测试知识：如何理解该业务并设计测试。`,
      '---',
      '',
      `# ${dirName}`,
      '',
      '## 业务概念',
      '- ',
      '',
      '## 测试生成步骤',
      '1. ',
      '',
      '## 约束',
      '- ',
      '',
    ].join('\n');
    await mkdir(path.join(full, 'references'), { recursive: true });
    await writeFile(path.join(full, 'SKILL.md'), template, 'utf8');
    return this.collectFiles(full, dirName, 1);
  }

  async loadSkillDocs(dir: string, targetBaseUrl?: string): Promise<Array<{ path: string; content: string }>> {
    const skill = (await this.list()).find((entry) => entry.dir === dir);
    const main = dir + '/SKILL.md';
    if (!skill?.files.some((file) => file.path === main)) {
      throw new NotFoundException('业务 Skill 不存在：' + dir);
    }
    const files = skill.files.filter((file) =>
      (file.path === main || file.path === dir + '/schema.json' || file.path.startsWith(dir + '/references/')) &&
      !file.path.startsWith(dir + '/' + VERIFIED_REPAIRS),
    );
    const repairs = targetBaseUrl
      ? skill.files.filter((file) => file.path.startsWith(dir + '/' + VERIFIED_REPAIRS + hash(targetBaseUrl) + '-'))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, MAX_REPAIR_DOCS)
      : [];
    return Promise.all([...files.slice(0, 15), ...repairs].map(async (file) => {
      const doc = await this.read(file.path);
      return { ...doc, content: doc.content.slice(0, MAX_REPAIR_DOC_BYTES) };
    }));
  }

  async recordVerifiedRepair(dir: string, targetBaseUrl: string, verificationRunId: number, steps: object[]) {
    if (!isSkillDirectoryName(dir) || !steps.length) return;
    const relative = dir + '/' + VERIFIED_REPAIRS + hash(targetBaseUrl) + '-' + hash(JSON.stringify(steps)) + '.json';
    const full = this.paths.safeJoin(this.paths.skillsRoot, relative);
    const content = JSON.stringify({ verificationRunId, steps }, null, 2) + '\n';
    if (Buffer.byteLength(content) > MAX_REPAIR_DOC_BYTES) return;
    const main = await stat(path.join(this.paths.skillsRoot, dir, 'SKILL.md')).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (!main?.isFile()) return;
    if (existsSync(full)) return relative;
    await mkdir(path.dirname(full), { recursive: true });
    const temp = path.join(path.dirname(full), '.' + randomUUID() + '.tmp');
    try {
      await writeFile(temp, content, { encoding: 'utf8', flag: 'wx' });
      await rename(temp, full);
    } finally {
      await unlink(temp).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
    return relative;
  }

  private async collectFiles(absDir: string, relDir: string, depth: number): Promise<SkillFileInfo[]> {
    if (depth > MAX_DEPTH) return [];
    const out: SkillFileInfo[] = [];
    const entries = await readdir(absDir, { withFileTypes: true });
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith('.')) continue;
      const rel = `${relDir}/${e.name}`;
      const abs = path.join(absDir, e.name);
      if (e.isDirectory()) {
        out.push(...(await this.collectFiles(abs, rel, depth + 1)));
      } else if (e.isFile() && ALLOWED_EXT.has(path.extname(e.name).toLowerCase())) {
        const s = await stat(abs);
        out.push({ path: rel, size: s.size, updatedAt: s.mtime.toISOString() });
      }
    }
    return out;
  }
}
