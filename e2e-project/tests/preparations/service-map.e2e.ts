import { rename, writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { test } from '@e2e-dev/web';
import { credentials } from 'e2e';
import { runPreparation } from '../../support/service-map-preparation.ts';
import { servicePreparationActions } from '../../support/tusk-service-preflight.ts';

test('独立准备服务与地图基础数据', async ({ app, browser, screen }) => {
  const input = process.env.AUTOTEST_PREPARATION_INPUT;
  const destination = process.env.AUTOTEST_PREPARATION_RESULT;
  test.skip(!input && !destination, '仅从准备流程入口运行');
  if (!input || !destination || !isAbsolute(destination)) throw new Error('缺少准备流程输入或结果文件路径');
  const actions = servicePreparationActions({ browser, screen, open: path => app.open(path), credentials: () => credentials.user('target') });
  await runPreparation(JSON.parse(input), actions, async report => {
    const temporary = `${destination}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(report), 'utf8');
    await rename(temporary, destination);
  });
});
