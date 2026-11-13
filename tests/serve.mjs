// Static file server for local testing of web/ (what GitHub Pages will serve). No dependencies.
// Usage: node tools/sim/tests/serve.mjs [port]   then open http://localhost:8351
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web');
const port = +process.argv[2] || 8351;
// optional, local testing only: --firmware <path> serves that file at /__local/firmware
const fwArg = process.argv.indexOf('--firmware');
const firmware = fwArg > 0 ? path.resolve(process.argv[fwArg + 1]) : null;
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon' };
http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/__local/firmware' && firmware) { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); fs.createReadStream(firmware).pipe(res); return; }
  if (p.endsWith('/')) p += 'index.html';
  const f = path.join(root, p);
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(f).pipe(res);
}).listen(port, () => console.log(`serving ${root} at http://localhost:${port}`));
