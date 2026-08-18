import { jsPDF } from 'jspdf';

/**
 * A4 portrait Test Requisition Form (TRF) for the B2B partner portal.
 *
 * The partner selects booked orders and hands this sheet to the sample
 * collector: it lists every order with its tests, the sample required for
 * each, a tick box per row, and signature blocks for the partner and the
 * collector. The signed copy is the proof of which samples changed hands.
 */

export interface TrfTest {
  name: string;
  sample_type: string;
  sample_color?: string | null;
  requires_fasting?: boolean;
  guidelines?: string | null;
}

export interface TrfSample {
  id: string;
  barcode?: string | null;
  sample_type?: string | null;
  container_type?: string | null;
  status?: string | null;
  collected_at?: string | null;
}

export interface TrfOrder {
  order_id: string;
  order_display: string;
  patient_name: string;
  order_date: string;
  priority?: string | null;
  doctor?: string | null;
  notes?: string | null;
  status?: string | null;
  sample_id?: string | null;
  /** Age / gender / phone — bookings carry it, orders do not expose it to B2B */
  patient_meta?: string | null;
  /** "Booked" for orders, "Scheduled" for bookings */
  date_label?: string | null;
  tests: TrfTest[];
  samples: TrfSample[];
}

export interface TrfPartner {
  name: string;
  code?: string | null;
  contact_person?: string | null;
  phone?: string | null;
  address?: string | null;
}

export interface TrfOptions {
  labName: string;
  labLogoDataUrl?: string | null;
  partner: TrfPartner;
  generatedAt: Date;
  reference: string;
  /** Printed under the partner panel, e.g. to flag a pre-order booking sheet */
  note?: string | null;
}

const PAGE_MARGIN = 30;
const CONTENT_WIDTH = 535; // A4 portrait (595pt) minus both margins
const HEADER_BOTTOM = 74;
const FOOTER_RESERVE = 34;

interface Column {
  key: 'test' | 'sample' | 'barcode' | 'collected';
  label: string;
  width: number;
  align: 'left' | 'center';
}

const COLUMNS: Column[] = [
  { key: 'test', label: 'Test / Panel', width: 242, align: 'left' },
  { key: 'sample', label: 'Sample required', width: 116, align: 'left' },
  { key: 'barcode', label: 'Barcode / Sample ID', width: 127, align: 'left' },
  { key: 'collected', label: 'Collected', width: 50, align: 'center' },
];

const columnX = (index: number) =>
  PAGE_MARGIN + COLUMNS.slice(0, index).reduce((sum, col) => sum + col.width, 0);

const shortDate = (value?: string | null): string => {
  if (!value) return '-';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '-' : parsed.toLocaleDateString('en-GB');
};

const sampleKey = (value?: string | null): string =>
  String(value || '').trim().toLowerCase();

/** One container per distinct sample type is what the partner has to hand over. */
const containerTally = (orders: TrfOrder[]): Array<{ type: string; count: number }> => {
  const counts = new Map<string, { type: string; count: number }>();
  orders.forEach((order) => {
    const typesInOrder = new Set<string>();
    order.tests.forEach((test) => typesInOrder.add(test.sample_type || 'Not specified'));
    typesInOrder.forEach((type) => {
      const key = sampleKey(type);
      const existing = counts.get(key);
      if (existing) existing.count += 1;
      else counts.set(key, { type, count: 1 });
    });
  });
  return Array.from(counts.values()).sort((a, b) => a.type.localeCompare(b.type));
};

export const generateB2BTrfPdf = (orders: TrfOrder[], options: TrfOptions): jsPDF => {
  const doc = new jsPDF({ unit: 'pt', format: 'a4', orientation: 'portrait' });
  const pageHeight = doc.internal.pageSize.getHeight();
  const rightEdge = PAGE_MARGIN + CONTENT_WIDTH;

  const totalTests = orders.reduce((sum, order) => sum + order.tests.length, 0);
  const tally = containerTally(orders);
  const totalContainers = tally.reduce((sum, item) => sum + item.count, 0);

  const wrap = (text: string, width: number): string[] =>
    doc.splitTextToSize(String(text ?? '-'), width - 8) as string[];

  const drawPageHeader = () => {
    let titleX = PAGE_MARGIN;
    if (options.labLogoDataUrl) {
      try {
        const format = options.labLogoDataUrl.includes('image/jpeg') || options.labLogoDataUrl.includes('image/jpg')
          ? 'JPEG'
          : 'PNG';
        doc.addImage(options.labLogoDataUrl, format, PAGE_MARGIN, 24, 42, 42, undefined, 'FAST');
        titleX = PAGE_MARGIN + 52;
      } catch {
        // A broken logo must never block the handover sheet
      }
    }

    doc.setTextColor(17, 24, 39);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(13);
    doc.text(options.labName || 'Laboratory', titleX, 38);

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(30, 64, 175);
    doc.text('Test Requisition & Sample Handover Form (TRF)', titleX, 53);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(107, 114, 128);
    doc.text(`TRF No: ${options.reference}`, rightEdge, 38, { align: 'right' });
    doc.text(`Generated: ${options.generatedAt.toLocaleString('en-IN')}`, rightEdge, 50, { align: 'right' });

    doc.setDrawColor(209, 213, 219);
    doc.line(PAGE_MARGIN, 62, rightEdge, 62);
  };

  const drawTableHeader = (y: number): number => {
    doc.setFillColor(241, 245, 249);
    doc.rect(PAGE_MARGIN, y, CONTENT_WIDTH, 16, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    doc.setTextColor(55, 65, 81);
    COLUMNS.forEach((col, index) => {
      const x = col.align === 'center' ? columnX(index) + col.width / 2 : columnX(index) + 4;
      doc.text(col.label, x, y + 11, { align: col.align });
    });
    return y + 16;
  };

  drawPageHeader();
  let y = HEADER_BOTTOM;

  const ensureSpace = (needed: number, repeatTableHeader: boolean): void => {
    if (y + needed <= pageHeight - FOOTER_RESERVE) return;
    doc.addPage();
    drawPageHeader();
    y = HEADER_BOTTOM;
    if (repeatTableHeader) y = drawTableHeader(y);
  };

  // Partner / summary panel
  const partnerLines = [
    `Partner: ${options.partner.name}${options.partner.code ? ` (${options.partner.code})` : ''}`,
    options.partner.contact_person ? `Contact person: ${options.partner.contact_person}` : '',
    options.partner.phone ? `Phone: ${options.partner.phone}` : '',
    options.partner.address ? `Address: ${options.partner.address}` : '',
  ].filter(Boolean);

  const summaryLines = [
    `Orders: ${orders.length}`,
    `Tests: ${totalTests}`,
    `Containers to hand over: ${totalContainers}`,
    tally.length ? tally.map((item) => `${item.count} x ${item.type}`).join(', ') : '',
  ].filter(Boolean);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  const wrappedPartner = partnerLines.flatMap((line) => wrap(line, CONTENT_WIDTH / 2));
  const wrappedSummary = summaryLines.flatMap((line) => wrap(line, CONTENT_WIDTH / 2));
  const panelHeight = Math.max(wrappedPartner.length, wrappedSummary.length) * 11 + 14;

  doc.setFillColor(249, 250, 251);
  doc.rect(PAGE_MARGIN, y, CONTENT_WIDTH, panelHeight, 'F');
  doc.setDrawColor(229, 231, 235);
  doc.rect(PAGE_MARGIN, y, CONTENT_WIDTH, panelHeight);
  doc.setTextColor(55, 65, 81);
  doc.text(wrappedPartner, PAGE_MARGIN + 8, y + 13);
  doc.text(wrappedSummary, PAGE_MARGIN + CONTENT_WIDTH / 2 + 8, y + 13);
  y += panelHeight;

  if (options.note) {
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(7.5);
    doc.setTextColor(146, 64, 14);
    const wrappedNote = doc.splitTextToSize(options.note, CONTENT_WIDTH) as string[];
    doc.text(wrappedNote, PAGE_MARGIN, y + 11);
    y += wrappedNote.length * 9 + 4;
    doc.setFont('helvetica', 'normal');
  }

  y += 14;

  orders.forEach((order) => {
    const orderSamples = order.samples || [];
    const samplesByType = new Map<string, TrfSample>();
    orderSamples.forEach((sample) => {
      const key = sampleKey(sample.sample_type);
      if (!samplesByType.has(key)) samplesByType.set(key, sample);
    });

    const fastingTests = order.tests.filter((test) => test.requires_fasting).map((test) => test.name);
    const guidelines = Array.from(
      new Set(order.tests.map((test) => (test.guidelines || '').trim()).filter(Boolean)),
    );

    // Order band
    ensureSpace(48, false);
    doc.setFillColor(239, 246, 255);
    doc.rect(PAGE_MARGIN, y, CONTENT_WIDTH, 24, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9.5);
    doc.setTextColor(30, 58, 138);
    doc.text(`${order.order_display} - ${order.patient_name}`, PAGE_MARGIN + 6, y + 15);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(75, 85, 99);
    const bandRight = [
      `${order.date_label || 'Booked'}: ${shortDate(order.order_date)}`,
      order.patient_meta || '',
      order.priority && order.priority.toLowerCase() !== 'normal' ? `Priority: ${order.priority}` : '',
      order.doctor ? `Ref. Dr: ${order.doctor}` : '',
    ].filter(Boolean).join('   |   ');
    doc.text(bandRight, rightEdge - 6, y + 15, { align: 'right' });
    y += 24;

    y = drawTableHeader(y);

    if (order.tests.length === 0) {
      ensureSpace(16, true);
      doc.setDrawColor(229, 231, 235);
      doc.rect(PAGE_MARGIN, y, CONTENT_WIDTH, 16);
      doc.setFont('helvetica', 'italic');
      doc.setFontSize(7.5);
      doc.setTextColor(107, 114, 128);
      doc.text('No tests listed on this order', PAGE_MARGIN + 4, y + 11);
      y += 16;
    }

    order.tests.forEach((test) => {
      const matchedSample = samplesByType.get(sampleKey(test.sample_type));

      // splitTextToSize measures with the active font, so match the draw settings first
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.5);
      // Bookings and freshly created orders have no barcode yet, so leave
      // a ruled blank for the collector to write it on
      const barcodeText = matchedSample?.barcode || matchedSample?.id || order.sample_id || '';
      const cells: Record<Column['key'], string[]> = {
        test: wrap(test.name, COLUMNS[0].width),
        sample: wrap(test.sample_type || 'Not specified', COLUMNS[1].width),
        barcode: barcodeText ? wrap(barcodeText, COLUMNS[2].width) : [''],
        collected: [''],
      };
      const lineCount = Math.max(...COLUMNS.map((col) => cells[col.key].length));
      const rowHeight = Math.max(18, lineCount * 9 + 9);

      ensureSpace(rowHeight, true);

      doc.setDrawColor(229, 231, 235);
      doc.rect(PAGE_MARGIN, y, CONTENT_WIDTH, rowHeight);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.5);
      doc.setTextColor(55, 65, 81);
      COLUMNS.forEach((col, index) => {
        if (col.key === 'collected') {
          // Empty tick box the collector fills in at handover
          doc.setDrawColor(107, 114, 128);
          doc.rect(columnX(index) + col.width / 2 - 5, y + rowHeight / 2 - 5, 10, 10);
          doc.setDrawColor(229, 231, 235);
          return;
        }
        if (col.key === 'barcode' && !barcodeText) {
          doc.setDrawColor(203, 213, 225);
          doc.line(columnX(index) + 6, y + rowHeight - 6, columnX(index) + col.width - 6, y + rowHeight - 6);
          doc.setDrawColor(229, 231, 235);
          return;
        }
        doc.text(cells[col.key], columnX(index) + 4, y + 11);
      });
      // Column separators
      doc.setDrawColor(229, 231, 235);
      COLUMNS.slice(1).forEach((_, index) => {
        const x = columnX(index + 1);
        doc.line(x, y, x, y + rowHeight);
      });
      y += rowHeight;
    });

    const notes = [
      fastingTests.length ? `Fasting required: ${fastingTests.join(', ')}` : '',
      guidelines.length ? `Collection notes: ${guidelines.join(' | ')}` : '',
      order.notes ? `Notes: ${order.notes}` : '',
    ].filter(Boolean);

    if (notes.length) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7);
      const wrappedNotes = notes.flatMap((note) => doc.splitTextToSize(note, CONTENT_WIDTH - 16) as string[]);
      const notesHeight = wrappedNotes.length * 9 + 8;
      ensureSpace(notesHeight, false);
      doc.setFillColor(255, 251, 235);
      doc.rect(PAGE_MARGIN, y, CONTENT_WIDTH, notesHeight, 'F');
      doc.setDrawColor(253, 230, 138);
      doc.rect(PAGE_MARGIN, y, CONTENT_WIDTH, notesHeight);
      doc.setTextColor(146, 64, 14);
      doc.text(wrappedNotes, PAGE_MARGIN + 8, y + 10);
      y += notesHeight;
    }

    y += 14;
  });

  // Declaration + signatures, kept together on one page
  const SIGN_BLOCK_HEIGHT = 132;
  ensureSpace(SIGN_BLOCK_HEIGHT, false);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  doc.setTextColor(75, 85, 99);
  const declaration = doc.splitTextToSize(
    'Declaration: The samples ticked in the "Collected" column above were handed over by the partner and physically received by the sample collector in acceptable condition. Rows left unticked were not collected.',
    CONTENT_WIDTH,
  ) as string[];
  doc.text(declaration, PAGE_MARGIN, y + 8);
  y += declaration.length * 9 + 14;

  const boxWidth = (CONTENT_WIDTH - 20) / 2;
  const boxHeight = 96;

  const drawSignatureBox = (x: number, title: string, prefill: string, fields: string[]) => {
    doc.setDrawColor(156, 163, 175);
    doc.rect(x, y, boxWidth, boxHeight);
    doc.setFillColor(243, 244, 246);
    doc.rect(x, y, boxWidth, 16, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.setTextColor(31, 41, 55);
    doc.text(title, x + 6, y + 11);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(75, 85, 99);
    if (prefill) doc.text(prefill, x + 6, y + 27);

    let lineY = y + (prefill ? 42 : 32);
    fields.forEach((field) => {
      doc.text(field, x + 6, lineY);
      doc.setDrawColor(156, 163, 175);
      doc.line(x + 6 + doc.getTextWidth(field) + 4, lineY + 1, x + boxWidth - 6, lineY + 1);
      lineY += 18;
    });
  };

  drawSignatureBox(
    PAGE_MARGIN,
    'Handed over by - Partner',
    options.partner.name,
    ['Name:', 'Signature:', 'Date & time:'],
  );
  drawSignatureBox(
    PAGE_MARGIN + boxWidth + 20,
    'Collected by - Sample Collector',
    '',
    ['Name:', 'ID / Phone:', 'Signature:', 'Date & time:'],
  );

  // Footers
  const pageCount = doc.getNumberOfPages();
  for (let page = 1; page <= pageCount; page += 1) {
    doc.setPage(page);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(156, 163, 175);
    doc.text(
      `${options.reference}  -  ${options.partner.name}  -  Retain the signed copy as proof of sample handover.`,
      PAGE_MARGIN,
      pageHeight - 16,
    );
    doc.text(`Page ${page} of ${pageCount}`, rightEdge, pageHeight - 16, { align: 'right' });
  }

  return doc;
};

export const downloadB2BTrfPdf = (orders: TrfOrder[], options: TrfOptions): void => {
  const doc = generateB2BTrfPdf(orders, options);
  doc.save(`${options.reference}.pdf`);
};
