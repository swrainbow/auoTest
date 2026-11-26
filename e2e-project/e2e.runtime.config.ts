import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { E2EConfig } from 'e2e';
import base from './e2e.config.ts';

const { AUTOTEST_RUN_MODE, MODEL_BASE_URL, MODEL_API_KEY, MODEL_NAME } = process.env;
const username = process.env.AUTOTEST_TARGET_USERNAME;
const password = process.env.AUTOTEST_TARGET_PASSWORD;
const temperature = process.env.MODEL_TEMPERATURE;
const maxOutputTokens = process.env.MODEL_MAX_OUTPUT_TOKENS;

const model = AUTOTEST_RUN_MODE === 'explore' && MODEL_BASE_URL && MODEL_API_KEY && MODEL_NAME
  ? createOpenAICompatible({
      name: 'platform-model',
      baseURL: MODEL_BASE_URL,
      apiKey: MODEL_API_KEY,
      transformRequestBody(body) {
        if (temperature !== undefined) body.temperature = Number(temperature);
        if (maxOutputTokens !== undefined) {
          const cap = Number(maxOutputTokens);
          body.max_tokens = typeof body.max_tokens === 'number' ? Math.min(body.max_tokens, cap) : cap;
        }
        return body;
      },
    }).chatModel(MODEL_NAME)
  : undefined;

export default {
  ...base,
  ...(model ? { agents: { default: { model } } } : {}),
  ...(username && password ? { credentials: { target: { username, password } } } : {}),
} satisfies E2EConfig;
