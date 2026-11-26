const assert = require('node:assert/strict');
const { test } = require('node:test');
const { PlannerService } = require('../src/planner/planner.service');

test('fresh protected map entry gets one conditional login before lookup without sending credentials to the model', async () => {
  const targetLogin = { username: 'fixture-user', password: 'fixture-password' };
  const planner = new PlannerService({ loadSkillDocs: async () => [] }, {
    get: async () => ({ targetBaseUrl: 'http://example.invalid', targetLogin }),
    getModelConfig: async () => ({}),
  });
  const lookup = { type: 'ensure-map-in-menu', frame: 'iframe#hyjalIframe', mapName: 'demo', existingOnly: true };
  planner.chat = async (_prompt, request) => {
    assert.ok(!JSON.stringify(request).includes(targetLogin.password));
    return JSON.stringify({ workflow: [{
      operations: [{ type: 'open', path: '/tkmap/mapDraw' }, lookup],
      checks: [{ type: 'url', path: '/tkmap/mapDraw' }],
    }] });
  };
  const input = { name: '查看现有地图', taskId: '', description: '', skill: '地图准备', steps: [{ order: 1, action: '打开地图', expected: '地图存在' }] };
  const operations = async (extra) => (await planner.generateWorkflow({ ...input, ...extra })).workflow[0].operations.map(op => op.type);
  assert.deepEqual(await operations({}), ['open', 'ensure-map-session', 'ensure-map-in-menu']);
  assert.deepEqual(await operations({ prerequisite: { skill: 'tusk-service-preflight', mapName: 'demo' } }), ['open', 'ensure-map-in-menu']);
});

test('script generation retries malformed official Flash output within the same deadline', async () => {
  const planner = new PlannerService({ loadSkillDocs: async () => [] }, {
    get: async () => ({ targetBaseUrl: 'http://example.invalid' }),
    getModelConfig: async () => ({ baseUrl: 'https://api.deepseek.com', name: 'deepseek-flash', scriptReasoning: 'off' }),
  });
  const signals = [];
  const text = '检查显示的代码\n```json\n{"field":true}\n```';
  const workflow = [{ operations: [{ type: 'open', path: '/' }], checks: [{ type: 'text', testId: 'example', value: text }] }];
  planner.chat = async (_system, _input, purpose, signal) => {
    assert.equal(purpose, 'script');
    signals.push(signal);
    return signals.length === 1 ? '{"workflow":[]}' : JSON.stringify({ workflow });
  };
  const result = await planner.generateWorkflow({
    name: '示例', description: '', skill: 'task-config', taskId: '',
    steps: [{ order: 1, action: '打开页面', expected: '显示代码' }],
  });
  assert.deepEqual(result.workflow, workflow);
  assert.equal(signals.length, 2);
  assert.equal(signals[0], signals[1]);
});

test('Flash script batches are merged by business step order', async () => {
  const planner = new PlannerService({ loadSkillDocs: async () => [] }, {
    get: async () => ({ targetBaseUrl: 'http://example.invalid' }),
    getModelConfig: async () => ({ baseUrl: 'https://api.deepseek.com', name: 'deepseek-flash', scriptReasoning: 'off' }),
  });
  const steps = Array.from({ length: 8 }, (_, i) => ({ order: i + 1, action: `步骤 ${i + 1}`, expected: `结果 ${i + 1}` }));
  const calls = [];
  planner.chat = async (prompt, input) => {
    const [, first, last] = prompt.match(/第 (\d+) 至 (\d+) 步/);
    calls.push([Number(first), Number(last)]);
    assert.deepEqual(input.steps, steps);
    return JSON.stringify({ workflow: input.steps.slice(Number(first) - 1, Number(last)).map(({ order }) => ({
      operations: order === 1 ? [{ type: 'open', path: '/' }] : [],
      checks: [{ type: 'text', testId: 'result', value: String(order) }],
    })) });
  };
  const result = await planner.generateWorkflow({ name: '示例', description: '', skill: 'task-config', taskId: '', steps });
  assert.deepEqual(calls, [[1, 3], [4, 6], [7, 8]]);
  assert.deepEqual(result.workflow.map(({ checks }) => Number(checks[0].value)), steps.map(({ order }) => order));
});

test('a repair response may change only the failed step’s operations', async () => {
  const planner = new PlannerService({ loadSkillDocs: async () => [] }, {});
  const original = [
    { operations: [{ type: 'open', path: '/task/taskLego' }], checks: [{ type: 'url', path: '/task/taskLego' }] },
    {
      operations: [{ type: 'click', testId: 'confirm-filter' }, { type: 'wait-hidden', testId: 'name-filter' }],
      checks: [{ type: 'count', testId: 'matching-row', value: 0 }],
    },
    { operations: [{ type: 'click', testId: 'add-task' }], checks: [{ type: 'visible', testId: 'editor' }] },
  ];
  const operations = [{ type: 'filter-task-config', value: 'legoTask2' }];
  planner.chat = async () => JSON.stringify({ operations, checks: [{ type: 'count', testId: 'matching-row', value: 1 }] });
  const input = {
    name: '新增任务配置', description: '', skill: 'task-config', taskId: '',
    steps: original.map((_, i) => ({ order: i + 1, action: `操作 ${i + 1}`, expected: `预期 ${i + 1}` })),
  };
  const repaired = await planner.repairWorkflow(input, original, 'http://example.invalid', {
    failure: '筛选框仍可见', failedStep: 2, failedCall: { kind: 'operation', type: 'wait-hidden', index: 1 },
    screen: '', logTail: '', priorFailures: [],
  });
  assert.equal(repaired.repairKind, 'operation');
  assert.deepEqual(repaired.workflow, [original[0], { operations, checks: original[1].checks }, original[2]]);
});

const originalSelector = '.vue-flow__edge';
const mainFlowSelector = '.vue-flow:has(.vue-flow__node-llm) .vue-flow__edge';
const locator = (value) => ({ kind: 'css', value });

function countRepair({ expected = 1, observedCount = 2, docs = [mainFlowSelector], verified = [], selector = mainFlowSelector } = {}) {
  const skill = 'task-config';
  const planner = new PlannerService({
    loadSkillDocs: async (id) => id === skill ? [
      { path: 'task-config/references/editor-workflow.md', content: docs.map((doc) => `核对主流程连线时使用 \`${doc}\`。`).join('\n') },
      { path: 'task-config/references/verified-repairs/fixture.json', content: JSON.stringify({ verificationRunId: 42, steps: verified }) },
    ] : [],
  }, {});
  const original = [{
    operations: [{ type: 'open', path: '/task/taskLego' }],
    checks: [{ type: 'url', path: '/task/taskLego' }, { type: 'count', locator: locator(originalSelector), value: expected }],
  }];
  const input = {
    name: '回读任务配置', description: '', skill, taskId: '',
    steps: [{ order: 1, action: '查看主流程与阶段配置', expected: '主流程有一条连线' }],
  };
  const evidence = {
    failure: '主流程和阶段抽屉各显示一条连线', failedStep: 1,
    failedCall: { kind: 'check', type: 'count', index: 1 }, observedCount,
    screen: '', logTail: '', priorFailures: [],
  };
  planner.chat = async () => JSON.stringify({
    locator: locator(selector), diagnosis: '只核对主流程画布',
    value: 2, operations: [{ type: 'click', testId: 'save' }],
  });
  return { original, repair: () => planner.repairWorkflow(input, original, 'http://example.invalid', evidence) };
}

test('manual count repair uses the known main canvas selector and preserves the expected count', async () => {
  const { original, repair } = countRepair();
  const result = await repair();
  assert.equal(result.repairKind, 'check-locator');
  assert.deepEqual(result.workflow, [{
    operations: original[0].operations,
    checks: [original[0].checks[0], { ...original[0].checks[1], locator: locator(mainFlowSelector) }],
  }]);
});

test('count repair rejects an undocumented scope and documented selectors that omit or limit the subject by position', async () => {
  await assert.rejects(countRepair({ selector: '.other .vue-flow__edge' }).repair(), /未选用业务 Skill/);
  for (const selector of ['.vue-flow__edge:first-child', '.other, .vue-flow__edge', '.vue-flow__edge .other']) {
    await assert.rejects(countRepair({ docs: [selector], selector }).repair(), /未记录可核实/);
  }
});

test('count repair cannot hide duplicate records from a zero-count check or repair a missing match', async () => {
  await assert.rejects(countRepair({ expected: 0 }).repair(), /不适合收窄定位/);
  await assert.rejects(countRepair({ observedCount: 0 }).repair(), /不适合收窄定位/);
});

test('verified count selector recipes require the same page and original CSS', async () => {
  const checks = [{ type: 'count', from: originalSelector, to: mainFlowSelector }];
  const eligible = countRepair({ docs: [], verified: [{ page: '/task/taskLego', checks }] });
  assert.equal((await eligible.repair()).repairKind, 'check-locator');
  await assert.rejects(countRepair({ docs: [], verified: [{ page: '/task/other', checks }] }).repair(), /未记录可核实/);
  await assert.rejects(countRepair({
    docs: [], verified: [{ page: '/task/taskLego', checks: [{ ...checks[0], from: '.other' }] }],
  }).repair(), /未记录可核实/);
});

const containerFrom = '.el-drawer:visible .el-form-item:has(.el-form-item__label:text-is("容器类型"))';
const containerTo = '.el-drawer:visible:has(.el-drawer__title:text-is("全局配置")) :text-is("容器类型")';
const containerRule = {
  page: '/task/taskLego', type: 'visible', from: containerFrom, to: containerTo, container: '全局配置', label: '容器类型',
};
const containerScreen = [
  '#root document',
  ' #n1 dialog "任务配置"',
  '  #n2 dialog "全局配置"',
  '   #n3 heading "全局配置"',
  '   #n4 text="容器类型"',
  '   #n5 combobox',
].join('\n');

function visibleRepair({ rules = [containerRule], screen = containerScreen, observedCount = 0, skill = 'task-config' } = {}) {
  const planner = new PlannerService({
    loadSkillDocs: async () => [{
      path: 'task-config/references/locator-repairs.json', content: JSON.stringify({ rules }),
    }],
  }, {});
  const original = [{
    operations: [{ type: 'open', path: '/task/taskLego' }],
    checks: [
      { type: 'visible', locator: locator(containerFrom) },
      { type: 'visible', testId: 'robot-groups' },
    ],
  }, {
    operations: [{ type: 'click', testId: 'close' }],
    checks: [{ type: 'visible', testId: 'canvas' }],
  }];
  const input = {
    name: '回读全局配置', description: '', skill, taskId: '',
    steps: [{ order: 1, action: '查看全局配置', expected: '显示容器类型' }, { order: 2, action: '关闭', expected: '显示画布' }],
  };
  const evidence = {
    failure: '没有匹配的元素', failedStep: 1, failedCall: { kind: 'check', type: 'visible', index: 0 },
    observedCount, screen, logTail: '', priorFailures: [],
  };
  planner.chat = async () => { throw new Error('a verified visibility rule should not call the model'); };
  return {
    original,
    repair: () => planner.repairWorkflow(input, original, 'http://example.invalid', evidence),
    preflight: () => planner.findVisibleLocatorRepair(skill, 'http://example.invalid', {
      workflow: original, failedStep: 1, checkIndex: 0, observedCount, screen,
    }),
  };
}

test('a verified visibility rule changes only the failed selector without asking the model', async () => {
  const { original, repair, preflight } = visibleRepair();
  assert.deepEqual(await preflight(), containerRule);
  const result = await repair();
  assert.equal(result.repairKind, 'check-locator');
  assert.match(result.diagnosis, /容器类型/);
  assert.deepEqual(result.workflow, [{
    operations: original[0].operations,
    checks: [{ type: 'visible', locator: locator(containerTo) }, original[0].checks[1]],
  }, original[1]]);
});

test('visibility repair rejects a missing label, labels outside the expected drawer, or ambiguous rules', async () => {
  for (const fixture of [
    visibleRepair({ screen: containerScreen.replace('容器类型', '货物种类') }),
    visibleRepair({ screen: containerScreen.replace('   #n4', '  #n4') }),
    visibleRepair({ rules: [containerRule, { ...containerRule, to: '.other-locator' }] }),
    visibleRepair({ rules: [{ ...containerRule, page: '/task/other' }] }),
    visibleRepair({ rules: [{ ...containerRule, from: '.another-old-selector' }] }),
    visibleRepair({ observedCount: 1 }),
    visibleRepair({ skill: 'other-skill' }),
  ]) {
    assert.equal(await fixture.preflight(), undefined);
    await assert.rejects(fixture.repair(), /未确认同一字段/);
  }
});

test('generation applies a verified visible locator mapping only for the same page and step skill', async () => {
  const planner = new PlannerService({
    loadSkillDocs: async (skill) => skill === 'task-config' ? [{
      path: 'task-config/references/locator-repairs.json',
      content: JSON.stringify({ rules: [containerRule] }),
    }] : [],
  }, {
    get: async () => ({ targetBaseUrl: 'http://example.invalid' }),
    getModelConfig: async () => ({ baseUrl: 'https://example.invalid', name: 'fixture' }),
  });
  const oldCheck = { type: 'visible', locator: locator(containerFrom) };
  const countCheck = { type: 'count', locator: locator(containerFrom), value: 1 };
  const source = [
    { operations: [{ type: 'open', path: '/task/taskLego' }], checks: [oldCheck, countCheck] },
    { operations: [], checks: [oldCheck] },
    { operations: [{ type: 'open', path: '/task/other' }], checks: [oldCheck] },
  ];
  planner.chat = async () => JSON.stringify({ workflow: source });
  const { workflow } = await planner.generateWorkflow({
    name: '回读全局配置', description: '', skill: 'task-config', taskId: '',
    steps: source.map((_, i) => ({
      order: i + 1, action: '查看表单', expected: '显示容器类型', ...(i === 1 ? { skill: 'other-form' } : {}),
    })),
  });
  assert.deepEqual(workflow, [
    { ...source[0], checks: [{ ...oldCheck, locator: locator(containerTo) }, countCheck] },
    ...source.slice(1),
  ]);
});
