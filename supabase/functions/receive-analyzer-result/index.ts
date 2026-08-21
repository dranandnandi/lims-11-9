// AI Result Receiver - Enhanced version with ACK handling and intelligent result storage
// Webhook endpoint for analyzer_raw_messages table inserts
// Handles: ORU (Results), ACK (Acknowledgments), NAK (Rejections)

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { GoogleGenerativeAI } from 'npm:@google/generative-ai'
import {
  buildRangeContext,
  resolveReferenceRange,
  type ReferenceRangeRule,
} from '../_shared/referenceRangeResolver.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Parse HL7 message type from MSH segment
function parseMessageType(rawContent: string): { type: string; controlId: string } {
  // Positional MSH parse. Some analyzers (e.g. Peerless HA560) emit malformed MSH
  // headers with shifted fields, so fall back to scanning MSH fields for a
  // message-type-shaped token (ORU^R01, ORM^O01, ACK, ...).
  const mshSegment = rawContent.split(/\r|\n/).find((s) => s.trim().startsWith('MSH'))
  if (mshSegment) {
    const fields = mshSegment.split('|')
    const typePattern = /^(OR[UMR]|ACK|NAK|QRY|QCK|ORR|OUL)(\^[A-Z0-9]+)?$/i
    const typeIndex = fields.findIndex((f) => typePattern.test(f.trim()))
    if (typeIndex !== -1) {
      return {
        type: fields[typeIndex].trim().toUpperCase(),
        controlId: fields[typeIndex + 1]?.trim() || ''
      }
    }
    return { type: 'UNKNOWN', controlId: '' }
  }

  // Try ASTM format
  if (rawContent.includes('H|') || rawContent.startsWith('1H')) {
    return { type: 'ASTM_RESULT', controlId: '' }
  }

  return { type: 'UNKNOWN', controlId: '' }
}

function normalizeAnalyzerFlag(value: unknown): string {
  const flag = String(value ?? '').trim().replace(/^["']+|["']+$/g, '')
  if (!flag) return 'N'

  const components = flag
    .split(/[~\\]/)
    .map((component) => component.trim().replace(/^["']+|["']+$/g, '').toUpperCase())
    .filter(Boolean)
  return components.find((component) => ['LL', 'HH', 'L', 'H', 'A', 'N'].includes(component))
    || 'N'
}

// --- Flag computed from the lab's SAVED reference range (never the machine's) ---
// Mirrors process-analyzer-result's computeSavedFlag. Output vocabulary matches
// the HL7 flags this path already stores: 'N','H','L','HH','LL','A'. flag_source
// is constrained, so computed flags are 'auto_numeric' / 'auto_text'.

const SAVED_NORMAL_TEXT = [
  /^negative$/i, /^non[\s-]?reactive$/i, /^normal$/i, /^nil$/i, /^absent$/i,
  /^not[\s-]?detected$/i, /^nd$/i, /^none[\s-]?seen$/i, /^within[\s-]?normal[\s-]?limits$/i,
  /^wnl$/i, /^clear$/i, /^no[\s-]?growth$/i, /^sterile$/i, /^unremarkable$/i,
]
const SAVED_ABNORMAL_TEXT = [
  /^positive$/i, /^reactive$/i, /^detected$/i, /^present$/i, /^abnormal$/i, /^growth$/i,
]

function extractNumericValue(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const cleaned = String(value).replace(/,/g, '').replace(/[<>≤≥]/g, '').trim()
  const match = cleaned.match(/^-?\d*\.?\d+/)
  if (!match) return null
  const num = parseFloat(match[0])
  return Number.isNaN(num) ? null : num
}

function parseSavedReferenceRange(refRange: string | null | undefined): {
  low: number | null; high: number | null; type: 'range' | 'less_than' | 'greater_than' | 'single' | 'none'
} {
  if (!refRange || typeof refRange !== 'string') return { low: null, high: null, type: 'none' }
  const cleaned = refRange
    .replace(/\([^)]*\)/g, '')
    .replace(/[a-zA-Z%\/]+/g, ' ')
    .replace(/,/g, '')
    .trim()
  const lt = cleaned.match(/[<≤]\s*([\d.]+)/)
  if (lt) return { low: null, high: parseFloat(lt[1]), type: 'less_than' }
  const gt = cleaned.match(/[>≥]\s*([\d.]+)/)
  if (gt) return { low: parseFloat(gt[1]), high: null, type: 'greater_than' }
  const rng = cleaned.match(/([\d.]+)\s*[-–—~]+\s*([\d.]+)/)
  if (rng) {
    const a = parseFloat(rng[1]), b = parseFloat(rng[2])
    return { low: Math.min(a, b), high: Math.max(a, b), type: 'range' }
  }
  const single = cleaned.match(/^([\d.]+)$/)
  if (single) return { low: null, high: parseFloat(single[1]), type: 'single' }
  return { low: null, high: null, type: 'none' }
}

function computeSavedFlag(
  value: unknown,
  refRange: string | null | undefined,
  opts: {
    lowCritical?: string | number | null
    highCritical?: string | number | null
    expectedNormalValues?: unknown
    valueType?: string | null
  } = {},
): { flag: string; source: 'auto_numeric' | 'auto_text' } {
  const raw = String(value ?? '').trim()
  if (!raw) return { flag: 'N', source: 'auto_numeric' }

  const num = extractNumericValue(raw)
  const isQualitativeType = opts.valueType === 'qualitative'

  if (num !== null && !isQualitativeType) {
    const highCrit = extractNumericValue(opts.highCritical ?? null)
    const lowCrit = extractNumericValue(opts.lowCritical ?? null)
    if (highCrit !== null && num >= highCrit) return { flag: 'HH', source: 'auto_numeric' }
    if (lowCrit !== null && num < lowCrit) return { flag: 'LL', source: 'auto_numeric' }

    const { low, high, type } = parseSavedReferenceRange(refRange)
    if (type === 'range' && low !== null && high !== null) {
      if (num < low) return { flag: 'L', source: 'auto_numeric' }
      if (num > high) return { flag: 'H', source: 'auto_numeric' }
      return { flag: 'N', source: 'auto_numeric' }
    }
    if ((type === 'less_than' || type === 'single') && high !== null) {
      return { flag: num > high ? 'H' : 'N', source: 'auto_numeric' }
    }
    if (type === 'greater_than' && low !== null) {
      return { flag: num < low ? 'L' : 'N', source: 'auto_numeric' }
    }
    return { flag: 'N', source: 'auto_numeric' }
  }

  const lower = raw.toLowerCase()
  const expected = Array.isArray(opts.expectedNormalValues)
    ? opts.expectedNormalValues.map((v) => String(v).toLowerCase().trim()).filter(Boolean)
    : []
  if (expected.length > 0) {
    return { flag: expected.includes(lower) ? 'N' : 'A', source: 'auto_text' }
  }
  const refLower = String(refRange ?? '').toLowerCase().trim()
  if (refLower) {
    const refIsText = SAVED_NORMAL_TEXT.some((p) => p.test(refLower)) || SAVED_ABNORMAL_TEXT.some((p) => p.test(refLower))
    if (refIsText) return { flag: lower === refLower ? 'N' : 'A', source: 'auto_text' }
  }
  if (SAVED_NORMAL_TEXT.some((p) => p.test(lower))) return { flag: 'N', source: 'auto_text' }
  if (SAVED_ABNORMAL_TEXT.some((p) => p.test(lower))) return { flag: 'A', source: 'auto_text' }
  return { flag: 'N', source: 'auto_text' }
}

function normalizeAnalyzerValue(value: unknown): string | null {
  const normalized = String(value ?? '').trim()
  if (!normalized) return null

  const unquoted = normalized.replace(/^["']+|["']+$/g, '').trim()
  if (!unquoted) return null

  const placeholder = unquoted.toUpperCase()
  if (['NULL', 'N/A', 'NA', 'NIL', '*****', '****', '***'].includes(placeholder)) {
    return null
  }

  return unquoted
}

function logAiRefRange(event: string, details: Record<string, unknown> = {}) {
  console.log(`[interface-ai-ref-range] ${event} ${JSON.stringify(details)}`)
}

function normalizeAnalyteName(value: unknown): string {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

function matchResolvedRange(candidate: {
  analyte_id: string
  lab_analyte_id?: string | null
  analyte_name: string
}, results: any[]): { result: any; matchType: string } | null {
  let result = candidate.lab_analyte_id
    ? results.find((item) => item?.lab_analyte_id === candidate.lab_analyte_id)
    : null
  if (result) return { result, matchType: 'exact_lab_analyte_id' }

  result = results.find((item) => item?.analyte_id === candidate.analyte_id)
  if (result) return { result, matchType: 'exact_id' }

  result = results.find((item) => item?.analyte_name === candidate.analyte_name)
  if (result) return { result, matchType: 'exact_name' }

  const candidateName = normalizeAnalyteName(candidate.analyte_name)
  if (candidateName) {
    result = results.find((item) => {
      const resultName = normalizeAnalyteName(item?.analyte_name)
      return resultName && (candidateName.includes(resultName) || resultName.includes(candidateName))
    })
    if (result) return { result, matchType: 'fuzzy_name' }
  }

  if (results.length === 1) return { result: results[0], matchType: 'single_result' }
  return null
}

function resolvedRangeKey(testGroupId: string, candidate: { analyte_id: string; lab_analyte_id?: string | null }): string {
  return `${testGroupId}:${candidate.lab_analyte_id || candidate.analyte_id}`
}

async function resolveAiReferenceRanges(
  orderId: string,
  candidates: Array<{
    analyte_id: string
    lab_analyte_id: string | null
    analyte_name: string
    value: string
    unit: string
    test_group_id: string | null
  }>,
): Promise<Map<string, any>> {
  const resolvedByKey = new Map<string, any>()
  const grouped = new Map<string, typeof candidates>()

  for (const candidate of candidates) {
    if (!candidate.test_group_id) continue
    const group = grouped.get(candidate.test_group_id) ?? []
    group.push(candidate)
    grouped.set(candidate.test_group_id, group)
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (grouped.size === 0) {
    logAiRefRange('resolver_skipped_no_candidates', { order_id: orderId, processor: 'fallback' })
    return resolvedByKey
  }
  if (!supabaseUrl || !serviceRoleKey) {
    logAiRefRange('resolver_skipped_missing_credentials', {
      order_id: orderId,
      processor: 'fallback',
      test_group_count: grouped.size,
    })
    return resolvedByKey
  }

  logAiRefRange('resolver_started', {
    order_id: orderId,
    processor: 'fallback',
    test_group_count: grouped.size,
    analyte_count: candidates.length,
  })

  for (const [testGroupId, groupCandidates] of grouped) {
    try {
      const startedAt = Date.now()
      logAiRefRange('group_request_started', {
        order_id: orderId,
        processor: 'fallback',
        test_group_id: testGroupId,
        analyte_count: groupCandidates.length,
        analyte_ids: groupCandidates.map((candidate) => candidate.analyte_id),
      })

      const response = await fetch(`${supabaseUrl}/functions/v1/resolve-reference-ranges`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${serviceRoleKey}`,
          'x-internal-service-key': serviceRoleKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          orderId,
          testGroupId,
          analytes: groupCandidates.map((candidate) => ({
            id: candidate.analyte_id,
            lab_analyte_id: candidate.lab_analyte_id,
            name: candidate.analyte_name,
            value: candidate.value,
            unit: candidate.unit,
          })),
        }),
      })

      if (!response.ok) {
        const responseText = await response.text().catch(() => '')
        logAiRefRange('group_request_failed', {
          order_id: orderId,
          processor: 'fallback',
          test_group_id: testGroupId,
          status: response.status,
          duration_ms: Date.now() - startedAt,
          response: responseText.slice(0, 500),
        })
        continue
      }
      const payload = await response.json()
      if (!payload?.success || !Array.isArray(payload.results)) {
        logAiRefRange('group_response_invalid', {
          order_id: orderId,
          processor: 'fallback',
          test_group_id: testGroupId,
          duration_ms: Date.now() - startedAt,
          error: payload?.error || 'Missing results array',
        })
        continue
      }

      const unmatchedCandidates: Array<{ analyte_id: string; analyte_name: string }> = []
      for (const candidate of groupCandidates) {
        const match = matchResolvedRange(candidate, payload.results)
        if (match) {
          resolvedByKey.set(resolvedRangeKey(testGroupId, candidate), match.result)
          logAiRefRange('analyte_response_matched', {
            order_id: orderId,
            processor: 'fallback',
            test_group_id: testGroupId,
            requested_analyte_id: candidate.analyte_id,
            requested_analyte_name: candidate.analyte_name,
            returned_analyte_id: match.result?.analyte_id || null,
            returned_analyte_name: match.result?.analyte_name || null,
            match_type: match.matchType,
          })
        } else {
          unmatchedCandidates.push({
            analyte_id: candidate.analyte_id,
            analyte_name: candidate.analyte_name,
          })
        }
      }

      logAiRefRange('group_request_completed', {
        order_id: orderId,
        processor: 'fallback',
        test_group_id: testGroupId,
        requested_count: groupCandidates.length,
        returned_count: payload.results.length,
        matched_count: groupCandidates.length - unmatchedCandidates.length,
        unmatched_candidates: unmatchedCandidates,
        returned_results: payload.results.map((result: any) => ({
          analyte_id: result?.analyte_id || null,
          analyte_name: result?.analyte_name || null,
          used_reference_range: result?.used_reference_range || null,
        })),
        duration_ms: Date.now() - startedAt,
      })
    } catch (error) {
      logAiRefRange('group_request_exception', {
        order_id: orderId,
        processor: 'fallback',
        test_group_id: testGroupId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  logAiRefRange('resolver_completed', {
    order_id: orderId,
    processor: 'fallback',
    resolved_count: resolvedByKey.size,
  })
  return resolvedByKey
}

// Handle ACK/NAK messages - update order queue status
async function handleAcknowledgment(
  supabase: any, 
  messageType: string, 
  controlId: string, 
  rawContent: string,
  labId: string
): Promise<{ handled: boolean; message: string }> {
  
  if (!controlId) {
    return { handled: false, message: 'No control ID for ACK correlation' }
  }

  // Find the original order in queue
  const { data: queueEntry, error } = await supabase
    .from('analyzer_order_queue')
    .select('*')
    .eq('message_control_id', controlId)
    .eq('lab_id', labId)
    .single()

  if (error || !queueEntry) {
    return { handled: false, message: `No matching order found for control ID: ${controlId}` }
  }

  const isPositiveAck = messageType.includes('ACK') || 
                        rawContent.includes('AA') ||  // Application Accept
                        rawContent.includes('CA')     // Commit Accept

  const newStatus = isPositiveAck ? 'acknowledged' : 'rejected'
  const errorMsg = isPositiveAck ? null : extractAckError(rawContent)

  await supabase
    .from('analyzer_order_queue')
    .update({
      status: newStatus,
      ack_received_at: new Date().toISOString(),
      last_error: errorMsg
    })
    .eq('id', queueEntry.id)

  // Log communication
  await supabase
    .from('analyzer_comm_log')
    .insert({
      lab_id: labId,
      analyzer_connection_id: queueEntry.analyzer_connection_id,
      direction: 'RECEIVE',
      message_type: messageType,
      message_control_id: controlId,
      message_preview: rawContent.slice(0, 500),
      message_size: rawContent.length,
      success: isPositiveAck,
      error_message: errorMsg,
      order_id: queueEntry.order_id,
      queue_id: queueEntry.id
    })

  return { 
    handled: true, 
    message: `${messageType} processed: Order ${queueEntry.order_id} marked as ${newStatus}` 
  }
}

// Extract error message from NAK
function extractAckError(rawContent: string): string | null {
  // Look for ERR segment
  const errMatch = rawContent.match(/ERR\|[^|]*\|[^|]*\|[^|]*\|([^|]*)/i)
  if (errMatch) return errMatch[1]
  
  // Look for MSA segment error code
  const msaMatch = rawContent.match(/MSA\|([^|]*)\|[^|]*\|([^|]*)/i)
  if (msaMatch && msaMatch[2]) return msaMatch[2]
  
  return null
}

// Extract sample barcode from various message formats
function extractBarcode(rawContent: string): string | null {
  // HL7: OBR segment field 3 or 20
  const obrMatch = rawContent.match(/OBR\|[^|]*\|([^|]*)\|([^|]*)/i)
  if (obrMatch && obrMatch[1]) return obrMatch[1].split('^')[0]
  
  // HL7: PID segment field 3
  const pidMatch = rawContent.match(/PID\|[^|]*\|[^|]*\|([^|]*)/i)
  if (pidMatch && pidMatch[1]) return pidMatch[1].split('^')[0]
  
  // ASTM: Patient record
  const astmPatient = rawContent.match(/P\|[^|]*\|([^|]*)/i)
  if (astmPatient) return astmPatient[1]
  
  return null
}

// Main AI parsing function for results
async function parseResultsWithAI(
  supabase: any,
  genAI: GoogleGenerativeAI,
  rawContent: string,
  labId: string
): Promise<{
  barcode: string
  results: Array<{
    test_code: string
    value: string
    unit: string
    flag: string
    reference_range?: string
  }>
  instrument?: string
  graphs?: any[]
}> {
  
  const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' })
  
  // Get lab's existing mappings for context
  // usage_count may be null for older records, so handle that
  const { data: knownMappings } = await supabase
    .from('test_mappings')
    .select('analyzer_code, lims_code')
    .eq('lab_id', labId)
    .or('usage_count.gt.0,verified.eq.true')
    .limit(100)
  
  const mappingContext = knownMappings?.length 
    ? `\nKNOWN CODE MAPPINGS:\n${knownMappings.map((m: any) => `${m.analyzer_code} -> ${m.lims_code}`).join('\n')}`
    : ''
  
  const prompt = `You are a laboratory analyzer result parser. Parse this raw analyzer data.
${mappingContext}

RAW DATA:
${rawContent}

OUTPUT ONLY valid JSON:
{
  "barcode": "sample/patient identifier",
  "instrument": "analyzer name if detectable",
  "results": [
    {
      "test_code": "LIMS code (use mapping if available, otherwise analyzer code)",
      "analyzer_code": "original code from analyzer",
      "value": "numeric or text value",
      "unit": "unit if present",
      "flag": "H/L/HH/LL/A/N/empty for normal",
      "reference_range": "range if present"
    }
  ],
  "graphs": [
    {
      "type": "histogram/scatter/waveform",
      "name": "description",
      "associated_test": "related test code"
    }
  ]
}

PARSING RULES:
1. Extract ALL result values (OBX segments in HL7, R records in ASTM)
2. Preserve original flags (H=High, L=Low, HH=Critical High, etc.)
3. Include units and reference ranges when present
4. Identify embedded images/graphs
5. Use LIMS code from mappings when available`

  const aiResult = await model.generateContent(prompt)
  const text = aiResult.response.text()
  
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    throw new Error('AI returned invalid JSON')
  }
  
  return JSON.parse(jsonMatch[0])
}

// Store results in database with intelligent analyte matching
async function storeResults(
  supabase: any,
  genAI: GoogleGenerativeAI,
  parsedData: any,
  labId: string,
  rawMessageId: string,
  opts: { useSavedReferenceRanges: boolean } = { useSavedReferenceRanges: true }
): Promise<{ success: boolean; mapped: number; unmapped: number; log: string }> {
  
  let log = ''
  let mappedCount = 0
  let unmappedCount = 0

  // An empty barcode must never reach the wildcard queries below —
  // '%%' matches an arbitrary sample/order in the lab.
  const barcode = String(parsedData.barcode ?? '').trim()
  if (!barcode) {
    return { success: false, mapped: 0, unmapped: parsedData.results?.length || 0, log: 'No sample barcode parsed from message' }
  }

  // Find sample by barcode
  const { data: samples } = await supabase
    .from('samples')
    .select('id, order_id, lab_id, barcode')
    .eq('lab_id', labId)
    .ilike('barcode', `%${barcode}%`)
    .limit(1)
  
  const sample = samples?.[0]
  
  if (!sample) {
    // Try orders table sample_id field
    const { data: orders } = await supabase
      .from('orders')
      .select('id, sample_id, patient_id, lab_id')
      .eq('lab_id', labId)
      .ilike('sample_id', `%${barcode}%`)
      .limit(1)

    if (!orders?.[0]) {
      log = `Sample not found for barcode: ${barcode}`
      return { success: false, mapped: 0, unmapped: parsedData.results?.length || 0, log }
    }
    
    // Use order directly
    const order = orders[0]
    return await storeResultsForOrder(supabase, genAI, parsedData, order, labId, log, opts)
  }

  return await storeResultsForSample(supabase, genAI, parsedData, sample, labId, log, opts)
}

async function storeResultsForOrder(
  supabase: any,
  genAI: GoogleGenerativeAI,
  parsedData: any,
  order: any,
  labId: string,
  log: string,
  opts: { useSavedReferenceRanges: boolean } = { useSavedReferenceRanges: true }
) {
  const useSavedReferenceRanges = opts.useSavedReferenceRanges !== false
  let mappedCount = 0
  let unmappedCount = 0
  
  // Get expected analytes for this order
  const { data: expectedAnalytes } = await supabase
    .from('v_order_missing_analytes')
    .select('*')
    .eq('order_id', order.id)
  
  // AI mapping of results to expected analytes
  const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' })
  
  const mappingPrompt = `Match analyzer results to expected lab analytes.

ANALYZER RESULTS:
${JSON.stringify(parsedData.results, null, 2)}

EXPECTED ANALYTES:
${JSON.stringify(expectedAnalytes?.map((a: any) => ({
  analyte_id: a.analyte_id,
  analyte_name: a.analyte_name,
  test_group_id: a.test_group_id,
  order_test_id: a.order_test_id
})) || [], null, 2)}

OUTPUT JSON:
{
  "mappings": [
    {
      "analyzer_code": "original code",
      "analyte_id": "uuid or null if no match",
      "analyte_name": "matched name",
      "test_group_id": "uuid or null",
      "order_test_id": "uuid or null",
      "confidence": 0.95
    }
  ]
}`

  let analyteMap = new Map()
  
  try {
    const aiResult = await model.generateContent(mappingPrompt)
    const text = aiResult.response.text()
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    
    if (jsonMatch) {
      const mappings = JSON.parse(jsonMatch[0])
      // The AI may echo either the machine code or the mnemonic name in
      // analyzer_code, but the downstream lookup keys on (analyzer_code ||
      // test_code). Reconcile the AI's answer back to the real result code (by
      // code OR name) so a correct mapping is never filed under the wrong key.
      const realCodeByToken = new Map<string, string>()
      for (const r of parsedData.results || []) {
        const realCode = String(r.analyzer_code || r.test_code || '').toUpperCase()
        if (!realCode) continue
        for (const token of [r.analyzer_code, r.test_code, r.name]) {
          const key = normalizeAnalyteName(token)
          if (key && !realCodeByToken.has(key)) realCodeByToken.set(key, realCode)
        }
      }
      for (const m of mappings.mappings || []) {
        if (!m.analyzer_code || !m.analyte_id) continue
        const realCode = realCodeByToken.get(normalizeAnalyteName(m.analyzer_code))
          || String(m.analyzer_code).toUpperCase()
        if (!analyteMap.has(realCode)) analyteMap.set(realCode, m)
      }
    }
  } catch (e: any) {
    console.error('AI mapping error:', e?.message, JSON.stringify(e))
    log += `AI mapping failed: ${e?.message}. `
  }
  
  // Ensure result record exists
  let { data: resultHeader } = await supabase
    .from('results')
    .select('id')
    .eq('order_id', order.id)
    .maybeSingle()
  
  if (!resultHeader) {
    const { data: newResult } = await supabase
      .from('results')
      .insert({
        order_id: order.id,
        patient_id: order.patient_id,
        lab_id: labId,
        test_name: 'Analyzer Result',
        entered_by: 'AI Interface',
        status: 'Entered'
      })
      .select()
      .single()
    resultHeader = newResult
  }
  
  if (!resultHeader) {
    return { success: false, mapped: 0, unmapped: parsedData.results.length, log: 'Failed to create result record' }
  }
  
  // Insert result values
  // Batch-resolve lab_analyte_id for all mapped analytes, plus the lab's saved
  // reference ranges / critical thresholds used to derive the range and flag.
  const allMappedAnalyteIds = Array.from(analyteMap.values()).map((m: any) => m.analyte_id).filter(Boolean) as string[]
  const labAnalyteIdMap = new Map<string, string>()
  const refRangeMap = new Map<string, {
    lab_specific: string | null; ref_generic: string | null;
    ref_male: string | null; ref_female: string | null;
    low_critical: string | null; high_critical: string | null;
    value_type: string | null; expected_normal_values: unknown
  }>()
  if (allMappedAnalyteIds.length > 0) {
    const { data: laRows } = await supabase
      .from('lab_analytes')
      .select('id, analyte_id, reference_range, reference_range_male, reference_range_female, lab_specific_reference_range, low_critical, high_critical, value_type, expected_normal_values')
      .eq('lab_id', labId)
      .in('analyte_id', allMappedAnalyteIds)
      .order('created_at', { ascending: true })
    if (laRows) {
      for (const la of laRows) {
        if (!labAnalyteIdMap.has(la.analyte_id)) labAnalyteIdMap.set(la.analyte_id, la.id)
        refRangeMap.set(la.id, {
          lab_specific: la.lab_specific_reference_range || null,
          ref_generic:  la.reference_range || null,
          ref_male:     la.reference_range_male || null,
          ref_female:   la.reference_range_female || null,
          low_critical: la.low_critical || null,
          high_critical: la.high_critical || null,
          value_type: la.value_type || null,
          expected_normal_values: la.expected_normal_values ?? null,
        })
      }
    }
  }

  // Patient facts drive the deterministic range rules: gender, age and
  // pregnancy. Loaded once per order rather than per result row.
  let patientRow: any = null
  let orderPatientContext: any = null
  if (useSavedReferenceRanges && order.patient_id) {
    const [{ data: p }, { data: o }] = await Promise.all([
      supabase
        .from('patients')
        .select('gender, dob, date_of_birth, age, age_unit')
        .eq('id', order.patient_id)
        .maybeSingle(),
      supabase
        .from('orders')
        .select('patient_context')
        .eq('id', order.id)
        .maybeSingle(),
    ])
    patientRow = p ?? null
    orderPatientContext = o?.patient_context ?? null
  }

  // Deterministic range rules, keyed by lab_analyte_id.
  const rangeRulesByLabAnalyte = new Map<string, ReferenceRangeRule[]>()
  if (useSavedReferenceRanges) {
    const ruleLabAnalyteIds = Array.from(new Set(labAnalyteIdMap.values()))
    if (ruleLabAnalyteIds.length > 0) {
      const { data: ruleRows, error: ruleErr } = await supabase
        .from('lab_analyte_reference_ranges')
        .select('id, lab_analyte_id, gender, age_min_days, age_max_days, sample_condition, pregnancy, range_text, range_low, range_high, low_critical, high_critical, priority, is_active, created_at')
        .in('lab_analyte_id', ruleLabAnalyteIds)
        .eq('is_active', true)
      if (ruleErr) {
        console.warn('[analyzer-result] range rule lookup failed, using legacy columns:', ruleErr.message)
      }
      for (const rule of (ruleRows ?? []) as ReferenceRangeRule[]) {
        if (!rule.lab_analyte_id) continue
        if (!rangeRulesByLabAnalyte.has(rule.lab_analyte_id)) rangeRulesByLabAnalyte.set(rule.lab_analyte_id, [])
        rangeRulesByLabAnalyte.get(rule.lab_analyte_id)!.push(rule)
      }
    }
  }

  // Sample condition is per test group on the order.
  const sampleConditionByTestGroup = new Map<string, string>()
  if (useSavedReferenceRanges) {
    const [{ data: otgRows }, { data: otRows }] = await Promise.all([
      supabase.from('order_test_groups').select('test_group_id, sample_condition').eq('order_id', order.id),
      supabase.from('order_tests').select('test_group_id, sample_condition').eq('order_id', order.id),
    ])
    for (const row of [...(otgRows ?? []), ...(otRows ?? [])]) {
      const condition = String(row?.sample_condition ?? '').trim()
      if (row?.test_group_id && condition && !sampleConditionByTestGroup.has(row.test_group_id)) {
        sampleConditionByTestGroup.set(row.test_group_id, condition)
      }
    }
  }

  const mappedCandidates: Array<{ item: any; mapping: any }> = []
  for (const item of parsedData.results) {
    const code = (item.analyzer_code || item.test_code)?.toUpperCase()
    const normalizedValue = normalizeAnalyzerValue(item.value)

    if (normalizedValue === null) {
      console.log(`[analyzer-result] skipped_empty_value ${JSON.stringify({
        order_id: order.id,
        analyzer_code: item.analyzer_code || item.test_code || null,
        raw_value: item.value ?? null,
        processor: 'fallback',
      })}`)
      continue
    }

    const mapping = analyteMap.get(code)
    
    if (!mapping?.analyte_id) {
      unmappedCount++
      log += `Unmapped: ${item.test_code}. `
      continue
    }

    mappedCandidates.push({
      item: { ...item, value: normalizedValue },
      mapping,
    })
  }

  const candidateTestGroupIds = [
    ...new Set(mappedCandidates.map(({ mapping }) => mapping.test_group_id).filter(Boolean)),
  ] as string[]
  const aiEnabledTestGroupIds = new Set<string>()
  if (candidateTestGroupIds.length > 0) {
    const { data: aiGroups } = await supabase
      .from('test_groups')
      .select('id, ref_range_ai_config')
      .in('id', candidateTestGroupIds)
    for (const group of aiGroups ?? []) {
      if (group.ref_range_ai_config?.enabled === true) aiEnabledTestGroupIds.add(group.id)
    }
  }

  logAiRefRange('configuration_evaluated', {
    order_id: order.id,
    processor: 'fallback',
    candidate_count: mappedCandidates.length,
    candidate_test_group_ids: candidateTestGroupIds,
    enabled_test_group_ids: [...aiEnabledTestGroupIds],
  })

  const aiResolvedRanges = await resolveAiReferenceRanges(
    order.id,
    mappedCandidates
      .filter(({ mapping }) => aiEnabledTestGroupIds.has(mapping.test_group_id))
      .map(({ item, mapping }) => ({
        analyte_id: mapping.analyte_id,
        lab_analyte_id: labAnalyteIdMap.get(mapping.analyte_id) || null,
        analyte_name: mapping.analyte_name,
        value: String(item.value ?? ''),
        unit: String(item.unit ?? ''),
        test_group_id: mapping.test_group_id,
      })),
  )

  for (const { item, mapping } of mappedCandidates) {
    const labAnalyteId = labAnalyteIdMap.get(mapping.analyte_id) || null
    const aiResolution = mapping.test_group_id
      ? aiResolvedRanges.get(`${mapping.test_group_id}:${labAnalyteId || mapping.analyte_id}`)
      : null

    const rr = labAnalyteId ? refRangeMap.get(labAnalyteId) : null
    // Deterministic rules first (gender / age / sample condition / pregnancy),
    // with the legacy gender columns as the fallback inside the resolver.
    const resolvedSavedRange = resolveReferenceRange(
      labAnalyteId ? rangeRulesByLabAnalyte.get(labAnalyteId) : null,
      buildRangeContext({
        patient: patientRow,
        patientContext: orderPatientContext,
        sampleCondition: mapping.test_group_id
          ? sampleConditionByTestGroup.get(mapping.test_group_id) ?? null
          : null,
      }),
      {
        lab_specific_reference_range: rr?.lab_specific ?? null,
        reference_range: rr?.ref_generic ?? null,
        reference_range_male: rr?.ref_male ?? null,
        reference_range_female: rr?.ref_female ?? null,
        low_critical: rr?.low_critical ?? null,
        high_critical: rr?.high_critical ?? null,
      },
    )
    const savedReferenceRange = resolvedSavedRange.range_text || null
    // With the toggle on, the lab's saved range wins and the machine's range is
    // only a last resort. With it off, keep the prior machine-first behaviour.
    const fallbackReferenceRange = useSavedReferenceRanges
      ? (savedReferenceRange || item.reference_range || '-')
      : (item.reference_range || savedReferenceRange || '-')
    const finalReferenceRange = aiResolution?.used_reference_range || fallbackReferenceRange

    // Flag: compute from the saved/AI range when the toggle is on; never trust
    // the analyzer's OBX-8. Keep the machine (or AI) flag when the toggle is off.
    let finalFlag: string
    let finalFlagSource: string
    if (useSavedReferenceRanges) {
      const computed = computeSavedFlag(item.value, finalReferenceRange, {
        // A matched rule may carry its own criticals for that condition.
        lowCritical: resolvedSavedRange.low_critical ?? rr?.low_critical,
        highCritical: resolvedSavedRange.high_critical ?? rr?.high_critical,
        expectedNormalValues: rr?.expected_normal_values,
        valueType: rr?.value_type,
      })
      finalFlag = computed.flag
      finalFlagSource = computed.source
    } else {
      finalFlag = aiResolution?.flag || normalizeAnalyzerFlag(item.flag)
      finalFlagSource = aiResolution ? 'ai' : 'analyzer'
    }

    const fallbackReason = aiResolution
      ? null
      : !mapping.test_group_id
        ? 'missing_test_group'
        : !aiEnabledTestGroupIds.has(mapping.test_group_id)
          ? 'ai_disabled'
          : 'ai_no_resolution'

    logAiRefRange(aiResolution ? 'result_resolution_applied' : 'result_fallback_used', {
      order_id: order.id,
      processor: 'fallback',
      test_group_id: mapping.test_group_id || null,
      analyte_id: mapping.analyte_id,
      analyzer_code: item.analyzer_code || item.test_code || null,
      range_source: aiResolution ? 'ai' : (useSavedReferenceRanges ? resolvedSavedRange.source : 'analyzer'),
      applied_range_rule: aiResolution ? null : resolvedSavedRange.applied_rule,
      flag_source: finalFlagSource,
      fallback_reason: fallbackReason,
      reference_range: finalReferenceRange,
      flag: finalFlag,
    })

    const { error } = await supabase.from('result_values').insert({
      result_id: resultHeader.id,
      order_id: order.id,
      lab_id: labId,
      analyte_id: mapping.analyte_id,
      lab_analyte_id: labAnalyteId,
      parameter: mapping.analyte_name,
      analyte_name: mapping.analyte_name,
      value: item.value,
      unit: item.unit,
      flag: finalFlag,
      reference_range: finalReferenceRange,
      range_rule_id: aiResolution ? null : resolvedSavedRange.rule_id,
      range_source: aiResolution ? 'ai' : (useSavedReferenceRanges ? resolvedSavedRange.source : 'analyzer'),
      applied_range_rule: aiResolution ? null : resolvedSavedRange.applied_rule,
      extracted_by_ai: true,
      flag_source: finalFlagSource,
      test_group_id: mapping.test_group_id,
      order_test_id: mapping.order_test_id
    })
    
    if (!error) {
      mappedCount++
    } else {
      log += `Error: ${item.test_code}: ${error.message}. `
    }
  }
  
  log += `Mapped ${mappedCount}/${parsedData.results.length} results. `
  
  // Update order queue if exists. Include 'sent' — analyzers that never send an
  // application-level ACK would otherwise leave the entry stuck at 'sent' forever.
  await supabase
    .from('analyzer_order_queue')
    .update({ status: 'completed', completed_at: new Date().toISOString() })
    .eq('order_id', order.id)
    .in('status', ['acknowledged', 'sent'])
  
  return { success: true, mapped: mappedCount, unmapped: unmappedCount, log }
}

async function storeResultsForSample(
  supabase: any,
  genAI: GoogleGenerativeAI,
  parsedData: any,
  sample: any,
  labId: string,
  log: string,
  opts: { useSavedReferenceRanges: boolean } = { useSavedReferenceRanges: true }
) {
  // Get order from sample
  const { data: order } = await supabase
    .from('orders')
    .select('id, patient_id')
    .eq('id', sample.order_id)
    .single()

  if (!order) {
    return { success: false, mapped: 0, unmapped: parsedData.results.length, log: 'Order not found for sample' }
  }

  return await storeResultsForOrder(supabase, genAI, parsedData, order, labId, log, opts)
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const startTime = Date.now()
  
  try {
    const payload = await req.json()
    const { record } = payload

    if (!record?.raw_content) {
      return new Response(JSON.stringify({ message: 'No content to process' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Deduplication guard: process-analyzer-result is the primary handler.
    // If the row is already being processed or completed, skip to avoid duplicate result_values.
    if (record.ai_status && record.ai_status !== 'pending') {
      return new Response(JSON.stringify({ message: 'Already handled by primary processor' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )
    
    const genAI = new GoogleGenerativeAI(Deno.env.get('GEMINI_API_KEY') || '')

    // Parse message type
    const { type: messageType, controlId } = parseMessageType(record.raw_content)
    
    console.log(`📥 Received ${messageType} message, Control ID: ${controlId || 'N/A'}`)

    // Update message with type info
    await supabase
      .from('analyzer_raw_messages')
      .update({ 
        message_type: messageType,
        message_control_id: controlId,
        ai_status: 'processing'
      })
      .eq('id', record.id)

    // Handle ACK/NAK messages
    if (messageType.includes('ACK') || messageType.includes('NAK')) {
      const ackResult = await handleAcknowledgment(
        supabase, messageType, controlId, record.raw_content, record.lab_id
      )
      
      await supabase
        .from('analyzer_raw_messages')
        .update({ 
          ai_status: 'completed',
          ai_result: { type: 'acknowledgment', ...ackResult },
          processing_time_ms: Date.now() - startTime
        })
        .eq('id', record.id)
      
      return new Response(JSON.stringify(ackResult), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Handle result messages (ORU, ASTM_RESULT, etc.)
    const parsedData = await parseResultsWithAI(supabase, genAI, record.raw_content, record.lab_id)
    
    // Update with barcode for quick lookup
    await supabase
      .from('analyzer_raw_messages')
      .update({ sample_barcode: parsedData.barcode })
      .eq('id', record.id)

    // Per-connection toggle: derive the reference range + flag from the lab's
    // SAVED analyte settings instead of trusting the analyzer's OBX-7/OBX-8.
    // Defaults ON; an explicit `use_saved_reference_ranges: false` reverts.
    let useSavedReferenceRanges = true
    if (record.analyzer_connection_id) {
      const { data: connRow } = await supabase
        .from('analyzer_connections')
        .select('config')
        .eq('id', record.analyzer_connection_id)
        .maybeSingle()
      if (connRow?.config?.use_saved_reference_ranges === false) useSavedReferenceRanges = false
    }

    // Store results
    const storeResult = await storeResults(supabase, genAI, parsedData, record.lab_id, record.id, { useSavedReferenceRanges })

    // Final update
    await supabase
      .from('analyzer_raw_messages')
      .update({
        ai_status: storeResult.success ? 'completed' : 'review_needed',
        ai_result: {
          ...parsedData,
          storage_result: storeResult
        },
        ai_confidence: storeResult.mapped / (storeResult.mapped + storeResult.unmapped) || 0,
        processing_time_ms: Date.now() - startTime
      })
      .eq('id', record.id)

    // Log communication
    await supabase
      .from('analyzer_comm_log')
      .insert({
        lab_id: record.lab_id,
        analyzer_connection_id: record.analyzer_connection_id,
        direction: 'RECEIVE',
        message_type: messageType,
        message_control_id: controlId,
        message_preview: record.raw_content.slice(0, 500),
        message_size: record.raw_content.length,
        success: storeResult.success,
        processing_time_ms: Date.now() - startTime,
        raw_message_id: record.id
      })

    return new Response(JSON.stringify({
      success: storeResult.success,
      message_type: messageType,
      barcode: parsedData.barcode,
      results_count: parsedData.results?.length || 0,
      mapped: storeResult.mapped,
      unmapped: storeResult.unmapped,
      processing_time_ms: Date.now() - startTime,
      log: storeResult.log
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })

  } catch (error) {
    console.error('Process error:', error)
    const message = error instanceof Error ? error.message : String(error)
    return new Response(JSON.stringify({ error: message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500
    })
  }
})
