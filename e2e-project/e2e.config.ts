import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { web } from '@e2e-dev/web';
import type { E2EConfig } from 'e2e';

const mode = process.env.AUTOTEST_RUN_MODE ?? 'explore';
function denyInference(): never {
  throw new Error('严格回放禁止模型推理。请探索录制后重试。');
}
// e2e 0.23 requires a model instance when acquiring the agent fixture.
// The replay instance has no credentials or network implementation.
const replayModel = {
  specificationVersion: 'v4' as const,
  provider: 'autotest.replay',
  modelId: 'offline',
  supportedUrls: {},
  async doGenerate() { return denyInference(); },
  async doStream() { return denyInference(); },
};
const model = mode === 'explore' && process.env.MODEL_BASE_URL && process.env.MODEL_API_KEY && process.env.MODEL_NAME
  ? createOpenAICompatible({
      name: 'platform-model',
      baseURL: process.env.MODEL_BASE_URL,
      apiKey: process.env.MODEL_API_KEY,
    }).chatModel(process.env.MODEL_NAME)
  : undefined;

export default {
  agents: { default: mode === 'explore' ? (model ? { model } : {}) : { model: replayModel } },
  targets: [{ engine: web(), app: { url: process.env.TARGET_BASE_URL ?? 'http://127.0.0.1:3211' } }],
  workers: 1,
  retries: 0,
  actionTimeout: 10000,
  assertionTimeout: 5000,
  cache: { mode: mode === 'explore' ? 'read-write' : 'read-only' },
} satisfies E2EConfig;
