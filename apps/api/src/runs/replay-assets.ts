import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import * as path from 'node:path';
import { digest, ENSURE_MAP_MODULE, IMPORT_GENERATED_MAP_MODULE, isSimulationCall, SIMULATION_START_MODULE, TUSK_SERVICE_PREREQUISITE_MODULE, usesTargetLogin, type Workflow } from '../planner/workflow';
import type { PathsService } from '../paths/paths.service';
import { needsTargetProxy } from './target-proxy';

export const RUNTIME_CONFIG = 'e2e.runtime.config.ts';
export const PROXY_CONFIG = 'e2e.proxy.config.ts';
export const RUN_TIMEOUT_CONFIG = 'e2e.explore.config.ts';

export function usesMapMenu(workflow: Workflow): boolean {
  return workflow.some(step => step.operations.some(op => op.type === 'ensure-map-in-menu' || op.type === 'import-generated-map'));
}

export function usesGeneratedMap(workflow: Workflow): boolean {
  return workflow.some(step => step.operations.some(op => op.type === 'import-generated-map'));
}

function usesSimulation(workflow: Workflow): boolean {
  return workflow.some(step => step.operations.some(isSimulationCall) || step.checks.some(isSimulationCall));
}

function usesServiceManagement(workflow: Workflow): boolean {
  return workflow.some(step => step.operations.some(op => op.type === 'bind-paladin-map' || op.type === 'sync-bound-map-services'));
}

export function usesRunTimeout(workflow: Workflow, hasPrerequisite: boolean): boolean {
  return hasPrerequisite || usesMapMenu(workflow) || usesSimulation(workflow) || usesServiceManagement(workflow);
}

export function cacheDir(paths: PathsService, id: number, version: number, target: string): string {
  return path.join(paths.root, 'storage', 'replay', String(id), 'v' + version, digest(target));
}

export async function cacheFingerprint(
  paths: PathsService, directory: string, scriptHash: string, target: string, workflow: Workflow, hasPrerequisite = false,
): Promise<string> {
  const hash = createHash('sha256').update(JSON.stringify({ scriptHash, target }));
  const files = [path.join(paths.root, 'pnpm-lock.yaml'), path.join(paths.e2eProject, 'e2e.config.ts')];
  const proxied = needsTargetProxy(target);
  const hasMapMenu = usesMapMenu(workflow);
  const extendedTimeout = usesRunTimeout(workflow, hasPrerequisite);
  if (usesTargetLogin(workflow) || proxied || extendedTimeout) files.push(path.join(paths.e2eProject, RUNTIME_CONFIG));
  if (proxied) files.push(path.join(paths.e2eProject, PROXY_CONFIG));
  if (extendedTimeout) files.push(path.join(paths.e2eProject, RUN_TIMEOUT_CONFIG));
  if (hasPrerequisite || usesServiceManagement(workflow)) files.push(path.join(paths.e2eProject, TUSK_SERVICE_PREREQUISITE_MODULE));
  if (usesSimulation(workflow)) files.push(path.join(paths.e2eProject, SIMULATION_START_MODULE));
  if (hasMapMenu) files.push(path.join(paths.e2eProject, ENSURE_MAP_MODULE));
  if (usesGeneratedMap(workflow)) {
    files.push(path.join(paths.e2eProject, IMPORT_GENERATED_MAP_MODULE));
    const scripts = path.join(paths.skillsRoot, 'tusk-map-simulation', 'scripts');
    for (const name of (await readdir(scripts)).filter(name => name.endsWith('.mjs')).sort()) {
      files.push(path.join(scripts, name));
    }
  }
  for (const file of files) {
    hash.update(createHash('sha256').update(await readFile(file)).digest());
  }
  const visit = async (relative: string) => {
    const dir = path.join(directory, relative);
    const entries = await readdir(dir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' && !relative) return [];
      throw error;
    });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) {
        await visit(name);
      } else if (entry.isFile()) {
        const contents = await readFile(path.join(directory, name));
        hash.update(JSON.stringify(name)).update(createHash('sha256').update(contents).digest());
      }
    }
  };
  await visit('');
  return hash.digest('hex');
}
