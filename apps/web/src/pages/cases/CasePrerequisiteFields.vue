<script setup lang="ts">
import { computed } from 'vue';
import { Field, FieldDescription, FieldError, FieldGroup } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { CasePrerequisite } from '@autotest/shared';

const props = defineProps<{
  id: string;
  availableSkill?: string;
  disabled?: boolean;
  validate?: boolean;
}>();
const prerequisite = defineModel<CasePrerequisite>();

const skip = '__skip__';
const skipLabel = '不执行前置检查';
const skillLabel = '服务同步与地图绑定';
const skillOption = computed(() => props.availableSkill ?? prerequisite.value?.skill);
const selectedSkill = computed({
  get: () => prerequisite.value?.skill ?? skip,
  set: (skill: string) => {
    prerequisite.value = skill === skip ? undefined : { skill, mapName: '' };
  },
});
const mapName = computed({
  get: () => prerequisite.value?.mapName ?? '',
  set: (value: string) => {
    if (prerequisite.value) prerequisite.value = { ...prerequisite.value, mapName: value };
  },
});
const serviceName = computed({
  get: () => prerequisite.value?.serviceName ?? '',
  set: (value: string) => {
    if (prerequisite.value) prerequisite.value = { ...prerequisite.value, serviceName: value || undefined };
  },
});
const missingMap = computed(() => props.validate && prerequisite.value && !mapName.value.trim());
</script>

<template>
  <FieldGroup class="gap-3">
    <Field :data-disabled="disabled || undefined" class="gap-2">
      <Label :for="`${id}-skill`">前置操作 Skill</Label>
      <Select v-model="selectedSkill" :disabled="disabled">
        <SelectTrigger :id="`${id}-skill`" class="w-full">
          <SelectValue>{{ prerequisite ? skillLabel : skipLabel }}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectItem :value="skip">{{ skipLabel }}</SelectItem>
            <SelectItem v-if="skillOption" :value="skillOption">{{ skillLabel }}</SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>
      <FieldDescription v-if="prerequisite" class="text-xs">检查服务同步和地图绑定，通过后执行测试步骤。</FieldDescription>
    </Field>
    <FieldGroup v-if="prerequisite" class="grid gap-3 sm:grid-cols-2">
      <Field :data-invalid="missingMap || undefined" :data-disabled="disabled || undefined" class="gap-2">
        <Label :for="`${id}-map`">地图名称</Label>
        <Input
          :id="`${id}-map`"
          v-model="mapName"
          :disabled="disabled"
          :aria-invalid="missingMap || undefined"
          :aria-describedby="missingMap ? `${id}-map-error` : undefined"
          placeholder="输入完整地图名称"
          required
        />
        <FieldError v-if="missingMap" :id="`${id}-map-error`">请输入地图名称</FieldError>
      </Field>
      <Field :data-disabled="disabled || undefined" class="gap-2">
        <Label :for="`${id}-service`">Paladin 服务名（可选）</Label>
        <Input :id="`${id}-service`" v-model="serviceName" :disabled="disabled" placeholder="有多个服务时填写完整名称" />
      </Field>
    </FieldGroup>
  </FieldGroup>
</template>
