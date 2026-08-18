-- B2B Detailed Invoice: patient-wise tests and amounts for every lab.
--
-- The seeded B2B template rendered {{invoice_items}}, which on a consolidated
-- account bill collapses to one row per patient (no tests) and on a single
-- invoice shows only that one patient. This replaces the layout for ALL labs
-- with the patient-block layout driven by {{b2b_patient_blocks}}, which lists
-- every patient with each test, rate, discount and amount, plus a per-patient
-- total. Previous HTML/CSS is kept in invoice_template_html_backups.

-- 1. Backup table (service-role only; no policies -> not reachable via PostgREST)
CREATE TABLE IF NOT EXISTS public.invoice_template_html_backups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id uuid NOT NULL,
  lab_id uuid,
  template_name text,
  category text,
  gjs_html text,
  gjs_css text,
  reason text,
  backed_up_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.invoice_template_html_backups ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_invoice_template_html_backups_template
  ON public.invoice_template_html_backups (template_id, backed_up_at DESC);

INSERT INTO public.invoice_template_html_backups
  (template_id, lab_id, template_name, category, gjs_html, gjs_css, reason)
SELECT id, lab_id, template_name, category, gjs_html, gjs_css, 'pre-patient-wise-b2b-layout'
FROM public.invoice_templates
WHERE category = 'b2b'
  AND COALESCE(gjs_html, '') NOT LIKE '%b2b_patient_blocks%';

-- 2. Apply the patient-wise layout to every lab's B2B template
UPDATE public.invoice_templates
SET
  template_description = 'Corporate/account invoice — patient-wise tests, rates and amounts with GST summary',
  gjs_html = $html$
<div class="b2b-invoice">
  <div class="inv-head">
    <div class="inv-head-left">
      <h1>{{lab_name}}</h1>
      <p>{{lab_address}}</p>
      <p>Phone: {{lab_phone}} &nbsp;|&nbsp; Email: {{lab_email}}</p>
      <p><strong>GSTIN:</strong> {{lab_gst}} &nbsp;&nbsp; <strong>Reg. No:</strong> {{lab_license}}</p>
    </div>
    <div class="inv-head-right">
      <div class="doc-type">TAX INVOICE</div>
      <p class="doc-no">{{invoice_number}}</p>
      <p class="doc-date">Date: {{invoice_date}}</p>
      {{partial_badge}}
    </div>
  </div>

  <div class="inv-parties">
    <div class="party-box">
      <h3>Bill To</h3>
      <p class="party-name">{{account_name}}</p>
      <p>{{account_address}}</p>
      <p>Phone: {{account_phone}}</p>
      <p>Email: {{account_email}}</p>
      <p><strong>GSTIN:</strong> {{account_gst}}</p>
    </div>
    <div class="party-box">
      <h3>Invoice Details</h3>
      <table class="kv-table">
        <tr><td>Invoice No</td><td><strong>{{invoice_number}}</strong></td></tr>
        <tr><td>Invoice Date</td><td>{{invoice_date}}</td></tr>
        <tr><td>Billing Period</td><td>{{billing_period}}</td></tr>
        <tr><td>Due Date</td><td>{{due_date}}</td></tr>
        <tr><td>Payment Type</td><td>{{payment_type}}</td></tr>
        <tr><td>Patients / Bills</td><td>{{patient_count}} / {{invoice_count}}</td></tr>
      </table>
    </div>
  </div>

  <div class="section-title">Patient-wise Tests &amp; Charges</div>
  <div class="patient-section">
    {{b2b_patient_blocks}}
  </div>

  <div class="totals-section">
    <div class="totals-left">
      <div class="words-box">
        <h4>Amount in Words</h4>
        <p>{{amount_in_words}}</p>
      </div>
      <div class="notes-box">
        <h4>Notes &amp; Remarks</h4>
        <p>{{notes}}</p>
      </div>
    </div>
    <div class="totals-right">
      <table class="amount-table">
        <tr><td>Subtotal</td><td>{{subtotal}}</td></tr>
        <tr><td>Less: Discount</td><td>-{{discount}}</td></tr>
        <tr><td>CGST @ 9%</td><td>{{cgst}}</td></tr>
        <tr><td>SGST @ 9%</td><td>{{sgst}}</td></tr>
        <tr><td>Total GST</td><td>{{tax}}</td></tr>
        <tr class="grand-total"><td>Grand Total</td><td>{{grand_total}}</td></tr>
        <tr class="paid-row"><td>Amount Paid</td><td>{{amount_paid}}</td></tr>
        <tr class="balance-row"><td>Balance Due</td><td>{{balance_due}}</td></tr>
      </table>
    </div>
  </div>

  <div class="terms-bank-section">
    <div>{{payment_terms}}</div>
    <div>{{bank_details}}</div>
  </div>

  <div class="declaration">
    <p><strong>Declaration:</strong> {{tax_disclaimer}}</p>
    <p>We declare that this invoice shows the actual price of the services described and that all particulars are true and correct.</p>
  </div>

  <div class="signature-section">
    <div class="signature-box">
      <p>For <strong>{{lab_name}}</strong></p>
      <div class="signature-line"></div>
      <p>Authorized Signatory</p>
    </div>
  </div>

  <div class="b2b-footer">
    <p>This is a system-generated invoice. Generated on {{current_date}}</p>
    <p><em>Thank you for your business partnership!</em></p>
  </div>
</div>
$html$,
  gjs_css = $css$
* { box-sizing: border-box; }
body { margin: 0; padding: 0; font-family: Arial, Helvetica, sans-serif; color: #1f2937; background: #fff; }
.b2b-invoice { max-width: 210mm; margin: 0 auto; padding: 12mm; font-size: 11.5px; line-height: 1.45; }

.inv-head { display: flex; justify-content: space-between; gap: 20px; border-bottom: 2px solid #111827; padding-bottom: 12px; margin-bottom: 14px; }
.inv-head-left h1 { margin: 0 0 5px; font-size: 22px; }
.inv-head-left p { margin: 2px 0; color: #374151; }
.inv-head-right { text-align: right; min-width: 180px; }
.doc-type { display: inline-block; border: 1.5px solid #111827; padding: 5px 14px; font-size: 15px; font-weight: bold; letter-spacing: 1px; }
.doc-no { margin: 7px 0 0; font-weight: bold; font-size: 13px; }
.doc-date { margin: 2px 0 0; color: #4b5563; }

.inv-parties { display: grid; grid-template-columns: 1.15fr 1fr; gap: 14px; margin-bottom: 14px; }
.party-box { border: 1px solid #d1d5db; padding: 10px 12px; }
.party-box h3 { margin: 0 0 7px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.4px; color: #111827; border-bottom: 1px solid #e5e7eb; padding-bottom: 4px; }
.party-box p { margin: 2px 0; }
.party-name { font-size: 14px; font-weight: bold; margin-bottom: 4px !important; }
.kv-table { width: 100%; border-collapse: collapse; }
.kv-table td { padding: 3px 0; vertical-align: top; }
.kv-table td:first-child { color: #6b7280; width: 42%; }

.section-title { background: #111827; color: #fff; padding: 7px 12px; font-size: 12px; font-weight: bold; text-transform: uppercase; letter-spacing: 0.5px; }
.patient-section { margin-bottom: 14px; }

.patient-service-block { border: 1px solid #d1d5db; border-top: 0; page-break-inside: avoid; }
.patient-service-head { display: flex; justify-content: space-between; gap: 14px; align-items: flex-start; background: #f3f4f6; border-bottom: 1px solid #d1d5db; padding: 8px 12px; }
.patient-service-index { font-size: 9.5px; color: #6b7280; text-transform: uppercase; font-weight: bold; letter-spacing: 0.4px; }
.patient-service-name { font-size: 14px; font-weight: bold; margin-top: 1px; }
.patient-service-meta { color: #6b7280; margin-top: 2px; font-size: 10.5px; }
.patient-service-total { text-align: right; min-width: 130px; }
.patient-service-total span { display: block; color: #6b7280; font-size: 9.5px; text-transform: uppercase; font-weight: bold; letter-spacing: 0.4px; }
.patient-service-total strong { display: block; font-size: 15px; margin-top: 2px; }
.patient-service-items { width: 100%; border-collapse: collapse; }
.patient-service-items th { background: #fff; border-bottom: 1px solid #d1d5db; padding: 6px 10px; font-size: 10.5px; color: #374151; text-align: left; }
.patient-service-items td { border-bottom: 1px solid #f0f1f3; padding: 6px 10px; vertical-align: top; }
.patient-service-items tbody tr:last-child td { border-bottom: 1px solid #e5e7eb; }
.patient-service-items tfoot td { background: #fafafa; font-weight: bold; padding: 6px 10px; border-bottom: 0; }
.patient-item-package { margin-top: 1px; font-size: 9.5px; color: #6b7280; }
.patient-service-words { border-top: 1px solid #f0f1f3; padding: 5px 10px; font-size: 10px; color: #4b5563; font-style: italic; }
.patient-service-empty { border: 1px solid #d1d5db; border-top: 0; padding: 16px; text-align: center; color: #6b7280; }

.totals-section { display: grid; grid-template-columns: 1fr 250px; gap: 14px; align-items: start; margin-bottom: 14px; }
.words-box, .notes-box { border: 1px solid #d1d5db; padding: 9px 12px; }
.notes-box { margin-top: 10px; }
.words-box h4, .notes-box h4 { margin: 0 0 4px; font-size: 10.5px; text-transform: uppercase; color: #6b7280; letter-spacing: 0.4px; }
.words-box p { margin: 0; font-weight: bold; }
.notes-box p { margin: 0; color: #4b5563; }
.amount-table { width: 100%; border-collapse: collapse; border: 1px solid #111827; }
.amount-table td { padding: 6px 10px; border-bottom: 1px solid #e5e7eb; }
.amount-table td:last-child { text-align: right; font-weight: bold; white-space: nowrap; }
.amount-table td:first-child { color: #4b5563; }
.grand-total td { background: #111827; color: #fff !important; font-size: 13px; }
.grand-total td:first-child { color: #fff !important; }
.paid-row td:last-child { color: #15803d; }
.balance-row td { background: #fff7ed; font-size: 12.5px; }
.balance-row td:last-child { color: #b45309; }

.terms-bank-section { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 12px; }
.payment-terms, .bank-details { border: 1px solid #d1d5db; padding: 9px 12px; height: 100%; }
.payment-terms h4, .bank-details h4 { margin: 0 0 5px; font-size: 10.5px; text-transform: uppercase; color: #6b7280; letter-spacing: 0.4px; }
.payment-terms p { margin: 0; }
.bank-details table { width: 100%; border-collapse: collapse; }
.bank-details td { padding: 2px 0; }

.declaration { border: 1px solid #111827; padding: 8px 12px; font-size: 10.5px; margin-bottom: 12px; }
.declaration p { margin: 2px 0; }
.signature-section { display: flex; justify-content: flex-end; text-align: center; margin-bottom: 10px; }
.signature-line { width: 180px; height: 38px; border-bottom: 1px solid #111827; margin: 4px 0 6px; }
.signature-box p { margin: 0; }
.b2b-footer { text-align: center; border-top: 1px solid #e5e7eb; padding-top: 8px; font-size: 10px; color: #6b7280; }
.b2b-footer p { margin: 2px 0; }
.partial-invoice-badge { display: inline-block; margin-top: 7px; border: 1px solid #b91c1c; color: #b91c1c; padding: 3px 8px; font-size: 10px; font-weight: bold; }
.payment-status-badge { display: inline-block; padding: 4px 10px; font-size: 10px; font-weight: bold; }

@media print {
  .b2b-invoice { padding: 10mm; }
  .patient-service-block { page-break-inside: avoid; }
  .totals-section, .declaration, .signature-section { page-break-inside: avoid; }
}
$css$,
  include_payment_terms = true,
  include_tax_breakdown = true,
  include_bank_details = true,
  page_size = COALESCE(page_size, 'A4'),
  tax_disclaimer = COALESCE(NULLIF(tax_disclaimer, ''), 'GST is applicable as per current CGST/SGST regulations.'),
  payment_terms_text = COALESCE(NULLIF(payment_terms_text, ''), 'Payment terms: Net 30. Bank transfer preferred. Please quote the invoice number with the payment.'),
  updated_at = now()
WHERE category = 'b2b';
