// Browser stand-in for supabase-js: password sign-in and signed uploads only.
window.supabase = { createClient() {
  let session = JSON.parse(localStorage.getItem('stub-session') || 'null'); const subs = [];
  const emit = (ev) => subs.forEach((f) => f(ev, session));
  return {
    auth: {
      async getSession() { return { data: { session } }; },
      onAuthStateChange(f) { subs.push(f); },
      async signInWithPassword({ email, password }) { if (password !== 'pw') return { error: { message: 'Invalid login credentials' } };
        session = { access_token: 'test:' + email }; localStorage.setItem('stub-session', JSON.stringify(session)); emit('SIGNED_IN'); return { error: null }; },
      async signOut() { session = null; localStorage.removeItem('stub-session'); emit('SIGNED_OUT'); },
      async signInWithOtp() { return { error: null }; }
    },
    storage: { from() { return { async uploadToSignedUrl(path, token, file) {
      const r = await fetch('/__upload?path=' + encodeURIComponent(path), { method: 'POST', body: file }); return { error: r.ok ? null : { message: 'fail' } }; } }; } }
  };
} };
