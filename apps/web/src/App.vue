<script setup lang="ts">
import MainLayout from '@/layouts/MainLayout.vue';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
</script>

<template>
  <TooltipProvider>
    <RouterView v-if="$route.name === 'run-report'" />
    <MainLayout v-else />
  </TooltipProvider>
  <Toaster position="top-center" rich-colors close-button />
</template>
