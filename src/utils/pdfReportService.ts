/**
 * Simplified PDF Report Service
 * 
 * This service provides a streamlined approach for report generation:
 * 1. View Report: Opens HTML in a new browser window (no PDF conversion)
 * 2. Generate Final Report: Creates PDF and saves to storage
 * 
 * This does NOT replace pdfService.ts - it's a simplified alternative for
 * the Reports page functionality.
 */

import { supabase, database } from './supabase';
import type { ReportTemplateContext, LabTemplateRecord } from './supabase';
import {
  renderLabTemplateHtmlBundle,
  selectTemplateForContext,
  savePDFToStorage,
  updateReportWithPDFInfo,
  type LabBrandingHtmlDefaults
} from './pdfService';
import {
  generatePDFWithPuppeteer,
  analyzePDFComplexity,
} from './pdfServicePuppeteer';
import {
  shouldUsePuppeteer,
  shouldFallbackToPDFCO,
  logPDFEvent,
  recordPerformanceMetrics,
} from './pdfProviderConfig';

/**
 * Helper to build context for template rendering
 */
const buildContextFromReportTemplate = (context: ReportTemplateContext): Record<string, any> => {
  return {
    // Patient info
    patientName: context.patient?.name || 'N/A',
    patientAge: context.patient?.age || 'N/A',
    patientGender: context.patient?.gender || 'N/A',
    patientId: context.patientId || 'N/A',
    
    // Order info
    orderId: context.orderId || 'N/A',
    sampleCollectedAt: context.order?.sampleCollectedAt || 'N/A',
    sampleReceivedAt: context.order?.sampleReceivedAt || 'N/A',
    referringDoctorName: context.order?.referringDoctorName || 'Self',
    
    // Lab info
    labName: context.lab?.name || 'Laboratory',
    labAddress: context.lab?.address || '',
    labPhone: context.lab?.phone || '',
    labEmail: context.lab?.email || '',
    
    // Test results
    analytes: context.analytes || [],
    testGroupIds: context.testGroupIds || [],
    
    // Meta
    allAnalytesApproved: context.meta?.allAnalytesApproved || false,
    report_generated_at: new Date().toISOString(),
  };
};

/**
 * Helper to group analytes by test_group_id
 */
const groupAnalytesByTestGroup = (analytes: any[]): Map<string, any[]> => {
  const grouped = new Map<string, any[]>();
  
  for (const analyte of analytes) {
    const testGroupId = analyte.test_group_id || 'ungrouped';
    if (!grouped.has(testGroupId)) {
      grouped.set(testGroupId, []);
    }
    grouped.get(testGroupId)!.push(analyte);
  }
  
  return grouped;
};

/**
 * Render multiple test group templates and merge them into a single HTML
 */
const renderMultipleTestGroupTemplates = (
  context: ReportTemplateContext,
  isDraft: boolean,
  brandingDefaults: LabBrandingHtmlDefaults | undefined,
  templates: LabTemplateRecord[],
  placeholderOverrides?: Record<string, any>
): { html: string; bundle: any } => {
  if (!context.analytes || context.analytes.length === 0) {
    throw new Error('No analytes found in report context');
  }

  // Group analytes by test_group_id
  const analytesByGroup = groupAnalytesByTestGroup(context.analytes);
  
  console.log(`📋 Found ${analytesByGroup.size} test group(s) in order ${context.orderId}`);
  
  // If only one test group, use the standard single-template rendering
  if (analytesByGroup.size === 1) {
    const template = selectTemplateForContext(templates, context);
    if (template?.gjs_html) {
      const bundle = renderLabTemplateHtmlBundle(template, {
        context,
        overrides: {
          ...(placeholderOverrides ?? {}),
          report_is_draft: isDraft,
          report_generated_at: new Date().toISOString(),
        },
        brandingDefaults,
      });
      
      return { html: bundle.previewHtml, bundle };
    }
  }

  // Multiple test groups - need to merge templates
  const renderedSections: string[] = [];
  const testGroupNames: string[] = [];
  
  for (const [testGroupId, groupAnalytes] of analytesByGroup.entries()) {
    console.log(`🔧 Rendering test group: ${testGroupId} with ${groupAnalytes.length} analyte(s)`);
    
    // Create a modified context for this test group
    const groupContext: ReportTemplateContext = {
      ...context,
      analytes: groupAnalytes,
      testGroupIds: [testGroupId],
    };
    
    // Select template for this specific test group
    let groupTemplate: LabTemplateRecord | null = null;
    
    // Try to find a template specifically for this test group
    if (testGroupId !== 'ungrouped') {
      groupTemplate = templates.find(t => t.test_group_id === testGroupId && t.gjs_html) || null;
    }
    
    // Fall back to selecting based on context
    if (!groupTemplate) {
      groupTemplate = selectTemplateForContext(templates, groupContext);
    }
    
    // Fall back to default template
    if (!groupTemplate) {
      groupTemplate = templates.find(t => t.is_default && t.gjs_html) || templates.find(t => t.gjs_html) || null;
    }
    
    if (groupTemplate?.gjs_html) {
      const bundle = renderLabTemplateHtmlBundle(groupTemplate, {
        context: groupContext,
        overrides: {
          ...(placeholderOverrides ?? {}),
          report_is_draft: isDraft,
          report_generated_at: new Date().toISOString(),
        },
        brandingDefaults,
      });
      
      // Extract the body content from the rendered HTML
      const bodyMatch = bundle.previewHtml.match(/<body[^>]*>([\s\S]*)<\/body>/i);
      const bodyContent = bodyMatch ? bodyMatch[1] : bundle.previewHtml;
      
      // Add section with test group separator
      const testName = groupAnalytes[0]?.test_name || `Test Group ${renderedSections.length + 1}`;
      testGroupNames.push(testName);
      
      const sectionHtml = `
        <div class="test-group-section" data-test-group-id="${testGroupId}">
          ${renderedSections.length > 0 ? `
            <div class="test-group-separator" style="page-break-before: always; margin: 40px 0 20px; padding-top: 20px; border-top: 2px solid #2563eb;">
              <h2 style="color: #2563eb; font-size: 18px; margin: 0;">${testName}</h2>
            </div>
          ` : ''}
          ${bodyContent}
        </div>
      `;
      
      renderedSections.push(sectionHtml);
    } else {
      console.warn(`⚠️  No template found for test group: ${testGroupId}`);
    }
  }
  
  if (renderedSections.length === 0) {
    throw new Error('Failed to render any test group templates');
  }
  
  // Merge all sections into a single HTML document
  const mergedBody = renderedSections.join('\n');
  
  // Get the base template structure from the first rendered template
  const firstTemplate = templates.find(t => t.gjs_html);
  if (!firstTemplate?.gjs_html) {
    throw new Error('No valid template found for report generation');
  }
  
  // Create a bundle with the first template's structure but merged content
  const baseBundle = renderLabTemplateHtmlBundle(firstTemplate, {
    context,
    overrides: {
      ...(placeholderOverrides ?? {}),
      report_is_draft: isDraft,
      report_generated_at: new Date().toISOString(),
    },
    brandingDefaults,
  });
  
  // Replace the body content with merged sections
  const mergedHtml = baseBundle.previewHtml.replace(
    /<body[^>]*>[\s\S]*<\/body>/i,
    `<body class="limsv2-report multi-test-group-report">${mergedBody}</body>`
  );
  
  console.log(`✅ Successfully merged ${renderedSections.length} test group template(s)`);
  
  return {
    html: mergedHtml,
    bundle: {
      ...baseBundle,
      previewHtml: mergedHtml,
      bodyHtml: mergedBody,
      testGroupCount: renderedSections.length,
      testGroupNames,
    },
  };
};

/**
 * Prepare HTML for report viewing or PDF generation
 */
export const prepareReportHtml = async (
  orderId: string,
  allTemplates?: LabTemplateRecord[]
): Promise<{ html: string; isDraft: boolean; context: ReportTemplateContext }> => {
  console.log('prepareReportHtml called for order:', orderId);

  // Get report context
  const { data: context, error: contextError } = await database.reports.getTemplateContext(orderId);
  if (contextError || !context) {
    throw new Error(contextError?.message || 'Failed to load report context');
  }

  if (!Array.isArray(context.analytes) || context.analytes.length === 0) {
    throw new Error('No test results found for this order');
  }

  const isDraft = context.meta?.allAnalytesApproved !== true;

  // Load templates if not provided
  let templates = allTemplates;
  if (!templates) {
    const { data: templatesData, error: templateError } = await database.labTemplates.list();
    if (templateError) {
      console.warn('Unable to load lab templates:', templateError);
      templates = [];
    } else {
      templates = (templatesData as LabTemplateRecord[]) || [];
    }
  }

  // Get branding defaults
  let brandingDefaults: LabBrandingHtmlDefaults | undefined;
  try {
    const { data: labBranding, error: brandingError } = await database.labs.getBrandingDefaults();
    if (brandingError) {
      console.warn('Failed to load lab branding defaults:', brandingError);
    } else if (labBranding) {
      brandingDefaults = {
        headerHtml: labBranding.defaultReportHeaderHtml ?? null,
        footerHtml: labBranding.defaultReportFooterHtml ?? null,
      };
    }
  } catch (brandingFetchError) {
    console.warn('Unexpected error loading lab branding defaults:', brandingFetchError);
  }

  // Check if we have multiple test groups
  const hasMultipleTestGroups = context?.testGroupIds && context.testGroupIds.length > 1;
  
  let finalHtml = '';

  if (hasMultipleTestGroups && templates && templates.length > 0) {
    console.log(`🔀 Detected ${context.testGroupIds!.length} test groups, attempting multi-template merge`);
    
    try {
      const result = renderMultipleTestGroupTemplates(
        context,
        isDraft,
        brandingDefaults,
        templates
      );
      
      finalHtml = result.html;
    } catch (error) {
      console.error('❌ Multi-template merge failed, falling back to single template:', error);
    }
  }

  // Single template rendering
  if (!finalHtml && templates && templates.length > 0) {
    const selectedTemplate = selectTemplateForContext(templates, context);
    
    if (selectedTemplate?.gjs_html) {
      const bundle = renderLabTemplateHtmlBundle(selectedTemplate, {
        context,
        overrides: {
          report_is_draft: isDraft,
          report_generated_at: new Date().toISOString(),
        },
        brandingDefaults,
      });

      finalHtml = bundle.previewHtml;
    }
  }

  // Fallback if no template found
  if (!finalHtml) {
    throw new Error('No valid template found to generate report HTML');
  }

  return { html: finalHtml, isDraft, context };
};

/**
 * View report in browser window (HTML only, no PDF conversion)
 * User can use browser's native print function if they want a PDF
 */
export const viewReportInBrowser = async (
  orderId: string,
  allTemplates?: LabTemplateRecord[]
): Promise<void> => {
  console.log('viewReportInBrowser called for order:', orderId);

  try {
    const { html, isDraft } = await prepareReportHtml(orderId, allTemplates);

    // Add draft watermark if needed
    const displayHtml = isDraft
      ? html.replace(
          /<body([^>]*)>/i,
          `<body$1>
            <div style="position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%) rotate(-45deg); 
                        font-size: 120px; color: rgba(255, 0, 0, 0.1); font-weight: bold; 
                        pointer-events: none; z-index: 9999; user-select: none;">
              DRAFT
            </div>`
        )
      : html;

    // Open in new window
    const newWindow = window.open('', '_blank');
    if (newWindow) {
      newWindow.document.write(displayHtml);
      newWindow.document.close();
    } else {
      throw new Error('Failed to open new window. Please check your popup blocker settings.');
    }
  } catch (error) {
    console.error('viewReportInBrowser error:', error);
    throw error;
  }
};

/**
 * Generate PDF and save to storage (for download)
 */
export const generateFinalReportPDF = async (
  orderId: string,
  onProgress?: (stage: string, progress?: number) => void,
  allTemplates?: LabTemplateRecord[]
): Promise<string | null> => {
  console.log('generateFinalReportPDF called for order:', orderId);

  try {
    onProgress?.('Checking authentication...', 5);

    // Check authentication
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      throw new Error('Please login to generate reports');
    }

    onProgress?.('Loading report data...', 10);

    // Prepare HTML
    const { html, isDraft, context } = await prepareReportHtml(orderId, allTemplates);

    onProgress?.('Checking existing reports...', 15);

    // Check for existing report
    let { data: existingReport } = await supabase
      .from('reports')
      .select('id, pdf_url, pdf_generated_at, status, report_type')
      .eq('order_id', orderId)
      .maybeSingle();

    const reportType = isDraft ? 'draft' : 'final';

    // Create report record if it doesn't exist
    if (!existingReport) {
      console.log('No report record exists, creating one...');
      onProgress?.('Creating report record...', 20);

      const { data: orderData, error: orderError } = await supabase
        .from('orders')
        .select('patient_id, doctor')
        .eq('id', orderId)
        .single();

      if (orderError || !orderData) {
        throw new Error('Order not found. Please check the order ID.');
      }

      const { data: newReport, error: upsertError } = await supabase
        .from('reports')
        .upsert(
          {
            order_id: orderId,
            patient_id: orderData.patient_id,
            doctor: orderData.doctor || 'Unknown',
            status: 'pending',
            generated_date: new Date().toISOString(),
            report_type: reportType,
            report_status: 'generating',
          },
          {
            onConflict: 'order_id',
            ignoreDuplicates: false,
          }
        )
        .select()
        .single();

      if (upsertError) {
        throw new Error('Failed to create report record. Please try again.');
      }

      existingReport = newReport;
    }

    // Check if we need to regenerate
    const needsRegeneration =
      !existingReport ||
      existingReport.report_type !== reportType ||
      !existingReport.pdf_url ||
      existingReport.status !== 'completed';

    if (!needsRegeneration && existingReport?.pdf_url) {
      console.log(`${reportType.toUpperCase()} PDF already exists:`, existingReport.pdf_url);
      onProgress?.(`Using existing ${reportType} PDF`, 100);
      return existingReport.pdf_url;
    }

    console.log(`Generating new ${reportType} PDF...`);
    onProgress?.(`Generating ${reportType} PDF...`, 30);

    // Analyze PDF complexity
    const complexity = analyzePDFComplexity(html);
    const usePuppeteer = shouldUsePuppeteer() && complexity.recommendation === 'puppeteer';

    console.log('PDF Generation Strategy:', {
      usePuppeteer,
      complexity: complexity.complexity,
      pageCount: complexity.pageCount,
      recommendation: complexity.recommendation,
      htmlSize: complexity.htmlSize,
    });

    let pdfUrl: string | null = null;

    // Try Puppeteer first
    if (usePuppeteer) {
      logPDFEvent('start', 'puppeteer', { orderId, complexity: complexity.complexity });
      const startTime = Date.now();

      try {
        onProgress?.(`Generating ${reportType} PDF with Puppeteer...`, 40);
        console.log('🎭 Using Puppeteer for PDF generation');

        const puppeteerUrl = await generatePDFWithPuppeteer({
          orderId,
          html,
          variant: reportType,
          cacheKey: `${orderId}_${reportType}`,
        });

        if (puppeteerUrl) {
          const totalTime = Date.now() - startTime;
          console.log('✅ Puppeteer generation successful:', puppeteerUrl);
          logPDFEvent('success', 'puppeteer', { orderId, time: totalTime });
          recordPerformanceMetrics({
            provider: 'puppeteer',
            totalTime,
            htmlSize: complexity.htmlSize,
            pageCount: complexity.pageCount,
          });

          pdfUrl = puppeteerUrl;
        }
      } catch (error) {
        const totalTime = Date.now() - startTime;
        console.error('❌ Puppeteer failed:', error);
        logPDFEvent('error', 'puppeteer', {
          orderId,
          error: error instanceof Error ? error.message : 'Unknown error',
          time: totalTime,
        });

        if (!shouldFallbackToPDFCO()) {
          throw error;
        }
        console.log('⚠️  Falling back to PDF.co...');
      }
    }

    // Fallback to PDF.co (if needed)
    if (!pdfUrl) {
      throw new Error('PDF generation failed. Please try again.');
    }

    onProgress?.('Saving PDF to storage...', 70);

    // Save PDF to storage
    const filename = `Report_${context.patient?.name?.replace(/\s+/g, '_') || 'Patient'}_${orderId}${isDraft ? '_DRAFT' : ''}.pdf`;
    const storedUrl = await savePDFToStorage(orderId, pdfUrl, filename, reportType);

    if (!storedUrl) {
      throw new Error('Failed to save PDF to storage');
    }

    onProgress?.('Updating report record...', 90);

    // Update report record
    await updateReportWithPDFInfo(orderId, storedUrl, reportType);

    onProgress?.('PDF generated successfully!', 100);

    console.log('PDF generation complete:', storedUrl);
    return storedUrl;
  } catch (error) {
    console.error('generateFinalReportPDF error:', error);
    onProgress?.('PDF generation failed', 0);
    throw error;
  }
};

/**
 * Download PDF report
 */
export const downloadReportPDF = async (pdfUrl: string, filename: string): Promise<void> => {
  try {
    const response = await fetch(pdfUrl);
    if (!response.ok) {
      throw new Error('Failed to download PDF');
    }

    const blob = await response.blob();
    const downloadUrl = window.URL.createObjectURL(blob);

    const link = document.createElement('a');
    link.href = downloadUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.URL.revokeObjectURL(downloadUrl);

    console.log('PDF downloaded successfully');
  } catch (error) {
    console.error('downloadReportPDF error:', error);
    throw error;
  }
};
