/**
 * 预览页的本地静态服务。
 *
 * 为什么不能直接双击 HTML：预览页用的是 `<script type="module">`，而浏览器在
 * `file://` 下会以 **opaque origin** 加载模块脚本 —— Chrome/Edge 直接按 CORS 拒掉，
 * 表现是"页面壳子出来了但卡片一直没有"（正好又是本项目最讨厌的那类静默失败）。
 * 挂到 http://127.0.0.1 上就一切正常。
 *
 * 零依赖，只用 `node:`；Ctrl+C 结束。
 *
 * 用法：`npm run preview`（或 `node docs/preview/serve.mjs [端口]`）
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const PAGE = '/docs/preview/turn-tail-card.html';
const PORT = Number(process.argv[2] ?? 8787);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const target = url.pathname === '/' ? PAGE : url.pathname;
  const file = path.join(ROOT, path.normalize(target).replace(/^([/\\])+/, ''));

  // 只服务本仓库内的文件
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(file, (error, body) => {
    if (error) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end(`找不到 ${target}`);
      return;
    }
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(body);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}${PAGE}`;
  console.log(`预览页已就绪：${url}`);
  console.log('（Ctrl+C 结束；卡片加载的是本仓库里的 lib/client.js，改完刷新页面即可）');
  const opener =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]]
    : ['xdg-open', [url]];
  try {
    spawn(opener[0], opener[1], { stdio: 'ignore', detached: true }).unref();
  } catch {
    console.log(`（没能自动打开浏览器，手动访问上面的地址即可）`);
  }
});
