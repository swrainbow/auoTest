<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { toast } from 'vue-sonner';
import { getSettings, updateSettings } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { PlatformSettings, ScriptReasoning } from '@autotest/shared';

const reasoningLabels = {
  auto: '自动（DeepSeek 默认推理）',
  off: '关闭推理',
  low: '低',
  high: '高',
  max: '最高',
  provider: '使用服务商默认',
} satisfies Record<ScriptReasoning, string>;
const manualReasoning: ScriptReasoning[] = ['off', 'low', 'high', 'max'];
const defaultReasoning: ScriptReasoning[] = ['auto', 'provider'];

const detail = ref<PlatformSettings>();
const saving = ref(false);
const form = reactive({
  targetBaseUrl: '', runTimeoutMinutes: 10, showBrowser: true,
  username: '', password: '',
  baseUrl: '', name: '', apiKey: '',
  temperature: '' as number | string,
  maxOutputTokens: '' as number | string,
  scriptReasoning: 'auto' as ScriptReasoning,
  scriptTimeoutSeconds: 120,
});
const supportsManualReasoning = computed(() => {
  const model = form.name.trim();
  if (model !== 'deepseek-flash' && model !== 'deepseek-v4-pro') return false;
  try {
    const url = new URL(form.baseUrl.trim());
    return url.origin === 'https://api.deepseek.com' && ['/', '/v1', '/v1/'].includes(url.pathname) &&
      !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
});
const reasoningOptions = computed(() =>
  supportsManualReasoning.value ? ['auto', ...manualReasoning, 'provider'] as const : defaultReasoning,
);
const unsupportedReasoning = computed(() => !supportsManualReasoning.value && manualReasoning.includes(form.scriptReasoning));

function populate(settings: PlatformSettings): void {
  detail.value = settings;
  form.targetBaseUrl = settings.targetBaseUrl;
  form.runTimeoutMinutes = settings.runTimeoutMinutes;
  form.showBrowser = settings.showBrowser ?? true;
  form.username = settings.targetLogin.username;
  form.password = settings.targetLogin.password;
  form.baseUrl = settings.model.baseUrl;
  form.name = settings.model.name;
  form.apiKey = settings.model.apiKey;
  form.temperature = settings.model.temperature ?? '';
  form.maxOutputTokens = settings.model.maxOutputTokens ?? '';
  form.scriptReasoning = settings.model.scriptReasoning ?? 'auto';
  form.scriptTimeoutSeconds = settings.model.scriptTimeoutSeconds ?? 120;
}

async function save(): Promise<void> {
  if (saving.value || unsupportedReasoning.value) return;
  saving.value = true;
  try {
    populate(await updateSettings({
      targetBaseUrl: form.targetBaseUrl,
      runTimeoutMinutes: form.runTimeoutMinutes,
      showBrowser: form.showBrowser,
      targetLogin: { username: form.username, password: form.password },
      model: {
        baseUrl: form.baseUrl,
        name: form.name,
        ...(detail.value?.model.apiKeyFromEnvironment && !form.apiKey.trim() ? {} : { apiKey: form.apiKey }),
        temperature: form.temperature === '' ? null : Number(form.temperature),
        maxOutputTokens: form.maxOutputTokens === '' ? null : Number(form.maxOutputTokens),
        scriptReasoning: form.scriptReasoning,
        scriptTimeoutSeconds: form.scriptTimeoutSeconds,
      },
    }));
    toast.success('设置已保存');
  } catch {
    // The request helper displays the server's validation error.
  } finally {
    saving.value = false;
  }
}

onMounted(async () => populate(await getSettings()));
</script>

<template>
  <form v-if="detail" class="flex max-w-3xl flex-col gap-4" autocomplete="off" @submit.prevent="save">
    <Card>
      <CardHeader>
        <CardTitle>测试环境</CardTitle>
        <CardDescription>测试脚本通过此地址访问业务系统。</CardDescription>
      </CardHeader>
      <CardContent>
        <FieldGroup>
          <Field>
            <FieldLabel for="target-url">测试站点</FieldLabel>
            <Input id="target-url" v-model="form.targetBaseUrl" type="url" required />
            <FieldDescription>内置 Hook 示例使用 API 服务自身的地址。</FieldDescription>
          </Field>
          <Field>
            <FieldLabel for="run-timeout">运行超时（分钟）</FieldLabel>
            <Input id="run-timeout" v-model.number="form.runTimeoutMinutes" type="number" min="1" max="120" required />
          </Field>
          <Field>
            <FieldLabel for="show-browser" class="w-fit">
              <input id="show-browser" v-model="form.showBrowser" type="checkbox" class="size-4 accent-primary" aria-describedby="show-browser-help" />
              执行时显示浏览器
            </FieldLabel>
            <FieldDescription id="show-browser-help">取消勾选后，测试在后台运行，可避免浏览器窗口弹出。失败截图和日志仍可在运行详情查看。</FieldDescription>
          </Field>
          <FieldGroup class="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel for="target-username">测试账号</FieldLabel>
              <Input id="target-username" v-model="form.username" type="text" spellcheck="false" />
            </Field>
            <Field>
              <FieldLabel for="target-password">测试密码</FieldLabel>
              <Input id="target-password" v-model="form.password" type="text" spellcheck="false" />
            </Field>
          </FieldGroup>
          <FieldDescription>用例要求使用设置中的测试账号登录时，Runner 会填入这里保存的账号和密码。</FieldDescription>
        </FieldGroup>
      </CardContent>
    </Card>
    <Card>
      <CardHeader>
        <div class="flex items-center justify-between gap-2">
          <CardTitle>AI 模型</CardTitle>
          <Badge :variant="detail.model.configured ? 'default' : 'secondary'">{{ detail.model.configured ? '已配置' : '待配置' }}</Badge>
        </div>
        <CardDescription>生成计划和脚本、探索及失败修复使用 OpenAI 兼容接口。</CardDescription>
      </CardHeader>
      <CardContent>
        <FieldGroup>
          <Field>
            <FieldLabel for="model-base">接口基地址</FieldLabel>
            <Input id="model-base" v-model="form.baseUrl" type="url" placeholder="https://provider.example/v1" />
          </Field>
          <Field>
            <FieldLabel for="model-name">模型名称</FieldLabel>
            <Input id="model-name" v-model="form.name" />
          </Field>
          <Field>
            <FieldLabel for="model-api-key">API Key</FieldLabel>
            <Input
              id="model-api-key"
              v-model="form.apiKey"
              type="text"
              spellcheck="false"
              :placeholder="detail.model.apiKeyFromEnvironment ? '当前使用 .env 中的 Key，填写可覆盖' : '请输入 API Key'"
            />
          </Field>
          <FieldGroup class="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel for="model-temperature">Temperature</FieldLabel>
              <Input id="model-temperature" v-model.number="form.temperature" type="number" min="0" max="2" step="any" placeholder="默认" />
            </Field>
            <Field>
              <FieldLabel for="model-output-tokens">最大输出 Token</FieldLabel>
              <Input id="model-output-tokens" v-model.number="form.maxOutputTokens" type="number" min="1" step="1" placeholder="默认" />
            </Field>
          </FieldGroup>
          <FieldDescription>可选参数留空时使用默认值。设置保存后立即生效。</FieldDescription>
          <Field :data-invalid="unsupportedReasoning || undefined">
            <FieldLabel for="model-script-reasoning">脚本生成推理档位</FieldLabel>
            <Select v-model="form.scriptReasoning" :disabled="saving">
              <SelectTrigger
                id="model-script-reasoning"
                class="w-full min-w-0"
                :aria-invalid="unsupportedReasoning || undefined"
                :aria-describedby="unsupportedReasoning ? 'model-script-reasoning-help model-script-reasoning-error' : 'model-script-reasoning-help'"
              >
                <SelectValue>{{ reasoningLabels[form.scriptReasoning] }}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="mode in reasoningOptions" :key="mode" :value="mode">
                  {{ reasoningLabels[mode] }}
                </SelectItem>
              </SelectContent>
            </Select>
            <FieldDescription id="model-script-reasoning-help">
              仅用于 AI 生成脚本。支持的 DeepSeek 官方模型在「自动」档开启高档推理，其他模型沿用服务商默认。
            </FieldDescription>
            <FieldError v-if="unsupportedReasoning" id="model-script-reasoning-error">
              当前接口或模型不支持所选档位，请切换到「自动」或「使用服务商默认」后保存。
            </FieldError>
          </Field>
          <Field>
            <FieldLabel for="model-script-timeout">脚本生成超时（秒）</FieldLabel>
            <Input
              id="model-script-timeout"
              v-model.number="form.scriptTimeoutSeconds"
              type="number"
              min="30"
              max="300"
              step="1"
              required
              aria-describedby="model-script-timeout-help"
            />
            <FieldDescription id="model-script-timeout-help">等待模型生成脚本的时间上限，默认 120 秒。测试执行时间由上方的「运行超时」设置。</FieldDescription>
          </Field>
        </FieldGroup>
      </CardContent>
    </Card>
    <div><Button type="submit" :disabled="saving || unsupportedReasoning">{{ saving ? '保存中…' : '保存设置' }}</Button></div>
  </form>
</template>
