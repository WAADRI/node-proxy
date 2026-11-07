// Bench/smoke HTTP target: /<bytes> -> n bytes pattern; /echo -> POST echo.
import http from 'node:http';
const port = Number(process.env.TARGET_PORT || 9999);
const PATTERN = 'node-proxy-go-bench-';
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/echo') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { res.writeHead(200); res.end(Buffer.concat(chunks)); });
    return;
  }
  const n = Math.max(0, parseInt(url.pathname.slice(1), 10) || 0);
  if (n > 0) {
    const body = Buffer.alloc(n);
    for (let i = 0; i < n; i++) body[i] = PATTERN.charCodeAt(i % PATTERN.length);
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(body);
    return;
  }
  res.writeHead(200);
  res.end('target-ok');
}).listen(port, '127.0.0.1', () => console.log(`target on 127.0.0.1:${port}`));
