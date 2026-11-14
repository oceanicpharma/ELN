import assert from 'node:assert/strict';
import { makeApi } from '../lib/core.mjs';
import { memoryDb, memoryFiles } from './memory-adapters.mjs';
const db = memoryDb(), files = memoryFiles('/tmp/eln-out');
const as = (email, enforce = true) => makeApi({ db, files, user: { email }, config: { bucket: 'lab-files', enforceIndependentReview: enforce } });
const chem = as('Priya@oceanic.com'), rev = as('rahul@oceanic.com'), ana = as('anita@oceanic.com');
const P = JSON.parse, J = JSON.stringify;
const rejects = async (p, re) => assert.rejects(p, (e) => re.test(e.message));

let e = P(await chem.createEntry());
assert.match(e.id, /^CHEM-\d{4}-0001$/); assert.equal(e.chemist, 'priya');
const e2 = P(await chem.createEntry()); assert.match(e2.id, /-0002$/);
await rejects(chem.submitEntry(J(e)), /title.*one reagent.*all four checks/);
Object.assign(e, { title: 'Suzuki coupling', project: 'OPX-12', start: '2026-11-09T10:00', productMw: '250', actualYield: '2.0', product: 'OPX-12A', batch: 'B1',
  reagents: [{ material: 'Aryl bromide', mw: '200', mass: '2.0', lot: 'L1' }, { material: 'Boronic acid', mw: '150', mass: '1.8', lot: 'L2' }] });
// upload slot for scheme
const slot = P(await chem.uploadFile(J({ kind: 'scheme', ownerId: e.id, project: e.project, start: e.start, name: 'scheme 1.png', mime: 'image/png', size: 1000 })));
assert.match(slot.path, /^LAB-Working\/Chemistry\/2026\/OPX-12\/CHEM-\d{4}-0001\/\w+_scheme_1\.png$/);
await rejects(chem.uploadFile(J({ kind: 'scheme', ownerId: e.id, name: 'x.exe', mime: 'application/x-msdownload', size: 5 })), /not accepted/);
await rejects(chem.uploadFile(J({ kind: 'report', ownerId: 'nope', name: 'x.pdf', mime: 'application/pdf', size: 30e6 })), /over 20 MB/);
files.store.set(slot.path, Buffer.from('png'));
e.schemeFileId = slot.path;
e = P(await chem.saveEntry(J(e))); assert.equal(e.version, 2);
assert.equal(await chem.getImage(slot.path), '/__files/' + encodeURIComponent(slot.path));
await rejects(chem.getImage('LAB-Working/other.png'), /not found/);
// stale save is refused
await rejects(chem.saveEntry(J({ ...e, version: 1 })), /Someone else changed/);
e.checks = [true, true, true, true];
e = P(await chem.submitEntry(J(e))); assert.equal(e.status, 'Submitted');
await rejects(chem.saveEntry(J(e)), /locked/);
await rejects(chem.signEntry(e.id), /different person/);       // independent review
e = P(await rev.reopenEntry(e.id, 'Fix lot number')); assert.equal(e.status, 'Draft'); assert.deepEqual(e.checks, []);
e.checks = [true, true, true, true]; e = P(await chem.submitEntry(J(e)));
// request before signing is allowed (only Draft is blocked), as in the original
await rejects(chem.createRequest(J({ entryId: e2.id, tests: ['HPLC'], quantity: '50 mg' })), /Submit the ELN entry/);
e = P(await rev.signEntry(e.id)); assert.equal(e.status, 'Signed'); assert.ok(files.store.has(e.pdfPath), 'entry PDF stored');
assert.match(files.store.get(e.pdfPath).slice(0, 5).toString(), /%PDF-/);

await rejects(chem.createRequest(J({ entryId: e.id, tests: ['XRD'], quantity: '1' })), /at least one test/);
const r = P(await chem.createRequest(J({ entryId: e.id, tests: ['HPLC', 'NMR'], quantity: '50 mg', storage: '2-8 C' })));
assert.match(r.id, /^SR-\d{4}-0001$/); assert.equal(r.sampleId, e.id + '-S01');
const sid = await ana.receiveSample(r.id, 'Good');
await rejects(ana.receiveSample(r.id, 'Good'), /already been received/);
let s = P(await ana.getState()).samples[sid]; assert.match(s.anaEntry, /^ANA-\d{4}-0001$/);
assert.equal(P(await ana.getState()).requests[r.id].status, 'Received');
await rejects(rev.approveSample(sid), /Complete every test/);
const rs = P(await ana.uploadFile(J({ kind: 'report', ownerId: sid, name: 'HPLC run.pdf', mime: 'application/pdf', size: 2000 })));
files.store.set(rs.path, Buffer.from('%PDF-fake'));
s.tests.HPLC = { ...s.tests.HPLC, method: 'M-01', result: '99.2% area', limit: '>= 98%', outcome: 'Pass', fileId: rs.fileId, fileName: rs.fileName };
s.tests.NMR = { ...s.tests.NMR, method: '400 MHz', result: 'Consistent', outcome: 'Confirmed', fileId: '../../etc/passwd' };
s = P(await ana.saveSample(J(s)));
assert.equal(s.tests.NMR.fileId, '', 'unsafe path dropped');
assert.equal(P(await ana.getState()).samples[sid].tests.HPLC.outcome, 'Pass');
assert.equal(db.list ? (await db.get('samples', sid)).status : '', 'Ready for review');
await rejects(ana.approveSample(sid), /different person/);
s = P(await rev.approveSample(sid)); assert.ok(s.approved);
await rejects(ana.saveSample(J(s)), /approved and locked/);
s = P(await rev.issueReport(sid)); assert.ok(s.reportIssued);
assert.ok(files.store.has(s.sheetPdfPath)); assert.match(s.sheetPdfPath, /^LAB-Records\/Analytical\/\d{4}\/Sample_sheet_/);
assert.ok([...files.store.keys()].some((k) => k.startsWith('LAB-Records/Analytical/') && k.endsWith('HPLC_run.pdf')), 'report copied');
await rejects(rev.issueReport(sid), /already been issued/);
await rejects(rev.fileUrl('../secret'), /not found/);
assert.ok(db.audit_rows.length === 13); assert.ok(db.audit_rows.every((a) => a.by_email && a.snapshot));
console.log('All workflow checks passed. Audit rows:', db.audit_rows.length, '| files:', [...files.store.keys()].join('\n  '));
