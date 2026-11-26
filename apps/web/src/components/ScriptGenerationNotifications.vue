<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Bell } from '@lucide/vue';
import { PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from 'reka-ui';
import { toast } from 'vue-sonner';
import StatusBadge from '@/components/StatusBadge.vue';
import { SCRIPT_GENERATION_TEXT, isScriptGenerationActive, useScriptGenerationStore } from '@/stores/script-generation';
import { formatTime } from '@/utils/format';

const open = ref(false);
const route = useRoute();
const router = useRouter();
const store = useScriptGenerationStore();
let timer: ReturnType<typeof setTimeout>;
let stopped = false;

async function refresh(): Promise<void> {
  const completed = await store.refresh();
  if (stopped) return;
  for (const job of completed) {
    const path = `/cases/${job.testCaseId}/edit`;
    if (route.path === path) continue;
    const action = { label: '查看用例', onClick: () => void router.push(path) };
    if (job.status === 'succeeded') toast.success(`${job.caseCode} 脚本已生成`, { action });
    else toast.error(`${job.caseCode} 脚本生成失败`, { action });
  }
}

async function poll(): Promise<void> {
  await refresh();
  schedule();
}

function schedule(): void {
  clearTimeout(timer);
  if (!stopped) timer = setTimeout(poll, store.activeCount ? 2000 : 8000);
}

watch(() => store.activeCount, schedule);
onMounted(() => {
  void poll();
  window.addEventListener('focus', refresh);
});
onUnmounted(() => {
  stopped = true;
  clearTimeout(timer);
  window.removeEventListener('focus', refresh);
});
</script>

<template>
  <PopoverRoot v-model:open="open" @update:open="value => value && refresh()">
    <PopoverTrigger
      type="button"
      :aria-label="store.activeCount ? `脚本生成通知，${store.activeCount} 项进行中` : '脚本生成通知'"
      class="relative grid size-8 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Bell class="size-4" aria-hidden="true" />
      <span v-if="store.activeCount" aria-hidden="true" class="absolute right-0 top-0 grid min-w-4 place-items-center rounded-full bg-primary px-0.5 text-[10px] text-primary-foreground">
        {{ store.activeCount }}
      </span>
    </PopoverTrigger>
    <PopoverPortal>
      <PopoverContent
        align="end"
        :side-offset="8"
        :collision-padding="12"
        class="z-50 w-[min(22rem,calc(100vw-1.5rem))] rounded-xl border bg-popover text-sm text-popover-foreground shadow-md"
      >
        <p class="border-b px-4 py-3 font-semibold">脚本生成任务</p>
        <p v-if="store.refreshFailed" role="status" class="px-4 pt-3 text-muted-foreground">暂时无法刷新，正在重试。</p>
        <ul v-if="store.jobs.length" class="max-h-[min(60vh,28rem)] divide-y overflow-y-auto px-4">
          <li v-for="job in store.jobs" :key="job.id" class="py-2.5">
            <RouterLink
              :to="`/cases/${job.testCaseId}/edit`"
              class="flex items-start justify-between gap-2 rounded-sm focus-visible:ring-2 focus-visible:ring-ring"
              @click="open = false"
            >
              <span class="min-w-0 font-medium wrap-anywhere hover:underline">{{ job.caseCode }} · {{ job.caseName }}</span>
              <StatusBadge
                :text="SCRIPT_GENERATION_TEXT[job.status]"
                :type="job.status === 'succeeded' ? 'passed' : job.status === 'failed' ? 'failed' : 'info'"
                :dot="isScriptGenerationActive(job)"
              />
            </RouterLink>
            <p class="mt-1 text-xs text-muted-foreground">
              <span v-if="job.resultVersion">v{{ job.sourceVersion }} → v{{ job.resultVersion }}</span>
              <span v-else>v{{ job.sourceVersion }}</span>
              · {{ formatTime(job.updatedAt) }}
            </p>
            <p v-if="job.error" class="mt-1 text-xs text-destructive wrap-anywhere">{{ job.error }}</p>
          </li>
        </ul>
        <p v-else-if="!store.refreshFailed" class="px-4 py-3 text-muted-foreground">
          {{ store.refreshed ? '暂无脚本生成任务' : '正在读取任务…' }}
        </p>
        <div v-else class="pb-3" />
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>
