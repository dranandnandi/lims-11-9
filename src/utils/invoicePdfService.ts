/**
 * Invoice PDF Generation Service
 * 
 * Handles PDF generation for invoices using CKEditor templates and PDF.co API.
 * Features:
 * - Template-based HTML generation with placeholder replacement
 * - Partial invoice support (INV-2024-001-P1 suffix pattern)
 * - Financial validation before generation
 * - Upload to Supabase Storage (invoices bucket)
 * - UPI QR Code generation for payments
 */

import { supabase } from './supabase';
import { notificationTriggerService } from './notificationTriggerService';
import { generateUPIPaymentBlock, isValidUPIId } from './upiQrService';

// Edge Function URL for PDF generation (keeps API key secure)
const PDF_GENERATION_FUNCTION_URL = import.meta.env.VITE_SUPABASE_URL 
  ? `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/generate-invoice-pdf`
  : 'http://localhost:54321/functions/v1/generate-invoice-pdf';

const invoicePdfGenerationPromises = new Map<string, Promise<string>>();

export interface Invoice {
  id: string;
  lab_id: string;
  pdf_url?: string | null;
  pdf_generated_at?: string | null;
  invoice_number?: string;
  invoice_date: string;
  due_date: string;
  patient_id: string;
  patient_name: string;
  order_id?: string;
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  amount_paid: number;
  status: string;
  is_partial: boolean;
  parent_invoice_id?: string;
  invoice_type?: string;
  account_id?: string;
  template_id?: string | null;
  whatsapp_sent_at?: string | null;
  payment_type: string;
  notes?: string;
  custom_fields?: Record<string, string>;
  invoice_items?: InvoiceItem[];
  lab?: {
    name: string;
    address?: string;
    phone?: string;
    email?: string;
    license_number?: string;
    registration_number?: string;
  };
  patient?: {
    phone?: string;
    email?: string;
    address?: string;
    gender?: string;
    age?: number | string;
    age_unit?: string;
    date_of_birth?: string;
    custom_fields?: Record<string, unknown>;
  };
  doctor?: string;
  account?: {
    name: string;
    billing_mode?: string;
    address_line1?: string;
    address_line2?: string;
    city?: string;
    state?: string;
    pincode?: string;
    billing_phone?: string;
    billing_email?: string;
    gst_number?: string;
  };
}

export interface InvoiceItem {
  id: string;
  test_name: string;
  quantity: number;
  price: number;
  total: number;
  discount_amount?: number;
  item_type?: 'test' | 'lab_charge';
  is_shareable_with_doctor?: boolean;
  is_shareable_with_phlebotomist?: boolean;
}

export interface InvoiceTemplate {
  id: string;
  lab_id: string;
  template_name: string;
  gjs_html?: string;
  gjs_css?: string;
  is_default: boolean;
  include_payment_terms: boolean;
  payment_terms_text?: string;
  include_bank_details: boolean;
  bank_details?: {
    account_name?: string;
    account_number?: string;
    ifsc?: string;
    bank_name?: string;
    upi_id?: string;
  };
  tax_disclaimer?: string;
  page_size?: 'A4' | 'A5' | 'Letter';
  letterhead_space_mm?: number; // top spacer height (mm) for letterhead header area
  letterhead_image_url?: string; // full-page background image URL — activates table-spacer PDF mode
  letterhead_bottom_mm?: number; // bottom spacer height (mm) for letterhead footer area
  // Thermal printer support
  format_type?: 'a4' | 'thermal_80mm' | 'thermal_58mm';
  print_mode?: 'pdf' | 'thermal' | 'both';
  thermal_settings?: {
    width_mm: number;
    paper_size: string;
    font_size: string;
    line_spacing: string;
    margins: string;
    barcode_height: string;
    barcode_width: string;
    barcode_format: 'CODE128' | 'QR';
    include_logo: boolean;
    logo_height: string;
    show_barcode: boolean;
    auto_cut: boolean;
  };
}

export interface GenerateInvoicePDFOptions {
  forceRegenerate?: boolean;
  triggerNotification?: boolean;
}

/**
 * Main function to generate invoice PDF
 */
export async function generateInvoicePDF(
  invoiceId: string,
  templateId?: string,
  options: GenerateInvoicePDFOptions = {}
): Promise<string> {
  const existingPromise = invoicePdfGenerationPromises.get(invoiceId);
  if (existingPromise && !options.forceRegenerate) {
    return existingPromise;
  }

  const generationPromise = generateInvoicePDFInternal(invoiceId, templateId, options)
    .finally(() => {
      invoicePdfGenerationPromises.delete(invoiceId);
    });

  invoicePdfGenerationPromises.set(invoiceId, generationPromise);
  return generationPromise;
}

async function generateInvoicePDFInternal(
  invoiceId: string,
  templateId?: string,
  options: GenerateInvoicePDFOptions = {}
): Promise<string> {
  try {
    // 1. Fetch invoice data with all relations
    const invoice = await fetchInvoiceData(invoiceId);
    if (!invoice) {
      throw new Error('Invoice not found');
    }

    const requestedTemplateId = templateId || undefined;
    if (
      !options.forceRegenerate &&
      invoice.pdf_url &&
      (!requestedTemplateId || requestedTemplateId === invoice.template_id)
    ) {
      return invoice.pdf_url;
    }

    // 2. Auto-repair missing invoice_items from order_tests if applicable
    if ((!invoice.invoice_items || invoice.invoice_items.length === 0) && invoice.order_id) {
      const { data: orderTests } = await supabase
        .from('order_tests')
        .select('id, test_name, price')
        .eq('order_id', invoice.order_id);

      if (orderTests && orderTests.length > 0) {
        const itemsToInsert = orderTests.map((t: any) => ({
          invoice_id: invoiceId,
          order_test_id: t.id,
          test_name: t.test_name,
          price: t.price,
          quantity: 1,
          total: t.price,
          lab_id: invoice.lab_id,
          order_id: invoice.order_id,
        }));

        // Add collection charge as a line item if present
        if (invoice.collection_charge && invoice.collection_charge > 0) {
          itemsToInsert.push({
            invoice_id: invoiceId,
            order_test_id: null,
            test_name: 'Sample Collection Charge',
            price: invoice.collection_charge,
            quantity: 1,
            total: invoice.collection_charge,
            lab_id: invoice.lab_id,
            order_id: invoice.order_id,
          } as any);
        }

        const { data: inserted, error: insertError } = await supabase
          .from('invoice_items')
          .insert(itemsToInsert)
          .select();

        if (!insertError && inserted) {
          invoice.invoice_items = inserted;
        }
      }
    }

    // 3. Financial validation
    await validateInvoiceForPdf(invoice);

    // 3. Load template (user-selected or default)
    const template = templateId
      ? await fetchTemplateById(templateId)
      : await fetchDefaultTemplate(invoice.lab_id);

    if (!template) {
      throw new Error('No invoice template found. Please create a default template first.');
    }

    // 4. Generate invoice number if not exists
    if (!invoice.invoice_number) {
      invoice.invoice_number = await generateInvoiceNumber(invoice);
    }

    // 5. Build HTML bundle with data (async for UPI QR generation)
    const htmlBundle = await buildInvoiceHtmlBundle(invoice, template);

    // 6. Call Edge Function to generate and upload PDF
    // Pass invoice number without .pdf extension (edge function will add it)
    const pdfUrl = await callEdgeFunctionPdfGeneration(
      htmlBundle,
      invoice.invoice_number,
      invoiceId,
      invoice.lab_id,
      template.page_size || 'A4',
      template.letterhead_space_mm || 0,
      !!template.letterhead_image_url
    );

    // 7. Update invoice record
    await updateInvoiceWithPdf(
      invoiceId,
      pdfUrl,
      template.id,
      invoice.invoice_number,
      invoice.lab_id,
      options.triggerNotification !== false && !invoice.whatsapp_sent_at
    );

    return pdfUrl;
  } catch (error) {
    console.error('Invoice PDF generation failed:', error);
    throw error;
  }
}

/**
 * Generate Consolidated Invoice PDF
 */
export async function generateConsolidatedInvoicePDF(
  consolidatedInvoiceId: string,
  labId: string
): Promise<string> {
  try {
    // 1. Fetch consolidated invoice data with linked invoices
    const data = await fetchConsolidatedInvoiceData(consolidatedInvoiceId);
    if (!data) throw new Error('Consolidated invoice not found');

    // 2. Fetch lab details
    const { data: lab } = await supabase.from('labs').select('*').eq('id', labId).single();

    // 3. Prefer the lab's B2B template (patient-wise layout); fall back to the default.
    const template = (await fetchB2BTemplate(labId)) || (await fetchDefaultTemplate(labId));
    const html = template
      ? await buildConsolidatedInvoiceHtmlBundle(data, lab, template)
      : buildConsolidatedInvoiceHtml(data, lab);

    // 4. Generate PDF via Edge Function
    const filename = `CONSOLIDATED-${data.billing_period}-${(data.account_name || 'Account').replace(/\s+/g, '-')}`;
    const pdfUrl = await callEdgeFunctionPdfGeneration(
      html,
      filename,
      consolidatedInvoiceId, // Using consolidated ID as invoice ID for storage
      labId,
      template?.page_size || 'A4',
      template?.letterhead_space_mm || 0,
      !!template?.letterhead_image_url
    );

    // 5. Update record? (Optional, maybe store URL if schema supported it)
    // For now just return URL
    return pdfUrl;
  } catch (error) {
    console.error('Consolidated PDF generation failed:', error);
    throw error;
  }
}

/**
 * Amount received against a consolidated (B2B account) invoice.
 * Mirrors the allocation shown in Monthly Account Billing: payments booked
 * against this invoice count directly; account-level payments that name no
 * invoice are allocated to the account's invoices oldest-first.
 */
async function computeConsolidatedAmountPaid(consolidated: any): Promise<number> {
  const totalAmount = Number(consolidated.total_amount || 0);
  if (!consolidated.account_id) return 0;

  const [{ data: accountInvoices }, { data: payments }] = await Promise.all([
    supabase
      .from('consolidated_invoices')
      .select('id, total_amount, billing_period_start, created_at')
      .eq('account_id', consolidated.account_id),
    supabase
      .from('credit_transactions')
      .select('amount, reference_type, reference_id')
      .eq('account_id', consolidated.account_id)
      .eq('transaction_type', 'payment'),
  ]);

  const paymentRows = payments || [];
  const sumFor = (invoiceId: string) =>
    paymentRows
      .filter((p: any) => p.reference_type === 'consolidated_invoice' && p.reference_id === invoiceId)
      .reduce((sum: number, p: any) => sum + Number(p.amount || 0), 0);

  const directPaid = sumFor(consolidated.id);

  let unassignedPool = paymentRows
    .filter((p: any) => p.reference_type !== 'consolidated_invoice')
    .reduce((sum: number, p: any) => sum + Number(p.amount || 0), 0);

  const chronological = [...(accountInvoices || [])].sort((a: any, b: any) =>
    String(a.billing_period_start).localeCompare(String(b.billing_period_start)) ||
    String(a.created_at || '').localeCompare(String(b.created_at || ''))
  );

  let allocatedToThis = 0;
  for (const current of chronological) {
    const remaining = Math.max(0, Number(current.total_amount || 0) - sumFor(current.id));
    const allocated = Math.min(unassignedPool, remaining);
    unassignedPool -= allocated;
    if (current.id === consolidated.id) {
      allocatedToThis = allocated;
      break;
    }
  }

  return Math.min(totalAmount, directPaid + allocatedToThis);
}

async function fetchConsolidatedInvoiceData(id: string) {
  const { data: consolidated, error } = await supabase
    .from('consolidated_invoices')
    .select('*, account:accounts!consolidated_invoices_account_id_fkey(name, address_line1, address_line2, city, state, pincode, billing_phone, billing_email, gst_number)')
    .eq('id', id)
    .single();

  if (error || !consolidated) return null;

  // Fetch linked invoices
  const { data: invoices } = await supabase
    .from('invoices')
    .select('*, patient:patients(name, age, age_unit, gender, date_of_birth), invoice_items(*, package:packages(name))')
    .eq('consolidated_invoice_id', id)
    .order('invoice_date');

  const invoiceList = invoices || [];

  // B2B account invoices are created per order without invoice_items rows, so the
  // patient-wise blocks would collapse to a single "invoice total" line. Pull the
  // tests straight from order_tests for those (read-only — no rows are written).
  const missingItems = invoiceList.filter(
    (inv: any) => (!inv.invoice_items || inv.invoice_items.length === 0) && inv.order_id
  );
  if (missingItems.length > 0) {
    const orderIds = Array.from(new Set(missingItems.map((inv: any) => inv.order_id)));
    const { data: orderTests } = await supabase
      .from('order_tests')
      // order_tests has two FKs to packages, so the embed must name the constraint
      .select('id, order_id, test_name, price, is_canceled, package:packages!order_tests_package_id_fkey(name)')
      .in('order_id', orderIds);

    const testsByOrder = new Map<string, any[]>();
    (orderTests || [])
      .filter((t: any) => !t.is_canceled)
      .forEach((t: any) => {
        const bucket = testsByOrder.get(t.order_id) || [];
        bucket.push({
          test_name: t.test_name,
          package: t.package || null,
          quantity: 1,
          price: Number(t.price || 0),
          discount_amount: 0,
          total: Number(t.price || 0),
        });
        testsByOrder.set(t.order_id, bucket);
      });

    missingItems.forEach((inv: any) => {
      const derived = testsByOrder.get(inv.order_id);
      if (derived && derived.length > 0) inv.invoice_items = derived;
    });
  }

  const totalAmount = Number(consolidated.total_amount || 0);
  const amountPaid = await computeConsolidatedAmountPaid(consolidated);

  // Normalize field names for template consumption
  const normalized = {
    ...consolidated,
    account_name: consolidated.account?.name || 'Account',
    account_address: formatAccountAddress(consolidated.account),
    account_email: consolidated.account?.billing_email || '',
    account_phone: consolidated.account?.billing_phone || '',
    account_gst: consolidated.account?.gst_number || '',
    // billing_period_start is YYYY-MM-DD, derive readable period
    billing_period: (() => {
      const d = new Date(consolidated.billing_period_start);
      return d.toLocaleDateString('en-IN', { year: 'numeric', month: 'long' });
    })(),
    // Map DB column names to template names
    total_discount: consolidated.discount_amount || 0,
    tax: consolidated.tax_amount || 0,
    total: totalAmount,
    amount_paid: amountPaid,
    balance_due: Math.max(0, totalAmount - amountPaid),
    invoices: invoiceList,
    invoice_count: invoiceList.length,
    patient_count: (() => {
      const uniquePatients = new Set(
        invoiceList.map((inv: any) => inv.patient_id || inv.patient?.name || inv.patient_name || inv.id)
      );
      return uniquePatients.size;
    })(),
  };

  return normalized;
}

async function buildConsolidatedInvoiceHtmlBundle(
  data: any,
  lab: any,
  template: InvoiceTemplate
): Promise<string> {
  let html = template.gjs_html || getDefaultInvoiceHtml();
  let css = template.gjs_css || getDefaultInvoiceCss();

  const placeholders: Record<string, string> = {
    '{{invoice_number}}': data.invoice_number || 'N/A',
    '{{invoice_date}}': formatDate(data.created_at || new Date().toISOString()),
    '{{due_date}}': data.due_date ? formatDate(data.due_date) : '',
    '{{billing_period}}': data.billing_period || '',
    '{{billing_period_start}}': data.billing_period_start ? formatDate(data.billing_period_start) : '',
    '{{billing_period_end}}': data.billing_period_end ? formatDate(data.billing_period_end) : '',
    '{{patient_name}}': data.account_name || 'Account',
    '{{patient_phone}}': data.account_phone || '',
    '{{patient_email}}': data.account_email || '',
    '{{patient_address}}': data.account_address || '',
    '{{doctor}}': '',
    '{{subtotal}}': formatCurrency(data.subtotal || 0),
    '{{discount}}': formatCurrency(data.total_discount || 0),
    '{{tax}}': formatCurrency(data.tax || 0),
    '{{cgst}}': formatCurrency((data.tax || 0) / 2),
    '{{sgst}}': formatCurrency((data.tax || 0) / 2),
    '{{total}}': formatCurrency(data.total || 0),
    '{{grand_total}}': formatCurrency(data.total || 0),
    '{{amount_in_words}}': amountToIndianWords(data.total || 0),
    '{{total_amount_in_words}}': amountToIndianWords(data.total || 0),
    '{{grand_total_in_words}}': amountToIndianWords(data.total || 0),
    '{{amount_paid}}': formatCurrency(data.amount_paid || 0),
    '{{balance_due}}': formatCurrency(
      data.balance_due != null ? data.balance_due : (data.total || 0)
    ),
    '{{payment_type}}': 'Bill to Account',
    '{{payment_status}}': String(data.status || 'sent').toUpperCase(),
    '{{lab_name}}': lab?.name || '',
    '{{lab_address}}': lab?.address || '',
    '{{lab_phone}}': lab?.phone || '',
    '{{lab_email}}': lab?.email || '',
    '{{lab_license}}': lab?.license_number || '',
    '{{lab_registration}}': lab?.registration_number || '',
    '{{lab_gst}}': lab?.gst_number || '',
    '{{lab_upi}}': (lab as any)?.upi_id || (lab as any)?.bank_details?.upi_id || template.bank_details?.upi_id || '',
    '{{notes}}': data.notes || '',
    '{{current_date}}': formatDate(new Date().toISOString()),
    '{{invoice_time}}': data.created_at
      ? new Date(data.created_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })
      : '',
    '{{invoice_datetime}}': data.created_at
      ? `${new Date(data.created_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })} ${new Date(data.created_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })}`
      : '',
    '{{account_name}}': data.account_name || '',
    '{{account_address}}': data.account_address || '',
    '{{account_phone}}': data.account_phone || '',
    '{{account_email}}': data.account_email || '',
    '{{account_gst}}': data.account_gst || '',
    '{{invoice_count}}': String(data.invoice_count || 0),
    '{{patient_count}}': String(data.patient_count || 0),
  };

  Object.entries(placeholders).forEach(([key, value]) => {
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    html = html.replace(new RegExp(escapedKey, 'g'), value);
  });

  const consolidatedRowsHtml = buildConsolidatedInvoiceRows(data.invoices || []);
  const patientBlocksHtml = buildPatientServiceBlocks(data.invoices || []);
  html = html.replace(/{{consolidated_invoice_rows}}/g, consolidatedRowsHtml);
  html = html.replace(/{{invoice_items}}/g, consolidatedRowsHtml);
  html = html.replace(/{{b2b_patient_blocks}}/g, patientBlocksHtml);
  html = html.replace(/{{patient_service_blocks}}/g, patientBlocksHtml);
  html = html.replace(/{{patient_item_blocks}}/g, patientBlocksHtml);

  if (template.include_payment_terms && template.payment_terms_text) {
    html = html.replace(/{{payment_terms}}/g, `
      <div class="payment-terms">
        <h4>Payment Terms</h4>
        <p>${template.payment_terms_text}</p>
      </div>
    `);
  } else {
    html = html.replace(/{{payment_terms}}/g, '');
  }

  if (template.include_bank_details && template.bank_details) {
    html = html.replace(/{{bank_details}}/g, buildBankDetailsHtml(template.bank_details));
  } else {
    html = html.replace(/{{bank_details}}/g, '');
  }

  html = html.replace(/{{upi_qr_code}}/g, '');
  html = html.replace(/{{partial_badge}}/g, '');
  html = html.replace(
    /{{payment_status_badge}}/g,
    `<div class="payment-status-badge pending">${String(data.status || 'sent').toUpperCase()}</div>`
  );
  html = html.replace(/{{tax_disclaimer}}/g, template.tax_disclaimer || '');

  const badgeCss = `
    .payment-status-badge { display: inline-block; padding: 8px 16px; border-radius: 4px; font-weight: bold; font-size: 14px; }
    .payment-status-badge.pending { background: #fff3cd; color: #856404; border: 1px solid #ffeeba; }
  `;

  const pageSize = template.page_size || 'A4';
  const letterheadUrl = template.letterhead_image_url;

  // Letterhead background mode — same technique as single-invoice PDFs so the
  // image repeats on every page of a multi-patient bill.
  if (letterheadUrl) {
    const PAGE_DIM: Record<string, { w: string; h: string }> = {
      A4: { w: '210mm', h: '297mm' },
      A5: { w: '148mm', h: '210mm' },
      Letter: { w: '216mm', h: '279mm' },
    };
    const dim = PAGE_DIM[pageSize] || PAGE_DIM['A4'];
    const topMm = template.letterhead_space_mm || 40;
    const botMm = template.letterhead_bottom_mm || 20;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Invoice ${data.invoice_number || ''}</title>
  <style>
    @page { size: ${pageSize}; margin: 0; }
    html, body { margin: 0; padding: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    #inv-lh-bg {
      position: fixed;
      top: 0; left: 0;
      width: ${dim.w}; height: ${dim.h};
      z-index: 0; pointer-events: none;
      background-image: url('${letterheadUrl}');
      background-repeat: no-repeat;
      background-position: top center;
      background-size: cover;
      -webkit-print-color-adjust: exact; print-color-adjust: exact;
    }
    #inv-content-wrap { position: relative; z-index: 1; }
    ${badgeCss}
    ${css}
  </style>
</head>
<body>
  <div id="inv-lh-bg"></div>
  <table style="width:100%;border:none;border-collapse:collapse;position:relative;z-index:1;">
    <thead style="display:table-header-group;">
      <tr><td style="border:none;padding:0;"><div style="height:${topMm}mm;"></div></td></tr>
    </thead>
    <tfoot style="display:table-footer-group;">
      <tr><td style="border:none;padding:0;"><div style="height:${botMm}mm;"></div></td></tr>
    </tfoot>
    <tbody>
      <tr><td style="border:none;padding:0 6mm;">
        <div id="inv-content-wrap">${html}</div>
      </td></tr>
    </tbody>
  </table>
</body>
</html>`;
  }

  const topMargin = template.letterhead_space_mm ? `${template.letterhead_space_mm}mm` : '5mm';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Invoice ${data.invoice_number || ''}</title>
  <style>
    @page { size: ${pageSize}; margin: 5mm; margin-top: ${topMargin}; }
    ${badgeCss}
    ${css}
  </style>
</head>
<body>
  ${html}
</body>
</html>`;
}

function buildConsolidatedInvoiceRows(invoices: any[]): string {
  if (!invoices || invoices.length === 0) {
    return '<tr><td colspan="4">No items</td></tr>';
  }

  return invoices.map((inv: any) => `
    <tr>
      <td>${inv.patient?.name || inv.patient_name || 'Unknown'}<br><span style="font-size:11px;color:#666;">${inv.invoice_number || '-'}</span></td>
      <td style="text-align:center;">1</td>
      <td style="text-align:right;">${formatCurrency(inv.subtotal || inv.total || 0)}</td>
      <td style="text-align:right;">${formatCurrency(inv.total || 0)}</td>
    </tr>
  `).join('');
}

function formatPatientAgeGender(patient: any): string {
  if (!patient) return '';
  const genderRaw: string = patient.gender || '';
  const gender = genderRaw
    ? genderRaw.charAt(0).toUpperCase() + genderRaw.slice(1).toLowerCase()
    : '';

  let ageStr = '';
  if (patient.date_of_birth) {
    const birthDate = new Date(patient.date_of_birth);
    const today = new Date();
    let age = today.getFullYear() - birthDate.getFullYear();
    const m = today.getMonth() - birthDate.getMonth();
    if (m < 0 || (m === 0 && today.getDate() < birthDate.getDate())) age--;
    if (age >= 0) ageStr = `${age} yrs`;
  }
  if (!ageStr && patient.age != null) {
    ageStr = `${patient.age} ${patient.age_unit || 'yrs'}`;
  }

  if (gender && ageStr) return `${ageStr} / ${gender}`;
  return gender || ageStr;
}

function buildPatientServiceBlocks(invoices: any[]): string {
  if (!invoices || invoices.length === 0) {
    return '<div class="patient-service-empty">No patient services found</div>';
  }

  return invoices.map((inv: any, index: number) => {
    const items = Array.isArray(inv.invoice_items) ? inv.invoice_items : [];
    const serviceRows = items.length > 0
      ? items.map((item: any, itemIndex: number) => {
          const packageName = item.package?.name || item.package_name || '';
          const itemName = item.test_name || item.name || 'Service';
          const label = packageName
            ? `${escapeHtml(itemName)}<div class="patient-item-package">Package: ${escapeHtml(packageName)}</div>`
            : escapeHtml(itemName);
          const itemDiscount = Number(item.discount_amount || 0);
          const rate = Number(item.price || 0);
          const qty = Number(item.quantity || 1);
          const amount = item.total != null ? Number(item.total) : rate * qty - itemDiscount;
          return `
            <tr>
              <td style="text-align:center;">${itemIndex + 1}</td>
              <td>${label}</td>
              <td style="text-align:center;">${qty}</td>
              <td style="text-align:right;">${formatCurrency(rate)}</td>
              <td style="text-align:right;">${itemDiscount > 0 ? `-${formatCurrency(itemDiscount)}` : '-'}</td>
              <td style="text-align:right;">${formatCurrency(amount)}</td>
            </tr>
          `;
        }).join('')
      : `
        <tr>
          <td style="text-align:center;">1</td>
          <td>${escapeHtml(inv.invoice_number || 'Laboratory Services')}</td>
          <td style="text-align:center;">1</td>
          <td style="text-align:right;">${formatCurrency(Number(inv.subtotal || inv.total || 0))}</td>
          <td style="text-align:right;">-</td>
          <td style="text-align:right;">${formatCurrency(Number(inv.total || 0))}</td>
        </tr>
      `;

    const patientTotal = Number(inv.total || 0);
    const patientName = inv.patient?.name || inv.patient_name || 'Unknown Patient';
    const ageGender = formatPatientAgeGender(inv.patient);
    const testCount = items.length || 1;
    const metaParts = [
      `Invoice: ${escapeHtml(inv.invoice_number || '-')}`,
      inv.invoice_date ? `Date: ${formatDate(inv.invoice_date)}` : '',
      ageGender ? escapeHtml(ageGender) : '',
      `${testCount} test${testCount === 1 ? '' : 's'}`,
    ].filter(Boolean);

    return `
      <div class="patient-service-block">
        <div class="patient-service-head">
          <div>
            <div class="patient-service-index">Patient ${index + 1}</div>
            <div class="patient-service-name">${escapeHtml(patientName)}</div>
            <div class="patient-service-meta">${metaParts.join(' &nbsp;|&nbsp; ')}</div>
          </div>
          <div class="patient-service-total">
            <span>Patient Amount</span>
            <strong>${formatCurrency(patientTotal)}</strong>
          </div>
        </div>
        <table class="patient-service-items">
          <thead>
            <tr>
              <th style="width:6%; text-align:center;">#</th>
              <th style="width:46%;">Test / Package</th>
              <th style="width:8%; text-align:center;">Qty</th>
              <th style="width:14%; text-align:right;">Rate (₹)</th>
              <th style="width:12%; text-align:right;">Disc.</th>
              <th style="width:14%; text-align:right;">Amount (₹)</th>
            </tr>
          </thead>
          <tbody>${serviceRows}</tbody>
          <tfoot>
            <tr>
              <td colspan="5" style="text-align:right;">Patient Total</td>
              <td style="text-align:right;">${formatCurrency(patientTotal)}</td>
            </tr>
          </tfoot>
        </table>
        <div class="patient-service-words">Amount in words: ${amountToIndianWords(patientTotal)}</div>
      </div>
    `;
  }).join('');
}

function buildConsolidatedInvoiceHtml(data: any, lab: any): string {
  const fmt = (n: any) => `₹${(parseFloat(n) || 0).toFixed(2)}`;
  const fmtDate = (d: string) => new Date(d).toLocaleDateString('en-IN');

  const rows = (data.invoices || []).map((inv: any, index: number) => `
    <tr>
      <td>${index + 1}</td>
      <td>${fmtDate(inv.invoice_date)}</td>
      <td>${inv.invoice_number || '-'}</td>
      <td>${inv.patient?.name || inv.patient_name || 'Unknown'}</td>
      <td style="text-align:right">${fmt(inv.subtotal)}</td>
      <td style="text-align:right">${fmt(inv.total_discount)}</td>
      <td style="text-align:right">${fmt(inv.tax)}</td>
      <td style="text-align:right"><strong>${fmt(inv.total)}</strong></td>
    </tr>
  `).join('');

  const periodEnd = fmtDate(data.billing_period_end);
  const dueDate = data.due_date ? fmtDate(data.due_date) : '-';

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, sans-serif; font-size: 13px; color: #222; padding: 32px; }
  .top { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 28px; }
  .lab-name { font-size: 20px; font-weight: bold; color: #1a56db; }
  .lab-sub { font-size: 12px; color: #555; margin-top: 4px; }
  .inv-title { text-align: right; }
  .inv-title h2 { font-size: 18px; color: #1a56db; letter-spacing: 1px; }
  .inv-title p { font-size: 12px; color: #555; margin-top: 3px; }
  .parties { display: flex; justify-content: space-between; background: #f8f9fa; border: 1px solid #e5e7eb; border-radius: 6px; padding: 16px; margin-bottom: 24px; }
  .party h4 { font-size: 11px; text-transform: uppercase; color: #888; margin-bottom: 6px; letter-spacing: 0.5px; }
  .party p { font-size: 13px; }
  .party .name { font-weight: bold; font-size: 15px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 20px; font-size: 12px; }
  thead tr { background: #1a56db; color: white; }
  th { padding: 9px 10px; text-align: left; font-weight: 600; }
  td { padding: 8px 10px; border-bottom: 1px solid #f0f0f0; }
  tbody tr:nth-child(even) { background: #fafafa; }
  .totals-wrap { display: flex; justify-content: flex-end; }
  .totals { width: 300px; border: 1px solid #e5e7eb; border-radius: 6px; overflow: hidden; }
  .totals table { margin: 0; font-size: 13px; }
  .totals td { border-bottom: 1px solid #f0f0f0; padding: 8px 12px; }
  .totals .grand { background: #1a56db; color: white; font-size: 14px; font-weight: bold; }
  .footer { margin-top: 40px; text-align: center; font-size: 11px; color: #999; border-top: 1px solid #eee; padding-top: 12px; }
  .badge { display: inline-block; background: #dcfce7; color: #166534; border-radius: 4px; padding: 2px 8px; font-size: 11px; font-weight: bold; }
</style>
</head>
<body>

<div class="top">
  <div>
    <div class="lab-name">${lab?.name || 'Laboratory'}</div>
    <div class="lab-sub">${lab?.address || ''}</div>
    <div class="lab-sub">Ph: ${lab?.phone || ''} &nbsp;|&nbsp; ${lab?.email || ''}</div>
    ${lab?.gst_number ? `<div class="lab-sub">GST: ${lab.gst_number}</div>` : ''}
  </div>
  <div class="inv-title">
    <h2>CONSOLIDATED INVOICE</h2>
    <p><strong>${data.invoice_number}</strong></p>
    <p>Period: <strong>${data.billing_period}</strong></p>
    <p>Due: <strong>${dueDate}</strong></p>
    <span class="badge">${(data.status || 'sent').toUpperCase()}</span>
  </div>
</div>

<div class="parties">
  <div class="party">
    <h4>Bill To</h4>
    <p class="name">${data.account_name}</p>
    ${data.account_address ? `<p>${data.account_address}</p>` : ''}
    ${data.account_phone ? `<p>Ph: ${data.account_phone}</p>` : ''}
    ${data.account_gst ? `<p>GST: ${data.account_gst}</p>` : ''}
  </div>
  <div class="party" style="text-align:right">
    <h4>Period End</h4>
    <p><strong>${periodEnd}</strong></p>
    <p style="margin-top:8px;font-size:12px;color:#555">${(data.invoices || []).length} order(s)</p>
    <p style="font-size:12px;color:#555">${data.notes || ''}</p>
  </div>
</div>

<table>
  <thead>
    <tr>
      <th>#</th><th>Date</th><th>Inv #</th><th>Patient</th>
      <th style="text-align:right">Subtotal</th>
      <th style="text-align:right">Discount</th>
      <th style="text-align:right">Tax</th>
      <th style="text-align:right">Amount</th>
    </tr>
  </thead>
  <tbody>${rows}</tbody>
</table>

<div class="totals-wrap">
  <div class="totals">
    <table>
      <tr><td>Subtotal</td><td style="text-align:right">${fmt(data.subtotal)}</td></tr>
      <tr><td>Discount</td><td style="text-align:right">- ${fmt(data.total_discount)}</td></tr>
      <tr><td>Tax</td><td style="text-align:right">${fmt(data.tax)}</td></tr>
      <tr class="grand"><td>Grand Total</td><td style="text-align:right">${fmt(data.total)}</td></tr>
    </table>
  </div>
</div>

<div class="footer">
  <p>This is a system-generated consolidated invoice. &nbsp;|&nbsp; ${lab?.name || ''} &nbsp;|&nbsp; Generated: ${new Date().toLocaleDateString('en-IN')}</p>
</div>
</body>
</html>`;
}

async function fetchInvoiceData(invoiceId: string): Promise<Invoice | null> {
  const { data, error } = await supabase
    .from('invoices')
    .select(`
      *,
      lab:labs(name, address, phone, email, license_number, registration_number, upi_id, bank_details, gst_number),
      patient:patients(name, phone, email, address, date_of_birth, age, age_unit, gender, custom_fields),
      account:accounts(name, billing_mode, address_line1, address_line2, city, state, pincode, billing_phone, billing_email, gst_number),
      invoice_items(*, package:packages(name)),
      location:locations(id, name, address, phone, email, contact_person, upi_id, bank_details),
      referring_doctor:doctors(name)
    `)
    .eq('id', invoiceId)
    .single();

  if (error) {
    console.error('Failed to fetch invoice:', error);
    throw new Error(`Failed to fetch invoice: ${error.message}`);
  }

  const invoice = data as Invoice;

  // Always use live patient name from the patients table, not the stored snapshot
  if ((data as any).patient?.name) {
    invoice.patient_name = (data as any).patient.name;
  }

  // Populate doctor name — try invoice join first, then fall back to the order
  (invoice as any).doctor = (data as any).referring_doctor?.name || '';
  if (!(invoice as any).doctor && invoice.order_id) {
    const { data: orderData } = await supabase
      .from('orders')
      .select('referring_doctor:doctors(name)')
      .eq('id', invoice.order_id)
      .single();
    (invoice as any).doctor = (orderData as any)?.referring_doctor?.name || '';
  }

  // Consolidate all invoice_items across every invoice for the same order so
  // charges billed on a separate invoice still appear in one PDF.
  // Source 1: invoice_items sharing the same order_id (tests on a later invoice)
  // Source 2: invoice_items linked via order_billing_item_id (charges whose
  //           invoice_item ended up with a different order_id)
  // The DB trigger trg_link_invoice_item_to_billing_item ensures invoice_item_id
  // is always written back to order_billing_items on insert, so no synthesis needed.
  if (invoice.order_id) {
    // Fetch all sibling invoices for this order (needed for both items and financials)
    const { data: allOrderInvoices } = await supabase
      .from('invoices')
      .select('id, subtotal, discount, tax, total, amount_paid')
      .eq('order_id', invoice.order_id);

    const siblingInvoiceIds = (allOrderInvoices || []).map((inv: any) => inv.id);

    const { data: billingItems } = await supabase
      .from('order_billing_items')
      .select('id')
      .eq('order_id', invoice.order_id)
      .eq('is_invoiced', true);

    const billingItemIds = (billingItems || []).map((b: any) => b.id);

    // Source 1: items where invoice_items.order_id matches (populated on newer records)
    // Source 2: items belonging to any sibling invoice by invoice_id (catches items
    //           where invoice_items.order_id is null — older records or separate invoices)
    // Source 3: items linked via order_billing_item_id
    const queries: Promise<any>[] = [
      supabase.from('invoice_items').select('*').eq('order_id', invoice.order_id),
    ];
    if (siblingInvoiceIds.length > 0) {
      queries.push(
        supabase.from('invoice_items').select('*').in('invoice_id', siblingInvoiceIds)
      );
    }
    if (billingItemIds.length > 0) {
      queries.push(
        supabase.from('invoice_items').select('*').in('order_billing_item_id', billingItemIds)
      );
    }

    const results = await Promise.all(queries);
    const seen = new Set<string>();
    const allItems: any[] = [];
    for (const { data } of results) {
      for (const item of (data || [])) {
        if (!seen.has(item.id)) {
          seen.add(item.id);
          allItems.push(item);
        }
      }
    }

    if (allItems.length > 0) {
      invoice.invoice_items = allItems;
    }

    // Recalculate ALL financials by summing across every invoice for this order.
    // This ensures discount, paid, subtotal and total are always consistent with
    // the consolidated item list regardless of which invoice triggered the PDF.
    if (allOrderInvoices && allOrderInvoices.length > 0) {
      invoice.subtotal    = allOrderInvoices.reduce((s: number, inv: any) => s + (parseFloat(inv.subtotal)    || 0), 0);
      invoice.discount    = allOrderInvoices.reduce((s: number, inv: any) => s + (parseFloat(inv.discount)    || 0), 0);
      invoice.tax         = allOrderInvoices.reduce((s: number, inv: any) => s + (parseFloat(inv.tax)         || 0), 0);
      invoice.total       = allOrderInvoices.reduce((s: number, inv: any) => s + (parseFloat(inv.total)       || 0), 0);
      invoice.amount_paid = allOrderInvoices.reduce((s: number, inv: any) => s + (parseFloat(inv.amount_paid) || 0), 0);
    }
  }

  return invoice;
}

/**
 * Fetch template by ID
 */
async function fetchTemplateById(templateId: string): Promise<InvoiceTemplate | null> {
  const { data, error } = await supabase
    .from('invoice_templates')
    .select('*')
    .eq('id', templateId)
    .eq('is_active', true)
    .single();

  if (error) {
    console.error('Failed to fetch template:', error);
    return null;
  }

  return data;
}

/**
 * Fetch the lab's B2B (corporate/account) invoice template.
 * Used for consolidated account invoices, which render patient-wise blocks.
 */
async function fetchB2BTemplate(labId: string): Promise<InvoiceTemplate | null> {
  const { data } = await supabase
    .from('invoice_templates')
    .select('*')
    .eq('lab_id', labId)
    .eq('category', 'b2b')
    .eq('is_active', true)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  return data || null;
}

/**
 * Fetch default template for lab
 */
async function fetchDefaultTemplate(labId: string): Promise<InvoiceTemplate | null> {
  const { data, error } = await supabase
    .from('invoice_templates')
    .select('*')
    .eq('lab_id', labId)
    .eq('is_default', true)
    .eq('is_active', true)
    .single();

  if (error || !data) {
    // Fallback: get any active template for this lab
    const { data: fallback } = await supabase
      .from('invoice_templates')
      .select('*')
      .eq('lab_id', labId)
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    return fallback || null;
  }

  return data;
}

/**
 * Build HTML bundle with template and invoice data (async for QR generation)
 */
async function buildInvoiceHtmlBundle(invoice: Invoice, template: InvoiceTemplate): Promise<string> {
  let html = template.gjs_html || getDefaultInvoiceHtml();
  let css = template.gjs_css || getDefaultInvoiceCss();

  // Calculate balance due
  const balanceDue = invoice.total - invoice.amount_paid;
  const isPaid = balanceDue <= 0;

  // Generate UPI QR Code if location/lab has UPI ID and balance is due
  let upiQrHtml = '';
  // Location-wise UPI: Check location first, then fall back to lab, then template
  const locationUpiId = (invoice as any).location?.upi_id || (invoice as any).location?.bank_details?.upi_id;
  const labUpiId = (invoice.lab as any)?.upi_id || (invoice.lab as any)?.bank_details?.upi_id || template.bank_details?.upi_id;
  const effectiveUpiId = locationUpiId || labUpiId;
  
  if (effectiveUpiId && isValidUPIId(effectiveUpiId) && !isPaid && balanceDue > 0) {
    try {
      // Use location name if location has UPI, else use lab name
      const payeeName = locationUpiId 
        ? ((invoice as any).location?.name || invoice.lab?.name || 'Lab') 
        : (invoice.lab?.name || 'Lab');
      upiQrHtml = await generateUPIPaymentBlock({
        upiId: effectiveUpiId,
        payeeName,
        amount: balanceDue,
        transactionNote: `INV-${invoice.invoice_number}`,
      }, {
        size: 140,
        showAmount: true,
        showUpiId: true,
        title: 'Scan to Pay via UPI',
      });
    } catch (qrError) {
      console.error('UPI QR generation failed:', qrError);
    }
  }

  // Calculate GST split (for B2B invoices)
  const gstAmount = invoice.tax || 0;
  const cgst = gstAmount / 2;
  const sgst = gstAmount / 2;

  // Get location data for placeholders
  const location = (invoice as any).location;

  // Replace basic placeholders
  const accountAddress = formatAccountAddress(invoice.account);
  const accountPhone = invoice.account?.billing_phone || '';
  const accountEmail = invoice.account?.billing_email || '';
  const accountGst = invoice.account?.gst_number || '';

  const placeholders: Record<string, string> = {
    '{{invoice_number}}': invoice.invoice_number || 'N/A',
    '{{invoice_date}}': formatDate(invoice.invoice_date),
    '{{due_date}}': formatDate(invoice.due_date),
    // For account invoices, show Account Name in Bill To section, with Patient Name below
    '{{patient_name}}': invoice.account 
      ? `${invoice.account.name}<br><span style="font-size: 0.9em; font-weight: normal;">Patient: ${invoice.patient_name}</span>`
      : (invoice.patient_name || 'N/A'),
    '{{patient_phone}}': invoice.account ? accountPhone : (invoice.patient?.phone || ''),
    '{{patient_email}}': invoice.account ? accountEmail : (invoice.patient?.email || ''),
    '{{patient_address}}': invoice.account ? accountAddress : (invoice.patient?.address || ''),
    '{{patient_gender}}': (invoice.patient as any)?.gender || '',
    '{{patient_age}}': (() => {
      const dob = (invoice.patient as any)?.date_of_birth;
      if (dob) {
        const birthDate = new Date(dob);
        const today = new Date();
        let age = today.getFullYear() - birthDate.getFullYear();
        const m = today.getMonth() - birthDate.getMonth();
        if (m < 0 || (m === 0 && today.getDate() < birthDate.getDate())) age--;
        if (age >= 0) return `${age} yrs`;
      }
      const age = (invoice.patient as any)?.age;
      const ageUnit = (invoice.patient as any)?.age_unit || 'years';
      return age != null ? `${age} ${ageUnit}` : '';
    })(),
    '{{patient_age_gender}}': (() => {
      const genderRaw: string = (invoice.patient as any)?.gender || '';
      const gender = genderRaw
        ? genderRaw.charAt(0).toUpperCase() + genderRaw.slice(1).toLowerCase()
        : '';
      const dob = (invoice.patient as any)?.date_of_birth;
      let ageStr = '';
      if (dob) {
        const birthDate = new Date(dob);
        const today = new Date();
        let age = today.getFullYear() - birthDate.getFullYear();
        const m = today.getMonth() - birthDate.getMonth();
        if (m < 0 || (m === 0 && today.getDate() < birthDate.getDate())) age--;
        if (age >= 0) ageStr = `${age} yrs`;
      }
      if (!ageStr) {
        const age = (invoice.patient as any)?.age;
        const ageUnit = (invoice.patient as any)?.age_unit || 'yrs';
        ageStr = age != null ? `${age} ${ageUnit}` : '';
      }
      if (gender && ageStr) return `${gender} / ${ageStr}`;
      return gender || ageStr;
    })(),
    '{{doctor}}': invoice.doctor || '',
    '{{subtotal}}': formatCurrency(invoice.subtotal),
    '{{discount}}': formatCurrency(invoice.discount),
    '{{tax}}': formatCurrency(invoice.tax),
    '{{cgst}}': formatCurrency(cgst),
    '{{sgst}}': formatCurrency(sgst),
    '{{total}}': formatCurrency(invoice.total),
    '{{grand_total}}': formatCurrency(invoice.total),
    '{{amount_in_words}}': amountToIndianWords(invoice.total),
    '{{total_amount_in_words}}': amountToIndianWords(invoice.total),
    '{{grand_total_in_words}}': amountToIndianWords(invoice.total),
    '{{amount_paid}}': formatCurrency(invoice.amount_paid),
    // If account is monthly billing, Balance Due is effectively 0 for the patient (handled by account)
    '{{balance_due}}': (invoice.account && invoice.account.billing_mode === 'monthly') 
      ? formatCurrency(0) // or 'Billed to Account'
      : formatCurrency(balanceDue),
    '{{payment_type}}': invoice.account ? 'Bill to Account' : formatPaymentType(invoice.payment_type),
    '{{payment_status}}': isPaid ? 'PAID' : 'PENDING',
    '{{account_name}}': invoice.account?.name || '',
    '{{account_address}}': accountAddress,
    '{{account_phone}}': accountPhone,
    '{{account_email}}': accountEmail,
    '{{account_gst}}': accountGst,
    // Present so B2B/account templates render cleanly for a single invoice too
    '{{billing_period}}': (() => {
      const period = (invoice as any).billing_period;
      if (!period) return formatDate(invoice.invoice_date);
      const match = /^(\d{4})-(\d{2})$/.exec(String(period));
      if (!match) return String(period);
      const d = new Date(Number(match[1]), Number(match[2]) - 1, 1);
      return d.toLocaleDateString('en-IN', { year: 'numeric', month: 'long' });
    })(),
    '{{patient_count}}': '1',
    '{{invoice_count}}': '1',
    '{{lab_name}}': invoice.lab?.name || '',
    '{{lab_address}}': invoice.lab?.address || '',
    '{{lab_phone}}': invoice.lab?.phone || '',
    '{{lab_email}}': invoice.lab?.email || '',
    '{{lab_license}}': invoice.lab?.license_number || '',
    '{{lab_registration}}': invoice.lab?.registration_number || '',
    '{{lab_gst}}': (invoice.lab as any)?.gst_number || '',
    '{{lab_upi}}': effectiveUpiId || '',
    // Location placeholders (collection center / branch)
    '{{location_name}}': location?.name || '',
    '{{location_address}}': location?.address || '',
    '{{location_phone}}': location?.phone || '',
    '{{location_email}}': location?.email || '',
    '{{location_upi}}': locationUpiId || '',
    '{{location_contact}}': location?.contact_person || '',
    '{{notes}}': invoice.notes || '',
    '{{current_date}}': formatDate(new Date().toISOString()),
    '{{invoice_time}}': (() => {
      const ts = (invoice as any).created_at || invoice.invoice_date;
      if (!ts) return '';
      return new Date(ts).toLocaleTimeString('en-IN', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
      });
    })(),
    '{{invoice_datetime}}': (() => {
      const ts = (invoice as any).created_at || invoice.invoice_date;
      if (!ts) return '';
      const d = new Date(ts);
      return `${d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })} ${d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })}`;
    })(),
  };

  // Replace all placeholders (escape regex special chars so {{ }} are treated literally)
  Object.entries(placeholders).forEach(([key, value]) => {
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    html = html.replace(new RegExp(escapedKey, 'g'), value);
  });

  // Build invoice items table
  const itemsHtml = buildInvoiceItemsTable(invoice.invoice_items || []);
  const patientBlocksHtml = buildPatientServiceBlocks([invoice]);
  html = html.replace(/{{invoice_items}}/g, itemsHtml);
  html = html.replace(/{{b2b_patient_blocks}}/g, patientBlocksHtml);
  html = html.replace(/{{patient_service_blocks}}/g, patientBlocksHtml);
  html = html.replace(/{{patient_item_blocks}}/g, patientBlocksHtml);

  // Add payment terms if enabled
  if (template.include_payment_terms && template.payment_terms_text) {
    const paymentTermsHtml = `
      <div class="payment-terms">
        <h4>Payment Terms</h4>
        <p>${template.payment_terms_text}</p>
      </div>
    `;
    html = html.replace(/{{payment_terms}}/g, paymentTermsHtml);
  } else {
    html = html.replace(/{{payment_terms}}/g, '');
  }

  // Add bank details if enabled
  if (template.include_bank_details && template.bank_details) {
    const bankHtml = buildBankDetailsHtml(template.bank_details);
    html = html.replace(/{{bank_details}}/g, bankHtml);
  } else {
    html = html.replace(/{{bank_details}}/g, '');
  }

  // Add UPI QR Code block
  if (upiQrHtml) {
    html = html.replace(/{{upi_qr_code}}/g, upiQrHtml);
  } else {
    html = html.replace(/{{upi_qr_code}}/g, '');
  }

  // Add tax disclaimer if present
  if (template.tax_disclaimer) {
    html = html.replace(/{{tax_disclaimer}}/g, template.tax_disclaimer);
  } else {
    html = html.replace(/{{tax_disclaimer}}/g, '');
  }

  // Partial invoice indicator
  if (invoice.is_partial) {
    const partialBadge = '<div class="partial-invoice-badge">PARTIAL INVOICE</div>';
    html = html.replace(/{{partial_badge}}/g, partialBadge);
  } else {
    html = html.replace(/{{partial_badge}}/g, '');
  }

  // Payment status badge
  const statusBadge = isPaid 
    ? '<div class="payment-status-badge paid">✓ PAID</div>'
    : '<div class="payment-status-badge pending">PAYMENT PENDING</div>';
  html = html.replace(/{{payment_status_badge}}/g, statusBadge);

  // Replace custom field tokens: {{custom.field_key}}
  // Patient custom_fields are merged in (invoice-level values take priority)
  const patientCustomFields = (invoice.patient as any)?.custom_fields || {};
  const customFields = { ...patientCustomFields, ...(invoice.custom_fields || {}) };
  Object.entries(customFields).forEach(([key, value]) => {
    const safeKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    html = html.replace(new RegExp(`{{custom\\.${safeKey}}}`, 'g'), String(value ?? ''));
  });
  // Clear any remaining unmatched {{custom.*}} tokens so they don't render literally
  html = html.replace(/\{\{custom\.[^}]+\}\}/g, '');

  // Add status badge CSS
  const statusBadgeCss = `
    .payment-status-badge {
      display: inline-block;
      padding: 8px 16px;
      border-radius: 4px;
      font-weight: bold;
      font-size: 14px;
    }
    .payment-status-badge.paid {
      background: #d4edda;
      color: #155724;
      border: 1px solid #c3e6cb;
    }
    .payment-status-badge.pending {
      background: #fff3cd;
      color: #856404;
      border: 1px solid #ffeeba;
    }
    .upi-payment-block {
      page-break-inside: avoid;
    }
  `;

  const pageSize = template.page_size || 'A4';
  const letterheadUrl = template.letterhead_image_url;

  // ── LETTERHEAD BACKGROUND MODE ──────────────────────────────────────────
  // When an image URL is set, use the position:fixed background + HTML table
  // spacer technique so the image shows through on every page (same as reports).
  if (letterheadUrl) {
    const PAGE_DIM: Record<string, { w: string; h: string }> = {
      A4: { w: '210mm', h: '297mm' },
      A5: { w: '148mm', h: '210mm' },
      Letter: { w: '216mm', h: '279mm' },
    };
    const dim = PAGE_DIM[pageSize] || PAGE_DIM['A4'];
    const topMm = template.letterhead_space_mm || 40;
    const botMm = template.letterhead_bottom_mm || 20;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Invoice ${invoice.invoice_number}</title>
  <style>
    @page { size: ${pageSize}; margin: 0; }
    html, body { margin: 0; padding: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    /* Full-page letterhead background — position:fixed repeats on every PDF page */
    #inv-lh-bg {
      position: fixed;
      top: 0; left: 0;
      width: ${dim.w}; height: ${dim.h};
      z-index: 0; pointer-events: none;
      background-image: url('${letterheadUrl}');
      background-repeat: no-repeat;
      background-position: top center;
      background-size: cover;
      -webkit-print-color-adjust: exact; print-color-adjust: exact;
    }
    #inv-content-wrap { position: relative; z-index: 1; }
    ${statusBadgeCss}
    ${css}
  </style>
</head>
<body>
  <div id="inv-lh-bg"></div>
  <!-- Table spacer technique: thead/tfoot repeat on every page, creating
       consistent header/footer space that aligns with the letterhead image -->
  <table style="width:100%;border:none;border-collapse:collapse;position:relative;z-index:1;">
    <thead style="display:table-header-group;">
      <tr><td style="border:none;padding:0;"><div style="height:${topMm}mm;"></div></td></tr>
    </thead>
    <tfoot style="display:table-footer-group;">
      <tr><td style="border:none;padding:0;"><div style="height:${botMm}mm;"></div></td></tr>
    </tfoot>
    <tbody>
      <tr><td style="border:none;padding:0 6mm;">
        <div id="inv-content-wrap">${html}</div>
      </td></tr>
    </tbody>
  </table>
</body>
</html>`;
  }

  // ── STANDARD MODE (no letterhead image) ─────────────────────────────────
  const topMargin = template.letterhead_space_mm ? `${template.letterhead_space_mm}mm` : '5mm';
  const pageSizeCss = `@page { size: ${pageSize}; margin: 5mm; }\n`;
  const letterheadCss = `@page { margin-top: ${topMargin}; }\n`;

  return `
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Invoice ${invoice.invoice_number}</title>
        <style>${pageSizeCss}${statusBadgeCss}${css}${letterheadCss}</style>
      </head>
      <body>
        ${html}
      </body>
    </html>
  `;
}

/**
 * Build invoice items table HTML
 */
function buildInvoiceItemsTable(items: InvoiceItem[]): string {
  if (!items || items.length === 0) {
    return '<tr><td colspan="4">No items</td></tr>';
  }

  const testItems = items.filter(i => i.item_type !== 'lab_charge');
  const chargeItems = items.filter(i => i.item_type === 'lab_charge');

  const renderRow = (item: InvoiceItem, isCharge = false) => `
    <tr${isCharge ? ' style="background:#fffbeb;"' : ''}>
      <td>${item.test_name}${isCharge ? ' <span style="font-size:10px;color:#92400e;background:#fef3c7;padding:1px 5px;border-radius:3px;margin-left:4px;">Charge</span>' : ''}</td>
      <td style="text-align: center;">${item.quantity}</td>
      <td style="text-align: right;">₹${item.price.toFixed(2)}</td>
      <td style="text-align: right;">₹${item.total.toFixed(2)}</td>
    </tr>
  `;

  const rows: string[] = [];
  testItems.forEach(item => rows.push(renderRow(item, false)));

  if (chargeItems.length > 0) {
    rows.push(`<tr><td colspan="4" style="padding:4px 8px;background:#fffbeb;font-size:11px;font-weight:600;color:#92400e;border-top:1px solid #fde68a;">Additional Charges</td></tr>`);
    chargeItems.forEach(item => rows.push(renderRow(item, true)));
  }

  return rows.join('');
}

/**
 * Build bank details HTML
 */
function buildBankDetailsHtml(bankDetails: InvoiceTemplate['bank_details']): string {
  if (!bankDetails) return '';

  return `
    <div class="bank-details">
      <h4>Bank Details for Payment</h4>
      <table style="width: 100%; font-size: 14px;">
        ${bankDetails.account_name ? `<tr><td><strong>Account Name:</strong></td><td>${bankDetails.account_name}</td></tr>` : ''}
        ${bankDetails.account_number ? `<tr><td><strong>Account Number:</strong></td><td>${bankDetails.account_number}</td></tr>` : ''}
        ${bankDetails.ifsc ? `<tr><td><strong>IFSC Code:</strong></td><td>${bankDetails.ifsc}</td></tr>` : ''}
        ${bankDetails.bank_name ? `<tr><td><strong>Bank Name:</strong></td><td>${bankDetails.bank_name}</td></tr>` : ''}
        ${bankDetails.upi_id ? `<tr><td><strong>UPI ID:</strong></td><td>${bankDetails.upi_id}</td></tr>` : ''}
      </table>
    </div>
  `;
}

/**
 * Edge Function to generate PDF and upload to storage
 * This keeps PDF.co API key secure on the server side
 */
async function callEdgeFunctionPdfGeneration(
  html: string,
  filename: string,
  invoiceId: string,
  labId: string,
  pageSize: string = 'A4',
  letterheadSpaceMm: number = 0,
  hasLetterhead: boolean = false
): Promise<string> {
  // Get auth token for edge function call
  const { data: { session } } = await supabase.auth.getSession();
  
  if (!session?.access_token) {
    throw new Error('User not authenticated');
  }

  const response = await fetch(PDF_GENERATION_FUNCTION_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({
      html,
      filename, // Just the invoice number (e.g., INV-20251218-O001-ABC123), edge function adds .pdf
      invoiceId,
      labId,
      pageSize,
      letterheadSpaceMm,
      hasLetterhead,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Edge function error: ${response.status} - ${errorText}`);
  }

  const result = await response.json();

  if (!result.success) {
    throw new Error(`PDF generation failed: ${result.error || 'Unknown error'}`);
  }

  return result.pdfUrl;
}

/**
 * Note: PDF upload is now handled by the edge function
 * This function is no longer needed but kept for reference
 */

/**
 * Update invoice record with PDF URL and metadata
 */
async function updateInvoiceWithPdf(
  invoiceId: string,
  pdfUrl: string,
  templateId: string,
  invoiceNumber: string,
  labId: string,
  shouldTriggerNotification: boolean = true
): Promise<void> {
  const { error } = await supabase
    .from('invoices')
    .update({
      pdf_url: pdfUrl,
      pdf_generated_at: new Date().toISOString(),
      template_id: templateId,
      invoice_number: invoiceNumber,
      updated_at: new Date().toISOString(),
    })
    .eq('id', invoiceId);

  if (error) {
    console.error('Failed to update invoice:', error);
    throw new Error(`Failed to update invoice: ${error.message}`);
  }

  // Trigger invoice generated notification (async, don't block response)
  if (shouldTriggerNotification) {
    notificationTriggerService.triggerInvoiceGenerated(invoiceId, pdfUrl, labId)
      .catch(err => console.error('Error triggering invoice generation notification:', err));
  }
}

/**
 * Generate invoice number (INV-YYYY-NNNN or INV-YYYY-NNNN-PN for partials)
 */
async function generateInvoiceNumber(invoice: Invoice): Promise<string> {
  const year = new Date(invoice.invoice_date).getFullYear();
  
  // If partial invoice, get parent invoice number and add suffix
  if (invoice.is_partial && invoice.parent_invoice_id) {
    const { data: parentInvoice } = await supabase
      .from('invoices')
      .select('invoice_number')
      .eq('id', invoice.parent_invoice_id)
      .single();

    if (parentInvoice?.invoice_number) {
      // Count existing partial invoices for this parent
      const { data: partialInvoices } = await supabase
        .from('invoices')
        .select('invoice_number')
        .eq('parent_invoice_id', invoice.parent_invoice_id)
        .not('invoice_number', 'is', null);

      const partialCount = (partialInvoices?.length || 0) + 1;
      return `${parentInvoice.invoice_number}-P${partialCount}`;
    }
  }

  // B2B/Account Invoice (multiple orders) - use account-based numbering
  if (invoice.invoice_type === 'account' && invoice.account_id) {
    // Get account code for unique identifier
    const { data: account } = await supabase
      .from('accounts')
      .select('code, name')
      .eq('id', invoice.account_id)
      .single();
    
    const accountCode = account?.code || account?.name?.substring(0, 6).toUpperCase() || invoice.account_id.substring(0, 6).toUpperCase();
    
    // Get last invoice number for this account/year combination
    const { data: lastInvoice } = await supabase
      .from('invoices')
      .select('invoice_number')
      .eq('account_id', invoice.account_id)
      .eq('invoice_type', 'account')
      .like('invoice_number', `INV-ACC${accountCode}-${year}-%`)
      .not('invoice_number', 'ilike', '%-P%') // Exclude partial invoices
      .order('created_at', { ascending: false })
      .maybeSingle();

    let nextSequence = 1;
    if (lastInvoice?.invoice_number) {
      const parts = lastInvoice.invoice_number.split('-');
      const lastSequence = parseInt(parts[parts.length - 1]) || 0;
      nextSequence = lastSequence + 1;
    }

    return `INV-ACC${accountCode}-${year}-${String(nextSequence).padStart(4, '0')}`;
  }

  // Patient/Self Invoice (single order) - use order-based numbering with date and unique ID
  const orderId = invoice.order_id;
  if (!orderId) {
    throw new Error('Cannot generate invoice number: Patient invoice must be linked to an order');
  }

  // Format: INV-YYYYMMDD-O{order_display}-{order_id_short}
  // Example: INV-20251218-O001-a1b2c3d4
  // Note: Order numbers (001, 002) reset daily and can be same across labs
  // So we include: date + order display + unique order ID suffix for global uniqueness
  
  // Get order display number and order date
  const { data: order } = await supabase
    .from('orders')
    .select('order_display, order_number, order_date')
    .eq('id', orderId)
    .single();
  
  const orderDisplay = order?.order_display || order?.order_number?.toString().padStart(3, '0') || '000';
  
  // Format date as YYYYMMDD
  const invoiceDate = new Date(invoice.invoice_date);
  const dateStr = `${invoiceDate.getFullYear()}${String(invoiceDate.getMonth() + 1).padStart(2, '0')}${String(invoiceDate.getDate()).padStart(2, '0')}`;
  
  // Use last 8 characters of order ID for uniqueness (globally unique across all labs)
  const orderIdShort = orderId.substring(orderId.length - 8).toUpperCase();
  
  // Check if invoice already exists for this order
  const { data: existingInvoice } = await supabase
    .from('invoices')
    .select('invoice_number')
    .eq('order_id', orderId)
    .not('invoice_number', 'is', null)
    .not('invoice_number', 'ilike', '%-P%') // Exclude partial invoices
    .order('created_at', { ascending: false })
    .maybeSingle();

  // If invoice already exists for this order, add a sequence suffix
  if (existingInvoice?.invoice_number) {
    // Count existing invoices for this order
    const { data: orderInvoices } = await supabase
      .from('invoices')
      .select('invoice_number')
      .eq('order_id', orderId)
      .not('invoice_number', 'ilike', '%-P%');
    
    const invoiceCount = (orderInvoices?.length || 0) + 1;
    return `INV-${dateStr}-O${orderDisplay}-${orderIdShort}-${invoiceCount}`;
  }

  return `INV-${dateStr}-O${orderDisplay}-${orderIdShort}`;
}

/**
 * Financial validation before PDF generation
 */
async function validateInvoiceForPdf(invoice: Invoice): Promise<void> {
  // 1. Check if invoice has items
  if (!invoice.invoice_items || invoice.invoice_items.length === 0) {
    throw new Error('Cannot generate PDF: Invoice has no line items');
  }

  // 2. Validate financial totals
  const itemsTotal = invoice.invoice_items.reduce((sum, item) => sum + item.total, 0);
  const expectedSubtotal = itemsTotal;

  if (Math.abs(invoice.subtotal - expectedSubtotal) > 0.01) {
    console.warn(`Invoice subtotal mismatch: ${invoice.subtotal} vs calculated ${expectedSubtotal}`);
  }

  // 3. Validate partial invoice constraints
  if (invoice.is_partial) {
    if (!invoice.parent_invoice_id) {
      throw new Error('Partial invoice must have parent_invoice_id');
    }

    // Check parent invoice exists and total is valid
    const { data: parentInvoice } = await supabase
      .from('invoices')
      .select('total, amount_paid')
      .eq('id', invoice.parent_invoice_id)
      .single();

    if (!parentInvoice) {
      throw new Error('Parent invoice not found');
    }

    // Get sum of all partial invoices
    const { data: allPartials } = await supabase
      .from('invoices')
      .select('total')
      .eq('parent_invoice_id', invoice.parent_invoice_id)
      .eq('is_partial', true);

    const totalPartials = allPartials?.reduce((sum, p) => sum + p.total, 0) || 0;

    // Validate not over-invoicing
    if (totalPartials > parentInvoice.total) {
      throw new Error(
        `Partial invoices total (₹${totalPartials}) exceeds parent invoice total (₹${parentInvoice.total})`
      );
    }
  }

  // 4. Check if amount_paid exceeds total
  if (invoice.amount_paid > invoice.total + 0.01) {
    throw new Error(
      `Amount paid (₹${invoice.amount_paid}) exceeds invoice total (₹${invoice.total})`
    );
  }

  // 5. Validate status consistency
  if (invoice.status === 'Paid' && invoice.amount_paid < invoice.total - 0.01) {
    console.warn(`Invoice marked as Paid but amount_paid (₹${invoice.amount_paid}) < total (₹${invoice.total})`);
  }
}

// Helper functions
function formatDate(dateString: string): string {
  const date = new Date(dateString);
  return date.toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

function formatCurrency(amount: number): string {
  return `₹${amount.toFixed(2)}`;
}

function amountToIndianWords(amount: number): string {
  const safeAmount = Math.max(0, Number(amount) || 0);
  const rupees = Math.floor(safeAmount);
  const paise = Math.round((safeAmount - rupees) * 100);
  const rupeeWords = numberToIndianWords(rupees);
  const paiseWords = paise > 0 ? ` and ${numberToIndianWords(paise)} Paise` : '';
  return `${rupeeWords} Rupees${paiseWords} Only`;
}

function numberToIndianWords(value: number): string {
  const ones = [
    'Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
    'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen',
    'Seventeen', 'Eighteen', 'Nineteen',
  ];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

  const belowHundred = (num: number): string => {
    if (num < 20) return ones[num];
    const ten = Math.floor(num / 10);
    const one = num % 10;
    return one ? `${tens[ten]} ${ones[one]}` : tens[ten];
  };

  const belowThousand = (num: number): string => {
    if (num < 100) return belowHundred(num);
    const hundred = Math.floor(num / 100);
    const rest = num % 100;
    return rest ? `${ones[hundred]} Hundred ${belowHundred(rest)}` : `${ones[hundred]} Hundred`;
  };

  if (value === 0) return 'Zero';

  const parts: string[] = [];
  const crore = Math.floor(value / 10000000);
  value %= 10000000;
  const lakh = Math.floor(value / 100000);
  value %= 100000;
  const thousand = Math.floor(value / 1000);
  value %= 1000;

  if (crore) parts.push(`${belowThousand(crore)} Crore`);
  if (lakh) parts.push(`${belowThousand(lakh)} Lakh`);
  if (thousand) parts.push(`${belowThousand(thousand)} Thousand`);
  if (value) parts.push(belowThousand(value));

  return parts.join(' ');
}

function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatPaymentType(type: string): string {
  const types: Record<string, string> = {
    self: 'Self Pay',
    credit: 'Credit Account',
    insurance: 'Insurance',
    corporate: 'Corporate',
  };
  return types[type] || type;
}

function formatAccountAddress(account?: {
  address_line1?: string;
  address_line2?: string;
  city?: string;
  state?: string;
  pincode?: string;
} | null): string {
  return [
    account?.address_line1,
    account?.address_line2,
    account?.city,
    account?.state,
    account?.pincode,
  ].filter(Boolean).join(', ');
}

/**
 * Default invoice HTML template (fallback)
 */
function getDefaultInvoiceHtml(): string {
  return `
    <div class="invoice-container">
      <div class="invoice-header">
        <h1>{{lab_name}}</h1>
        <p>{{lab_address}}</p>
        <p>Phone: {{lab_phone}} | Email: {{lab_email}}</p>
        <p>License: {{lab_license}}</p>
      </div>
      
      {{partial_badge}}
      
      <div class="invoice-title">
        <h2>INVOICE</h2>
        <p><strong>Invoice #:</strong> {{invoice_number}}</p>
        <p><strong>Date:</strong> {{invoice_date}}</p>
        <p><strong>Due Date:</strong> {{due_date}}</p>
      </div>
      
      <div class="patient-info">
        <h3>Bill To:</h3>
        <p><strong>{{patient_name}}</strong></p>
        <p>{{patient_address}}</p>
        <p>Phone: {{patient_phone}}</p>
        <p>Doctor: {{doctor}}</p>
      </div>
      
      <table class="invoice-items">
        <thead>
          <tr>
            <th>Test Name</th>
            <th>Qty</th>
            <th>Price</th>
            <th>Total</th>
          </tr>
        </thead>
        <tbody>
          {{invoice_items}}
        </tbody>
      </table>
      
      <div class="invoice-totals">
        <table>
          <tr><td>Subtotal:</td><td>{{subtotal}}</td></tr>
          <tr><td>Discount:</td><td>-{{discount}}</td></tr>
          <tr><td>Tax (GST):</td><td>{{tax}}</td></tr>
          <tr class="total-row"><td><strong>Total:</strong></td><td><strong>{{total}}</strong></td></tr>
          <tr><td>Amount Paid:</td><td>{{amount_paid}}</td></tr>
          <tr class="balance-row"><td><strong>Balance Due:</strong></td><td><strong>{{balance_due}}</strong></td></tr>
        </table>
      </div>
      
      {{payment_terms}}
      {{bank_details}}
      
      {{upi_qr_code}}
      
      <div class="invoice-footer">
        <p>{{tax_disclaimer}}</p>
        <p><em>Thank you for your business!</em></p>
      </div>
    </div>
  `;
}

/**
 * Default invoice CSS (fallback)
 */
function getDefaultInvoiceCss(): string {
  return `
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #333; }
    .invoice-container { max-width: 800px; margin: 0 auto; padding: 20px; }
    .invoice-header { text-align: center; border-bottom: 2px solid #333; padding-bottom: 20px; margin-bottom: 20px; }
    .invoice-header h1 { font-size: 24px; margin-bottom: 10px; }
    .invoice-title { text-align: right; margin-bottom: 30px; }
    .invoice-title h2 { font-size: 28px; color: #0066cc; }
    .patient-info { margin-bottom: 30px; padding: 15px; background: #f5f5f5; border-radius: 5px; }
    .invoice-items { width: 100%; border-collapse: collapse; margin-bottom: 30px; }
    .invoice-items th, .invoice-items td { border: 1px solid #ddd; padding: 10px; text-align: left; }
    .invoice-items th { background: #0066cc; color: white; font-weight: bold; }
    .invoice-totals { margin-left: auto; width: 300px; }
    .invoice-totals table { width: 100%; }
    .invoice-totals td { padding: 8px; border-bottom: 1px solid #eee; }
    .total-row { font-size: 18px; background: #f5f5f5; }
    .balance-row { font-size: 16px; color: #cc0000; }
    .payment-terms, .bank-details { margin: 20px 0; padding: 15px; background: #f9f9f9; border-left: 4px solid #0066cc; }
    .invoice-footer { margin-top: 40px; text-align: center; font-size: 12px; color: #666; }
    .partial-invoice-badge { position: absolute; top: 20px; right: 20px; background: #ff9800; color: white; padding: 10px 20px; font-weight: bold; transform: rotate(10deg); }
    .upi-payment-block { margin: 20px 0; padding: 20px; background: linear-gradient(135deg, #f0f8ff 0%, #e8f5e9 100%); border: 2px dashed #4caf50; border-radius: 10px; text-align: center; }
    .upi-payment-block h3 { margin-bottom: 15px; color: #2e7d32; font-size: 18px; }
    .upi-payment-block img { max-width: 150px; height: auto; margin: 10px 0; border: 4px solid white; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
    .upi-payment-block .upi-id { font-family: monospace; background: white; padding: 8px 16px; border-radius: 5px; display: inline-block; margin: 10px 0; font-size: 14px; border: 1px solid #ddd; }
    .upi-payment-block .upi-apps { font-size: 12px; color: #666; margin-top: 10px; }
    .upi-payment-block .balance-amount { font-size: 20px; font-weight: bold; color: #d32f2f; margin: 10px 0; }
    .payment-status-badge { display: inline-block; padding: 6px 14px; border-radius: 20px; font-weight: bold; font-size: 12px; text-transform: uppercase; }
    .payment-status-badge.paid { background: #e8f5e9; color: #2e7d32; border: 2px solid #4caf50; }
    .payment-status-badge.pending { background: #fff3e0; color: #e65100; border: 2px solid #ff9800; }
  `;
}
