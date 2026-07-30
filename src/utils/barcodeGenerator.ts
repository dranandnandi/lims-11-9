// utils/barcodeGenerator.ts
// Barcode generation for sample tubes using Code 128 format

import { jsPDF } from 'jspdf';
import {
  formatGenderAge,
  getActiveLabelLayout,
  getLabelContentMetrics,
  normalizeLabelLayout,
  resolveLabelPage,
  type LabelContentMetrics,
  type LabelLayout,
} from './labelLayout';

/**
 * Generate Code 128 barcode as data URL
 * Uses canvas-based rendering for maximum compatibility
 * 
 * @param data - Data to encode (typically sample ID)
 * @param options - Barcode rendering options
 * @returns Data URL of the barcode image
 */
export function generateBarcode(
  data: string,
  options?: {
    width?: number;
    height?: number;
    displayValue?: boolean;
    fontSize?: number;
    margin?: number;
  }
): string {
  const {
    width = 2,
    height = 50,
    displayValue = true,
    fontSize = 12,
    margin = 10
  } = options || {};

  try {
    // Dynamic import of JsBarcode to avoid SSR issues
    if (typeof window === 'undefined') {
      console.warn('Barcode generation is only available in browser');
      return '';
    }

    const canvas = document.createElement('canvas');
    
    // Dynamically import JsBarcode
    import('jsbarcode').then(({ default: JsBarcode }) => {
      JsBarcode(canvas, data, {
        format: 'CODE128',
        width,
        height,
        displayValue,
        fontSize,
        margin,
        background: '#ffffff',
        lineColor: '#000000'
      });
    });

    return canvas.toDataURL('image/png');
  } catch (error) {
    console.error('Error generating barcode:', error);
    return '';
  }
}

/**
 * Generate barcode synchronously (requires JsBarcode to be pre-loaded)
 * Use this when JsBarcode is already imported in your component
 */
export function generateBarcodeSync(
  JsBarcode: any,
  data: string,
  options?: {
    width?: number;
    height?: number;
    displayValue?: boolean;
    fontSize?: number;
    margin?: number;
  }
): string {
  const {
    width = 2,
    height = 50,
    displayValue = true,
    fontSize = 12,
    margin = 10
  } = options || {};

  const canvas = document.createElement('canvas');
  
  JsBarcode(canvas, data, {
    format: 'CODE128',
    width,
    height,
    displayValue,
    fontSize,
    margin,
    background: '#ffffff',
    lineColor: '#000000'
  });

  return canvas.toDataURL('image/png');
}

/**
 * Validate if a string can be encoded as Code 128
 */
export function isValidBarcodeData(data: string): boolean {
  // Code 128 can encode all ASCII characters (0-127)
  if (!data || data.length === 0) return false;
  
  for (let i = 0; i < data.length; i++) {
    const charCode = data.charCodeAt(i);
    if (charCode > 127) {
      return false;
    }
  }
  
  return true;
}

interface BarcodeLabelMetadata {
  sampleType?: string;
  patientName?: string;
  collectionDate?: string;
  collectionTime?: string;
  gender?: string;
  age?: string | number;
  referredBy?: string;
  /**
   * Human-readable barcode number to print under the bars as crisp vector text.
   * When set, the barcode image itself should be generated with displayValue
   * off so the number is not baked into the anti-aliased raster (which prints
   * faded on thermal printers).
   */
  barcodeNumber?: string;
}

export interface PrintableBarcodeLabel {
  sampleId: string;
  barcodeDataUrl: string;
  metadata?: BarcodeLabelMetadata;
}

function cleanPdfText(value: unknown): string {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
}

function fitPdfText(doc: jsPDF, value: unknown, maxWidthMm: number): string {
  const text = cleanPdfText(value);
  if (doc.getTextWidth(text) <= maxWidthMm) return text;

  let fitted = text;
  while (fitted.length > 0 && doc.getTextWidth(`${fitted}..`) > maxWidthMm) {
    fitted = fitted.slice(0, -1);
  }

  return fitted ? `${fitted}..` : '';
}

/**
 * Draw one label into the cell whose top-left corner is at (originX, originY).
 * All coordinates come from the layout so a single geometry definition drives
 * every label size, orientation and N-up grid.
 */
function drawBarcodeLabelCell(
  doc: jsPDF,
  label: PrintableBarcodeLabel,
  metrics: LabelContentMetrics,
  cellWidth: number,
  cellHeight: number,
  originX: number,
  originY: number
): void {
  const metadata = label.metadata || {};
  const genderAgeStr = formatGenderAge(metadata.gender, metadata.age);
  const dateTimeStr = [metadata.collectionDate, metadata.collectionTime].filter(Boolean).join(' ');

  doc.setFillColor(255, 255, 255);
  doc.rect(originX, originY, cellWidth, cellHeight, 'F');
  doc.setTextColor(0, 0, 0);

  const left = originX + metrics.left;
  const right = originX + metrics.right;
  const innerWidth = right - left;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(metrics.typeFontPt);
  doc.text(
    fitPdfText(doc, `${metadata.sampleType || 'Sample'}.`, innerWidth),
    left,
    originY + metrics.typeBaseline
  );

  doc.setFontSize(metrics.nameFontPt);
  const genderAgeWidth = genderAgeStr
    ? Math.min(doc.getTextWidth(genderAgeStr), metrics.genderAgeMaxWidth)
    : 0;
  const nameGap = genderAgeStr ? metrics.nameGap : 0;
  const nameMaxWidth = innerWidth - genderAgeWidth - nameGap;
  doc.text(
    fitPdfText(doc, metadata.patientName || 'Patient', nameMaxWidth),
    left,
    originY + metrics.nameBaseline
  );

  if (genderAgeStr) {
    doc.text(
      fitPdfText(doc, genderAgeStr, metrics.genderAgeMaxWidth),
      right,
      originY + metrics.nameBaseline,
      { align: 'right' }
    );
  }

  // When a separate barcode number is supplied it is drawn as vector text
  // below the bars, so the bars only occupy the upper part of the envelope.
  const barsHeight = metadata.barcodeNumber
    ? metrics.barcodeHeight * 0.78
    : metrics.barcodeHeight;
  doc.addImage(
    label.barcodeDataUrl,
    'PNG',
    originX + metrics.barcodeX,
    originY + metrics.barcodeY,
    metrics.barcodeWidth,
    barsHeight
  );

  if (metadata.barcodeNumber) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(metrics.barcodeNumberFontPt);
    doc.text(
      cleanPdfText(metadata.barcodeNumber),
      originX + metrics.barcodeX + metrics.barcodeWidth / 2,
      originY + metrics.barcodeNumberBaseline,
      { align: 'center' }
    );
  }

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(metrics.infoFontPt);
  doc.text(fitPdfText(doc, label.sampleId, metrics.sampleIdMaxWidth), left, originY + metrics.infoBaseline);
  doc.text(
    fitPdfText(doc, dateTimeStr, metrics.dateTimeMaxWidth),
    right,
    originY + metrics.infoBaseline,
    { align: 'right' }
  );

  if (metadata.referredBy) {
    doc.setFontSize(metrics.referredByFontPt);
    doc.text(fitPdfText(doc, metadata.referredBy, innerWidth), left, originY + metrics.referredByBaseline);
  }
}

/**
 * Build a print-ready PDF for the given labels.
 *
 * The page box is the label itself for 1-up roll layouts, or the configured
 * sheet for N-up layouts, so the browser prints at 100% scale without the user
 * touching orientation or scaling in the print dialog. Short final rows simply
 * leave their remaining cells blank — no placeholder markup needed.
 */
export function generateBarcodeLabelsPDFBlob(
  labels: PrintableBarcodeLabel[],
  options?: { title?: string; layout?: LabelLayout }
): Blob {
  const layout = options?.layout ? normalizeLabelLayout(options.layout) : getActiveLabelLayout();
  const page = resolveLabelPage(layout);
  const metrics = getLabelContentMetrics(layout);
  const format: [number, number] = [page.pageWidth, page.pageHeight];
  const orientation = page.pageWidth >= page.pageHeight ? 'landscape' : 'portrait';

  const doc = new jsPDF({
    unit: 'mm',
    format,
    orientation,
    compress: true,
    putOnlyUsedFonts: true,
  });

  if (options?.title) {
    doc.setProperties({ title: options.title });
  }

  labels.forEach((label, index) => {
    if (index > 0 && index % page.perPage === 0) {
      doc.addPage(format, orientation);
    }
    const { x, y } = page.cellOrigin(index % page.perPage);
    drawBarcodeLabelCell(doc, label, metrics, page.cellWidth, page.cellHeight, x, y);
  });

  return doc.output('blob');
}
