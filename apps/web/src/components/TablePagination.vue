<script setup lang="ts">
import { ChevronLeft, ChevronRight } from '@lucide/vue';
import { PaginationList, PaginationListItem, PaginationNext, PaginationPrev, PaginationRoot } from 'reka-ui';
import { Button } from '@/components/ui/button';
import { CardFooter } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

defineProps<{ total: number; label: string }>();
const page = defineModel<number>('page', { required: true });
const pageSize = defineModel<string>('pageSize', { required: true });
const pageSizes = ['10', '20', '50'];
</script>

<template>
  <CardFooter class="flex-wrap justify-between gap-3 border-t">
    <div class="flex items-center gap-3 text-xs text-muted-foreground">
      <span class="tabular-nums" aria-live="polite">共 {{ total }} 条记录</span>
      <Select v-model="pageSize">
        <SelectTrigger aria-label="每页条数" size="sm">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem v-for="size in pageSizes" :key="size" :value="size">每页 {{ size }} 条</SelectItem>
        </SelectContent>
      </Select>
    </div>
    <PaginationRoot
      v-if="total > Number(pageSize)"
      v-model:page="page"
      as="nav"
      :aria-label="label"
      :total="total"
      :items-per-page="Number(pageSize)"
      :sibling-count="1"
      show-edges
    >
      <PaginationList v-slot="{ items }" class="flex flex-wrap items-center gap-1">
        <PaginationPrev as-child>
          <Button variant="outline" size="icon-sm" class="max-sm:size-7" aria-label="上一页"><ChevronLeft /></Button>
        </PaginationPrev>
        <template v-for="(item, index) in items" :key="item.type === 'page' ? item.value : `ellipsis-${index}`">
          <PaginationListItem v-if="item.type === 'page'" as-child :value="item.value">
            <Button
              :variant="item.value === page ? 'secondary' : 'ghost'"
              size="icon-sm"
              class="max-sm:size-7"
              :aria-label="`第 ${item.value} 页`"
              :aria-current="item.value === page ? 'page' : undefined"
            >
              {{ item.value }}
            </Button>
          </PaginationListItem>
          <span v-else class="px-1 text-muted-foreground" aria-hidden="true">…</span>
        </template>
        <PaginationNext as-child>
          <Button variant="outline" size="icon-sm" class="max-sm:size-7" aria-label="下一页"><ChevronRight /></Button>
        </PaginationNext>
      </PaginationList>
    </PaginationRoot>
  </CardFooter>
</template>
