<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "cn"

const props = defineProps<{
  class?: HTMLAttributes["class"]
}>()
</script>

<template>
  <div
    data-slot="card"
    :class="
      cn(
        'bg-card text-card-foreground flex min-w-0 flex-col gap-4 rounded-xl border py-4 shadow-panel',
        props.class,
      )
    "
  >
    <slot />
  </div>
</template>
