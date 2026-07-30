// utils/labelLayout.ts
// Single source of truth for barcode label geometry.
//
// Before this module the same 2" x 1" geometry was hardcoded in four places
// (jsPDF page format, jsPDF draw coordinates, ZPL ^PW/^LL/^FO, and a dead
// @page CSS block) and had to be kept in sync by hand. Everything now derives
// from one LabelLayout object resolved per lab/location.
//
// Geometry is expressed as fractions of a reference 50.8mm x 25.4mm label so
// the default layout renders byte-for-byte the same output as before, while any
// other size/orientation/grid scales proportionally.

export type LabelOrientation = 'landscape' | 'portrait';

export interface LabelLayout {
  /** Preset key this layout came from; 'custom' once any field is hand-edited. */
  preset: string;
  /** Physical label size as it comes off the roll or sheet. */
  widthMm: number;
  heightMm: number;
  /** 'portrait' swaps the label box so content reflows into a taller, narrower cell. */
  orientation: LabelOrientation;
  /** N-up grid. 1x1 = one label per page (roll / direct thermal). */
  columns: number;
  rows: number;
  /** Gutters between cells on a multi-up sheet. */
  columnGapMm: number;
  rowGapMm: number;
  /**
   * Sheet size for multi-up layouts. Null means the page is exactly one label
   * plus its margins, which is what roll printers expect.
   */
  pageWidthMm: number | null;
  pageHeightMm: number | null;
  /** Unprintable/offset margins of the sheet. */
  pageMarginTopMm: number;
  pageMarginLeftMm: number;
  /** Inner padding of a single label cell. */
  paddingXMm: number;
  paddingYMm: number;
  /** Barcode bar height. Null derives it from the label height. */
  barcodeHeightMm: number | null;
  /** Multiplier applied to every text size. 1 = the original sizing. */
  fontScale: number;
  /** Resolution of the ZPL/thermal printer, used to convert mm to dots. */
  dpi: number;
  /**
   * ^LL feed length for ZPL printers. Roll media often needs a feed slightly
   * longer than the printable label, so this is kept separate from heightMm.
   * Null derives it from the label height.
   */
  zplLabelLengthMm: number | null;
}

/** The label all fraction constants below are measured against. */
const REF_WIDTH_MM = 50.8;
const REF_HEIGHT_MM = 25.4;

export const DEFAULT_LABEL_LAYOUT: LabelLayout = {
  preset: 'roll_50x25',
  widthMm: REF_WIDTH_MM,
  heightMm: REF_HEIGHT_MM,
  orientation: 'landscape',
  columns: 1,
  rows: 1,
  columnGapMm: 0,
  rowGapMm: 0,
  pageWidthMm: null,
  pageHeightMm: null,
  pageMarginTopMm: 0,
  pageMarginLeftMm: 0,
  paddingXMm: 1.75,
  paddingYMm: 1,
  barcodeHeightMm: null,
  fontScale: 1,
  dpi: 203,
  // 244 dots at 203 dpi — the feed length this layout has always shipped with.
  zplLabelLengthMm: 30.5,
};

export interface LabelLayoutPreset {
  key: string;
  label: string;
  description: string;
  layout: LabelLayout;
}

function preset(key: string, label: string, description: string, overrides: Partial<LabelLayout>): LabelLayoutPreset {
  return {
    key,
    label,
    description,
    layout: { ...DEFAULT_LABEL_LAYOUT, ...overrides, preset: key },
  };
}

export const LABEL_LAYOUT_PRESETS: LabelLayoutPreset[] = [
  preset('roll_50x25', '2" x 1" roll (50.8 x 25.4 mm)', 'Standard lab tube label. One label per page.', {}),
  preset('roll_100x50', '4" x 2" roll (101.6 x 50.8 mm)', 'Large tube / container label.', {
    widthMm: 101.6,
    heightMm: 50.8,
    paddingXMm: 3.5,
    paddingYMm: 2,
    zplLabelLengthMm: null,
  }),
  preset('roll_100x25', '4" x 1" roll (101.6 x 25.4 mm)', 'Wide, short label for slides and slim tubes.', {
    widthMm: 101.6,
    heightMm: 25.4,
    paddingXMm: 3.5,
    zplLabelLengthMm: null,
  }),
  preset('roll_38x25', '38 x 25 mm roll', 'Compact paediatric / microtainer label.', {
    widthMm: 38,
    heightMm: 25,
    paddingXMm: 1.4,
    zplLabelLengthMm: null,
  }),
  preset('a4_2x10', 'A4 sheet 2 x 10 (99 x 27 mm)', '20 labels per A4 sheet.', {
    widthMm: 99,
    heightMm: 27,
    columns: 2,
    rows: 10,
    columnGapMm: 3,
    rowGapMm: 0,
    pageWidthMm: 210,
    pageHeightMm: 297,
    pageMarginTopMm: 13.5,
    pageMarginLeftMm: 4.5,
    paddingXMm: 3,
    paddingYMm: 1.5,
    zplLabelLengthMm: null,
  }),
  preset('a4_2x5', 'A4 sheet 2 x 5 (99 x 57 mm)', '10 large labels per A4 sheet.', {
    widthMm: 99,
    heightMm: 57,
    columns: 2,
    rows: 5,
    columnGapMm: 3,
    rowGapMm: 0,
    pageWidthMm: 210,
    pageHeightMm: 297,
    pageMarginTopMm: 6,
    pageMarginLeftMm: 4.5,
    paddingXMm: 3.5,
    paddingYMm: 2.5,
    zplLabelLengthMm: null,
  }),
  preset('a4_3x8', 'A4 sheet 3 x 8 (63.5 x 33.9 mm)', '24 labels per A4 sheet.', {
    widthMm: 63.5,
    heightMm: 33.9,
    columns: 3,
    rows: 8,
    columnGapMm: 2.5,
    rowGapMm: 0,
    pageWidthMm: 210,
    pageHeightMm: 297,
    pageMarginTopMm: 12.7,
    pageMarginLeftMm: 7,
    paddingXMm: 2.5,
    paddingYMm: 1.5,
    zplLabelLengthMm: null,
  }),
];

export function getLabelLayoutPreset(key: string): LabelLayoutPreset | undefined {
  return LABEL_LAYOUT_PRESETS.find((entry) => entry.key === key);
}

function num(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : parseFloat(String(value ?? ''));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function optionalNum(value: unknown, min: number, max: number): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : parseFloat(String(value));
  if (!Number.isFinite(parsed)) return null;
  return Math.min(max, Math.max(min, parsed));
}

/**
 * Coerce an arbitrary stored value (jsonb from Supabase, or a partially filled
 * form) into a complete, sane LabelLayout. Never throws.
 */
export function normalizeLabelLayout(value: unknown): LabelLayout {
  if (!value || typeof value !== 'object') return { ...DEFAULT_LABEL_LAYOUT };

  const raw = value as Record<string, unknown>;
  const base = getLabelLayoutPreset(String(raw.preset ?? ''))?.layout ?? DEFAULT_LABEL_LAYOUT;

  // Nullable fields must honour an explicit stored null rather than falling
  // back to the preset, otherwise "derive automatically" can never be selected.
  const nullable = (key: keyof LabelLayout): unknown =>
    Object.prototype.hasOwnProperty.call(raw, key) ? raw[key] : base[key];

  return {
    preset: String(raw.preset ?? base.preset),
    widthMm: num(raw.widthMm, base.widthMm, 10, 300),
    heightMm: num(raw.heightMm, base.heightMm, 8, 300),
    orientation: raw.orientation === 'portrait' ? 'portrait' : 'landscape',
    columns: Math.round(num(raw.columns, base.columns, 1, 10)),
    rows: Math.round(num(raw.rows, base.rows, 1, 30)),
    columnGapMm: num(raw.columnGapMm, base.columnGapMm, 0, 50),
    rowGapMm: num(raw.rowGapMm, base.rowGapMm, 0, 50),
    pageWidthMm: optionalNum(nullable('pageWidthMm'), 20, 1000),
    pageHeightMm: optionalNum(nullable('pageHeightMm'), 20, 1000),
    pageMarginTopMm: num(raw.pageMarginTopMm, base.pageMarginTopMm, 0, 100),
    pageMarginLeftMm: num(raw.pageMarginLeftMm, base.pageMarginLeftMm, 0, 100),
    paddingXMm: num(raw.paddingXMm, base.paddingXMm, 0, 30),
    paddingYMm: num(raw.paddingYMm, base.paddingYMm, 0, 30),
    barcodeHeightMm: optionalNum(nullable('barcodeHeightMm'), 2, 200),
    fontScale: num(raw.fontScale, base.fontScale, 0.4, 3),
    dpi: Math.round(num(raw.dpi, base.dpi, 96, 600)),
    zplLabelLengthMm: optionalNum(nullable('zplLabelLengthMm'), 5, 300),
  };
}

/** Label cell size after the orientation swap. */
export function getLabelCellSize(layout: LabelLayout): { width: number; height: number } {
  return layout.orientation === 'portrait'
    ? { width: layout.heightMm, height: layout.widthMm }
    : { width: layout.widthMm, height: layout.heightMm };
}

export interface ResolvedLabelPage {
  pageWidth: number;
  pageHeight: number;
  cellWidth: number;
  cellHeight: number;
  columns: number;
  rows: number;
  perPage: number;
  /** Top-left corner of the cell at the given index within a page. */
  cellOrigin: (indexOnPage: number) => { x: number; y: number };
}

/**
 * Work out the PDF page box and the position of each label cell on it.
 *
 * For a 1x1 layout with no explicit sheet size the page *is* the label, which is
 * what roll printers need — the browser then prints at 100% with no user
 * intervention.
 */
export function resolveLabelPage(layout: LabelLayout): ResolvedLabelPage {
  const { width: cellWidth, height: cellHeight } = getLabelCellSize(layout);
  const columns = Math.max(1, layout.columns);
  const rows = Math.max(1, layout.rows);

  const gridWidth = columns * cellWidth + (columns - 1) * layout.columnGapMm;
  const gridHeight = rows * cellHeight + (rows - 1) * layout.rowGapMm;

  const isSheet = columns > 1 || rows > 1 || layout.pageWidthMm !== null;

  const pageWidth = isSheet
    ? layout.pageWidthMm ?? gridWidth + layout.pageMarginLeftMm * 2
    : cellWidth;
  const pageHeight = isSheet
    ? layout.pageHeightMm ?? gridHeight + layout.pageMarginTopMm * 2
    : cellHeight;

  const originX = isSheet ? layout.pageMarginLeftMm : 0;
  const originY = isSheet ? layout.pageMarginTopMm : 0;

  return {
    pageWidth,
    pageHeight,
    cellWidth,
    cellHeight,
    columns,
    rows,
    perPage: columns * rows,
    cellOrigin: (indexOnPage: number) => ({
      x: originX + (indexOnPage % columns) * (cellWidth + layout.columnGapMm),
      y: originY + Math.floor(indexOnPage / columns) * (cellHeight + layout.rowGapMm),
    }),
  };
}

/**
 * Geometry of the content drawn inside one label cell, in mm relative to the
 * cell's top-left corner. Fractions are taken from the original hardcoded 2"x1"
 * layout so the default preset is visually unchanged.
 */
export interface LabelContentMetrics {
  left: number;
  right: number;
  typeBaseline: number;
  typeFontPt: number;
  nameBaseline: number;
  nameFontPt: number;
  genderAgeMaxWidth: number;
  /** Horizontal gap kept between the patient name and the gender/age column. */
  nameGap: number;
  barcodeX: number;
  barcodeY: number;
  barcodeWidth: number;
  barcodeHeight: number;
  /** Baseline for the human-readable barcode number drawn under the bars. */
  barcodeNumberBaseline: number;
  barcodeNumberFontPt: number;
  infoBaseline: number;
  infoFontPt: number;
  sampleIdMaxWidth: number;
  dateTimeMaxWidth: number;
  referredByBaseline: number;
  referredByFontPt: number;
}

const FRAC = {
  typeBaseline: 3.7 / REF_HEIGHT_MM,
  nameBaseline: 7.2 / REF_HEIGHT_MM,
  barcodeY: 8.1 / REF_HEIGHT_MM,
  barcodeHeight: 9.7 / REF_HEIGHT_MM,
  infoBaseline: 20 / REF_HEIGHT_MM,
  referredByBaseline: 23 / REF_HEIGHT_MM,
  genderAgeMaxWidth: 12 / REF_WIDTH_MM,
  sampleIdMaxWidth: 21 / REF_WIDTH_MM,
  dateTimeMaxWidth: 24 / REF_WIDTH_MM,
  nameGap: 2 / REF_WIDTH_MM,
  barcodeX: 3 / REF_WIDTH_MM,
  barcodeWidth: 44.8 / REF_WIDTH_MM,
};

export function getLabelContentMetrics(layout: LabelLayout): LabelContentMetrics {
  const { width, height } = getLabelCellSize(layout);
  const vScale = height / REF_HEIGHT_MM;
  const hScale = width / REF_WIDTH_MM;
  // Text scales with the smaller axis so a wide-but-short label does not get
  // fonts too tall to fit.
  const fontScale = Math.min(vScale, hScale) * layout.fontScale;

  const left = layout.paddingXMm;
  const right = width - layout.paddingXMm;

  const barcodeY = height * FRAC.barcodeY;
  const barcodeHeight = layout.barcodeHeightMm ?? height * FRAC.barcodeHeight;

  return {
    left,
    right,
    typeBaseline: height * FRAC.typeBaseline,
    typeFontPt: 7 * fontScale,
    nameBaseline: height * FRAC.nameBaseline,
    nameFontPt: 7.6 * fontScale,
    genderAgeMaxWidth: width * FRAC.genderAgeMaxWidth,
    nameGap: width * FRAC.nameGap,
    barcodeX: width * FRAC.barcodeX,
    barcodeY,
    barcodeWidth: width * FRAC.barcodeWidth,
    barcodeHeight,
    // The number sits in the bottom slice of the barcode envelope, so bars +
    // number occupy the same footprint the baked-in raster number used to.
    barcodeNumberBaseline: barcodeY + barcodeHeight,
    barcodeNumberFontPt: 5.5 * fontScale,
    infoBaseline: height * FRAC.infoBaseline,
    infoFontPt: 6.8 * fontScale,
    sampleIdMaxWidth: width * FRAC.sampleIdMaxWidth,
    dateTimeMaxWidth: width * FRAC.dateTimeMaxWidth,
    referredByBaseline: height * FRAC.referredByBaseline,
    referredByFontPt: 6.6 * fontScale,
  };
}

/**
 * ZPL geometry in printer dots.
 *
 * ZPL prints on continuous roll media, so columns/rows/sheet margins do not
 * apply — only the label box, dpi and font scale. The fractions below reproduce
 * the previously hardcoded ^FO/^A0N/^BY values exactly at the default preset
 * (406 x 244 dots at 203 dpi), so existing labs see no change.
 */
export interface LabelZplMetrics {
  printWidthDots: number;
  labelLengthDots: number;
  moduleWidth: number;
  leftDots: number;
  typeYDots: number;
  typeFontDots: number;
  nameYDots: number;
  nameFontDots: number;
  genderAgeXDots: number;
  barcodeXDots: number;
  barcodeYDots: number;
  barcodeHeightDots: number;
  infoYDots: number;
  infoFontDots: number;
  dateTimeXDots: number;
  referredByYDots: number;
}

const ZPL_FRAC = {
  left: 12 / 406,
  genderAgeX: 270 / 406,
  barcodeX: 40 / 406,
  dateTimeX: 210 / 406,
  typeY: 8 / 244,
  nameY: 34 / 244,
  barcodeY: 64 / 244,
  infoY: 132 / 244,
  referredByY: 160 / 244,
  typeFont: 22 / 244,
  nameFont: 24 / 244,
  infoFont: 22 / 244,
  barcodeHeight: 55 / 244,
};

export function getLabelZplMetrics(layout: LabelLayout): LabelZplMetrics {
  const { width, height } = getLabelCellSize(layout);
  const toDots = (mm: number) => Math.round((mm * layout.dpi) / 25.4);

  const printWidthDots = toDots(width);
  const labelLengthDots = toDots(layout.zplLabelLengthMm ?? height);
  const font = (frac: number) => Math.max(8, Math.round(labelLengthDots * frac * layout.fontScale));

  return {
    printWidthDots,
    labelLengthDots,
    moduleWidth: Math.max(2, Math.round((3 * layout.dpi) / 203)),
    leftDots: Math.round(printWidthDots * ZPL_FRAC.left),
    typeYDots: Math.round(labelLengthDots * ZPL_FRAC.typeY),
    typeFontDots: font(ZPL_FRAC.typeFont),
    nameYDots: Math.round(labelLengthDots * ZPL_FRAC.nameY),
    nameFontDots: font(ZPL_FRAC.nameFont),
    genderAgeXDots: Math.round(printWidthDots * ZPL_FRAC.genderAgeX),
    barcodeXDots: Math.round(printWidthDots * ZPL_FRAC.barcodeX),
    barcodeYDots: Math.round(labelLengthDots * ZPL_FRAC.barcodeY),
    barcodeHeightDots: layout.barcodeHeightMm
      ? toDots(layout.barcodeHeightMm)
      : Math.round(labelLengthDots * ZPL_FRAC.barcodeHeight),
    infoYDots: Math.round(labelLengthDots * ZPL_FRAC.infoY),
    infoFontDots: font(ZPL_FRAC.infoFont),
    dateTimeXDots: Math.round(printWidthDots * ZPL_FRAC.dateTimeX),
    referredByYDots: Math.round(labelLengthDots * ZPL_FRAC.referredByY),
  };
}

/*
 * Ambient layout
 * --------------
 * Every barcode print path in the app already resolves its printer name from
 * QZTrayContext, so rather than threading a layout argument through six call
 * sites the context publishes the resolved layout here and the PDF/ZPL builders
 * read it. Callers that need a specific layout (e.g. a settings preview) can
 * still pass one explicitly.
 */
let activeLabelLayout: LabelLayout = { ...DEFAULT_LABEL_LAYOUT };

export function setActiveLabelLayout(layout: LabelLayout | null | undefined): void {
  activeLabelLayout = layout ? normalizeLabelLayout(layout) : { ...DEFAULT_LABEL_LAYOUT };
}

export function getActiveLabelLayout(): LabelLayout {
  return activeLabelLayout;
}

/**
 * Compose the gender + age string drawn next to the patient name.
 *
 * The gender/age slot on a label is narrow (~12mm on a 2" label), so the full
 * word "Female" alone fills it and the age gets truncated away. Lab tube labels
 * conventionally show the gender as a single initial (M / F / O), which leaves
 * room for the age — matching the "M 34 Y" format the ZPL renderer documents.
 */
export function formatGenderAge(gender?: unknown, age?: unknown): string {
  const initial = String(gender ?? '').trim().charAt(0).toUpperCase();
  const ageStr = age === null || age === undefined || String(age).trim() === ''
    ? ''
    : `${String(age).trim()} Y`;
  return [initial, ageStr].filter(Boolean).join(' ');
}
