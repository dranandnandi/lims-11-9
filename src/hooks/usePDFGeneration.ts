import { useState, useCallback, useRef, useContext } from 'react';
import { QZTrayContext } from '../contexts/QZTrayContext';
import type { LabTemplateRecord, PreparedPDFBundle, PdfCoRequestOptions } from '../utils/pdfService';
import {
  generateAndSavePDFReportWithProgress,
  ReportData,
  selectTemplateForContext,
  createReportDataFromContext,
  preparePDFBundle,
  regeneratePDFWithSettings,
} from '../utils/pdfService';
import { supabase, database } from '../utils/supabase';
import { getShareableReportLink, getReportLinkState } from '../utils/reportLink';

export async function isOrderReportReady(orderId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("v_result_panel_status")
    .select("panel_ready")
    .eq("order_id", orderId);

  if (error) return false;
  if (!data?.length) return false;
  return data.every(r => r.panel_ready);
}

interface PDFGenerationState {
  isGenerating: boolean;
  stage: string;
  progress: number;
  error?: string;
  pdfUrl?: string;
  /**
   * Stable link to hand a patient. Populated BEFORE generation starts, so it can
   * be copied or sent while the PDF is still rendering -- unlike pdfUrl, which
   * only arrives once the edge function has finished uploading to storage.
   * Undefined when the lab is not enrolled; callers should fall back to pdfUrl.
   */
  shareUrl?: string;
}

export const usePDFGeneration = () => {
  const { autoPrintReport } = useContext(QZTrayContext);
  const [state, setState] = useState<PDFGenerationState>({
    isGenerating: false,
    stage: '',
    progress: 0
  });

  // Cache the last prepared bundle for regeneration with different settings
  const lastBundleRef = useRef<PreparedPDFBundle | null>(null);
  const lastReportDataRef = useRef<ReportData | null>(null);

  const generatePDF = useCallback(async (orderId: string, forceDraft = false, draftVariant: 'ecopy' | 'print' = 'ecopy') => {
    setState({
      isGenerating: true,
      stage: 'Initializing...',
      progress: 0,
      error: undefined,
      pdfUrl: undefined,
      shareUrl: undefined
    });

    // Runs the edge function through to the storage upload. Held as its own
    // promise so the UI can stop waiting on it once the report is merely
    // viewable, while auto-print and error reporting still get the real storage
    // URL whenever it eventually lands.
    const runGeneration = async () => {
      const { data: authData } = await supabase.auth.getSession();
      if (!authData?.session) {
        throw new Error('Not authenticated');
      }

      // The edge function matches this against users.id — the id space the
      // WhatsApp backend registers senders under — not the auth UUID.
      const { data: limsUser } = await supabase
        .from('users')
        .select('id')
        .eq('auth_user_id', authData.session.user.id)
        .maybeSingle();

      const response = await supabase.functions.invoke('generate-pdf-letterhead', {
        body: {
          orderId,
          isDraft: forceDraft,
          // Last-resort WhatsApp sender on the server side; location and lab
          // configuration take precedence.
          triggeredByUserId: limsUser?.id ?? null
        }
      });

      if (response.error) {
        throw new Error(response.error.message || 'Edge Function failed');
      }

      const result = response.data;
      if (!result || !result.pdfUrl) {
        throw new Error('No PDF URL returned from Edge Function');
      }

      // Choose eCopy or Print URL based on draftVariant
      const usePrint = draftVariant === 'print' && !!result.printPdfUrl;
      if (draftVariant === 'print' && !result.printPdfUrl) {
        console.warn('Print PDF URL not available, falling back to eCopy');
      }
      return { result, pdfUrl: usePrint ? result.printPdfUrl : result.pdfUrl };
    };

    /** The original completion path: verify the file, show it, auto-print. */
    const finishWithFile = async (result: any, pdfUrl: string) => {
      const fetchResponse = await fetch(pdfUrl, { method: 'HEAD' });
      if (!fetchResponse.ok) {
        throw new Error('Failed to access generated PDF URL');
      }
      const isDraft = result.status === 'draft';
      setState(prev => ({
        ...prev,
        stage: isDraft ? 'Draft PDF ready to view' : 'Final PDF ready to view',
        progress: 100,
        pdfUrl
      }));
      // Auto-print report via LIMS Utility queue if enabled (only for final/approved reports, not drafts)
      if (!isDraft) {
        autoPrintReport(pdfUrl).catch(() => {});
      }
    };

    /**
     * Waits until the stable link actually resolves to a PDF.
     *
     * Deliberately NOT the moment the token exists: at t=0 it would only serve
     * the "preparing" page, so View would open a spinner. 'temp' means PDF.co
     * has finished rendering -- still well before the download/upload tail the
     * edge function spends most of its time in.
     */
    const waitForViewableLink = async (): Promise<boolean> => {
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        const status = await getReportLinkState(orderId, 'final');
        if (status === 'temp' || status === 'permanent') return true;
        await new Promise(resolve => setTimeout(resolve, 800));
      }
      return false;
    };

    try {
      // Reserve the shareable link up front. The token is valid immediately and
      // never changes, so it can be copied or sent while the render/upload chain
      // below is still running.
      // Always the 'final' variant: the print copy is an internal artefact and is
      // never what gets shared, and the generator only publishes temp URLs for
      // final/compact -- a 'print' row would rely solely on backfill.
      const shareUrl = await getShareableReportLink(orderId, 'final');
      if (shareUrl) setState(prev => ({ ...prev, shareUrl }));

      setState(prev => ({ ...prev, stage: 'Generating PDF via Edge Function...', progress: 30 }));
      const generation = runGeneration();

      // Labs not enrolled in stable links have no token to wait on, so there is
      // nothing to do but await the function -- exactly the previous behaviour.
      if (!shareUrl) {
        const { result, pdfUrl } = await generation;
        setState(prev => ({ ...prev, stage: 'PDF generated, preparing preview...', progress: 80 }));
        await finishWithFile(result, pdfUrl);
        return;
      }

      // Enrolled: race the link becoming viewable against the function finishing.
      // Whichever happens first releases the UI.
      const outcome = await Promise.race([
        waitForViewableLink().then(ready => ({ kind: 'link' as const, ready })),
        generation.then(
          g => ({ kind: 'done' as const, ...g }),
          error => ({ kind: 'error' as const, error })
        )
      ]);

      if (outcome.kind === 'error') throw outcome.error;

      if (outcome.kind === 'done') {
        setState(prev => ({ ...prev, stage: 'PDF generated, preparing preview...', progress: 80 }));
        await finishWithFile(outcome.result, outcome.pdfUrl);
        return;
      }

      if (!outcome.ready) {
        // Link never became viewable within the window; fall back to waiting.
        const { result, pdfUrl } = await generation;
        await finishWithFile(result, pdfUrl);
        return;
      }

      // The link resolves now. Release the UI and point View at the token, which
      // stays correct even after the storage URL is swapped in underneath it.
      setState(prev => ({
        ...prev,
        stage: 'Report ready to view and share',
        progress: 100,
        pdfUrl: shareUrl
      }));

      // The upload tail keeps running. Auto-print needs the real file (a print
      // bridge cannot consume the resolver's HTML wait page), and generation
      // failures must still surface even though nothing is awaiting them.
      generation
        .then(({ result, pdfUrl }) => {
          if (result.status !== 'draft') {
            autoPrintReport(pdfUrl).catch(() => {});
          }
        })
        .catch(error => {
          console.error('Background PDF generation failed:', error);
          setState(prev => ({
            ...prev,
            stage: 'PDF generation failed after the link was issued',
            error: error instanceof Error ? error.message : 'Unknown error'
          }));
        });
    } catch (error) {
      console.error('Edge Function PDF generation failed:', error);
      setState(prev => ({
        ...prev,
        stage: 'PDF generation failed',
        progress: 0,
        error: error instanceof Error ? error.message : 'Unknown error'
      }));
    }
  }, []);

  const resetState = useCallback(() => {
      setState({
        isGenerating: false,
        stage: '',
        progress: 0,
        error: undefined,
        pdfUrl: undefined
      });
  }, []);

  /**
   * Regenerate PDF with custom settings using cached HTML bundle
   */
  const regenerateWithSettings = useCallback(async (
    orderId: string,
    options: PdfCoRequestOptions
  ): Promise<string | null> => {
    setState({
      isGenerating: true,
      stage: 'Preparing for regeneration...',
      progress: 0,
      error: undefined,
      pdfUrl: undefined
    });

    try {
      let bundle = lastBundleRef.current;
      
      // If no cached bundle or different order, prepare fresh
      if (!bundle || bundle.orderId !== orderId) {
        setState(prev => ({ ...prev, stage: 'Loading report context...', progress: 10 }));
        
        const { data: context, error: contextError } = await database.reports.getTemplateContext(orderId);
        if (contextError || !context) {
          throw new Error(contextError?.message || 'Failed to load report context');
        }

        const isDraft = context.meta?.allAnalytesApproved !== true;
        
        let selectedTemplate: LabTemplateRecord | null = null;
        let allTemplates: LabTemplateRecord[] = [];
        try {
          const { data: templates } = await database.labTemplates.list();
          if (Array.isArray(templates) && templates.length > 0) {
            allTemplates = templates as LabTemplateRecord[];
            selectedTemplate = selectTemplateForContext(allTemplates, context);
          }
        } catch (e) {
          console.warn('Template fetch failed:', e);
        }

        setState(prev => ({ ...prev, stage: 'Preparing report data...', progress: 30 }));

        const reportData = createReportDataFromContext(context, {
          template: selectedTemplate,
          isDraft,
        });
        
        lastReportDataRef.current = reportData;
        
        setState(prev => ({ ...prev, stage: 'Building HTML bundle...', progress: 50 }));
        
        bundle = await preparePDFBundle(orderId, reportData, isDraft, allTemplates);
        lastBundleRef.current = bundle;
      }

      setState(prev => ({ ...prev, stage: 'Regenerating PDF with custom settings...', progress: 70 }));

      const pdfUrl = await regeneratePDFWithSettings(bundle, options);

      if (pdfUrl) {
        setState(prev => ({ ...prev, stage: 'Waiting for PDF to be ready...', progress: 85 }));
        
        // Retry checking the PDF with exponential backoff
        // PDF.co S3 URLs sometimes need time to propagate
        const maxDownloadRetries = 5;
        const baseDelay = 1500;
        let lastError: Error | null = null;
        
        for (let attempt = 1; attempt <= maxDownloadRetries; attempt++) {
          try {
            setState(prev => ({ 
              ...prev, 
              stage: attempt > 1 ? `Retrying PDF check (attempt ${attempt})...` : 'Checking generated PDF...', 
              progress: 85 + (attempt * 2) 
            }));
            
            const response = await fetch(pdfUrl, { method: 'HEAD' });
            if (response.ok) {
              setState(prev => ({
                ...prev,
                stage: 'PDF ready to view',
                progress: 100,
                pdfUrl
              }));

              return pdfUrl;
            } else {
              lastError = new Error(`PDF check failed with status ${response.status}`);
              console.warn(`PDF check attempt ${attempt} failed:`, response.status);
            }
          } catch (fetchError) {
            lastError = fetchError instanceof Error ? fetchError : new Error('PDF check failed');
            console.warn(`PDF check attempt ${attempt} error:`, fetchError);
          }
          
          // Wait before retry (exponential backoff)
          if (attempt < maxDownloadRetries) {
            await new Promise(resolve => setTimeout(resolve, baseDelay * attempt));
          }
        }
        
        throw lastError || new Error('Failed to access PDF after multiple attempts');
      }
      
      return null;
    } catch (error) {
      setState(prev => ({
        ...prev,
        stage: 'PDF regeneration failed',
        progress: 0,
        error: error instanceof Error ? error.message : 'Unknown error'
      }));
      return null;
    }
  }, []);

  /**
   * Get the last cached bundle (for passing to settings modal)
   */
  const getCachedBundle = useCallback(() => lastBundleRef.current, []);

  return {
    ...state,
    generatePDF,
    regenerateWithSettings,
    getCachedBundle,
    resetState
  };
};

export default usePDFGeneration;
