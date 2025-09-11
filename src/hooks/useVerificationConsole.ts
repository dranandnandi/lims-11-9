import { useState, useEffect, useCallback } from 'react';
import { verificationService, VerificationResult, VerificationFilters, VerificationStats } from '../utils/verificationService';

interface UseVerificationConsoleResult {
  results: VerificationResult[];
  stats: VerificationStats;
  loading: boolean;
  error: string | null;
  selectedIds: Set<string>;
  focusedResult: VerificationResult | null;
  expandedRows: Set<string>;
  
  // Actions
  refreshResults: () => Promise<void>;
  setFilters: (filters: VerificationFilters) => void;
  selectResult: (id: string, selected: boolean) => void;
  selectAllResults: (selected: boolean) => void;
  focusResult: (result: VerificationResult) => void;
  toggleExpanded: (id: string) => void;
  approveResult: (id: string, notes?: string) => Promise<boolean>;
  rejectResult: (id: string, reason: string) => Promise<boolean>;
  bulkApprove: (notes?: string) => Promise<{ success: boolean; successCount: number; failedIds: string[] }>;
  bulkReject: (reason: string) => Promise<{ success: boolean; successCount: number; failedIds: string[] }>;
  clearSelection: () => void;
}

const defaultFilters: VerificationFilters = {
  dateFilter: 'today',
  priorityFilter: '',
  categoryFilter: '',
  search: '',
  showOnlyPending: true,
  showOnlyCritical: false
};

export const useVerificationConsole = (initialFilters: Partial<VerificationFilters> = {}): UseVerificationConsoleResult => {
  // State
  const [results, setResults] = useState<VerificationResult[]>([]);
  const [stats, setStats] = useState<VerificationStats>({ total: 0, pending: 0, flagged: 0, critical: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFiltersState] = useState<VerificationFilters>({ ...defaultFilters, ...initialFilters });
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [focusedResult, setFocusedResult] = useState<VerificationResult | null>(null);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());

  // Fetch results
  const fetchResults = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      
      const { results: fetchedResults, stats: fetchedStats } = await verificationService.fetchVerificationResults(filters);
      
      setResults(fetchedResults);
      setStats(fetchedStats);
      
      // Clear selections if results changed
      setSelectedIds(new Set());
      setFocusedResult(null);
      
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch results');
      console.error('Error fetching verification results:', err);
    } finally {
      setLoading(false);
    }
  }, [filters]);

  // Initial load
  useEffect(() => {
    fetchResults();
  }, [fetchResults]);

  // Actions
  const refreshResults = useCallback(async () => {
    await fetchResults();
  }, [fetchResults]);

  const setFilters = useCallback((newFilters: VerificationFilters) => {
    setFiltersState(newFilters);
  }, []);

  const selectResult = useCallback((id: string, selected: boolean) => {
    setSelectedIds(prev => {
      const newSelected = new Set(prev);
      if (selected) {
        newSelected.add(id);
      } else {
        newSelected.delete(id);
      }
      return newSelected;
    });
  }, []);

  const selectAllResults = useCallback((selected: boolean) => {
    if (selected) {
      setSelectedIds(new Set(results.map(r => r.id)));
    } else {
      setSelectedIds(new Set());
    }
  }, [results]);

  const focusResult = useCallback((result: VerificationResult) => {
    setFocusedResult(result);
  }, []);

  const toggleExpanded = useCallback((id: string) => {
    setExpandedRows(prev => {
      const newExpanded = new Set(prev);
      if (newExpanded.has(id)) {
        newExpanded.delete(id);
      } else {
        newExpanded.add(id);
      }
      return newExpanded;
    });
  }, []);

  const approveResult = useCallback(async (id: string, notes?: string): Promise<boolean> => {
    try {
      const success = await verificationService.approveResult(id, notes);
      
      if (success) {
        // Remove from local state (since we only show pending verification)
        setResults(prev => prev.filter(result => result.id !== id));
        
        // Remove from selected if it was selected
        setSelectedIds(prev => {
          const newSelected = new Set(prev);
          newSelected.delete(id);
          return newSelected;
        });
        
        // Update stats
        setStats(prev => ({
          ...prev,
          pending: Math.max(0, prev.pending - 1),
          total: Math.max(0, prev.total - 1)
        }));
      }
      
      return success;
    } catch (err) {
      console.error('Error approving result:', err);
      return false;
    }
  }, []);

  const rejectResult = useCallback(async (id: string, reason: string): Promise<boolean> => {
    try {
      const success = await verificationService.rejectResult(id, reason);
      
      if (success) {
        // Remove from local state (since we only show pending verification)
        setResults(prev => prev.filter(result => result.id !== id));
        
        // Remove from selected if it was selected
        setSelectedIds(prev => {
          const newSelected = new Set(prev);
          newSelected.delete(id);
          return newSelected;
        });
        
        // Update stats
        setStats(prev => ({
          ...prev,
          pending: Math.max(0, prev.pending - 1),
          total: Math.max(0, prev.total - 1)
        }));
      }
      
      return success;
    } catch (err) {
      console.error('Error rejecting result:', err);
      return false;
    }
  }, []);

  const bulkApprove = useCallback(async (notes?: string) => {
    try {
      const idsToApprove = Array.from(selectedIds);
      
      if (idsToApprove.length === 0) {
        return { success: false, successCount: 0, failedIds: [] };
      }
      
      const result = await verificationService.bulkApproveResults(idsToApprove, notes);
      
      if (result.success) {
        // Remove successful approvals from local state
        setResults(prev => prev.filter(r => !idsToApprove.includes(r.id)));
        
        // Clear selections
        setSelectedIds(new Set());
        
        // Update stats
        setStats(prev => ({
          ...prev,
          pending: Math.max(0, prev.pending - result.successCount),
          total: Math.max(0, prev.total - result.successCount)
        }));
      }
      
      return result;
    } catch (err) {
      console.error('Error in bulk approve:', err);
      return { success: false, successCount: 0, failedIds: Array.from(selectedIds) };
    }
  }, [selectedIds]);

  const bulkReject = useCallback(async (reason: string) => {
    try {
      const idsToReject = Array.from(selectedIds);
      
      if (idsToReject.length === 0 || !reason.trim()) {
        return { success: false, successCount: 0, failedIds: [] };
      }
      
      const result = await verificationService.bulkRejectResults(idsToReject, reason);
      
      if (result.success) {
        // Remove successful rejections from local state
        setResults(prev => prev.filter(r => !idsToReject.includes(r.id)));
        
        // Clear selections
        setSelectedIds(new Set());
        
        // Update stats
        setStats(prev => ({
          ...prev,
          pending: Math.max(0, prev.pending - result.successCount),
          total: Math.max(0, prev.total - result.successCount)
        }));
      }
      
      return result;
    } catch (err) {
      console.error('Error in bulk reject:', err);
      return { success: false, successCount: 0, failedIds: Array.from(selectedIds) };
    }
  }, [selectedIds]);

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
    setFocusedResult(null);
  }, []);

  return {
    results,
    stats,
    loading,
    error,
    selectedIds,
    focusedResult,
    expandedRows,
    
    // Actions
    refreshResults,
    setFilters,
    selectResult,
    selectAllResults,
    focusResult,
    toggleExpanded,
    approveResult,
    rejectResult,
    bulkApprove,
    bulkReject,
    clearSelection
  };
};

export default useVerificationConsole;