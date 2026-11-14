/**
 * Oceanic Lab Workflow: server logic.
 * A line-for-line port of the Apps Script Code.gs. Google Sheets is replaced by
 * Postgres tables (via the `db` adapter) and Google Drive by object storage
 * (via the `files` adapter). Every rule from the original is kept: status locks,
 * version checks, required fields, independent review, ID formats and PDFs.
 *
 * This is an R&D tracking tool, not a validated ELN or LIMS.
 */
import { buildPdf, entryDoc, sheetDoc } from './pdf.mjs';

export const TEST_NAMES = { HPLC: 'HPLC assay', LCMS: 'LCMS', GCMS: 'GCMS', NMR: '1H NMR' };
const MAX_DOC = 900000;           // Postgres jsonb has no 50k cell limit; this just stops runaway records
const MAX_FILE_BYTES = 20 * 1024 * 1024;

export class UserError extends Error {}
const fail = (m) => { throw new UserError(m); };

/* ---------- helpers (unchanged behaviour) ---------- */
const nowIso = () => new Date().toISOString();
const text_ = (v, max) => String(v == null ? '' : v).slice(0, max || 2000);

export function nextId(prefix, ids) {
  const start = prefix + '-' + new Date().getFullYear() + '-';
  let max = 0;
  ids.forEach((id) => {
    if (String(id).indexOf(start) === 0) {
      const n = parseInt(String(id).slice(start.length, start.length + 4), 10);
      if (n > max) max = n;
    }
  });
  return start + ('000' + (max + 1)).slice(-4);
}

export function calc(e) {
  const rows = (e.reagents || []).map((r) => {
    const mass = parseFloat(r.mass), mw = parseFloat(r.mw);
    return mass >= 0 && mw > 0 ? mass / mw * 1000 : null;
  });
  const lim = rows[e.limiting || 0];
  const pm = parseFloat(e.productMw), act = parseFloat(e.actualYield);
  const theo = lim && pm > 0 ? lim * pm / 1000 : null;
  return { rows, lim, theo, pct: theo && act >= 0 ? act / theo * 100 : null };
}

const testDone = (t) => !!(t.result && t.outcome && t.outcome !== 'Pending');

export function sampleStatus(s) {
  if (s.reportIssued) return 'Report issued';
  if (s.approved) return 'Approved';
  const keys = Object.keys(s.tests || {});
  const done = keys.filter((k) => testDone(s.tests[k])).length;
  if (keys.length && done === keys.length) return 'Ready for review';
  return done ? 'In testing' : 'Registered';
}

const summaryOf = (table, doc) => table === 'entries' ? (doc.title || '') : [doc.product, doc.batch].filter(String).join(', ');
const yearOf = (start) => { const y = String(start || '').slice(0, 4); return /^\d{4}$/.test(y) ? y : String(new Date().getFullYear()); };
const safeSeg = (name) => String(name || 'file').replace(/[^\w.\-]+/g, '_').replace(/^\.+/, '').slice(0, 120) || 'file';
const validPath = (p) => typeof p === 'string' && /^LAB-(Working|Records)\/[\w.\-\/]+$/.test(p) && p.indexOf('..') < 0;

/**
 * db adapter:   list(table) -> rows; get(table,id) -> row|null;
 *               insert(table,row) (throws {conflict:true} on duplicate key);
 *               update(table,id,expectedVersion,row) -> boolean (false = someone else changed it);
 *               remove(table,id); audit(entry)
 *   row = { id, summary, status, version, updated_at, updated_by, doc, ...extra }
 * files adapter: signedUpload(path) -> {token}; signedUrl(path) -> url; copy(from,to); put(path,bytes,mime)
 */
export function makeApi({ db, files, user, config }) {
  const enforce = !!config.enforceIndependentReview;
  const me = { email: user.email.toLowerCase(), name: user.email.toLowerCase().split('@')[0] };

  const log = (doc, action) => {
    doc.history = (doc.history || []).concat([{ at: nowIso(), by: me.name, email: me.email, action }]);
  };
  const didBy = (doc, action, email) => (doc.history || []).some((h) => h.action === action && h.email === email);
  const requireOtherPerson = (doc, action) => {
    if (enforce && didBy(doc, action, me.email)) fail('A different person must do this step.');
  };

  const readAll = async (table) => {
    const out = {};
    (await db.list(table)).forEach((r) => { out[r.id] = r.doc; });
    return out;
  };
  const getDoc = async (table, id) => {
    const r = await db.get(table, id);
    if (!r) fail(id + ' was not found.');
    return r.doc;
  };

  const rowFor = (table, doc) => {
    if (JSON.stringify(doc).length > MAX_DOC) fail('This record is too large to save. Shorten the text or remove some rows.');
    const row = {
      id: doc.id, summary: summaryOf(table, doc),
      status: table === 'samples' ? sampleStatus(doc) : doc.status,
      version: doc.version, updated_at: nowIso(), updated_by: me.email, doc
    };
    if (table === 'samples') row.ana_entry = doc.anaEntry;
    if (table === 'requests') row.sample_id = doc.sampleId;
    return row;
  };
  const audit = (table, doc) => db.audit({
    collection: table, record_id: doc.id, version: doc.version,
    action: (doc.history && doc.history.length ? doc.history[doc.history.length - 1].action : ''),
    by_email: me.email, at: nowIso(), snapshot: doc
  });

  /** Update an existing record; fails if anyone saved it since `doc` was read. */
  const save = async (table, doc) => {
    const prev = Number(doc.version) || 0;
    doc.version = prev + 1;
    const ok = await db.update(table, doc.id, prev, rowFor(table, doc));
    if (!ok) fail('Someone else changed this record. Reload it and enter your change again.');
    await audit(table, doc);
    return doc;
  };
  /** Insert a new record; on an ID clash (two people at once) rebuild and retry. */
  const create = async (table, build) => {
    for (let attempt = 0; attempt < 6; attempt++) {
      const doc = await build();
      doc.version = 1;
      try {
        await db.insert(table, rowFor(table, doc));
        await audit(table, doc);
        return doc;
      } catch (e) {
        if (!e || !e.conflict) throw e;
      }
    }
    fail('The system is busy. Try again in a moment.');
  };
  const checkVersion = (cur, incoming) => {
    if (Number(incoming.version) !== Number(cur.version)) fail('Someone else changed this record. Reload it and enter your change again.');
  };

  const savePdf = async (path, docDef) => {
    const bytes = await buildPdf(docDef);
    await files.put(path, bytes, 'application/pdf');
    return path;
  };

  /* ---------- reading ---------- */
  async function getState() {
    const [entries, requests, samples] = await Promise.all([readAll('entries'), readAll('requests'), readAll('samples')]);
    return JSON.stringify({ me, independentReview: enforce, entries, requests, samples });
  }

  /* ---------- ELN entries ---------- */
  async function createEntry() {
    const doc = await create('entries', async () => {
      const ids = (await db.list('entries')).map((r) => r.id);
      const d = {
        id: nextId('CHEM', ids), title: '', project: '', chemist: me.name, start: '',
        objective: '', safety: '', drive: '',
        compounds: [{ name: '', role: '', smiles: '' }],
        reagents: [{ material: '', mw: '', mass: '', lot: '' }], limiting: 0,
        steps: [{ time: '', step: '', temp: '', obs: '' }],
        product: '', batch: '', productMw: '', actualYield: '', status: 'Draft', checks: [], history: []
      };
      log(d, 'Entry created');
      return d;
    });
    return JSON.stringify(doc);
  }

  const arr = (v) => Array.isArray(v) ? v : [];
  function mergeEntry(cur, d) {
    ['title', 'project', 'chemist', 'start', 'product', 'batch', 'productMw', 'actualYield', 'drive'].forEach((k) => { cur[k] = text_(d[k], 500); });
    cur.schemeFileId = d.schemeFileId && validPath(d.schemeFileId) ? d.schemeFileId : '';
    cur.objective = text_(d.objective);
    cur.safety = text_(d.safety);
    cur.compounds = arr(d.compounds).slice(0, 100).map((x) => ({ name: text_(x.name, 300), role: text_(x.role, 100), smiles: text_(x.smiles, 2000) }));
    cur.reagents = arr(d.reagents).slice(0, 100).map((x) => ({ material: text_(x.material, 300), mw: text_(x.mw, 30), mass: text_(x.mass, 30), lot: text_(x.lot, 100) }));
    cur.steps = arr(d.steps).slice(0, 300).map((x) => ({ time: text_(x.time, 50), step: text_(x.step, 2000), temp: text_(x.temp, 30), obs: text_(x.obs, 2000) }));
    cur.limiting = Number(d.limiting) || 0;
    cur.checks = arr(d.checks).slice(0, 4).map(Boolean);
  }

  async function saveEntry(json) {
    const d = JSON.parse(json), cur = await getDoc('entries', d.id);
    if (cur.status !== 'Draft') fail('This entry is locked. Reopen it to make changes.');
    checkVersion(cur, d);
    mergeEntry(cur, d);
    log(cur, 'Entry saved');
    return JSON.stringify(await save('entries', cur));
  }

  async function submitEntry(json) {
    const d = JSON.parse(json), cur = await getDoc('entries', d.id);
    if (cur.status !== 'Draft') fail('This entry has already been submitted.');
    checkVersion(cur, d);
    mergeEntry(cur, d);
    const missing = [];
    if (!cur.title) missing.push('title');
    if (!cur.chemist) missing.push('chemist');
    if (calc(cur).rows.filter((x) => x !== null).length === 0) missing.push('one reagent with MW and mass');
    if ([0, 1, 2, 3].some((i) => !cur.checks[i])) missing.push('all four checks');
    if (missing.length) fail('Add before submitting: ' + missing.join(', ') + '.');
    cur.status = 'Submitted';
    log(cur, 'Submitted for review');
    return JSON.stringify(await save('entries', cur));
  }

  async function signEntry(id) {
    const cur = await getDoc('entries', id);
    if (cur.status !== 'Submitted') fail('Only a submitted entry can be signed.');
    requireOtherPerson(cur, 'Submitted for review');
    cur.status = 'Signed';
    log(cur, 'Signed by reviewer');
    const path = ['LAB-Records', 'Chemistry', yearOf(cur.start), safeSeg(cur.id + '.pdf')].join('/');
    cur.pdfPath = path;
    const saved = await save('entries', cur);       // lock the record first, then write the PDF
    await savePdf(path, entryDoc(saved, calc(saved)));
    return JSON.stringify(saved);
  }

  async function reopenEntry(id, reason) {
    const cur = await getDoc('entries', id), why = text_(reason, 300).trim();
    if (cur.status !== 'Submitted') fail('Only a submitted entry can be reopened.');
    if (!why) fail('Add the reason for reopening.');
    cur.status = 'Draft';
    cur.checks = [];
    log(cur, 'Reopened: ' + why);
    return JSON.stringify(await save('entries', cur));
  }

  /* ---------- sample requests ---------- */
  async function createRequest(json) {
    const d = JSON.parse(json), entry = await getDoc('entries', d.entryId);
    if (entry.status === 'Draft') fail('Submit the ELN entry before requesting analysis.');
    const tests = arr(d.tests).filter((t) => TEST_NAMES[t]);
    if (!tests.length) fail('Choose at least one test.');
    if (!d.quantity) fail('Add the quantity.');
    const doc = await create('requests', async () => {
      const all = await readAll('requests');
      const count = Object.keys(all).filter((k) => all[k].entryId === entry.id).length;
      const r = {
        id: nextId('SR', Object.keys(all)), entryId: entry.id,
        sampleId: entry.id + '-S' + ('0' + (count + 1)).slice(-2),
        product: entry.product || entry.title, batch: entry.batch || '',
        quantity: text_(d.quantity, 100), storage: text_(d.storage, 200), tests,
        status: 'Requested', history: []
      };
      log(r, 'Request submitted');
      return r;
    });
    return JSON.stringify(doc);
  }

  /* ---------- LIMS samples ---------- */
  async function receiveSample(requestId, condition) {
    const r = await getDoc('requests', requestId);
    if (r.status !== 'Requested') fail('This sample has already been received.');
    const s = await create('samples', async () => {
      const anaIds = (await db.list('samples')).map((x) => x.doc.anaEntry);
      const tests = {};
      r.tests.forEach((t) => { tests[t] = { method: '', instrument: '', result: '', limit: '', outcome: 'Pending', link: '', fileId: '', fileName: '' }; });
      const doc = {
        id: r.sampleId, requestId: r.id, entryId: r.entryId, product: r.product, batch: r.batch,
        anaEntry: nextId('ANA', anaIds), condition: text_(condition, 100), tests,
        approved: false, reportIssued: false, history: []
      };
      log(doc, 'Sample received');
      return doc;
    });
    r.status = 'Received';
    log(r, 'Sample received');
    try {
      await save('requests', r);
    } catch (e) {
      await db.remove('samples', s.id);  // undo, so the two records never disagree
      throw e;
    }
    return s.id;
  }

  async function saveSample(json) {
    const d = JSON.parse(json), cur = await getDoc('samples', d.id);
    if (cur.approved) fail('These results are approved and locked.');
    checkVersion(cur, d);
    const incoming = d.tests || {};
    Object.keys(cur.tests).forEach((k) => {
      const t = incoming[k] || {}, c = cur.tests[k];
      ['method', 'instrument', 'result', 'limit', 'outcome', 'link', 'fileName'].forEach((f) => { c[f] = text_(t[f], 500); });
      c.fileId = validPath(t.fileId) ? t.fileId : '';
    });
    log(cur, 'Results saved');
    return JSON.stringify(await save('samples', cur));
  }

  async function approveSample(id) {
    const cur = await getDoc('samples', id);
    if (sampleStatus(cur) !== 'Ready for review') fail('Complete every test before approving.');
    requireOtherPerson(cur, 'Results saved');
    cur.approved = true;
    log(cur, 'Results approved');
    return JSON.stringify(await save('samples', cur));
  }

  async function issueReport(id) {
    const cur = await getDoc('samples', id);
    if (!cur.approved) fail('Approve the results before issuing the report.');
    if (cur.reportIssued) fail('The report has already been issued.');
    const entryRow = await db.get('entries', cur.entryId);
    const entry = entryRow ? entryRow.doc : null;
    const year = cur.anaEntry.slice(4, 8);
    const folder = ['LAB-Records', 'Analytical', year].join('/');
    cur.reportIssued = true;
    log(cur, 'Report issued');
    cur.sheetPdfPath = folder + '/' + safeSeg('Sample_sheet_' + cur.id + '.pdf');
    const saved = await save('samples', cur);
    await savePdf(cur.sheetPdfPath, sheetDoc(saved, entry, entry ? calc(entry) : {}, TEST_NAMES));
    for (const k of Object.keys(saved.tests)) {
      const t = saved.tests[k];
      if (t.fileId) await files.copy(t.fileId, folder + '/' + safeSeg(t.fileName || (saved.id + '_' + k + '.pdf')));
    }
    return JSON.stringify(saved);
  }

  /* ---------- files ---------- */
  /** Step 1 of an upload: checks the request and returns a one-time upload slot.
   *  The browser then sends the file straight to storage (no 6 MB function limit). */
  async function uploadFile(json) {
    const d = JSON.parse(json);
    const allowed = d.kind === 'scheme' ? ['image/png', 'image/jpeg'] : ['application/pdf'];
    if (allowed.indexOf(d.mime) < 0) fail('That file type is not accepted.');
    if (!(Number(d.size) > 0)) fail('That file is empty.');
    if (Number(d.size) > MAX_FILE_BYTES) fail('That file is over 20 MB. Choose a smaller one.');
    let folder;
    if (d.kind === 'scheme') {
      const e = await getDoc('entries', d.ownerId);
      folder = ['LAB-Working', 'Chemistry', yearOf(d.start || e.start), safeSeg(d.project || e.project || 'No project'), e.id];
    } else {
      const s = await getDoc('samples', d.ownerId);
      folder = ['LAB-Working', 'Analytical', s.anaEntry.slice(4, 8), 'Characterization', s.anaEntry, 'Raw_data'];
    }
    const fileName = safeSeg(d.name);
    const path = folder.join('/') + '/' + Date.now().toString(36) + '_' + fileName;
    const slot = await files.signedUpload(path);
    return JSON.stringify({ bucket: config.bucket, path, token: slot.token, fileId: path, fileName });
  }

  /** Reaction image for an entry, as a short-lived link. Only images used by an entry are served. */
  async function getImage(fileId) {
    const entries = await readAll('entries');
    const known = Object.keys(entries).some((k) => entries[k].schemeFileId === fileId);
    if (!known) fail('Image not found.');
    return files.signedUrl(fileId);
  }

  /** Short-lived link to any lab file (signed PDF, sample sheet, instrument report). */
  async function fileUrl(path) {
    if (!validPath(path)) fail('File not found.');
    return files.signedUrl(path);
  }

  return {
    getState, createEntry, saveEntry, submitEntry, signEntry, reopenEntry,
    createRequest, receiveSample, saveSample, approveSample, issueReport,
    uploadFile, getImage, fileUrl
  };
}
