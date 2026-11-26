import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { PlatformSettings, PreparationEvidence, PreparationRun, PreparationStepResult } from '@autotest/shared';
import { PathsService } from '../paths/paths.service';
import { RUN_TIMEOUT_CONFIG } from '../runs/replay-assets';
import { runnerEnvironment, stopRunner } from '../runs/runner-process';
import { needsTargetProxy, startTargetProxy } from '../runs/target-proxy';

type Result = { steps: PreparationStepResult[]; evidence?: PreparationEvidence };

@Injectable()
export class PreparationRunner implements OnModuleDestroy {
  private child?: ChildProcess;
  private stopping = false;

  constructor(private readonly paths: PathsService) {}

  onModuleDestroy(): void {
    this.stopping = true;
    if (this.child) stopRunner(this.child);
  }

  private directory(id: string): string {
    return path.join(this.paths.root, 'storage', 'preparations', id);
  }

  async result(run: PreparationRun): Promise<Result> {
    const resultPath = path.join(this.directory(run.id), 'result.json');
    let snapshot: { steps: PreparationStepResult[]; evidence?: PreparationEvidence };
    try {
      snapshot = JSON.parse(await readFile(resultPath, 'utf8')) as typeof snapshot;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { steps: run.steps };
      throw error;
    }
    // The runner writes an atomic partial snapshot after each action. Keep the saved flow order.
    const steps = run.steps.map((step) => {
      const found = snapshot.steps.find((item) => item.skillId === step.skillId);
      if (!found) return step;
      if (!['pending', 'running', 'passed', 'failed', 'skipped'].includes(found.status) || typeof found.evidence !== 'string') {
        throw new Error('准备步骤的回读记录无效');
      }
      return { ...step, status: found.status, evidence: found.evidence };
    });
    return { steps, evidence: snapshot.evidence };
  }

  async execute(run: PreparationRun, settings: PlatformSettings): Promise<void> {
    if (run.targetBaseUrl !== settings.targetBaseUrl) throw new Error('平台目标环境已变化，请确认目标站点后重新运行');
    const directory = this.directory(run.id);
    await mkdir(directory, { recursive: true });
    const timeoutMs = settings.runTimeoutMinutes * 60_000;
    const proxy = needsTargetProxy(run.targetBaseUrl) ? await startTargetProxy(run.targetBaseUrl) : undefined;
    try {
      const env: NodeJS.ProcessEnv = {
        ...runnerEnvironment(), AUTOTEST_RUN_MODE: 'strict', TARGET_BASE_URL: proxy?.url ?? run.targetBaseUrl,
        AUTOTEST_EXPLORE_TIMEOUT_MS: String(timeoutMs), E2E_TELEMETRY_DISABLED: '1', CI: '1',
        AUTOTEST_PREPARATION_INPUT: JSON.stringify({
          steps: run.steps.map((step) => step.skillId), selection: run.selection, mapName: run.mapName, serviceName: run.serviceName,
        }),
        AUTOTEST_PREPARATION_RESULT: path.join(directory, 'result.json'),
      };
      if (proxy) env.AUTOTEST_TARGET_IDENTITY = run.targetBaseUrl;
      const { username, password } = settings.targetLogin;
      if (username && password) Object.assign(env, { AUTOTEST_TARGET_USERNAME: username, AUTOTEST_TARGET_PASSWORD: password });
      const cli = path.join(this.paths.e2eProject, 'node_modules', 'e2e', 'dist', 'cli', 'bin.js');
      const args = [cli, 'run', 'tests/preparations/service-map.e2e.ts', '--config', RUN_TIMEOUT_CONFIG,
        '--output', path.join(this.paths.e2eProject, '.e2e', 'runs', 'preparation-' + run.id),
        '--cache-dir', path.join(directory, 'cache')];
      if (settings.showBrowser) args.push('--headed');
      if (this.stopping) throw new Error('平台停止，准备执行已中断');
      const child = this.child = spawn(process.execPath, args, {
        cwd: this.paths.e2eProject, env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, detached: process.platform !== 'win32',
      });
      let stderr = '';
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
        stderr = (stderr + chunk).slice(-8192);
      });
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; stopRunner(child); }, timeoutMs + 30_000);
      try {
        const exitCode = await new Promise<number | null>((resolve, reject) => {
          child.once('error', reject);
          child.once('close', resolve);
        });
        if (timedOut) throw new Error('准备运行超时，执行进程已终止');
        if (exitCode !== 0) {
          let detail = stderr.trim();
          if (password) detail = detail.replaceAll(password, '[REDACTED]');
          throw new Error(detail ? '准备运行器失败：' + detail.slice(0, 1500) : '准备运行器已退出，退出码 ' + String(exitCode));
        }
      } finally {
        clearTimeout(timer);
        this.child = undefined;
      }
    } finally {
      proxy?.close();
    }
  }
}
