<script setup lang="ts">
import { Box } from '@lucide/vue';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { TableCell, TableRow } from '@/components/ui/table';

defineProps<{
  text?: string;
  colspan?: number;
}>();
</script>

<template>
  <TableRow>
    <TableCell :colspan="colspan ?? 1" class="py-10">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Box />
          </EmptyMedia>
          <EmptyTitle class="sr-only">暂无数据</EmptyTitle>
          <EmptyDescription>{{ text ?? '暂无数据' }}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent />
      </Empty>
    </TableCell>
  </TableRow>
</template>
