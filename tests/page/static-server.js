// 仅用于页面测试的最小静态文件服务器（生产中可直接用任意静态托管/本地打开）。
// 不参与任何文件传输：文件始终只在两个浏览器的 WebRTC DataChannel 之间流动。
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = normalize(join(fileURLToPath(new URL('.', import.meta.url)), '..', '..'));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

export function startServer(port = 0) {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      try {
        const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
        const rel = urlPath === '/' ? '/index.html' : urlPath;
        const filePath = normalize(join(ROOT, rel));
        if (!filePath.startsWith(ROOT)) {
          res.writeHead(403).end('forbidden');
          return;
        }
        const body = await readFile(filePath);
        res.writeHead(200, { 'content-type': MIME[extname(filePath)] ?? 'application/octet-stream' });
        res.end(body);
      } catch {
        res.writeHead(404).end('not found');
      }
    });
    server.listen(port, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

// 直接运行：node tests/page/static-server.js [port]
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2]) || 8080;
  const { url } = await startServer(port);
  console.log(`静态服务器：${url}（Ctrl+C 退出）`);
}
