// In-memory stand-ins for Supabase, used only by the tests.
import fs from 'node:fs'; import path from 'node:path';
export function memoryDb() {
  const t = { entries: new Map(), requests: new Map(), samples: new Map() }, audit = [];
  const uniq = { requests: 'sample_id', samples: 'ana_entry' };
  const c = (o) => JSON.parse(JSON.stringify(o));
  return {
    audit_rows: audit,
    async list(n) { return [...t[n].values()].map(c); },
    async get(n, id) { return t[n].has(id) ? c(t[n].get(id)) : null; },
    async insert(n, row) {
      const u = uniq[n];
      if (t[n].has(row.id) || (u && [...t[n].values()].some((r) => r[u] === row[u]))) { const e = new Error('dup'); e.conflict = true; throw e; }
      t[n].set(row.id, c(row));
    },
    async update(n, id, v, row) { const r = t[n].get(id); if (!r || r.version !== v) return false; t[n].set(id, c(row)); return true; },
    async remove(n, id) { t[n].delete(id); },
    async audit(e) { audit.push(c(e)); }
  };
}
export function memoryFiles(dir) {
  const store = new Map();
  return {
    store,
    async signedUpload(p) { return { token: 'tok:' + p }; },
    async signedUrl(p) { if (!store.has(p)) throw new Error('missing ' + p); return '/__files/' + encodeURIComponent(p); },
    async copy(a, b) { if (!store.has(a)) throw new Error('missing ' + a); store.set(b, store.get(a)); },
    async put(p, bytes) { store.set(p, bytes); if (dir) { const f = path.join(dir, p); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, bytes); } }
  };
}
