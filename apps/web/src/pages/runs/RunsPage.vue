<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { useRouter } from 'vue-router';
import { Play, Plus } from '@lucide/vue';
import { toast } from 'vue-sonner';
import { cancelRun, createRun, getCases, getRunPage } from '@/api/client';
import { CASE_STATUS_TEXT, MODE_TEXT, RUN_STATUS_BADGE, RUN_STATUS_TEXT, formatDuration, fromNow } from '@/utils/format';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import StatusBadge from '@/components/StatusBadge.vue';
import TableEmpty from '@/components/TableEmpty.vue';
import TablePagination from '@/components/TablePagination.vue';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldGroup } from '@/components/ui/field';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { TestCaseDto, TestRunDto, TestRunPage, TestRunPageQuery } from '@autotest/shared';

const router = useRouter();
const loading = ref(true);
const loadFailed = ref(false);
const result = shallowRef<TestRunPage | null>(null);
const cases = ref<TestCaseDto[]>([]);
const statusFilter = ref('all');
const moduleFilter = ref('all');
const caseFilter = ref('all');
const page = ref(1);
const pageSize = ref('10');

const selectedModule = computed(() => {
  if (moduleFilter.value === 'all') return undefined;
  return moduleFilter.value === 'uncategorized' ? '' : moduleFilter.value.slice('module:'.length);
});
const modules = computed(() => [...new Set(cases.value.map((item) => item.module).filter(Boolean))]
  .sort((a, b) => a.localeCompare(b, 'zh-CN')));
const filterCases = computed(() => cases.value.filter((item) =>
  selectedModule.value === undefined || item.module === selectedModule.value,
));
const query = computed<TestRunPageQuery>(() => ({
  page: page.value,
  pageSize: Number(pageSize.value),
  module: selectedModule.value,
  testCaseId: caseFilter.value === 'all' ? undefined : Number(caseFilter.value),
  status: statusFilter.value === 'all' ? undefined : statusFilter.value,
}));
const hasFilters = computed(() => moduleFilter.value !== 'all' || caseFilter.value !== 'all' || statusFilter.value !== 'all');

const dialogVisible = ref(false);
const submitting = ref(false);
const form = ref<{ testCaseId: string; mode: 'auto' | 'explore' | 'replay' | 'strict'; autoRepair: boolean }>({
  testCaseId: '',
  mode: 'auto',
  autoRepair: false,
});
const runnableCases = computed(() => cases.value.filter((item) => item.scriptPath && item.status !== 'deprecated'));
const cancelTarget = ref<TestRunDto | null>(null);

let timer: ReturnType<typeof setInterval> | null = null;
let requestId = 0;
let pending = false;

async function load(showLoading = false): Promise<void> {
  if (pending && !showLoading) return;
  const id = ++requestId;
  pending = true;
  if (showLoading) loading.value = true;
  try {
    const next = await getRunPage(query.value);
    if (id !== requestId) return;
    result.value = next;
    page.value = next.page;
    loadFailed.value = false;
  } catch {
    if (id === requestId && loading.value) loadFailed.value = true;
  } finally {
    if (id === requestId) {
      pending = false;
      loading.value = false;
    }
  }
}

watch(moduleFilter, () => { caseFilter.value = 'all'; }, { flush: 'sync' });
watch([moduleFilter, caseFilter, statusFilter, pageSize], () => { page.value = 1; }, { flush: 'sync' });
watch(query, () => void load(true), { immediate: true });

function loadCases(): void {
  void getCases().then((list) => { cases.value = list; }).catch(() => {});
}

function openDialog(): void {
  form.value = { testCaseId: '', mode: 'auto', autoRepair: false };
  loadCases();
  dialogVisible.value = true;
}

async function submit(): Promise<void> {
  submitting.value = true;
  try {
    const run = await createRun({
      testCaseId: Number(form.value.testCaseId),
      mode: form.value.mode === 'auto' ? undefined : form.value.mode,
      autoRepair: form.value.mode !== 'strict' && form.value.autoRepair,
    });
    dialogVisible.value = false;
    toast.success(`已创建执行 #${run.id}`);
    router.push(`/runs/${run.id}`);
  } finally {
    submitting.value = false;
  }
}

async function doCancel(): Promise<void> {
  const target = cancelTarget.value;
  cancelTarget.value = null;
  if (!target) return;
  await cancelRun(target.id);
  toast.success('已发送取消信号');
  void load(true);
}

onMounted(() => {
  loadCases();
  timer = setInterval(() => void load(), 5000);
});
onBeforeUnmount(() => {
  requestId++;
  if (timer) clearInterval(timer);
});
</script>

<template>
  <div class="flex flex-col gap-4">
    <Card>
      <CardHeader class="flex flex-row flex-wrap items-center gap-3 space-y-0">
        <CardTitle class="text-[15px]">测试运行</CardTitle>
        <Select v-model="moduleFilter">
          <SelectTrigger aria-label="用例模块" class="w-40">
            <SelectValue placeholder="全部模块" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部模块</SelectItem>
            <SelectItem v-for="module in modules" :key="module" :value="`module:${module}`">{{ module }}</SelectItem>
            <SelectItem value="uncategorized">未分类</SelectItem>
          </SelectContent>
        </Select>
        <Select v-model="caseFilter">
          <SelectTrigger aria-label="测试用例" class="w-52">
            <SelectValue placeholder="全部用例" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部用例</SelectItem>
            <SelectItem v-for="item in filterCases" :key="item.id" :value="String(item.id)">
              {{ item.code }} {{ item.name }}
            </SelectItem>
          </SelectContent>
        </Select>
        <Select v-model="statusFilter">
          <SelectTrigger aria-label="执行状态" class="w-36">
            <SelectValue placeholder="全部状态" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部状态</SelectItem>
            <SelectItem v-for="(text, key) in RUN_STATUS_TEXT" :key="key" :value="key">{{ text }}</SelectItem>
          </SelectContent>
        </Select>
        <span v-if="result?.hasActive" class="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span class="size-1.5 animate-pulse rounded-full bg-indigo-500" />
          存在进行中的执行，列表自动刷新
        </span>
        <div class="flex-1" />
        <Button @click="openDialog">
          <Plus data-icon="inline-start" />
          新建执行
        </Button>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead class="w-16">ID</TableHead>
              <TableHead class="min-w-56">用例 / 目标</TableHead>
              <TableHead class="w-28">模块</TableHead>
              <TableHead class="w-24">模式</TableHead>
              <TableHead class="w-24">状态</TableHead>
              <TableHead class="w-20">耗时</TableHead>
              <TableHead class="w-28">创建时间</TableHead>
              <TableHead class="w-20 text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody :aria-busy="loading">
            <TableRow v-if="loading">
              <TableCell :colspan="8" class="py-10 text-center text-muted-foreground">正在加载执行记录…</TableCell>
            </TableRow>
            <TableEmpty v-else-if="loadFailed" text="执行记录加载失败，列表会自动重试" :colspan="8" />
            <TableEmpty
              v-else-if="!result?.items.length"
              :text="hasFilters ? '没有符合筛选条件的执行记录' : '还没有执行记录，点击右上角「新建执行」发起一次本地运行'"
              :colspan="8"
            />
            <TableRow v-for="row in result.items" v-else :key="row.id" class="cursor-pointer" @click="router.push(`/runs/${row.id}`)">
              <TableCell class="font-semibold">#{{ row.id }}</TableCell>
              <TableCell>
                <div class="text-[13px] font-medium">
                  {{ row.testCaseCode ? `${row.testCaseCode} ${row.testCaseName}` : '自定义执行' }}
                </div>
                <div class="mt-0.5 font-mono text-xs text-muted-foreground">{{ row.target || '（全部测试）' }}</div>
              </TableCell>
              <TableCell class="max-w-32 truncate text-xs text-muted-foreground" :title="row.testCaseModule ?? '未分类'">
                {{ row.testCaseModule ?? '未分类' }}
              </TableCell>
              <TableCell>{{ MODE_TEXT[row.mode] ?? row.mode }}</TableCell>
              <TableCell>
                <StatusBadge
                  :text="RUN_STATUS_TEXT[row.status] ?? row.status"
                  :type="RUN_STATUS_BADGE[row.status] ?? 'neutral'"
                  :dot="row.status === 'running'"
                />
              </TableCell>
              <TableCell>{{ formatDuration(row.durationMs) }}</TableCell>
              <TableCell class="text-xs text-muted-foreground">{{ fromNow(row.createdAt) }}</TableCell>
              <TableCell class="text-right" @click.stop>
                <Button
                  v-if="row.status === 'running' || row.status === 'queued'"
                  variant="ghost"
                  size="xs"
                  class="text-red-600 hover:text-red-700"
                  @click="cancelTarget = row"
                >
                  取消
                </Button>
                <Button v-else variant="ghost" size="xs" @click="router.push(`/runs/${row.id}`)">详情</Button>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </CardContent>
      <TablePagination
        v-if="result && !loadFailed"
        v-model:page="page"
        v-model:page-size="pageSize"
        :total="result.total"
        label="执行记录分页"
      />
    </Card>

    <!-- 新建执行 -->
    <Dialog v-model:open="dialogVisible">
      <DialogContent class="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>新建执行</DialogTitle>
          <DialogDescription>在本地 e2e 工程中以子进程运行，同一时刻串行执行一条</DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <Label for="run-case">关联用例</Label>
            <Select v-model="form.testCaseId">
              <SelectTrigger id="run-case">
                <SelectValue placeholder="选择已有脚本的用例" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem v-for="c in runnableCases" :key="c.id" :value="String(c.id)">
                    {{ c.code }} {{ c.name }}（{{ CASE_STATUS_TEXT[c.status] }}）
                  </SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <Label>执行模式</Label>
            <RadioGroup v-model="form.mode" class="gap-2">
              <div class="flex items-center gap-2">
                <RadioGroupItem id="mode-auto" value="auto" />
                <Label for="mode-auto" class="font-normal">自动（已验证用例走零 AI 回放）</Label>
              </div>
              <div class="flex items-center gap-2">
                <RadioGroupItem id="mode-explore" value="explore" />
                <Label for="mode-explore" class="font-normal">探索（可用 AI）</Label>
              </div>
              <div class="flex items-center gap-2">
                <RadioGroupItem id="mode-replay" value="replay" />
                <Label for="mode-replay" class="font-normal">回放</Label>
              </div>
              <div class="flex items-center gap-2">
                <RadioGroupItem id="mode-strict" value="strict" />
                <Label for="mode-strict" class="font-normal">严格回放</Label>
              </div>
            </RadioGroup>
            <p class="text-xs leading-relaxed text-muted-foreground">
              探索可录制缓存。回放只读取缓存，缓存失效时报告失败。
            </p>
          </Field>
          <Field v-if="form.mode === 'explore' || form.mode === 'replay'">
            <Label class="flex items-center gap-2">
              <input v-model="form.autoRepair" type="checkbox" class="accent-primary" />
              定位或 Agent 操作失败时，最多自动修复两轮
            </Label>
          </Field>
        </FieldGroup>
        <DialogFooter>
          <Button variant="outline" @click="dialogVisible = false">取消</Button>
          <Button :disabled="submitting || !form.testCaseId" @click="submit">
            <Play data-icon="inline-start" />
            开始执行
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <ConfirmDialog
      :open="!!cancelTarget"
      title="取消执行"
      :description="cancelTarget ? `确认取消执行 #${cancelTarget.id}？正在运行的子进程将被终止。` : ''"
      confirm-text="取消执行"
      danger
      @update:open="(v: boolean) => { if (!v) cancelTarget = null; }"
      @confirm="doCancel"
    />
  </div>
</template>
