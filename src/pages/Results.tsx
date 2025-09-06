import React, { useState } from 'react';
import { Search, Filter, CheckCircle, Clock as ClockIcon, AlertTriangle, FileText, Download, Eye, Brain, Paperclip, User, Calendar, TestTube, Activity, TrendingUp, ChevronDown, ChevronUp } from 'lucide-react';
import { Result, initializeStorage } from '../utils/localStorage';
import { database, supabase } from '../utils/supabase';
import { useAuth } from '../contexts/AuthContext';
import { calculateFlag, hasAbnormalFlags, getFlagColor } from '../utils/flagCalculation';
import AIToolsModal from '../components/Results/AIToolsModal';

const Results: React.FC = () => {
  const { user } = useAuth();
  const [results, setResults] = useState<Result[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedStatus, setSelectedStatus] = useState('All');
  const [selectedResult, setSelectedResult] = useState<Result | null>(null);
  const [showAITools, setShowAITools] = useState(false);
  const [aiEnhancedResults, setAIEnhancedResults] = useState<{[key: string]: any}>({});
  const [isReverting, setIsReverting] = useState(false);
  const [expandedDetails, setExpandedDetails] = useState<{[key: string]: boolean}>({});

  // Load results from localStorage on component mount
  React.useEffect(() => {
    initializeStorage(); // Initialize local storage for other data (e.g., analytes, test groups)
    fetchResults();
  }, []);

  // Calculate summary statistics
  const summaryStats = React.useMemo(() => {
    const pendingReview = results.filter(r => r.status === 'Under Review').length;
    const approved = results.filter(r => r.status === 'Approved').length;
    const reported = results.filter(r => r.status === 'Reported').length;
    const abnormal = results.filter(r => hasAbnormalFlags(r.values.map(v => ({ 
      ...v, 
      reference_range: v.reference 
    })))).length;
    const avgTurnaround = results.length > 0 ? 
      Math.round(results.reduce((sum, r) => {
        const entryDate = new Date(r.enteredDate);
        const reviewDate = r.reviewedDate ? new Date(r.reviewedDate) : new Date();
        const diffHours = (reviewDate.getTime() - entryDate.getTime()) / (1000 * 60 * 60);
        return sum + diffHours;
      }, 0) / results.length) : 0;

    return { pendingReview, approved, reported, abnormal, avgTurnaround };
  }, [results]);

  const fetchResults = async () => {
    try {
      const { data, error } = await database.results.getAll();
      if (error) {
        console.error('Error loading results:', error);
      } else if (data) {
        // Map result_values to 'values' property and consolidate by order+test
        const allResults = data.map((result: any) => ({
          id: result.id,
          orderId: result.order_id,
          patientId: result.patient_id,
          patientName: result.patient_name,
          testName: result.test_name,
          status: result.status,
          enteredBy: result.entered_by,
          enteredDate: result.entered_date,
          reviewedBy: result.reviewed_by,
          reviewedDate: result.reviewed_date,
          notes: result.notes,
          attachmentId: result.attachment_id, // Include attachment linkage
          values: result.result_values ? result.result_values.map((val: any) => ({
            parameter: val.parameter,
            value: val.value,
            unit: val.unit,
            reference: val.reference_range, // Map reference_range to reference
            flag: val.flag
          })) : [],
        }));
        
        // Debug: Log results with attachmentId
        console.log('Loaded results with attachments:', allResults.filter(r => r.attachmentId).map(r => ({ 
          id: r.id, 
          testName: r.testName, 
          attachmentId: r.attachmentId 
        })));
        
        // Consolidate results by orderId + testName, keeping only the most recent
        const consolidatedResults = new Map<string, any>();
        
        allResults.forEach(result => {
          const compositeKey = `${result.orderId}-${result.testName}`;
          const existingResult = consolidatedResults.get(compositeKey);
          
          if (!existingResult || new Date(result.enteredDate) > new Date(existingResult.enteredDate)) {
            consolidatedResults.set(compositeKey, result);
          }
        });
        
        // Convert map values back to array and set state
        const formattedData = Array.from(consolidatedResults.values());
        setResults(formattedData);
        
        console.log(`Consolidated ${allResults.length} results into ${formattedData.length} unique entries`);
      }
    } catch (err) {
      console.error('Error fetching results:', err);
    }
  };

  const toggleDetails = (resultId: string) => {
    setExpandedDetails(prev => ({
      ...prev,
      [resultId]: !prev[resultId]
    }));
  };

  const handleApproveResult = async (resultId: string) => {
    const resultToUpdate = results.find(result => result.id === resultId);
    if (!resultToUpdate) return;

    const updatedResultData = {
      status: 'Approved' as const,
      reviewed_by: user?.email || 'System',
      reviewed_date: new Date().toISOString().split('T')[0],
    };

    try {
      const { data, error } = await database.results.update(resultId, updatedResultData);
      if (error) {
        console.error('Error approving result:', error);
        return;
      }
      
      // Update local state
      setResults(prev => prev.map(r => r.id === resultId ? { ...r, ...data, values: r.values } : r)); // Preserve values array
      
      // Get the approved result (from updated local state)
      const approvedResult = results.find(r => r.id === resultId); // Use the original result object to get patientId etc.
      if (approvedResult) {      
        // Create report for the approved result
        createReportForResult(approvedResult);
        
        // The order status is automatically updated in database.results.update via checkAndUpdateStatus
        console.log('Result approved and order status automatically checked');
      }
      
      // Update selected result if it's the one being approved
      if (selectedResult && selectedResult.id === resultId) {
        setSelectedResult(prev => prev ? { ...prev, ...data, values: prev.values } : null);
      }
    } catch (err) {
      console.error('Error during result approval:', err);
    }
  };

  const createReportForResult = async (result: Result) => {
    try {
      // Get patient details from Supabase
      const { data: patient, error: patientError } = await database.patients.getById(result.patientId);
      if (patientError || !patient) {
        console.error('Error fetching patient for report:', patientError);
        return;
      }
      
      // Create a new report in Supabase
      const reportData = {
        patient_id: result.patientId,
        result_id: result.id,
        status: 'Generated',
        generated_date: new Date().toISOString(),
        doctor: result.enteredBy || user?.email || 'System',
      };
      
      await database.reports.create(reportData);
    } catch (error) {
      console.error('Error creating report:', error);
    }
  };

  const handleRejectResult = async (resultId: string) => {
    const resultToUpdate = results.find(result => result.id === resultId);
    if (!resultToUpdate) return;

    const updatedResultData = {
      status: 'Entered' as const,
      reviewed_by: user?.email || 'System',
      reviewed_date: new Date().toISOString().split('T'),
    };

    try {
      const { data, error } = await database.results.update(resultId, updatedResultData);
      if (error) {
        console.error('Error rejecting result:', error);
        return;
      }
      
      // Update local state
      setResults(prev => prev.map(r => r.id === resultId ? { ...r, ...data, values: r.values } : r));
      
      // Update selected result if it's the one being rejected
      if (selectedResult && selectedResult.id === resultId) {
        setSelectedResult(prev => prev ? { ...prev, ...data, values: prev.values } : null);
      }
    } catch (err) {
      console.error('Error during result rejection:', err);
    }
  };

  const handleGenerateReport = async (resultId: string) => {
    const resultToUpdate = results.find(result => result.id === resultId);
    if (!resultToUpdate) return;

    const updatedResultData = {
      status: 'Reported' as const,
    };

    try {
      const { data, error } = await database.results.update(resultId, updatedResultData);
      if (error) {
        console.error('Error generating report (updating result status):', error);
        return;
      }
      
      // Update local state
      setResults(prev => prev.map(r => r.id === resultId ? { ...r, ...data, values: r.values } : r));
      
      // Update the corresponding order status to Delivered
      const reportedResult = results.find(r => r.id === resultId);
      if (reportedResult) {
        // Update order status in Supabase
        await database.orders.update(reportedResult.orderId, {
          status: 'Delivered'
        });
        
        // Update the report status in Supabase
        updateReportStatus(reportedResult.id);
      }
      
      // Update selected result if it's the one being reported
      if (selectedResult && selectedResult.id === resultId) {
        setSelectedResult(prev => prev ? { ...prev, ...data, values: prev.values } : null);
      }
      
      // Close modal after generating report
      setSelectedResult(null);
    } catch (err) {
      console.error('Error during report generation:', err);
    }
  };

  const updateReportStatus = async (resultId: string) => {
    try {
      // Find the report with this result_id
      const { data: reports, error } = await supabase
        .from('reports')
        .select('id')
        .eq('result_id', resultId)
        .limit(1);
      
      if (error) {
        console.error('Error finding report:', error);
        return;
      }
      
      if (reports && reports.length > 0) {
        // Update the report status to Delivered
        const { error: updateError } = await supabase
          .from('reports')
          .update({
          status: 'Delivered'
        })
          .eq('id', reports[0].id);
        
        if (updateError) {
          console.error('Error updating report status:', updateError);
        }
      }
    } catch (error) {
      console.error('Error updating report status:', error);
    }
  };

  const handleRevertToUnderReview = async (resultId: string) => {
    setIsReverting(true);
    try {
      // Update the result status back to Under Review
      const { error } = await database.results.update(resultId, {
        status: 'Under Review'
      });
      
      if (error) {
        console.error('Error reverting result status:', error);
        return;
      }
      
      // Find the associated report
      const { data: reports, error: reportError } = await supabase
        .from('reports')
        .select('id')
        .eq('result_id', resultId)
        .limit(1);
      
      if (reportError) {
        console.error('Error finding associated report:', reportError);
      } else if (reports && reports.length > 0) {
        // Update the report status back to Generated
        const { error: updateError } = await supabase
          .from('reports')
          .update({
            status: 'Generated'
          })
          .eq('id', reports[0].id);
        
        if (updateError) {
          console.error('Error updating report status:', updateError);
        }
      }
      
      // Update local state
      setResults(prev => prev.map(r => r.id === resultId ? { ...r, status: 'Under Review' } : r));
      
      // Update selected result if it's the one being reverted
      if (selectedResult && selectedResult.id === resultId) {
        setSelectedResult(prev => prev ? { ...prev, status: 'Under Review' } : null);
      }
    } catch (err) {
      console.error('Error during status reversion:', err);
    } finally {
      setIsReverting(false);
    }
  };

  const handleOpenAITools = () => {
    setShowAITools(true);
  };

  const handleAIResultGenerated = (aiData: any) => {
    if (selectedResult) {
      setAIEnhancedResults(prev => ({
        ...prev,
        [selectedResult.id]: aiData
      }));
      
      // You could also update the result in localStorage here if needed
      console.log('AI data generated for result:', selectedResult.id, aiData);
    }
  };

  const statuses = ['All', 'Entered', 'Under Review', 'Approved', 'Reported'];

  const filteredResults = results.filter(result => {
    const matchesSearch = result.patientName.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         result.orderId.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         result.testName.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesStatus = selectedStatus === 'All' || result.status === selectedStatus;
    return matchesSearch && matchesStatus;
  });

  const getStatusColor = (status: string) => {
    const colors = {
      'Entered': 'bg-blue-100 text-blue-800',
      'Under Review': 'bg-yellow-100 text-yellow-800',
      'Approved': 'bg-green-100 text-green-800',
      'Reported': 'bg-gray-100 text-gray-800',
    };
    return colors[status as keyof typeof colors] || 'bg-gray-100 text-gray-800';
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'Entered':
        return <ClockIcon className="h-4 w-4" />;
      case 'Under Review':
        return <AlertTriangle className="h-4 w-4" />;
      case 'Approved':
        return <CheckCircle className="h-4 w-4" />;
      case 'Reported':
        return <FileText className="h-4 w-4" />;
      default:
        return <ClockIcon className="h-4 w-4" />;
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold text-gray-900">Result Entry & Approval</h1>
        <div className="flex space-x-3">
          <button className="flex items-center px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">
            <Download className="h-4 w-4 mr-2" />
            Export Results
          </button>
        </div>
      </div>

      {/* Enhanced Summary Dashboard */}
      <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
        <div className="bg-gradient-to-r from-yellow-50 to-yellow-100 rounded-lg shadow-sm border border-yellow-200 p-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-2xl font-bold text-yellow-900">{summaryStats.pendingReview}</div>
              <div className="text-sm text-yellow-700">Pending Review</div>
            </div>
            <div className="bg-yellow-500 p-2 rounded-lg">
              <ClockIcon className="h-5 w-5 text-white" />
            </div>
          </div>
        </div>
        
        <div className="bg-gradient-to-r from-green-50 to-green-100 rounded-lg shadow-sm border border-green-200 p-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-2xl font-bold text-green-900">{summaryStats.approved}</div>
              <div className="text-sm text-green-700">Approved</div>
            </div>
            <div className="bg-green-500 p-2 rounded-lg">
              <CheckCircle className="h-5 w-5 text-white" />
            </div>
          </div>
        </div>
        
        <div className="bg-gradient-to-r from-blue-50 to-blue-100 rounded-lg shadow-sm border border-blue-200 p-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-2xl font-bold text-blue-900">{summaryStats.reported}</div>
              <div className="text-sm text-blue-700">Reported</div>
            </div>
            <div className="bg-blue-500 p-2 rounded-lg">
              <FileText className="h-5 w-5 text-white" />
            </div>
          </div>
        </div>
        
        <div className="bg-gradient-to-r from-red-50 to-red-100 rounded-lg shadow-sm border border-red-200 p-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-2xl font-bold text-red-900">{summaryStats.abnormal}</div>
              <div className="text-sm text-red-700">Abnormal Results</div>
            </div>
            <div className="bg-red-500 p-2 rounded-lg">
              <AlertTriangle className="h-5 w-5 text-white" />
            </div>
          </div>
        </div>
        
        <div className="bg-gradient-to-r from-purple-50 to-purple-100 rounded-lg shadow-sm border border-purple-200 p-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-2xl font-bold text-purple-900">{summaryStats.avgTurnaround}h</div>
              <div className="text-sm text-purple-700">Avg TAT</div>
            </div>
            <div className="bg-purple-500 p-2 rounded-lg">
              <TrendingUp className="h-5 w-5 text-white" />
            </div>
          </div>
        </div>
      </div>

      {/* Search and Filter Bar */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
        <div className="flex flex-col sm:flex-row gap-4">
          <div className="flex-1 relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
            <input
              type="text"
              placeholder="Search by patient name, order ID, or test name..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-10 pr-4 py-2 w-full border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
          <select
            value={selectedStatus}
            onChange={(e) => setSelectedStatus(e.target.value)}
            className="px-4 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          >
            {statuses.map(status => (
              <option key={status} value={status}>{status}</option>
            ))}
          </select>
          <button className="flex items-center px-4 py-2 border border-gray-300 rounded-md hover:bg-gray-50 transition-colors">
            <Filter className="h-4 w-4 mr-2" />
            More Filters
          </button>
        </div>
      </div>

      {/* Results Cards */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <div className="px-6 py-4 border-b border-gray-200">
          <h3 className="text-lg font-semibold text-gray-900">
            Test Results ({filteredResults.length})
          </h3>
        </div>
        
        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-6 mt-6">
          {filteredResults.map((result) => {
            const isAbnormal = hasAbnormalFlags(result.values.map(v => ({ 
              ...v, 
              reference_range: v.reference 
            })));
            const abnormalCount = result.values.filter(v => {
              const flag = v.flag || calculateFlag(v.value, v.reference);
              return flag === 'H' || flag === 'L' || flag === 'C';
            }).length;
            const normalCount = result.values.length - abnormalCount;
            
            return (
              <div 
                key={result.id} 
                className={`bg-white border-2 rounded-lg p-4 hover:shadow-md transition-all cursor-pointer ${
                  isAbnormal ? 'border-red-200 bg-red-50' : 'border-gray-200'
                }`}
                onClick={() => setSelectedResult(result)}
              >
                {/* Header with Test Name and Critical Flag */}
                <div className="flex items-start justify-between mb-3">
                  <div className="flex-1">
                    <div className="flex items-center space-x-2">
                      {isAbnormal && (
                        <AlertTriangle className="h-4 w-4 text-red-500 flex-shrink-0" />
                      )}
                      <h4 className={`font-bold text-lg ${isAbnormal ? 'text-red-900' : 'text-gray-900'}`}>
                        {result.testName}
                      </h4>
                      {isAbnormal && (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800">
                          Abnormal
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-gray-500 mt-1">
                      Result ID: {result.id} • Order: {result.orderId}
                    </div>
                  </div>
                  
                  {/* Status Chip */}
                  <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getStatusColor(result.status)}`}>
                    {getStatusIcon(result.status)}
                    <span className="ml-1">{result.status}</span>
                  </span>
                </div>

                {/* Patient Information */}
                <div className="flex items-center space-x-2 mb-3">
                  <User className="h-4 w-4 text-blue-500" />
                  <span className="font-medium text-gray-900">{result.patientName}</span>
                  <span className="text-sm text-gray-500">• ID: {result.patientId}</span>
                </div>

                {/* Test Summary */}
                <div className="bg-gray-50 rounded-lg p-3 mb-3">
                  <div className="flex items-center justify-between text-sm">
                    <div className="flex items-center space-x-4">
                      <div className="flex items-center">
                        <TestTube className="h-4 w-4 text-gray-400 mr-1" />
                        <span className="text-gray-600">{result.values.length} parameters</span>
                      </div>
                      {abnormalCount > 0 && (
                        <div className="flex items-center">
                          <AlertTriangle className="h-4 w-4 text-red-500 mr-1" />
                          <span className="text-red-600 font-medium">{abnormalCount} abnormal</span>
                        </div>
                      )}
                      {normalCount > 0 && (
                        <div className="flex items-center">
                          <CheckCircle className="h-4 w-4 text-green-500 mr-1" />
                          <span className="text-green-600">{normalCount} normal</span>
                        </div>
                      )}
                    </div>
                    
                    {/* Attachment Indicator */}
                    {result.attachmentId && (
                      <div className="flex items-center text-blue-600">
                        <Paperclip className="h-4 w-4 mr-1" />
                        <span className="text-xs">Source Doc</span>
                      </div>
                    )}
                  </div>
                  
                  {/* Expandable Parameter Details */}
                  {expandedDetails[result.id] && (
                    <div className="mt-3 pt-3 border-t border-gray-200">
                      <div className="space-y-2">
                        {result.values.slice(0, 5).map((value, index) => {
                          const calculatedFlag = value.flag || calculateFlag(value.value, value.reference);
                          return (
                            <div key={index} className="flex items-center justify-between text-xs">
                              <span className="font-medium text-gray-700">{value.parameter}</span>
                              <div className="flex items-center space-x-2">
                                <span className="font-bold">{value.value} {value.unit}</span>
                                {calculatedFlag && (
                                  <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${getFlagColor(calculatedFlag)}`}>
                                    {calculatedFlag}
                                  </span>
                                )}
                              </div>
                            </div>
                          );
                        })}
                        {result.values.length > 5 && (
                          <div className="text-xs text-gray-500 text-center">
                            +{result.values.length - 5} more parameters
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                  
                  {/* Toggle Details Button */}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleDetails(result.id);
                    }}
                    className="w-full mt-2 flex items-center justify-center text-xs text-gray-500 hover:text-gray-700 transition-colors"
                  >
                    {expandedDetails[result.id] ? (
                      <>
                        <ChevronUp className="h-3 w-3 mr-1" />
                        Hide Details
                      </>
                    ) : (
                      <>
                        <ChevronDown className="h-3 w-3 mr-1" />
                        Show Details
                      </>
                    )}
                  </button>
                </div>

                {/* Entry and Review Information */}
                <div className="text-xs text-gray-600 mb-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center">
                      <Activity className="h-3 w-3 mr-1" />
                      <span>Tech: {result.enteredBy}</span>
                    </div>
                    <div className="flex items-center">
                      <Calendar className="h-3 w-3 mr-1" />
                      <span>{new Date(result.enteredDate).toLocaleDateString()}</span>
                    </div>
                  </div>
                  {result.reviewedBy && (
                    <div className="flex items-center justify-between mt-1">
                      <div className="flex items-center">
                        <CheckCircle className="h-3 w-3 mr-1 text-green-500" />
                        <span>Reviewed: {result.reviewedBy}</span>
                      </div>
                      <span>{new Date(result.reviewedDate || '').toLocaleDateString()}</span>
                    </div>
                  )}
                </div>

                {/* Action Buttons */}
                <div className="flex items-center justify-between pt-3 border-t border-gray-200">
                  <div className="flex items-center space-x-2">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedResult(result);
                      }}
                      className="flex items-center px-2 py-1 text-xs bg-blue-100 text-blue-700 rounded hover:bg-blue-200 transition-colors"
                    >
                      <Eye className="h-3 w-3 mr-1" />
                      View
                    </button>
                    
                    <button 
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedResult(result);
                        setShowAITools(true);
                      }}
                      className="flex items-center px-2 py-1 text-xs bg-purple-100 text-purple-700 rounded hover:bg-purple-200 transition-colors"
                    >
                      <Brain className="h-3 w-3 mr-1" />
                      AI Tools
                    </button>
                    
                    {result.attachmentId && (
                      <button 
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedResult(result);
                          setShowAITools(true);
                        }}
                        className="flex items-center px-2 py-1 text-xs bg-indigo-100 text-indigo-700 rounded hover:bg-indigo-200 transition-colors"
                      >
                        <Paperclip className="h-3 w-3 mr-1" />
                        Source
                      </button>
                    )}
                  </div>
                  
                  {/* Quick Actions */}
                  <div className="flex items-center space-x-1">
                    {result.status === 'Under Review' && (
                      <button 
                        onClick={(e) => {
                          e.stopPropagation();
                          handleApproveResult(result.id);
                        }}
                        className="p-1 text-green-600 hover:text-green-800 hover:bg-green-100 rounded transition-colors"
                        title="Approve Result"
                      >
                        <CheckCircle className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        
        {/* Empty State */}
        {filteredResults.length === 0 && (
          <div className="text-center py-12">
            <TestTube className="h-12 w-12 text-gray-300 mx-auto mb-4" />
            <h3 className="text-lg font-medium text-gray-900 mb-2">No Results Found</h3>
            <p className="text-gray-500">
              {searchTerm || selectedStatus !== 'All' 
                ? 'Try adjusting your search or filter criteria.' 
                : 'No test results have been entered yet.'}
            </p>
          </div>
        )}
        </div>

      {/* Result Details Modal */}
      {selectedResult && (
        <div className="fixed inset-0 bg-gray-600 bg-opacity-75 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-4xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-6 border-b border-gray-200">
              <h2 className="text-xl font-semibold text-gray-900">Result Details</h2>
              <button
                onClick={() => setSelectedResult(null)}
                className="text-gray-400 hover:text-gray-500 p-1 rounded"
              >
                ×
              </button>
            </div>

            <div className="p-6 space-y-6">
              {/* Result Header */}
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                  <div>
                    <div className="text-blue-600 font-medium">Result ID</div>
                    <div className="text-blue-900">{selectedResult.id}</div>
                  </div>
                  <div>
                    <div className="text-blue-600 font-medium">Patient</div>
                    <div className="text-blue-900">{selectedResult.patientName}</div>
                  </div>
                  <div>
                    <div className="text-blue-600 font-medium">Test</div>
                    <div className="text-blue-900">{selectedResult.testName}</div>
                  </div>
                  <div>
                    <div className="text-blue-600 font-medium">Status</div>
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getStatusColor(selectedResult.status)}`}>
                      {selectedResult.status}
                    </span>
                  </div>
                </div>
              </div>

              {/* Test Results */}
              <div>
                <h3 className="text-lg font-semibold text-gray-900 mb-4">Test Results</h3>
                <div className="space-y-4">
                  <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
                    <div className="grid grid-cols-3 gap-4 text-sm">
                      <div className="text-center">
                        <div className="text-lg font-bold text-blue-900">{selectedResult.values.length}</div>
                        <div className="text-blue-700">Total Parameters</div>
                      </div>
                      <div className="text-center">
                        <div className="text-lg font-bold text-red-900">
                          {selectedResult.values.filter(v => {
                            const flag = v.flag || calculateFlag(v.value, v.reference);
                            return flag === 'H' || flag === 'L' || flag === 'C';
                          }).length}
                        </div>
                        <div className="text-red-700">Abnormal</div>
                      </div>
                      <div className="text-center">
                        <div className="text-lg font-bold text-green-900">
                          {selectedResult.values.filter(v => {
                            const flag = v.flag || calculateFlag(v.value, v.reference);
                            return !flag || flag === '';
                          }).length}
                        </div>
                        <div className="text-green-700">Normal</div>
                      </div>
                    </div>
                  </div>
                  
                  <div className="overflow-x-auto">
                  <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                          Parameter
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                          Value
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                          Unit
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                          Reference Range
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                          Flag
                        </th>
                      </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                      {selectedResult.values.map((value, index) => {
                        const calculatedFlag = value.flag || calculateFlag(value.value, value.reference);
                        return (
                          <tr key={index} className="hover:bg-gray-50">
                            <td className="px-4 py-3 text-sm font-medium text-gray-900">
                              {value.parameter}
                            </td>
                            <td className="px-4 py-3 text-sm font-bold text-gray-900">
                              {value.value}
                            </td>
                            <td className="px-4 py-3 text-sm text-gray-600">
                              {value.unit}
                            </td>
                            <td className="px-4 py-3 text-sm text-gray-600">
                              {value.reference}
                            </td>
                            <td className="px-4 py-3 text-sm">
                              {calculatedFlag && (
                                <span className={`inline-flex items-center px-2 py-1 rounded text-xs font-medium ${getFlagColor(calculatedFlag)}`}>
                                  {calculatedFlag}
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  </div>
                </div>
              </div>

              {/* Attachment Section */}
              {selectedResult.attachmentId && (
                <div>
                  <h3 className="text-lg font-semibold text-gray-900 mb-4">Attachments</h3>
                  <div className="bg-indigo-50 border border-indigo-200 rounded-lg p-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center">
                        <Paperclip className="h-5 w-5 text-indigo-500 mr-2" />
                        <div>
                          <div className="text-sm font-medium text-indigo-900">
                            Lab Result Document
                          </div>
                          <div className="text-sm text-indigo-600">
                            Attachment ID: {selectedResult.attachmentId}
                          </div>
                        </div>
                      </div>
                      <button
                        onClick={() => {
                          // This will be handled by the AI Tools modal
                          setShowAITools(true);
                        }}
                        className="flex items-center px-3 py-1 text-sm bg-indigo-100 text-indigo-700 rounded-md hover:bg-indigo-200 transition-colors"
                      >
                        <Eye className="h-4 w-4 mr-1" />
                        View
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* Actions */}
              <div className="flex items-center justify-between pt-6 border-t border-gray-200">
                <div className="flex items-center space-x-4">
                  <button
                    onClick={handleOpenAITools}
                    className="flex items-center px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors shadow-sm"
                  >
                    <Brain className="h-4 w-4 mr-2" />
                    AI Tools
                  </button>
                  {aiEnhancedResults[selectedResult.id] && (
                    <div className="flex items-center text-sm text-green-600">
                      <CheckCircle className="h-4 w-4 mr-1" />
                      AI Enhanced
                    </div>
                  )}
                </div>
                <div className="flex items-center space-x-4">
                <button
                  onClick={() => setSelectedResult(null)}
                  className="px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 transition-colors"
                >
                  Close
                </button>
                {selectedResult.status === 'Under Review' && (
                  <>
                    <button 
                      onClick={() => handleRejectResult(selectedResult.id)}
                      className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors"
                    >
                      Reject
                    </button>
                    <button 
                      onClick={() => handleApproveResult(selectedResult.id)}
                      className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors"
                    >
                      Approve
                    </button>
                  </>
                )}
                {selectedResult.status === 'Approved' && (
                  <button 
                    onClick={() => handleGenerateReport(selectedResult.id)}
                    className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:bg-gray-400 disabled:cursor-not-allowed"
                  >
                    Generate Report
                  </button>
                )}
                {selectedResult.status === 'Reported' && (
                  <button 
                    onClick={() => handleRevertToUnderReview(selectedResult.id)}
                    disabled={isReverting}
                    className="px-4 py-2 bg-yellow-600 text-white rounded-lg hover:bg-yellow-700 transition-colors disabled:bg-gray-400 disabled:cursor-not-allowed"
                  >
                    {isReverting ? (
                      <>
                        <div className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent mr-2 inline-block"></div>
                        Reverting...
                      </>
                    ) : (
                      'Revert to Under Review'
                    )}
                  </button>
                )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* AI Tools Modal */}
      {showAITools && selectedResult && (
        <AIToolsModal
          isOpen={showAITools}
          onClose={() => setShowAITools(false)}
          patient={{
            id: selectedResult.patientId,
            name: selectedResult.patientName,
          }}
          result={{
            id: selectedResult.id,
            testName: selectedResult.testName,
            values: selectedResult.values,
            attachmentId: selectedResult.attachmentId,
          }}
          onAIResultGenerated={handleAIResultGenerated}
        />
      )}

      {/* Quick Actions */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-gradient-to-r from-yellow-50 to-yellow-100 rounded-lg p-6 border border-yellow-200">
          <h3 className="text-lg font-semibold text-yellow-900 mb-2">Pending Review</h3>
          <p className="text-yellow-800 text-sm mb-4">
            {summaryStats.pendingReview} results awaiting pathologist review
          </p>
          <button 
            onClick={() => setSelectedStatus('Under Review')}
            className="bg-yellow-600 text-white px-4 py-2 rounded-lg hover:bg-yellow-700 transition-colors shadow-sm"
          >
            Review Queue
          </button>
        </div>

        <div className="bg-gradient-to-r from-green-50 to-green-100 rounded-lg p-6 border border-green-200">
          <h3 className="text-lg font-semibold text-green-900 mb-2">Approved Results</h3>
          <p className="text-green-800 text-sm mb-4">
            {summaryStats.approved} results ready for report generation
          </p>
          <button 
            onClick={() => setSelectedStatus('Approved')}
            className="bg-green-600 text-white px-4 py-2 rounded-lg hover:bg-green-700 transition-colors shadow-sm"
          >
            Generate Reports
          </button>
        </div>

        <div className="bg-gradient-to-r from-red-50 to-red-100 rounded-lg p-6 border border-red-200">
          <h3 className="text-lg font-semibold text-red-900 mb-2">Critical Results</h3>
          <p className="text-red-800 text-sm mb-4">
            {summaryStats.abnormal} results with abnormal values requiring attention
          </p>
          <button 
            onClick={() => {
              // Filter to show only abnormal results
              const abnormalResults = results.filter(r => hasAbnormalFlags(r.values.map(v => ({ 
                ...v, 
                reference_range: v.reference 
              }))));
              // You could implement a custom filter here
            }}
            className="bg-red-600 text-white px-4 py-2 rounded-lg hover:bg-red-700 transition-colors shadow-sm"
          >
            Review Critical
          </button>
        </div>
      </div>
      </div>
  );
};

export default Results;