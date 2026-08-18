// src/utils/technicianWorksheet.ts
// Printable "technician worksheet" for a date group on the Orders screen.
// One card per sample/order — mirroring the result-entry cards — listing the
// test groups still pending, with ruled space to write readings on paper.

export type WorksheetPanel = {
  name: string;
  expected: number;
  entered: number;
  verified: boolean;
  status: string;
  sample_type?: string;
  sample_color?: string;
  isOutsourced?: boolean;
  outsourcedLab?: string;
  is_section_only?: boolean;
};

export type WorksheetOrder = {
  seq: number;
  orderId: string;
  sampleId?: string | null;
  barcodes?: string[];
  patientName: string;
  patientAgeGender?: string;
  doctor?: string | null;
  accountName?: string | null;
  priority?: string;
  orderDate: string;
  colorName?: string | null;
  colorCode?: string | null;
  panels: WorksheetPanel[];
};

export type WorksheetOptions = {
  labName?: string;
  dateLabel: string;
  /** Extra context line (active filters etc.) shown under the title. */
  subtitle?: string;
  /** Rows per test group to leave blank for writing. */
  writeLines?: number;
};

const DONE_STATUSES = new Set([
  'complete',
  'completed',
  'verified',
  'pending_approval',
]);

/** A panel still needs bench work if it is neither verified nor fully entered. */
export function isPanelPending(p: WorksheetPanel): boolean {
  if (p.verified) return false;
  const s = String(p.status || '').toLowerCase().replace(/\s+/g, '_');
  if (DONE_STATUSES.has(s)) return false;
  if (p.expected > 0 && p.entered >= p.expected) return false;
  return true;
}

export function pendingPanels(o: WorksheetOrder): WorksheetPanel[] {
  return (o.panels || []).filter(isPanelPending);
}

const esc = (v: unknown): string =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const isSafeColor = (c?: string | null): boolean =>
  !!c && /^#[0-9a-fA-F]{3,8}$/.test(c.trim());

function panelRow(p: WorksheetPanel, writeLines: number): string {
  const tube = p.sample_type || '';
  const swatch = isSafeColor(p.sample_color)
    ? `<span class="dot" style="background:${esc(p.sample_color)}"></span>`
    : '';
  const count = p.expected > 0 ? `${p.expected} test${p.expected !== 1 ? 's' : ''}` : '';
  const partial =
    p.entered > 0 && p.expected > 0 && p.entered < p.expected
      ? `<span class="partial">partial ${p.entered}/${p.expected}</span>`
      : '';
  const outsourced = p.isOutsourced
    ? `<span class="tag out">Outsourced${p.outsourcedLab ? ` · ${esc(p.outsourcedLab)}` : ''}</span>`
    : '';
  const section = p.is_section_only ? `<span class="tag sec">Report section</span>` : '';

  const lines = Array.from({ length: Math.max(1, writeLines) })
    .map(() => `<div class="wline"></div>`)
    .join('');

  return `
    <div class="panel">
      <div class="panel-head">
        <span class="box"></span>
        <span class="pname">${esc(p.name)}</span>
        <span class="pmeta">${swatch}${esc(tube)}${tube && count ? ' · ' : ''}${esc(count)}</span>
        ${partial}${outsourced}${section}
      </div>
      <div class="wlines">${lines}</div>
    </div>`;
}

function orderCard(o: WorksheetOrder, pending: WorksheetPanel[], writeLines: number): string {
  const codes = (o.barcodes || []).filter(Boolean);
  const idLine = o.sampleId || codes[0] || o.orderId.slice(0, 8);
  const extraCodes = codes.length > 1 ? codes.slice(1).join(' / ') : '';
  const prio = o.priority && o.priority !== 'Normal'
    ? `<span class="tag prio ${o.priority === 'STAT' ? 'stat' : ''}">${esc(o.priority)}</span>`
    : '';
  const tube = isSafeColor(o.colorCode)
    ? `<span class="dot" style="background:${esc(o.colorCode)}"></span>${esc(o.colorName || '')}`
    : esc(o.colorName || '');

  return `
    <section class="card">
      <header class="card-head">
        <div class="seq">${esc(String(o.seq || 0).padStart(3, '0'))}</div>
        <div class="who">
          <div class="pt">${esc(o.patientName)}${prio}</div>
          <div class="sub">
            ${esc(o.patientAgeGender || '')}
            ${o.doctor ? ` · Dr. ${esc(o.doctor)}` : ''}
            ${o.accountName ? ` · ${esc(o.accountName)}` : ''}
          </div>
        </div>
        <div class="ids">
          <div class="sid">${esc(idLine)}</div>
          ${extraCodes ? `<div class="sub">${esc(extraCodes)}</div>` : ''}
          ${tube ? `<div class="sub">${tube}</div>` : ''}
          <div class="sub oid">Order ${esc(o.orderId)}</div>
        </div>
      </header>
      <div class="panels">
        ${pending.map((p) => panelRow(p, writeLines)).join('')}
      </div>
      <footer class="card-foot">
        <span>Done by: ______________</span>
        <span>Time: __________</span>
        <span>Checked: ______________</span>
      </footer>
    </section>`;
}

function workloadSummary(rows: { name: string; count: number }[]): string {
  if (rows.length === 0) return '';
  return `
    <div class="summary">
      <span class="slabel">Workload</span>
      ${rows
        .map((r) => `<span class="schip">${esc(r.name)} <b>${r.count}</b></span>`)
        .join('')}
    </div>`;
}

/**
 * Build the printable worksheet HTML for one day's orders.
 * Orders with nothing pending are skipped.
 */
export function generateWorksheetHTML(
  orders: WorksheetOrder[],
  opts: WorksheetOptions
): string {
  const writeLines = opts.writeLines ?? 2;

  const withPending = orders
    .map((o) => ({ order: o, pending: pendingPanels(o) }))
    .filter((x) => x.pending.length > 0);

  const skipped = orders.length - withPending.length;

  const counts = new Map<string, number>();
  withPending.forEach((x) =>
    x.pending.forEach((p) => counts.set(p.name, (counts.get(p.name) || 0) + 1))
  );
  const summaryRows = Array.from(counts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  const totalPending = summaryRows.reduce((s, r) => s + r.count, 0);
  const printedAt = new Date().toLocaleString('en-IN');

  const body =
    withPending.length === 0
      ? `<div class="empty">Nothing pending — every test group for this date is already entered or verified.</div>`
      : withPending.map((x) => orderCard(x.order, x.pending, writeLines)).join('');

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8" />
<title>Worksheet - ${esc(opts.dateLabel)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; margin: 14px; color: #111; font-size: 12px; }
  .head { border-bottom: 2px solid #111; padding-bottom: 8px; margin-bottom: 10px; }
  .head h1 { margin: 0; font-size: 17px; }
  .head .lab { font-size: 13px; font-weight: bold; margin-bottom: 2px; }
  .head .meta { color: #444; font-size: 11px; margin-top: 3px; }
  .summary { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; margin: 8px 0 12px; }
  .slabel { font-size: 10px; text-transform: uppercase; letter-spacing: .5px; color: #555; margin-right: 2px; }
  .schip { border: 1px solid #bbb; border-radius: 10px; padding: 1px 7px; font-size: 10.5px; }
  /* inline-block (not grid/flex) — the only layout browsers reliably page-break on */
  .grid { font-size: 0; }
  .card { display: inline-block; vertical-align: top; width: calc(50% - 5px); margin: 0 0 9px; font-size: 12px;
          border: 1px solid #333; border-radius: 5px; padding: 7px 8px; break-inside: avoid; page-break-inside: avoid; }
  .card:nth-child(odd) { margin-right: 9px; }
  .card-head { display: flex; gap: 7px; align-items: flex-start; border-bottom: 1px dashed #999; padding-bottom: 5px; }
  .seq { border: 1px solid #333; border-radius: 4px; min-width: 30px; text-align: center; font-weight: bold; padding: 2px 3px; font-size: 13px; }
  .who { flex: 1; min-width: 0; }
  .pt { font-weight: bold; font-size: 13px; line-height: 1.2; }
  .sub { color: #444; font-size: 10.5px; line-height: 1.35; }
  .ids { text-align: right; white-space: nowrap; }
  .sid { font-family: "Courier New", monospace; font-weight: bold; font-size: 12px; }
  .oid { font-family: "Courier New", monospace; font-size: 8.5px; color: #777; }
  .panels { margin-top: 5px; }
  .panel { padding: 3px 0; border-bottom: 1px dotted #ccc; }
  .panel:last-child { border-bottom: none; }
  .panel-head { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
  .box { width: 10px; height: 10px; border: 1px solid #333; display: inline-block; flex: none; }
  .pname { font-weight: bold; font-size: 12px; }
  .pmeta { color: #555; font-size: 10px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; border: 1px solid #555; display: inline-block; margin-right: 3px; }
  .tag { border: 1px solid #666; border-radius: 8px; padding: 0 5px; font-size: 9px; text-transform: uppercase; }
  .tag.prio { border-color: #b45309; color: #b45309; margin-left: 5px; }
  .tag.prio.stat { border-color: #b91c1c; color: #b91c1c; font-weight: bold; }
  .tag.out { border-color: #c2410c; color: #c2410c; }
  .tag.sec { border-color: #4338ca; color: #4338ca; }
  .partial { font-size: 9px; color: #92400e; border: 1px solid #d97706; border-radius: 8px; padding: 0 5px; }
  .wlines { padding: 2px 0 1px 15px; }
  .wline { border-bottom: 1px solid #ddd; height: 15px; }
  .card-foot { display: flex; justify-content: space-between; gap: 6px; border-top: 1px dashed #999; margin-top: 5px; padding-top: 4px; font-size: 9.5px; color: #555; }
  .empty { border: 1px dashed #999; padding: 24px; text-align: center; color: #555; font-size: 12px; }
  .foot-note { margin-top: 10px; font-size: 10px; color: #666; }
  @media print {
    body { margin: 8mm; }
    .no-print { display: none; }
    @page { size: A4; margin: 8mm; }
  }
</style></head>
<body>
  <div class="head">
    ${opts.labName ? `<div class="lab">${esc(opts.labName)}</div>` : ''}
    <h1>Technician Worksheet — ${esc(opts.dateLabel)}</h1>
    <div class="meta">
      ${withPending.length} sample${withPending.length !== 1 ? 's' : ''} ·
      ${totalPending} test group${totalPending !== 1 ? 's' : ''} pending
      ${skipped > 0 ? ` · ${skipped} sample${skipped !== 1 ? 's' : ''} fully done (not listed)` : ''}
      ${opts.subtitle ? ` · ${esc(opts.subtitle)}` : ''}
      · Printed ${esc(printedAt)}
    </div>
  </div>
  ${workloadSummary(summaryRows)}
  <div class="grid">${body}</div>
  <div class="foot-note">Status reflects the moment of printing. Enter results in the LIMS after the bench run.</div>
  <script>window.onload = function () { window.print(); };</script>
</body></html>`;
}

/** Open the worksheet in a new tab and trigger the print / save-as-PDF dialog. */
export function openWorksheetWindow(html: string): void {
  const win = window.open('', '_blank');
  if (!win) {
    throw new Error('Popup blocked. Please allow popups to print the worksheet.');
  }
  win.document.write(html);
  win.document.close();
  win.focus();
}
