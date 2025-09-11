import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface TestConfigurationRequest {
  testName: string;
  description?: string;
  labContext?: string;
  existingTests?: string[];
}

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // Verify authentication
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      throw new Error('No authorization header')
    }

    // Initialize Supabase client
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      {
        global: {
          headers: { Authorization: authHeader },
        },
      }
    )

    // Verify user authentication
    const { data: { user }, error: authError } = await supabaseClient.auth.getUser()
    if (authError || !user) {
      throw new Error('Invalid authentication')
    }

    // Get user's lab_id for context
    const { data: userData } = await supabaseClient
      .from('users')
      .select('lab_id, role')
      .eq('id', user.id)
      .single()

    // Parse request body
    const { testName, description, labContext, existingTests }: TestConfigurationRequest = await req.json()

    if (!testName?.trim()) {
      throw new Error('Test name is required')
    }

    // Get AI prompt from database with fallbacks
    const { data: promptData } = await supabaseClient.rpc('resolve_ai_prompt', {
      p_processing_type: 'test_suggestion',
      p_test_id: null,
      p_analyte_id: null,
      p_lab_id: userData?.lab_id || null
    })

    // Always use the updated default prompt for now to ensure consistency
    const systemPrompt = getDefaultTestConfigurationPrompt()

    // Build the complete prompt
    const fullPrompt = `${systemPrompt}

${existingTests ? `EXISTING TESTS TO AVOID DUPLICATING: ${existingTests.join(', ')}` : ''}

TEST TO ANALYZE: ${testName}
${description ? `DESCRIPTION: ${description}` : ''}
LAB CONTEXT: ${labContext || `User: ${user.email}, Lab: ${userData?.lab_id || 'Default'}`}

Return ONLY valid JSON with no additional text.`

    // Call Gemini API
    const geminiApiKey = Deno.env.get('ALLGOOGLE_KEY')
    if (!geminiApiKey) {
      throw new Error('Gemini API key not configured')
    }

    const geminiResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiApiKey}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: fullPrompt
                }
              ]
            }
          ],
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 2048,
            responseMimeType: "application/json"
          }
        })
      }
    )

    if (!geminiResponse.ok) {
      const errorText = await geminiResponse.text()
      throw new Error(`Gemini API error: ${errorText}`)
    }

    const geminiData = await geminiResponse.json()
    
    if (!geminiData.candidates?.[0]?.content?.parts?.[0]?.text) {
      throw new Error('Invalid response format from Gemini API')
    }

    const responseText = geminiData.candidates[0].content.parts[0].text
    let parsedResponse

    try {
      parsedResponse = JSON.parse(responseText)
    } catch (parseError) {
      throw new Error(`Failed to parse AI response: ${parseError}`)
    }

    // Log usage for analytics (optional)
    await supabaseClient
      .from('ai_usage_logs')
      .insert({
        user_id: user.id,
        lab_id: userData?.lab_id,
        processing_type: 'test_suggestion',
        input_data: { testName, description },
        confidence: parsedResponse.confidence || 0,
        created_at: new Date().toISOString()
      })

    return new Response(
      JSON.stringify({
        success: true,
        data: parsedResponse
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      },
    )

  } catch (error) {
    console.error('Error in AI test configurator:', error)
    
    return new Response(
      JSON.stringify({
        success: false,
        error: error.message
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 400,
      },
    )
  }
})

function getDefaultTestConfigurationPrompt(): string {
  return `You are a medical laboratory AI assistant. Given a test name, suggest a complete test group configuration with analytes that matches the database schema.

REQUIREMENTS:
1. Return valid JSON matching this exact interface:
{
  "test_group": {
    "name": "string",
    "code": "string (unique 3-8 char code)",
    "category": "string",
    "clinical_purpose": "string",
    "price": "string (decimal format like '45.00')",
    "turnaround_time": "string (e.g., '24 hours', '2-3 days')",
    "sample_type": "string",
    "requires_fasting": boolean,
    "is_active": true,
    "default_ai_processing_type": "gemini",
    "group_level_prompt": null,
    "to_be_copied": false
  },
  "analytes": [{
    "name": "string",
    "unit": "string",
    "reference_range": "string (e.g., '3.5-5.0')",
    "low_critical": "string or null",
    "high_critical": "string or null", 
    "interpretation_low": "string",
    "interpretation_normal": "string",
    "interpretation_high": "string",
    "category": "string",
    "is_active": true,
    "ai_processing_type": "gemini",
    "ai_prompt_override": null,
    "group_ai_mode": "individual",
    "is_global": false,
    "to_be_copied": false
  }],
  "test_group_analytes": [{
    "test_group_code": "string (matches test_group.code)",
    "analyte_name": "string (matches analyte.name)"
  }],
  "confidence": number,
  "reasoning": "string"
}

2. Use medically accurate reference ranges and units
3. Provide realistic prices in decimal format ($15.00-$500.00)
4. Include relevant analytes for the test type
5. Always include confidence score (0-1) and reasoning
6. Generate unique, meaningful codes for test groups (3-8 characters)
7. Create test_group_analytes mapping for each analyte

CONTEXT:
- This is for a clinical laboratory information system
- Test names may be abbreviated or colloquial
- Base suggestions on standard medical laboratory practices
- Ensure all analytes have proper clinical interpretations`
}
