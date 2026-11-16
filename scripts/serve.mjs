import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname, sep } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const port = Number(process.env.PORT || 5173);
const host = process.env.HOST || '127.0.0.1';
const types = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8' };
const server = createServer(async (req, res) => {
  try {
    if (!['GET','HEAD'].includes(req.method)) { res.writeHead(405); return res.end('Method not allowed'); }
    const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const relative = path === '/' ? 'index.html' : path.slice(1);
    const file = resolve(root, relative);
    const permitted = relative === 'index.html' || file.startsWith(resolve(root, 'src') + sep);
    if (!permitted || !types[extname(file)]) { res.writeHead(404); return res.end('Not found'); }
    const bytes = await readFile(file);
    res.writeHead(200, {'Content-Type': types[extname(file)], 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff'});
    res.end(req.method === 'HEAD' ? undefined : bytes);
  } catch { res.writeHead(404); res.end('Not found'); }
});
server.listen(port, host, () => console.log(`LabReview demo: http://${host}:${server.address().port}`));
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
