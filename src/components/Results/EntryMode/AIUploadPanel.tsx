import React, { useState, useCallback, useEffect } from 'react';
import { Brain, Upload, File, AlertCircle, CheckCircle, Loader, Play } from 'lucide-react';
import { supabase, attachments } from '../../../utils/supabase';
import { useAuth } from '../../../contexts/AuthContext';
import AIProcessingProgress, { AIStep } from '../../Orders/AIProcessingProgress';

interface Order {
  id: string;
  patient_name: string;
  patient_id: string;
  lab_id: string;
}

interface TestGroup {
  id: string;
  name: string;
}

interface ProcessingStatus {
  id: string;
  status: 'uploading' | 'processing' | 'completed' | 'failed';
  progress: number;
  message?: string;
  results?: any[];
}

interface AIUploadPanelProps {
  order: Order;
  testGroup?: TestGroup;
  onUploadComplete?: (results: any[]) => void;
  onProgressUpdate?: (status: ProcessingStatus) => void;
}

const AIUploadPanel: React.FC<AIUploadPanelProps> = ({ order, testGroup, onUploadComplete, onProgressUpdate }) => {
  const { user } = useAuth();
  const [uploading, setUploading] = useState(false);
  const [processingStatus, setProcessingStatus] = useState<ProcessingStatus | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [attachmentId, setAttachmentId] = useState<string | null>(null);
  const [aiSteps, setAiSteps] = useState<AIStep[]>([]);
  const [aiLogs, setAiLogs] = useState<string[]>([]);
  const [aiRunning, setAiRunning] = useState(false);
  const [extracted, setExtracted] = useState<any[]>([]);
  const [uploadScope, setUploadScope] = useState<'order' | 'test'>('order');
  const [selectedTestGroupId, setSelectedTestGroupId] = useState<string>('');
  const [availableTestGroups, setAvailableTestGroups] = useState<any[]>([]);
  const [saving, setSaving] = useState(false);

  // Fetch test groups for this order
  useEffect(() => {
    fetchOrderTestGroups();
  }, [order.id]);

  const fetchOrderTestGroups = async () => {
    try {
      const { data } = await supabase
        .from('order_tests')
        .select(`
          id,
          test_group_id,
          test_groups (id, name)
        `)
        .eq('order_id', order.id);

      setAvailableTestGroups(data || []);
    } catch (error) {
      console.error('Error fetching test groups:', error);
    }
  };

  // Handle file drop
  const handleDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);

    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) {
      handleFileUpload(files[0]);
    }
  }, []);

  // Handle drag events
  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
  }, []);

  // Validate file
  const validateFile = (file: File): { valid: boolean; error?: string } => {
    // Check file type
    const allowedTypes = ['image/jpeg', 'image/png', 'image/jpg'];
    if (!allowedTypes.includes(file.type)) {
      return { valid: false, error: 'Only JPG and PNG files are supported' };
    }

    // Check file size (10MB max)
    const maxSize = 10 * 1024 * 1024; // 10MB
    if (file.size > maxSize) {
      return { valid: false, error: 'File size must be less than 10MB' };
    }

    return { valid: true };
  };

  // Monitor processing status
  const monitorProcessingStatus = async (jobId: string) => {
    const checkStatus = async () => {
      try {
        const { data } = await supabase.functions.invoke('check-processing-status', {
          body: { jobId }
        });

        if (data) {
          const status: ProcessingStatus = {
            id: jobId,
            status: data.status,
            progress: data.progress || 0,
            message: data.message,
            results: data.results
          };

          setProcessingStatus(status);
          // propagate to parent if provided
          onProgressUpdate?.(status);
          if (status.status === 'completed' && status.results) {
            onUploadComplete?.(status.results);
            setUploading(false);
          } else if (status.status === 'failed') {
            setUploading(false);
          } else if (status.status === 'processing') {
            // Continue monitoring
            setTimeout(checkStatus, 2000);
          }
        }
      } catch (error) {
        console.error('Error checking processing status:', error);
        setUploading(false);
      }
    };

    // Start monitoring
    setTimeout(checkStatus, 1000);
  };

  // Handle file upload
  const handleFileUpload = async (file: File) => {
    if (!user?.id || !order?.id) return;

    // Validate file
    const validation = validateFile(file);
    if (!validation.valid) {
      alert(validation.error);
      return;
    }

    setUploading(true);
    setProcessingStatus({
      id: 'upload',
      status: 'uploading',
      progress: 0,
      message: 'Uploading file...'
    });

    try {
      // 1. Upload file to Supabase storage
      const fileName = `lab-results/${order.lab_id}/${order.id}/${Date.now()}-${file.name}`;
      const { data: uploadData, error: uploadError } = await supabase.storage
        .from('attachments')
        .upload(fileName, file, {
          cacheControl: '3600',
          upsert: false
        });

      if (uploadError) throw uploadError;

      // Update upload progress
      setProcessingStatus({
        id: 'upload',
        status: 'uploading',
        progress: 50,
        message: 'File uploaded, creating record...'
      });

      // 2. Get public URL
      const { data: { publicUrl } } = supabase.storage
        .from('attachments')
        .getPublicUrl(uploadData.path);

      // 3. Create attachment record
      const { data: attachment, error: attachmentError } = await attachments.create({
        file_path: uploadData.path,
        file_name: file.name,
        file_type: file.type,
        file_size: file.size,
        public_url: publicUrl,
        related_table: 'orders',
        related_id: order.id,
        uploaded_by: user.id,
        metadata: {
          upload_mode: uploadScope,
          test_group_id: uploadScope === 'test' ? testGroup?.id : null,
          order_id: order.id,
          patient_name: order.patient_name
        }
      });

      if (attachmentError) throw attachmentError;
      setAttachmentId(attachment.id);

      // Update progress
      setProcessingStatus({
        id: 'upload',
        status: 'processing',
        progress: 75,
        message: 'Starting AI processing...'
      });

      // 4. Trigger AI processing (background job remains supported)
      const { data: processingJob, error: processingError } = await supabase.functions.invoke('process-lab-document', {
        body: {
          attachmentId: attachment.id,
          orderId: order.id,
          testGroupId: uploadScope === 'test' ? testGroup?.id : null,
          mode: uploadScope,
          fileName: file.name,
          filePath: uploadData.path
        }
      });

      if (processingError) throw processingError;

      // 5. Monitor processing status
      if (processingJob?.jobId) {
        monitorProcessingStatus(processingJob.jobId);
      } else {
        // Fallback if no job ID returned
        setProcessingStatus({
          id: 'completed',
          status: 'completed',
          progress: 100,
          message: 'Processing started successfully'
        });
        setUploading(false);
      }

    } catch (error) {
      console.error('Upload failed:', error);
      setProcessingStatus({
        id: 'error',
        status: 'failed',
        progress: 0,
        message: error instanceof Error ? error.message : 'Upload failed'
      });
      setUploading(false);
    }
  };

  // Direct AI pipeline mirroring modal logic
  const startAISteps = () => {
    const steps: AIStep[] = [
      { key: 'upload', label: 'Attachment', desc: 'Validating uploaded file', state: attachmentId ? 'ok' : 'idle' },
      { key: 'ocr', label: 'OCR Extraction', desc: 'Reading text from document', state: 'idle' },
      { key: 'nlp', label: 'NLP Parsing', desc: 'Extracting parameters', state: 'idle' },
      { key: 'match', label: 'Match to Analytes', desc: 'Aligning results to catalog', state: 'idle' },
      { key: 'fill', label: 'Autofill Grid', desc: 'Filling entry grid', state: 'idle' },
      { key: 'done', label: 'Finalize', desc: 'Finishing up', state: 'idle' }
    ];
    setAiSteps(steps);
  };

  const setStep = (key: AIStep['key'], state: AIStep['state'], meta?: Record<string, any>) => {
    setAiSteps(prev => prev.map(s => s.key === key ? { ...s, state, meta: meta ?? s.meta } : s));
  };

  const pushLog = (msg: string) => setAiLogs(prev => [...prev, msg]);

  const processWithAI = async () => {
    if (!attachmentId) return;
    setAiRunning(true);
    if (aiSteps.length === 0) startAISteps();
    try {
      setStep('ocr', 'running');
      pushLog('Invoking vision-ocr…');
      const vision = await supabase.functions.invoke('vision-ocr', { body: { attachmentId } });
      if (vision.error) throw new Error(vision.error.message);
      setStep('ocr', 'ok', { sample: (vision.data?.fullText || '').slice(0, 64) + '…' });

      setStep('nlp', 'running');
      pushLog('Invoking gemini-nlp…');
      const gemini = await supabase.functions.invoke('gemini-nlp', {
        body: {
          rawText: vision.data?.fullText,
          visionResults: vision.data,
        },
        headers: { 'x-attachment-id': attachmentId, 'x-order-id': order.id },
      });
      if (gemini.error) throw new Error(gemini.error.message);
      setStep('nlp', 'ok', { extracted: Array.isArray(gemini.data?.extractedParameters) ? gemini.data.extractedParameters.length : 0 });

      setStep('match', 'ok');
      setStep('fill', 'ok');
      setStep('done', 'ok');

      // Deliver results upwards if provided
      const found = Array.isArray(gemini.data?.extractedParameters) ? gemini.data.extractedParameters : [];
      if (found.length) {
        setExtracted(found);
        onUploadComplete?.(found);
      }
    } catch (e: any) {
      pushLog(e?.message || 'AI processing failed');
      setStep('done', 'err', { error: e?.message });
    } finally {
      setAiRunning(false);
    }
  };

  const saveExtractedToResults = async () => {
    if (!extracted.length) return;
    try {
      const { data: { user } } = await supabase.auth.getUser();
      const labId = order.lab_id;
      const testGroupId = uploadScope === 'test' ? testGroup?.id : null;
      const testName = uploadScope === 'test' ? (testGroup?.name || 'Unknown Test') : 'AI Upload';

      // Create results row similar to modal
      const { data: resultRow, error: resultErr } = await supabase
        .from('results')
        .insert({
          order_id: order.id,
          patient_id: order.patient_id,
          patient_name: order.patient_name,
          test_name: testName,
          status: 'pending_verification',
          entered_by: user?.email || 'Unknown User',
          entered_date: new Date().toISOString().split('T')[0],
          test_group_id: testGroupId,
          lab_id: labId,
          extracted_by_ai: true,
          attachment_id: attachmentId
        })
        .select()
        .single();
      if (resultErr) throw resultErr;

      const values = extracted.map((p: any) => ({
        result_id: resultRow.id,
        analyte_id: p.analyte_id || null,
        analyte_name: p.parameter,
        parameter: p.parameter,
        value: p.value,
        unit: p.unit || '',
        reference_range: p.reference_range || p.reference || '',
        flag: p.flag || null,
        order_id: order.id,
        test_group_id: testGroupId,
        lab_id: labId
      }));
      const { error: valuesErr } = await supabase.from('result_values').insert(values);
      if (valuesErr) throw valuesErr;
      alert('AI-extracted results saved.');
    } catch (e) {
      console.error('Save failed:', e);
      alert('Failed to save extracted results');
    }
  };

  // Handle file input change
  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      handleFileUpload(files[0]);
    }
  };

  // Updated save function after AI extraction
  const handleSaveResults = async () => {
    if (!extracted || extracted.length === 0) {
      alert('No values to save');
      return;
    }

    setSaving(true);
    try {
      // Group extracted values by test group
      const valuesByTestGroup = await groupValuesByTestGroup(extracted);
      
      for (const [testGroupId, values] of Object.entries(valuesByTestGroup)) {
        // Find or create result row for this test group
        const resultId = await findOrCreateResultRow(testGroupId);
        
        // Prepare result_values
        const resultValues = await Promise.all(values.map(async (item: any) => {
          // Find analyte ID by name
          const { data: analyte } = await supabase
            .from('analytes')
            .select('id')
            .eq('name', item.parameter)
            .single();

          return {
            result_id: resultId,
            analyte_id: analyte?.id,
            analyte_name: item.parameter,
            parameter: item.parameter,
            value: item.value,
            unit: item.unit || '',
            reference_range: item.reference || '',
            flag: item.flag || null,
            order_id: order.id,
            test_group_id: testGroupId,
            lab_id: order.lab_id
          };
        }));

        // Delete existing values for these analytes
        const analyteIds = resultValues
          .map(v => v.analyte_id)
          .filter(Boolean);
          
        if (analyteIds.length > 0) {
          await supabase
            .from('result_values')
            .delete()
            .eq('result_id', resultId)
            .in('analyte_id', analyteIds);
        }

        // Insert new values
        const { error } = await supabase
          .from('result_values')
          .insert(resultValues);

  if (error) throw error;

        // Update result metadata
        await supabase
          .from('results')
          .update({
            extracted_by_ai: true,
            updated_at: new Date().toISOString()
          })
          .eq('id', resultId);
      }

      alert('Results saved successfully');
      
      if (onUploadComplete) {
        onUploadComplete(extracted);
      }

      // Reset state
      setExtracted([]);
      setAttachmentId(null);
      
    } catch (error) {
      console.error('Error saving results:', error);
      alert('Failed to save results');
    } finally {
      setSaving(false);
    }
  };

  // Helper to find or create result row
  const findOrCreateResultRow = async (testGroupId: string) => {
    try {
      // Check for existing result
      const { data: existing } = await supabase
        .from('results')
        .select('id')
        .eq('order_id', order.id)
        .eq('test_group_id', testGroupId)
        .order('created_at', { ascending: false })
        .limit(1);

      if (existing && existing.length > 0) {
        return existing[0].id;
      }

      // Get test group name
      const { data: testGroup } = await supabase
        .from('test_groups')
        .select('name')
        .eq('id', testGroupId)
        .single();

      // Create new result
      const currentUser = await supabase.auth.getUser();
      const { data: newResult, error } = await supabase
        .from('results')
        .insert({
          order_id: order.id,
          patient_id: order.patient_id,
          patient_name: order.patient_name,
          test_name: testGroup?.name || 'Unknown Test',
          test_group_id: testGroupId,
          status: 'Entered',
          lab_id: order.lab_id,
          entered_by: currentUser.data.user?.email || 'AI System',
          entered_date: new Date().toISOString(),
          extracted_by_ai: true,
          created_at: new Date().toISOString()
        })
        .select()
        .single();

      if (error) throw error;
      return newResult.id;
    } catch (error) {
      console.error('Error in findOrCreateResultRow:', error);
      throw error;
    }
  };

  // Group extracted values by test group
  const groupValuesByTestGroup = async (values: any[]) => {
    const grouped: Record<string, any[]> = {};
    
    for (const value of values) {
      // Find which test group this analyte belongs to
      const { data } = await supabase
        .from('test_group_analytes')
        .select(`
          test_group_id,
          analytes!inner(name)
        `)
        .eq('analytes.name', value.parameter)
        .in('test_group_id', availableTestGroups.map(tg => tg.test_group_id));

      if (data && data.length > 0) {
        const testGroupId = data[0].test_group_id;
        if (!grouped[testGroupId]) {
          grouped[testGroupId] = [];
        }
        grouped[testGroupId].push(value);
      }
    }
    
    // If test-specific upload, use selected test group
    if (uploadScope === 'test' && selectedTestGroupId) {
      return { [selectedTestGroupId]: values };
    }
    
    return grouped;
  };

  // Handle scope change
  // Note: scope changes handled inline in inputs below

  return (
    <div className="space-y-6">
      {/* Scope Selection */}
      <div className="flex items-center space-x-4">
        <label className="flex items-center">
          <input
            type="radio"
            value="order"
            checked={uploadScope === 'order'}
            onChange={(e) => setUploadScope(e.target.value as 'order' | 'test')}
            className="mr-2"
          />
          <span>Order Level</span>
        </label>
        <label className="flex items-center">
          <input
            type="radio"
            value="test"
            checked={uploadScope === 'test'}
            onChange={(e) => setUploadScope(e.target.value as 'order' | 'test')}
            className="mr-2"
          />
          <span>Test Specific</span>
        </label>
        
        {uploadScope === 'test' && (
          <select
            value={selectedTestGroupId}
            onChange={(e) => setSelectedTestGroupId(e.target.value)}
            className="px-3 py-2 border rounded-md text-sm"
          >
            <option value="">Select test group...</option>
            {availableTestGroups.map(tg => (
              <option key={tg.test_group_id} value={tg.test_group_id}>
                {tg.test_groups?.name}
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="bg-white rounded-lg border p-6">
        <div className="flex items-center mb-4">
          <Brain className="h-6 w-6 text-purple-600 mr-2" />
          <h3 className="text-lg font-semibold">AI-Powered Result Processing</h3>
        </div>

        {/* Upload info */}
        <div className="mb-4 p-3 bg-blue-50 rounded-lg">
          <p className="text-sm text-blue-800">
            <strong>Selected Order:</strong> {order.patient_name} (#{order.id.slice(0, 8)})
          </p>
          {uploadScope === 'test' && (
            <p className="text-sm text-blue-700 mt-1">
              <strong>Test Group:</strong> {selectedTestGroupId}
            </p>
          )}
        </div>

        {/* Dropzone */}
        <div
          className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors ${
            dragActive
              ? 'border-purple-400 bg-purple-50'
              : uploading
              ? 'border-gray-300 bg-gray-50'
              : 'border-purple-300 hover:border-purple-400 hover:bg-purple-50'
          }`}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
        >
          {uploading ? (
            <div className="flex flex-col items-center">
              <Loader className="h-12 w-12 text-purple-400 animate-spin mb-4" />
              <p className="text-gray-700 mb-2">Processing document...</p>
              <p className="text-sm text-gray-500">Please wait while AI extracts the results</p>
            </div>
          ) : (
            <>
              <Upload className="h-12 w-12 text-purple-400 mx-auto mb-4" />
              <p className="text-gray-700 mb-2">Drop your lab result document here</p>
              <p className="text-sm text-gray-500 mb-4">Supports JPG, PNG (max 10MB)</p>
              
              <input
                type="file"
                id="file-upload"
                accept="image/jpeg,image/png,image/jpg"
                onChange={handleFileInputChange}
                className="hidden"
                disabled={uploading}
              />
              <label
                htmlFor="file-upload"
                className="inline-flex items-center px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Upload className="h-4 w-4 mr-2" />
                Upload Document
              </label>
            </>
          )}
        </div>

        {/* Processing Status */}
        {processingStatus && (
          <ProcessingStatusCard status={processingStatus} />
        )}

        {/* AI Steps (on-demand, mirrors modal) */}
        {attachmentId && (
          <div className="mt-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="text-sm text-gray-700">Advanced AI Processing</div>
              <button
                onClick={processWithAI}
                disabled={aiRunning}
                className="inline-flex items-center px-3 py-1.5 text-sm rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
              >
                <Play className="h-4 w-4 mr-1" /> Process with AI
              </button>
            </div>
            <AIProcessingProgress
              steps={aiSteps}
              logs={aiLogs}
              mode="legacy"
            />
            {extracted.length > 0 && (
              <div className="flex items-center justify-between p-3 border rounded-md bg-gray-50">
                <div className="text-sm text-gray-700">Extracted {extracted.length} parameters</div>
                <button
                  onClick={saveExtractedToResults}
                  className="text-sm px-3 py-1.5 rounded-md bg-green-600 text-white hover:bg-green-700"
                >
                  Save to Results
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Save button */}
      {extracted.length > 0 && (
        <button
          onClick={handleSaveResults}
          disabled={saving}
          className="w-full px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50"
        >
          {saving ? 'Saving Results...' : 'Save to Results'}
        </button>
      )}
    </div>
  );
};

// Processing Status Component
const ProcessingStatusCard: React.FC<{ status: ProcessingStatus }> = ({ status }) => {
  const getStatusIcon = () => {
    switch (status.status) {
      case 'uploading':
      case 'processing':
        return <Loader className="h-5 w-5 text-blue-600 animate-spin" />;
      case 'completed':
        return <CheckCircle className="h-5 w-5 text-green-600" />;
      case 'failed':
        return <AlertCircle className="h-5 w-5 text-red-600" />;
      default:
        return <File className="h-5 w-5 text-gray-600" />;
    }
  };

  const getStatusColor = () => {
    switch (status.status) {
      case 'uploading':
      case 'processing':
        return 'border-blue-200 bg-blue-50';
      case 'completed':
        return 'border-green-200 bg-green-50';
      case 'failed':
        return 'border-red-200 bg-red-50';
      default:
        return 'border-gray-200 bg-gray-50';
    }
  };

  return (
    <div className={`mt-4 p-4 border rounded-lg ${getStatusColor()}`}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center">
          {getStatusIcon()}
          <span className="ml-2 font-medium capitalize">{status.status.replace('_', ' ')}</span>
        </div>
        <span className="text-sm text-gray-600">{status.progress}%</span>
      </div>

      {/* Progress Bar */}
      <div className="w-full bg-gray-200 rounded-full h-2 mb-2">
        <div
          className={`h-2 rounded-full transition-all duration-300 ${
            status.status === 'completed' ? 'bg-green-500' :
            status.status === 'failed' ? 'bg-red-500' : 'bg-blue-500'
          }`}
          style={{ width: `${status.progress}%` }}
        />
      </div>

      {status.message && (
        <p className="text-sm text-gray-700">{status.message}</p>
      )}

      {/* Results Summary */}
      {status.status === 'completed' && status.results && (
        <div className="mt-3 p-3 bg-white rounded border">
          <p className="text-sm font-medium text-green-800 mb-1">
            ✓ Successfully extracted {status.results.length} result(s)
          </p>
          <div className="text-xs text-gray-600">
            Results have been automatically saved and are ready for review.
          </div>
        </div>
      )}
    </div>
  );
};

export default AIUploadPanel;