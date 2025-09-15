import { supabase } from './supabase';

// Types for the verification console
export interface VerificationParameter {
  name: string;
  value: string;
  units?: string;
  reference_range?: string;
  flag: 'normal' | 'abnormal' | 'critical';
  delta?: {
    percent: number;
    direction: 'up' | 'down' | 'none';
    previousValue?: string;
    previousDate?: string;
  };
}

export interface VerificationResult {
  id: string;
  test_name: string;
  test_group?: string;
  test_category?: string;
  patient: {
    name: string;
    age: number;
    gender: string;
    mrn?: string;
  };
  order_id: string;
  status: 'pending' | 'normal' | 'abnormal' | 'critical';
  parameters: VerificationParameter[];
  flags: {
    critical: boolean;
    repeat: boolean;
    manual_override: boolean;
  };
  sample_time: string;
  collection_time?: string;
  receipt_time?: string;
  images?: Array<{
    type: string;
    thumb_url: string;
    full_url: string;
  }>;
  attachments?: Array<{
    id: string;
    file_url: string;
    file_type: string;
    original_filename: string;
    created_at: string;
    level: 'test' | 'order';
  }>;
  audit_info: {
    source: 'OCR' | 'Analyzer' | 'LIS' | 'Manual';
    auto_calculated: boolean;
    manually_edited: boolean;
  };
  verification_status: 'pending_verification' | 'verified' | 'rejected';
  verified_by?: string;
  verified_at?: string;
  review_comment?: string;
}

export interface VerificationFilters {
  dateFilter: 'today' | 'last7days' | 'custom';
  startDate?: string;
  endDate?: string;
  priorityFilter: string;
  categoryFilter: string;
  search: string;
  showOnlyPending?: boolean;
  showOnlyCritical?: boolean;
}

export interface VerificationStats {
  total: number;
  pending: number;
  flagged: number;
  critical: number;
}

/**
 * Service for Result Verification Console operations
 */
class VerificationService {
  
  // Fetch results for verification with filtering
  async fetchVerificationResults(filters: VerificationFilters): Promise<{
    results: VerificationResult[];
    stats: VerificationStats;
  }> {
    try {
      let query = supabase
        .from('results')
        .select(`
          id,
          test_name,
          status,
          verification_status,
          verified_by,
          verified_at,
          review_comment,
          created_at,
          critical_flag,
          delta_check_flag,
          manually_verified,
          extracted_by_ai,
          ai_confidence,
          order_id,
          orders!inner (
            id,
            patient_name,
            sample_collected_at,
            sample_collected_by
          ),
          result_values (
            parameter,
            value,
            unit,
            reference_range,
            flag
          )
        `)
        .eq('verification_status', 'pending_verification')
        .order('order_id', { ascending: true })
        .order('test_name', { ascending: true })
        .order('created_at', { ascending: false });

      // Apply date filters
      if (filters.dateFilter === 'today') {
        const today = new Date().toISOString().split('T')[0];
        query = query.gte('created_at', `${today}T00:00:00`);
      } else if (filters.dateFilter === 'last7days') {
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
        query = query.gte('created_at', sevenDaysAgo.toISOString());
      } else if (filters.dateFilter === 'custom' && filters.startDate && filters.endDate) {
        query = query
          .gte('created_at', `${filters.startDate}T00:00:00`)
          .lte('created_at', `${filters.endDate}T23:59:59`);
      }

      // Apply search filter
      if (filters.search) {
        query = query.or(`
          test_name.ilike.%${filters.search}%,
          orders.patient_name.ilike.%${filters.search}%,
          orders.id.ilike.%${filters.search}%
        `);
      }

      // Apply priority filter
      if (filters.priorityFilter === 'critical') {
        query = query.eq('critical_flag', true);
      }

      // Execute query
      const { data, error } = await query;

      if (error) {
        console.error('Error fetching verification results:', error);
        throw error;
      }

      // Transform data to match VerificationResult interface
      const results: VerificationResult[] = (data || []).map(result => {
        const order = Array.isArray(result.orders) ? result.orders[0] : result.orders;
        
        // Extract test group from test name (e.g., "Blood Grouping" from "Rh Blood Group")
        const testGroup = this.extractTestGroup(result.test_name);
        
        return {
          id: result.id,
          test_name: result.test_name,
          test_group: testGroup,
          test_category: this.getTestCategory(testGroup),
          patient: {
            name: order?.patient_name || 'Unknown',
            age: 0, // Will need to be fetched separately if needed
            gender: 'U', // Will need to be fetched separately if needed
            mrn: undefined
          },
          order_id: result.order_id || order?.id || 'Unknown',
          status: this.getStatusFromFlags(result),
          parameters: this.transformResultValues(result.result_values || []),
          flags: {
            critical: result.critical_flag || false,
            repeat: result.delta_check_flag || false,
            manual_override: result.manually_verified || false
          },
          sample_time: result.created_at,
          collection_time: order?.sample_collected_at,
          receipt_time: result.created_at,
          audit_info: {
            source: result.extracted_by_ai ? 'OCR' : 'Manual',
            auto_calculated: result.extracted_by_ai || false,
            manually_edited: result.manually_verified || false
          },
          verification_status: result.verification_status,
          verified_by: result.verified_by,
          verified_at: result.verified_at,
          review_comment: result.review_comment
        };
      });

      // Fetch attachments for all order_ids
      const uniqueOrderIds = [...new Set(results.map(r => r.order_id))];
      const attachmentsByOrder: Record<string, any[]> = {};
      
      if (uniqueOrderIds.length > 0) {
        const { data: attachmentsData } = await supabase
          .from('attachments')
          .select(`
            id,
            file_url,
            file_type,
            original_filename,
            created_at,
            order_id,
            order_test_id
          `)
          .in('order_id', uniqueOrderIds)
          .order('created_at', { ascending: false });
        
        // Group attachments by order_id
        attachmentsData?.forEach(att => {
          if (!attachmentsByOrder[att.order_id]) {
            attachmentsByOrder[att.order_id] = [];
          }
          attachmentsByOrder[att.order_id].push({
            id: att.id,
            file_url: att.file_url,
            file_type: att.file_type,
            original_filename: att.original_filename,
            created_at: att.created_at,
            level: att.order_test_id ? 'test' : 'order'
          });
        });
      }

      // Add attachments to results
      const resultsWithAttachments = results.map(result => ({
        ...result,
        attachments: attachmentsByOrder[result.order_id] || []
      }));

      // Calculate stats
      const stats: VerificationStats = {
        total: resultsWithAttachments.length,
        pending: resultsWithAttachments.filter(r => r.verification_status === 'pending_verification').length,
        flagged: resultsWithAttachments.filter(r => r.flags.critical || r.flags.repeat).length,
        critical: resultsWithAttachments.filter(r => r.flags.critical).length
      };

      return { results: resultsWithAttachments, stats };

    } catch (error) {
      console.error('Error in fetchVerificationResults:', error);
      throw error;
    }
  }

  // Approve a single result
  async approveResult(resultId: string, notes?: string): Promise<boolean> {
    try {
      const { error } = await supabase
        .from('results')
        .update({
          verification_status: 'verified',
          verified_at: new Date().toISOString(),
          review_comment: notes,
          manually_verified: true
        })
        .eq('id', resultId);

      if (error) {
        console.error('Error approving result:', error);
        return false;
      }

      return true;
    } catch (error) {
      console.error('Error in approveResult:', error);
      return false;
    }
  }

  // Reject a single result
  async rejectResult(resultId: string, reason: string): Promise<boolean> {
    try {
      if (!reason.trim()) {
        throw new Error('Rejection reason is required');
      }

      const { error } = await supabase
        .from('results')
        .update({
          verification_status: 'rejected',
          review_comment: reason,
          manually_verified: true
        })
        .eq('id', resultId);

      if (error) {
        console.error('Error rejecting result:', error);
        return false;
      }

      return true;
    } catch (error) {
      console.error('Error in rejectResult:', error);
      return false;
    }
  }

  // Bulk approve results
  async bulkApproveResults(resultIds: string[], notes?: string): Promise<{
    success: boolean;
    successCount: number;
    failedIds: string[];
  }> {
    try {
      const { data, error } = await supabase
        .from('results')
        .update({
          verification_status: 'verified',
          verified_at: new Date().toISOString(),
          review_comment: notes,
          manually_verified: true
        })
        .in('id', resultIds)
        .select('id');

      if (error) {
        console.error('Error in bulk approve:', error);
        return {
          success: false,
          successCount: 0,
          failedIds: resultIds
        };
      }

      const successfulIds = (data || []).map(r => r.id);
      const failedIds = resultIds.filter(id => !successfulIds.includes(id));

      return {
        success: failedIds.length === 0,
        successCount: successfulIds.length,
        failedIds
      };

    } catch (error) {
      console.error('Error in bulkApproveResults:', error);
      return {
        success: false,
        successCount: 0,
        failedIds: resultIds
      };
    }
  }

  // Bulk reject results
  async bulkRejectResults(resultIds: string[], reason: string): Promise<{
    success: boolean;
    successCount: number;
    failedIds: string[];
  }> {
    try {
      if (!reason.trim()) {
        throw new Error('Rejection reason is required');
      }

      const { data, error } = await supabase
        .from('results')
        .update({
          verification_status: 'rejected',
          review_comment: reason,
          manually_verified: true
        })
        .in('id', resultIds)
        .select('id');

      if (error) {
        console.error('Error in bulk reject:', error);
        return {
          success: false,
          successCount: 0,
          failedIds: resultIds
        };
      }

      const successfulIds = (data || []).map(r => r.id);
      const failedIds = resultIds.filter(id => !successfulIds.includes(id));

      return {
        success: failedIds.length === 0,
        successCount: successfulIds.length,
        failedIds
      };

    } catch (error) {
      console.error('Error in bulkRejectResults:', error);
      return {
        success: false,
        successCount: 0,
        failedIds: resultIds
      };
    }
  }

  // Get previous results for delta comparison
  async getPreviousResult(patientId: string, testName: string, currentResultId: string): Promise<VerificationParameter | null> {
    try {
      const { data, error } = await supabase
        .from('results')
        .select(`
          id,
          created_at,
          result_values (
            parameter,
            value,
            unit
          )
        `)
        .eq('patient_id', patientId)
        .eq('test_name', testName)
        .neq('id', currentResultId)
        .eq('verification_status', 'verified')
        .order('created_at', { ascending: false })
        .limit(1);

      if (error || !data || data.length === 0) {
        return null;
      }

      const previousResult = data[0];
      const mainParameter = previousResult.result_values?.[0];

      if (!mainParameter) {
        return null;
      }

      return {
        name: mainParameter.parameter,
        value: mainParameter.value,
        units: mainParameter.unit,
        flag: 'normal' // Previous results are assumed normal
      };

    } catch (error) {
      console.error('Error getting previous result:', error);
      return null;
    }
  }

  // Private helper methods
  private getStatusFromFlags(result: any): 'pending' | 'normal' | 'abnormal' | 'critical' {
    if (result.critical_flag) return 'critical';
    if (result.delta_check_flag) return 'abnormal';
    return 'pending';
  }

  private transformResultValues(resultValues: any[]): VerificationParameter[] {
    return resultValues.map(rv => ({
      name: rv.parameter,
      value: rv.value,
      units: rv.unit,
      reference_range: rv.reference_range,
      flag: this.getFlagFromValue(rv.flag) as 'normal' | 'abnormal' | 'critical'
    }));
  }

  private getFlagFromValue(flag: string | null): string {
    if (!flag) return 'normal';
    const flagLower = flag.toLowerCase();
    if (flagLower.includes('critical')) return 'critical';
    if (flagLower.includes('abnormal') || flagLower.includes('high') || flagLower.includes('low')) return 'abnormal';
    return 'normal';
  }

  private extractTestGroup(testName: string): string {
    // Extract test group from test name based on common patterns
    const testName_lower = testName.toLowerCase();
    
    if (testName_lower.includes('blood group') || testName_lower.includes('rh') || testName_lower.includes('abo')) {
      return 'Blood Banking';
    }
    if (testName_lower.includes('antibody') || testName_lower.includes('crossmatch') || testName_lower.includes('screen')) {
      return 'Blood Banking';
    }
    if (testName_lower.includes('glucose') || testName_lower.includes('creatinine') || testName_lower.includes('urea')) {
      return 'Chemistry';
    }
    if (testName_lower.includes('cbc') || testName_lower.includes('hemoglobin') || testName_lower.includes('platelet')) {
      return 'Hematology';
    }
    if (testName_lower.includes('culture') || testName_lower.includes('sensitivity') || testName_lower.includes('gram')) {
      return 'Microbiology';
    }
    if (testName_lower.includes('urine') || testName_lower.includes('microscopy')) {
      return 'Clinical Pathology';
    }
    
    return 'General Tests';
  }

  private getTestCategory(testGroup: string): string {
    const categoryMap: { [key: string]: string } = {
      'Blood Banking': 'Transfusion Medicine',
      'Chemistry': 'Clinical Chemistry',
      'Hematology': 'Hematology',
      'Microbiology': 'Microbiology',
      'Clinical Pathology': 'Clinical Pathology',
      'General Tests': 'General'
    };
    
    return categoryMap[testGroup] || 'General';
  }
}

export const verificationService = new VerificationService();
export default verificationService;