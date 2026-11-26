import axios from 'axios';
import { toast } from 'vue-sonner';
import type {
  CreateRunInput,
  DashboardSummary,
  GeneratedPlan,
  PlatformSettings,
  PreparationFlow,
  PreparationRule,
  PreparationRun,
  PreparationSelection,
  PreparationSkillId,
  PreparationWorkspace,
  SaveTestCaseInput,
  ScriptGenerationJob,
  SkillDto,
  TestCaseDto,
  TestCaseVersionDto,
  TestRunDto,
  TestRunPage,
  TestRunPageQuery,
  UpdateSettingsInput,
} from '@autotest/shared';

const http = axios.create({ baseURL: '/api', timeout: 180_000 });

function messageOf(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const data = error.response?.data as { message?: string | string[] } | undefined;
    if (data?.message) return Array.isArray(data.message) ? data.message.join('；') : data.message;
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

export { messageOf };

export function isRequestTimeout(error: unknown): boolean {
  return axios.isAxiosError(error) && !error.response && (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT');
}

export async function request<T>(p: Promise<{ data: T }>): Promise<T> {
  try {
    return (await p).data;
  } catch (error) {
    toast.error(messageOf(error));
    throw error;
  }
}

// ---------- 仪表盘 ----------
export const getDashboard = (days: number) =>
  request<DashboardSummary>(http.get<DashboardSummary>('/dashboard/summary', { params: { days } }));

// ---------- 用例 ----------
export const getCases = () => request<TestCaseDto[]>(http.get<TestCaseDto[]>('/test-cases'));

export const getCase = (id: number, { silent = false } = {}) => {
  const response = http.get<TestCaseDto & { versions: TestCaseVersionDto[] }>(`/test-cases/${id}`);
  return silent ? response.then(({ data }) => data) : request(response);
};

export const createCase = (input: SaveTestCaseInput) =>
  request<TestCaseDto>(http.post<TestCaseDto>('/test-cases', input));

export const updateCase = (id: number, input: SaveTestCaseInput & { changeNote?: string }) =>
  request<TestCaseDto>(http.put<TestCaseDto>(`/test-cases/${id}`, input));

export const updateCaseStatus = (id: number, status: string) =>
  request<TestCaseDto>(http.put<TestCaseDto>(`/test-cases/${id}/status`, { status }));

export const deleteCase = (id: number) => request<{ ok: true }>(http.delete(`/test-cases/${id}`));

export const generateScript = async (id: number, version: number) =>
  (await http.post<ScriptGenerationJob>(`/test-cases/${id}/generate-script`, { version }, { timeout: 15_000 })).data;

export const getScriptGeneration = async (id: number) =>
  (await http.get<ScriptGenerationJob | null>(`/test-cases/${id}/script-generation`, { timeout: 10_000 })).data;

export const getScriptGenerations = async () =>
  (await http.get<ScriptGenerationJob[]>('/script-generations', { timeout: 10_000 })).data;

export const readScript = (id: number, version?: number) =>
  request<{ scriptPath: string; content: string }>(http.get(`/test-cases/${id}/script`, { params: { version } }));

export const generatePlan = (requirement: string, skill?: string, taskId?: string) =>
  request<GeneratedPlan>(http.post<GeneratedPlan>('/test-cases/generate', { requirement, skill, taskId }));

// ---------- 执行 ----------
export const getRunPage = (params: TestRunPageQuery) =>
  request<TestRunPage>(http.get<TestRunPage>('/test-runs/page', { params }));

export const getRun = (id: number) => request<TestRunDto>(http.get<TestRunDto>(`/test-runs/${id}`));

export const createRun = (input: CreateRunInput) =>
  request<TestRunDto>(http.post<TestRunDto>('/test-runs', input));

export const cancelRun = (id: number) => request<TestRunDto>(http.post(`/test-runs/${id}/cancel`));

export const diagnoseRun = (id: number) => request<TestRunDto>(http.post(`/test-runs/${id}/diagnose`));
export const repairRun = async (id: number) => (await http.post<TestRunDto>(`/test-runs/${id}/repair`)).data;

export const getRunLog = (id: number, tail = 400) =>
  request<{ log: string }>(http.get<{ log: string }>(`/test-runs/${id}/log`, { params: { tail } }));

export const getRunArtifacts = (id: number) =>
  request<{ files: string[] }>(http.get<{ files: string[] }>(`/test-runs/${id}/artifacts`));

// ---------- Skill ----------
export const getSkills = () => request<SkillDto[]>(http.get<SkillDto[]>('/skills'));

export async function getCaseSkills(): Promise<{ business: SkillDto[]; prerequisite?: string }> {
  const prerequisiteId = 'tusk-service-preflight';
  const usable = (await getSkills()).filter((skill) => skill.files.some((file) => file.path === `${skill.dir}/SKILL.md`));
  return {
    business: usable.filter((skill) => skill.dir !== 'test-failure-diagnosis' && skill.dir !== prerequisiteId),
    prerequisite: usable.find((skill) => skill.dir === prerequisiteId)?.dir,
  };
}

export const readSkillFile = (path: string) =>
  request<{ path: string; content: string }>(http.get<{ path: string; content: string }>('/skills/file', { params: { path } }));

export const saveSkillFile = (path: string, content: string) =>
  request<{ path: string }>(http.put<{ path: string }>('/skills/file', { path, content }));

export const createSkillFile = (path: string, content: string) =>
  request<{ path: string }>(http.post<{ path: string }>('/skills/file', { path, content }));

export const deleteSkillFile = (path: string) =>
  request<{ ok: true }>(http.delete<{ ok: true }>('/skills/file', { params: { path } }));

export async function createSkillDir(dir: string): Promise<SkillDto['files']> {
  const { data } = await http.post<SkillDto['files']>('/skills/directory', { dir });
  return data;
}

// ---------- 设置 ----------
export const getSettings = () => request<PlatformSettings>(http.get<PlatformSettings>('/settings'));

export const updateSettings = (input: UpdateSettingsInput) =>
  request<PlatformSettings>(http.put<PlatformSettings>('/settings', input));

// ---------- 测试准备 ----------
export const getPreparations = async () => (await http.get<PreparationWorkspace>('/preparations')).data;
export const savePreparationRule = async (selection: PreparationSelection) =>
  (await http.post<PreparationRule>('/preparations/rules', { selection })).data;
export const savePreparationFlow = async (input: { name: string; steps: PreparationSkillId[]; ruleVersion: number }) =>
  (await http.post<PreparationFlow>('/preparations/flows', input)).data;
export const startPreparation = async (input: { flowId: string; targetBaseUrl: string; mapName: string; serviceName?: string }) =>
  (await http.post<PreparationRun>('/preparations/runs', input)).data;
