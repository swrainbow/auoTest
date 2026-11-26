import { computed, shallowRef } from 'vue';
import { defineStore } from 'pinia';
import { generateScript, getScriptGeneration, getScriptGenerations } from '@/api/client';
import type { ScriptGenerationJob } from '@autotest/shared';

export const SCRIPT_GENERATION_TEXT: Record<ScriptGenerationJob['status'], string> = {
  queued: '排队中',
  running: '生成中',
  succeeded: '已生成',
  failed: '生成失败',
};

const STATUS_ORDER: Record<ScriptGenerationJob['status'], number> = {
  queued: 0,
  running: 1,
  succeeded: 2,
  failed: 2,
};

export function isScriptGenerationActive(job: ScriptGenerationJob): boolean {
  return job.status === 'queued' || job.status === 'running';
}

export const useScriptGenerationStore = defineStore('script-generation', () => {
  const jobs = shallowRef<ScriptGenerationJob[]>([]);
  const refreshed = shallowRef(false);
  const refreshing = shallowRef(false);
  const refreshFailed = shallowRef(false);
  const activeCount = computed(() => jobs.value.filter(isScriptGenerationActive).length);
  const latestByCase = computed(() => {
    const latest = new Map<number, ScriptGenerationJob>();
    for (const job of jobs.value) {
      if (!latest.has(job.testCaseId)) latest.set(job.testCaseId, job);
    }
    return latest;
  });

  function merge(incoming: ScriptGenerationJob[], missingCandidates?: Set<number>): ScriptGenerationJob[] {
    const records = new Map(jobs.value.map(job => [job.id, job]));
    const completed: ScriptGenerationJob[] = [];
    for (const job of incoming) {
      missingCandidates?.delete(job.id);
      const known = records.get(job.id);
      if (known && STATUS_ORDER[job.status] < STATUS_ORDER[known.status]) continue;
      if (known && isScriptGenerationActive(known) && !isScriptGenerationActive(job)) completed.push(job);
      records.set(job.id, job);
    }
    for (const id of missingCandidates ?? []) {
      const job = records.get(id);
      if (job && isScriptGenerationActive(job)) records.delete(id);
    }
    const sorted = [...records.values()].sort((a, b) => b.id - a.id);
    const active = sorted.filter(isScriptGenerationActive);
    const recent = sorted.filter(job => !isScriptGenerationActive(job)).slice(0, 40);
    jobs.value = [...active, ...recent].sort((a, b) => b.id - a.id);
    return completed;
  }

  async function refresh(): Promise<ScriptGenerationJob[]> {
    if (refreshing.value) return [];
    // The listing includes every active job. Preserve jobs added while it is in flight.
    const activeBeforeRequest = new Set(jobs.value.filter(isScriptGenerationActive).map(job => job.id));
    refreshing.value = true;
    try {
      const completed = merge(await getScriptGenerations(), activeBeforeRequest);
      refreshed.value = true;
      refreshFailed.value = false;
      return completed;
    } catch {
      refreshFailed.value = true;
      return [];
    } finally {
      refreshing.value = false;
    }
  }

  async function fetchLatest(caseId: number): Promise<ScriptGenerationJob | null> {
    const job = await getScriptGeneration(caseId);
    if (job) merge([job]);
    return job;
  }

  async function start(caseId: number, version: number): Promise<ScriptGenerationJob> {
    const job = await generateScript(caseId, version);
    merge([job]);
    return job;
  }

  return { jobs, refreshed, refreshing, refreshFailed, activeCount, latestByCase, refresh, fetchLatest, start };
});
