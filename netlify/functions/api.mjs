/**
 * The one server endpoint (/api). Replaces google.script.run.
 * GET  /api?config        -> public Supabase settings for the sign-in screen
 * POST /api {fn, args}    -> runs one server function as the signed-in user
 */
import { createClient } from '@supabase/supabase-js';
import { makeApi, UserError } from '../../lib/core.mjs';
import { supabaseDb, supabaseFiles } from '../../lib/supabase-adapters.mjs';

const env = (k, d = '') => (process.env[k] || d).trim();
const SUPABASE_URL = env('SUPABASE_URL');
const ANON_KEY = env('SUPABASE_ANON_KEY');
const SERVICE_KEY = env('SUPABASE_SERVICE_ROLE_KEY');
const BUCKET = env('STORAGE_BUCKET', 'lab-files');
const ALLOWED_DOMAINS = env('ALLOWED_EMAIL_DOMAINS').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
const ALLOWED_EMAILS = env('ALLOWED_EMAILS').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
const CALLABLE = new Set(['getState', 'createEntry', 'saveEntry', 'submitEntry', 'signEntry', 'reopenEntry',
  'createRequest', 'receiveSample', 'saveSample', 'approveSample', 'issueReport', 'uploadFile', 'getImage', 'fileUrl']);

const json = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
});

function allowed(email) {
  if (!ALLOWED_DOMAINS.length && !ALLOWED_EMAILS.length) return true;
  return ALLOWED_EMAILS.includes(email) || ALLOWED_DOMAINS.includes(email.split('@')[1]);
}

export default async (req) => {
  if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY) {
    return json(500, { error: 'The app is not set up yet. Add the Supabase settings in Netlify (see README).' });
  }
  const url = new URL(req.url);
  if (req.method === 'GET' && url.searchParams.has('config')) {
    return json(200, { supabaseUrl: SUPABASE_URL, anonKey: ANON_KEY });
  }
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed.' });

  const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

  // Who is calling? The browser sends its Supabase sign-in token; we verify it with Supabase.
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return json(401, { error: 'Sign in to use this app.' });
  const { data: auth, error: authErr } = await sb.auth.getUser(token);
  const email = auth && auth.user && auth.user.email ? auth.user.email.toLowerCase() : '';
  if (authErr || !email) return json(401, { error: 'Your sign-in has expired. Sign in again.' });
  if (!allowed(email)) return json(403, { error: `${email} does not have access to the lab app. Ask the administrator.` });

  let body;
  try { body = await req.json(); } catch { return json(400, { error: 'Bad request.' }); }
  const fn = body && body.fn, args = Array.isArray(body && body.args) ? body.args : [];
  if (!CALLABLE.has(fn)) return json(400, { error: 'Unknown action.' });

  const api = makeApi({
    db: supabaseDb(sb), files: supabaseFiles(sb, BUCKET), user: { email },
    config: { bucket: BUCKET, enforceIndependentReview: env('ENFORCE_INDEPENDENT_REVIEW') === 'true' }
  });
  try {
    return json(200, { result: await api[fn](...args) });
  } catch (e) {
    if (e instanceof UserError || e instanceof SyntaxError) return json(400, { error: e.message });
    console.error(fn, e);
    return json(500, { error: 'Something went wrong on the server. Try again; if it keeps happening, tell the administrator.' });
  }
};

export const config = { path: '/api' };
