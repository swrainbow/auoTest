const assert = require('node:assert/strict');
const { test } = require('node:test');
const { PlannerService } = require('../src/planner/planner.service');

const openStep = { operations: [{ type: 'open', path: '/index' }], checks: [{ type: 'url', path: '/index' }] };
const remainingStep = { operations: [], checks: [{ type: 'url', path: '/index' }] };
const steps = Array.from({ length: 7 }, (_, index) => ({
  order: index + 1, action: `操作 ${index + 1}`, expected: `预期 ${index + 1}`,
}));

function fixture(t, options = {}, reply = (workflow) => ({ workflow })) {
  const model = {
    configured: true, baseUrl: 'https://api.deepseek.com/v1', name: 'deepseek-flash',
    apiKey: 'fixture-key', maxOutputTokens: 2048, temperature: 0.2, scriptReasoning: 'auto', scriptTimeoutSeconds: 120,
    ...options,
  };
  let modelReads = 0;
  const planner = new PlannerService({ loadSkillDocs: async () => [] }, {
    get: async () => ({ targetBaseUrl: 'http://example.invalid' }),
    getModelConfig: async () => { modelReads++; return model; },
  });
  const metrics = [];
  planner.logger = { log: (message) => metrics.push(JSON.parse(message)), warn: () => {} };
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(String(url), model.baseUrl + '/chat/completions');
    const body = JSON.parse(init.body);
    calls.push({ body, signal: init.signal });
    init.signal.throwIfAborted();
    const range = /中第 (\d+) 至 (\d+) 步/.exec(body.messages[0].content);
    const patch = /只纠正输入 steps 中第 (\d+) 步/.exec(body.messages[0].content);
    const from = Number(patch?.[1] ?? range?.[1] ?? 1);
    const length = patch ? 1 : range ? Number(range[2]) - from + 1 : steps.length;
    const workflow = Array.from({ length }, (_, index) => index === 0 && from === 1 ? openStep : remainingStep);
    const value = reply(workflow, from, body.messages[0].content);
    const content = typeof value === 'string' ? value : JSON.stringify(value);
    return Response.json({ choices: [{ message: { content }, finish_reason: 'stop' }] });
  });
  return {
    calls, metrics, modelReads: () => modelReads,
    generate: (caseSteps = steps) => planner.generateWorkflow({ name: '脚本', description: '', skill: 'task-config', taskId: '', steps: caseSteps }),
    diagnose: () => planner.diagnoseRun({ code: 'TC', name: '脚本', steps, run: {}, logTail: '' }),
  };
}

test('explicit off uses parallel JSON generation on official Flash', async (t) => {
  const { calls, generate, modelReads } = fixture(t, { scriptReasoning: 'off' });
  const { workflow } = await generate();
  assert.equal(workflow.length, 7);
  assert.equal(modelReads(), 1);
  assert.equal(calls.length, 3);
  assert.equal(new Set(calls.map(({ signal }) => signal)).size, 1);
  for (const { body } of calls) {
    assert.deepEqual(body.thinking, { type: 'disabled' });
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.equal(body.reasoning_effort, undefined);
  }
});

test('automatic mode uses DeepSeek default thinking effort on both official models', async (t) => {
  for (const name of ['deepseek-flash', 'deepseek-v4-pro']) {
    await t.test(name, async (child) => {
      const { calls, generate } = fixture(child, { name });
      await generate();
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0].body.thinking, { type: 'enabled' });
      assert.equal(calls[0].body.reasoning_effort, 'high');
      assert.deepEqual(calls[0].body.response_format, { type: 'json_object' });
    });
  }
});

test('low, high and max request their exact effort without fast batching', async (t) => {
  for (const effort of ['low', 'high', 'max']) {
    await t.test(effort, async (child) => {
      const { calls, generate, metrics } = fixture(child, { scriptReasoning: effort });
      await generate();
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0].body.thinking, { type: 'enabled' });
      assert.equal(calls[0].body.reasoning_effort, effort);
      assert.equal(calls[0].body.temperature, 0.2);
      assert.deepEqual(calls[0].body.response_format, { type: 'json_object' });
      assert.equal(metrics[0].reasoningEffort, effort);
    });
  }
});

test('explicit off for Pro is unbatched and does not affect diagnosis', async (t) => {
  const { calls, generate, diagnose } = fixture(t, { name: 'deepseek-v4-pro', scriptReasoning: 'off' });
  await generate();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body.thinking, { type: 'disabled' });
  assert.deepEqual(calls[0].body.response_format, { type: 'json_object' });
  await diagnose();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.thinking, undefined);
  assert.equal(calls[1].body.reasoning_effort, undefined);
  assert.equal(calls[1].body.response_format, undefined);
});

test('provider mode and unsupported endpoints leave options to the provider', async (t) => {
  for (const [name, options] of [
    ['provider default', { scriptReasoning: 'provider' }],
    ['automatic compatible provider', { baseUrl: 'https://example.invalid/v1' }],
    ['compatible provider', { baseUrl: 'https://example.invalid/v1', scriptReasoning: 'max' }],
  ]) {
    await t.test(name, async (child) => {
      const { calls, generate } = fixture(child, options);
      await generate();
      assert.equal(calls.length, 1);
      assert.equal(calls[0].body.thinking, undefined);
      assert.equal(calls[0].body.reasoning_effort, undefined);
      assert.equal(calls[0].body.response_format, undefined);
    });
  }
});

test('the configured script deadline is shared by a generation and does not change diagnosis', async (t) => {
  const { generate, diagnose } = fixture(t, { scriptTimeoutSeconds: 75 });
  const timeout = t.mock.method(AbortSignal, 'timeout', () =>
    AbortSignal.abort(new DOMException('Mock request timeout', 'TimeoutError')),
  );
  await assert.rejects(generate(), /模型在 75 秒内/);
  await assert.rejects(diagnose(), /模型在 120 秒内/);
  assert.deepEqual(timeout.mock.calls.map(({ arguments: args }) => args), [[75_000], [120_000]]);
});

test('thinking mode corrects an invalid operation once with the same request deadline', async (t) => {
  const { calls, generate } = fixture(t, {}, (workflow, from) => {
    if (from === 1) {
      workflow[2] = { ...remainingStep, operations: [{ type: 'fill-input' }] };
    } else {
      workflow[0] = { ...remainingStep, operations: [{ type: 'fill', testId: 'name', value: 'legoTask2' }] };
    }
    return { workflow };
  });
  const { workflow } = await generate();
  assert.deepEqual(workflow[2].operations, [{ type: 'fill', testId: 'name', value: 'legoTask2' }]);
  assert.deepEqual(workflow.filter((_, index) => index !== 2), [openStep, ...Array(5).fill(remainingStep)]);
  assert.equal(calls.length, 2);
  assert.match(calls[1].body.messages[0].content, /第 3 步：操作 1：未知测试动作「fill-input」/);
  assert.match(calls[1].body.messages[0].content, /记录和比较都必须放进 checks/);
  assert.deepEqual(JSON.parse(calls[1].body.messages[1].content).rejectedStep.operations, [{ type: 'fill-input' }]);
  assert.deepEqual(calls[1].body.thinking, { type: 'enabled' });
  assert.equal(calls[1].signal, calls[0].signal);
});

test('batched validation identifies the case step and still rejects an invalid retry', async (t) => {
  const { calls, generate } = fixture(t, { scriptReasoning: 'off' }, (workflow, from) => {
    if (from === 4) workflow[1] = { ...remainingStep, operations: [{ type: 'capture-text', testId: 'field' }] };
    if (from === 5) workflow[0] = { ...remainingStep, operations: [{ type: 'capture-text', testId: 'field' }] };
    return { workflow };
  });
  await assert.rejects(generate(), /第 5 步：操作 1：未知测试动作「capture-text」/);
  assert.equal(calls.filter(({ body }) => body.messages[0].content.includes('只纠正输入 steps 中第 5 步')).length, 1);
  assert.equal(calls.length, 4);
});

test('independent invalid Agent steps are corrected once each within the original deadline', async (t) => {
  const bad = { operations: [{ type: 'act', instruction: '选择地图' }, { type: 'click', testId: 'save' }], checks: remainingStep.checks };
  const { calls, generate } = fixture(t, {}, (workflow, from) => {
    if (from === 1) {
      workflow[1] = bad;
      workflow[2] = bad;
    } else {
      workflow[0] = { ...bad, operations: [{ type: 'act', instruction: '选中目标地图并保存' }] };
    }
    return { workflow };
  });
  const { workflow } = await generate();
  assert.deepEqual(calls.map(call => call.signal), Array(3).fill(calls[0].signal));
  assert.match(calls[1].body.messages[0].content, /第 2 步：每步最多一个 Agent/);
  assert.match(calls[2].body.messages[0].content, /第 3 步：每步最多一个 Agent/);
  assert.equal(workflow[1].operations.length, 1);
  assert.equal(workflow[2].operations.length, 1);
  assert.deepEqual(workflow.slice(3), Array(4).fill(remainingStep));
});

test('a model response describing missing business context is reported without retry', async (t) => {
  const message = '第 3 步：缺少该字段的实际页面定位';
  const { calls, generate } = fixture(t, {}, () => ({ error: message }));
  await assert.rejects(generate(), { message });
  assert.equal(calls.length, 1);
});

test('generation corrects Hook type lookups before saving a stage graph workflow', async (t) => {
  const properties = { node: '取货', stage: '离开后', hook: '回调', key: 'afterLeaveHooks' };
  const legacy = { type: 'count', locator: { kind: 'css', value: '.el-drawer:visible .vue-flow__node:has-text("回调")' }, value: 1 };
  const { calls, generate } = fixture(t, {}, (workflow, from, prompt) => {
    const corrected = prompt.includes('上次生成未通过结构检查');
    workflow[2] = { operations: [], checks: [corrected ? { type: 'capture-hook-graph', ...properties } : legacy] };
    workflow[5] = { operations: [], checks: [corrected ? { type: 'matches-hook-graph', ...properties } : legacy] };
    return { workflow };
  });
  const { workflow } = await generate(steps.map((step, i) => i === 5 ? { ...step, skill: 'hook-configuration-testing' } : step));
  assert.equal(calls.length, 2);
  assert.match(calls[1].body.messages[0].content, /第 3、6 步按 Hook 类型文字定位执行图节点/);
  assert.equal(workflow[2].checks[0].type, 'capture-hook-graph');
  assert.equal(workflow[5].checks[0].type, 'matches-hook-graph');
});

test('a whitespace-only JSON-mode response gets one repair with the original deadline', async t => {
  let count = 0;
  const { calls, generate } = fixture(t, { scriptReasoning: 'high' }, workflow => ++count === 1 ? '   ' : { workflow });
  assert.equal((await generate()).workflow.length, steps.length);
  assert.equal(calls.length, 2);
  assert.match(calls[1].body.messages[0].content, /空白内容/);
  assert.equal(calls[0].signal, calls[1].signal);
  for (const call of calls) assert.deepEqual(call.body.response_format, { type: 'json_object' });
});

test('twice malformed JSON reports the failing script range and omits raw model text', async t => {
  const { calls, generate } = fixture(t, { scriptReasoning: 'high' }, () => 'fixture-private-incomplete{');
  await assert.rejects(generate(), { message: '脚本生成重试失败（第 1 至 7 步）：模型响应包含 JSON 语法错误' });
  assert.equal(calls.length, 2);
});

test('an invalid JSON root during a targeted repair identifies the rejected step', async t => {
  const { calls, generate } = fixture(t, {}, (workflow, _from, prompt) => {
    if (prompt.includes('只纠正输入 steps')) return '[]';
    workflow[2] = { ...remainingStep, operations: [{ type: 'fill-input' }] };
    return { workflow };
  });
  await assert.rejects(generate(), { message: '脚本生成重试失败（第 3 步）：模型响应的 JSON 根节点应为对象' });
  assert.equal(calls.length, 2);
});
