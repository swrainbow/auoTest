<script setup lang="ts">
import { computed, type Component } from 'vue';
import { ArrowDownRight, ArrowUpRight } from '@lucide/vue';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

const props = defineProps<{
  label: string;
  value: string;
  icon: Component;
  info: string;
  delta?: number | null;
  direction?: 'higher' | 'lower';
  size?: 'large' | 'small';
  unit?: string;
}>();

const negative = computed(() => props.delta != null && (
  props.direction === 'higher' && props.delta < 0 ||
  props.direction === 'lower' && props.delta > 0
));
</script>

<template>
  <div :class="cn('flex min-w-0 flex-col', size === 'small' ? 'gap-1' : 'gap-1.5')">
    <div class="flex items-center gap-1.5">
      <span :class="cn('font-medium text-muted-foreground', size === 'small' ? 'text-xs' : 'text-sm')">{{ label }}</span>
      <Tooltip>
        <TooltipTrigger as-child>
          <button
            type="button"
            :aria-label="label + '说明'"
            class="grid size-5 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
          >
            <component :is="icon" class="size-3.5" aria-hidden="true" />
          </button>
        </TooltipTrigger>
        <TooltipContent>{{ info }}</TooltipContent>
      </Tooltip>
    </div>
    <div class="flex flex-wrap items-baseline gap-x-1.5 gap-y-1">
      <span :class="cn('leading-none font-semibold tracking-tight tabular-nums', size === 'large' ? 'text-[2.1rem] sm:text-[2.5rem]' : size === 'small' ? 'text-xl' : 'text-[1.7rem]')">{{ value }}</span>
      <span v-if="unit && value !== '—'" class="text-xs tabular-nums text-muted-foreground">{{ unit }}</span>
      <span v-if="delta != null" class="inline-flex items-center gap-0.5 text-xs tabular-nums" :class="negative ? 'text-destructive' : 'text-muted-foreground'">
        <ArrowUpRight v-if="delta > 0" class="size-3.5" aria-label="上升" />
        <ArrowDownRight v-else-if="delta < 0" class="size-3.5" aria-label="下降" />
        {{ Math.abs(delta) }}% <span class="ml-1">较上期</span>
      </span>
    </div>
  </div>
</template>
