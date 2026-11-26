import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { DashboardSummary, KpiTrend } from '@autotest/shared';
import type { TestRun, TestCase } from '@prisma/client';

type RunWithCase = TestRun & { testCase: TestCase | null };

const FINISHED = ['passed', 'failed', 'warning'];

function pct(n: number, d: number): number {
  if (d <= 0) return 0;
  return Math.round((n / d) * 1000) / 10;
}

function runCounts(run: RunWithCase) {
  const s = run.summary ? safeParse(run.summary) : null;
  const passed = typeof s?.passed === 'number' ? s.passed : Number(run.status === 'passed');
  const failed = typeof s?.failed === 'number' ? s.failed : Number(run.status === 'failed');
  const warnings = typeof s?.warnings === 'number' ? s.warnings : Number(run.status === 'warning');
  const total = typeof s?.total === 'number' ? s.total : passed + failed + warnings;
  return { passed, failed, warnings, total };
}

function safeParse(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(days = 90): Promise<DashboardSummary> {
    const windowDays = Math.min(Math.max(days || 90, 1), 365);
    const now = new Date();
    const windowStart = new Date(now.getTime() - windowDays * 864e5);
    const prevStart = new Date(windowStart.getTime() - windowDays * 864e5);

    const [cases, caseCountPrev, runs, prevRuns] = await Promise.all([
      this.prisma.testCase.findMany({ include: { runs: { orderBy: { createdAt: 'desc' } } } }),
      this.prisma.testCase.count({ where: { createdAt: { lt: windowStart } } }),
      this.prisma.testRun.findMany({
        where: { createdAt: { gte: windowStart } },
        include: { testCase: true },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.testRun.findMany({
        where: { createdAt: { gte: prevStart, lt: windowStart }, status: { in: FINISHED } },
        select: { status: true, durationMs: true, testCaseId: true },
      }),
    ]);

    const finished = runs.filter((r) => FINISHED.includes(r.status));
    const assessed = finished.filter((r) => r.status !== 'warning');
    const passedRuns = assessed.filter((r) => r.status === 'passed');

    // ---- KPI ----
    const passRate = pct(passedRuns.length, assessed.length);
    // 稳定性评分 = 通过率 × (1 - 不稳定用例占比)
    const caseRunStats = this.groupByCase(assessed);
    const flakyCaseIds = new Set(
      [...caseRunStats.entries()].filter(([, s]) => s.passed > 0 && s.failed > 0).map(([id]) => id),
    );
    const reliabilityScore = Math.round(passRate * (1 - (flakyCaseIds.size / Math.max(cases.length, 1))) * 10) / 10;
    const durations = finished.map((r) => r.durationMs ?? 0).filter((d) => d > 0);
    const avgDurationMs = durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null;

    const prevAssessed = prevRuns.filter((r) => r.status !== 'warning');
    const prevPassRate = pct(prevAssessed.filter((r) => r.status === 'passed').length, prevAssessed.length);
    const prevDurations = prevRuns.map((r) => r.durationMs ?? 0).filter((d) => d > 0);
    const prevAvg = prevDurations.length ? prevDurations.reduce((a, b) => a + b, 0) / prevDurations.length : null;
    const prevFlakyIds = new Set(
      prevAssessed
        .map((r) => r.testCaseId)
        .filter((id): id is number => id !== null)
        .filter((id, i, arr) => arr.indexOf(id) !== i),
    );
    const prevReliability = Math.round(prevPassRate * (1 - prevFlakyIds.size / Math.max(cases.length, 1)) * 10) / 10;

    const trend = (cur: number, prev: number | null, lowerIsBetter = false): KpiTrend => {
      if (prev === null || prev === 0) return { delta: null };
      const ratio = (cur - prev) / prev;
      return { delta: Math.round((lowerIsBetter ? -ratio : ratio) * 1000) / 10 };
    };

    // ---- 模块概览 ----
    const moduleMap = new Map<string, { runs: number; passed: number; assessed: number; lastRunAt: Date | null }>();
    for (const c of cases) {
      if (!moduleMap.has(c.module)) moduleMap.set(c.module, { runs: 0, passed: 0, assessed: 0, lastRunAt: null });
    }
    for (const r of finished) {
      const mod = r.testCase?.module;
      if (!mod) continue;
      const m = moduleMap.get(mod);
      if (!m) continue;
      m.runs += 1;
      if (r.status !== 'warning') m.assessed += 1;
      if (r.status === 'passed') m.passed += 1;
      if (!m.lastRunAt || r.createdAt > m.lastRunAt) m.lastRunAt = r.createdAt;
    }
    const moduleSummary = [...moduleMap.entries()]
      .map(([module, m]) => {
        const passRate = pct(m.passed, m.assessed);
        let status: DashboardSummary['moduleSummary'][number]['status'] = 'none';
        if (m.runs > 0) status = 'warning';
        if (m.assessed > 0) status = m.passed === m.assessed ? 'passed' : 'failed';
        return { module, runs: m.runs, lastRunAt: m.lastRunAt?.toISOString() ?? null, passRate, status };
      })
      .sort((a, b) => b.runs - a.runs);

    // ---- 不稳定用例 ----
    const flakyTests = [...caseRunStats.entries()]
      .map(([id, s]) => {
        const c = cases.find((x) => x.id === id);
        return c
          ? {
              testCaseId: id,
              code: c.code,
              name: c.name,
              module: c.module,
              runs: s.passed + s.failed,
              failures: s.failed,
              flakyScore: pct(s.failed, s.passed + s.failed),
            }
          : null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .filter((x) => x.failures > 0)
      .sort((a, b) => b.flakyScore - a.flakyScore || b.failures - a.failures)
      .slice(0, 5);

    const recent = finished.slice(-15);
    const trendSeries = recent.map((r, i) => {
      const counts = runCounts(r);
      return {
        runId: r.id, label: `#${i + 1}`, ...counts,
        caseName: r.testCase?.name ?? null,
        status: r.status as DashboardSummary['trend'][number]['status'],
        durationMs: r.durationMs, createdAt: r.createdAt.toISOString(),
      };
    });

    return {
      days: windowDays,
      kpis: {
        totalCases: cases.length,
        assessedRuns: assessed.length,
        passRate,
        reliabilityScore,
        avgDurationMs,
        trends: {
          totalCases: trend(cases.length, caseCountPrev > 0 ? caseCountPrev : null),
          passRate: trend(passRate, prevAssessed.length > 0 ? prevPassRate : null),
          reliabilityScore: trend(reliabilityScore, prevAssessed.length > 0 ? prevReliability : null),
          avgDurationMs: trend(avgDurationMs ?? 0, prevAvg, true).delta === null ? { delta: null } : trend(avgDurationMs ?? 0, prevAvg, true),
        },
      },
      moduleSummary,
      flakyTests,
      trend: trendSeries,
    };
  }

  private groupByCase(assessed: RunWithCase[]): Map<number, { passed: number; failed: number }> {
    const map = new Map<number, { passed: number; failed: number }>();
    for (const r of assessed) {
      if (r.testCaseId === null) continue;
      const entry = map.get(r.testCaseId) ?? { passed: 0, failed: 0 };
      if (r.status === 'passed') entry.passed += 1;
      else entry.failed += 1;
      map.set(r.testCaseId, entry);
    }
    return map;
  }
}
