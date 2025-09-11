/**
 * Secure Gemini AI Integration for LIMS System
 * Uses Supabase Edge Functions to keep API keys secure
 */

import { supabase } from './supabase';

export interface TestConfigurationRequest {
  testName: string;
  description?: string;
  labContext?: string;
  existingTests?: string[]; // For avoiding duplicates
}

export interface TestConfigurationResponse {
  test_group: {
    name: string;
    code: string;
    category: string;
    clinical_purpose: string;
    price: string;
    turnaround_time: string;
    sample_type: string;
    requires_fasting: boolean;
    is_active: boolean;
    default_ai_processing_type: string;
    group_level_prompt: string | null;
    to_be_copied: boolean;
  };
  analytes: Array<{
    name: string;
    unit: string;
    reference_range: string;
    low_critical: string | null;
    high_critical: string | null;
    interpretation_low: string;
    interpretation_normal: string;
    interpretation_high: string;
    category: string;
    is_active: boolean;
    ai_processing_type: string;
    ai_prompt_override: string | null;
    group_ai_mode: string;
    is_global: boolean;
    to_be_copied: boolean;
  }>;
  test_group_analytes: Array<{
    test_group_code: string;
    analyte_name: string;
  }>;
  confidence: number;
  reasoning: string;
  inserted?: boolean;
}

export interface DocumentAnalysisRequest {
  documentType: 'pdf' | 'image' | 'color_card';
  content: string; // Base64 or text content
  testContext?: {
    testId: string;
    analyteIds?: string[];
    expectedFormat?: string;
  };
  customPrompt?: string;
}

export interface DocumentAnalysisResponse {
  extractedData: Record<string, any>;
  confidence: number;
  processingType: string;
  suggestions?: string[];
  errors?: string[];
}

class SecureGeminiAIService {
  /**
   * Generate test configuration suggestions using secure Edge Function
   */
  async suggestTestConfiguration(request: TestConfigurationRequest): Promise<TestConfigurationResponse> {
    try {
      const { data, error } = await supabase.functions.invoke('ai-test-configurator', {
        body: request
      });

      if (error) {
        throw new Error(`Edge function error: ${error.message}`);
      }

      if (!data.success) {
        throw new Error(data.error || 'Unknown error from AI service');
      }

      return data.data as TestConfigurationResponse;
    } catch (error) {
      console.error('Error in suggestTestConfiguration:', error);
      throw new Error(`Failed to generate test configuration: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Analyze document content using secure Edge Function
   */
  async analyzeDocument(request: DocumentAnalysisRequest): Promise<DocumentAnalysisResponse> {
    try {
      const { data, error } = await supabase.functions.invoke('ai-document-processor', {
        body: request
      });

      if (error) {
        throw new Error(`Edge function error: ${error.message}`);
      }

      if (!data.success) {
        throw new Error(data.error || 'Unknown error from AI service');
      }

      return data.data as DocumentAnalysisResponse;
    } catch (error) {
      console.error('Error in analyzeDocument:', error);
      throw new Error(`Failed to analyze document: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Check if AI services are available
   */
  async checkAvailability(): Promise<{ available: boolean; message?: string }> {
    try {
      // Test with a simple request
      const testRequest = {
        testName: 'Test Connectivity',
        description: 'Connection test'
      };

      await this.suggestTestConfiguration(testRequest);
      return { available: true };
    } catch (error) {
      return { 
        available: false, 
        message: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Generate test configuration with options
   */
  async generateTestConfiguration(
    testName: string,
    options?: {
      description?: string;
      sampleType?: string;
      requiresFasting?: boolean;
      existingTests?: string[];
      labContext?: string;
      insert?: boolean;
    }
  ): Promise<TestConfigurationResponse> {
    try {
      const { data, error } = await supabase.functions.invoke('ai-test-configurator', {
        body: {
          testName,
          description: options?.description,
          sampleType: options?.sampleType,
          requiresFasting: options?.requiresFasting,
          existingTests: options?.existingTests || [],
          labContext: options?.labContext,
          insert: options?.insert || false
        }
      });

      if (error) {
        console.error('Edge Function error:', error);
        throw new Error(`Edge Function failed: ${error.message || 'Unknown error'}`);
      }

      if (!data) {
        throw new Error('No data returned from Edge Function');
      }

      if (!data.success) {
        throw new Error(data.error || 'Edge Function returned unsuccessful response');
      }
      
      // Transform response if needed (handle legacy format)
      const result = this.transformResponse(data.data);
      result.inserted = data.inserted || false;
      
      return result;
    } catch (err) {
      console.error('Failed to generate test configuration:', err);
      throw err;
    }
  }

  /**
   * Transform response to handle legacy format from Gemini
   */
  private transformResponse(response: any): TestConfigurationResponse {
    // If response already has the correct format, return as-is
    if (response.test_group) {
      return response as TestConfigurationResponse;
    }

    // Handle legacy format: testGroup -> test_group
    if (response.testGroup) {
      const transformed: TestConfigurationResponse = {
        test_group: {
          name: response.testGroup.name || '',
          code: this.generateTestCode(response.testGroup.name || ''),
          category: response.testGroup.category || '',
          clinical_purpose: response.testGroup.description || '',
          price: response.testGroup.price?.toString() || '0',
          turnaround_time: response.testGroup.tat_hours ? `${response.testGroup.tat_hours} hours` : '24 hours',
          sample_type: response.testGroup.sample_type || 'Serum',
          requires_fasting: response.testGroup.requires_fasting || false,
          is_active: true,
          default_ai_processing_type: 'gemini',
          group_level_prompt: null,
          to_be_copied: false
        },
        analytes: (response.analytes || []).map((analyte: any) => ({
          name: analyte.name || '',
          unit: analyte.unit || '',
          reference_range: this.formatReferenceRange(analyte.reference_min, analyte.reference_max),
          low_critical: analyte.critical_min?.toString() || null,
          high_critical: analyte.critical_max?.toString() || null,
          interpretation_low: `Low ${analyte.name || 'value'} may indicate underlying condition`,
          interpretation_normal: `Normal ${analyte.name || 'value'} indicates healthy status`,
          interpretation_high: `High ${analyte.name || 'value'} may indicate inflammation or disease`,
          category: response.testGroup.category || 'General',
          is_active: true,
          ai_processing_type: 'gemini',
          ai_prompt_override: null,
          group_ai_mode: 'individual',
          is_global: false,
          to_be_copied: false
        })),
        test_group_analytes: (response.analytes || []).map((analyte: any) => ({
          test_group_code: this.generateTestCode(response.testGroup.name || ''),
          analyte_name: analyte.name || ''
        })),
        confidence: response.confidence || 0.95,
        reasoning: response.reasoning || 'Generated based on standard medical laboratory practices'
      };

      return transformed;
    }

    // Fallback: return response as-is and hope for the best
    return response as TestConfigurationResponse;
  }

  /**
   * Generate a test code from test name
   */
  private generateTestCode(name: string): string {
    return name
      .replace(/[^a-zA-Z\s]/g, '') // Remove non-letters
      .split(' ')
      .filter(word => word.length > 0)
      .map(word => word.charAt(0).toUpperCase())
      .join('')
      .substring(0, 6) || 'TEST';
  }

  /**
   * Format reference range from min/max values
   */
  private formatReferenceRange(min: any, max: any): string {
    if (min !== null && max !== null) {
      return `${min}-${max}`;
    }
    if (max !== null) {
      return `< ${max}`;
    }
    if (min !== null) {
      return `> ${min}`;
    }
    return 'See lab reference';
  }
}

// Export the secure service instance
export const geminiAI = new SecureGeminiAIService();
export { SecureGeminiAIService as GeminiAIService };

// Export the generateTestConfiguration function directly for easier use
export const generateTestConfiguration = geminiAI.generateTestConfiguration.bind(geminiAI);
