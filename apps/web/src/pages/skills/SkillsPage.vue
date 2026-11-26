<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { FilePlus, FileText, Folder, FolderPlus, Library, Search, Trash2 } from '@lucide/vue';
import { toast } from 'vue-sonner';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import {
  createSkillDir,
  createSkillFile,
  deleteSkillFile,
  getSkills,
  messageOf,
  readSkillFile,
  saveSkillFile,
} from '@/api/client';
import { fromNow } from '@/utils/format';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import type { SkillDto } from '@autotest/shared';

const loading = ref(true);
const listError = ref('');
const skills = ref<SkillDto[]>([]);
const activePath = ref('');
const content = ref('');
const original = ref('');
const saving = ref(false);
const preview = ref(false);
const search = ref('');

// 弹窗状态：新建文件 / 新建 Skill / 未保存切换 / 删除
const newFileDlg = ref({ open: false, value: '' });
const newSkillDlg = ref({ open: false, value: '', error: '' });
const creatingSkill = ref(false);
const unsavedSwitchPath = ref<string | null>(null);
const deleteConfirm = ref(false);

const dirty = computed(() => content.value !== original.value);

const filteredSkills = computed(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return skills.value;
  return skills.value
    .map((s) => ({ ...s, files: s.files.filter((f) => f.path.toLowerCase().includes(q)) }))
    .filter((s) => s.files.length || `${s.dir} ${s.name}`.toLowerCase().includes(q));
});

const activeSkill = computed(() => skills.value.find((s) => activePath.value.startsWith(`${s.dir}/`)));

const previewHtml = computed(() => DOMPurify.sanitize(marked.parse(content.value, { async: false })));

async function loadSkills(keepActive = true): Promise<void> {
  loading.value = true;
  listError.value = '';
  try {
    skills.value = await getSkills();
  } catch (error) {
    listError.value = messageOf(error);
    return;
  } finally {
    loading.value = false;
  }
  if (!keepActive || !activePath.value) {
    const first = skills.value[0]?.files.find((f) => f.path.endsWith('SKILL.md'));
    if (first) await open(first.path, true);
  }
}

async function open(path: string, force = false): Promise<void> {
  if (!force && dirty.value) {
    unsavedSwitchPath.value = path;
    return;
  }
  try {
    const file = await readSkillFile(path);
    activePath.value = path;
    content.value = file.content;
    original.value = file.content;
  } catch {
    // 请求失败时 API 客户端会显示错误，保留当前编辑内容。
  }
}

async function save(): Promise<void> {
  if (!activePath.value) return;
  saving.value = true;
  try {
    await saveSkillFile(activePath.value, content.value);
    original.value = content.value;
    toast.success(`已保存 ${activePath.value}`);
    await loadSkills();
  } finally {
    saving.value = false;
  }
}

async function continueSwitch(): Promise<void> {
  const path = unsavedSwitchPath.value;
  unsavedSwitchPath.value = null;
  if (path) await open(path, true);
}

// ---- 新建文件 ----
function promptNewFile(): void {
  const dir = activeSkill.value?.dir ?? skills.value[0]?.dir;
  if (!dir) {
    toast.warning('请先创建一个 Skill 目录');
    return;
  }
  newFileDlg.value = { open: true, value: `${dir}/references/note.md` };
}

async function confirmNewFile(): Promise<void> {
  const value = newFileDlg.value.value.trim();
  if (!/^[^\\/]+(\/[^\\/]+)*\.(md|txt|json|ya?ml)$/.test(value)) {
    toast.error('路径需为 相对路径 + 合法扩展名（.md/.txt/.json/.yaml/.yml）');
    return;
  }
  newFileDlg.value.open = false;
  await createSkillFile(value, '');
  await loadSkills(false);
  await open(value, true);
}

// ---- 新建 Skill ----
async function confirmNewSkill(): Promise<void> {
  if (creatingSkill.value) return;

  const value = newSkillDlg.value.value.trim();
  if (!value) {
    newSkillDlg.value.error = '请输入目录名。';
    return;
  }

  newSkillDlg.value.error = '';
  creatingSkill.value = true;
  try {
    await createSkillDir(value);
    newSkillDlg.value.open = false;
  } catch (error) {
    newSkillDlg.value.error = `创建失败：${messageOf(error)}`;
    return;
  } finally {
    creatingSkill.value = false;
  }

  toast.success(`已创建 Skill：${value}`);
  await loadSkills();
  await open(`${value}/SKILL.md`, true);
}

// ---- 删除 ----
async function doDelete(): Promise<void> {
  deleteConfirm.value = false;
  if (!activePath.value) return;
  await deleteSkillFile(activePath.value);
  toast.success('已删除');
  activePath.value = '';
  content.value = '';
  original.value = '';
  await loadSkills(false);
}

function onKeydown(e: KeyboardEvent): void {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    if (dirty.value) void save();
  }
}

onMounted(() => {
  void loadSkills(false);
  window.addEventListener('keydown', onKeydown);
});
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));
</script>

<template>
  <div class="grid grid-cols-1 items-start gap-4 lg:grid-cols-[300px_1fr]">
    <!-- 左：文件树 -->
    <Card class="py-4">
      <CardContent class="flex flex-col gap-2.5 px-3.5">
        <div class="flex items-center justify-between">
          <span class="text-[15px] font-semibold">业务 Skill 库</span>
          <div class="flex gap-0.5">
            <Button variant="ghost" size="icon-sm" title="新建 Skill 目录" @click="newSkillDlg = { open: true, value: '', error: '' }">
              <FolderPlus />
            </Button>
            <Button variant="ghost" size="icon-sm" title="新建文件" @click="promptNewFile">
              <FilePlus />
            </Button>
          </div>
        </div>

        <Button v-if="!dirty" as-child variant="outline" size="sm">
          <RouterLink :to="{ path: '/preparations', query: { view: 'edit' } }">维护前置准备规则</RouterLink>
        </Button>
        <div class="relative">
          <Search class="absolute left-2.5 top-1/2 size-3 -translate-y-1/2 text-muted-foreground/70" />
          <Input v-model="search" placeholder="搜索文件…" class="h-7 pl-7 text-xs" />
        </div>

        <div class="max-h-[calc(100vh-260px)] overflow-y-auto">
          <div v-if="listError" role="alert" class="space-y-2 px-2 py-3 text-center text-xs">
            <p class="font-medium">Skill 列表加载失败</p>
            <p class="break-words text-muted-foreground">{{ listError }}</p>
            <Button variant="outline" size="sm" @click="loadSkills()">重试</Button>
          </div>
          <div v-if="loading && !skills.length" class="flex justify-center py-10">
            <Spinner class="size-5 text-muted-foreground" />
          </div>
          <div v-for="skill in filteredSkills" :key="skill.dir" class="mb-2">
            <div class="flex items-center gap-1.5 px-1.5 pb-0.5 pt-2">
              <Folder class="size-3.5 text-muted-foreground/70" />
              <span class="flex-1 truncate text-[13px] font-semibold">{{ skill.name }}</span>
              <span class="rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground">{{ skill.files.length }}</span>
            </div>
            <div v-if="skill.description" class="line-clamp-2 px-1.5 pb-1 pl-7 text-[11px] leading-snug text-muted-foreground/80">
              {{ skill.description }}
            </div>
            <button
              v-for="f in skill.files"
              :key="f.path"
              class="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 pl-7 text-left text-xs transition-colors hover:bg-muted"
              :class="{ 'bg-muted font-medium': activePath === f.path }"
              @click="open(f.path)"
            >
              <FileText class="size-3.5 shrink-0 text-muted-foreground/70" />
              <span class="flex-1 truncate font-mono">{{ f.path.replace(`${skill.dir}/`, '') }}</span>
              <span class="shrink-0 text-[10px] text-muted-foreground/70">{{ fromNow(f.updatedAt) }}</span>
            </button>
          </div>
          <div v-if="!loading && !listError && !filteredSkills.length" class="py-6 text-center text-xs text-muted-foreground">
            {{ skills.length ? '没有匹配的文件' : '尚未创建 Skill' }}
          </div>
        </div>
      </CardContent>
    </Card>

    <!-- 右：编辑器 -->
    <Card class="h-fit">
      <CardContent class="flex flex-col gap-3 pt-6">
        <div class="flex flex-wrap items-center justify-between gap-2.5">
          <div class="flex min-w-0 items-center gap-1.5 text-[13px] font-medium">
            <FileText class="size-3.5 shrink-0 text-muted-foreground/70" />
            <span class="truncate font-mono text-xs">{{ activePath || '选择左侧文件开始编辑' }}</span>
            <span v-if="dirty" class="rounded-md border border-amber-200 bg-amber-50 px-1.5 py-px text-[11px] text-amber-600">未保存</span>
          </div>
          <div class="flex items-center gap-2">
            <div class="flex overflow-hidden rounded-lg border">
              <button
                class="px-3 py-1.5 text-xs transition-colors"
                :class="preview ? 'text-muted-foreground hover:bg-muted' : 'bg-primary text-primary-foreground'"
                @click="preview = false"
              >
                编辑
              </button>
              <button
                class="border-l px-3 py-1.5 text-xs transition-colors"
                :class="preview ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'"
                @click="preview = true"
              >
                预览
              </button>
            </div>
            <Button variant="outline" size="sm" class="text-red-600 hover:text-red-700" :disabled="!activePath" @click="deleteConfirm = true">
              <Trash2 data-icon="inline-start" />
              删除
            </Button>
            <Button size="sm" :disabled="!activePath || !dirty || saving" @click="save">
              {{ saving ? '保存中…' : '保存 Ctrl+S' }}
            </Button>
          </div>
        </div>

        <template v-if="activePath">
          <textarea v-show="!preview" v-model="content" class="at-code-textarea flex-1" spellcheck="false" />
          <!-- eslint-disable-next-line vue/no-v-html — 内容经 DOMPurify 消毒 -->
          <div v-if="preview" class="at-md-preview" v-html="previewHtml" />
        </template>
        <div v-else class="flex flex-col items-center gap-2 py-20 text-muted-foreground">
          <Library class="size-7 text-muted-foreground/40" />
          <p class="text-[13px]">选择左侧文件，或新建 Skill / 文件开始编辑</p>
        </div>

        <p class="text-[11.5px] leading-relaxed text-muted-foreground/80">
          SKILL.md 必须包含 frontmatter（name 与 description），保存时自动校验；修改会即时影响 AI 生成计划时引用的知识。
        </p>
      </CardContent>
    </Card>

    <!-- 新建文件 -->
    <Dialog v-model:open="newFileDlg.open">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>新建文件</DialogTitle>
          <DialogDescription>相对 skills/ 目录的路径，支持 .md / .txt / .json / .yaml</DialogDescription>
        </DialogHeader>
        <div class="flex flex-col gap-1.5">
          <Label for="new-file-path">文件路径</Label>
          <Input id="new-file-path" v-model="newFileDlg.value" placeholder="my-skill/references/rules.md" class="font-mono text-xs" />
        </div>
        <DialogFooter>
          <Button variant="outline" @click="newFileDlg.open = false">取消</Button>
          <Button @click="confirmNewFile">创建</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- 新建 Skill -->
    <Dialog :open="newSkillDlg.open" @update:open="(open) => { if (!creatingSkill) newSkillDlg.open = open }">
      <DialogContent class="sm:max-w-md" :show-close-button="!creatingSkill">
        <DialogHeader>
          <DialogTitle>新建 Skill</DialogTitle>
          <DialogDescription>目录名支持汉字、小写英文字母和数字，词之间可用短横线连接。创建后会生成 SKILL.md 模板。</DialogDescription>
        </DialogHeader>
        <form class="flex flex-col gap-4" @submit.prevent="confirmNewSkill">
          <FieldGroup>
            <Field class="gap-1.5" :data-invalid="!!newSkillDlg.error">
              <FieldLabel for="new-skill-dir">目录名</FieldLabel>
              <Input
                id="new-skill-dir"
                v-model="newSkillDlg.value"
                placeholder="例如：地图准备"
                class="font-mono text-xs"
                :readonly="creatingSkill"
                :aria-invalid="!!newSkillDlg.error"
                :aria-describedby="newSkillDlg.error ? 'new-skill-error' : undefined"
                @update:model-value="newSkillDlg.error = ''"
              />
              <FieldError v-if="newSkillDlg.error" id="new-skill-error">{{ newSkillDlg.error }}</FieldError>
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button type="button" variant="outline" :disabled="creatingSkill" @click="newSkillDlg.open = false">取消</Button>
            <Button type="submit" :disabled="creatingSkill">
              {{ creatingSkill ? '创建中…' : '创建' }}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>

    <!-- 未保存切换确认 -->
    <ConfirmDialog
      :open="!!unsavedSwitchPath"
      title="未保存的修改"
      description="当前文件未保存，切换将丢弃修改。继续？"
      confirm-text="丢弃并切换"
      danger
      @update:open="(v: boolean) => { if (!v) unsavedSwitchPath = null; }"
      @confirm="continueSwitch"
    />

    <!-- 删除确认 -->
    <ConfirmDialog
      v-model:open="deleteConfirm"
      title="删除文件"
      :description="`确认删除 ${activePath}？该操作不可恢复。`"
      confirm-text="删除"
      danger
      @confirm="doDelete"
    />
  </div>
</template>
