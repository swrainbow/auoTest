<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Search, Wand2 } from '@lucide/vue';
import { toast } from 'vue-sonner';
import { deleteCase, getCases, updateCaseStatus } from '@/api/client';
import { CASE_STATUS_BADGE, CASE_STATUS_TEXT, fromNow } from '@/utils/format';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import StatusBadge from '@/components/StatusBadge.vue';
import TableEmpty from '@/components/TableEmpty.vue';
import TablePagination from '@/components/TablePagination.vue';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { TestCaseDto } from '@autotest/shared';

const route = useRoute();
const router = useRouter();
const loading = ref(true);
const loadFailed = ref(false);
const cases = ref<TestCaseDto[]>([]);
const keyword = ref(typeof route.query.q === 'string' ? route.query.q : '');
const statusFilter = ref('all');
const moduleFilter = ref('all');
const page = ref(1);
const pageSize = ref('10');

type ConfirmState = { kind: 'publish' | 'deprecate' | 'delete'; item: TestCaseDto } | null;
const confirmState = ref<ConfirmState>(null);

const modules = computed(() => [...new Set(cases.value.map((c) => c.module))]);

const filtered = computed(() => {
  let list = cases.value;
  const q = keyword.value.trim().toLowerCase();
  if (q) {
    list = list.filter((c) => `${c.code} ${c.name} ${c.description} ${c.tags.join(' ')}`.toLowerCase().includes(q));
  }
  if (statusFilter.value !== 'all') list = list.filter((c) => c.status === statusFilter.value);
  if (moduleFilter.value !== 'all') list = list.filter((c) => c.module === moduleFilter.value);
  return list;
});

const pageCount = computed(() => Math.max(1, Math.ceil(filtered.value.length / Number(pageSize.value))));
const visibleCases = computed(() => {
  const size = Number(pageSize.value);
  const start = (page.value - 1) * size;
  return filtered.value.slice(start, start + size);
});
const hasFilters = computed(() => Boolean(keyword.value.trim()) || statusFilter.value !== 'all' || moduleFilter.value !== 'all');

watch(() => route.query.q, q => { keyword.value = typeof q === 'string' ? q : ''; });
watch([keyword, statusFilter, moduleFilter, pageSize], () => { page.value = 1; });
watch(pageCount, count => { if (page.value > count) page.value = count; });

async function load(): Promise<void> {
  loading.value = true;
  loadFailed.value = false;
  try {
    cases.value = await getCases();
  } catch {
    loadFailed.value = true;
  } finally {
    loading.value = false;
  }
}

async function onConfirm(): Promise<void> {
  const state = confirmState.value;
  confirmState.value = null;
  if (!state) return;
  const { kind, item } = state;
  if (kind === 'publish') {
    await updateCaseStatus(item.id, 'published');
    toast.success('已发布');
  } else if (kind === 'deprecate') {
    await updateCaseStatus(item.id, 'deprecated');
    toast.success('已停用');
  } else {
    await deleteCase(item.id);
    toast.success('已删除');
  }
  void load();
}

const confirmMeta = computed(() => {
  const s = confirmState.value;
  if (!s) return { title: '', description: '', confirmText: '', danger: false };
  const c = s.item;
  if (s.kind === 'publish') {
    return {
      title: '发布用例',
      description: `确认发布 ${c.code}「${c.name}」？发布后用例进入只读状态，修改需停用或复制新用例。`,
      confirmText: '发布',
      danger: false,
    };
  }
  if (s.kind === 'deprecate') {
    return { title: '停用用例', description: `确认停用 ${c.code}「${c.name}」？`, confirmText: '停用', danger: false };
  }
  return {
    title: '删除用例',
    description: `确认删除 ${c.code}「${c.name}」？该操作不可恢复。`,
    confirmText: '删除',
    danger: true,
  };
});

onMounted(() => void load());
</script>

<template>
  <Card>
    <CardHeader class="flex flex-row flex-wrap items-center gap-3 space-y-0">
      <CardTitle class="text-[15px]">测试用例</CardTitle>
      <div class="relative w-56">
        <Search class="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/70" />
        <Input v-model="keyword" placeholder="搜索编码 / 名称 / 标签…" class="h-8 pl-8 text-xs" />
      </div>
      <Select v-model="statusFilter">
        <SelectTrigger class="h-8 w-32 text-xs">
          <SelectValue placeholder="全部状态" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">全部状态</SelectItem>
          <SelectItem v-for="(text, key) in CASE_STATUS_TEXT" :key="key" :value="key">{{ text }}</SelectItem>
        </SelectContent>
      </Select>
      <Select v-model="moduleFilter">
        <SelectTrigger class="h-8 w-32 text-xs">
          <SelectValue placeholder="全部模块" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">全部模块</SelectItem>
          <SelectItem v-for="m in modules" :key="m" :value="m">{{ m }}</SelectItem>
        </SelectContent>
      </Select>
      <div class="flex-1" />
      <Button @click="router.push('/cases/new')">
        <Wand2 data-icon="inline-start" />
        AI 创建用例
      </Button>
    </CardHeader>
    <CardContent>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead class="w-20">编码</TableHead>
            <TableHead class="min-w-56">用例名称</TableHead>
            <TableHead class="w-24">模块</TableHead>
            <TableHead class="w-16">优先级</TableHead>
            <TableHead class="w-24">状态</TableHead>
            <TableHead class="w-24">执行模式</TableHead>
            <TableHead class="w-48 text-right">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableEmpty v-if="loading || loadFailed" :text="loading ? '正在加载测试用例…' : '测试用例加载失败，请刷新重试。'" :colspan="7" />
          <TableEmpty v-else-if="!filtered.length" :text="hasFilters ? '没有符合条件的测试用例' : '暂无用例，试试右上角「AI 创建用例」'" :colspan="7" />
          <TableRow v-for="row in visibleCases" v-else :key="row.id" class="cursor-pointer" @click="router.push(`/cases/${row.id}/edit`)">
            <TableCell class="font-semibold">{{ row.code }}</TableCell>
            <TableCell>
              <div class="text-[13px] font-medium">{{ row.name }}</div>
              <div class="mt-0.5 text-xs text-muted-foreground">
                v{{ row.currentVersion }} · {{ row.steps.length }} 步 · 更新于 {{ fromNow(row.updatedAt) }}
              </div>
            </TableCell>
            <TableCell>{{ row.module }}</TableCell>
            <TableCell>{{ row.priority }}</TableCell>
            <TableCell>
              <StatusBadge :text="CASE_STATUS_TEXT[row.status] ?? row.status" :type="CASE_STATUS_BADGE[row.status] ?? 'neutral'" />
            </TableCell>
            <TableCell class="text-[13px]">
              {{ row.executionMode === 'strict' ? '严格回放' : row.executionMode === 'replay' ? '回放' : '探索' }}
            </TableCell>
            <TableCell class="text-right" @click.stop>
              <div class="flex justify-end gap-1">
                <Button variant="ghost" size="xs" @click="router.push(`/cases/${row.id}/edit`)">编辑</Button>
                <Button
                  v-if="row.status === 'trial-passed' && row.zeroAiVerified"
                  variant="ghost"
                  size="xs"
                  class="text-emerald-600 hover:text-emerald-700"
                  @click="confirmState = { kind: 'publish', item: row }"
                >
                  发布
                </Button>
                <Button
                  v-if="row.status === 'published'"
                  variant="ghost"
                  size="xs"
                  @click="confirmState = { kind: 'deprecate', item: row }"
                >
                  停用
                </Button>
                <Button
                  variant="ghost"
                  size="xs"
                  class="text-red-600 hover:text-red-700"
                  @click="confirmState = { kind: 'delete', item: row }"
                >
                  删除
                </Button>
              </div>
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </CardContent>
    <TablePagination
      v-if="!loading && !loadFailed"
      v-model:page="page"
      v-model:page-size="pageSize"
      :total="filtered.length"
      label="测试用例分页"
    />
  </Card>

  <ConfirmDialog
    :open="!!confirmState"
    :title="confirmMeta.title"
    :description="confirmMeta.description"
    :confirm-text="confirmMeta.confirmText"
    :danger="confirmMeta.danger"
    @update:open="(v: boolean) => { if (!v) confirmState = null; }"
    @confirm="onConfirm"
  />
</template>
