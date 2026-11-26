<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  ChevronsLeft,
  ChevronsRight,
  FileText,
  FolderOpen,
  Gauge,
  Library,
  ListChecks,
  Moon,
  Play,
  Search,
  Settings,
  Wand2,
} from '@lucide/vue';
import ScriptGenerationNotifications from '@/components/ScriptGenerationNotifications.vue';
import { useAppStore } from '@/stores/app';
import { cn } from '@/lib/utils';

interface NavItem {
  path: string;
  title: string;
  icon: unknown;
}

const navItems: NavItem[] = [
  { path: '/dashboard', title: '总览', icon: Gauge },
  { path: '/preparations', title: '测试准备', icon: ListChecks },
  { path: '/runs', title: '测试运行', icon: Play },
  { path: '/cases', title: '测试用例', icon: FileText },
  { path: '/cases/new', title: 'AI 创建', icon: Wand2 },
  { path: '/skills', title: 'Skill 管理', icon: Library },
  { path: '/settings', title: '设置', icon: Settings },
];

const route = useRoute();
const router = useRouter();
const store = useAppStore();
const search = ref('');

const activePath = computed(() => {
  if (route.path === '/preparations') return '/preparations';
  if (route.path.startsWith('/runs')) return '/runs';
  if (route.path.startsWith('/cases/new')) return '/cases/new';
  if (route.path.startsWith('/cases')) return '/cases';
  if (route.path.startsWith('/skills')) return '/skills';
  if (route.path.startsWith('/settings')) return '/settings';
  return '/dashboard';
});

const breadcrumb = computed(() => [route.meta.group ?? '', route.meta.title ?? '']);

function onSearch(): void {
  const q = search.value.trim();
  if (q) router.push({ path: '/cases', query: { q } });
}
</script>

<template>
  <div class="flex h-dvh overflow-hidden bg-background">
    <aside
      :class="cn(
        'flex w-12 shrink-0 flex-col overflow-hidden bg-background motion-safe:transition-[width] motion-safe:duration-200',
        store.sidebarCollapsed ? 'md:w-16' : 'md:w-52',
      )"
    >
      <div :class="cn('flex h-14 shrink-0 items-center justify-center gap-2.5', !store.sidebarCollapsed && 'md:justify-start md:px-3.5')">
        <div class="grid size-7 shrink-0 place-items-center rounded-lg bg-primary text-[13px] font-semibold text-primary-foreground">
          测
        </div>
        <div v-if="!store.sidebarCollapsed" class="hidden leading-tight md:block">
          <div class="text-sm font-bold">AutoTest</div>
          <div class="text-[11px] text-muted-foreground">业务测试平台</div>
        </div>
      </div>

      <nav class="flex flex-1 flex-col gap-1 overflow-y-auto p-1.5 md:px-2.5 md:pt-3" aria-label="主导航">
        <router-link
          v-for="item in navItems"
          :key="item.path"
          :to="item.path"
          :aria-label="item.title"
          :title="item.title"
          :aria-current="activePath === item.path ? 'page' : undefined"
          :class="cn(
            'flex shrink-0 items-center justify-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] last:mt-4 focus-visible:ring-2 focus-visible:ring-ring motion-safe:transition-colors',
            !store.sidebarCollapsed && 'md:justify-start',
            activePath === item.path
              ? 'bg-primary-subtle font-semibold text-primary-subtle-foreground'
              : 'text-foreground/75 hover:bg-muted hover:text-foreground',
          )"
        >
          <component :is="item.icon" class="size-4 shrink-0" aria-hidden="true" />
          <span v-if="!store.sidebarCollapsed" class="hidden truncate md:block">{{ item.title }}</span>
        </router-link>
      </nav>

      <div :class="cn(
        'flex shrink-0 flex-col items-center gap-2 px-1.5 py-2.5',
        !store.sidebarCollapsed && 'md:flex-row md:justify-between md:px-2.5',
      )">
        <div class="flex min-w-0 items-center gap-2">
          <div class="grid size-7 shrink-0 place-items-center rounded-lg bg-primary text-xs text-primary-foreground" title="测试工程师">工</div>
          <div v-if="!store.sidebarCollapsed" class="hidden min-w-0 leading-tight md:block">
            <div class="truncate text-xs font-semibold">测试工程师</div>
            <div class="truncate text-[10px] text-muted-foreground">tester@autotest.local</div>
          </div>
        </div>
        <button
          type="button"
          :class="cn(
            'hidden size-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring md:grid',
            store.sidebarCollapsed && 'order-first',
          )"
          :title="store.sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'"
          :aria-label="store.sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'"
          :aria-expanded="!store.sidebarCollapsed"
          @click="store.toggleSidebar()"
        >
          <ChevronsLeft v-if="!store.sidebarCollapsed" class="size-3.5" />
          <ChevronsRight v-else class="size-3.5" />
        </button>
      </div>
    </aside>

    <div class="flex min-w-0 flex-1 flex-col overflow-hidden">
      <header class="flex h-14 shrink-0 items-center justify-between bg-background px-3 sm:px-6">
        <div class="flex items-center gap-1.5 text-[13px]">
          <FolderOpen class="size-3.5 text-muted-foreground/70" />
          <span class="text-muted-foreground">{{ breadcrumb[0] }}</span>
          <span class="text-muted-foreground/60">›</span>
          <span class="font-semibold">{{ breadcrumb[1] }}</span>
        </div>
        <div class="flex items-center gap-2.5">
          <div class="hidden h-8 w-60 items-center gap-2 rounded-lg bg-muted px-2.5 sm:flex">
            <Search class="size-3.5 text-muted-foreground/70" />
            <input
              v-model="search"
              placeholder="搜索测试用例…"
              class="w-full bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground/70"
              @keyup.enter="onSearch"
            />
            <kbd class="shrink-0 whitespace-nowrap rounded border bg-background px-1.5 py-px text-[10px] text-muted-foreground">Ctrl K</kbd>
          </div>
          <ScriptGenerationNotifications />
          <button class="grid size-8 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-muted" title="主题（预留）">
            <Moon class="size-4" />
          </button>
        </div>
      </header>

      <main class="flex-1 overflow-y-auto rounded-tl-xl bg-workspace px-3 pt-4 pb-10 sm:px-5 sm:pt-5 md:mr-3 md:mb-3 md:rounded-xl">
        <div class="mx-auto w-full min-w-0 max-w-[1480px]">
          <router-view />
        </div>
      </main>
    </div>
  </div>
</template>
