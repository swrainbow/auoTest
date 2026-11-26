import { createServer, request, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

export function needsTargetProxy(target: string): boolean {
  const { protocol, hostname } = new URL(target);
  return protocol === 'http:' && hostname !== 'localhost' && !hostname.endsWith('.localhost')
    && hostname !== '[::1]' && !/^127(?:\.\d{1,3}){3}$/.test(hostname);
}

function forwardHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const hopHeaders = [
    'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te',
    'trailer', 'transfer-encoding', 'upgrade', ...(headers.connection ?? '').split(','),
  ];
  const forwarded = { ...headers };
  for (const header of hopHeaders) delete forwarded[header.trim().toLowerCase()];
  return forwarded;
}

export async function startTargetProxy(target: string) {
  const upstream = new URL(target);
  if (upstream.protocol !== 'http:' || upstream.username || upstream.password || upstream.search || upstream.hash) {
    throw new Error('测试站点的 HTTP 地址无效');
  }

  const server = createServer((req, res) => {
    const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
    const origin = `http://${host}`;
    const address = req.url?.startsWith('/') ? URL.parse(req.url, origin) : null;
    if (address?.origin !== origin || req.headers.host !== host
      || (req.headers.origin && req.headers.origin !== origin)
      || (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site']))) {
      res.writeHead(403).end();
      return;
    }

    const headers = forwardHeaders(req.headers);
    headers.host = upstream.host;
    if (headers.origin) headers.origin = upstream.origin;
    const referer = headers.referer && URL.parse(headers.referer);
    if (referer && referer.origin === origin) headers.referer = upstream.origin + referer.pathname + referer.search;

    const forward = request(upstream, {
      path: address.pathname + address.search, method: req.method, headers,
    }, (response) => {
      const outgoing = forwardHeaders(response.headers);
      if (outgoing.location) {
        const redirect = URL.parse(outgoing.location, upstream.origin + address.pathname + address.search);
        if (redirect?.origin === upstream.origin) outgoing.location = origin + redirect.pathname + redirect.search + redirect.hash;
      }
      if (outgoing['set-cookie']) {
        outgoing['set-cookie'] = outgoing['set-cookie'].map((cookie) => cookie.replace(/;\s*Domain=[^;]*/gi, ''));
      }
      response.once('error', (error) => res.destroy(error));
      res.writeHead(response.statusCode ?? 502, outgoing);
      response.pipe(res);
    });
    forward.setTimeout(30_000, () => forward.destroy(new Error('测试站点响应超时')));
    forward.once('error', () => {
      if (res.headersSent) res.destroy();
      else res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }).end('无法连接配置的测试站点');
    });
    res.once('close', () => {
      if (!res.writableFinished) forward.destroy();
    });
    req.pipe(forward);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}${upstream.pathname}`,
    close() {
      server.close();
      server.closeAllConnections();
    },
  };
}
