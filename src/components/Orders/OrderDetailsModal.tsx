import React, { useState } from 'react';
import {
  X, Upload, FileText, Brain, Zap, CheckCircle, AlertTriangle, Target, Layers,
  TestTube2, QrCode, Calendar, Clock, ArrowRight, Printer
} from 'lucide-react';
import QRCodeLib from 'qrcode';
import { supabase, uploadFile, generateFilePath, database } from '../../utils/supabase';
import { useAuth } from '../../contexts/AuthContext';
import { calculateFlagsForResults } from '../../utils/flagCalculation';

interface WorkflowStep {
  name: string;
  description: string;
  completed: boolean;
  current: boolean;
  timestamp?: string;
}

interface NextStep {
  action: string;
  description: string;
  urgent?: boolean;
  priority?: 'low' | 'medium' | 'high';
  assignedTo?: string;
  deadline?: string;
}

interface StatusAction {
  status: string;
  label: string;
  primary?: boolean;
}

// Helper function to get workflow steps based on current status
const getWorkflowSteps = (currentStatus: string, order?: any): WorkflowStep[] => {
  const allSteps = [
    { name: 'Order Created', description: 'Order placed and confirmed' },
    { name: 'Sample Collection', description: 'Collect sample from patient' },
    { name: 'In Progress', description: 'Laboratory analysis in progress' },
    { name: 'Pending Approval', description: 'Results awaiting approval' },
    { name: 'Completed', description: 'Results approved and ready' },
    { name: 'Delivered', description: 'Results delivered to patient' },
  ];

  const statusOrder = ['Order Created', 'Sample Collection', 'In Progress', 'Pending Approval', 'Completed', 'Delivered'];
  const currentIndex = statusOrder.indexOf(currentStatus);

  return allSteps.map((step, index) => {
    let completed = index < currentIndex;
    let current = index === currentIndex;
    
    // Special logic for Sample Collection step - check actual collection status
    if (step.name === 'Sample Collection') {
      const sampleCollected = order?.sample_collected_at;
      if (sampleCollected) {
        completed = true;
        current = false;
      } else if (currentStatus === 'Sample Collection') {
        completed = false;
        current = true;
      } else if (currentIndex > 1) {
        // If we're past Sample Collection status but sample not collected, keep it pending
        completed = false;
        current = false;
      }
    }

    return {
      ...step,
      completed,
      current,
      timestamp: (completed || current) ? (step.name === 'Sample Collection' && order?.sample_collected_at ? order.sample_collected_at : new Date().toISOString()) : undefined
    };
  });
};

// Helper function to get next steps based on current status
const getNextSteps = (currentStatus: string, order: any): NextStep[] => {
  switch (currentStatus) {
    case 'Order Created':
      return [{
        action: 'Collect Sample',
        description: `Collect ${order.color_name || 'assigned'} tube sample from patient ${order.patient_name}`,
        urgent: true,
        priority: 'high',
        assignedTo: 'Sample Collection Team',
        deadline: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()
      }];
    case 'Sample Collection':
      return [{
        action: 'Begin Laboratory Analysis',
        description: 'Process sample and begin testing procedures',
        priority: 'high',
        assignedTo: 'Laboratory Team',
        deadline: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
      }];
    case 'In Progress':
      return [
        { action: 'Complete Testing', description: 'Finish all laboratory tests and enter results', priority: 'medium', assignedTo: 'Lab Technicians' },
        { action: 'Enter Results', description: 'Input test results into the system', priority: 'high', assignedTo: 'Data Entry Team' }
      ];
    case 'Pending Approval':
      return [{
        action: 'Review & Approve Results',
        description: 'Medical review and approval of test results',
        urgent: true, priority: 'high', assignedTo: 'Medical Officer', deadline: order.expected_date
      }];
    case 'Completed':
      return [{ action: 'Deliver Results', description: 'Send results to patient via preferred method', priority: 'medium', assignedTo: 'Patient Services' }];
    case 'Delivered':
      return [{ action: 'Follow Up', description: 'Follow up with patient if needed', priority: 'low', assignedTo: 'Patient Care Team' }];
    default:
      return [];
  }
};

// Helper function to get available status actions
const getAvailableStatusActions = (currentStatus: string, order?: any): StatusAction[] => {
  switch (currentStatus) {
    case 'Order Created': 
      return [{ status: 'Sample Collection', label: 'Mark Sample Collected', primary: true }];
    case 'Sample Collection': 
      return [{ status: 'In Progress', label: 'Start Processing', primary: true }];
    case 'In Progress': 
      return [{ status: 'Pending Approval', label: 'Submit for Approval', primary: true }];
    case 'Pending Approval': 
      return [
        { status: 'Completed', label: 'Approve Results', primary: true }, 
        { status: 'In Progress', label: 'Return for Revision' }
      ];
    case 'Completed': 
      return [{ status: 'Delivered', label: 'Mark as Delivered', primary: true }];
    default: 
      return [];
  }
};

interface ExtractedValue {
  parameter: string;
  value: string;
  unit: string;
  reference: string;
  flag?: string;
}

interface Order {
  id: string;
  patient_name: string;
  patient_id: string;
  tests: string[];
  status: string;
  priority: string;
  order_date: string;
  expected_date: string;
  total_amount: number;
  doctor: string;
  sample_id?: string;
  color_code?: string;
  color_name?: string;
  qr_code_data?: string;
  sample_collected_at?: string;
  sample_collected_by?: string;
}

interface OrderDetailsModalProps {
  order: Order;
  onClose: () => void;
  onUpdateStatus: (orderId: string, newStatus: string) => void;
  onSubmitResults: (orderId: string, resultsData: ExtractedValue[]) => void;
}

interface TestGroupResult {
  test_group_id: string
  test_group_name: string
  analytes: {
    id: string
    name: string
    code: string
    units?: string
    reference_range?: string
    normal_range_min?: number
    normal_range_max?: number
    existing_result?: {
      id: string
      value: string
      status: string
      verified_at?: string
    }
  }[]
}

const OrderDetailsModal: React.FC<OrderDetailsModalProps> = ({
  order,
  onClose,
  onUpdateStatus,
  onSubmitResults
}) => {
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState<'details' | 'results'>('details');
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const [attachmentId, setAttachmentId] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isOCRProcessing, setIsOCRProcessing] = useState(false);
  const [ocrResults, setOcrResults] = useState<any>(null);
  const [ocrError, setOcrError] = useState<string | null>(null);
  const [extractedValues, setExtractedValues] = useState<ExtractedValue[]>([]);
  const [manualValues, setManualValues] = useState<ExtractedValue[]>([]);
  const [allAnalytes, setAllAnalytes] = useState<any[]>([]);
  const [existingResultId, setExistingResultId] = useState<string | null>(null);
  const [orderAnalytes, setOrderAnalytes] = useState<any[]>([]);
  const [selectedAnalyteForAI, setSelectedAnalyteForAI] = useState<any | null>(null);
  const [aiProcessingConfig, setAiProcessingConfig] = useState<{ type: string, prompt?: string } | null>(null);
  const [savingDraft, setSavingDraft] = useState(false);
  const [submittingResults, setSubmittingResults] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [testGroups, setTestGroups] = useState<TestGroupResult[]>([])
  const [selectedTestGroup, setSelectedTestGroup] = useState<string>()
  const [activeEntryMode, setActiveEntryMode] = useState<'manual' | 'ai'>('manual')

  // Function to generate QR code as data URL for display
  const generateQRCodeDataURL = async (data: string): Promise<string> => {
    try {
      return await QRCodeLib.toDataURL(data, { width: 200, margin: 2, color: { dark: '#000000', light: '#FFFFFF' } });
    } catch {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      canvas.width = 200; canvas.height = 200;
      if (ctx) {
        ctx.fillStyle = '#000000'; ctx.fillRect(0, 0, 200, 200);
        ctx.fillStyle = '#ffffff';
        for (let i = 0; i < 20; i++) for (let j = 0; j < 20; j++) if ((i + j) % 3 === 0 || i === j) ctx.fillRect(i * 10, j * 10, 10, 10);
      }
      return canvas.toDataURL('image/png');
    }
  };

  // State for QR code image
  const [qrCodeImage, setQrCodeImage] = useState<string>('');

  // Generate QR code when component mounts or QR data changes
  React.useEffect(() => {
    if (order.qr_code_data) {
      generateQRCodeDataURL(order.qr_code_data).then(setQrCodeImage);
    }
  }, [order.qr_code_data]);

  // Function to print QR code
  const handlePrintQRCode = async () => {
    if (!order.qr_code_data) return;
    const printWindow = window.open('', '_blank');
    if (!printWindow) return;
    const qrCodeImageForPrint = await generateQRCodeDataURL(order.qr_code_data);
    printWindow.document.write(`
      <!DOCTYPE html><html><head><title>Sample QR Code - ${order.sample_id || ''}</title>
      <style>
        body{font-family:Arial,sans-serif;margin:20px;text-align:center}
        .qr-container{border:2px solid #000;padding:20px;display:inline-block;margin:20px}
        .qr-code{width:200px;height:200px;margin:10px auto;border:1px solid #ccc}
        .sample-info{margin-top:20px;text-align:left}
        .sample-info div{margin:5px 0}
        .color-indicator{width:30px;height:30px;border-radius:50%;display:inline-block;margin-right:10px;vertical-align:middle;border:2px solid #333}
        @media print{body{margin:0}}
      </style></head><body>
        <div class="qr-container">
          <h2>Sample Tracking Label</h2>
          <img src="${qrCodeImageForPrint}" alt="QR Code" class="qr-code" />
          <div class="sample-info">
            <div><strong>Sample ID:</strong> ${order.sample_id || 'N/A'}</div>
            <div><strong>Patient:</strong> ${order.patient_name}</div>
            <div><strong>Order ID:</strong> ${order.id}</div>
            <div><strong>Sample Tube:</strong> <span class="color-indicator" style="background-color:${order.color_code}"></span>${order.color_name || ''}</div>
            <div><strong>Order Date:</strong> ${new Date(order.order_date).toLocaleDateString()}</div>
            <div><strong>Tests:</strong> ${order.tests.join(', ')}</div>
          </div>
        </div>
        <script>window.onload=()=>{window.print();window.onafterprint=()=>window.close();}</script>
      </body></html>`);
    printWindow.document.close();
  };

  React.useEffect(() => {
    fetchAllAnalytes();
    fetchOrderAnalytes();
  }, []);

  React.useEffect(() => {
    if (orderAnalytes.length > 0) {
      setManualValues(orderAnalytes.map((analyte) => ({
        parameter: analyte.name,
        value: '',
        unit: analyte.unit || '',
        reference: analyte.reference_range || '',
        flag: undefined
      })));
      fetchExistingResult();
    }
  }, [orderAnalytes]);

  const fetchAllAnalytes = async () => {
    try {
      const { data, error } = await supabase
        .from('analytes')
        .select('id, name, unit, reference_range, low_critical, high_critical, category, ai_processing_type, ai_prompt_override')
        .eq('is_active', true);
      if (!error) setAllAnalytes(data || []);
    } catch (err) {
      console.error('Error fetching analytes:', err);
    }
  };

  const fetchOrderAnalytes = async () => {
    try {
      const { data: orderData, error: orderError } = await database.orders.getById(order.id);
      if (orderError || !orderData) return;

      // Enhanced query using both order_test_groups and order_tests tables
      const { data, error } = await supabase
        .from('orders')
        .select(`
          id,
          lab_id,
          patient_id,
          patient_name,
          order_test_groups(
            id,
            test_group_id,
            test_name,
            price,
            test_groups(
              id,
              name,
              code,
              lab_id,
              test_group_analytes(
                analyte_id,
                analytes(
                  id,
                  name,
                  unit,
                  reference_range,
                  ai_processing_type,
                  ai_prompt_override
                )
              )
            )
          ),
          order_tests(
            id,
            test_name,
            test_group_id,
            sample_id,
            test_groups(
              id,
              name,
              code,
              lab_id,
              test_group_analytes(
                analyte_id,
                analytes(
                  id,
                  name,
                  unit,
                  reference_range,
                  ai_processing_type,
                  ai_prompt_override
                )
              )
            )
          ),
          samples(
            id,
            sample_type,
            barcode,
            status,
            collected_at,
            collected_by
          ),
          results(
            id,
            order_id,
            test_name,
            status,
            verified_at,
            verified_by,
            created_at,
            order_test_group_id,
            order_test_id,
            test_group_id,
            lab_id,
            result_values(
              id,
              analyte_name,
              value,
              unit,
              reference_range,
              flag,
              analyte_id,
              order_test_group_id,
              order_test_id
            )
          )
        `)
        .eq('id', order.id)
        .single()

      if (error) throw error

      // Combine test groups from both order_test_groups and order_tests
      const testGroupsFromOrderTestGroups = data.order_test_groups ? data.order_test_groups
        .filter(otg => otg.test_groups)
        .map(otg => ({
          test_group_id: otg.test_groups.id,
          test_group_name: otg.test_groups.name,
          order_test_group_id: otg.id,
          order_test_id: null,
          source: 'order_test_groups',
          analytes: otg.test_groups.test_group_analytes?.map(tga => ({
            ...tga.analytes,
            code: otg.test_groups.code,
            units: tga.analytes.unit,
            existing_result: data.results?.find(r => 
              r.order_test_group_id === otg.id
            )?.result_values?.find(rv => rv.analyte_id === tga.analytes.id)
          })) || []
        })) : []

      const testGroupsFromOrderTests = data.order_tests ? data.order_tests
        .filter(ot => ot.test_groups && ot.test_group_id)
        .map(ot => ({
          test_group_id: ot.test_groups.id,
          test_group_name: ot.test_groups.name,
          order_test_group_id: null,
          order_test_id: ot.id,
          source: 'order_tests',
          analytes: ot.test_groups.test_group_analytes?.map(tga => ({
            ...tga.analytes,
            code: ot.test_groups.code,
            units: tga.analytes.unit,
            existing_result: data.results?.find(r => 
              r.order_test_id === ot.id
            )?.result_values?.find(rv => rv.analyte_id === tga.analytes.id)
          })) || []
        })) : []

      // Merge and deduplicate test groups
      const allTestGroups = [...testGroupsFromOrderTestGroups, ...testGroupsFromOrderTests]
      const uniqueTestGroups = allTestGroups.reduce((acc, current) => {
        const existingIndex = acc.findIndex(tg => tg.test_group_id === current.test_group_id)
        if (existingIndex === -1) {
          acc.push(current)
        } else {
          // Merge analytes if same test group from different sources
          const existing = acc[existingIndex]
          const mergedAnalytes = [...existing.analytes]
          current.analytes.forEach(analyte => {
            if (!mergedAnalytes.find(ma => ma.id === analyte.id)) {
              mergedAnalytes.push(analyte)
            }
          })
          acc[existingIndex] = {
            ...existing,
            analytes: mergedAnalytes,
            // Prefer order_test_groups if available
            order_test_group_id: existing.order_test_group_id || current.order_test_group_id,
            order_test_id: existing.order_test_id || current.order_test_id
          }
        }
        return acc
      }, [] as typeof allTestGroups)

      setTestGroups(uniqueTestGroups)

      // Set manual values based on test groups
      const allAnalytes = uniqueTestGroups.flatMap(tg => tg.analytes)
      setManualValues(allAnalytes.map((analyte) => ({
        parameter: analyte.name,
        value: analyte.existing_result?.value || '',
        unit: analyte.units || analyte.unit || '',
        reference: analyte.reference_range || '',
        flag: analyte.existing_result?.flag || undefined
      })))

      // Also set orderAnalytes for backward compatibility
      setOrderAnalytes(allAnalytes)
    } catch (err) {
      console.error('Error fetching order analytes:', err);
    }
  };

  const fetchExistingResult = async () => {
    try {
      const { data, error } = await database.results.getByOrderId(order.id);
      if (error || !data?.length) return;
      const mostRecentResult = data[0];
      setExistingResultId(mostRecentResult.id);

      if (mostRecentResult.result_values?.length) {
        setManualValues(prev => {
          const updated = [...prev];
          mostRecentResult.result_values.forEach((rv: any) => {
            const idx = updated.findIndex(v => v.parameter === rv.parameter);
            if (idx !== -1) {
              updated[idx] = { ...updated[idx], value: rv.value, unit: rv.unit, reference: rv.reference_range, flag: rv.flag };
            }
          });
          return updated;
        });
      }
    } catch (err) {
      console.error('Error fetching existing result:', err);
    }
  };

  const handleFileUpload = async (file: File) => {
    setIsUploading(true);
    setOcrError(null);
    try {
      const filePath = generateFilePath(file.name, order.patient_id, undefined, 'order-results');
      const uploadResult = await uploadFile(file, filePath);
      const currentLabId = await database.getCurrentUserLabId();

      const { data: attachment, error } = await supabase
        .from('attachments')
        .insert([{
          patient_id: order.patient_id,
          lab_id: currentLabId,
          related_table: 'orders',
          related_id: order.id,
          file_url: uploadResult.publicUrl,
          file_path: uploadResult.path,
          original_filename: file.name,
          stored_filename: filePath.split('/').pop(),
          file_type: file.type,
          file_size: file.size,
          description: `Lab result document for order ${order.id}`,
          uploaded_by: user?.id || null,
          upload_timestamp: new Date().toISOString()
        }])
        .select()
        .single();

      if (error) throw new Error(error.message);
      setAttachmentId(attachment.id);
      setUploadedFile(file);
    } catch (err) {
      console.error('Error uploading file:', err);
      setOcrError('Failed to upload file. Please try again.');
    } finally {
      setIsUploading(false);
    }
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFileUpload(file);
  };

  const handleRunAIProcessing = async (analyteConfig?: { type: string, prompt?: string }) => {
    if (!attachmentId) { setOcrError('Please upload a file first.'); return; }

    const processingType = analyteConfig?.type || aiProcessingConfig?.type || 'ocr_report';
    const customPrompt = analyteConfig?.prompt || aiProcessingConfig?.prompt;

    setIsOCRProcessing(true);
    setOcrError(null);

    const analytesToExtract = manualValues.filter(v => v.value.trim() === '').map(v => v.parameter);

    try {
      const visionResponse = await supabase.functions.invoke('vision-ocr', {
        body: {
          attachmentId,
          documentType: processingType === 'ocr_report' ? 'printed-report' : undefined,
          testType: processingType === 'vision_card' ? 'test-card' : processingType === 'vision_color' ? 'color-analysis' : undefined,
          aiProcessingType: processingType,
          analysisType: processingType === 'ocr_report' ? 'text' : processingType === 'vision_card' ? 'objects' : processingType === 'vision_color' ? 'colors' : 'all'
        }
      });
      if (visionResponse.error) throw new Error(visionResponse.error.message);

      const visionData = visionResponse.data;

      const geminiResponse = await supabase.functions.invoke('gemini-nlp', {
        body: {
          rawText: visionData.fullText,
          visionResults: visionData,
          originalBase64Image: visionData.originalBase64Image,
          documentType: processingType === 'ocr_report' ? 'printed-report' : undefined,
          testType: processingType === 'vision_card' ? 'test-card' : processingType === 'vision_color' ? 'color-analysis' : undefined,
          aiProcessingType: processingType,
          aiPromptOverride: customPrompt,
          allAnalytes,
          analytesToExtract: analytesToExtract.length ? analytesToExtract : undefined
        },
        headers: { 'x-attachment-id': attachmentId, 'x-order-id': order.id }
      });
      if (geminiResponse.error) throw new Error(geminiResponse.error.message);

      const result = geminiResponse.data;

      if (analytesToExtract.length && result && typeof result === 'object' && !Array.isArray(result) && !result.extractedParameters) {
        setOcrResults(result);
        setManualValues(prev => {
          const updated = [...prev];
          Object.keys(result).forEach(paramName => {
            const idx = updated.findIndex(v => v.parameter === paramName);
            if (idx !== -1) updated[idx] = { ...updated[idx], value: result[paramName] };
          });
          return updated;
        });
        setExtractedValues([]);
      } else if (Array.isArray(result?.extractedParameters)) {
        const extractedParams = result.extractedParameters.map((p: any) => ({
          parameter: p.parameter,
          value: p.value,
          unit: p.unit || '',
          reference: p.reference_range || '',
          flag: p.flag || undefined,
          matched: !!p.matched,
          analyte_id: p.analyte_id || null,
          confidence: p.confidence || 0.95
        }));
        setExtractedValues(extractedParams);
        setOcrResults(result);
        setManualValues(prev => {
          const updated = [...prev];
          extractedParams.forEach((ep: ExtractedValue) => {
            const idx = updated.findIndex(v => v.parameter === ep.parameter);
            if (idx !== -1) updated[idx] = { ...updated[idx], value: ep.value, flag: ep.flag };
          });
          return updated;
        });
      } else if (result?.rawText) {
        setOcrError('OCR extracted text but could not parse structured data. Please enter results manually.');
      } else {
        setOcrError('No structured data could be extracted from the document.');
      }
    } catch (err) {
      console.error('Error running AI processing:', err);
      setOcrError('Failed to process document. Please try again.');
    } finally {
      setIsOCRProcessing(false);
    }
  };

  const handleManualValueChange = (index: number, field: keyof ExtractedValue, value: string) => {
    setManualValues(prev => prev.map((item, i) => (i === index ? { ...item, [field]: value } : item)));
  };

  const handleSaveDraft = async () => {
    const validResults = manualValues.filter(v => v.value.trim() !== '');
    if (!validResults.length) { alert('Please enter at least one test result before saving draft.'); return; }

    setSavingDraft(true);
    setSaveMessage(null);

    try {
      const resultValues = validResults.map(item => ({
        parameter: item.parameter,
        value: item.value,
        unit: item.unit,
        reference_range: item.reference,
        flag: item.flag
      }));
      const valuesWithFlags = calculateFlagsForResults(resultValues);

      const resultData = {
        order_id: order.id,
        patient_name: order.patient_name,
        patient_id: order.patient_id,
        test_name: order.tests.join(', '),
        status: 'Entered' as const,
        entered_by: user?.user_metadata?.full_name || user?.email || 'Unknown User',
        entered_date: new Date().toISOString().split('T')[0],
        values: valuesWithFlags
      };

      if (existingResultId) {
        const { error } = await database.results.update(existingResultId, resultData);
        if (error) throw new Error(error.message);
      } else {
        const { data, error } = await database.results.create(resultData);
        if (error) throw new Error(error.message);
        setExistingResultId(data.id);
      }

      setSaveMessage('Draft saved successfully!');
      setTimeout(() => setSaveMessage(null), 3000);
    } catch (err) {
      console.error('Error saving draft:', err);
      setSaveMessage('Failed to save draft. Please try again.');
      setTimeout(() => setSaveMessage(null), 5000);
    } finally {
      setSavingDraft(false);
    }
  };

  const handleSubmitResults = async () => {
    const validResults = manualValues.filter(v => v.value.trim() !== '');
    if (!validResults.length) { 
      alert('Please enter at least one test result.'); 
      return; 
    }

    setSubmittingResults(true);
    setSaveMessage(null);

    try {
      const currentUser = await supabase.auth.getUser();
      const userLabId = await database.getCurrentUserLabId();

      // Process each test group
      for (const testGroup of testGroups) {
        const testGroupResults = validResults.filter(v => 
          testGroup.analytes.some(a => a.name === v.parameter)
        );

        if (testGroupResults.length === 0) continue;

        try {
          // Create result record with proper schema fields for both sources
          const resultData = {
            order_id: order.id,
            patient_id: order.patient_id,
            patient_name: order.patient_name,
            test_name: testGroup.test_group_name,
            status: 'pending_verification',
            entered_by: currentUser.data.user?.email || 'Unknown User',
            entered_date: new Date().toISOString().split('T')[0],
            test_group_id: testGroup.test_group_id,
            lab_id: userLabId,
            extracted_by_ai: !!attachmentId,
            ai_confidence: ocrResults?.metadata?.ocrConfidence || null,
            attachment_id: attachmentId || null,
            ...(testGroup.order_test_group_id && { order_test_group_id: testGroup.order_test_group_id }),
            ...(testGroup.order_test_id && { order_test_id: testGroup.order_test_id })
          }

          const { data: savedResult, error: resultError } = await supabase
            .from('results')
            .insert(resultData)
            .select()
            .single();

          if (resultError) throw resultError;

          // Insert result_values with proper relationships
          const resultValuesData = testGroupResults.map(result => {
            const analyte = testGroup.analytes.find(a => a.name === result.parameter);
            return {
              result_id: savedResult.id,
              analyte_id: analyte?.id,
              analyte_name: result.parameter,
              parameter: result.parameter,
              value: result.value,
              unit: result.unit || '',
              reference_range: result.reference || '',
              flag: result.flag || null,
              order_id: order.id,
              test_group_id: testGroup.test_group_id,
              lab_id: userLabId,
              ...(testGroup.order_test_group_id && { order_test_group_id: testGroup.order_test_group_id }),
              ...(testGroup.order_test_id && { order_test_id: testGroup.order_test_id })
            };
          });

          const { error: valuesError } = await supabase
            .from('result_values')
            .insert(resultValuesData);

          if (valuesError) throw valuesError;

        } catch (testError) {
          console.error(`Error processing test group ${testGroup.test_group_name}:`, testError);
        }
      }

      setSaveMessage('Successfully saved test results!');
      setTimeout(() => onSubmitResults(order.id, validResults), 500);
      setTimeout(() => setSaveMessage(null), 5000);

    } catch (err) {
      console.error('Error submitting results:', err);
      setSaveMessage('Failed to submit results. Please try again.');
      setTimeout(() => setSaveMessage(null), 5000);
    } finally {
      setSubmittingResults(false);
    }
  };

  const handleSelectAnalyteForAI = (analyte: any) => {
    setSelectedAnalyteForAI(analyte);
    setAiProcessingConfig({ type: analyte.ai_processing_type || 'ocr_report', prompt: analyte.ai_prompt_override || undefined });
  };

  // Styling utils
  const styleUtils = {
    aiProcessingType: {
      label: (t: string) => ({ none: 'Manual Entry Only', ocr_report: 'OCR Report Processing', vision_card: 'Vision Card Analysis', vision_color: 'Vision Color Analysis' } as any)[t] || t,
      color: (t: string) => ({ none: 'bg-gray-100 text-gray-800', ocr_report: 'bg-blue-100 text-blue-800', vision_card: 'bg-green-100 text-green-800', vision_color: 'bg-purple-100 text-purple-800' } as any)[t] || 'bg-gray-100 text-gray-800'
    },
    status: (s: string) => ({ 'Sample Collection': 'bg-blue-100 text-blue-800', 'In Progress': 'bg-orange-100 text-orange-800', 'Pending Approval': 'bg-yellow-100 text-yellow-800', 'Completed': 'bg-green-100 text-green-800', 'Delivered': 'bg-gray-100 text-gray-800' } as any)[s] || 'bg-gray-100 text-gray-800',
    priority: (p: string) => ({ Normal: 'bg-gray-100 text-gray-800', Urgent: 'bg-orange-100 text-orange-800', STAT: 'bg-red-100 text-red-800' } as any)[p] || 'bg-gray-100 text-gray-800',
    flag: (f?: string) => (f === 'H' || f === 'High') ? 'text-red-600 bg-red-100' : (f === 'L' || f === 'Low') ? 'text-blue-600 bg-blue-100' : (f === 'C' || f === 'Critical') ? 'text-orange-600 bg-orange-100' : '',
    confidence: (c: number) => (c >= 0.95 ? 'text-green-600 bg-green-100' : c >= 0.9 ? 'text-yellow-600 bg-yellow-100' : 'text-red-600 bg-red-100')
  };

  const getAIProcessingTypeLabel = styleUtils.aiProcessingType.label;
  const getAIProcessingTypeColor = styleUtils.aiProcessingType.color;
  const getStatusColor = styleUtils.status;
  const getPriorityColor = styleUtils.priority;
  const getFlagColor = styleUtils.flag;
  const getConfidenceColor = styleUtils.confidence;

  const FLAG_OPTIONS = [
    { value: '', label: 'Normal' },
    { value: 'H', label: 'High' },
    { value: 'L', label: 'Low' },
    { value: 'C', label: 'Critical' }
  ];

  // Render file upload section
  const renderFileUpload = () => (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-2">
        Upload {aiProcessingConfig?.type === 'vision_card' ? 'Test Card Image' : aiProcessingConfig?.type === 'vision_color' ? 'Color Analysis Image' : 'Lab Result Document'}
      </label>
      <div className="border-2 border-dashed border-purple-300 rounded-lg p-4 text-center hover:border-purple-400 transition-colors">
        {uploadedFile ? (
          <div className="space-y-3">
            <div className="flex items-center justify-center"><div className="bg-purple-100 p-3 rounded-full"><FileText className="h-8 w-8 text-purple-600" /></div></div>
            <div>
              <div className="text-sm font-medium text-gray-900">{uploadedFile.name}</div>
              <div className="text-xs text-gray-500">{(uploadedFile.size / 1024 / 1024).toFixed(2)} MB</div>
              {aiProcessingConfig && <div className="text-xs text-purple-600 mt-1">AI Type: {getAIProcessingTypeLabel(aiProcessingConfig.type)}</div>}
            </div>
            <button onClick={() => document.getElementById('file-upload')?.click()} className="text-purple-600 hover:text-purple-700 text-sm font-medium bg-purple-100 px-3 py-1 rounded">Change File</button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex justify-center"><div className="bg-purple-100 p-3 rounded-full"><Upload className="h-8 w-8 text-purple-600" /></div></div>
            <div>
              <button
                onClick={() => document.getElementById('file-upload')?.click()}
                disabled={isUploading}
                className="flex items-center justify-center mx-auto px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:bg-purple-400 disabled:cursor-not-allowed transition-colors"
              >
                {isUploading ? (<><span className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent mr-2" />Uploading...</>) : (<><Upload className="h-4 w-4 mr-2" />Upload {aiProcessingConfig?.type === 'vision_card' ? 'Test Card' : aiProcessingConfig?.type === 'vision_color' ? 'Color Image' : 'Document'}</>)}
              </button>
              <p className="text-xs text-gray-500 mt-2">{aiProcessingConfig?.type === 'ocr_report' ? 'Supports JPG, PNG, PDF (max 10MB)' : 'Supports JPG, PNG (max 10MB)'}</p>
              {aiProcessingConfig && <p className="text-xs text-purple-600 mt-1">Optimized for: {getAIProcessingTypeLabel(aiProcessingConfig.type)}</p>}
            </div>
          </div>
        )}
      </div>

      <input id="file-upload" type="file" accept={aiProcessingConfig?.type === 'ocr_report' ? 'image/*,.pdf' : 'image/*'} onChange={handleFileInputChange} className="hidden" />
    </div>
  );

  // Test Group Result Entry Component (similar to ResultIntake.tsx)
  const TestGroupResultEntry: React.FC<{
    testGroup: TestGroupResult
    entryMode: 'manual' | 'ai'
  }> = ({ testGroup, entryMode }) => {
    const testGroupValues = manualValues.filter(v => 
      testGroup.analytes.some(a => a.name === v.parameter)
    )
    
    const completedCount = testGroupValues.filter(v => v.value.trim()).length

    return (
      <div className="border border-gray-200 rounded-lg p-4 mb-4">
        <div className="flex items-center justify-between mb-4">
          <h4 className="text-lg font-medium">{testGroup.test_group_name}</h4>
          <div className="flex items-center space-x-3">
            <span className="text-sm text-gray-500">
              {completedCount}/{testGroupValues.length} completed
            </span>
            <div className="w-16 bg-gray-200 rounded-full h-2">
              <div 
                className="bg-blue-600 h-2 rounded-full transition-all"
                style={{ width: `${(completedCount / testGroupValues.length) * 100}%` }}
              />
            </div>
          </div>
        </div>

        {entryMode === 'ai' && (
          <div className="mb-4 p-3 bg-purple-50 border border-purple-200 rounded-lg">
            <h5 className="text-sm font-medium text-purple-900 mb-2">AI Processing for {testGroup.test_group_name}</h5>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {testGroup.analytes.map((analyte) => (
                <div
                  key={analyte.id}
                  onClick={() => handleSelectAnalyteForAI(analyte)}
                  className={`p-2 border rounded cursor-pointer transition-all ${
                    selectedAnalyteForAI?.id === analyte.id ? 'border-purple-500 bg-purple-100' : 'border-gray-200 hover:border-gray-300'
                  }`}
                >
                  <div className="text-sm font-medium">{analyte.name}</div>
                  <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${getAIProcessingTypeColor(analyte.ai_processing_type || 'none')}`}>
                    {getAIProcessingTypeLabel(analyte.ai_processing_type || 'none')}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Parameter</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Value</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Unit</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Reference Range</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Flag</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {testGroupValues.map((value, index) => {
                const globalIndex = manualValues.findIndex(v => v.parameter === value.parameter)
                const analyte = testGroup.analytes.find(a => a.name === value.parameter)
                
                return (
                  <tr key={index} className="hover:bg-gray-50">
                    <td className="px-4 py-3 text-sm font-medium text-gray-900">
                      <div>{value.parameter}</div>
                      <div className="text-xs text-gray-500">({analyte?.code})</div>
                      {analyte?.existing_result && (
                        <div className="text-xs text-green-600 mt-1">
                          Current: {analyte.existing_result.value}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <input 
                        type="text" 
                        value={value.value} 
                        onChange={(e) => handleManualValueChange(globalIndex, 'value', e.target.value)} 
                        className="w-full px-2 py-1 border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-500" 
                        placeholder="Enter value" 
                      />
                    </td>
                    <td className="px-4 py-3">
                      <input 
                        type="text" 
                        value={value.unit} 
                        onChange={(e) => handleManualValueChange(globalIndex, 'unit', e.target.value)} 
                        className="w-full px-2 py-1 border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-500" 
                        placeholder="Unit" 
                      />
                    </td>
                    <td className="px-4 py-3">
                      <input 
                        type="text" 
                        value={value.reference} 
                        onChange={(e) => handleManualValueChange(globalIndex, 'reference', e.target.value)} 
                        className="w-full px-2 py-1 border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-500" 
                        placeholder="Reference range" 
                      />
                    </td>
                    <td className="px-4 py-3">
                      <select 
                        value={value.flag || ''} 
                        onChange={(e) => handleManualValueChange(globalIndex, 'flag', e.target.value)} 
                        className="w-full px-2 py-1 border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
                      >
                        {FLAG_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                      </select>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 bg-gray-600 bg-opacity-75 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-6xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <div>
            <h2 className="text-xl font-semibold text-gray-900">Order Details</h2>
            <p className="text-sm text-gray-600 mt-1">Order ID: {order.id}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-500 p-1 rounded">
            <X className="h-6 w-6" />
          </button>
        </div>

        {/* Tab Navigation */}
        <div className="border-b border-gray-200">
          <div className="flex space-x-8 px-6">
            <button
              onClick={() => setActiveTab('details')}
              className={`py-4 text-sm font-medium border-b-2 transition-colors ${activeTab === 'details' ? 'border-blue-500 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
            >
              Order Details
            </button>
            <button
              onClick={() => setActiveTab('results')}
              className={`py-4 text-sm font-medium border-b-2 transition-colors ${activeTab === 'results' ? 'border-blue-500 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
            >
              AI Result Entry
            </button>
          </div>
        </div>

        <div className="p-6">
          {activeTab === 'details' ? (
            <div className="space-y-6">
              {/* ===== TOP: Quick Status Updates (moved up) ===== */}
              <div className="bg-white border border-gray-200 rounded-lg p-6">
                <h3 className="text-lg font-semibold text-gray-900 mb-4">Quick Status Updates</h3>
                <div className="flex flex-wrap gap-3">
                  {getAvailableStatusActions(order.status, order).map(action => (
                    <button
                      key={action.status}
                      onClick={() => onUpdateStatus(order.id, action.status)}
                      className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${action.primary ? 'bg-blue-600 text-white hover:bg-blue-700' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}
                    >
                      {action.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Order Summary */}
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-6">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <div>
                    <div className="text-blue-600 font-medium">Patient</div>
                    <div className="text-blue-900 font-semibold">{order.patient_name}</div>
                    <div className="text-blue-700 text-sm">{order.patient_id}</div>
                  </div>
                  <div>
                    <div className="text-blue-600 font-medium">Status</div>
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getStatusColor(order.status)}`}>{order.status}</span>
                  </div>
                  <div>
                    <div className="text-blue-600 font-medium">Priority</div>
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getPriorityColor(order.priority)}`}>{order.priority}</span>
                  </div>
                  <div>
                    <div className="text-blue-600 font-medium">Amount</div>
                    <div className="text-blue-900 font-semibold">₹{order.total_amount.toLocaleString()}</div>
                  </div>
                </div>
              </div>

              {/* Sample Tracking Information */}
              {order.sample_id && (
                <div className="bg-green-50 border border-green-200 rounded-lg p-6">
                  <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center">
                    <TestTube2 className="h-5 w-5 mr-2 text-green-600" />
                    Sample Tracking Information
                  </h3>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    {/* Sample ID & Color */}
                    <div className="flex items-center space-x-4">
                      <div className="w-12 h-12 rounded-full border-4 border-gray-300 flex-shrink-0" style={{ backgroundColor: order.color_code }} title={`Sample Color: ${order.color_name}`} />
                      <div>
                        <div className="text-sm font-medium text-gray-700">Sample ID</div>
                        <div className="text-lg font-bold text-green-900">{order.sample_id}</div>
                        <div className="text-sm text-green-700">{order.color_name} Tube</div>
                      </div>
                    </div>

                    {/* QR Code */}
                    <div>
                      <div className="text-sm font-medium text-gray-700 mb-2 flex items-center justify-between">
                        <div className="flex items-center"><QrCode className="h-4 w-4 mr-1" />QR Code</div>
                        {order.qr_code_data && (
                          <button onClick={handlePrintQRCode} className="flex items-center px-2 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors">
                            <Printer className="h-3 w-3 mr-1" />Print Label
                          </button>
                        )}
                      </div>
                      {order.qr_code_data ? (
                        <div className="space-y-3">
                          <div className="bg-white border-2 border-green-300 rounded-lg p-4 text-center">
                            <div className="mb-2">
                              {qrCodeImage ? (
                                <img src={qrCodeImage} alt="Sample QR Code" className="w-32 h-32 mx-auto border border-gray-300 rounded" />
                              ) : (
                                <div className="w-32 h-32 mx-auto border border-gray-300 rounded bg-gray-100 flex items-center justify-center">
                                  <QrCode className="h-8 w-8 text-gray-400" />
                                </div>
                              )}
                            </div>
                            <div className="text-xs text-gray-600">Scan to access sample information</div>
                          </div>
                          {/* QR Code Data section hidden for cleaner UI */}
                          {/* Uncomment below to show technical QR data for debugging */}
                          {/* 
                          <div className="bg-gray-50 border border-green-300 rounded-lg p-3">
                            <div className="text-xs font-medium text-gray-700 mb-2">QR Code Data:</div>
                            <div className="text-xs font-mono text-gray-600 bg-white border rounded p-2 max-h-20 overflow-y-auto">
                              {(() => {
                                try { return JSON.stringify(JSON.parse(order.qr_code_data), null, 2); }
                                catch { return order.qr_code_data; }
                              })()}
                            </div>
                          </div>
                          */}
                        </div>
                      ) : (
                        <div className="text-sm text-gray-500 bg-gray-50 border border-gray-200 rounded-lg p-3 text-center">
                          <QrCode className="h-8 w-8 mx-auto mb-2 text-gray-400" />
                          No QR code generated
                        </div>
                      )}
                    </div>

                    {/* Collection Status */}
                    <div>
                      <div className="text-sm font-medium text-gray-700 mb-2">Collection Status</div>
                      {order.sample_collected_at ? (
                        <div className="bg-green-100 border border-green-300 rounded-lg p-3">
                          <div className="flex items-center text-green-800 mb-1"><CheckCircle className="h-4 w-4 mr-1" /><span className="font-medium">Collected</span></div>
                          <div className="text-xs text-green-700">{new Date(order.sample_collected_at).toLocaleString()}</div>
                          {order.sample_collected_by && <div className="text-xs text-green-700">By: {order.sample_collected_by}</div>}
                        </div>
                      ) : (
                        <div className="bg-yellow-100 border border-yellow-300 rounded-lg p-3">
                          <div className="flex items-center text-yellow-800 mb-1"><Clock className="h-4 w-4 mr-1" /><span className="font-medium">Pending Collection</span></div>
                          <div className="text-xs text-yellow-700">Sample needs to be collected from patient</div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* Tests Ordered */}
              <div className="bg-white border border-gray-200 rounded-lg p-6">
                <h3 className="text-lg font-semibold text-gray-900 mb-4">Tests Ordered</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {order.tests.map((test, index) => (
                    <div key={index} className="bg-gray-50 rounded-lg p-4">
                      <div className="font-medium text-gray-900">{test}</div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Order Timeline & Workflow */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div className="bg-white border border-gray-200 rounded-lg p-6">
                  <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center">
                    <ArrowRight className="h-5 w-5 mr-2 text-blue-600" />
                    Workflow Progress
                  </h3>
                  <div className="space-y-4">
                    {getWorkflowSteps(order.status, order).map((step, index) => (
                      <div key={step.name} className="flex items-center space-x-3">
                        <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${step.completed ? 'bg-green-500 text-white' : step.current ? 'bg-blue-500 text-white' : 'bg-gray-200 text-gray-600'}`}>
                          {step.completed ? <CheckCircle className="h-4 w-4" /> : index + 1}
                        </div>
                        <div className="flex-1">
                          <div className={`font-medium ${step.current ? 'text-blue-900' : step.completed ? 'text-green-900' : 'text-gray-600'}`}>{step.name}</div>
                          <div className="text-sm text-gray-500">{step.description}</div>
                          {step.timestamp && <div className="text-xs text-gray-400">{new Date(step.timestamp).toLocaleString()}</div>}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="bg-white border border-gray-200 rounded-lg p-6">
                  <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center">
                    <Calendar className="h-5 w-5 mr-2 text-orange-600" />
                    Next Steps
                  </h3>
                  <div className="space-y-4">
                    {getNextSteps(order.status, order).map((step, index) => (
                      <div
                        key={index}
                        className={`p-4 rounded-lg border-l-4 ${step.urgent ? 'bg-red-50 border-red-400' : step.priority === 'high' ? 'bg-orange-50 border-orange-400' : 'bg-blue-50 border-blue-400'}`}
                      >
                        <div className={`font-medium ${step.urgent ? 'text-red-900' : step.priority === 'high' ? 'text-orange-900' : 'text-blue-900'}`}>{step.action}</div>
                        <div className="text-sm text-gray-600 mt-1">{step.description}</div>
                        {step.assignedTo && <div className="text-xs text-gray-500 mt-2">Assigned to: {step.assignedTo}</div>}
                        {step.deadline && <div className="text-xs text-gray-500">Deadline: {new Date(step.deadline).toLocaleString()}</div>}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-6">
              {/* AI OCR Section */}
              <div className="bg-gradient-to-r from-purple-50 to-blue-50 border border-purple-200 rounded-lg p-6">
                <h3 className="text-lg font-semibold text-purple-900 mb-4 flex items-center">
                  <Brain className="h-5 w-5 mr-2" />
                  AI-Powered Result Processing
                </h3>

                <div className="space-y-4">
                  {/* File Upload */}
                  {renderFileUpload()}

                  {/* OCR Processing */}
                  {uploadedFile && attachmentId && (
                    <div className="space-y-3">
                      <button
                        onClick={() => handleRunAIProcessing()}
                        disabled={isOCRProcessing}
                        className="w-full flex items-center justify-center px-4 py-3 bg-gradient-to-r from-purple-600 to-blue-600 text-white rounded-lg hover:from-purple-700 hover:to-blue-700 disabled:from-gray-400 disabled:to-gray-400 disabled:cursor-not-allowed transition-colors"
                      >
                        {isOCRProcessing ? (
                          <>
                            <span className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent mr-2" />
                            Processing with AI...
                          </>
                        ) : (
                          <>
                            <Zap className="h-4 w-4 mr-2" />
                            <Brain className="h-4 w-4 mr-2" />
                            Process with AI {selectedAnalyteForAI ? `(${selectedAnalyteForAI.name})` : ''}
                          </>
                        )}
                      </button>

                      {/* Processing status display */}
                      {isOCRProcessing && (
                        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
                          <div className="text-sm text-blue-800 space-y-1">
                            <div className="flex items-center"><Layers className="h-4 w-4 mr-2" />AI Processing Pipeline Active ({getAIProcessingTypeLabel(aiProcessingConfig?.type || 'ocr_report')})</div>
                            <div>• Google Vision AI: {aiProcessingConfig?.type === 'vision_card' ? 'Analyzing test card objects...' : aiProcessingConfig?.type === 'vision_color' ? 'Analyzing colors and patterns...' : 'Extracting text from document...'}</div>
                            <div>• Gemini NLP: {aiProcessingConfig?.prompt ? 'Using custom prompt...' : 'Using default analysis...'}</div>
                            <div>• Database matching: Linking to analyte definitions...</div>
                            <div>• Auto-filling result entry form...</div>
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* OCR Error */}
                  {ocrError && (
                    <div className="bg-red-50 border border-red-200 rounded-lg p-3">
                      <div className="flex items-center">
                        <AlertTriangle className="h-4 w-4 text-red-500 mr-2" />
                        <span className="text-red-700 text-sm">{ocrError}</span>
                      </div>
                    </div>
                  )}

                  {/* OCR Success */}
                  {ocrResults && extractedValues.length > 0 && (
                    <div className="bg-green-50 border border-green-200 rounded-lg p-4">
                      <div className="flex items-center mb-3">
                        <CheckCircle className="h-5 w-5 text-green-500 mr-2" />
                        <span className="text-green-700 text-sm font-medium">
                          AI processing completed! ({getAIProcessingTypeLabel(aiProcessingConfig?.type || 'ocr_report')})
                        </span>
                      </div>
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
                        <div className="text-center"><div className="text-lg font-bold text-green-600">{extractedValues.length}</div><div className="text-xs text-green-700">Parameters Found</div></div>
                        <div className="text-center"><div className="text-lg font-bold text-blue-600">{manualValues.length}</div><div className="text-xs text-blue-700">Expected Count</div></div>
                        <div className="text-center"><div className="text-lg font-bold text-purple-600">{(extractedValues as any[]).filter(v => (v as any).matched).length}</div><div className="text-xs text-purple-700">DB Matched</div></div>
                        <div className="text-center"><div className="text-lg font-bold text-orange-600">{Math.round((ocrResults.metadata?.ocrConfidence || 0.95) * 100)}%</div><div className="text-xs text-orange-700">Confidence</div></div>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Test Group Selection */}
              {testGroups.length > 1 && (
                <div className="bg-white border border-gray-200 rounded-lg p-4">
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Select Test Group
                  </label>
                  <select
                    value={selectedTestGroup || ''}
                    onChange={(e) => setSelectedTestGroup(e.target.value)}
                    className="w-full border border-gray-300 rounded-md px-3 py-2 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  >
                    <option value="">All Test Groups</option>
                    {testGroups.map(tg => (
                      <option key={tg.test_group_id} value={tg.test_group_id}>
                        {tg.test_group_name} ({tg.analytes.length} analytes)
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* Entry Mode Toggle */}
              <div className="bg-white border border-gray-200 rounded-lg p-4">
                <div className="flex items-center space-x-4">
                  <h3 className="text-lg font-semibold">Result Entry Mode</h3>
                  <div className="flex bg-gray-100 rounded-lg p-1">
                    <button
                      onClick={() => setActiveEntryMode('manual')}
                      className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                        activeEntryMode === 'manual'
                          ? 'bg-white text-blue-600 shadow-sm'
                          : 'text-gray-600 hover:text-gray-900'
                      }`}
                    >
                      Manual Entry
                    </button>
                    <button
                      onClick={() => setActiveEntryMode('ai')}
                      className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                        activeEntryMode === 'ai'
                          ? 'bg-white text-blue-600 shadow-sm'
                          : 'text-gray-600 hover:text-gray-900'
                      }`}
                    >
                      AI Upload
                    </button>
                  </div>
                </div>
              </div>

              {/* Test Group Results Display */}
              <div className="bg-white border border-gray-200 rounded-lg p-6">
                <h3 className="text-lg font-semibold text-gray-900 mb-4">
                  Test Group Results {selectedTestGroup && `- ${testGroups.find(tg => tg.test_group_id === selectedTestGroup)?.test_group_name}`}
                </h3>
                
                {testGroups.length === 0 ? (
                  <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
                    <div className="flex items-center text-yellow-800">
                      <AlertTriangle className="h-5 w-5 mr-2" />
                      <div>
                        <p className="font-semibold">No Test Groups Found</p>
                        <p className="text-sm">This order doesn't have any test groups configured for result entry.</p>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {testGroups
                      .filter(tg => !selectedTestGroup || tg.test_group_id === selectedTestGroup)
                      .map(testGroup => (
                        <TestGroupResultEntry
                          key={testGroup.test_group_id}
                          testGroup={testGroup}
                          entryMode={activeEntryMode}
                        />
                      ))}
                  </div>
                )}

                {saveMessage && (
                  <div className={`mt-4 p-3 rounded-lg ${saveMessage.includes('successfully') ? 'bg-green-50 border border-green-200 text-green-700' : 'bg-red-50 border border-red-200 text-red-700'}`}>
                    <div className="flex items-center">
                      {saveMessage.includes('successfully') ? <CheckCircle className="h-4 w-4 mr-2" /> : <AlertTriangle className="h-4 w-4 mr-2" />}
                      {saveMessage}
                    </div>
                  </div>
                )}

                <div className="mt-6 flex justify-end space-x-4">
                  <button onClick={handleSaveDraft} disabled={savingDraft} className="px-6 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 disabled:bg-gray-100 disabled:cursor-not-allowed transition-colors">
                    {savingDraft ? (<><span className="animate-spin rounded-full h-4 w-4 border-2 border-gray-600 border-t-transparent mr-2 inline-block" />Saving Draft...</>) : 'Save Draft'}
                  </button>
                  <button onClick={handleSubmitResults} disabled={submittingResults} className="px-6 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:bg-green-400 disabled:cursor-not-allowed transition-colors">
                    {submittingResults ? (<><span className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent mr-2 inline-block" />Submitting...</>) : 'Submit Results'}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default OrderDetailsModal;
