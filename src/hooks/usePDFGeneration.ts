import { useState, useCallback } from 'react';
import type { LabTemplateRecord } from '../utils/pdfService';
import { database } from '../utils/supabase';
import { generateFinalReportPDF, downloadReportPDF } from '../utils/pdfReportService';
import { supabase } from '../utils/supabase';

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
}

export const usePDFGeneration = () => {
  const [state, setState] = useState<PDFGenerationState>({
    isGenerating: false,
    stage: '',
    progress: 0
  });

  const generatePDF = useCallback(async (orderId: string, forceDraft = false) => {
    setState({
      isGenerating: true,
      stage: 'Initializing...',
      progress: 0,
      error: undefined
    });

    try {
      // Check if order is ready (for non-draft reports)
      if (!forceDraft) {
        const { data: context, error: contextError } = await database.reports.getTemplateContext(orderId);
        if (contextError || !context) {
          throw new Error('Failed to load report context');
        }

        if (!Array.isArray(context.analytes) || context.analytes.length === 0) {
          throw new Error('No test results found for this order');
        }
      }

      // Load templates
      const { data: templates, error: templateError } = await database.labTemplates.list();
      const allTemplates = (templates as LabTemplateRecord[]) || [];

      // Use new simplified service to generate PDF
      const pdfUrl = await generateFinalReportPDF(
        orderId,
        (stage: string, progress?: number) => {
          setState(prev => ({
            ...prev,
            stage,
            progress: progress ?? prev.progress,
          }));
        },
        allTemplates
      );

      if (pdfUrl) {
        setState(prev => ({ ...prev, stage: 'Starting download...', progress: 95 }));
        
        // Download the PDF
        const { data: context } = await database.reports.getTemplateContext(orderId);
        const safePatientName = context?.patient?.name?.replace(/\s+/g, '_') || 'Patient';
        const isDraft = forceDraft || context?.meta?.allAnalytesApproved !== true;
        const filename = `${safePatientName}_${orderId}${isDraft ? '_DRAFT' : ''}.pdf`;
        
        await downloadReportPDF(pdfUrl, filename);
        
        setState(prev => ({
          ...prev,
          stage: 'PDF downloaded successfully!',
          progress: 100
        }));
        
        // Auto-hide after 2 seconds on success
        setTimeout(() => {
          setState(prev => ({ ...prev, isGenerating: false }));
        }, 2000);
      } else {
        setState(prev => ({
          ...prev,
          stage: 'PDF generation failed',
          progress: 0,
          error: 'Failed to generate PDF'
        }));
      }
    } catch (error) {
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
      error: undefined
    });
  }, []);

  return {
    ...state,
    generatePDF,
    resetState
  };
};

export default usePDFGeneration;