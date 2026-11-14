/** Connects the server logic to Supabase: Postgres tables for records, a private Storage bucket for files. */
export function supabaseDb(sb) {
  const check = (error) => { if (error) throw new Error('Database error: ' + error.message); };
  return {
    async list(table) {
      const out = [];
      for (let from = 0; ; from += 1000) {           // page past the 1000-row API cap
        const { data, error } = await sb.from(table).select('id, doc').order('id').range(from, from + 999);
        check(error);
        out.push(...data);
        if (data.length < 1000) return out;
      }
    },
    async get(table, id) {
      const { data, error } = await sb.from(table).select('id, doc').eq('id', id).maybeSingle();
      check(error);
      return data;
    },
    async insert(table, row) {
      const { error } = await sb.from(table).insert(row);
      if (error && error.code === '23505') { const e = new Error('duplicate'); e.conflict = true; throw e; }
      check(error);
    },
    async update(table, id, expectedVersion, row) {
      // Only succeeds if nobody saved in between: the version check and the write are one SQL statement.
      const { data, error } = await sb.from(table).update(row).eq('id', id).eq('version', expectedVersion).select('id');
      check(error);
      return data.length === 1;
    },
    async remove(table, id) {
      const { error } = await sb.from(table).delete().eq('id', id);
      check(error);
    },
    async audit(entry) {
      const { error } = await sb.from('audit_log').insert(entry);
      check(error);
    }
  };
}

export function supabaseFiles(sb, bucket) {
  const store = () => sb.storage.from(bucket);
  const check = (error) => { if (error) throw new Error('File storage error: ' + error.message); };
  return {
    async signedUpload(path) {
      const { data, error } = await store().createSignedUploadUrl(path);
      check(error);
      return { token: data.token };
    },
    async signedUrl(path) {
      const { data, error } = await store().createSignedUrl(path, 60 * 10);
      check(error);
      return data.signedUrl;
    },
    async copy(from, to) {
      const { error } = await store().copy(from, to);
      check(error);
    },
    async put(path, bytes, mime) {
      const { error } = await store().upload(path, bytes, { contentType: mime, upsert: false });
      check(error);
    }
  };
}
