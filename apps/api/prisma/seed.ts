import { PrismaClient } from '@prisma/client';
import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { compileWorkflow, digest, type Workflow } from '../src/planner/workflow';

const prisma = new PrismaClient();
const steps = [
  { order: 1, action: '打开演示任务并选中 move-002', expected: '显示目标移动节点的配置面板' },
  { order: 2, action: '在创建时添加校验 Hook，将货物状态和锁定状态设为不校验', expected: '创建时校验 Hook 的两个参数都是不校验' },
  { order: 3, action: '保存任务', expected: '提示保存成功' },
  { order: 4, action: '重新打开任务并选中 move-002', expected: '生命周期、Hook 类型及两个参数保存成功' },
];
const checks = [
  { type: 'text', testId: 'hook-summary', value: '创建时 · 校验 Hook · 货物状态 不校验 · 锁定状态 不校验' },
  { type: 'value', testId: 'cargo-state', value: 'none' },
  { type: 'value', testId: 'lock-state', value: 'none' },
] as const;
const open = [{ type: 'open', path: '/demo/task.html' }, { type: 'click', testId: 'move-002' }] as const;
const workflow: Workflow = [
  { operations: [...open], checks: [{ type: 'visible', testId: 'node-panel' }] },
  {
    operations: [
      { type: 'click', testId: 'add-validation' },
      { type: 'select', testId: 'cargo-state', value: 'none' },
      { type: 'select', testId: 'lock-state', value: 'none' },
    ],
    checks: [...checks],
  },
  { operations: [{ type: 'click', testId: 'save-task' }], checks: [{ type: 'text', testId: 'save-status', value: '保存成功' }] },
  { operations: [...open], checks: [...checks] },
];

async function main() {
  const code = 'TC-DEMO';
  const name = '演示 · 移动节点校验 Hook';
  const skill = 'hook-configuration-testing';
  const scriptPath = 'tests/generated/demo/v1.e2e.ts';
  const full = path.resolve('..', '..', 'e2e-project', scriptPath);
  const content = compileWorkflow(code + ' ' + name, steps, workflow);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content, { flag: 'wx' }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error;
  });
  const data = {
    code, name, scriptPath, description: '用内置任务页面验证 Hook 配置和刷新后的持久化。',
    skill, taskId: 'task-e2e-001', module: '任务配置',
    steps: JSON.stringify(steps), status: 'trial-pending',
    versions: {
      create: {
        version: 1, skill, scriptPath, scriptHash: digest(content), steps: JSON.stringify(steps),
        workflow: JSON.stringify(workflow), changeNote: '内置可执行示例',
      },
    },
  };
  await prisma.testCase.upsert({ where: { code }, create: data, update: {} });
  console.log('内置 Hook 演示用例已就绪');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
