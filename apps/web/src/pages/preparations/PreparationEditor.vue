<script setup lang="ts">
import { computed, ref } from 'vue';
import { ArrowDown, ArrowUp, Plus, X } from '@lucide/vue';
import { toast } from 'vue-sonner';
import type { PreparationFlow, PreparationRule, PreparationSelection, PreparationSkillId, PreparationWorkspace } from '@autotest/shared';
import { messageOf, savePreparationFlow, savePreparationRule } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { flowLabel, selectionLabel } from './labels';

const props = defineProps<{ workspace: PreparationWorkspace }>();
const emit = defineEmits<{ rule: [rule: PreparationRule]; flow: [flow: PreparationFlow] }>();
const source = ref('');
const name = ref(suggestName('服务同步与地图绑定'));
const steps = ref<PreparationSkillId[]>(props.workspace.skills.map(skill => skill.id));
const newestRule = computed(() => [...props.workspace.rules].sort((a, b) => b.version - a.version));
const version = ref(newestRule.value[0]?.version);
const policy = ref<PreparationSelection>(newestRule.value[0]?.selection ?? 'unique');
const selectedRule = computed(() => props.workspace.rules.find(rule => rule.version === version.value));
const skillName = (id: PreparationSkillId) => props.workspace.skills.find(skill => skill.id === id)?.name ?? id;
const available = computed(() => props.workspace.skills.filter(skill => !steps.value.includes(skill.id)));
const ruleBusy = ref(false);
const flowBusy = ref(false);
const ruleError = ref('');
const flowError = ref('');
const orderingError = computed(() => {
  for (const [index, skill] of steps.value.entries()) {
    const dependency = props.workspace.skills.find(item => item.id === skill)?.requires;
    if (dependency && !steps.value.slice(0, index).includes(dependency)) {
      return `请先添加「${skillName(dependency)}」，并将它排在「${skillName(skill)}」前面。`;
    }
  }
  return '';
});

function suggestName(original: string): string {
  const names = new Set(props.workspace.flows.map(flow => flow.name));
  if (!names.has(original)) return original;
  const base = original.replace(/（副本(?: \d+)?）$/, '');
  let name = `${base}（副本）`;
  for (let index = 2; names.has(name); index++) name = `${base}（副本 ${index}）`;
  return name;
}

function useSource(value: unknown) {
  source.value = String(value);
  const flow = props.workspace.flows.find(item => item.id === source.value);
  if (!flow) return;
  name.value = suggestName(flow.name);
  steps.value = [...flow.steps];
  version.value = flow.ruleVersion;
  policy.value = selectedRule.value?.selection ?? 'unique';
  flowError.value = '';
}

function move(index: number, direction: number) {
  const [skill] = steps.value.splice(index, 1);
  steps.value.splice(index + direction, 0, skill);
}

async function saveRule() {
  if (ruleBusy.value) return;
  ruleBusy.value = true;
  ruleError.value = '';
  try {
    const rule = await savePreparationRule(policy.value);
    version.value = rule.version;
    emit('rule', rule);
    toast.success(`已选择规则 v${rule.version}`);
  } catch (error) {
    ruleError.value = messageOf(error);
  } finally {
    ruleBusy.value = false;
  }
}

async function saveFlow() {
  if (!version.value || flowBusy.value || orderingError.value || !name.value.trim() || !steps.value.length) return;
  flowError.value = '';
  flowBusy.value = true;
  try {
    emit('flow', await savePreparationFlow({ name: name.value.trim(), ruleVersion: version.value, steps: [...steps.value] }));
  } catch (error) {
    flowError.value = messageOf(error);
  } finally {
    flowBusy.value = false;
  }
}
</script>

<template>
  <div class="grid items-start gap-4 lg:grid-cols-[minmax(260px,1fr)_minmax(0,1.65fr)]">
    <Card>
      <CardHeader>
        <CardTitle>服务选择规则</CardTitle>
        <CardDescription>维护地图绑定时如何选择 Paladin 服务。完整流程试跑通过后，规则标记为已验证。</CardDescription>
      </CardHeader>
      <CardContent>
        <form class="flex flex-col items-start gap-4" @submit.prevent="saveRule">
          <Field>
            <FieldLabel for="rule-selection">目标服务</FieldLabel>
            <Select v-model="policy">
              <SelectTrigger id="rule-selection" class="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem v-for="(label, value) in selectionLabel" :key="value" :value="value">{{ label }}</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <FieldError v-if="ruleError" role="alert">{{ ruleError }}</FieldError>
          <Button type="submit" variant="outline" :disabled="ruleBusy || flowBusy">{{ ruleBusy ? '正在保存…' : '保存规则版本' }}</Button>
        </form>
      </CardContent>
    </Card>
    <Card>
      <CardHeader><CardTitle>编排准备流程</CardTitle></CardHeader>
      <CardContent>
        <form class="flex flex-col gap-5" @submit.prevent="saveFlow">
          <Field v-if="workspace.flows.length">
            <FieldLabel for="flow-source">从已有流程复制</FieldLabel>
            <Select :model-value="source" @update:model-value="useSource">
              <SelectTrigger id="flow-source" class="w-full"><SelectValue placeholder="选择已有流程（可选）" /></SelectTrigger>
              <SelectContent><SelectItem v-for="flow in workspace.flows" :key="flow.id" :value="flow.id">{{ flowLabel(flow, workspace.flows) }}</SelectItem></SelectContent>
            </Select>
          </Field>
          <FieldGroup class="grid gap-3 sm:grid-cols-2">
            <Field>
              <FieldLabel for="prep-flow-name">流程名称</FieldLabel>
              <Input id="prep-flow-name" v-model="name" required placeholder="输入流程名称" />
            </Field>
            <Field>
              <FieldLabel for="prep-flow-rule">执行规则版本</FieldLabel>
              <Select v-model="version">
                <SelectTrigger id="prep-flow-rule" class="w-full"><SelectValue placeholder="选择规则版本" /></SelectTrigger>
                <SelectContent><SelectItem v-for="rule in newestRule" :key="rule.version" :value="rule.version">v{{ rule.version }} · {{ rule.status === 'verified' ? '已验证' : '待试跑' }} · {{ selectionLabel[rule.selection] }}</SelectItem></SelectContent>
              </Select>
            </Field>
          </FieldGroup>
          <section class="flex flex-col gap-2">
            <h3 class="text-sm font-medium">执行顺序</h3>
            <ol class="flex flex-col gap-2">
              <li v-for="(id, index) in steps" :key="id" class="flex items-center gap-2 rounded-lg border p-2.5">
                <span class="min-w-4 text-xs text-muted-foreground">{{ index + 1 }}</span>
                <div class="min-w-0 flex-1">
                  <p class="text-sm font-medium">{{ skillName(id) }}</p>
                  <p class="text-xs text-muted-foreground">{{ workspace.skills.find(item => item.id === id)?.description }}</p>
                </div>
                <Button type="button" size="icon-sm" variant="ghost" :aria-label="`上移${skillName(id)}`" :disabled="index === 0" @click="move(index, -1)"><ArrowUp /></Button>
                <Button type="button" size="icon-sm" variant="ghost" :aria-label="`下移${skillName(id)}`" :disabled="index === steps.length - 1" @click="move(index, 1)"><ArrowDown /></Button>
                <Button type="button" size="icon-sm" variant="ghost" :aria-label="`移除${skillName(id)}`" @click="steps.splice(index, 1)"><X /></Button>
              </li>
            </ol>
            <div v-if="available.length" class="flex flex-wrap gap-2">
              <Button v-for="skill in available" :key="skill.id" type="button" size="sm" variant="outline" @click="steps.push(skill.id)"><Plus />添加{{ skill.name }}</Button>
            </div>
            <FieldError v-if="orderingError" role="alert">{{ orderingError }}</FieldError>
          </section>
          <FieldError v-if="flowError" role="alert">{{ flowError }}</FieldError>
          <div><Button type="submit" :disabled="!steps.length || !!orderingError || !version || !name.trim() || ruleBusy || flowBusy">{{ flowBusy ? '正在保存…' : '保存为新流程' }}</Button></div>
        </form>
      </CardContent>
    </Card>
  </div>
</template>
