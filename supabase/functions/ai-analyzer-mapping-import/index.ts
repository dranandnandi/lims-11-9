/**
 * ai-analyzer-mapping-import
 *
 * Reads an analyzer mapping image, or a raw analyzer message/code list pasted as
 * plain text, and proposes result-code mappings for the analytes attached to one
 * test group and one connected analyzer.
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const CLAUDE_HAIKU_MODEL = 'claude-haiku-4-5-20251001'
const CLAUDE_SONNET_FALLBACK_MODEL = 'claude-sonnet-4-5-20250929'

interface IncomingAnalyte {
  analyte_id: string
  lab_analyte_id: string
  name: string
  lims_code?: string
  unit?: string
}

interface AiSuggestion {
  lab_analyte_id: string
  analyte_id?: string
  analyte_name: string
  analyzer_code: string
  analyzer_display?: string
  confidence: number
  rationale?: string
  source_text?: string
}

function buildPrompt(params: {
  testGroupName: string
  analyzerName: string
  analytes: IncomingAnalyte[]
  textContent?: string
}): string {
  const compactAnalytes = params.analytes.map((analyte) => ({
    la: analyte.lab_analyte_id,
    a: analyte.analyte_id,
    n: analyte.name,
    c: analyte.lims_code || '',
    u: analyte.unit || '',
  }))

  const sourceInstruction = params.textContent
    ? `Read the analyzer text below. It may be a raw instrument message (ASTM/HL7/LIS frames), a plain code list, a copy-pasted analyzer software screen, or free-form notes. Extract analyzer result codes only, then match them to the attached LIMS analytes below.

--- ANALYZER TEXT START ---
${params.textContent}
--- ANALYZER TEXT END ---`
    : 'Read the attached analyzer mapping/code image. Extract analyzer result codes only, then match them to the attached LIMS analytes below.'

  return `You are configuring a laboratory LIMS analyzer interface.

${sourceInstruction}

Test group: ${params.testGroupName || 'Unknown'}
Connected analyzer: ${params.analyzerName || 'Unknown'}

Attached analytes (la=lab_analyte_id, a=analyte_id, n=name, c=LIMS code, u=unit):
${JSON.stringify(compactAnalytes)}

Return ONLY JSON with this exact shape:
{
  "suggestions": [
    {
      "lab_analyte_id": "<la>",
      "analyte_id": "<a>",
      "analyte_name": "Hemoglobin",
      "analyzer_code": "HGB",
      "analyzer_display": "HGB",
      "confidence": 0.95,
      "rationale": "Image row HGB aligns with Hemoglobin",
      "source_text": "HGB Hemoglobin"
    }
  ],
  "unmatched_codes": [
    { "analyzer_code": "XYZ", "source_text": "XYZ Unknown" }
  ],
  "notes": "string or null"
}

Rules:
- Do not invent analyzer codes. Use only codes present in the ${params.textContent ? 'analyzer text' : 'image'}.
- Match only to analytes listed above. Never create new analytes.
- Analyzer codes are often short tokens such as HGB, WBC, PLT, GLU, CREA, ALT.
- In raw ASTM/HL7 result frames the analyzer code is the test identifier field (for example the R|1|^^^HGB| segment or an OBX-3 identifier), not the result value.
- Ignore prices, ranges, units, patient values, flags, timestamps, sample IDs, and calibration text unless they help identify the code row.
- If multiple visible codes could match one analyte, choose the strongest and lower confidence.
- Include suggestions only when confidence is at least 0.60.
- Keep analyzer_code exactly as shown, preserving punctuation/case where meaningful.`
}

async function callAnthropic(params: {
  fileBase64?: string
  mimeType?: string
  prompt: string
  apiKey: string
  model: string
}): Promise<Record<string, unknown>> {
  const content: Array<Record<string, unknown>> = []
  if (params.fileBase64 && params.mimeType) {
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: params.mimeType,
        data: params.fileBase64,
      },
    })
  }
  content.push({ type: 'text', text: params.prompt })

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': params.apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: params.model,
      max_tokens: 4096,
      temperature: 0,
      messages: [{ role: 'user', content }],
    }),
  })

  if (!resp.ok) {
    const errText = await resp.text()
    throw new Error(`Anthropic ${params.model} error ${resp.status}: ${errText}`)
  }

  const data = await resp.json()
  const text = String(data?.content?.[0]?.text ?? '').trim()
  if (!text) throw new Error('Anthropic returned empty response')

  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const objMatch = cleaned.match(/\{[\s\S]*\}/)
  if (!objMatch) {
    console.error('[ai-analyzer-mapping-import] raw response:', text.slice(0, 1000))
    throw new Error('Could not extract JSON from Anthropic response')
  }

  try {
    return JSON.parse(objMatch[0]) as Record<string, unknown>
  } catch (err) {
    console.error('[ai-analyzer-mapping-import] JSON parse failed:', objMatch[0].slice(0, 1500))
    throw new Error(`Anthropic JSON parse failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function normalizeSuggestions(raw: Record<string, unknown>, analytes: IncomingAnalyte[]): AiSuggestion[] {
  const byLabAnalyteId = new Map(analytes.map((analyte) => [analyte.lab_analyte_id, analyte]))
  const seen = new Set<string>()
  const rows = Array.isArray(raw.suggestions) ? raw.suggestions as Array<Record<string, unknown>> : []
  const suggestions: AiSuggestion[] = []

  for (const row of rows) {
    const labAnalyteId = String(row.lab_analyte_id ?? '')
    const analyzerCode = String(row.analyzer_code ?? '').trim()
    const analyte = byLabAnalyteId.get(labAnalyteId)
    const confidence = Number(row.confidence ?? 0)
    if (!analyte || !analyzerCode || confidence < 0.6) continue
    if (seen.has(labAnalyteId)) continue
    seen.add(labAnalyteId)
    suggestions.push({
      lab_analyte_id: labAnalyteId,
      analyte_id: analyte.analyte_id,
      analyte_name: analyte.name,
      analyzer_code: analyzerCode,
      analyzer_display: String(row.analyzer_display ?? analyzerCode).trim() || analyzerCode,
      confidence: Math.max(0, Math.min(1, confidence)),
      rationale: row.rationale ? String(row.rationale) : undefined,
      source_text: row.source_text ? String(row.source_text) : undefined,
    })
  }

  return suggestions.sort((a, b) => b.confidence - a.confidence)
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  try {
    const anthropicApiKey = Deno.env.get('ANTHROPIC_API_KEY')
    if (!anthropicApiKey) {
      return new Response(JSON.stringify({ error: 'Anthropic API key not configured' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const body = await req.json()
    const {
      file_base64,
      file_mime_type,
      text_content,
      test_group,
      analyzer_connection,
      analytes,
    } = body

    const pastedText = typeof text_content === 'string' ? text_content.trim() : ''

    if (!pastedText && (!file_base64 || !file_mime_type)) {
      return new Response(
        JSON.stringify({ error: 'Provide text_content, or file_base64 with file_mime_type' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    if (pastedText && pastedText.length > 200_000) {
      return new Response(JSON.stringify({ error: 'Analyzer text must be under 200,000 characters' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    if (!pastedText) {
      const approximateBytes = Math.ceil(String(file_base64).length * 0.75)
      if (approximateBytes > 20 * 1024 * 1024) {
        return new Response(JSON.stringify({ error: 'File size must be under 20 MB' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }

      const supportedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']
      if (!supportedTypes.includes(file_mime_type)) {
        return new Response(JSON.stringify({ error: `Unsupported file type: ${file_mime_type}` }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }
    }

    const attachedAnalytes = Array.isArray(analytes)
      ? (analytes as IncomingAnalyte[]).filter((analyte) => analyte.lab_analyte_id && analyte.name)
      : []

    if (attachedAnalytes.length === 0) {
      return new Response(JSON.stringify({ error: 'At least one attached lab analyte is required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const prompt = buildPrompt({
      testGroupName: String(test_group?.name ?? ''),
      analyzerName: String(analyzer_connection?.name ?? ''),
      analytes: attachedAnalytes,
      textContent: pastedText || undefined,
    })

    const preferredModel = Deno.env.get('ANTHROPIC_ANALYZER_MAPPING_MODEL') || CLAUDE_HAIKU_MODEL
    const imagePayload = pastedText
      ? {}
      : { fileBase64: file_base64 as string, mimeType: file_mime_type as string }
    let raw: Record<string, unknown>
    let modelUsed = preferredModel

    try {
      raw = await callAnthropic({
        ...imagePayload,
        prompt,
        apiKey: anthropicApiKey,
        model: preferredModel,
      })
    } catch (err) {
      if (preferredModel === CLAUDE_SONNET_FALLBACK_MODEL) throw err
      console.warn('[ai-analyzer-mapping-import] Haiku failed, retrying Sonnet:', err)
      modelUsed = CLAUDE_SONNET_FALLBACK_MODEL
      raw = await callAnthropic({
        ...imagePayload,
        prompt,
        apiKey: anthropicApiKey,
        model: CLAUDE_SONNET_FALLBACK_MODEL,
      })
    }

    return new Response(JSON.stringify({
      suggestions: normalizeSuggestions(raw, attachedAnalytes),
      unmatched_codes: Array.isArray(raw.unmatched_codes) ? raw.unmatched_codes : [],
      notes: raw.notes ?? null,
      model_used: modelUsed,
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    console.error('[ai-analyzer-mapping-import] Error:', err)
    return new Response(
      JSON.stringify({ error: 'Analyzer mapping import failed', message: err instanceof Error ? err.message : String(err) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  }
})
