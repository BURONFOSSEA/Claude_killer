// Serveur local : sert le site (web/) et l'API (/api) avec une base PGlite (Postgres sans installation).
// Usage : npm run dev   →   http://localhost:3000
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { pgliteAdapter } from '../supabase/functions/_shared/adapters.js';
import { boot } from '../supabase/functions/_shared/boot.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webDir = path.join(root, 'web');
const port = Number(process.env.PORT) || 3000;
const dataDir = process.env.PGLITE_DIR || path.join(root, 'data', 'pglite');
await fs.mkdir(dataDir, { recursive: true });

const handle = await boot({ db: pgliteAdapter(new PGlite(dataDir)), env: process.env });

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const headers = { ...req.headers, 'x-forwarded-for': req.socket.remoteAddress };
      const request = new Request(url, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) });
      const response = await handle(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      return res.end(Buffer.from(await response.arrayBuffer()));
    }
    // Fichiers statiques
    let file = path.normalize(path.join(webDir, decodeURIComponent(url.pathname)));
    if (!file.startsWith(webDir)) return res.writeHead(403).end();
    try {
      if ((await fs.stat(file)).isDirectory()) file = path.join(file, 'index.html');
      const data = await fs.readFile(file);
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Introuvable');
    }
  })
  .listen(port, () => console.log(`Killer (local) : http://localhost:${port}`));
