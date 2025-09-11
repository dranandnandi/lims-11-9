import { useState, useCallback } from 'react';
import { downloadPDFReport, ReportData } from '../utils/pdfService';

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

  const generatePDF = useCallback(async (orderId: string, reportData: ReportData) => {
    setState({
      isGenerating: true,
      stage: 'Initializing...',
      progress: 0,
      error: undefined
    });

    try {
      const success = await downloadPDFReport(
        orderId,
        reportData,
        (stage: string, progress?: number) => {
          setState(prev => ({
            ...prev,
            stage,
            progress: progress || prev.progress
          }));
        }
      );

      if (success) {
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