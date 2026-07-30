/**
 * ai-report-import — Supabase Edge Function (Deno)
 *
 * Two-stage AI pipeline:
 *   Stage 1 → Gemini 2.5 Flash (vision)  — extract structured data from lab report image/PDF
 *   Stage 2 → Claude Haiku 4.5           — match extracted analytes to DB analytes → CRUD-ready JSON
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const GEMINI_VISION_MODEL = 'gemini-2.5-flash'
const CLAUDE_HAIKU_MODEL = 'claude-haiku-4-5-20251001'

/**
 * Allowed values of the Postgres `sample_type` enum (verified against the live
 * DB). test_groups.sample_type is enum-typed, so anything outside this list is
 * rejected by the database — free text from the report must be mapped onto it.
 * The client may override via `allowed_sample_types` in the request body.
 */
const SAMPLE_TYPE_ENUM = [
  'EDTA Blood', 'Serum', 'Plasma', 'Urine', 'Stool', 'CSF', 'Sputum', 'Swab',
  'Tissue', 'Other', 'Fluoride Plasma', 'Citrated Plasma', 'X-Ray', 'CT Scan',
  'MRI', 'Ultrasound', 'Mammography', 'PET Scan', 'Fluoroscopy', 'Angiography',
  'DEXA Scan', 'ECG', 'EEG', 'Endoscopy', 'Colonoscopy', 'Bronchoscopy',
  'No Sample Required', 'Whole Blood', 'Capillary Blood',
]

/** How labs actually word specimens on reports → the enum value they mean. */
const SAMPLE_TYPE_ALIASES: Record<string, string> = {
  'whole blood edta': 'EDTA Blood',
  'edta whole blood': 'EDTA Blood',
  'blood edta': 'EDTA Blood',
  'edta': 'EDTA Blood',
  'edta blood sample': 'EDTA Blood',
  'k2 edta blood': 'EDTA Blood',
  'k3 edta blood': 'EDTA Blood',
  'anticoagulated blood': 'EDTA Blood',
  'lavender top': 'EDTA Blood',
  'purple top': 'EDTA Blood',
  'blood': 'Whole Blood',
  'blood sample': 'Whole Blood',
  'venous blood': 'Whole Blood',
  'peripheral blood': 'Whole Blood',
  'peripheral smear': 'Whole Blood',
  'finger prick blood': 'Capillary Blood',
  'fingerstick blood': 'Capillary Blood',
  'clotted blood': 'Serum',
  'plain blood': 'Serum',
  'serum sample': 'Serum',
  'sst': 'Serum',
  'red top': 'Serum',
  'heparinised plasma': 'Plasma',
  'heparinized plasma': 'Plasma',
  'lithium heparin plasma': 'Plasma',
  'citrated blood': 'Citrated Plasma',
  'sodium citrate': 'Citrated Plasma',
  'sodium citrate plasma': 'Citrated Plasma',
  'blue top': 'Citrated Plasma',
  'fluoride blood': 'Fluoride Plasma',
  'sodium fluoride plasma': 'Fluoride Plasma',
  'grey top': 'Fluoride Plasma',
  'gray top': 'Fluoride Plasma',
  'random urine': 'Urine',
  'spot urine': 'Urine',
  'first morning urine': 'Urine',
  'midstream urine': 'Urine',
  '24 hour urine': 'Urine',
  '24 hr urine': 'Urine',
  '24 hrs urine': 'Urine',
  'faeces': 'Stool',
  'feces': 'Stool',
  'stool sample': 'Stool',
  'cerebrospinal fluid': 'CSF',
  'csf fluid': 'CSF',
  'biopsy': 'Tissue',
  'tissue biopsy': 'Tissue',
  'fnac': 'Tissue',
  'usg': 'Ultrasound',
  'sonography': 'Ultrasound',
  'ultrasonography': 'Ultrasound',
  'x ray': 'X-Ray',
  'xray': 'X-Ray',
  'radiograph': 'X-Ray',
  'ct': 'CT Scan',
  'cect': 'CT Scan',
  'computed tomography': 'CT Scan',
  'body fluid': 'Other',
  'not applicable': 'No Sample Required',
  'na': 'No Sample Required',
}

/** Words that carry no discriminating power when fuzzy-matching a specimen. */
const GENERIC_SAMPLE_TOKENS = new Set(['sample', 'specimen', 'fluid', 'scan', 'type'])

function sampleTypeKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * Map free-text specimen wording from a report onto the sample_type enum.
 * Returns null when nothing matches confidently — the caller then skips the
 * update rather than letting Postgres reject the whole test-group write.
 */
function normalizeSampleType(raw: string, allowed: string[]): string | null {
  const key = sampleTypeKey(raw)
  if (!key) return null

  // 1. Exact (case/punctuation-insensitive) hit
  const exact = allowed.find(v => sampleTypeKey(v) === key)
  if (exact) return exact

  // 2. Known lab wording
  const alias = SAMPLE_TYPE_ALIASES[key]
  if (alias && allowed.includes(alias)) return alias

  // 3. Token containment — every word of the enum value appears in the raw text
  //    ("Whole Blood EDTA" contains all of "EDTA Blood"). Score by discriminating
  //    tokens; ties fall to enum declaration order, which is most-specific-first.
  const rawTokens = new Set(key.split(' '))
  let best: string | null = null
  let bestScore = 0
  for (const value of allowed) {
    const tokens = sampleTypeKey(value).split(' ')
    if (!tokens.every(t => rawTokens.has(t))) continue
    const score = tokens.reduce((sum, t) => sum + (GENERIC_SAMPLE_TOKENS.has(t) ? 0.25 : 1), 0)
    if (score > bestScore) {
      bestScore = score
      best = value
    }
  }
  return best
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface ExistingAnalyte {
  id: string
  lab_analyte_id: string
  name: string
  code: string
  unit: string
  reference_range: string
  reference_range_male?: string | null
  reference_range_female?: string | null
}

interface ExistingTGA {
  id?: string
  analyte_id: string
  lab_analyte_id?: string | null
  sort_order: number
  section_heading: string
}

interface ExtractedAnalyte {
  extracted_name: string
  unit: string
  reference_range?: string
  reference_range_male?: string
  reference_range_female?: string
  reference_range_pediatric?: string
  section_header?: string
  position: number
}

interface GeminiExtractedData {
  test_name?: string
  methodology?: string
  sample_type?: string
  analytes: ExtractedAnalyte[]
}

// ─── Stage 1: Gemini 2.5 Flash vision extraction ─────────────────────────────

function buildGeminiExtractionPrompt(allowedSampleTypes: string[]): string {
  return `You are a medical laboratory data extraction specialist. Analyze this lab report image/PDF and extract all structured data.

Extract the following and return ONLY a JSON object with no extra text:

1. Test name / panel name (if shown)
2. Methodology / technique (if shown, e.g., "Impedance", "Flow Cytometry", "Photometry")
3. Sample type — you MUST return one of these exact values, or null if none applies:
${JSON.stringify(allowedSampleTypes)}
   Map the report's wording to the closest listed value (e.g. "Whole Blood EDTA",
   "EDTA Whole Blood" and "Lavender top" all map to "EDTA Blood"; "Clotted blood"
   maps to "Serum"; "USG"/"Sonography" map to "Ultrasound"). Never invent a value
   outside the list — return null instead of guessing.
4. ALL analytes/parameters listed, in the ORDER they appear

For each analyte:
- extracted_name: Exact parameter name as written
- unit: Unit of measurement
- reference_range: Combined range if single range (e.g., "4.5-11.0")
- reference_range_male: Male-specific if shown separately
- reference_range_female: Female-specific if shown separately
- reference_range_pediatric: Pediatric range if shown
- section_header: The group/section heading this analyte falls under (null if none)
- position: 1-based index in report order

Return JSON:
{
  "test_name": "string or null",
  "methodology": "string or null",
  "sample_type": "string or null",
  "analytes": [
    {
      "extracted_name": "Haemoglobin",
      "unit": "g/dL",
      "reference_range": null,
      "reference_range_male": "13.0-17.0",
      "reference_range_female": "11.0-15.0",
      "reference_range_pediatric": null,
      "section_header": "Red Blood Cell Parameters",
      "position": 1
    }
  ]
}

Rules:
- Capture ALL parameters visible, including calculated ones
- Preserve exact names as written (do not normalise)
- Percentage and absolute forms of the same parameter are SEPARATE analytes — keep
  the qualifier from the report (e.g. "Neutrophils %" and "Neutrophils (Absolute)"),
  and if the report distinguishes them only by unit, append the form to the name
- If a single unified range exists, use reference_range; if M/F split, use reference_range_male / reference_range_female
- Section headers are bold/underlined group labels appearing above sets of analytes`
}

async function callGeminiVision(
  fileBase64: string,
  mimeType: string,
  geminiApiKey: string,
  allowedSampleTypes: string[]
): Promise<GeminiExtractedData> {
  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          { inlineData: { mimeType, data: fileBase64 } },
          { text: buildGeminiExtractionPrompt(allowedSampleTypes) },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.1,
      topP: 0.9,
      // 2.5 Flash spends part of the output budget on thinking tokens; a long
      // report can otherwise get cut off mid-array. Disable thinking (extraction
      // is mechanical) and give the answer plenty of room.
      maxOutputTokens: 65536,
      thinkingConfig: { thinkingBudget: 0 },
      responseMimeType: 'application/json',
    },
  }

  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_VISION_MODEL}:generateContent?key=${geminiApiKey}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  )

  if (!resp.ok) {
    const errText = await resp.text()
    throw new Error(`Gemini vision error ${resp.status}: ${errText}`)
  }

  const data = await resp.json()
  const candidate = data?.candidates?.[0]
  const finishReason: string = candidate?.finishReason ?? ''

  // Join every text part — long JSON answers can be split across parts
  const text: string = (candidate?.content?.parts ?? [])
    .filter((p: Record<string, unknown>) => typeof p?.text === 'string' && !p?.thought)
    .map((p: { text: string }) => p.text)
    .join('')
    .trim()

  if (!text) {
    console.error('[ai-report-import] Gemini empty response. finishReason:', finishReason)
    throw new Error(`Gemini returned empty response (finishReason: ${finishReason || 'unknown'})`)
  }

  if (finishReason && finishReason !== 'STOP') {
    console.warn('[ai-report-import] Gemini finishReason:', finishReason, '- output may be truncated')
  }

  return parseLlmJson<GeminiExtractedData>(text, 'Gemini')
}

// ─── Stage 2: Claude Haiku 4.5 matching & CRUD payload generation ─────────────

function buildHaikuPrompt(
  extracted: GeminiExtractedData,
  existingAnalytes: ExistingAnalyte[],
  existingTga: ExistingTGA[],
  currentTestGroup: { methodology: string; sample_type: string }
): string {
  // Build compact catalog: only essential fields for matching
  const compactCatalog = existingAnalytes.map(a => ({
    i: a.lab_analyte_id, // lab_analyte_id
    a: a.id,             // analyte_id
    n: a.name,           // name
    c: a.code || '',     // code
    u: a.unit || '',     // unit
  }))

  // Build attached map with minimal keys
  const attachedIds = new Set(
    existingTga
      .filter(t => t.lab_analyte_id)
      .map(t => t.lab_analyte_id as string)
  )

  // Compact extracted analytes
  const compactExtracted = (extracted.analytes ?? []).map(a => ({
    n: a.extracted_name,
    u: a.unit || '',
    r: a.reference_range || '',
    rm: a.reference_range_male || '',
    rf: a.reference_range_female || '',
    s: a.section_header || '',
    p: a.position,
  }))

  return `Match extracted lab report analytes to DB catalog. Return COMPACT JSON.

CATALOG (i=lab_analyte_id, a=analyte_id, n=name, c=code, u=unit):
${JSON.stringify(compactCatalog)}

ATTACHED IDS: ${JSON.stringify([...attachedIds])}

EXTRACTED (n=name, u=unit, r=ref_range, rm=male, rf=female, s=section, p=position):
${JSON.stringify(compactExtracted)}

TASK: For each extracted analyte, find best match from catalog by name/code similarity.
Handle common variants: Haemoglobin↔Hemoglobin, TLC↔WBC, Platelet Count↔PLT, etc.

CRITICAL — each catalog id may be used AT MOST ONCE across the whole result:
- Percentage vs absolute counts are DIFFERENT analytes (Neutrophils % vs Neutrophils
  Absolute / AEC). Match each to its own catalog entry; compare units (% vs 10^3/µL)
  to tell them apart.
- If two extracted analytes look like the same catalog entry, keep only the better
  match and put the other in "u" so it can be created as a new analyte.
- Never emit two objects in "m" with the same "i".

Return JSON (no markdown):
{
  "m": [
    {
      "e": "Haemoglobin",
      "i": "<lab_analyte_id>",
      "c": 0.97
    }
  ],
  "u": ["MPV", "PDW"]
}

Where:
- m = matches array (e=extracted_name, i=lab_analyte_id, c=confidence 0-1)
- u = unmatched extracted names (confidence < 0.75)

Only include matches with confidence >= 0.75. Be concise.`
}

/**
 * Attempt to repair truncated JSON from LLM output.
 *
 * Walks the text tracking nesting, remembering the last offset at which a
 * container element was fully closed. On failure we cut back to that point and
 * close the still-open containers — so a response cut off mid-object loses only
 * the trailing partial element instead of the whole extraction.
 */
function repairTruncatedJson(text: string): string {
  const json = text.trim()

  const stack: string[] = []
  let inString = false
  let escaped = false
  let safeEnd = -1
  let safeStack: string[] = []

  for (let i = 0; i < json.length; i++) {
    const char = json[i]

    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }

    if (char === '"') {
      inString = true
    } else if (char === '{') {
      stack.push('}')
    } else if (char === '[') {
      stack.push(']')
    } else if (char === '}' || char === ']') {
      stack.pop()
      // Everything up to and including this closer is valid JSON structure
      safeEnd = i
      safeStack = [...stack]
    }
  }

  // Nothing closed cleanly — fall back to closing whatever is open
  if (safeEnd === -1) {
    return (inString ? `${json}"` : json) + stack.reverse().join('')
  }

  return json.slice(0, safeEnd + 1) + safeStack.reverse().join('')
}

/**
 * Parse JSON emitted by an LLM: strips code fences / prose, then repairs
 * truncated output before giving up.
 */
function parseLlmJson<T>(text: string, source: string): T {
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim()

  const start = cleaned.indexOf('{')
  if (start === -1) {
    console.error(`[ai-report-import] ${source} raw response (no JSON found):`, cleaned.slice(0, 500))
    throw new Error(`Could not extract JSON from ${source} response`)
  }

  // Take from the first brace to the end — do NOT stop at the last `}`, which
  // would drop the closers needed to detect truncation.
  const candidate = cleaned.slice(start)

  try {
    return JSON.parse(candidate) as T
  } catch (_firstError) {
    console.warn(`[ai-report-import] ${source} JSON parse failed, attempting truncation repair...`)
    const repaired = repairTruncatedJson(candidate)
    try {
      const result = JSON.parse(repaired) as T
      console.log(`[ai-report-import] ${source} JSON repair successful (recovered ${repaired.length}/${candidate.length} chars)`)
      return result
    } catch (e) {
      console.error(`[ai-report-import] ${source} JSON parse error after repair. Raw (first 1500 chars):`, candidate.slice(0, 1500))
      console.error(`[ai-report-import] ${source} raw tail (last 500 chars):`, candidate.slice(-500))
      throw new Error(`${source} response JSON parse failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
}

async function callClaudeHaiku(
  prompt: string,
  anthropicApiKey: string
): Promise<unknown> {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': anthropicApiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: CLAUDE_HAIKU_MODEL,
      max_tokens: 16384,
      messages: [{ role: 'user', content: prompt }],
    }),
  })

  if (!resp.ok) {
    const errText = await resp.text()
    throw new Error(`Claude Haiku error ${resp.status}: ${errText}`)
  }

  const data = await resp.json()
  const text: string = (data?.content ?? [])
    .filter((b: Record<string, unknown>) => b?.type === 'text' && typeof b?.text === 'string')
    .map((b: { text: string }) => b.text)
    .join('')
    .trim()
  const stopReason: string = data?.stop_reason ?? ''

  if (!text) throw new Error('Claude Haiku returned empty response')

  // Check if output was truncated due to token limit
  const wasTruncated = stopReason === 'max_tokens' || (stopReason === 'end_turn' && !text.endsWith('}'))
  if (wasTruncated) {
    console.warn('[ai-report-import] Claude response may be truncated (stop_reason:', stopReason, ')')
  }

  return parseLlmJson<unknown>(text, 'Claude Haiku')
}

// ─── Handler ──────────────────────────────────────────────────────────────────

function comparable(value: unknown): string {
  return String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase()
}

/**
 * Normalize AI response to handle both compact (m/u) and legacy (analyte_changes) formats
 */
function normalizeAiResponse(rawResult: Record<string, unknown>): {
  matches: Array<{ extracted_name: string; lab_analyte_id: string; match_confidence: number }>
  unmatchedNames: string[]
} {
  // Handle compact format: { m: [...], u: [...] }
  if (Array.isArray(rawResult.m)) {
    const matches = (rawResult.m as Array<Record<string, unknown>>).map(item => ({
      extracted_name: String(item.e ?? ''),
      lab_analyte_id: String(item.i ?? ''),
      match_confidence: Number(item.c ?? 0),
    }))
    const unmatchedNames = Array.isArray(rawResult.u)
      ? (rawResult.u as string[]).map(String)
      : []
    return { matches, unmatchedNames }
  }

  // Handle legacy format: { analyte_changes: [...] }
  if (Array.isArray(rawResult.analyte_changes)) {
    const matches = (rawResult.analyte_changes as Array<Record<string, unknown>>).map(item => ({
      extracted_name: String(item.extracted_name ?? ''),
      lab_analyte_id: String(item.lab_analyte_id ?? ''),
      match_confidence: Number(item.match_confidence ?? 0),
    }))
    const unmatchedNames = Array.isArray(rawResult.unmatched_analytes)
      ? (rawResult.unmatched_analytes as Array<Record<string, unknown>>).map(
          item => String(item.extracted_name ?? '')
        )
      : []
    return { matches, unmatchedNames }
  }

  return { matches: [], unmatchedNames: [] }
}

function buildDeterministicResult(
  rawResult: Record<string, unknown>,
  extracted: GeminiExtractedData,
  existingAnalytes: ExistingAnalyte[],
  existingTga: ExistingTGA[],
  currentTestGroup: { methodology: string; sample_type: string },
  allowedSampleTypes: string[]
): Record<string, unknown> {
  const catalogByLabId = new Map(existingAnalytes.map(a => [a.lab_analyte_id, a]))
  const extractedByName = new Map((extracted.analytes ?? []).map(a => [comparable(a.extracted_name), a]))
  const attachedByLabId = new Map(
    existingTga.filter(t => t.lab_analyte_id).map(t => [t.lab_analyte_id as string, t])
  )
  const legacyAttachedByAnalyteId = new Map(
    existingTga.filter(t => !t.lab_analyte_id).map(t => [t.analyte_id, t])
  )
  const matchedLabIds = new Set<string>()
  const matchedExtractedNames = new Set<string>()
  const analyteChanges: Record<string, unknown>[] = []

  const { matches } = normalizeAiResponse(rawResult)

  // A catalog analyte may be claimed only once per import: test_group_analytes has
  // UNIQUE (test_group_id, analyte_id), so two extracted rows pointing at the same
  // analyte (typically "Neutrophils %" and "Neutrophils Absolute" both matching
  // "Neutrophils") would fail the second attach. Keep the strongest claim; the
  // losers fall through to unmatched_analytes so they can be created separately.
  const winnerByAnalyteId = new Map<string, typeof matches[number]>()
  const claimedExtracted = new Set<string>()
  const duplicateNotes: string[] = []

  for (const match of [...matches].sort((a, b) => b.match_confidence - a.match_confidence)) {
    const catalog = catalogByLabId.get(match.lab_analyte_id)
    if (!catalog) continue
    const extractedKey = comparable(match.extracted_name)
    if (claimedExtracted.has(extractedKey)) continue

    const incumbent = winnerByAnalyteId.get(catalog.id)
    if (incumbent) {
      duplicateNotes.push(`"${match.extracted_name}" also matched ${catalog.name}, already claimed by "${incumbent.extracted_name}" — listed as a new analyte instead.`)
      continue
    }
    winnerByAnalyteId.set(catalog.id, match)
    claimedExtracted.add(extractedKey)
  }

  const acceptedMatches = new Set(winnerByAnalyteId.values())

  for (const match of matches) {
    if (!acceptedMatches.has(match)) continue
    const labAnalyteId = match.lab_analyte_id
    const catalog = catalogByLabId.get(labAnalyteId)
    const extractedName = comparable(match.extracted_name)
    const item = extractedByName.get(extractedName)
    const confidence = match.match_confidence
    if (!catalog || !item || confidence < 0.75) continue

    const attached = attachedByLabId.get(labAnalyteId) || legacyAttachedByAnalyteId.get(catalog.id)
    const labUpdates: Record<string, string> = {}
    const fields: Array<[keyof ExtractedAnalyte, keyof ExistingAnalyte]> = [
      ['unit', 'unit'],
      ['reference_range', 'reference_range'],
      ['reference_range_male', 'reference_range_male'],
      ['reference_range_female', 'reference_range_female'],
    ]
    for (const [source, target] of fields) {
      const proposed = item[source]
      if (proposed && comparable(proposed) !== comparable(catalog[target])) {
        labUpdates[target] = String(proposed).trim()
      }
    }

    const section = String(item.section_header ?? '').trim()
    const order = Number(item.position ?? 0)
    const currentSection = String(attached?.section_heading ?? '')
    const currentOrder = Number(attached?.sort_order ?? 0)
    const tgaUpdates: Record<string, string | number> = {}
    if (!attached || comparable(section) !== comparable(currentSection)) tgaUpdates.section_heading = section
    if (!attached || order !== currentOrder) tgaUpdates.sort_order = order

    matchedLabIds.add(labAnalyteId)
    matchedExtractedNames.add(extractedName)
    const needsAttachment = !attached
    const hasLabChanges = Object.keys(labUpdates).length > 0
    const hasTgaChanges = Object.keys(tgaUpdates).length > 0 || needsAttachment
    if (!hasLabChanges && !hasTgaChanges) continue

    analyteChanges.push({
      extracted_name: item.extracted_name,
      analyte_id: catalog.id,
      lab_analyte_id: catalog.lab_analyte_id,
      matched_name: catalog.name,
      matched_code: catalog.code ?? '',
      match_confidence: confidence,
      is_currently_attached: Boolean(attached),
      needs_attachment: needsAttachment,
      lab_analyte_updates: labUpdates,
      tga_updates: tgaUpdates,
      current_values: {
        unit: catalog.unit ?? '',
        reference_range: catalog.reference_range ?? '',
        reference_range_male: catalog.reference_range_male ?? '',
        reference_range_female: catalog.reference_range_female ?? '',
        section_heading: currentSection,
        sort_order: currentOrder,
      },
      has_lab_analyte_changes: hasLabChanges,
      has_tga_changes: hasTgaChanges,
    })
  }

  const unmatched = (extracted.analytes ?? []).filter(
    item => !matchedExtractedNames.has(comparable(item.extracted_name))
  )

  const missingAttached = existingTga.flatMap(tga => {
    const catalog = tga.lab_analyte_id
      ? catalogByLabId.get(tga.lab_analyte_id)
      : existingAnalytes.find(a => a.id === tga.analyte_id)
    if (!catalog || matchedLabIds.has(catalog.lab_analyte_id)) return []
    return [{
      tga_id: tga.id,
      analyte_id: catalog.id,
      lab_analyte_id: catalog.lab_analyte_id,
      name: catalog.name,
      code: catalog.code ?? '',
      section_heading: tga.section_heading ?? '',
      sort_order: tga.sort_order ?? 0,
    }]
  })

  const testGroupUpdates: Record<string, string> = {}
  const notes: string[] = []

  if (extracted.methodology && comparable(extracted.methodology) !== comparable(currentTestGroup.methodology)) {
    testGroupUpdates.methodology = extracted.methodology.trim()
  }

  // sample_type is an enum column — only propose a value the DB will accept
  if (extracted.sample_type) {
    const raw = extracted.sample_type.trim()
    const normalized = normalizeSampleType(raw, allowedSampleTypes)
    if (!normalized) {
      notes.push(`Sample type "${raw}" from the report does not map to a known sample type — left unchanged.`)
    } else if (comparable(normalized) !== comparable(currentTestGroup.sample_type)) {
      testGroupUpdates.sample_type = normalized
      if (comparable(normalized) !== comparable(raw)) {
        notes.push(`Sample type "${raw}" mapped to "${normalized}".`)
      }
    }
  }

  notes.push(...duplicateNotes)
  const aiNote = rawResult.extraction_notes ?? rawResult.notes
  if (typeof aiNote === 'string' && aiNote.trim()) notes.unshift(aiNote.trim())

  return {
    test_group_updates: testGroupUpdates,
    has_test_group_changes: Object.keys(testGroupUpdates).length > 0,
    analyte_changes: analyteChanges,
    unmatched_analytes: unmatched,
    missing_attached_analytes: missingAttached,
    extraction_notes: notes.length > 0 ? notes.join(' ') : undefined,
  }
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
    const geminiApiKey = Deno.env.get('ALLGOOGLE_KEY') || Deno.env.get('GEMINI_API_KEY')
    const anthropicApiKey = Deno.env.get('ANTHROPIC_API_KEY')

    if (!geminiApiKey) {
      return new Response(JSON.stringify({ error: 'Gemini API key not configured' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }
    if (!anthropicApiKey) {
      return new Response(JSON.stringify({ error: 'Anthropic API key not configured' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const body = await req.json()
    const { file_base64, file_mime_type, test_group, existing_analytes, existing_tga } = body

    // Client may supply the live enum values; fall back to the known list
    const allowedSampleTypes: string[] =
      Array.isArray(body.allowed_sample_types) && body.allowed_sample_types.length > 0
        ? body.allowed_sample_types.map(String)
        : SAMPLE_TYPE_ENUM

    if (!file_base64 || !file_mime_type) {
      return new Response(JSON.stringify({ error: 'file_base64 and file_mime_type are required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const supportedTypes = [
      'image/jpeg', 'image/png', 'image/webp', 'image/gif',
      'image/heic', 'image/heif', 'application/pdf',
    ]
    if (!supportedTypes.includes(file_mime_type)) {
      return new Response(JSON.stringify({ error: `Unsupported file type: ${file_mime_type}` }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    console.log(`[ai-report-import] Stage 1: Gemini vision (${file_mime_type})`)
    const extracted = await callGeminiVision(file_base64, file_mime_type, geminiApiKey, allowedSampleTypes)
    console.log(`[ai-report-import] Extracted ${extracted.analytes?.length ?? 0} analytes`)

    const currentTestGroup = {
      methodology: test_group?.methodology ?? '',
      sample_type: test_group?.sample_type ?? test_group?.sampleType ?? '',
    }

    console.log('[ai-report-import] Stage 2: Claude Haiku matching')
    const prompt = buildHaikuPrompt(
      extracted,
      existing_analytes ?? [],
      existing_tga ?? [],
      currentTestGroup
    )
    console.log(`[ai-report-import] Prompt size: ${prompt.length} chars, catalog: ${(existing_analytes ?? []).length} analytes`)
    const aiResult = await callClaudeHaiku(prompt, anthropicApiKey) as Record<string, unknown>
    console.log(`[ai-report-import] AI returned ${Array.isArray(aiResult.m) ? aiResult.m.length : (Array.isArray(aiResult.analyte_changes) ? aiResult.analyte_changes.length : 0)} matches`)
    const result = buildDeterministicResult(
      aiResult,
      extracted,
      existing_analytes ?? [],
      existing_tga ?? [],
      currentTestGroup,
      allowedSampleTypes
    )

    const enriched = {
      ...result,
      test_group_current: currentTestGroup,
    }

    console.log(
      `[ai-report-import] Done. changes=${(result.analyte_changes as unknown[])?.length ?? 0}, ` +
      `unmatched=${(result.unmatched_analytes as unknown[])?.length ?? 0}`
    )

    return new Response(JSON.stringify(enriched), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    console.error('[ai-report-import] Error:', err)
    return new Response(
      JSON.stringify({ error: 'Import failed', message: err instanceof Error ? err.message : String(err) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
