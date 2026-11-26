import type { E2EConfig } from 'e2e';
import runtime from './e2e.runtime.config.ts';

const identity = process.env.AUTOTEST_TARGET_IDENTITY;

export default {
  ...runtime,
  timeout: Number(process.env.AUTOTEST_EXPLORE_TIMEOUT_MS ?? 120_000),
  ...(identity ? {
    targets: runtime.targets.map((target) => ({ ...target, app: { ...target.app, identity } })),
  } : {}),
} satisfies E2EConfig;
