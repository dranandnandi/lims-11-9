/**
 * Compatibility facade for the old QZ Tray service.
 *
 * Phase 1 of the print bridge replaces browser -> QZ direct printing with:
 *
 *   browser -> print_jobs queue -> LIMS Bridge Utility -> local printer
 *
 * Existing components still import qzTrayService during this phase. These
 * exports keep that surface stable while queueing jobs for the utility.
 */

import {
  connect,
  disconnect,
  enqueueBarcodeLabelPrint,
  enqueueReportPrint,
  getConnectionStatus,
  isConnected,
  onConnectionStatusChange,
  type BarcodeLabelData,
  type PrintBridgeStatus,
} from './printBridgeService';
import JsBarcode from 'jsbarcode';
import { generateBarcodeLabelsPDFBlob, generateBarcodeSync } from './barcodeGenerator';
import { getActiveLabelLayout, getLabelCellSize } from './labelLayout';

export type QZConnectionStatus = PrintBridgeStatus;
export type { BarcodeLabelData };

export {
  connect,
  disconnect,
  getConnectionStatus,
  isConnected,
  onConnectionStatusChange,
};

/**
 * Queue a barcode label for the LIMS Bridge Utility.
 */
export async function printBarcodeLabel(
  printerName: string,
  data: BarcodeLabelData
): Promise<void> {
  if (!String(data.sampleId || '').trim()) {
    throw new Error('Cannot print barcode label: sample barcode is missing.');
  }

  await enqueueBarcodeLabelPrint(printerName, data);
}

export function printBarcodeLabelsInBrowser(
  labels: BarcodeLabelData[],
  preferredPrinterName?: string | null
): void {
  if (labels.length === 0) return;
  if (labels.some((label) => !String(label.sampleId || '').trim())) {
    alert('Cannot print barcode label: sample barcode is missing.');
    return;
  }

  const printWindow = window.open('', '_blank', 'width=320,height=520');
  if (!printWindow) {
    alert('Browser blocked the print window. Please allow pop-ups for this site and try again.');
    return;
  }

  const layout = getActiveLabelLayout();
  // Render the barcode bitmap at a resolution proportional to the label so a
  // 4" label is not an upscaled 2" image.
  const barcodeScale = Math.max(1, Math.round(getLabelCellSize(layout).width / 50.8));

  const printableLabels = labels.map((label) => {
    const collectionDate = label.date || new Date().toLocaleDateString('en-GB', {
      day: '2-digit',
      month: 'short',
      year: '2-digit',
    }).replace(/ /g, '-');
    const collectionTime = label.collectionTime || new Date().toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });

    return {
      sampleId: label.labelId || label.sampleId,
      barcodeDataUrl: generateBarcodeSync(JsBarcode, label.sampleId, {
        width: 2 * barcodeScale,
        height: 50 * barcodeScale,
        // The number is drawn separately as crisp vector text so it prints
        // solid black on thermal printers instead of a faded raster.
        displayValue: false,
        margin: 5 * barcodeScale,
      }),
      metadata: {
        sampleType: label.sampleType,
        patientName: label.patientName || 'Sample',
        collectionDate,
        collectionTime,
        gender: label.gender,
        age: label.age,
        referredBy: label.referredBy,
        barcodeNumber: label.sampleId,
      },
    };
  });

  const pdfBlob = generateBarcodeLabelsPDFBlob(printableLabels, {
    title: preferredPrinterName ? `Print labels - ${preferredPrinterName}` : 'Print labels',
  });
  const pdfUrl = URL.createObjectURL(pdfBlob);

  printWindow.location.href = pdfUrl;
  setTimeout(() => {
    printWindow.focus();
    printWindow.print();
    setTimeout(() => URL.revokeObjectURL(pdfUrl), 60_000);
  }, 1000);
}

/**
 * Queue a report PDF for the LIMS Bridge Utility.
 */
export async function printPDFFromUrl(
  printerName: string,
  pdfUrl: string
): Promise<void> {
  await enqueueReportPrint(printerName, pdfUrl);
}
