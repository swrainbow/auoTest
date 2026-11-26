<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "cn"

const props = defineProps<{
  class?: HTMLAttributes["class"]
}>()
</script>

<template>
  <thead
    data-slot="table-header"
    :class="cn('bg-muted/65 [&_tr]:border-0 [&_tr:hover]:bg-transparent', props.class)"
  >
    <slot />
  </thead>
</template>
