import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, 'fixture');
const PORT_A = 8731;      // served as http://127.0.0.1:8731
const PORT_B = 8732;      // served as http://localhost:8732  (different origin)

function mk(port, xorigin) {
  return http.createServer((req, res) => {
    const url = new URL(req.url, `http://x`);
    const file = path.join(ROOT, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
    if (!file.startsWith(ROOT) || !fs.existsSync(file)) { res.writeHead(404); return res.end('nope'); }
    let body = fs.readFileSync(file, 'utf8').replaceAll('__XORIGIN__', xorigin);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(body);
  }).listen(port);
}
mk(PORT_A, `http://localhost:${PORT_B}`);
mk(PORT_B, `http://127.0.0.1:${PORT_A}`);
console.log(`serving http://127.0.0.1:${PORT_A}/ and http://localhost:${PORT_B}/`);
