/** Final PDFs (signed ELN entry and sample sheet), same content as the Apps Script version. */
import PdfPrinter from 'pdfmake';

// Built-in PDF fonts: nothing to bundle or download.
const printer = new PdfPrinter({
  Helvetica: { normal: 'Helvetica', bold: 'Helvetica-Bold', italics: 'Helvetica-Oblique', bolditalics: 'Helvetica-BoldOblique' }
});

const INK = '#16302F', LINE = '#CFE1DD', HEAD = '#E7F1EF';
const s = (v) => String(v == null ? '' : v);

function table(heads, rows) {
  return {
    table: {
      headerRows: 1,
      widths: heads.map(() => '*'),
      body: [heads.map((h) => ({ text: h, bold: true, fillColor: HEAD })), ...rows.map((r) => r.map((c) => ({ text: s(c) })))]
    },
    layout: { hLineColor: () => LINE, vLineColor: () => LINE, paddingLeft: () => 5, paddingRight: () => 5, paddingTop: () => 3, paddingBottom: () => 3 },
    margin: [0, 0, 0, 6]
  };
}
const h2 = (t) => ({ text: t, bold: true, fontSize: 12, margin: [0, 10, 0, 4] });

function page(title, content) {
  return {
    pageSize: 'A4', pageMargins: [36, 40, 36, 48],
    defaultStyle: { font: 'Helvetica', fontSize: 9.5, color: INK },
    info: { title, creator: 'Oceanic Lab Workflow' },
    footer: (cur, total) => ({ text: `${title}  ·  page ${cur} of ${total}  ·  generated ${new Date().toISOString()}`, fontSize: 7.5, color: '#55706D', margin: [36, 16, 36, 0] }),
    content: [
      { text: 'Oceanic Pharmachem R&D Center', fontSize: 9, color: '#55706D' },
      { text: title, fontSize: 18, bold: true, margin: [0, 2, 0, 10] },
      ...content
    ]
  };
}

const historyTable = (doc) => [h2('Activity'), table(['When', 'Who', 'Action'], (doc.history || []).map((h) => [h.at, h.email, h.action]))];

export function entryDoc(e, c) {
  const lim = c.lim;
  return page('ELN entry ' + e.id, [
    table(['Field', 'Entry'], [['Title', e.title], ['Project', e.project], ['Chemist', e.chemist], ['Start', e.start], ['Objective', e.objective], ['Safety notes', e.safety]]),
    h2('Compounds'), table(['Compound', 'Role', 'SMILES'], (e.compounds || []).map((x) => [x.name, x.role, x.smiles])),
    h2('Reagents'), table(['Material', 'MW (g/mol)', 'Mass (g)', 'mmol', 'Equiv', 'Lot no.'], (e.reagents || []).map((r, i) => {
      const m = c.rows[i];
      return [r.material, r.mw, r.mass, m == null ? '' : m.toFixed(1), m != null && lim ? (m / lim).toFixed(2) : '', r.lot];
    })),
    h2('Procedure and observations'), table(['Time', 'Step', 'Temp (C)', 'Observation'], (e.steps || []).map((x) => [x.time, x.step, x.temp, x.obs])),
    h2('Yield'), table(['Product', 'Batch', 'Actual (g)', 'Theoretical (g)', 'Percent'], [[e.product, e.batch, e.actualYield, c.theo == null ? '' : c.theo.toFixed(2), c.pct == null ? '' : c.pct.toFixed(1) + '%']]),
    ...historyTable(e)
  ]);
}

export function sheetDoc(smp, e, c, names) {
  const lim = e && e.reagents ? e.reagents[e.limiting || 0] : null;
  return page('Sample sheet ' + smp.id, [
    table(['Product', 'Batch', 'Project', 'Request'], [[smp.product, smp.batch, e ? e.project : '', smp.requestId]]),
    h2('Synthesis'), table(['ELN entry', 'Chemist', 'Scale', 'Yield'], [[smp.entryId, e ? e.chemist : '', lim ? lim.mass + ' g ' + lim.material : '', e ? e.actualYield + ' g, ' + (c.pct == null ? '' : c.pct.toFixed(1) + '%') : '']]),
    h2('Analytical data: ' + smp.anaEntry), table(['Test', 'Method', 'Key result', 'Limit or expected', 'Outcome', 'Report'], Object.keys(smp.tests).map((k) => {
      const t = smp.tests[k];
      return [names[k] || k, t.method, t.result, t.limit, t.outcome, t.fileName];
    })),
    ...historyTable(smp)
  ]);
}

export function buildPdf(def) {
  return new Promise((ok, no) => {
    const doc = printer.createPdfKitDocument(def);
    const chunks = [];
    doc.on('data', (b) => chunks.push(b));
    doc.on('end', () => ok(Buffer.concat(chunks)));
    doc.on('error', no);
    doc.end();
  });
}
