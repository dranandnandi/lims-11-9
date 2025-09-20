import React, { useState, useEffect } from 'react';
import { Save, CheckCircle } from 'lucide-react';
import { supabase } from '../../../utils/supabase';
import { useAuth } from '../../../contexts/AuthContext';
import { calculateFlagsForResults } from '../../../utils/flagCalculation';

interface ManualEntryFormProps {
  order: {
    id: string;
    patient_id: string;
    patient_name: string;
    lab_id: string;
  };
  testGroup: {
    id: string;
    name: string;
    department: string;
  };
  onSubmit: (results: any[]) => void;
}

interface AnalyteData {
  value: string;
  unit: string;
  referenceRange: string;
  flag?: string;
  isApproved?: boolean;
  isVerified?: boolean;
  existingId?: string;
}

const ManualEntryForm: React.FC<ManualEntryFormProps> = ({ order, testGroup, onSubmit }) => {
  const { user } = useAuth();
  const [analytes, setAnalytes] = useState<any[]>([]);
  const [formData, setFormData] = useState<Record<string, AnalyteData>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Helper to determine if analyte expects categorical values
  const getCategoricalOptions = (analyte: any): string[] | null => {
    const name = analyte.name.toLowerCase();
    
    // Check for positive/negative tests
    if (
      name.includes('hiv') ||
      name.includes('hbsag') ||
      name.includes('hcv') ||
      name.includes('vdrl') ||
      name.includes('antibody') ||
      name.includes('antigen') ||
      (analyte.reference_range && analyte.reference_range.toLowerCase().includes('negative'))
    ) {
      return ['Negative', 'Positive', 'Reactive', 'Non-Reactive'];
    }
    
    // Check for blood group
    if (name.includes('blood group') || name.includes('abo')) {
      return ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
    }
    
    // Check for presence/absence
    if (
      name.includes('culture') ||
      name.includes('growth') ||
      name.includes('presence')
    ) {
      return ['Absent', 'Present', 'No Growth', 'Growth Detected'];
    }
    
    return null;
  };

  // Fetch analytes for the test group
  const fetchAnalytes = async () => {
    try {
      const { data, error } = await supabase
        .from('test_group_analytes')
        .select(`
          analyte_id,
          analytes!inner(
            id,
            name,
            unit,
            reference_range,
            low_critical,
            high_critical,
            category
          )
        `)
        .eq('test_group_id', testGroup.id);

      if (!error && data) {
        const analyteList = data.map(item => ({
          id: item.analytes.id,
          name: item.analytes.name,
          unit: item.analytes.unit || '',
          reference_range: item.analytes.reference_range || '',
          low_critical: item.analytes.low_critical,
          high_critical: item.analytes.high_critical,
          category: item.analytes.category
        }));
        setAnalytes(analyteList);
        
        // Initialize form data
        const initialData: Record<string, AnalyteData> = {};
        analyteList.forEach(analyte => {
          initialData[analyte.id] = {
            value: '',
            unit: analyte.unit,
            referenceRange: analyte.reference_range,
            flag: ''
          };
        });
        setFormData(initialData);
      }
    } catch (error) {
      console.error('Error fetching analytes:', error);
    }
  };

  // Fetch existing results
  const fetchExistingResults = async () => {
    try {
      const { data, error } = await supabase
        .from('result_values')
        .select(`
          id,
          analyte_id,
          parameter,
          value,
          unit,
          reference_range,
          flag,
          verify_status,
          verified,
          verified_at,
          verify_note
        `)
        .eq('order_id', order.id)
        .eq('test_group_id', testGroup.id);

      if (!error && data) {
        const updatedFormData = { ...formData };
        data.forEach(rv => {
          if (updatedFormData[rv.analyte_id]) {
            updatedFormData[rv.analyte_id] = {
              value: rv.value || '',
              unit: rv.unit || updatedFormData[rv.analyte_id].unit,
              referenceRange: rv.reference_range || updatedFormData[rv.analyte_id].referenceRange,
              flag: rv.flag || '',
              isApproved: rv.verify_status === 'approved',
              isVerified: rv.verified === true,
              existingId: rv.id
            };
          }
        });
        setFormData(updatedFormData);
      }
    } catch (error) {
      console.error('Error fetching existing results:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAnalytes();
  }, [testGroup.id]);

  useEffect(() => {
    if (analytes.length > 0) {
      fetchExistingResults();
    }
  }, [analytes]);

  const handleAnalyteChange = (analyteId: string, data: Partial<AnalyteData>) => {
    setFormData(prev => ({
      ...prev,
      [analyteId]: { ...prev[analyteId], ...data }
    }));
  };

  const renderValueInput = (analyte: any, currentValue: AnalyteData, isApproved: boolean) => {
    const categoricalOptions = getCategoricalOptions(analyte);
    
    if (categoricalOptions && !isApproved) {
      return (
        <select
          value={currentValue.value || ''}
          onChange={(e) => handleAnalyteChange(analyte.id, { value: e.target.value })}
          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500"
        >
          <option value="">Select...</option>
          {categoricalOptions.map(option => (
            <option key={option} value={option}>{option}</option>
          ))}
        </select>
      );
    }
    
    return (
      <input
        type="text"
        value={currentValue.value || ''}
        onChange={(e) => handleAnalyteChange(analyte.id, { value: e.target.value })}
        placeholder="Enter value"
        disabled={isApproved}
        className={`w-full px-3 py-2 border rounded-md ${
          isApproved 
            ? 'bg-gray-100 text-gray-600 cursor-not-allowed' 
            : 'border-gray-300 focus:ring-2 focus:ring-blue-500'
        }`}
      />
    );
  };

  const handleSubmit = async () => {
    setSaving(true);
    
    try {
      // Filter out empty values and approved results
      const resultsToSubmit = Object.entries(formData)
        .filter(([_, data]) => data.value && data.value.trim() !== '' && !data.isApproved)
        .map(([analyteId, data]) => {
          const analyte = analytes.find(a => a.id === analyteId);
          return {
            analyte_id: analyteId,
            parameter: analyte?.name || '',
            value: data.value,
            unit: data.unit,
            reference_range: data.referenceRange,
            flag: data.flag
          };
        });

      if (resultsToSubmit.length === 0) {
        alert('No new results to submit');
        setSaving(false);
        return;
      }

      // Calculate flags
      const resultsWithFlags = calculateFlagsForResults(resultsToSubmit);

      // Create or update result record
      let resultId = null;
      
      // Check if a result record already exists
      const { data: existingResult } = await supabase
        .from('results')
        .select('id')
        .eq('order_id', order.id)
        .eq('test_group_id', testGroup.id)
        .single();

      if (existingResult) {
        resultId = existingResult.id;
      } else {
        // Create new result record
        const { data: newResult, error: resultError } = await supabase
          .from('results')
          .insert({
            order_id: order.id,
            patient_id: order.patient_id,
            patient_name: order.patient_name,
            test_name: testGroup.name,
            status: 'pending_verification',
            entered_by: user?.email || 'Unknown User',
            entered_date: new Date().toISOString().split('T')[0],
            test_group_id: testGroup.id,
            lab_id: order.lab_id
          })
          .select()
          .single();

        if (resultError) throw resultError;
        resultId = newResult.id;
      }

      // Insert result values
      const resultValuesData = resultsWithFlags.map(rv => ({
        result_id: resultId,
        ...rv,
        order_id: order.id,
        test_group_id: testGroup.id,
        lab_id: order.lab_id,
        verify_status: 'pending'
      }));

      const { error: valuesError } = await supabase
        .from('result_values')
        .insert(resultValuesData);

      if (valuesError) throw valuesError;

      onSubmit(resultsWithFlags);
      
    } catch (error) {
      console.error('Error submitting results:', error);
      alert('Failed to save results. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  const hasEditableResults = Object.values(formData).some(data => !data.isApproved);

  return (
    <div className="space-y-6">
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <h4 className="font-medium text-blue-900">{testGroup.name}</h4>
        <p className="text-sm text-blue-700">
          Enter results for {analytes.length} parameters
        </p>
      </div>

      <div className="space-y-4">
        {analytes.map(analyte => {
          const currentValue = formData[analyte.id] || {};
          const isApproved = currentValue.isApproved;
          
          return (
            <div key={analyte.id} className="grid grid-cols-5 gap-4 items-start p-4 border rounded-lg hover:bg-gray-50">
              <div className="col-span-1">
                <label className="text-sm font-medium text-gray-700">
                  {analyte.name}
                  {isApproved && (
                    <div className="flex items-center mt-1 text-xs text-green-600">
                      <CheckCircle className="h-3 w-3 mr-1" />
                      Approved
                    </div>
                  )}
                </label>
              </div>
              
              <div>
                {renderValueInput(analyte, currentValue, isApproved)}
              </div>
              
              <div>
                <input
                  type="text"
                  value={currentValue.unit || ''}
                  onChange={(e) => handleAnalyteChange(analyte.id, { unit: e.target.value })}
                  placeholder="Unit"
                  disabled={isApproved}
                  className={`w-full px-3 py-2 border rounded-md ${
                    isApproved 
                      ? 'bg-gray-100 text-gray-600 cursor-not-allowed' 
                      : 'border-gray-300 focus:ring-2 focus:ring-blue-500'
                  }`}
                />
              </div>
              
              <div>
                <input
                  type="text"
                  value={currentValue.referenceRange || ''}
                  onChange={(e) => handleAnalyteChange(analyte.id, { referenceRange: e.target.value })}
                  placeholder="Reference Range"
                  disabled={isApproved}
                  className={`w-full px-3 py-2 border rounded-md ${
                    isApproved 
                      ? 'bg-gray-100 text-gray-600 cursor-not-allowed' 
                      : 'border-gray-300 focus:ring-2 focus:ring-blue-500'
                  }`}
                />
              </div>
              
              <div>
                <select
                  value={currentValue.flag || ''}
                  onChange={(e) => handleAnalyteChange(analyte.id, { flag: e.target.value })}
                  disabled={isApproved}
                  className={`w-full px-3 py-2 border rounded-md ${
                    isApproved 
                      ? 'bg-gray-100 text-gray-600 cursor-not-allowed' 
                      : 'border-gray-300 focus:ring-2 focus:ring-blue-500'
                  }`}
                >
                  <option value="">Normal</option>
                  <option value="H">High</option>
                  <option value="L">Low</option>
                  <option value="C">Critical</option>
                </select>
              </div>
            </div>
          );
        })}
      </div>

      {hasEditableResults && (
        <div className="flex justify-end space-x-3">
          <button
            onClick={handleSubmit}
            disabled={saving}
            className="flex items-center px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50"
          >
            <Save className="h-4 w-4 mr-2" />
            {saving ? 'Saving...' : 'Save Results'}
          </button>
        </div>
      )}

      {!hasEditableResults && (
        <div className="bg-green-50 border border-green-200 rounded-lg p-4 text-center">
          <CheckCircle className="h-8 w-8 text-green-600 mx-auto mb-2" />
          <p className="text-green-800">All results for this test group have been approved</p>
        </div>
      )}
    </div>
  );
};

export default ManualEntryForm;