import { supabase } from './supabase';

// PDF.co API configuration
const PDFCO_API_KEY = import.meta.env.VITE_PDFCO_API_KEY || 'landinquiryfirm@gmail.com_AEu7lrDUacQsWOHuJ757dQDYPrJz6XbsYQcX2HrSVXf1LX8cvBn94TPzmfpeVgrT';
const PDFCO_API_URL = 'https://api.pdf.co/v1/pdf/convert/from/html';

// Interfaces from pdfGenerator.ts
export interface LabTemplate {
  id: string;
  name: string;
  header: {
    labName: string;
    address: string;
    phone: string;
    email: string;
    logo?: string;
  };
  footer: {
    signature: string;
    authorizedBy: string;
    disclaimer?: string;
  };
  styling: {
    primaryColor: string;
    secondaryColor: string;
    fontFamily: string;
  };
}

export interface PatientInfo {
  name: string;
  id: string;
  age: number;
  gender: string;
  referredBy?: string;
}

export interface ReportDetails {
  reportId: string;
  collectionDate: string;
  reportDate: string;
  reportType: string;
}

export interface TestResult {
  parameter: string;
  result: string;
  unit: string;
  referenceRange: string;
  flag?: string;
}

export interface ReportData {
  patient: PatientInfo;
  report: ReportDetails;
  testResults: TestResult[];
  interpretation?: string;
  template?: LabTemplate;
}

// Default lab template
export const defaultLabTemplate: LabTemplate = {
  id: 'medilab-default',
  name: 'MediLab Diagnostics Default',
  header: {
    labName: 'MediLab Diagnostics',
    address: '123 Health Street, Medical District, City - 560001',
    phone: '+91 80 1234 5678',
    email: 'reports@medilab.com',
  },
  footer: {
    signature: 'Digital Signature',
    authorizedBy: 'Dr. Sarah Wilson, MD',
    disclaimer: 'This report is generated electronically and is valid without signature.',
  },
  styling: {
    primaryColor: '#2563eb',
    secondaryColor: '#64748b',
    fontFamily: 'Arial, sans-serif',
  },
};

// Template management functions
export const saveLabTemplate = (template: LabTemplate): void => {
  try {
    const templates = getLabTemplates();
    const updatedTemplates = templates.filter(t => t.id !== template.id);
    updatedTemplates.push(template);
    localStorage.setItem('lims_lab_templates', JSON.stringify(updatedTemplates));
  } catch (error) {
    console.error('Error saving lab template:', error);
  }
};

export const getLabTemplates = (): LabTemplate[] => {
  try {
    const templates = localStorage.getItem('lims_lab_templates');
    return templates ? JSON.parse(templates) : [defaultLabTemplate];
  } catch (error) {
    console.error('Error loading lab templates:', error);
    return [defaultLabTemplate];
  }
};

export const getLabTemplate = (id: string): LabTemplate => {
  const templates = getLabTemplates();
  return templates.find(t => t.id === id) || defaultLabTemplate;
};

// Authentication helper - ensures user is authenticated before operations
const ensureAuthenticated = async (): Promise<string | null> => {
  const { data: { session }, error } = await supabase.auth.getSession();
  if (error || !session) {
    console.error('User not authenticated:', error);
    return null;
  }
  return session.user.id;
};

// Enhanced HTML template generator with optional draft watermark
const generateUniversalHTMLTemplate = (data: ReportData, isDraft = false): string => {
  const { patient, report, testResults, interpretation } = data;
  const template = data.template || defaultLabTemplate;
  
  const draftWatermarkCSS = isDraft ? `
    .draft-watermark {
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%) rotate(-45deg);
      font-size: 120px;
      font-weight: bold;
      color: rgba(220, 53, 69, 0.1);
      z-index: -1;
      pointer-events: none;
      user-select: none;
      text-transform: uppercase;
      letter-spacing: 10px;
    }
    .draft-indicator {
      background: #fff3cd;
      border: 2px solid #ffc107;
      border-radius: 8px;
      padding: 15px;
      margin: 20px 0;
      text-align: center;
      color: #856404;
      font-weight: bold;
      font-size: 14px;
    }
  ` : '';
  
  const draftWatermarkHTML = isDraft ? `
    <div class="draft-watermark">DRAFT</div>
    <div class="draft-indicator">
      ⚠️ DRAFT REPORT - Some results may still be pending verification
    </div>
  ` : '';
  
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Lab Report - ${report.reportId}${isDraft ? ' (DRAFT)' : ''}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { 
      font-family: ${template.styling.fontFamily}; 
      padding: 30px; 
      margin: 0;
      color: #333;
      line-height: 1.6;
      font-size: 12px;
      position: relative;
    }
    ${draftWatermarkCSS}
    .header { 
      text-align: center; 
      border-bottom: 3px solid ${template.styling.primaryColor};
      padding-bottom: 20px;
      margin-bottom: 30px;
    }
    .header .lab-name {
      font-size: 28px;
      font-weight: bold;
      color: ${template.styling.primaryColor};
      margin-bottom: 8px;
    }
    .header .lab-info {
      font-size: 12px;
      color: ${template.styling.secondaryColor};
      line-height: 1.4;
    }
    .report-title {
      text-align: center;
      font-size: 20px;
      font-weight: bold;
      color: ${template.styling.primaryColor};
      margin: 25px 0;
      text-transform: uppercase;
      letter-spacing: 1px;
    }
    .info-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 25px;
      margin: 25px 0;
    }
    .info-box {
      background: #f8f9fa;
      padding: 20px;
      border-radius: 8px;
      border-left: 5px solid ${template.styling.primaryColor};
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    .info-title {
      font-weight: bold;
      color: ${template.styling.primaryColor};
      margin-bottom: 15px;
      font-size: 16px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .info-item {
      margin: 8px 0;
      font-size: 13px;
      display: flex;
      justify-content: space-between;
    }
    .info-label {
      font-weight: bold;
      color: ${template.styling.secondaryColor};
      min-width: 120px;
    }
    .info-value {
      color: #333;
      font-weight: 500;
    }
    .results-section {
      margin: 30px 0;
    }
    .section-title {
      font-size: 18px;
      font-weight: bold;
      color: ${template.styling.primaryColor};
      margin-bottom: 15px;
      padding-bottom: 8px;
      border-bottom: 2px solid ${template.styling.primaryColor};
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    table { 
      width: 100%; 
      border-collapse: collapse; 
      margin-top: 15px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
    }
    th, td { 
      border: 1px solid #ddd; 
      padding: 12px 8px; 
      text-align: left;
      font-size: 12px;
    }
    th {
      background: ${template.styling.primaryColor};
      color: white;
      font-weight: bold;
      text-align: center;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      font-size: 11px;
    }
    td {
      text-align: center;
      vertical-align: middle;
    }
    td:first-child {
      text-align: left;
      font-weight: 600;
      color: #333;
    }
    .result-value {
      font-weight: bold;
      font-size: 13px;
    }
    .flag-h {
      color: #dc3545;
      font-weight: bold;
    }
    .flag-l {
      color: #0066cc;
      font-weight: bold;
    }
    .flag-c {
      color: #ff6600;
      font-weight: bold;
    }
    .interpretation-box {
      background: linear-gradient(135deg, #e3f2fd 0%, #f8f9fa 100%);
      padding: 20px;
      border-radius: 8px;
      border-left: 5px solid ${template.styling.primaryColor};
      margin: 30px 0;
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
    }
    .interpretation-title {
      font-weight: bold;
      color: ${template.styling.primaryColor};
      margin-bottom: 12px;
      font-size: 16px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .interpretation-text {
      line-height: 1.6;
      color: #333;
      font-size: 13px;
    }
    .footer {
      margin-top: 50px;
      padding-top: 20px;
      border-top: 2px solid ${template.styling.secondaryColor};
    }
    .signature-section {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 40px;
      margin: 30px 0;
    }
    .signature-box {
      text-align: center;
    }
    .signature-line {
      border-top: 2px solid #333;
      margin-top: 60px;
      padding-top: 8px;
      font-weight: bold;
      font-size: 12px;
    }
    .footer-info {
      text-align: center;
      font-size: 10px;
      color: ${template.styling.secondaryColor};
      margin-top: 20px;
      font-style: italic;
    }
    .generation-info {
      text-align: center;
      font-size: 10px;
      color: ${template.styling.secondaryColor};
      margin-top: 15px;
    }
    @media print {
      body { margin: 0; padding: 15px; }
      .page-break { page-break-before: always; }
      .info-grid { grid-template-columns: 1fr; gap: 15px; }
      .signature-section { grid-template-columns: 1fr; gap: 20px; }
    }
  </style>
</head>
<body>
  ${draftWatermarkHTML}
  <div class="header">
    <div class="lab-name">${template.header.labName}</div>
    <div class="lab-info">
      ${template.header.address}<br>
      Phone: ${template.header.phone} | Email: ${template.header.email}
    </div>
  </div>

  <div class="report-title">Laboratory Report${isDraft ? ' (DRAFT)' : ''}</div>

  <div class="info-grid">
    <div class="info-box">
      <div class="info-title">Patient Information</div>
      <div class="info-item">
        <span class="info-label">Name:</span>
        <span class="info-value">${patient.name}</span>
      </div>
      <div class="info-item">
        <span class="info-label">Patient ID:</span>
        <span class="info-value">${patient.id}</span>
      </div>
      <div class="info-item">
        <span class="info-label">Age:</span>
        <span class="info-value">${patient.age} years</span>
      </div>
      <div class="info-item">
        <span class="info-label">Gender:</span>
        <span class="info-value">${patient.gender}</span>
      </div>
      ${patient.referredBy ? `
      <div class="info-item">
        <span class="info-label">Referred By:</span>
        <span class="info-value">${patient.referredBy}</span>
      </div>
      ` : ''}
    </div>
    
    <div class="info-box">
      <div class="info-title">Report Details</div>
      <div class="info-item">
        <span class="info-label">Report ID:</span>
        <span class="info-value">${report.reportId}</span>
      </div>
      <div class="info-item">
        <span class="info-label">Collection Date:</span>
        <span class="info-value">${new Date(report.collectionDate).toLocaleDateString('en-IN')}</span>
      </div>
      <div class="info-item">
        <span class="info-label">Report Date:</span>
        <span class="info-value">${new Date(report.reportDate).toLocaleDateString('en-IN')}</span>
      </div>
      <div class="info-item">
        <span class="info-label">Test Type:</span>
        <span class="info-value">${report.reportType}</span>
      </div>
    </div>
  </div>

  <div class="results-section">
    <div class="section-title">Test Results</div>
    <table>
      <thead>
        <tr>
          <th style="width: 35%;">Parameter</th>
          <th style="width: 15%;">Result</th>
          <th style="width: 10%;">Unit</th>
          <th style="width: 25%;">Reference Range</th>
          <th style="width: 15%;">Flag</th>
        </tr>
      </thead>
      <tbody>
        ${testResults.map(result => `
          <tr>
            <td>${result.parameter}</td>
            <td class="result-value ${result.flag ? `flag-${result.flag.toLowerCase()}` : ''}">${result.result}</td>
            <td>${result.unit || '-'}</td>
            <td>${result.referenceRange || '-'}</td>
            <td>${result.flag ? `<span class="flag-${result.flag.toLowerCase()}">${result.flag}</span>` : '-'}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  </div>

  ${interpretation ? `
  <div class="interpretation-box">
    <div class="interpretation-title">Clinical Interpretation</div>
    <div class="interpretation-text">${interpretation}</div>
  </div>
  ` : ''}

  <div class="footer">
    <div class="signature-section">
      <div class="signature-box">
        <div class="signature-line">
          Laboratory Technician
        </div>
      </div>
      <div class="signature-box">
        <div class="signature-line">
          ${template.footer.authorizedBy}
        </div>
      </div>
    </div>
    
    ${template.footer.disclaimer ? `
    <div class="footer-info">
      ${template.footer.disclaimer}
    </div>
    ` : ''}
    
    <div class="generation-info">
      Report generated on: ${new Date().toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      })}
    </div>
  </div>
</body>
</html>`;
};

// Enhanced PDF generation with PDF.co API
export const generatePDFWithAPI = async (reportData: ReportData, isDraft = false): Promise<string> => {
  console.log('Generating PDF with PDF.co API...', isDraft ? '(DRAFT)' : '(FINAL)');
  
  if (!PDFCO_API_KEY) {
    throw new Error('PDF.co API key not configured');
  }

  const htmlContent = generateUniversalHTMLTemplate(reportData, isDraft);
  const filename = `${reportData.patient.name.replace(/\s+/g, '_')}_${reportData.report.reportId}${isDraft ? '_DRAFT' : ''}.pdf`;

  const requestBody = {
    name: filename,
    html: htmlContent,
    async: false,
    margins: "15mm",
    paperSize: "A4",
    orientation: "portrait",
    printBackground: true,
    scale: 1.0,
    mediaType: "print",
    displayHeaderFooter: false
  };

  try {
    const response = await fetch(PDFCO_API_URL, {
      method: 'POST',
      headers: {
        'x-api-key': PDFCO_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      throw new Error(`PDF.co API error: ${response.status} ${response.statusText}`);
    }

    const result = await response.json();
    
    if (result.error) {
      throw new Error(`PDF.co API error: ${result.message}`);
    }

    console.log('PDF generated successfully:', result.url);
    return result.url;
  } catch (error) {
    console.error('PDF.co generation failed:', error);
    throw error;
  }
};

// Fallback PDF generation using browser print
export const generatePDFWithBrowser = (reportData: ReportData): string => {
  console.log('Generating PDF with browser fallback...');
  
  const htmlContent = generateUniversalHTMLTemplate(reportData);
  const blob = new Blob([htmlContent], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  
  console.log('Browser PDF blob created');
  return url;
};

// Enhanced Save PDF to Supabase storage - For public bucket
export const savePDFToStorage = async (pdfBlob: Blob, orderId: string): Promise<string> => {
  console.log('Saving PDF to Supabase storage...');

  try {
    // Create a unique filename
    const fileName = `${orderId}_${Date.now()}.pdf`;
    
    console.log('Uploading file:', fileName, 'Size:', pdfBlob.size, 'Type:', pdfBlob.type);

    // Ensure we have a proper PDF blob
    if (!pdfBlob || pdfBlob.size === 0) {
      throw new Error('Invalid PDF blob provided');
    }

    // Ensure blob has correct type
    if (pdfBlob.type !== 'application/pdf') {
      console.log('Converting blob to proper PDF type');
      pdfBlob = new Blob([pdfBlob], { type: 'application/pdf' });
    }

    // Upload the blob directly to Supabase storage
    // This will send raw binary data with proper content-type header
    console.log('Starting upload to Supabase...');
    const { data, error } = await supabase.storage
      .from('reports')
      .upload(fileName, pdfBlob, {
        contentType: 'application/pdf',
        cacheControl: '3600',
        upsert: true
      });

    if (error) {
      console.error('Storage upload error details:', error);
      console.error('Error message:', error.message);
      throw new Error(`Storage upload failed: ${error.message}`);
    }

    console.log('Upload successful, data:', data);

    // Verify the file was uploaded
    if (!data || !data.path) {
      throw new Error('Upload succeeded but no file path returned');
    }

    // Get the public URL for the uploaded file
    const { data: { publicUrl } } = supabase.storage
      .from('reports')
      .getPublicUrl(fileName);

    console.log('PDF saved to storage successfully:', publicUrl);
    
    // Test if the URL is accessible
    try {
      const testResponse = await fetch(publicUrl, { method: 'HEAD' });
      console.log('URL test response status:', testResponse.status);
    } catch (testError) {
      console.warn('URL test failed:', testError);
    }

    return publicUrl;
  } catch (error) {
    console.error('Failed to save PDF to storage:', error);
    throw error;
  }
};

// Update database with PDF information
export const updateReportWithPDFInfo = async (orderId: string, pdfUrl: string, reportType: string = 'final'): Promise<void> => {
  console.log(`Updating database with ${reportType} PDF info...`);
  
  try {
    const { error } = await supabase
      .from('reports')
      .update({
        pdf_url: pdfUrl,
        pdf_generated_at: new Date().toISOString(),
        status: 'completed'
      })
      .eq('order_id', orderId)
      .eq('report_type', reportType);

    if (error) {
      console.error('Database update error:', error);
      throw error;
    }

    console.log(`Database updated successfully for ${reportType} report`);
  } catch (error) {
    console.error('Failed to update database:', error);
    throw error;
  }
};

// Main PDF generation function with comprehensive error handling and progress tracking
export async function generateAndSavePDFReportWithProgress(
  orderId: string, 
  reportData: ReportData,
  onProgress?: (stage: string, progress?: number) => void,
  isDraft = false
): Promise<string | null> {
  console.log('generateAndSavePDFReportWithProgress called for order:', orderId, 'isDraft:', isDraft);
  
  onProgress?.('Checking authentication...', 5);
  
  // Check authentication for database operations only
  const userId = await ensureAuthenticated();
  if (!userId) {
    console.error('User must be authenticated to generate reports');
    onProgress?.('Authentication failed', 0);
    alert('Please login to generate reports');
    return null;
  }
  
  try {
    onProgress?.('Checking existing reports...', 10);
    
    // First, check for existing report of the same type (draft vs final)
    const reportType = isDraft ? 'draft' : 'final';
    let { data: existingReport } = await supabase
      .from('reports')
      .select('id, pdf_url, pdf_generated_at, status, report_type')
      .eq('order_id', orderId)
      .eq('report_type', reportType)
      .maybeSingle(); // Use maybeSingle to avoid errors when no record exists

    // If no report of this type exists, create one
    if (!existingReport) {
      console.log(`No ${reportType} report record exists, creating one...`);
      onProgress?.(`Creating ${reportType} report record...`, 15);
      
      // Get order details to populate report
      const { data: orderData, error: orderError } = await supabase
        .from('orders')
        .select('patient_id, doctor')
        .eq('id', orderId)
        .single();
      
      if (orderError || !orderData) {
        console.error('Failed to fetch order data:', orderError);
        onProgress?.('Order not found', 0);
        alert('Order not found. Please check the order ID.');
        return null;
      }
      
      // Create report record
      const { data: newReport, error: insertError } = await supabase
        .from('reports')
        .insert({
          order_id: orderId,
          patient_id: orderData.patient_id,
          doctor: orderData.doctor || 'Unknown',
          status: 'pending',
          generated_date: new Date().toISOString(),
          report_type: reportType,
          report_status: 'generating'
        })
        .select()
        .single();

      if (insertError) {
        console.error('Failed to create report record:', insertError);
        if (insertError.code === '23505') {
          const { data: retryReport } = await supabase
            .from('reports')
            .select('id, pdf_url, pdf_generated_at, status, report_type')
            .eq('order_id', orderId)
            .eq('report_type', reportType)
            .single();
          existingReport = retryReport;
        } else {
          onProgress?.('Failed to create report record', 0);
          alert('Failed to create report record. Please try again.');
          return null;
        }
      } else {
        existingReport = newReport;
      }
    }

    // Check if PDF already exists and is valid for this specific report type
    if (existingReport?.pdf_url) {
      console.log(`${reportType.toUpperCase()} PDF already exists:`, existingReport.pdf_url);
      onProgress?.(`Validating existing ${reportType} PDF...`, 20);
      
      try {
        const response = await fetch(existingReport.pdf_url, { method: 'HEAD' });
        if (response.ok) {
          console.log(`Existing ${reportType} PDF is valid`);
          onProgress?.(`Using existing ${reportType} PDF`, 100);
          return existingReport.pdf_url;
        }
      } catch (error) {
        console.warn(`Existing ${reportType} PDF URL is invalid, regenerating...`);
      }
    }

    console.log(`Generating new ${reportType} PDF...`);
    onProgress?.(`Generating ${reportType} PDF with PDF.co...`, 25);
    
    let pdfUrl: string | null = null;
    let pdfBlob: Blob | null = null;

    // Try PDF.co API - this is the only method we should use
    try {
      pdfUrl = await generatePDFWithAPI(reportData, isDraft);
      console.log('✅ PDF.co URL received:', pdfUrl);
      onProgress?.('PDF generated, downloading...', 40);
      
      if (pdfUrl && (pdfUrl.includes('pdf.co') || pdfUrl.includes('s3.us-west-2.amazonaws.com'))) {
        console.log('📥 Downloading PDF from PDF.co/AWS...');
        
        // Use the robust download function for large files with progress
        try {
          pdfBlob = await downloadLargePDFWithProgress(pdfUrl, onProgress);
          console.log('✅ PDF successfully downloaded:', pdfBlob.size, 'bytes');
          onProgress?.('PDF downloaded successfully', 80);
        } catch (downloadError) {
          console.warn('⚠️ Robust download failed, trying standard method:', downloadError);
          onProgress?.('Retrying download...', 50);
          
          // Fallback to standard download method
          const response = await fetch(pdfUrl, {
            method: 'GET',
            headers: {
              'Accept': 'application/pdf, */*',
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
              'Cache-Control': 'no-cache'
            }
          });
          
          if (response.ok) {
            console.log('📊 Standard download response:', {
              status: response.status,
              contentType: response.headers.get('content-type'),
              contentLength: response.headers.get('content-length')
            });
            
            const arrayBuffer = await response.arrayBuffer();
            pdfBlob = new Blob([arrayBuffer], { type: 'application/pdf' });
            console.log('✅ Standard download completed, size:', pdfBlob.size);
            onProgress?.('PDF downloaded successfully', 80);
          } else {
            throw new Error(`Standard download failed: ${response.status} ${response.statusText}`);
          }
        }
      } else {
        throw new Error(`Invalid PDF URL received: ${pdfUrl}`);
      }
    } catch (error) {
      console.error('❌ PDF.co generation failed completely:', error);
      onProgress?.('PDF generation failed', 0);
      throw new Error(`PDF generation failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (!pdfBlob) {
      console.error('❌ Failed to generate PDF blob');
      onProgress?.('Failed to generate PDF', 0);
      alert('Failed to generate PDF. Please try again.');
      return null;
    }

    // Save to Supabase storage (public bucket)
    console.log('Saving PDF to storage...');
    onProgress?.('Uploading to storage...', 85);
    const storageUrl = await savePDFToStorage(pdfBlob, orderId);
    
    // Update database
    console.log('Updating database with PDF URL...');
    onProgress?.('Updating database...', 90);
    await updateReportWithPDFInfo(orderId, storageUrl, reportType);

    console.log('PDF generation completed successfully');
    onProgress?.('PDF ready for download!', 100);
    return storageUrl;
  } catch (error) {
    console.error('PDF generation and save failed:', error);
    onProgress?.('PDF generation failed', 0);
    alert('An error occurred while generating the PDF. Please try again.');
    return null;
  }
}

// Enhanced download function with progress callbacks
export const downloadLargePDFWithProgress = async (
  url: string, 
  onProgress?: (stage: string, progress?: number) => void,
  maxRetries: number = 3
): Promise<Blob> => {
  console.log('🔄 Downloading large PDF from:', url);
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`📥 Attempt ${attempt}/${maxRetries}...`);
      onProgress?.(`Downloading... (Attempt ${attempt}/${maxRetries})`, 40 + (attempt - 1) * 10);
      
      // Create abort controller for timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout
      
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Accept': 'application/pdf, */*',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache',
          'Range': 'bytes=0-' // Request all bytes
        },
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      const contentLength = response.headers.get('content-length');
      const expectedLength = contentLength ? parseInt(contentLength) : 0;
      
      // Read the response as a stream for large files
      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('Response body is not readable');
      }
      
      const chunks: Uint8Array[] = [];
      let receivedLength = 0;
      
      while (true) {
        const { done, value } = await reader.read();
        
        if (done) break;
        
        chunks.push(value);
        receivedLength += value.length;
        
        if (expectedLength > 0) {
          const downloadProgress = (receivedLength / expectedLength * 100);
          const overallProgress = 40 + (downloadProgress * 0.4); // 40-80% range
          onProgress?.(`Downloading: ${downloadProgress.toFixed(1)}%`, overallProgress);
        }
      }
      
      console.log(`✅ Download completed: ${receivedLength} bytes received`);
      
      // Verify we got the expected amount
      if (expectedLength > 0 && receivedLength !== expectedLength) {
        console.warn(`⚠️ Size mismatch: expected ${expectedLength}, got ${receivedLength}`);
        if (receivedLength < expectedLength * 0.9) {
          throw new Error(`Incomplete download: ${receivedLength}/${expectedLength} bytes`);
        }
      }
      
      // Combine all chunks into a single array buffer
      const arrayBuffer = new ArrayBuffer(receivedLength);
      const uint8Array = new Uint8Array(arrayBuffer);
      let position = 0;
      
      for (const chunk of chunks) {
        uint8Array.set(chunk, position);
        position += chunk.length;
      }
      
      // Validate PDF format
      const firstBytes = new Uint8Array(arrayBuffer.slice(0, 8));
      const header = String.fromCharCode(...firstBytes);
      
      if (!header.startsWith('%PDF')) {
        throw new Error(`Invalid PDF header: ${header}`);
      }
      
      // Create and return the blob
      const blob = new Blob([arrayBuffer], { type: 'application/pdf' });
      console.log(`✅ PDF blob created successfully: ${blob.size} bytes`);
      
      return blob;
      
    } catch (error) {
      console.error(`❌ Attempt ${attempt} failed:`, error);
      
      if (attempt === maxRetries) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to download PDF after ${maxRetries} attempts: ${errorMessage}`);
      }
      
      // Wait before retry (exponential backoff)
      const delay = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s...
      onProgress?.(`Retrying in ${delay/1000}s...`, 40 + (attempt - 1) * 10);
      console.log(`⏳ Waiting ${delay}ms before retry...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  throw new Error('This should never be reached');
};

// Main PDF generation function with comprehensive error handling and authentication
export async function generateAndSavePDFReport(orderId: string, reportData: ReportData): Promise<string | null> {
  console.log('generateAndSavePDFReport called for order:', orderId);
  
  // Check authentication for database operations only
  const userId = await ensureAuthenticated();
  if (!userId) {
    console.error('User must be authenticated to generate reports');
    alert('Please login to generate reports');
    return null;
  }
  
  try {
    // First, ensure a report record exists
    let { data: existingReport } = await supabase
      .from('reports')
      .select('id, pdf_url, pdf_generated_at, status')
      .eq('order_id', orderId)
      .maybeSingle(); // Use maybeSingle to avoid errors when no record exists

    // If no report exists, create one
    if (!existingReport) {
      console.log('No report record exists, creating one...');
      
      // Get order details to populate report
      // Remove test_names from the query as it doesn't exist in orders table
      const { data: orderData, error: orderError } = await supabase
        .from('orders')
        .select('patient_id, doctor')  // Removed test_names
        .eq('id', orderId)
        .single();
      
      if (orderError || !orderData) {
        console.error('Failed to fetch order data:', orderError);
        alert('Order not found. Please check the order ID.');
        return null;
      }
      
      // Create report record
      const { data: newReport, error: insertError } = await supabase
        .from('reports')
        .insert({
          order_id: orderId,
          patient_id: orderData.patient_id,
          doctor: orderData.doctor || 'Unknown',
          status: 'pending',
          generated_date: new Date().toISOString(),
          report_type: 'Laboratory Report',
          report_status: 'generating'
        })
        .select()
        .single();

      if (insertError) {
        console.error('Failed to create report record:', insertError);
        // Check if it's a unique constraint violation
        if (insertError.code === '23505') {
          // Report already exists, try to fetch it again
          const { data: retryReport } = await supabase
            .from('reports')
            .select('id, pdf_url, pdf_generated_at, status')
            .eq('order_id', orderId)
            .single();
          existingReport = retryReport;
        } else {
          alert('Failed to create report record. Please try again.');
          return null;
        }
      } else {
        existingReport = newReport;
      }
    }

    // Check if PDF already exists and is valid
    if (existingReport?.pdf_url) {
      console.log('PDF already exists:', existingReport.pdf_url);
      
      // Verify URL is still valid
      try {
        const response = await fetch(existingReport.pdf_url, { method: 'HEAD' });
        if (response.ok) {
          console.log('Existing PDF is valid');
          return existingReport.pdf_url;
        }
      } catch (error) {
        console.warn('Existing PDF URL is invalid, regenerating...');
      }
    }

    console.log('Generating new PDF...');
    let pdfUrl: string | null = null;
    let pdfBlob: Blob | null = null;

    // Try PDF.co API - this is the only method we should use
    try {
      pdfUrl = await generatePDFWithAPI(reportData);
      console.log('✅ PDF.co URL received:', pdfUrl);
      
      if (pdfUrl && (pdfUrl.includes('pdf.co') || pdfUrl.includes('s3.us-west-2.amazonaws.com'))) {
        console.log('📥 Downloading PDF from PDF.co/AWS...');
        
        // Use the robust download function for large files
        try {
          pdfBlob = await downloadLargePDF(pdfUrl);
          console.log('✅ PDF successfully downloaded:', pdfBlob.size, 'bytes');
        } catch (downloadError) {
          console.warn('⚠️ Robust download failed, trying standard method:', downloadError);
          
          // Fallback to standard download method
          const response = await fetch(pdfUrl, {
            method: 'GET',
            headers: {
              'Accept': 'application/pdf, */*',
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
              'Cache-Control': 'no-cache'
            }
          });
          
          if (response.ok) {
            console.log('📊 Standard download response:', {
              status: response.status,
              contentType: response.headers.get('content-type'),
              contentLength: response.headers.get('content-length')
            });
            
            const arrayBuffer = await response.arrayBuffer();
            pdfBlob = new Blob([arrayBuffer], { type: 'application/pdf' });
            console.log('✅ Standard download completed, size:', pdfBlob.size);
          } else {
            throw new Error(`Standard download failed: ${response.status} ${response.statusText}`);
          }
        }
      } else {
        throw new Error(`Invalid PDF URL received: ${pdfUrl}`);
      }
    } catch (error) {
      console.error('❌ PDF.co generation failed completely:', error);
      throw new Error(`PDF generation failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (!pdfBlob) {
      console.error('❌ Failed to generate PDF blob');
      alert('Failed to generate PDF. Please try again.');
      return null;
    }

    // Save to Supabase storage (public bucket)
    console.log('Saving PDF to storage...');
    const storageUrl = await savePDFToStorage(pdfBlob, orderId);
    
    // Update database
    console.log('Updating database with PDF URL...');
    await updateReportWithPDFInfo(orderId, storageUrl, 'final');

    console.log('PDF generation completed successfully');
    return storageUrl;
  } catch (error) {
    console.error('PDF generation and save failed:', error);
    alert('An error occurred while generating the PDF. Please try again.');
    return null;
  }
}

// View PDF report (opens in new tab)
export async function viewPDFReport(orderId: string, reportData: ReportData): Promise<string | null> {
  console.log('viewPDFReport called for order:', orderId);
  
  try {
    const pdfUrl = await generateAndSavePDFReport(orderId, reportData);
    if (!pdfUrl) {
      console.error('No PDF URL returned');
      return null;
    }
    
    console.log('PDF URL ready for viewing:', pdfUrl);
    return pdfUrl;
  } catch (error) {
    console.error('View PDF error:', error);
    alert('Failed to view PDF report');
    return null;
  }
}

// Enhanced Download PDF report with progress callback
export async function downloadPDFReport(
  orderId: string, 
  reportData: ReportData, 
  onProgress?: (stage: string, progress?: number) => void
): Promise<boolean> {
  console.log('downloadPDFReport called for order:', orderId);
  
  try {
    onProgress?.('Initializing PDF generation...', 0);
    
    const pdfUrl = await generateAndSavePDFReportWithProgress(orderId, reportData, onProgress);
    if (!pdfUrl) {
      console.error('No PDF URL generated');
      onProgress?.('Failed to generate PDF', 0);
      return false;
    }

    onProgress?.('Starting download...', 95);
    console.log('Initiating download from URL:', pdfUrl);
    
    // Handle blob URLs differently
    if (pdfUrl.startsWith('blob:')) {
      // For blob URLs, open in new window
      window.open(pdfUrl, '_blank');
      onProgress?.('Download completed!', 100);
      return true;
    }
    
    // For regular URLs, create download link
    const link = document.createElement('a');
    link.href = pdfUrl;
    link.download = `Report_${reportData.patient.name.replace(/\s+/g, '_')}_${orderId}.pdf`;
    link.target = '_blank';
    
    // Some browsers require the link to be in the DOM
    document.body.appendChild(link);
    
    // Trigger download
    link.click();
    
    // Clean up
    setTimeout(() => {
      document.body.removeChild(link);
    }, 100);
    
    onProgress?.('Download completed!', 100);
    console.log('Download initiated successfully');
    return true;
  } catch (error) {
    console.error('Download failed:', error);
    onProgress?.('Download failed', 0);
    alert('Failed to download PDF report');
    return false;
  }
}

// Generate sample report data for testing
export const generateSampleReportData = (template: LabTemplate = defaultLabTemplate): ReportData => {
  return {
    patient: {
      name: 'Ravi Mehta',
      id: 'PTX100256',
      age: 45,
      gender: 'Male',
      referredBy: 'Dr. Anjali Desai',
    },
    report: {
      reportId: 'RPT20250629',
      collectionDate: '2025-06-28',
      reportDate: '2025-06-29',
      reportType: 'Liver Function Test (LFT)',
    },
    testResults: [
      { parameter: 'SGOT (AST)', result: '72', unit: 'U/L', referenceRange: '15–37', flag: 'H' },
      { parameter: 'SGPT (ALT)', result: '105', unit: 'U/L', referenceRange: '16–63', flag: 'H' },
      { parameter: 'Total Bilirubin', result: '1.9', unit: 'mg/dL', referenceRange: '0.2–1', flag: 'H' },
      { parameter: 'Direct Bilirubin', result: '1.1', unit: 'mg/dL', referenceRange: '0.0–0.3', flag: 'H' },
      { parameter: 'Albumin', result: '2.8', unit: 'g/dL', referenceRange: '3.4–5', flag: 'L' },
      { parameter: 'Total Protein', result: '6.2', unit: 'g/dL', referenceRange: '6.0–8.3', flag: '' },
      { parameter: 'ALP', result: '120', unit: 'U/L', referenceRange: '40–150', flag: '' },
      { parameter: 'GGT', result: '85', unit: 'U/L', referenceRange: '10–50', flag: 'H' },
    ],
    interpretation: 'Liver enzymes (AST, ALT, GGT) are significantly elevated. Bilirubin levels are increased with predominant direct fraction. Low albumin suggests impaired synthetic function. These findings are suggestive of hepatocellular injury with cholestatic pattern. Clinical correlation and further evaluation recommended.',
    template,
  };
};

// Utility function to download PDF from URL
export const downloadPDFFromURL = async (url: string, filename: string): Promise<void> => {
  try {
    console.log('Downloading PDF from URL:', url);
    
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to download PDF: ${response.statusText}`);
    }
    
    const blob = await response.blob();
    const downloadUrl = window.URL.createObjectURL(blob);
    
    const link = document.createElement('a');
    link.href = downloadUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    
    // Clean up the blob URL
    setTimeout(() => {
      window.URL.revokeObjectURL(downloadUrl);
    }, 100);
    
    console.log('PDF download completed');
  } catch (error) {
    console.error('Error downloading PDF:', error);
    throw error;
  }
};

// Function to test PDF generation without saving to database
export const testPDFGeneration = async (): Promise<void> => {
  console.log('Testing PDF generation...');
  
  try {
    const sampleData = generateSampleReportData();
    const pdfUrl = await generatePDFWithAPI(sampleData);
    
    if (pdfUrl) {
      console.log('Test PDF generated successfully:', pdfUrl);
      window.open(pdfUrl, '_blank');
    } else {
      console.error('Test PDF generation failed');
    }
  } catch (error) {
    console.error('Test PDF generation error:', error);
  }
};

// Debug function to test storage upload directly
export const testStorageUpload = async (): Promise<void> => {
  console.log('Testing storage upload...');
  
  try {
    // Create a test PDF blob
    const testContent = new Blob(['%PDF-1.4\n1 0 obj\n<<\n/Type /Catalog\n/Pages 2 0 R\n>>\nendobj\n2 0 obj\n<<\n/Type /Pages\n/Kids [3 0 R]\n/Count 1\n>>\nendobj\n3 0 obj\n<<\n/Type /Page\n/Parent 2 0 R\n/MediaBox [0 0 612 792]\n>>\nendobj\nxref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \ntrailer\n<<\n/Size 4\n/Root 1 0 R\n>>\nstartxref\n174\n%%EOF'], { type: 'application/pdf' });
    
    console.log('Test blob created:', testContent.size, 'bytes');
    
    // Check auth status
    const { data: { session }, error: authError } = await supabase.auth.getSession();
    console.log('Auth check - session exists:', !!session);
    console.log('Auth error:', authError);
    if (session) {
      console.log('User ID:', session.user.id);
      console.log('Access token length:', session.access_token.length);
    }
    
    // Test upload
    const fileName = `test_${Date.now()}.pdf`;
    console.log('Attempting upload of:', fileName);
    
    const { data, error } = await supabase.storage
      .from('reports')
      .upload(fileName, testContent, {
        contentType: 'application/pdf',
        upsert: true
      });
    
    if (error) {
      console.error('Upload failed:', error);
      console.error('Error details:', JSON.stringify(error, null, 2));
    } else {
      console.log('Upload successful:', data);
      
      // Get public URL
      const { data: { publicUrl } } = supabase.storage
        .from('reports')
        .getPublicUrl(fileName);
      
      console.log('Public URL:', publicUrl);
      
      // Test URL accessibility
      try {
        const testResponse = await fetch(publicUrl, { method: 'HEAD' });
        console.log('URL accessible:', testResponse.ok, testResponse.status);
      } catch (urlError) {
        console.error('URL test failed:', urlError);
      }
    }
  } catch (error) {
    console.error('Test storage upload error:', error);
  }
};

// Robust PDF download function for large files
export const downloadLargePDF = async (url: string, maxRetries: number = 3): Promise<Blob> => {
  console.log('🔄 Downloading large PDF from:', url);
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`📥 Attempt ${attempt}/${maxRetries}...`);
      
      // Create abort controller for timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout
      
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Accept': 'application/pdf, */*',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache',
          'Range': 'bytes=0-' // Request all bytes
        },
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      const contentLength = response.headers.get('content-length');
      const contentType = response.headers.get('content-type');
      
      console.log('📊 Response headers:', {
        status: response.status,
        contentType,
        contentLength: contentLength ? `${parseInt(contentLength)} bytes` : 'unknown',
        acceptRanges: response.headers.get('accept-ranges'),
        cacheControl: response.headers.get('cache-control')
      });
      
      // Read the response as a stream for large files
      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('Response body is not readable');
      }
      
      const chunks: Uint8Array[] = [];
      let receivedLength = 0;
      const expectedLength = contentLength ? parseInt(contentLength) : 0;
      
      while (true) {
        const { done, value } = await reader.read();
        
        if (done) break;
        
        chunks.push(value);
        receivedLength += value.length;
        
        if (expectedLength > 0) {
          const progress = (receivedLength / expectedLength * 100).toFixed(1);
          console.log(`📈 Download progress: ${progress}% (${receivedLength}/${expectedLength} bytes)`);
        }
      }
      
      console.log(`✅ Download completed: ${receivedLength} bytes received`);
      
      // Verify we got the expected amount
      if (expectedLength > 0 && receivedLength !== expectedLength) {
        console.warn(`⚠️ Size mismatch: expected ${expectedLength}, got ${receivedLength}`);
        if (receivedLength < expectedLength * 0.9) { // If we got less than 90% of expected
          throw new Error(`Incomplete download: ${receivedLength}/${expectedLength} bytes`);
        }
      }
      
      // Combine all chunks into a single array buffer
      const arrayBuffer = new ArrayBuffer(receivedLength);
      const uint8Array = new Uint8Array(arrayBuffer);
      let position = 0;
      
      for (const chunk of chunks) {
        uint8Array.set(chunk, position);
        position += chunk.length;
      }
      
      // Validate PDF format
      const firstBytes = new Uint8Array(arrayBuffer.slice(0, 8));
      const header = String.fromCharCode(...firstBytes);
      
      if (!header.startsWith('%PDF')) {
        throw new Error(`Invalid PDF header: ${header}`);
      }
      
      // Check for PDF end marker
      const lastBytes = new Uint8Array(arrayBuffer.slice(-10));
      const footer = String.fromCharCode(...lastBytes);
      const hasEOF = footer.includes('%%EOF') || arrayBuffer.byteLength < 1000; // Small files might not have clear EOF
      
      console.log('📄 PDF validation:', {
        header: header.substring(0, 8),
        size: arrayBuffer.byteLength,
        hasEOF,
        isValid: header.startsWith('%PDF')
      });
      
      if (!hasEOF && arrayBuffer.byteLength > 1000) {
        console.warn('⚠️ PDF may be incomplete - no EOF marker found');
      }
      
      // Create and return the blob
      const blob = new Blob([arrayBuffer], { type: 'application/pdf' });
      console.log(`✅ PDF blob created successfully: ${blob.size} bytes`);
      
      return blob;
      
    } catch (error) {
      console.error(`❌ Attempt ${attempt} failed:`, error);
      
      if (attempt === maxRetries) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to download PDF after ${maxRetries} attempts: ${errorMessage}`);
      }
      
      // Wait before retry (exponential backoff)
      const delay = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s...
      console.log(`⏳ Waiting ${delay}ms before retry...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  throw new Error('This should never be reached');
};

// Comprehensive debug function to test the entire PDF pipeline
export const debugPDFPipeline = async (): Promise<void> => {
  console.log('🔍 Starting comprehensive PDF pipeline debug...');
  
  try {
    // Step 1: Generate PDF with PDF.co
    console.log('📝 Step 1: Generating PDF with PDF.co...');
    const sampleData = generateSampleReportData();
    const pdfcoUrl = await generatePDFWithAPI(sampleData);
    console.log('✅ PDF.co URL generated:', pdfcoUrl);
    
    // Step 2: Test PDF.co URL directly
    console.log('🔗 Step 2: Testing PDF.co URL directly...');
    window.open(pdfcoUrl, '_blank');
    
    // Step 3: Download and analyze the PDF
    console.log('⬇️ Step 3: Downloading PDF from PDF.co...');
    const response = await fetch(pdfcoUrl, {
      method: 'GET',
      headers: {
        'Accept': 'application/pdf',
        'User-Agent': 'Mozilla/5.0 (compatible; LIMS-PDF-Downloader)',
      }
    });
    
    console.log('📊 Response details:', {
      status: response.status,
      statusText: response.statusText,
      contentType: response.headers.get('content-type'),
      contentLength: response.headers.get('content-length'),
      headers: [...response.headers.entries()]
    });
    
    if (!response.ok) {
      throw new Error(`PDF.co download failed: ${response.status}`);
    }
    
    // Step 4: Get ArrayBuffer and analyze
    console.log('🔬 Step 4: Analyzing downloaded content...');
    const arrayBuffer = await response.arrayBuffer();
    console.log('📏 ArrayBuffer size:', arrayBuffer.byteLength);
    
    // Check PDF header
    const firstBytes = new Uint8Array(arrayBuffer.slice(0, 10));
    const header = String.fromCharCode(...firstBytes);
    console.log('📄 PDF header:', JSON.stringify(header));
    console.log('✅ Valid PDF header:', header.startsWith('%PDF'));
    
    // Check PDF footer
    const lastBytes = new Uint8Array(arrayBuffer.slice(-10));
    const footer = String.fromCharCode(...lastBytes);
    console.log('📄 PDF footer:', JSON.stringify(footer));
    
    // Step 5: Create blob and test locally
    console.log('💾 Step 5: Creating blob and testing locally...');
    const pdfBlob = new Blob([arrayBuffer], { type: 'application/pdf' });
    console.log('🎯 Blob details:', {
      size: pdfBlob.size,
      type: pdfBlob.type,
      arrayBufferSize: arrayBuffer.byteLength,
      sizesMatch: pdfBlob.size === arrayBuffer.byteLength
    });
    
    // Create local blob URL and test
    const localBlobUrl = URL.createObjectURL(pdfBlob);
    console.log('🔗 Local blob URL:', localBlobUrl);
    console.log('🚀 Opening local blob in new tab...');
    setTimeout(() => window.open(localBlobUrl, '_blank'), 2000);
    
    // Step 6: Upload to Supabase and test
    console.log('☁️ Step 6: Uploading to Supabase...');
    const fileName = `debug_${Date.now()}.pdf`;
    
    const { data, error } = await supabase.storage
      .from('reports')
      .upload(fileName, pdfBlob, {
        contentType: 'application/pdf',
        upsert: true
      });
    
    if (error) {
      console.error('❌ Supabase upload failed:', error);
      return;
    }
    
    console.log('✅ Supabase upload successful:', data);
    
    // Step 7: Get public URL and test
    const { data: { publicUrl } } = supabase.storage
      .from('reports')
      .getPublicUrl(fileName);
    
    console.log('🔗 Supabase public URL:', publicUrl);
    
    // Step 8: Download from Supabase and compare
    console.log('🔄 Step 8: Downloading from Supabase to compare...');
    const supabaseResponse = await fetch(publicUrl);
    console.log('📊 Supabase response:', {
      status: supabaseResponse.status,
      contentType: supabaseResponse.headers.get('content-type'),
      contentLength: supabaseResponse.headers.get('content-length')
    });
    
    if (supabaseResponse.ok) {
      const supabaseArrayBuffer = await supabaseResponse.arrayBuffer();
      console.log('📏 Downloaded from Supabase size:', supabaseArrayBuffer.byteLength);
      
      // Compare sizes
      console.log('🔍 Size comparison:', {
        original: arrayBuffer.byteLength,
        downloaded: supabaseArrayBuffer.byteLength,
        match: arrayBuffer.byteLength === supabaseArrayBuffer.byteLength
      });
      
      // Compare first few bytes
      const downloadedFirstBytes = new Uint8Array(supabaseArrayBuffer.slice(0, 10));
      const downloadedHeader = String.fromCharCode(...downloadedFirstBytes);
      console.log('📄 Downloaded PDF header:', JSON.stringify(downloadedHeader));
      
      // Test if downloaded version works
      const downloadedBlob = new Blob([supabaseArrayBuffer], { type: 'application/pdf' });
      const downloadedUrl = URL.createObjectURL(downloadedBlob);
      console.log('🚀 Opening downloaded version in new tab...');
      setTimeout(() => window.open(downloadedUrl, '_blank'), 4000);
      
      // Direct comparison
      const originalBytes = new Uint8Array(arrayBuffer);
      const downloadedBytes = new Uint8Array(supabaseArrayBuffer);
      let differences = 0;
      for (let i = 0; i < Math.min(originalBytes.length, downloadedBytes.length); i++) {
        if (originalBytes[i] !== downloadedBytes[i]) {
          differences++;
          if (differences <= 10) {
            console.log(`Byte difference at ${i}: ${originalBytes[i]} vs ${downloadedBytes[i]}`);
          }
        }
      }
      console.log('🔍 Total byte differences:', differences);
    }
    
    console.log('🚀 Opening Supabase URL in new tab...');
    setTimeout(() => window.open(publicUrl, '_blank'), 6000);
    
    console.log('✅ Debug pipeline completed. Check the opened tabs to compare results.');
    
  } catch (error) {
    console.error('❌ Debug pipeline failed:', error);
  }
};

// Export all functions and interfaces
export default {
  generateAndSavePDFReport,
  viewPDFReport,
  downloadPDFReport,
  generateSampleReportData,
  downloadPDFFromURL,
  saveLabTemplate,
  getLabTemplates,
  getLabTemplate,
  defaultLabTemplate,
  testPDFGeneration,
  testStorageUpload,
  debugPDFPipeline
};