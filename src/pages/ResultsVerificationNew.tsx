import { useState, useEffect, useCallback, useMemo } from 'react';
import { supabase } from '../utils/supabase';
import { 
  CheckCircle, 
  XCircle, 
  AlertTriangle, 
  Clock, 
  Search,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  CheckSquare,
  Square
} from 'lucide-react';

interface PendingResult {
  result_id: string;
  order_id: string;
  patient_id: string;
  patient_name: string;
  test_name: string;
  verification_status: 'pending_verification' | 'verified' | 'rejected' | 'needs_clarification';
  entered_by: string;
  entered_date: string;
  technician_notes?: string;
  delta_check_flag: boolean;
  critical_flag: boolean;
  priority_level: number;
  sample_id: string;
  order_priority: string;
  order_date: string;
  physician_name: string;
  full_patient_name: string;
  gender: string;
  patient_code: string;
  age: number;
  hours_since_entry: number;
}

interface ResultValue {
  value: string;
  unit: string;
  reference_range: string;
  flag: string;
  analyte_name: string;
  department: string;
}

interface TestGroup {
  test_name: string;
  order_id: string;
  patient_name: string;
  patient_code: string;
  age: number;
  gender: string;
  physician_name: string;
  order_priority: string;
  order_date: string;
  sample_id: string;
  critical_flag: boolean;
  hours_since_entry: number;
  results: Array<PendingResult & { values: ResultValue[] }>;
}

interface VerificationStats {
  pending_count: number;
  approved_count: number;
  rejected_count: number;
  clarification_count: number;
  urgent_count: number;
  avg_verification_time_hours: number;
}

export default function ResultsVerification() {
  const [testGroups, setTestGroups] = useState<TestGroup[]>([]);
  const [verificationStats, setVerificationStats] = useState<VerificationStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterUrgency, setFilterUrgency] = useState<string>('all');
  const [filterCategory, setFilterCategory] = useState<string>('all');
  const [filterDate, setFilterDate] = useState<string>('today'); // Default to today
  const [selectedTestIds, setSelectedTestIds] = useState<Set<string>>(new Set());
  const [selectedResultIds, setSelectedResultIds] = useState<Set<string>>(new Set());
  const [expandedTests, setExpandedTests] = useState<Set<string>>(new Set());
  const [verificationNotes, setVerificationNotes] = useState('');

  // Load pending results and stats
  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      
      // Load pending results using the simplified verification_queue view
      const { data: results, error: resultsError } = await supabase
        .from('verification_queue')
        .select('*')
        .order('order_priority', { ascending: true })
        .order('hours_since_entry', { ascending: false });
      
      if (resultsError) throw resultsError;

      // For each result, get the result values separately
      const resultsWithValues = await Promise.all(
        (results || []).map(async (result) => {
          const { data: values, error: valuesError } = await supabase
            .rpc('get_result_values', { p_result_id: result.result_id });

          return {
            ...result,
            values: valuesError ? [] : (values || [])
          };
        })
      );
      
      // Group results by test and order
      const groupedTests = new Map<string, TestGroup>();
      
      resultsWithValues.forEach(result => {
        const groupKey = `${result.order_id}-${result.test_name}`;
        
        if (!groupedTests.has(groupKey)) {
          groupedTests.set(groupKey, {
            test_name: result.test_name,
            order_id: result.order_id,
            patient_name: result.patient_name,
            patient_code: result.patient_code,
            age: result.age,
            gender: result.gender,
            physician_name: result.physician_name,
            order_priority: result.order_priority,
            order_date: result.order_date,
            sample_id: result.orders?.sample_id || null, // Get sample_id from orders table
            critical_flag: result.critical_flag,
            hours_since_entry: result.hours_since_entry,
            results: []
          });
        }
        
        groupedTests.get(groupKey)!.results.push(result);
      });
      
      // Load verification stats
      const { data: stats, error: statsError } = await supabase
        .from('view_verification_stats')
        .select('*')
        .single();
      
      if (statsError) console.error('Stats error:', statsError);
      
      setTestGroups(Array.from(groupedTests.values()));
      setVerificationStats(stats);
    } catch (error) {
      console.error('Error loading verification data:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  // Filter and sort test groups
  const filteredAndSortedTestGroups = useMemo(() => {
    let filtered = testGroups.filter(testGroup => {
      const matchesSearch = searchTerm === '' || 
        testGroup.patient_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        testGroup.test_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        testGroup.order_id.toLowerCase().includes(searchTerm.toLowerCase()) ||
        testGroup.patient_code.toLowerCase().includes(searchTerm.toLowerCase());
      
      const matchesUrgency = filterUrgency === 'all' || 
        (filterUrgency === 'urgent' && (testGroup.critical_flag || testGroup.order_priority === 'STAT')) ||
        (filterUrgency === 'high' && testGroup.order_priority === 'High') ||
        (filterUrgency === 'medium' && testGroup.order_priority === 'Medium') ||
        (filterUrgency === 'normal' && testGroup.order_priority === 'Normal');
      
      const matchesCategory = filterCategory === 'all' || 
        testGroup.results.some(result => 
          result.values.some(value => value.department === filterCategory)
        );
      
      // Date filtering
      const matchesDate = (() => {
        if (filterDate === 'all') return true;
        
        const resultDate = new Date(testGroup.order_date);
        const today = new Date();
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);
        const weekAgo = new Date(today);
        weekAgo.setDate(weekAgo.getDate() - 7);
        const monthAgo = new Date(today);
        monthAgo.setMonth(monthAgo.getMonth() - 1);
        
        switch (filterDate) {
          case 'today':
            return resultDate.toDateString() === today.toDateString();
          case 'yesterday':
            return resultDate.toDateString() === yesterday.toDateString();
          case 'week':
            return resultDate >= weekAgo;
          case 'month':
            return resultDate >= monthAgo;
          default:
            return true;
        }
      })();
      
      return matchesSearch && matchesUrgency && matchesCategory && matchesDate;
    });

    // Sort by priority: critical first, then STAT, then by hours pending
    filtered.sort((a, b) => {
      if (a.critical_flag && !b.critical_flag) return -1;
      if (!a.critical_flag && b.critical_flag) return 1;
      if (a.order_priority === 'STAT' && b.order_priority !== 'STAT') return -1;
      if (a.order_priority !== 'STAT' && b.order_priority === 'STAT') return 1;
      return b.hours_since_entry - a.hours_since_entry;
    });

    return filtered;
  }, [testGroups, searchTerm, filterUrgency, filterCategory, filterDate]);

  // Verify single result
  const verifyResult = async (resultId: string, status: 'verified' | 'rejected' | 'needs_clarification', notes?: string) => {
    try {
      const { error } = await supabase
        .rpc('verify_result', {
          p_result_id: resultId,
          p_action: status === 'verified' ? 'approve' : status === 'rejected' ? 'reject' : 'clarify',
          p_comment: notes || verificationNotes
        });

      if (error) throw error;

      // Refresh data
      await loadData();
    } catch (error) {
      console.error('Error verifying result:', error);
      alert('Error verifying result. Please try again.');
    }
  };

  // Bulk verify selected results
  const bulkVerifyResults = async (status: 'verified' | 'rejected' | 'needs_clarification') => {
    if (selectedResultIds.size === 0) return;

    try {
      const promises = Array.from(selectedResultIds).map(resultId =>
        supabase.rpc('verify_result', {
          p_result_id: resultId,
          p_action: status === 'verified' ? 'approve' : status === 'rejected' ? 'reject' : 'clarify',
          p_comment: verificationNotes
        })
      );

      await Promise.all(promises);
      
      // Clear selections and refresh
      setSelectedResultIds(new Set());
      setSelectedTestIds(new Set());
      setVerificationNotes('');
      await loadData();
    } catch (error) {
      console.error('Error bulk verifying results:', error);
      alert('Error verifying results. Please try again.');
    }
  };

  // Verify entire test (all analytes)
  const verifyEntireTest = async (testGroup: TestGroup, status: 'verified' | 'rejected' | 'needs_clarification') => {
    try {
      const resultIds = testGroup.results.map(result => result.result_id);
      const promises = resultIds.map(resultId =>
        supabase.rpc('verify_result', {
          p_result_id: resultId,
          p_action: status === 'verified' ? 'approve' : status === 'rejected' ? 'reject' : 'clarify',
          p_comment: verificationNotes
        })
      );

      await Promise.all(promises);
      await loadData();
    } catch (error) {
      console.error('Error verifying test:', error);
      alert('Error verifying test. Please try again.');
    }
  };

  // Select all tests functionality
  const selectAllTests = () => {
    const allTestKeys = filteredAndSortedTestGroups.map(group => `${group.order_id}-${group.test_name}`);
    const allResultIds = filteredAndSortedTestGroups.flatMap(group => 
      group.results.map(result => result.result_id)
    );
    
    setSelectedTestIds(new Set(allTestKeys));
    setSelectedResultIds(new Set(allResultIds));
  };

  // Clear all selections
  const clearAllSelections = () => {
    setSelectedTestIds(new Set());
    setSelectedResultIds(new Set());
  };

  // Toggle test selection
  const toggleTestSelection = (testGroup: TestGroup) => {
    const testKey = `${testGroup.order_id}-${testGroup.test_name}`;
    const resultIds = testGroup.results.map(result => result.result_id);
    
    const newSelectedTests = new Set(selectedTestIds);
    const newSelectedResults = new Set(selectedResultIds);
    
    if (selectedTestIds.has(testKey)) {
      // Deselect test and all its results
      newSelectedTests.delete(testKey);
      resultIds.forEach(id => newSelectedResults.delete(id));
    } else {
      // Select test and all its results
      newSelectedTests.add(testKey);
      resultIds.forEach(id => newSelectedResults.add(id));
    }
    
    setSelectedTestIds(newSelectedTests);
    setSelectedResultIds(newSelectedResults);
  };

  // Toggle individual result selection
  const toggleResultSelection = (resultId: string, testGroup: TestGroup) => {
    const testKey = `${testGroup.order_id}-${testGroup.test_name}`;
    const resultIds = testGroup.results.map(result => result.result_id);
    
    const newSelectedResults = new Set(selectedResultIds);
    const newSelectedTests = new Set(selectedTestIds);
    
    if (selectedResultIds.has(resultId)) {
      newSelectedResults.delete(resultId);
      // If no results from this test are selected, deselect the test
      const hasSelectedResults = resultIds.some(id => newSelectedResults.has(id));
      if (!hasSelectedResults) {
        newSelectedTests.delete(testKey);
      }
    } else {
      newSelectedResults.add(resultId);
      // If all results from this test are selected, select the test
      const allSelected = resultIds.every(id => newSelectedResults.has(id));
      if (allSelected) {
        newSelectedTests.add(testKey);
      }
    }
    
    setSelectedResultIds(newSelectedResults);
    setSelectedTestIds(newSelectedTests);
  };

  // Toggle test expansion
  const toggleTestExpansion = (testKey: string) => {
    const newExpanded = new Set(expandedTests);
    if (expandedTests.has(testKey)) {
      newExpanded.delete(testKey);
    } else {
      newExpanded.add(testKey);
    }
    setExpandedTests(newExpanded);
  };

  useEffect(() => {
    loadData();
  }, [loadData]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-96">
        <RefreshCw className="w-8 h-8 animate-spin text-indigo-600" />
        <span className="ml-2 text-lg">Loading verification queue...</span>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Results Verification</h1>
            <p className="text-gray-600 mt-1">Pathologist review and approval workflow</p>
          </div>
          
          {/* Stats Cards */}
          <div className="flex space-x-4">
            <div className="text-center">
              <div className="text-2xl font-bold text-orange-600">
                {verificationStats?.pending_count || 0}
              </div>
              <div className="text-sm text-gray-600">Pending</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-red-600">
                {verificationStats?.urgent_count || 0}
              </div>
              <div className="text-sm text-gray-600">Urgent</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-green-600">
                {verificationStats?.approved_count || 0}
              </div>
              <div className="text-sm text-gray-600">Approved Today</div>
            </div>
          </div>
        </div>
      </div>

      <div className="flex h-screen">
        {/* Left Panel - Test Groups */}
        <div className="w-1/2 bg-white border-r flex flex-col">
          {/* Filters */}
          <div className="p-4 border-b bg-gray-50">
            <div className="space-y-3">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-4 h-4" />
                <input
                  type="text"
                  placeholder="Search patients, tests, orders..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-md text-sm"
                />
              </div>
              
              <div className="grid grid-cols-3 gap-2">
                <select
                  value={filterDate}
                  onChange={(e) => setFilterDate(e.target.value)}
                  className="px-3 py-2 border border-gray-300 rounded-md text-sm"
                >
                  <option value="all">All Dates</option>
                  <option value="today">Today</option>
                  <option value="yesterday">Yesterday</option>
                  <option value="week">This Week</option>
                  <option value="month">This Month</option>
                </select>
                
                <select
                  value={filterUrgency}
                  onChange={(e) => setFilterUrgency(e.target.value)}
                  className="px-3 py-2 border border-gray-300 rounded-md text-sm"
                >
                  <option value="all">All Priority</option>
                  <option value="urgent">Urgent</option>
                  <option value="high">High</option>
                  <option value="medium">Medium</option>
                  <option value="normal">Normal</option>
                </select>
                
                <select
                  value={filterCategory}
                  onChange={(e) => setFilterCategory(e.target.value)}
                  className="px-3 py-2 border border-gray-300 rounded-md text-sm"
                >
                  <option value="all">All Categories</option>
                  <option value="Hematology">Hematology</option>
                  <option value="Chemistry">Chemistry</option>
                  <option value="Microbiology">Microbiology</option>
                  <option value="Immunology">Immunology</option>
                </select>
              </div>
            </div>
          </div>

          {/* Bulk Actions */}
          {selectedResultIds.size > 0 && (
            <div className="p-3 bg-indigo-50 border-b">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-indigo-900">
                  {selectedResultIds.size} result(s) selected
                </span>
                <div className="flex space-x-2">
                  <button
                    onClick={() => bulkVerifyResults('verified')}
                    className="px-3 py-1 bg-green-600 text-white text-xs rounded hover:bg-green-700"
                  >
                    Approve All
                  </button>
                  <button
                    onClick={() => bulkVerifyResults('rejected')}
                    className="px-3 py-1 bg-red-600 text-white text-xs rounded hover:bg-red-700"
                  >
                    Reject All
                  </button>
                  <button
                    onClick={clearAllSelections}
                    className="px-3 py-1 bg-gray-600 text-white text-xs rounded hover:bg-gray-700"
                  >
                    Clear
                  </button>
                </div>
              </div>
              
              <div className="mt-2">
                <button
                  onClick={selectAllTests}
                  className="text-xs text-indigo-600 hover:text-indigo-800"
                >
                  Select All Tests
                </button>
              </div>
            </div>
          )}

          {/* Test Groups List */}
          <div className="flex-1 overflow-y-auto">
            {filteredAndSortedTestGroups.map((testGroup) => {
              const testKey = `${testGroup.order_id}-${testGroup.test_name}`;
              const isTestSelected = selectedTestIds.has(testKey);
              const isExpanded = expandedTests.has(testKey);
              
              return (
                <div key={testKey} className="border-b">
                  {/* Test Header */}
                  <div className="p-4 hover:bg-gray-50">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center space-x-3">
                        <button
                          onClick={() => toggleTestExpansion(testKey)}
                          className="text-gray-400 hover:text-gray-600"
                        >
                          {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                        </button>
                        
                        <button
                          onClick={() => toggleTestSelection(testGroup)}
                          className="text-indigo-600 hover:text-indigo-800"
                        >
                          {isTestSelected ? <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4" />}
                        </button>
                        
                        <div>
                          <div className="font-medium text-gray-900">{testGroup.test_name}</div>
                          <div className="text-sm text-gray-600">
                            {testGroup.patient_name} • {testGroup.patient_code} • {testGroup.age}y {testGroup.gender}
                          </div>
                          <div className="text-xs text-gray-500">
                            Order: {testGroup.order_id} • Sample: {testGroup.sample_id}
                          </div>
                        </div>
                      </div>
                      
                      <div className="flex items-center space-x-2">
                        {testGroup.critical_flag && (
                          <span className="px-2 py-1 text-xs font-medium rounded-full text-red-600 bg-red-50">
                            CRITICAL
                          </span>
                        )}
                        <span className={`px-2 py-1 text-xs font-medium rounded-full ${
                          testGroup.order_priority === 'STAT' ? 'text-orange-600 bg-orange-50' :
                          testGroup.order_priority === 'High' ? 'text-yellow-600 bg-yellow-50' :
                          'text-gray-600 bg-gray-50'
                        }`}>
                          {testGroup.order_priority}
                        </span>
                        
                        <div className="flex space-x-1">
                          <button
                            onClick={() => verifyEntireTest(testGroup, 'verified')}
                            className="px-2 py-1 text-xs bg-green-600 text-white rounded hover:bg-green-700"
                          >
                            Approve Test
                          </button>
                          <button
                            onClick={() => verifyEntireTest(testGroup, 'rejected')}
                            className="px-2 py-1 text-xs bg-red-600 text-white rounded hover:bg-red-700"
                          >
                            Reject Test
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Analyte Results */}
                  {isExpanded && (
                    <div className="bg-gray-50 border-t">
                      {testGroup.results.map((result) => (
                        <div key={result.result_id} className="px-8 py-3 border-b border-gray-200 last:border-b-0">
                          {result.values.map((value, index) => (
                            <div key={index} className="flex items-center justify-between">
                              <div className="flex items-center space-x-3">
                                <button
                                  onClick={() => toggleResultSelection(result.result_id, testGroup)}
                                  className="text-indigo-600 hover:text-indigo-800"
                                >
                                  {selectedResultIds.has(result.result_id) ? 
                                    <CheckSquare className="w-3 h-3" /> : 
                                    <Square className="w-3 h-3" />
                                  }
                                </button>
                                
                                <div>
                                  <div className="font-medium text-sm">{value.analyte_name}</div>
                                  <div className="text-xs text-gray-600">
                                    <span className="font-medium">{value.value}</span>
                                    {value.unit && <span className="ml-1">{value.unit}</span>}
                                    {value.reference_range && <span className="ml-2 text-gray-500">Ref: {value.reference_range}</span>}
                                  </div>
                                </div>
                              </div>
                              
                              <div className="flex items-center space-x-2">
                                {value.flag && (
                                  <span className={`px-2 py-1 text-xs font-medium rounded ${
                                    value.flag === 'H' ? 'text-red-600 bg-red-50' :
                                    value.flag === 'L' ? 'text-blue-600 bg-blue-50' :
                                    'text-gray-600 bg-gray-50'
                                  }`}>
                                    {value.flag}
                                  </span>
                                )}
                                
                                <div className="flex space-x-1">
                                  <button
                                    onClick={() => verifyResult(result.result_id, 'verified')}
                                    className="p-1 text-green-600 hover:bg-green-50 rounded"
                                  >
                                    <CheckCircle className="w-4 h-4" />
                                  </button>
                                  <button
                                    onClick={() => verifyResult(result.result_id, 'rejected')}
                                    className="p-1 text-red-600 hover:bg-red-50 rounded"
                                  >
                                    <XCircle className="w-4 h-4" />
                                  </button>
                                  <button
                                    onClick={() => verifyResult(result.result_id, 'needs_clarification')}
                                    className="p-1 text-yellow-600 hover:bg-yellow-50 rounded"
                                  >
                                    <AlertTriangle className="w-4 h-4" />
                                  </button>
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Right Panel - Verification Notes */}
        <div className="w-1/2 bg-white flex flex-col">
          <div className="p-4 border-b">
            <h3 className="text-lg font-semibold text-gray-900">Verification Notes</h3>
            <p className="text-sm text-gray-600">Add comments for verification actions</p>
          </div>
          
          <div className="flex-1 p-4">
            <textarea
              value={verificationNotes}
              onChange={(e) => setVerificationNotes(e.target.value)}
              placeholder="Add verification notes here..."
              className="w-full h-32 p-3 border border-gray-300 rounded-md resize-none"
            />
            
            <div className="mt-4 space-y-2">
              <h4 className="font-medium text-gray-900">Quick Actions</h4>
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => setVerificationNotes('Approved - Values within normal limits')}
                  className="p-2 text-sm text-left border border-gray-300 rounded hover:bg-gray-50"
                >
                  Normal limits
                </button>
                <button
                  onClick={() => setVerificationNotes('Rejected - Repeat analysis required')}
                  className="p-2 text-sm text-left border border-gray-300 rounded hover:bg-gray-50"
                >
                  Repeat required
                </button>
                <button
                  onClick={() => setVerificationNotes('Critical value - Physician notified')}
                  className="p-2 text-sm text-left border border-gray-300 rounded hover:bg-gray-50"
                >
                  Critical value
                </button>
                <button
                  onClick={() => setVerificationNotes('Delta check flag - Previous results reviewed')}
                  className="p-2 text-sm text-left border border-gray-300 rounded hover:bg-gray-50"
                >
                  Delta check
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
