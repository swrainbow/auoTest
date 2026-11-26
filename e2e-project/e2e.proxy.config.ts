import type { E2EConfig } from 'e2e';
import runtime from './e2e.runtime.config.ts';

const identity = process.env.AUTOTEST_TARGET_IDENTITY;
if (!identity) throw new Error('缺少测试站点的回放标识');

export default {
  ...runtime,
  targets: runtime.targets.map((target) => ({ ...target, app: { ...target.app, identity } })),
} satisfies E2EConfig;
