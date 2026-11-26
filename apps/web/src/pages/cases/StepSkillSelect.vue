<script setup lang="ts">
import { computed } from 'vue';
import { Field } from '@/components/ui/field';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { SkillDto } from '@autotest/shared';

const props = defineProps<{ id: string; skills: SkillDto[]; disabled?: boolean }>();
const model = defineModel<string>();
const inherit = '__inherit__';
const inheritLabel = '使用用例默认 Skill';
const selected = computed({
  get: () => model.value || inherit,
  set: (value: string) => { model.value = value === inherit ? undefined : value; },
});
const selectedSkill = computed(() => props.skills.find((skill) => skill.dir === model.value));
const options = computed(() => model.value && !selectedSkill.value
  ? [...props.skills, { dir: model.value, name: model.value }]
  : props.skills);
</script>

<template>
  <Field orientation="horizontal" class="gap-2" :data-disabled="disabled || undefined">
    <Label :for="id" class="w-8 shrink-0 text-xs text-muted-foreground">Skill</Label>
    <Select v-model="selected" :disabled="disabled">
      <SelectTrigger :id="id" size="sm" class="min-w-0 flex-1 text-xs">
        <SelectValue>{{ selectedSkill?.name || model || inheritLabel }}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectItem :value="inherit">{{ inheritLabel }}</SelectItem>
          <SelectItem v-for="skill in options" :key="skill.dir" :value="skill.dir">{{ skill.name }}</SelectItem>
        </SelectGroup>
      </SelectContent>
    </Select>
  </Field>
</template>
