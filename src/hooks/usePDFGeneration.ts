import { useState, useCallback } from 'react';
import { generateAndSavePDFReportWithProgress, ReportData } from '../utils/pdfService';
import { supabase } from '../utils/supabase';

interface PDFGenerationState {
  isGenerating: boolean;
  stage: string;
  progress: number;
  error?: string;
}

// New types for the improved PDF generation
export type PDFAnalyte = {
  id: string;
  result_id: string;
  parameter: string;
  value: string | null;
  unit: string;
  reference_range: string;
  flag: string | null;
  verify_status: "pending" | "approved" | "rejected" | null;
};

export type PDFPanel = {
  result_id: string;
  test_group_id: string | null;
  test_name: string;
  analytes: PDFAnalyte[];
};

// Fetch order report data with proper grouping to avoid duplicates
export async function fetchOrderReportData(
  orderId: string,
  { onlyApproved = false }: { onlyApproved?: boolean } = {}
): Promise<PDFPanel[]> {
  // 1) Get all results/panels for the order (once)
  const { data: results, error: rErr } = await supabase
    .from("results")
    .select("id, test_group_id, test_name")
    .eq("order_id", orderId)
    .order("test_name", { ascending: true });

  if (rErr || !results?.length) return [];

  const resultIds = results.map(r => r.id);

  // 2) Get analytes for all those results in ONE round-trip
  let q = supabase
    .from("result_values")
    .select("id, result_id, parameter, value, unit, reference_range, flag, verify_status")
    .in("result_id", resultIds)
    .order("parameter", { ascending: true });

  if (onlyApproved) {
    q = q.eq("verify_status", "approved");
  }

  const { data: rows, error: aErr } = await q;
  if (aErr) return [];

  // 3) Group analytes by result_id
  const byResult = new Map<string, PDFAnalyte[]>();
  (rows || []).forEach((rv) => {
    const arr = byResult.get(rv.result_id) || [];
    arr.push(rv as PDFAnalyte);
    byResult.set(rv.result_id, arr);
  });

  // 4) Build panels – no duplicates
  const panels: PDFPanel[] = results.map((r) => ({
    result_id: r.id,
    test_group_id: r.test_group_id,
    test_name: r.test_name,
    analytes: (byResult.get(r.id) || []).filter((a, idx, self) => {
      // Guard against dupes by (parameter + result_id)
      const key = `${a.result_id}::${a.parameter}`;
      const firstIdx = self.findIndex(
        x => `${x.result_id}::${x.parameter}` === key
      );
      return firstIdx === idx;
    }),
  }));

  return panels;
}

// Check if order report is ready (all panels have approved analytes)
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
      setState(prev => ({ ...prev, stage: 'Fetching order data...', progress: 10 }));
      
      // Get order + patient header info
      const { data: orderData, error: orderError } = await supabase
        .from("orders")
        .select(`
          id, 
          patient_name, 
          patient_id, 
          doctor, 
          order_date,
          patients!inner(age, gender, phone)
        `)
        .eq("id", orderId)
        .single();

      if (orderError || !orderData) {
        throw new Error('Failed to fetch order data');
      }

      setState(prev => ({ ...prev, stage: 'Checking panel readiness...', progress: 20 }));

      // Get panel readiness
      const { data: readyRows } = await supabase
        .from("v_result_panel_status")
        .select("result_id, panel_ready, expected_analytes, approved_analytes")
        .eq("order_id", orderId);

      const anyUnready = readyRows?.some(r => !r.panel_ready) || false;
      const isDraft = forceDraft || anyUnready;

      setState(prev => ({ ...prev, stage: 'Fetching test results...', progress: 40 }));

      // Fetch panels with proper deduplication
      const onlyApproved = !isDraft;
      const panels = await fetchOrderReportData(orderId, { onlyApproved });

      if (panels.length === 0) {
        throw new Error('No test results found for this order');
      }

      setState(prev => ({ ...prev, stage: 'Preparing report data...', progress: 60 }));

      // Convert panels to ReportData format for PDF generation
      const testResults = panels.flatMap(panel => 
        panel.analytes.map(analyte => ({
          parameter: `${panel.test_name} - ${analyte.parameter}`,
          result: analyte.value || '—',
          unit: analyte.unit || '',
          referenceRange: analyte.reference_range || '',
          flag: analyte.flag || ''
        }))
      );

      const reportData: ReportData = {
        patient: {
          name: orderData.patient_name,
          id: orderData.patient_id,
          age: (orderData.patients as any)?.age || 0,
          gender: (orderData.patients as any)?.gender || 'Unknown',
          referredBy: orderData.doctor || 'Self'
        },
        report: {
          reportId: orderId,
          collectionDate: orderData.order_date,
          reportDate: new Date().toISOString(),
          reportType: isDraft ? 'Lab Tests (DRAFT)' : 'Lab Tests'
        },
        testResults,
        interpretation: isDraft 
          ? 'DRAFT REPORT: Some results may still be pending verification.'
          : 'Final report based on approved lab results.'
      };

      // Instead of using downloadPDFReport, call generateAndSavePDFReportWithProgress directly
      // to have better control over the draft parameter
      setState(prev => ({ ...prev, stage: 'Generating PDF...', progress: 80 }));

      const pdfUrl = await generateAndSavePDFReportWithProgress(
        orderId,
        reportData,
        (stage: string, progress?: number) => {
          setState(prev => ({
            ...prev,
            stage,
            progress: progress || prev.progress
          }));
        },
        isDraft
      );

      if (pdfUrl) {
        setState(prev => ({ ...prev, stage: 'Starting download...', progress: 95 }));
        
        // Download the PDF
        const filename = `${reportData.patient.name.replace(/\s+/g, '_')}_${orderId}${isDraft ? '_DRAFT' : ''}.pdf`;
        const response = await fetch(pdfUrl);
        if (response.ok) {
          const blob = await response.blob();
          const downloadUrl = window.URL.createObjectURL(blob);
          
          const link = document.createElement('a');
          link.href = downloadUrl;
          link.download = filename;
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
          window.URL.revokeObjectURL(downloadUrl);
          
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
          throw new Error('Failed to download PDF');
        }
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