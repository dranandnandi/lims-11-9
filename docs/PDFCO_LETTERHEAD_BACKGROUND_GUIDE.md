# PDF.co HTML→PDF: Full-Page Letterhead as Background Image

Portable instructions for any app using `https://api.pdf.co/v1/pdf/convert/from/html`.
Extracted from the working LIMS implementation (`supabase/functions/generate-pdf-letterhead/index.ts`,
`buildPdfBodyDocumentV2`) and the standalone proof `test-pdfco-direct.js`.

---

## 1. The core principle

Two independent mechanisms, both required:

| Need | Mechanism |
|------|-----------|
| Letterhead image on **every** page, edge to edge | `position: fixed` div sized to exactly A4, `z-index: 0` |
| Content never overlapping the printed header/footer artwork on **any** page | A layout `<table>` whose `<thead>` / `<tfoot>` hold empty spacer rows (browsers repeat thead/tfoot on every printed page) |

Do **not** use PDF.co's native `header` / `footer` HTML in this mode. Do not use CSS `@page` margins.
All spacing lives in the HTML; the API gets zero margins so the background is full bleed.

---

## 2. PDF.co API payload (exact settings)

```js
const payload = {
  name: 'report.pdf',
  html: finalHtml,

  // CRITICAL — zero margins so the fixed background starts at 0,0 and bleeds to the edges.
  // Any non-zero margin pushes the whole page box down and the letterhead goes with it.
  margins: '0px 0px 0px 0px',

  papersize: 'A4',
  orientation: 'Portrait',

  // CRITICAL — without this Chromium drops background-image entirely.
  printbackground: true,

  // CRITICAL — must be false. If true, PDF.co reserves header/footer bands
  // and your background/content get shifted and clipped.
  displayheaderfooter: false,
  header: '',
  footer: '',
  headerheight: '0px',
  footerheight: '0px',

  scale: 1.0,
  mediatype: 'screen',   // use 'print' only for the B&W/print copy
  async: true,           // true for multi-page reports; then poll /v1/job/check
};

const res = await fetch('https://api.pdf.co/v1/pdf/convert/from/html', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
  body: JSON.stringify(payload),
});
```

Note the payload keys PDF.co expects are **lowercase**: `papersize`, `printbackground`,
`displayheaderfooter`, `headerheight`, `footerheight`, `mediatype`.

### Async polling

```js
const result = await res.json();
if (result.error) throw new Error(result.message);
if (result.url) return result.url;              // sync
if (result.jobId) return pollJob(result.jobId); // async

async function pollJob(jobId, apiKey) {
  for (;;) {
    const r = await fetch('https://api.pdf.co/v1/job/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ jobid: jobId }),
    });
    const j = await r.json();
    if (j.status === 'success') return j.url;
    if (j.status === 'failed' || j.status === 'aborted') throw new Error(j.message || 'PDF job failed');
    await new Promise(s => setTimeout(s, 2000));
  }
}
```

---

## 3. HTML skeleton (copy-paste)

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<style>
  /* Do NOT add @page { margin: 0 } — it fights the API margins. Leave @page alone. */

  html, body {
    margin: 0;
    padding: 0;
    -webkit-print-color-adjust: exact;   /* keep colors/background in print rendering */
    print-color-adjust: exact;
  }

  /* --- The repeating full-page letterhead layer --- */
  #page-bg {
    position: fixed;
    top: 0;
    left: 0;
    width: 210mm;                 /* A4 exact */
    height: 297mm;
    z-index: 0;
    pointer-events: none;
    background-image: url('LETTERHEAD_URL_HERE');
    background-repeat: no-repeat;
    background-position: top left;
    background-size: 210mm 297mm; /* force exact A4 fit — never 'cover' */
  }

  /* --- Content sits above the background --- */
  .report,
  .report-body {
    position: relative;
    z-index: 1;
    background: transparent !important;       /* kill the white sheet */
    background-color: transparent !important;
  }

  /* Side padding lives here because API margins are 0 */
  .report-body--pdf {
    padding: 0 20px 0 20px;       /* right / left — see §4 */
  }

  /* Any wrapper that paints white will hide the letterhead — neutralize them all */
  .report-container, .report-region, .report-header, .content-wrapper {
    background: transparent !important;
    background-color: transparent !important;
  }

  /* Data tables stay solid white so text is readable over artwork.
     Make them transparent instead if the letterhead is a light watermark. */
  .patient-info, .report-table, .tbl-results, .tbl-interpretation {
    background: #ffffff !important;
  }

  /* Page-break hygiene */
  .report-table tr, .patient-info tr { break-inside: avoid; page-break-inside: avoid; }
  .report-table thead, .tbl-interpretation thead { display: table-header-group; }
  .signature-block { page-break-inside: avoid; }
</style>
</head>
<body>

  <!-- 1. Fixed background layer — repeats on every page -->
  <div id="page-bg"></div>

  <!-- 2. Layout table — thead/tfoot spacers repeat on every page -->
  <table style="width:100%; max-width:210mm; border:none; border-collapse:collapse;">

    <thead style="display: table-header-group;">
      <tr><td style="border:none; padding:0;">
        <div style="height: 130px;"></div>   <!-- TOP SPACER — clears letterhead header art -->
      </td></tr>
    </thead>

    <tfoot style="display: table-footer-group;">
      <tr><td style="border:none; padding:0;">
        <div style="height: 130px;"></div>   <!-- BOTTOM SPACER — clears letterhead footer art -->
      </td></tr>
    </tfoot>

    <tbody>
      <tr><td style="border:none; padding:0;">
        <div class="report">
          <main class="report-body report-body--pdf">
            <!-- ALL REPORT CONTENT GOES HERE -->
          </main>
        </div>
      </td></tr>
    </tbody>

  </table>

</body>
</html>
```

The `<thead>`/`<tfoot>` spacers are what make page 2, 3, 4… line up. A plain
`padding-top` on the body only protects page 1.

---

## 4. Padding / spacing — how to choose the numbers

Four numbers control everything. In the LIMS app they come from the lab's saved
`pdfSettings.margins`, defaulting to:

```js
const topSpacerHeight    = pdfSettings?.margins?.top    ?? 130;  // px — thead spacer
const bottomSpacerHeight = pdfSettings?.margins?.bottom ?? 130;  // px — tfoot spacer
const leftPadding        = pdfSettings?.margins?.left   ?? 20;   // px — CSS padding
const rightPadding       = pdfSettings?.margins?.right  ?? 20;   // px — CSS padding

// In letterhead mode the API margins are 0, so side padding MUST come from CSS.
// Enforce a floor so text never touches the paper edge if the lab saved 0.
const sidePadLeft  = letterheadUrl ? Math.max(leftPadding, 20)  : leftPadding;
const sidePadRight = letterheadUrl ? Math.max(rightPadding, 20) : rightPadding;
```

- **Top/bottom** → injected as the spacer `<div>` heights (not CSS padding).
- **Left/right** → injected as `padding` on `.report-body--pdf`.

### Converting your letterhead artwork into these numbers

A4 at CSS 96 dpi = **794 × 1123 px**. Measure the artwork in any image editor:

```
spacerPx = (bandHeightInImagePx / imageTotalHeightPx) × 1123
```

Example: letterhead image is 2480 × 3508; the header graphic occupies the top 460 px
and the footer band the bottom 300 px:

- top spacer = 460 / 3508 × 1123 ≈ **147px**
- bottom spacer = 300 / 3508 × 1123 ≈ **96px**

Then add ~10–15px breathing room. Typical working values:

| Letterhead style | top | bottom | left/right |
|---|---|---|---|
| Slim logo strip | 90–110 | 60–80 | 20–30 |
| Standard lab letterhead | 130–160 | 100–130 | 20–40 |
| Heavy header + footer + side border | 170–200 | 140–170 | 40–60 |

Tune by generating one report and measuring the overlap — the spacers are the only
thing to change; the background never moves.

---

## 5. Letterhead image: source and optimization

Store the URL (not base64). **Do not base64-encode images** — PDF.co fetches URLs
directly, and encoding adds seconds of function time and megabytes of payload.

If the image is on ImageKit, force an exact A4-ratio render. The LIMS app uses:

```js
function applyLetterheadImageTransform(url) {
  if (!url || !url.includes('ik.imagekit.io')) return url;
  const tr = 'w-1240,h-1754,c-force,q-75,f-jpg';   // A4 @150dpi, ~85% smaller than 300dpi PNG
  if (url.includes('/tr:')) return url.replace(/\/tr:[^/]+/, `/tr:${tr}`);
  if (url.includes('?tr=')) return url.replace(/\?tr=[^&]+/, `?tr=${tr}`);
  const u = new URL(url);
  const parts = u.pathname.split('/');
  parts.splice(parts.findIndex(p => p && !p.includes('.')) + 1, 0, `tr:${tr}`);
  u.pathname = parts.join('/');
  return u.toString();
}
```

- `c-force` guarantees the exact 1240×1754 (A4) aspect — no letterboxing.
- `w-1240,h-1754,q-75,f-jpg` ≈ 150 dpi. Bump to `w-2480,h-3508,q-95,f-png` only if the
  letterhead has fine linework; it costs ~6× the file size and noticeably slower PDFs.
- Image requirements: A4 aspect ratio (1:1.414), ≥1240px wide, no transparency needed.

---

## 6. Checklist of the things that actually break

| Symptom | Cause | Fix |
|---|---|---|
| Background missing entirely | `printbackground` not set | `printbackground: true` |
| Background on page 1 only | Used absolute positioning or a `<img>` in the body | `position: fixed` on `#page-bg` |
| Background pushed down / white strip at top | Non-zero API `margins`, or `displayheaderfooter: true` | `margins: '0px 0px 0px 0px'`, `displayheaderfooter: false` |
| Background stretched or cropped | `background-size: cover` / image not A4 ratio | `background-size: 210mm 297mm` + `c-force` transform |
| Letterhead hidden behind white | A wrapper element paints an opaque background | add it to the `background: transparent !important` list |
| Content overlaps header art on page 2+ | Used `padding-top` instead of the thead spacer | use the `<thead>`/`<tfoot>` spacer table |
| Text touches the paper edge | API margins are 0 and no CSS side padding | `Math.max(padding, 20)` floor on `.report-body--pdf` |
| Table row split across a page break | — | `break-inside: avoid; page-break-inside: avoid;` on `tr` |
| CSS variables render as literal `var(--x)` | PDF.co's Chromium chokes on some `var()` usage | pre-expand `:root` vars to literal values before sending |
| Colors washed out | — | `print-color-adjust: exact` on `html, body` |
| Timeout on long reports | Sync mode | `async: true` + poll `/v1/job/check` |

---

## 7. Mode switching (letterhead vs. plain)

Keep one code path and branch on whether a letterhead URL exists. The LIMS app detects
letterhead mode downstream by sniffing the built HTML:

```js
const hasLetterhead = finalHtml.includes('page-bg');

const margins = hasLetterhead
  ? '0px 0px 0px 0px'
  : `${top}px ${right}px ${bottom}px ${left}px`;   // plain mode: real API margins

const displayHeaderFooter = hasLetterhead ? false : userSetting;
const headerHeight = hasLetterhead ? '0px' : `${hh}px`;
const footerHeight = hasLetterhead ? '0px' : `${fh}px`;
```

In plain (no-letterhead) mode you go back to normal API margins — e.g.
`'180px 20px 150px 20px'` with `displayheaderfooter: true` and real header/footer HTML.
The two modes are mutually exclusive; never mix them.

---

## 8. Minimal end-to-end example

See `test-pdfco-direct.js` in the repo root — a single self-contained Node 18+ script
that renders a two-page report over a letterhead background. Run it against your own
image URL to validate spacer heights before wiring anything into the app.
