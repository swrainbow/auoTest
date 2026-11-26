export const preparationOrder = ['service-sync', 'map-binding', 'readiness-check'] as const;
type Step = typeof preparationOrder[number];
type Status = 'pending' | 'running' | 'passed' | 'failed' | 'skipped';
export interface ServiceRow { name: string; status: string; maps: string[] }
interface PreparationInput {
  steps: Step[];
  selection: 'unique' | 'explicit';
  mapName: string;
  serviceName: string;
}
interface PreparationReport {
  steps: { skillId: Step; status: Status; evidence: string }[];
  evidence: { serviceName?: string; mapsBefore?: string[]; mapsAfter?: string[]; wroteBinding?: boolean; services?: { name: string; status: string; attempts: number }[] };
}
interface ServiceActions {
  open(): Promise<void>;
  read(): Promise<ServiceRow[]>;
  sync(attempts: Map<string, number>): Promise<void>;
  select(rows: ServiceRow[], mapName: string, serviceName?: string): ServiceRow;
  bind(name: string, mapName: string, attempts: Map<string, number>): Promise<boolean>;
}

export async function runPreparation(input: PreparationInput, actions: ServiceActions, save: (report: PreparationReport) => Promise<void>) {
  if (!Array.isArray(input.steps) || !input.steps.length || input.steps.length > preparationOrder.length ||
      input.steps.some((id, index) => id !== preparationOrder[index])) throw new Error('准备流程的步骤或依赖顺序无效');
  if (input.steps.includes('map-binding') && (!input.mapName?.trim() || !['unique', 'explicit'].includes(input.selection) ||
      (input.selection === 'explicit' && !input.serviceName?.trim()))) throw new Error('请填写地图完整名称和所选规则要求的服务名称');
  const report: PreparationReport = {
    steps: input.steps.map(skillId => ({ skillId, status: 'pending', evidence: '等待执行' })), evidence: {},
  };
  const evidence = report.evidence;
  const attempts = new Map<string, number>();
  const read = async () => {
    const rows = await actions.read();
    evidence.services = rows.map(({ name, status }) => ({ name, status, attempts: attempts.get(name) ?? 0 }));
    const boundService = rows.find(row => row.name === evidence.serviceName);
    if (boundService) evidence.mapsAfter = [...boundService.maps];
    return rows;
  };
  async function synchronizeAndRead() {
    await read();
    await actions.sync(attempts);
    return read();
  }
  function confirmSync(rows: ServiceRow[]) {
    const pending = rows.filter(row => row.status !== '同步成功');
    if (!rows.length) throw new Error('服务列表为空');
    if (pending.length) throw new Error(`仍有服务未同步成功：${pending.map(row => `${row.name}（${row.status || '空'}）`).join('、')}`);
  }
  function confirmMaps(rows: ServiceRow[]) {
    const saved = rows.find(row => row.name === evidence.serviceName);
    if (!saved) throw new Error(`服务「${evidence.serviceName}」已不在列表中`);
    if (![...(evidence.mapsBefore ?? []), input.mapName].every(map => saved.maps.includes(map))) {
      throw new Error(`服务「${saved.name}」回读缺少目标地图或原有地图`);
    }
  }
  for (const step of report.steps) {
    step.status = 'running';
    step.evidence = '执行中';
    await save(report);
    try {
      if (step.skillId === 'service-sync') {
        await actions.open();
        const rows = await synchronizeAndRead();
        confirmSync(rows);
        step.evidence = `已回读 ${rows.length} 个服务，均同步成功`;
      } else if (step.skillId === 'map-binding') {
        const target = actions.select(await read(), input.mapName, input.serviceName?.trim() || undefined);
        evidence.serviceName = target.name;
        evidence.mapsBefore = [...target.maps];
        evidence.wroteBinding = target.maps.includes(input.mapName) ? false : await actions.bind(target.name, input.mapName, attempts);
        confirmMaps(await read());
        step.evidence = `${target.name} ${evidence.wroteBinding ? '新增' : '复用'}地图「${input.mapName}」，已回读原有地图及目标地图` +
          (evidence.wroteBinding ? '，已同步对应的 Paladin 和 Rattletrap 服务' : '');
      } else {
        // Leave the cached list, reopen service management and verify its persisted data.
        await actions.open();
        const rows = await synchronizeAndRead();
        confirmSync(rows);
        confirmMaps(rows);
        step.evidence = `已确认 ${rows.length} 个服务同步成功，${evidence.serviceName} 已绑定「${input.mapName}」`;
      }
      step.status = 'passed';
    } catch (error) {
      // A binding may have persisted before either service's synchronization failed.
      for (const row of evidence.services ?? []) row.attempts = attempts.get(row.name) ?? 0;
      await read().catch(() => undefined);
      step.status = 'failed';
      step.evidence = error instanceof Error ? error.message : String(error);
      for (const later of report.steps) {
        if (later.status === 'pending') {
          later.status = 'skipped';
          later.evidence = '前一步骤失败，已跳过';
        }
      }
      await save(report);
      throw error;
    }
    await save(report);
  }
  return report;
}
