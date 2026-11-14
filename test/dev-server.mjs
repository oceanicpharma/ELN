// Local stand-in for Netlify + Supabase, for testing the page in a browser. Not used in production.
import http from 'node:http'; import fs from 'node:fs';
import { makeApi, UserError } from '../lib/core.mjs';
import { memoryDb, memoryFiles } from './memory-adapters.mjs';
const db = memoryDb(), files = memoryFiles();
// Swap the real Supabase library for a local stub so the page works offline (any email, password "pw").
const page = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
  .replace(/<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase[^"]*"><\/script>/, '<script src="/__stub.js"></script>');
const stub = fs.readFileSync(new URL('./stub-supabase.js', import.meta.url));
const body = (req) => new Promise((ok) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => ok(Buffer.concat(c))); });
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'); const send = (s, o) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (u.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(page); }
  if (u.pathname === '/__stub.js') { res.writeHead(200, { 'content-type': 'application/javascript' }); return res.end(stub); }
  if (u.pathname === '/api' && req.method === 'GET') return send(200, { supabaseUrl: 'http://stub', anonKey: 'anon' });
  if (u.pathname === '/__upload') { files.store.set(u.searchParams.get('path'), await body(req)); return send(200, {}); }
  if (u.pathname.startsWith('/__files/')) { const f = files.store.get(decodeURIComponent(u.pathname.slice(9))); res.writeHead(f ? 200 : 404, { 'content-type': 'application/pdf' }); return res.end(f || ''); }
  if (u.pathname === '/api') {
    const email = (req.headers.authorization || '').replace('Bearer test:', '');
    if (!email.includes('@')) return send(401, { error: 'Sign in to use this app.' });
    const { fn, args } = JSON.parse(await body(req));
    const api = makeApi({ db, files, user: { email }, config: { bucket: 'lab-files', enforceIndependentReview: false } });
    try { send(200, { result: await api[fn](...args) }); } catch (e) { send(e instanceof UserError ? 400 : 500, { error: e.message }); if (!(e instanceof UserError)) console.error(e); }
    return;
  }
  res.writeHead(404); res.end();
}).listen(8899, () => console.log('dev server on 8899'));
