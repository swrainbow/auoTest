<script setup lang="ts">
import { computed } from 'vue';
import { Badge } from '@/components/ui/badge';

const props = defineProps<{
  text: string;
  type: string;
  dot?: boolean;
}>();

const styleClass = computed(() => {
  const types = props.type.split(' ');
  if (types.includes('passed')) return 'bg-status-success text-status-success-foreground';
  if (types.includes('failed')) return 'bg-status-failure text-status-failure-foreground';
  if (types.includes('info')) return 'bg-primary-subtle text-primary-subtle-foreground';
  if (types.includes('warn')) return 'bg-status-warning text-status-warning-foreground';
  return 'bg-muted text-muted-foreground';
});

const pulsing = computed(() => props.type.includes('running'));
</script>

<template>
  <Badge variant="secondary" :class="styleClass">
    <span v-if="dot" class="size-1.5 rounded-full bg-current" :class="{ 'motion-safe:animate-pulse': pulsing }" />
    {{ text }}
  </Badge>
</template>
