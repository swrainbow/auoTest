import 'reflect-metadata';
import { access } from 'node:fs/promises';
import * as path from 'node:path';
import * as express from 'express';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { PathsService } from './paths/paths.service';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const paths = app.get(PathsService);
  const webRoot = process.argv.includes('--serve-web') ? path.join(paths.root, 'apps', 'web', 'dist') : undefined;
  if (webRoot) {
    await access(path.join(webRoot, 'index.html')).catch(async () => {
      await app.close();
      throw new Error('缺少前端构建产物，请先在项目根目录执行 pnpm build');
    });
  }

  app.setGlobalPrefix('api');
  app.enableShutdownHooks();

  // 证据目录静态服务：/artifacts/run-<id>/...
  await paths.ensureArtifactsDir();
  app.use('/artifacts', express.static(paths.artifactsRoot, {
    setHeaders(response) {
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    },
  }));
  app.use('/demo', express.static(paths.root + '/demo'));
  if (webRoot) {
    app.use('/assets', express.static(path.join(webRoot, 'assets')));
    app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (req.method !== 'GET' || /^\/(?:api|artifacts|demo|assets)(?:\/|$)/.test(req.path) ||
          path.posix.extname(req.path) || !req.accepts('html')) return next();
      res.sendFile(path.join(webRoot, 'index.html'), { headers: { 'Cache-Control': 'no-cache' } });
    });
  }

  const config = app.get(ConfigService);
  const port = Number(config.get<number | string>('PORT', 3211));
  await app.listen(port, '127.0.0.1');
  console.log(`[api] listening on http://127.0.0.1:${port}`);
}

void bootstrap().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
