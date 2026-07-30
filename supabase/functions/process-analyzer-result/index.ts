import { createClient } from 'jsr:@supabase/supabase-js@2'
import Anthropic from 'npm:@anthropic-ai/sdk'
import { computeCalculatedResults } from './calculatedAnalytes.ts'
import { normalizeUnitForCompare, quantityKind, quantityKindsConflict } from './quantityKind.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Helper to extract Base64 images from HL7/ASTM messages
function extractEmbeddedImages(rawContent: string): Array<{ type: string; data: string; name: string }> {
  const images: Array<{ type: string; data: string; name: string }> = [];

  // Pattern 1: OBX segments with ED (Encapsulated Data) - HL7 standard
  // Format: OBX|1|ED|HISTOGRAM^WBC||^^PNG^BASE64^/9j/4AAQSkZJRgABAQAA...
  const obxEdPattern = /OBX\|[^|]*\|ED\|([^|]*)\|[^|]*\|([^^]*)\^([^^]*)\^([^^]*)\^([^|]*)/gi;
  let match;
  while ((match = obxEdPattern.exec(rawContent)) !== null) {
    const [_full, testCode, _sub, mimeType, encoding, data] = match;
    if (encoding?.toUpperCase() === 'BASE64' && data) {
      images.push({
        type: mimeType?.toLowerCase() || 'png',
        data: data.trim(),
        name: testCode || 'analyzer_image'
      });
    }
  }

  // Pattern 2: Inline base64 data (common in some analyzers)
  // Look for PNG/JPEG magic bytes in base64
  const base64Pattern = /data:image\/(png|jpeg|jpg|gif);base64,([A-Za-z0-9+/=]+)/gi;
  while ((match = base64Pattern.exec(rawContent)) !== null) {
    images.push({
      type: match[1],
      data: match[2],
      name: 'inline_image'
    });
  }

  // Pattern 3: Raw base64 blocks (PNG starts with iVBOR, JPEG with /9j/)
  const rawBase64Pattern = /(iVBOR[A-Za-z0-9+/=]{100,}|\/9j\/[A-Za-z0-9+/=]{100,})/g;
  while ((match = rawBase64Pattern.exec(rawContent)) !== null) {
    const data = match[1];
    const type = data.startsWith('iVBOR') ? 'png' : 'jpeg';
    images.push({
      type,
      data,
      name: 'raw_image'
    });
  }

  return images;
}

// Extract Octer-stream histogram data from ED-type OBX segments (3-digit decimal encoding)
function extractOcterStreamHistograms(rawContent: string): Array<{
  name: string
  testCode: string
  data: number[]
  leftLine?: number
  rightLine?: number
  divisionLines?: number[]
}> {
  const histograms: Array<{
    name: string; testCode: string; data: number[]
    leftLine?: number; rightLine?: number; divisionLines?: number[]
  }> = []

  // Match ED type OBX with Octer-stream encoding
  // Format: OBX|n|ED|CODE^Name^sys||^Application^Octer-stream^DIGITS||||||F
  const edPattern = /OBX\|\d+\|ED\|([^^|]+)\^([^^|]+)\^[^|]*\|\|[^^]*\^Application\^Octer-stream\^([0-9]+)/gi
  let match
  while ((match = edPattern.exec(rawContent)) !== null) {
    const testCode = match[1].trim()
    const name = match[2].trim()
    const digits = match[3]

    // Parse 3-digit chunks into numbers
    const data: number[] = []
    for (let i = 0; i + 3 <= digits.length; i += 3) {
      data.push(parseInt(digits.slice(i, i + 3), 10))
    }

    if (data.length > 0) {
      histograms.push({ testCode, name, data })
    }
  }

  // Parse boundary/division line values from NM segments
  const nmPattern = /OBX\|\d+\|NM\|(\d+)\^[^|]+\|\|([0-9.]+)/gi
  const lineMap = new Map<string, number>()
  while ((match = nmPattern.exec(rawContent)) !== null) {
    lineMap.set(match[1], parseFloat(match[2]))
  }

  for (const hist of histograms) {
    if (hist.testCode === '15000') { // WBC: Lym|Mid|Gran divisions
      hist.leftLine = lineMap.get('15010')
      hist.rightLine = lineMap.get('15013')
      const d1 = lineMap.get('15011'), d2 = lineMap.get('15012')
      if (d1 !== undefined && d2 !== undefined) hist.divisionLines = [d1, d2]
    } else if (hist.testCode === '15050') { // RBC
      hist.leftLine = lineMap.get('15051')
      hist.rightLine = lineMap.get('15052')
    } else if (hist.testCode === '15100') { // PLT
      hist.leftLine = lineMap.get('15111')
      hist.rightLine = lineMap.get('15112')
    }
  }

  return histograms
}

// Generate inline SVG area histogram chart
function generateHistogramSVG(
  name: string,
  data: number[],
  opts: { leftLine?: number; rightLine?: number; divisionLines?: number[]; color?: string }
): string {
  const W = 300, H = 110
  const PAD = { top: 8, right: 8, bottom: 22, left: 28 }
  const chartW = W - PAD.left - PAD.right
  const chartH = H - PAD.top - PAD.bottom

  const maxVal = Math.max(...data, 1)
  const n = data.length

  const xScale = (i: number) => PAD.left + (i / n) * chartW
  const yScale = (v: number) => PAD.top + chartH - (v / maxVal) * chartH

  // Area fill path
  let path = `M${PAD.left},${PAD.top + chartH}`
  for (let i = 0; i < n; i++) {
    path += ` L${xScale(i).toFixed(1)},${yScale(data[i]).toFixed(1)}`
  }
  path += ` L${(PAD.left + chartW).toFixed(1)},${PAD.top + chartH} Z`

  const color = opts.color ?? '#3B82F6'

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`
  svg += `<rect width="${W}" height="${H}" fill="white" stroke="#E5E7EB" stroke-width="0.5" rx="3"/>`

  // Area
  svg += `<path d="${path}" fill="${color}" fill-opacity="0.25" stroke="${color}" stroke-width="1.2"/>`

  // Division lines (e.g. Lym|Mid|Gran for WBC)
  if (opts.divisionLines) {
    for (const dl of opts.divisionLines) {
      const x = xScale(dl).toFixed(1)
      svg += `<line x1="${x}" y1="${PAD.top}" x2="${x}" y2="${PAD.top + chartH}" stroke="#9CA3AF" stroke-width="1" stroke-dasharray="3,2"/>`
    }
  }

  // Left/right gate markers
  if (opts.leftLine !== undefined) {
    const x = xScale(opts.leftLine).toFixed(1)
    svg += `<line x1="${x}" y1="${PAD.top}" x2="${x}" y2="${PAD.top + chartH}" stroke="#EF4444" stroke-width="1.2"/>`
  }
  if (opts.rightLine !== undefined) {
    const x = xScale(opts.rightLine).toFixed(1)
    svg += `<line x1="${x}" y1="${PAD.top}" x2="${x}" y2="${PAD.top + chartH}" stroke="#EF4444" stroke-width="1.2"/>`
  }

  // Y-axis ticks (0, mid, max)
  svg += `<line x1="${PAD.left}" y1="${PAD.top}" x2="${PAD.left}" y2="${PAD.top + chartH}" stroke="#6B7280" stroke-width="0.8"/>`
  svg += `<text x="${PAD.left - 3}" y="${PAD.top + 4}" text-anchor="end" font-size="7" fill="#6B7280" font-family="sans-serif">${maxVal}</text>`
  svg += `<text x="${PAD.left - 3}" y="${PAD.top + chartH / 2 + 3}" text-anchor="end" font-size="7" fill="#6B7280" font-family="sans-serif">${Math.round(maxVal / 2)}</text>`
  svg += `<text x="${PAD.left - 3}" y="${PAD.top + chartH}" text-anchor="end" font-size="7" fill="#6B7280" font-family="sans-serif">0</text>`

  // X-axis
  svg += `<line x1="${PAD.left}" y1="${PAD.top + chartH}" x2="${PAD.left + chartW}" y2="${PAD.top + chartH}" stroke="#6B7280" stroke-width="0.8"/>`

  // Title
  svg += `<text x="${W / 2}" y="${H - 5}" text-anchor="middle" font-size="9" fill="#374151" font-family="sans-serif" font-weight="600">${name}</text>`

  svg += `</svg>`
  return svg
}

function formatCalculatedResult(value: number): string {
  if (!Number.isFinite(value)) return String(value)
  const rounded = value.toFixed(6).replace(/\.?0+$/, '')
  return rounded === '-0' ? '0' : rounded
}

// Fixed-precision variant of formatCalculatedResult. Keeps trailing zeros —
// a 2 dp analyte should read "5.00", not "5" — but never emits "-0".
function formatFixedResult(value: number, decimals: number): string {
  if (!Number.isFinite(value)) return String(value)
  const fixed = value.toFixed(decimals)
  return Number(fixed) === 0 ? (0).toFixed(decimals) : fixed
}

function parseHl7Components(value: string | undefined): string[] {
  return String(value ?? '').split('^')
}

function firstComponent(value: string | undefined): string {
  return parseHl7Components(value)[0]?.trim() ?? ''
}

function normalizeHl7Flag(value: string | undefined): string {
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
// Ported from src/utils/flagDetermination.ts. Output vocabulary matches the HL7
// flags this path already stores: 'N','H','L','HH','LL','A'. `flag_source` is
// constrained (see 20260610_allow_analyzer_flag_source.sql), so computed flags
// are tagged 'auto_numeric' (numeric result) or 'auto_text' (qualitative result).

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
    .replace(/\([^)]*\)/g, '')       // drop parenthetical notes e.g. "(Optimal)"
    .replace(/[a-zA-Z%\/]+/g, ' ')   // drop units e.g. mg/dL, U/L
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

// Determine the abnormal flag for a result value by comparing it against the
// lab-saved reference range (and optional critical thresholds). Returns the flag
// plus a constraint-valid flag_source. Falls back to 'N' when nothing is
// parseable so a result is never dropped.
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
    return { flag: 'N', source: 'auto_numeric' } // numeric value, no parseable range
  }

  // Qualitative / text result — compare against expected normal values or the
  // reference-range text.
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

function normalizeSectionKey(value: unknown): string {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

function isUuid(value: unknown): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value ?? ''))
}

function normalizeSectionContent(value: unknown): string | null {
  const content = String(value ?? '').replace(/\r\n/g, '\n').trim()
  if (!content) return null

  const placeholder = content.toUpperCase()
  if (['NULL', 'N/A', 'NA', 'NIL', '*****', '****', '***'].includes(placeholder)) return null
  return content
}

function looksLikeNarrativeResult(item: any): boolean {
  const value = normalizeSectionContent(item?.value)
  if (!value) return false

  const valueType = String(item?.value_type ?? item?.type ?? '').trim().toUpperCase()
  if (['TX', 'FT', 'ST', 'TEXT'].includes(valueType)) return true
  if (value.includes('\n')) return true
  if (/[A-Za-z]{4,}/.test(value) && value.length >= 20) return true
  return false
}

function formatSectionContentFromResult(item: any): string | null {
  const value = normalizeSectionContent(item?.content ?? item?.value ?? item?.text ?? item?.final_content)
  if (!value) return null

  const name = String(item?.section_name ?? item?.name ?? '').trim()
  const code = String(item?.test_code ?? item?.machine_code ?? item?.analyzer_code ?? '').trim()
  const prefix = name && !value.toLowerCase().startsWith(name.toLowerCase())
    ? `${name}: `
    : ''

  if (prefix) return `${prefix}${value}`
  if (code && value.length < 20) return `${code}: ${value}`
  return value
}

function mergeSectionContent(previous: string | null | undefined, next: string): string {
  const oldContent = String(previous ?? '').trim()
  const newContent = next.trim()
  if (!oldContent) return newContent
  if (!newContent) return oldContent
  if (oldContent === newContent) return oldContent
  if (oldContent.includes(newContent)) return oldContent
  return `${oldContent}\n\n${newContent}`
}

function updateSectionContent(previous: string | null | undefined, next: string): string {
  const oldContent = String(previous ?? '').trim()
  const newContent = next.trim()
  if (!oldContent) return newContent
  if (!newContent) return oldContent
  if (oldContent === newContent) return oldContent
  if (newContent.includes(oldContent)) return newContent
  if (oldContent.includes(newContent)) return oldContent
  return newContent
}

type SectionDefinition = {
  id: string
  test_group_id: string
  section_type: string | null
  section_name: string
  placeholder_key: string | null
  display_order: number | null
  default_content?: string | null
}

type SectionOnlyGroup = {
  test_group_id: string
  test_group_name: string
  order_test_group_id: string | null
  order_test_id: string | null
  sections: SectionDefinition[]
}

type SectionCandidate = {
  test_code: string
  name: string
  content: string
  test_group_id?: string | null
  section_id?: string | null
  section_key?: string | null
  source: string
}

async function loadSectionOnlyGroups(supabase: any, orderId: string, labId: string): Promise<SectionOnlyGroup[]> {
  const groups = new Map<string, SectionOnlyGroup>()

  const { data: otgRows, error: otgError } = await supabase
    .from('order_test_groups')
    .select('id, test_group_id, test_groups!inner(id, name, is_section_only)')
    .eq('order_id', orderId)
    .eq('test_groups.is_section_only', true)

  if (otgError) console.warn('Failed to load section-only order_test_groups:', otgError)

  for (const row of otgRows ?? []) {
    const tg = row.test_groups
    if (!tg?.id) continue
    groups.set(tg.id, {
      test_group_id: tg.id,
      test_group_name: tg.name || 'Section Report',
      order_test_group_id: row.id,
      order_test_id: null,
      sections: [],
    })
  }

  const { data: otRows, error: otError } = await supabase
    .from('order_tests')
    .select('id, test_group_id, test_groups!inner(id, name, is_section_only)')
    .eq('order_id', orderId)
    .eq('test_groups.is_section_only', true)

  if (otError) console.warn('Failed to load section-only order_tests:', otError)

  for (const row of otRows ?? []) {
    const tg = row.test_groups
    if (!tg?.id) continue
    const existing = groups.get(tg.id)
    groups.set(tg.id, {
      test_group_id: tg.id,
      test_group_name: tg.name || existing?.test_group_name || 'Section Report',
      order_test_group_id: existing?.order_test_group_id ?? null,
      order_test_id: row.id || existing?.order_test_id || null,
      sections: existing?.sections ?? [],
    })
  }

  const testGroupIds = [...groups.keys()]
  if (testGroupIds.length === 0) return []

  const { data: sections, error: sectionsError } = await supabase
    .from('lab_template_sections')
    .select('id, test_group_id, section_type, section_name, placeholder_key, display_order, default_content')
    .eq('lab_id', labId)
    .in('test_group_id', testGroupIds)
    .order('display_order', { ascending: true })

  if (sectionsError) {
    console.warn('Failed to load section-only template sections:', sectionsError)
    return [...groups.values()]
  }

  for (const section of sections ?? []) {
    const group = groups.get(section.test_group_id)
    if (!group) continue
    group.sections.push(section)
  }

  return [...groups.values()].filter((group) => group.sections.length > 0)
}

function extractSectionCandidates(parsedData: any): SectionCandidate[] {
  const candidates: SectionCandidate[] = []

  for (const item of parsedData?.section_results ?? []) {
    const content = formatSectionContentFromResult(item)
    if (!content) continue
    candidates.push({
      test_code: String(item.test_code ?? item.machine_code ?? item.analyzer_code ?? item.section_key ?? '').toUpperCase(),
      name: String(item.section_name ?? item.name ?? item.section_key ?? '').trim(),
      content,
      test_group_id: item.test_group_id || null,
      section_id: item.section_id || null,
      section_key: item.section_key || item.placeholder_key || item.section_type || null,
      source: 'section_results',
    })
  }

  for (const item of parsedData?.results ?? []) {
    if (!looksLikeNarrativeResult(item)) continue
    const content = formatSectionContentFromResult(item)
    if (!content) continue
    candidates.push({
      test_code: String(item.test_code ?? '').toUpperCase(),
      name: String(item.name ?? item.test_name ?? '').trim(),
      content,
      test_group_id: item.test_group_id || null,
      section_id: item.section_id || null,
      section_key: item.section_key || item.placeholder_key || null,
      source: 'narrative_result',
    })
  }

  return candidates
}

function findMatchingSection(
  candidate: SectionCandidate,
  groups: SectionOnlyGroup[],
  mapping: any | null,
): { group: SectionOnlyGroup; section: SectionDefinition } | null {
  const mappedSectionId = mapping?.section_id || candidate.section_id
  if (mappedSectionId && isUuid(mappedSectionId)) {
    for (const group of groups) {
      const section = group.sections.find((s) => s.id === mappedSectionId)
      if (section) return { group, section }
    }
  }

  const mappedGroupId = mapping?.test_group_id || candidate.test_group_id
  const targetGroups = mappedGroupId
    ? groups.filter((group) => group.test_group_id === mappedGroupId)
    : groups

  if (targetGroups.length === 0) return null

  const sectionKeys = [
    candidate.section_key,
    mapping?.lims_code,
    mapping?.test_name,
    candidate.name,
    candidate.test_code,
  ].map(normalizeSectionKey).filter(Boolean)

  for (const group of targetGroups) {
    for (const section of group.sections) {
      const possibleKeys = [
        section.id,
        section.placeholder_key,
        section.section_type,
        section.section_name,
      ].map(normalizeSectionKey).filter(Boolean)

      if (sectionKeys.some((key) => possibleKeys.some((sectionKey) => key === sectionKey || key.includes(sectionKey) || sectionKey.includes(key)))) {
        return { group, section }
      }
    }
  }

  if (targetGroups.length === 1 && targetGroups[0].sections.length === 1) {
    return { group: targetGroups[0], section: targetGroups[0].sections[0] }
  }

  if (targetGroups.length === 1) {
    const firstEditable = [...targetGroups[0].sections].sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0))[0]
    if (firstEditable) return { group: targetGroups[0], section: firstEditable }
  }

  return null
}

async function getOrCreateSectionResult(
  supabase: any,
  params: {
    orderId: string
    patientId: string
    patientName: string
    labId: string
    group: SectionOnlyGroup
  },
): Promise<any | null> {
  const { data: existing, error: existingError } = await supabase
    .from('results')
    .select('id, verification_status, test_group_id, order_test_group_id, order_test_id')
    .eq('order_id', params.orderId)
    .eq('test_group_id', params.group.test_group_id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (existingError) {
    console.warn('Failed to load section result row:', existingError)
  }
  if (existing) return existing

  const resultPayload = {
    order_id: params.orderId,
    patient_id: params.patientId,
    patient_name: params.patientName,
    test_name: params.group.test_group_name,
    status: 'Entered',
    entered_by: 'AI Interface',
    entered_date: new Date().toISOString().split('T')[0],
    test_group_id: params.group.test_group_id,
    lab_id: params.labId,
    ...(params.group.order_test_group_id && { order_test_group_id: params.group.order_test_group_id }),
    ...(params.group.order_test_id && { order_test_id: params.group.order_test_id }),
  }

  const { data: created, error: createError } = await supabase
    .from('results')
    .upsert(resultPayload, { onConflict: 'order_id,test_name', ignoreDuplicates: false })
    .select('id, verification_status, test_group_id, order_test_group_id, order_test_id')
    .single()

  if (createError) {
    console.error('Failed to create section result row:', createError)
    return null
  }

  return created
}

// Get-or-create ONE results header per test_group, mirroring the manual entry
// path (save_result_entry_bulk). The UI matches each panel to its header by
// results.test_group_id, so a multi-panel order needs one header per panel.
// Analyzer results were previously dumped into a single 'Analyzer Result' header
// tagged with one (dominant) group, so only that one panel ever displayed them.
async function getOrCreateGroupResult(
  supabase: any,
  params: {
    orderId: string
    patientId: string
    patientName: string
    labId: string
    testGroupId: string
    testGroupName: string
    orderTestGroupId: string | null
    orderTestId: string | null
  },
): Promise<{ id: string } | null> {
  // 1. Reuse an existing per-panel header (manual entry, or a prior analyzer run).
  //    Match only on UUID columns — test_name can contain commas/parentheses that
  //    would break a PostgREST .or() filter.
  const orFilters: string[] = []
  if (params.orderTestGroupId) orFilters.push(`order_test_group_id.eq.${params.orderTestGroupId}`)
  if (params.orderTestId) orFilters.push(`order_test_id.eq.${params.orderTestId}`)
  if (params.testGroupId) orFilters.push(`test_group_id.eq.${params.testGroupId}`)

  if (orFilters.length > 0) {
    const { data: existing } = await supabase
      .from('results')
      .select('id')
      .eq('order_id', params.orderId)
      .or(orFilters.join(','))
      .limit(1)
      .maybeSingle()
    if (existing?.id) return existing
  }

  // 2. Create the panel header. On a (order_id, test_name) collision reuse the
  //    existing row rather than overwrite it — never clobber a manual header.
  const { data: created, error } = await supabase
    .from('results')
    .insert({
      order_id: params.orderId,
      patient_id: params.patientId,
      patient_name: params.patientName,
      lab_id: params.labId,
      test_name: params.testGroupName,
      test_group_id: params.testGroupId,
      order_test_group_id: params.orderTestGroupId,
      order_test_id: params.orderTestId,
      status: 'Entered',
      verification_status: 'pending_verification',
      entered_by: 'AI Interface',
      entered_date: new Date().toISOString().split('T')[0],
    })
    .select('id')
    .single()

  if (!error) return created
  if (error.code === '23505') {
    const { data: dup } = await supabase
      .from('results')
      .select('id')
      .eq('order_id', params.orderId)
      .eq('test_name', params.testGroupName)
      .limit(1)
      .maybeSingle()
    return dup ?? null
  }
  console.error('Failed to create group result header:', error)
  return null
}

async function upsertAnalyzerSectionContent(
  supabase: any,
  params: {
    orderId: string
    patientId: string
    patientName: string
    labId: string
    record: any
    parsedData: any
  },
): Promise<{ saved: number; skipped: number; log: string }> {
  const groups = await loadSectionOnlyGroups(supabase, params.orderId, params.labId)
  if (groups.length === 0) return { saved: 0, skipped: 0, log: 'No section-only groups found. ' }

  const candidates = extractSectionCandidates(params.parsedData)
  if (candidates.length === 0) return { saved: 0, skipped: 0, log: 'No section content found. ' }

  const machineCodes = [...new Set(candidates.map((candidate) => candidate.test_code).filter(Boolean))]
  const sectionMappings = new Map<string, any>()

  if (machineCodes.length > 0) {
    let mappingQuery = supabase
      .from('test_mappings')
      .select('analyzer_code, lims_code, test_name, test_group_id, section_id, ai_confidence, analyzer_connection_id')
      .eq('lab_id', params.labId)
      .eq('mapping_type', 'result_section')
      .in('direction', ['inbound', 'bidirectional'])
      .in('analyzer_code', machineCodes)

    if (params.record.analyzer_connection_id) {
      mappingQuery = mappingQuery.or(`analyzer_connection_id.eq.${params.record.analyzer_connection_id},analyzer_connection_id.is.null`)
    }

    const { data: mappingRows, error: mappingError } = await mappingQuery
    if (mappingError) {
      console.warn('Section mapping lookup failed:', mappingError)
    } else {
      const specificity = (row: any) => params.record.analyzer_connection_id && row.analyzer_connection_id === params.record.analyzer_connection_id ? 2 : 1
      for (const row of (mappingRows ?? []).sort((a: any, b: any) => specificity(a) - specificity(b))) {
        const code = String(row.analyzer_code ?? '').toUpperCase()
        if (code) sectionMappings.set(code, row)
      }
    }
  }

  const mergedBySection = new Map<string, {
    group: SectionOnlyGroup
    section: SectionDefinition
    content: string
    sources: string[]
  }>()

  let skipped = 0
  for (const candidate of candidates) {
    const mapping = candidate.test_code ? sectionMappings.get(candidate.test_code) ?? null : null
    const target = findMatchingSection(candidate, groups, mapping)
    if (!target) {
      skipped++
      continue
    }

    const key = `${target.group.test_group_id}:${target.section.id}`
    const existing = mergedBySection.get(key)
    if (existing) {
      existing.content = mergeSectionContent(existing.content, candidate.content)
      existing.sources.push(candidate.source)
    } else {
      mergedBySection.set(key, {
        group: target.group,
        section: target.section,
        content: candidate.content,
        sources: [candidate.source],
      })
    }
  }

  let saved = 0
  for (const entry of mergedBySection.values()) {
    const resultRow = await getOrCreateSectionResult(supabase, {
      orderId: params.orderId,
      patientId: params.patientId,
      patientName: params.patientName,
      labId: params.labId,
      group: entry.group,
    })

    if (!resultRow?.id) {
      skipped++
      continue
    }

    if (resultRow.verification_status === 'verified') {
      skipped++
      continue
    }

    const { data: existingContent, error: contentFetchError } = await supabase
      .from('result_section_content')
      .select('id, final_content, is_finalized')
      .eq('result_id', resultRow.id)
      .eq('section_id', entry.section.id)
      .maybeSingle()

    if (contentFetchError) {
      console.warn('Failed to fetch existing section content:', contentFetchError)
    }

    if (existingContent?.is_finalized) {
      skipped++
      continue
    }

    const finalContent = updateSectionContent(existingContent?.final_content, entry.content)
    const payload = {
      result_id: resultRow.id,
      section_id: entry.section.id,
      selected_options: [],
      custom_text: finalContent,
      final_content: finalContent,
      image_urls: [],
      cascading_selections: {},
      edited_at: new Date().toISOString(),
    }

    const { error: upsertError } = await supabase
      .from('result_section_content')
      .upsert(payload, { onConflict: 'result_id,section_id' })

    if (upsertError) {
      console.error('Failed to upsert analyzer section content:', upsertError)
      skipped++
    } else {
      saved++
    }
  }

  return {
    saved,
    skipped,
    log: saved > 0
      ? `Updated ${saved} section content row(s). ${skipped ? `Skipped ${skipped}. ` : ''}`
      : `No section content updated. ${skipped ? `Skipped ${skipped}. ` : ''}`,
  }
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

  if (grouped.size === 0) {
    logAiRefRange('resolver_skipped_no_candidates', { order_id: orderId })
    return resolvedByKey
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !serviceRoleKey) {
    logAiRefRange('resolver_skipped_missing_credentials', {
      order_id: orderId,
      test_group_count: grouped.size,
    })
    return resolvedByKey
  }

  logAiRefRange('resolver_started', {
    order_id: orderId,
    test_group_count: grouped.size,
    analyte_count: candidates.length,
  })

  for (const [testGroupId, groupCandidates] of grouped) {
    try {
      const startedAt = Date.now()
      logAiRefRange('group_request_started', {
        order_id: orderId,
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
        test_group_id: testGroupId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  logAiRefRange('resolver_completed', {
    order_id: orderId,
    resolved_count: resolvedByKey.size,
  })
  return resolvedByKey
}

// Pick the most barcode-like token from a set of candidate HL7 fields.
// The sample ID sits in different OBR fields per analyzer: OBR-2 on Tulip
// (OBR-3 is a bare counter like "1"), OBR-3 on FineCare (OBR-2 is an internal
// cartridge ID like "F25715503"), OBR-18 on Peerless HA560. Matching a wrong or
// trivial token against the wildcard sample lookup would attach results to an
// arbitrary sample, so prefer a real LIS-barcode-shaped token.
function pickSampleId(candidates: Array<string | undefined>): string {
  const cleaned = candidates
    .map((c) => firstComponent(c))
    .map((c) => c.replace(/^["']+|["']+$/g, '').trim())
    .filter((c) => c && !/^0+$/.test(c))
  // 1. Prefer a numeric sample-barcode-shaped token. LIS barcodes here are
  //    date-prefixed all-digit strings (e.g. 2607220002); this rejects both bare
  //    counters ("1") and alpha-prefixed analyzer internal IDs ("F25715503").
  const numeric = cleaned.find((c) => /^\d{6,}$/.test(c))
  if (numeric) return numeric
  // 2. Otherwise the first reasonably-long token (avoids counters like "1").
  return cleaned.find((c) => c.length >= 3) || cleaned[0] || ''
}

function parseHl7ResultsDeterministic(rawContent: string): {
  sample_barcode: string
  results: Array<{ test_code: string; name: string; value: string; unit: string; flag: string; reference_range: string; value_type?: string }>
  instrument: string
  graphs: Array<{ type: string; name: string; test_code: string; description: string; associated_test: string }>
} | null {
  const segments = rawContent.split(/\r|\n/).map((s) => s.trim()).filter(Boolean)
  if (!segments.some((s) => s.startsWith('MSH|'))) return null

  const msh = segments.find((s) => s.startsWith('MSH|'))?.split('|') ?? []
  const instrument = [msh[2], msh[3]].filter(Boolean).join('^')
  let sampleBarcode = ''

  for (const segment of segments) {
    const fields = segment.split('|')
    if (fields[0] === 'OBR') {
      // Sample ID placement varies by analyzer: OBR-2 (Placer, e.g. Tulip),
      // OBR-3 (Filler), or OBR-18 (Placer Field 1, e.g. Peerless HA560). Prefer a
      // real barcode-shaped token over an analyzer-assigned counter like "1".
      sampleBarcode = pickSampleId([fields[2], fields[18], fields[3]]) || sampleBarcode
    } else if (fields[0] === 'ORC') {
      sampleBarcode = firstComponent(fields[2]) || sampleBarcode
    } else if (fields[0] === 'PID') {
      sampleBarcode = firstComponent(fields[3]) || sampleBarcode
    }
  }

  const results: Array<{ test_code: string; name: string; value: string; unit: string; flag: string; reference_range: string; value_type?: string }> = []
  const graphs: Array<{ type: string; name: string; test_code: string; description: string; associated_test: string }> = []

  for (const segment of segments) {
    const fields = segment.split('|')
    if (fields[0] !== 'OBX') continue

    const valueType = String(fields[2] ?? '').trim().toUpperCase()
    const idParts = parseHl7Components(fields[3])
    let testCode = (idParts[0] || '').trim()
    let name = (idParts[1] || testCode).trim()
    let value = String(fields[5] ?? '').trim()

    // Some analyzers (e.g. Tulip) put a placeholder in OBX-3 and the real analyte
    // mnemonic in OBX-4 (Observation Sub-ID), e.g. OBX-3="0", OBX-4="IRON".
    const subId = firstComponent(fields[4])
    if ((!testCode || /^0+$/.test(testCode)) && /[A-Za-z]/.test(subId)) {
      testCode = subId
      name = subId
    }

    // Some analyzers (e.g. FineCare) embed the unit in the value field
    // (OBX-5 = "5.71 ng/mL") while also sending it in OBX-6. For numeric results,
    // keep just the leading number so the stored value is clean.
    if (valueType === 'NM') {
      value = value.replace(/^([+-]?\d*\.?\d+)\s+\S.*$/, '$1')
    }

    if (!testCode) continue

    if (['ED', 'NA'].includes(valueType)) {
      graphs.push({
        type: valueType === 'ED' ? 'histogram' : 'waveform',
        name,
        test_code: testCode,
        description: name,
        associated_test: '',
      })
      continue
    }

    results.push({
      test_code: testCode,
      name,
      value,
      unit: firstComponent(fields[6]),
      reference_range: String(fields[7] ?? '').trim(),
      flag: normalizeHl7Flag(fields[8]),
      value_type: valueType,
    })
  }

  if (!sampleBarcode && results.length === 0) return null
  return { sample_barcode: sampleBarcode, results, instrument, graphs }
}

// Extract the human-readable assay name from an ASTM Universal Test ID.
// Format is `^^^TT4 II` (components separated by ^); the assay name is the last
// non-empty component.
function astmTestName(universalTestId: string | undefined): string {
  const parts = parseHl7Components(universalTestId)
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i]?.trim()
    if (part) return part
  }
  return ''
}

// Deterministic parser for ASTM E1394 messages (Snibe Maglumi and similar).
// Records are \r-delimited and typed by their first field: H(eader), P(atient),
// O(rder), R(esult), L(erminator). Tolerates a stripped leading `H` on the
// header — detection keys off the `R` result records, not the header.
function parseAstmResultsDeterministic(rawContent: string): {
  sample_barcode: string
  results: Array<{ test_code: string; name: string; value: string; unit: string; flag: string; reference_range: string; value_type?: string }>
  instrument: string
  graphs: Array<{ type: string; name: string; test_code: string; description: string; associated_test: string }>
} | null {
  const segments = rawContent.split(/\r|\n/).map((s) => s.trim()).filter(Boolean)
  if (!segments.some((s) => /^R\|\d+\|/.test(s))) return null

  let sampleBarcode = ''
  let instrument = ''
  const results: Array<{ test_code: string; name: string; value: string; unit: string; flag: string; reference_range: string; value_type?: string }> = []

  for (const segment of segments) {
    const fields = segment.split('|')
    const recordType = (fields[0] ?? '').trim().toUpperCase()

    // Header record: proper `H` first field, or a header whose leading `H` was
    // stripped by framing (identified by the ASTM delimiter-definition token).
    if (recordType === 'H' || segment.startsWith('\\^&') || segment.startsWith('|\\^&')) {
      // Sender/instrument name sits in the early sender fields (e.g. "Maglumi User").
      instrument = fields[4]?.trim() || fields[3]?.trim() || instrument
      continue
    }

    if (recordType === 'O') {
      // O-3 = specimen/sample ID (the LIMS sample barcode).
      sampleBarcode = firstComponent(fields[2]) || firstComponent(fields[3]) || sampleBarcode
      continue
    }

    if (recordType === 'R') {
      // R-3 = Universal Test ID, R-4 = value, R-5 = unit, R-6 = reference range,
      // R-7 = abnormal flag.
      const testCode = astmTestName(fields[2])
      const value = String(fields[3] ?? '').trim()
      if (!testCode) continue
      results.push({
        test_code: testCode,
        name: testCode,
        value,
        unit: firstComponent(fields[4]),
        reference_range: String(fields[5] ?? '').trim(),
        flag: normalizeHl7Flag(fields[6]),
        value_type: 'NM',
      })
    }
  }

  if (!sampleBarcode && results.length === 0) return null
  return { sample_barcode: sampleBarcode, results, instrument, graphs: [] }
}

async function saveAnalyzerLearning(
  supabase: any,
  record: any,
  parsedData: any,
  messageType: string,
) {
  const sampleResults = (parsedData.results ?? [])
    .slice(0, 25)
    .map((r: any) => `${r.test_code}${r.name ? ` (${r.name})` : ''}`)
    .join(', ')

  await supabase.from('analyzer_knowledge').insert({
    lab_id: record.lab_id,
    knowledge_type: 'protocol',
    title: `${messageType || 'HL7'} ${parsedData.instrument || record.analyzer_connection_id || 'analyzer'} message`,
    content: [
      `message_type=${messageType || 'UNKNOWN'}`,
      `analyzer_connection_id=${record.analyzer_connection_id || ''}`,
      `instrument=${parsedData.instrument || ''}`,
      `sample_barcode_field=OBR-3/OBR-2/PID-3`,
      `result_format=HL7_OBX`,
      `result_codes=${sampleResults}`,
    ].join('\n'),
    metadata: {
      analyzer_connection_id: record.analyzer_connection_id,
      message_type: messageType || null,
      sample_barcode: parsedData.sample_barcode || null,
      parser: 'deterministic_hl7_obx',
      result_count: parsedData.results?.length ?? 0,
      graph_count: parsedData.graphs?.length ?? 0,
      raw_message_id: record.id,
    },
    confidence_score: 0.8,
  })
}

// Extract the message/run date from an HL7 (MSH-7 / OBR-7) or ASTM message.
// Sample barcodes are date-prefixed (YYMMDDSSSS), so the run date is what lets us
// scope a bare analyzer sequence ("9") to the correct day instead of matching an
// arbitrary previous-day sample. Returns the 6-digit YYMMDD prefix, or null.
function extractMessageDatePrefix(rawContent: string): string | null {
  const segments = rawContent.split(/\r|\n/).map((s) => s.trim()).filter(Boolean)

  const timestampCandidates: Array<string | undefined> = []
  const msh = segments.find((s) => s.startsWith('MSH|'))?.split('|')
  if (msh) timestampCandidates.push(msh[6]) // MSH-7 Date/Time Of Message
  const obr = segments.find((s) => s.startsWith('OBR|'))?.split('|')
  if (obr) timestampCandidates.push(obr[7]) // OBR-7 Observation Date/Time

  for (const raw of timestampCandidates) {
    const match = String(raw ?? '').trim().match(/^(\d{2})(\d{2})(\d{2})(\d{2})/)
    // Matches YYYYMMDD (captures YY MM DD from the first 8 digits).
    if (match) {
      const [, , yy, mm, dd] = match
      return `${yy}${mm}${dd}`
    }
  }
  return null
}

// Resolve the analyzer's parsed sample barcode to an actual sample row, in
// priority order so a bare operator-typed sequence never latches onto a stale
// previous-day sample:
//   1. Exact barcode match (analyzer sent the full LIS barcode).
//   2. Bare sequence ("9","10"): reconstruct the date-prefixed barcode
//      (YYMMDD + sequence) for the message's own day and match within that day.
//   3. Last-resort wildcard, but ordered most-recent-first so a current sample
//      always outranks an old one.
async function findSampleForBarcode(
  supabase: any,
  labId: string,
  barcode: string,
  datePrefix: string | null,
): Promise<{ sample: any; matchType: string } | null> {
  const selectCols = 'id, order_id, lab_id, barcode, created_at'

  // 1. Exact match.
  const { data: exact } = await supabase
    .from('samples')
    .select(selectCols)
    .eq('lab_id', labId)
    .eq('barcode', barcode)
    .order('created_at', { ascending: false })
    .limit(1)
  if (exact && exact.length > 0) return { sample: exact[0], matchType: 'exact' }

  // 2. Bare sequence scoped to the message's day.
  if (/^\d{1,4}$/.test(barcode) && datePrefix) {
    const seq = parseInt(barcode, 10)

    // 2a. Standard YYMMDDSSSS barcode (4-digit zero-padded sequence).
    const candidate = `${datePrefix}${String(seq).padStart(4, '0')}`
    const { data: reconstructed } = await supabase
      .from('samples')
      .select(selectCols)
      .eq('lab_id', labId)
      .eq('barcode', candidate)
      .order('created_at', { ascending: false })
      .limit(1)
    if (reconstructed && reconstructed.length > 0) {
      return { sample: reconstructed[0], matchType: 'same_day_sequence' }
    }

    // 2b. Same day, tolerating non-standard sequence widths/padding.
    const { data: sameDay } = await supabase
      .from('samples')
      .select(selectCols)
      .eq('lab_id', labId)
      .like('barcode', `${datePrefix}%`)
      .order('created_at', { ascending: false })
      .limit(500)
    const match = (sameDay ?? []).find((row: any) => {
      const suffix = String(row.barcode ?? '').slice(datePrefix.length)
      return /^\d+$/.test(suffix) && parseInt(suffix, 10) === seq
    })
    if (match) return { sample: match, matchType: 'same_day_sequence' }
  }

  // 3. Wildcard fallback (most recent first).
  const { data: wildcard } = await supabase
    .from('samples')
    .select(selectCols)
    .eq('lab_id', labId)
    .ilike('barcode', `%${barcode}%`)
    .order('created_at', { ascending: false })
    .limit(1)
  if (wildcard && wildcard.length > 0) return { sample: wildcard[0], matchType: 'wildcard' }

  return null
}

// Helper to extract histogram/waveform numeric data
function extractWaveformData(rawContent: string): Array<{ name: string; data: number[] }> {
  const waveforms: Array<{ name: string; data: number[] }> = [];

  // Pattern: OBX with NA (Numeric Array) data type
  // Format: OBX|1|NA|HISTOGRAM^RBC||12^15^18^22^...
  const naPattern = /OBX\|[^|]*\|NA\|([^|]*)\|[^|]*\|([^|]*)/gi;
  let match;
  while ((match = naPattern.exec(rawContent)) !== null) {
    const name = match[1]?.split('^')[0] || 'histogram';
    const dataStr = match[2];
    if (dataStr) {
      const numbers = dataStr.split('^').map(n => parseFloat(n)).filter(n => !isNaN(n));
      if (numbers.length > 0) {
        waveforms.push({ name, data: numbers });
      }
    }
  }

  return waveforms;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // 1. Parse Webhook Payload
    const payload = await req.json()
    const { record } = payload

    if (!record || !record.raw_content) {
        return new Response(JSON.stringify({ message: 'No record content' }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 200
        })
    }

    // 2. Init Supabase (Admin Client)
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const mshFields = String(record.raw_content).split(/\r|\n/).find((s) => s.startsWith('MSH|'))?.split('|') ?? []
    const hl7MessageType = mshFields[8] || record.message_type || ''
    const hasResultObx = /\r?OBX\|/i.test(record.raw_content)
    // ASTM E1394 analyzers (e.g. Snibe Maglumi) carry results in `R` records, not
    // HL7 OBX segments, and often have no MSH. Some framing strips the leading `H`
    // of the header, so key off the result record itself: `R|<seq>|` at a line
    // boundary. HL7 has no single-letter `R` segment, so this is unambiguous.
    const hasAstmResult = /(^|[\r\n])R\|\d+\|/.test(record.raw_content)
    const isResultMessage =
      hl7MessageType.includes('ORU') ||
      hl7MessageType.includes('ASTM_RESULT') ||
      hasResultObx ||
      hasAstmResult

    if (!isResultMessage) {
      await supabase
        .from('analyzer_raw_messages')
        .update({
          ai_status: 'completed',
          message_type: hl7MessageType || record.message_type || 'NON_RESULT',
          ai_result: {
            ignored: true,
            reason: 'non_result_message',
            message_type: hl7MessageType || record.message_type || null,
          },
        })
        .eq('id', record.id)

      return new Response(JSON.stringify({
        success: true,
        ignored: true,
        reason: 'non_result_message',
        message_type: hl7MessageType || null,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // 3. Init AI
    const anthropic = new Anthropic({ apiKey: Deno.env.get('ANTHROPIC_API_KEY') || '' })
    const MODEL = 'claude-haiku-4-5-20251001'

    // Per-connection toggle: derive reference range + flag from the lab's SAVED
    // reference ranges instead of trusting the analyzer's OBX-7/OBX-8. Defaults ON;
    // only an explicit `use_saved_reference_ranges: false` in the connection config
    // reverts to storing the machine-provided range and flag.
    let useSavedReferenceRanges = true
    if (record.analyzer_connection_id) {
      const { data: connRow } = await supabase
        .from('analyzer_connections')
        .select('config')
        .eq('id', record.analyzer_connection_id)
        .maybeSingle()
      if (connRow?.config?.use_saved_reference_ranges === false) useSavedReferenceRanges = false
    }
    console.log(`DEBUG: use_saved_reference_ranges=${useSavedReferenceRanges} for connection ${record.analyzer_connection_id || 'none'}`)

    // 3a. Extract embedded images, waveform data, and Octer-stream histograms
    const embeddedImages = extractEmbeddedImages(record.raw_content);
    const waveformData = extractWaveformData(record.raw_content);
    const octerHistograms = extractOcterStreamHistograms(record.raw_content);

    // Generate SVG charts for each decoded histogram
    const histogramColors: Record<string, string> = {
      '15000': '#3B82F6', // WBC — blue
      '15050': '#EF4444', // RBC — red
      '15100': '#F59E0B', // PLT — amber
    }
    const generatedHistogramSVGs = octerHistograms.map(h => ({
      testCode: h.testCode,
      name: h.name,
      channels: h.data.length,
      svg: generateHistogramSVG(h.name, h.data, {
        leftLine: h.leftLine,
        rightLine: h.rightLine,
        divisionLines: h.divisionLines,
        color: histogramColors[h.testCode] ?? '#6366F1',
      }),
    }))

    console.log(`📊 Found ${embeddedImages.length} images, ${waveformData.length} waveforms, ${octerHistograms.length} Octer-stream histograms in analyzer data`);

	    // 4. Parse results. Standard HL7 OBX and ASTM E1394 messages are deterministic;
	    // AI is the fallback for formats neither handles.
	    let parsedData = parseHl7ResultsDeterministic(record.raw_content)
	    let parserUsed = parsedData ? 'deterministic_hl7_obx' : 'ai'

	    if (!parsedData || !Array.isArray(parsedData.results) || parsedData.results.length === 0) {
	      const astmParsed = parseAstmResultsDeterministic(record.raw_content)
	      if (astmParsed && astmParsed.results.length > 0) {
	        parsedData = astmParsed
	        parserUsed = 'deterministic_astm'
	      }
	    }

	    if (!parsedData || !Array.isArray(parsedData.results) || parsedData.results.length === 0) {
	      parserUsed = 'ai'

	    // 4. AI Parse
    // Strip ED/Octer-stream binary blobs before sending to AI — already decoded separately
    const rawForAI = record.raw_content.replace(
      /(\|ED\|[^|]*\|\|[^^]*\^Application\^Octer-stream\^)[0-9]+/gi,
      '$1<binary_histogram_data_stripped>'
    )

    let parsePrompt = `You are a strictly technical laboratory interface parser.
Output ONLY valid JSON. No markdown fences, no explanation, no introduction.

Parse this raw analyzer data:
${rawForAI}

REQUIRED JSON STRUCTURE:
{
  "sample_barcode": "string",
  "results": [
    { "test_code": "string", "value": "string", "unit": "string", "flag": "string", "reference_range": "string" }
  ],
  "section_results": [
    {
      "test_code": "string",
      "section_key": "findings|impression|recommendation|technique|clinical_history|conclusion|custom-or-placeholder",
      "section_name": "string",
      "content": "string"
    }
  ],
  "instrument": "string",
  "graphs": [
    { "type": "histogram|scatter|waveform", "name": "string", "test_code": "string", "description": "string", "associated_test": "string" }
  ]
}

CRITICAL FLAG RULES for HL7 OBX segments:
- OBX field 7 = Reference Range (put this in "reference_range" if present)
- OBX field 8 = Abnormal Flag (THIS is what goes in "flag"): H=High, L=Low, HH=Critical High, LL=Critical Low, A=Abnormal. Empty or missing = "N" (Normal)
- OBX field 11 = Result Status (F=Final, P=Preliminary) — DO NOT put this in "flag"
- If OBX-8 is empty/missing, set flag to "N" (Normal)

For graphs/histograms, use the OBX test code (e.g. "15000" for WBC histogram).
Do NOT include or describe binary histogram data — it is already extracted separately.`

    if (waveformData.length > 0) {
      parsePrompt += `\n\nWAVEFORM DATA DETECTED:\n${JSON.stringify(waveformData, null, 2)}\nInclude these in the "graphs" array with type "waveform".`
    }

    const aiResult = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4096,
      messages: [{ role: 'user', content: parsePrompt }]
    })
    const aiText = (aiResult.content[0] as { type: string; text: string }).text

    // Robust JSON Extraction
    const jsonMatch = aiText.match(/\{[\s\S]*\}/);
    const jsonStr = jsonMatch ? jsonMatch[0] : aiText.trim();

	    try {
	        parsedData = JSON.parse(jsonStr)
	    } catch (e) {
	        console.error("AI returned invalid JSON:", aiText)
	        throw new Error("AI Parsing Failed: Invalid JSON format")
	    }
	    }

	    if (parsedData && parserUsed.startsWith('deterministic')) {
	      try {
	        await saveAnalyzerLearning(supabase, record, parsedData, hl7MessageType || record.message_type || (parserUsed === 'deterministic_astm' ? 'ASTM' : 'HL7'))
	      } catch (learningError) {
	        console.warn('Analyzer knowledge save skipped:', learningError)
	      }
	    }

	    if (!parsedData) {
	      throw new Error('Analyzer parsing failed: no parser produced result data')
	    }

	    // 5. Order Lookup & Insertion Logic
    let statusLog = "Parsed successfully. "
    let foundOrderId: string | null = null
    // Surfaced on the raw message so a rejected row is visible in the UI instead
    // of being buried in the free-text processing log.
    const insertErrors: Array<{ analyzer_code: string | null; analyte_name: string | null; message: string }> = []
    let calculatedSummary: {
      inserted: number
      skipped: Array<{ parameter: string; reason: string }>
    } | null = null
    const barcode = String(parsedData.sample_barcode).trim()

    // A. Find Sample. Barcodes are date-prefixed (YYMMDDSSSS); the analyzer often
    // sends only the bare operator-typed sequence ("9","10"), so match that day's
    // sample first and only fall back to a recency-ordered wildcard. An empty
    // barcode must never reach the wildcard query — '%%' matches any sample.
    let sample: any = null
    let sampleError: any = null
    if (barcode) {
        const datePrefix = extractMessageDatePrefix(record.raw_content)
        try {
            const found = await findSampleForBarcode(supabase, record.lab_id, barcode, datePrefix)
            sample = found?.sample ?? null
            if (found) {
                console.log(`🔎 Sample matched for barcode '${barcode}' via ${found.matchType} (barcode=${found.sample.barcode}, day=${datePrefix ?? 'unknown'})`)
            }
        } catch (lookupError) {
            sampleError = lookupError
            console.error('Sample lookup failed', lookupError)
        }
    }

    if (sampleError || !sample) {
       statusLog += barcode
           ? `Warning: Sample with barcode '${barcode}' not found (Lab: ${record.lab_id}).`
           : `Warning: No sample barcode could be parsed from the message (Lab: ${record.lab_id}).`
    } else {
        foundOrderId = sample.order_id ?? null
        // B. Process Results
        statusLog += "Sample found. Processing results... "

        // Fetch Patient Details from Order (patient_name from orders, gender from patients join)
        const { data: orderData, error: orderError } = await supabase
            .from('orders')
            .select('patient_id, patient_name, patients (gender, age)')
            .eq('id', sample.order_id)
            .single()

        if (orderError) {
            console.error("Failed to fetch order data for sample", sample.order_id, orderError)
        }

        const patientId = orderData?.patient_id
        // @ts-ignore
        const patientGender: string = (orderData as any)?.patients?.gender || ''
        // Age feeds AGE-dependent formulas (eGFR and friends) when calculated
        // analytes are evaluated below.
        // @ts-ignore
        const patientAge: number | null = (orderData as any)?.patients?.age ?? null
        const patientName = orderData?.patient_name || "Unknown Patient"

        if (patientId) {
            const sectionResult = await upsertAnalyzerSectionContent(supabase, {
                orderId: sample.order_id,
                patientId,
                patientName,
                labId: sample.lab_id,
                record,
                parsedData,
            })
            if (sectionResult.saved > 0 || sectionResult.skipped > 0) {
                statusLog += sectionResult.log
            }
        }

        // Ensure master Result record exists. The results table has a UNIQUE
        // (order_id, test_name) constraint, so a header may already exist for this
        // order with a null/other sample_id (e.g. from an earlier run). Look it up
        // by sample_id first, then fall back to the constraint key, and create via
        // upsert so a concurrent/existing header is reused instead of colliding.
        let { data: resultHeader } = await supabase
            .from('results')
            .select('id, test_group_id')
            .eq('sample_id', sample.id)
            .maybeSingle()

        if (!resultHeader) {
            const { data: existingByOrder } = await supabase
                .from('results')
                .select('id, test_group_id')
                .eq('order_id', sample.order_id)
                .eq('test_name', 'Analyzer Result')
                .maybeSingle()
            resultHeader = existingByOrder ?? null
        }

        if (!resultHeader) {
            if (!patientId) {
                console.error("Cannot create result header: patient_id is null for order", sample.order_id)
                statusLog += `Error: Could not create result record. Patient not found for order ${sample.order_id}. `
            } else {
                const { data: newResult, error: createError } = await supabase
                    .from('results')
                    .upsert({
                        order_id: sample.order_id,
                        patient_id: patientId,
                        patient_name: patientName,
                        lab_id: sample.lab_id,
                        sample_id: sample.id,
                        test_name: 'Analyzer Result',
                        entered_by: 'AI Interface',
                        status: 'Entered',
                    }, { onConflict: 'order_id,test_name' })
                    .select('id, test_group_id')
                    .single()

                if (createError) {
                    console.error("Failed to create result header", createError)
                    statusLog += `Error: Could not create result record. ${createError.message} `
                } else {
                    resultHeader = newResult
                }
            }
        }

        if (resultHeader) {
            // C. Fetch Expected Analytes from v_order_missing_analytes view
            const { data: missingAnalytes } = await supabase
                .from('v_order_missing_analytes')
                .select('*')
                .eq('order_id', sample.order_id)

            // The view carries no unit / code / is_calculated, so every mapping
            // path below was matching on names alone. Enrich the expected list
            // once here: the unit tells a percentage analyte from a count
            // analyte, and is_calculated marks analytes that must NEVER receive
            // a machine value (they are derived from other analytes instead).
            const expectedKey = (a: any) => String(a?.lab_analyte_id || a?.analyte_id || '')
            const expectedMeta = new Map<string, { unit: string; code: string; is_calculated: boolean }>()
            if (missingAnalytes && missingAnalytes.length > 0) {
                const allExpectedAnalyteIds = [
                    ...new Set(missingAnalytes.map((a: any) => a.analyte_id).filter(Boolean)),
                ] as string[]

                const [{ data: globalMetaRows }, { data: labMetaRows }] = await Promise.all([
                    allExpectedAnalyteIds.length > 0
                        ? supabase.from('analytes').select('id, code, unit, is_calculated').in('id', allExpectedAnalyteIds)
                        : Promise.resolve({ data: [] }),
                    allExpectedAnalyteIds.length > 0
                        ? supabase
                              .from('lab_analytes')
                              .select('id, analyte_id, code, unit, lab_specific_unit, is_calculated')
                              .eq('lab_id', sample.lab_id)
                              .in('analyte_id', allExpectedAnalyteIds)
                        : Promise.resolve({ data: [] }),
                ])

                const globalMetaById = new Map<string, any>()
                for (const row of globalMetaRows ?? []) globalMetaById.set(row.id, row)
                const labMetaById = new Map<string, any>()
                const labMetaByAnalyteId = new Map<string, any>()
                for (const row of labMetaRows ?? []) {
                    labMetaById.set(row.id, row)
                    if (!labMetaByAnalyteId.has(row.analyte_id)) labMetaByAnalyteId.set(row.analyte_id, row)
                }

                for (const a of missingAnalytes) {
                    const lab = (a.lab_analyte_id ? labMetaById.get(a.lab_analyte_id) : null)
                        ?? labMetaByAnalyteId.get(a.analyte_id)
                        ?? null
                    const global = globalMetaById.get(a.analyte_id) ?? null
                    const meta = {
                        unit: String(lab?.lab_specific_unit || lab?.unit || global?.unit || ''),
                        code: String(lab?.code || global?.code || ''),
                        is_calculated: (lab?.is_calculated ?? global?.is_calculated ?? false) === true,
                    }
                    expectedMeta.set(expectedKey(a), meta)
                    // Secondary key: a mapping row may carry a lab_analyte_id the view
                    // row did not, so keep an analyte_id entry to fall back on.
                    if (a.analyte_id && !expectedMeta.has(String(a.analyte_id))) {
                        expectedMeta.set(String(a.analyte_id), meta)
                    }
                }
            }

            // Machine values may only target non-calculated analytes.
            const mappableAnalytes = (missingAnalytes ?? []).filter(
                (a: any) => !expectedMeta.get(expectedKey(a))?.is_calculated,
            )
            const calculatedExpectedCount = (missingAnalytes?.length ?? 0) - mappableAnalytes.length
            if (calculatedExpectedCount > 0) {
                console.log(`DEBUG: Excluded ${calculatedExpectedCount} calculated analyte(s) from analyzer mapping targets`)
            }

            const expectedMetaFor = (mapping: any) =>
                (mapping?.lab_analyte_id ? expectedMeta.get(String(mapping.lab_analyte_id)) : null)
                ?? (mapping?.analyte_id ? expectedMeta.get(String(mapping.analyte_id)) : null)
                ?? null

            if (!missingAnalytes || missingAnalytes.length === 0) {
                statusLog += "No expected analytes found for this order. "
            } else {
                // D. Use AI to map machine results to expected analytes
                // Filter to only clinical result codes — skip instrument mode/alert/boundary line codes
                const NON_CLINICAL_PREFIXES = ['080', '010', '120', '150']
                const clinicalResults = (parsedData.results || []).filter((r: any) => {
                    const code = String(r.test_code ?? '')
                    const value = normalizeAnalyzerValue(r.value)
                    // r.flag = HL7 OBX-8 (abnormal flag: H/L/HH/LL) NOT OBX-11 result status (F=Final).
                    // Never filter out based on flag value — F here means Final result, not a clinical flag.
                    return !NON_CLINICAL_PREFIXES.some(p => code.startsWith(p)) && value !== null
                })

                const machineCodes = clinicalResults
                    .map((r: any) => String(r.test_code ?? '').toUpperCase())
                    .filter(Boolean)
                const expectedAnalyteIds = mappableAnalytes
                    .map((a: any) => a.analyte_id)
                    .filter(Boolean)
                let deterministicMappingRows: any[] = []

                // Collect lab_analyte_ids from missingAnalytes view
                const expectedLabAnalyteIds = mappableAnalytes
                    .map((a: any) => a.lab_analyte_id)
                    .filter(Boolean)

                if (machineCodes.length > 0 && (expectedAnalyteIds.length > 0 || expectedLabAnalyteIds.length > 0)) {
                    // Primary: lookup by lab_analyte_id (most specific)
                    if (expectedLabAnalyteIds.length > 0) {
                        let laQuery = supabase
                            .from('test_mappings')
                            .select('analyzer_code, analyte_id, lab_analyte_id, test_name, test_group_id, ai_confidence, analyzer_connection_id')
                            .eq('lab_id', sample.lab_id)
                            .eq('mapping_type', 'result_analyte')
                            .in('direction', ['inbound', 'bidirectional'])
                            .in('analyzer_code', machineCodes)
                            .in('lab_analyte_id', expectedLabAnalyteIds)

                        if (record.analyzer_connection_id) {
                            laQuery = laQuery.or(`analyzer_connection_id.eq.${record.analyzer_connection_id},analyzer_connection_id.is.null`)
                        }

                        const { data: laRows, error: laError } = await laQuery
                        if (!laError && laRows) {
                            deterministicMappingRows.push(...laRows)
                        }
                    }

                    // Fallback: lookup by analyte_id (legacy)
                    const foundMachineCodes = new Set(deterministicMappingRows.map((r: any) => String(r.analyzer_code).toUpperCase()))
                    const remainingCodes = machineCodes.filter((c: string) => !foundMachineCodes.has(c))

                    if (remainingCodes.length > 0 && expectedAnalyteIds.length > 0) {
                        let deterministicQuery = supabase
                            .from('test_mappings')
                            .select('analyzer_code, analyte_id, lab_analyte_id, test_name, test_group_id, ai_confidence, analyzer_connection_id')
                            .eq('lab_id', sample.lab_id)
                            .eq('mapping_type', 'result_analyte')
                            .in('direction', ['inbound', 'bidirectional'])
                            .in('analyzer_code', remainingCodes)
                            .in('analyte_id', expectedAnalyteIds)

                        if (record.analyzer_connection_id) {
                            deterministicQuery = deterministicQuery.or(`analyzer_connection_id.eq.${record.analyzer_connection_id},analyzer_connection_id.is.null`)
                        }

                        const { data: mappingRows, error: mappingRowsError } = await deterministicQuery
                        if (mappingRowsError) {
                            console.error('Deterministic analyzer mapping lookup failed:', mappingRowsError)
                        } else if (mappingRows) {
                            deterministicMappingRows.push(...mappingRows)
                        }
                    }
                }

                const analyteMap = new Map()
                const mappingSpecificity = (row: any) => {
                    if (record.analyzer_connection_id && row.analyzer_connection_id === record.analyzer_connection_id) return 2
                    return 1
                }
                deterministicMappingRows.sort((a: any, b: any) => mappingSpecificity(a) - mappingSpecificity(b))
                for (const row of deterministicMappingRows) {
                    const machineCode = String(row.analyzer_code ?? '').toUpperCase()
                    if (!machineCode) continue

                    // Match by lab_analyte_id first, then analyte_id
                    let expected = row.lab_analyte_id
                        ? mappableAnalytes.find((a: any) => a.lab_analyte_id === row.lab_analyte_id)
                        : null
                    if (!expected && row.analyte_id) {
                        expected = mappableAnalytes.find((a: any) => a.analyte_id === row.analyte_id)
                    }
                    if (!expected) continue

                    analyteMap.set(machineCode, {
                        analyte_id: row.analyte_id || expected.analyte_id,
                        lab_analyte_id: row.lab_analyte_id || expected.lab_analyte_id,
                        analyte_name: expected.analyte_name || row.test_name,
                        test_group_id: expected.test_group_id || row.test_group_id,
                        order_test_group_id: null,
                        order_test_id: expected.order_test_id,
                        confidence: row.ai_confidence || 1.0,
                        mapping_source: 'test_mappings'
                    })
                }

	                // Deterministic name/code fallback (runs before the AI mapper).
	                // Analyzers routinely send a standard mnemonic in the OBX name
	                // (e.g. "HGB", "RBC") even when OBX-3 carries a LOINC code
	                // ("718-7"). Match that mnemonic — and the raw code — against each
	                // expected analyte's name and code (global + lab-specific) so
	                // obvious mappings never depend on the AI. Exact-token only, and
	                // only when a single analyte matches, to avoid false positives.
	                const preAiUnresolved = clinicalResults.filter((r: any) => {
	                    const code = String(r.test_code ?? '').toUpperCase()
	                    return code && !analyteMap.has(code)
	                })
	                if (preAiUnresolved.length > 0 && mappableAnalytes.length > 0) {
	                    const expAnalyteIds = [...new Set(mappableAnalytes.map((a: any) => a.analyte_id).filter(Boolean))] as string[]
	                    const expLabAnalyteIds = [...new Set(mappableAnalytes.map((a: any) => a.lab_analyte_id).filter(Boolean))] as string[]
	                    const codesByAnalyteId = new Map<string, Set<string>>()
	                    const addCode = (analyteId: string, code: unknown) => {
	                        const key = normalizeAnalyteName(code)
	                        if (!analyteId || !key) return
	                        const set = codesByAnalyteId.get(analyteId) ?? new Set<string>()
	                        set.add(key)
	                        codesByAnalyteId.set(analyteId, set)
	                    }
	                    if (expAnalyteIds.length > 0) {
	                        const { data: aRows } = await supabase.from('analytes').select('id, code').in('id', expAnalyteIds)
	                        for (const a of aRows ?? []) addCode(a.id, a.code)
	                    }
	                    if (expLabAnalyteIds.length > 0) {
	                        const { data: laRows } = await supabase.from('lab_analytes').select('id, analyte_id, code').in('id', expLabAnalyteIds)
	                        for (const la of laRows ?? []) addCode(la.analyte_id, la.code)
	                    }

	                    const analyteCandidates = mappableAnalytes.map((a: any) => {
	                        const tokens = new Set<string>()
	                        const nameKey = normalizeAnalyteName(a.analyte_name)
	                        if (nameKey) tokens.add(nameKey)
	                        for (const code of codesByAnalyteId.get(a.analyte_id) ?? []) tokens.add(code)
	                        const meta = expectedMeta.get(expectedKey(a))
	                        return { expected: a, tokens, kind: quantityKind(a.analyte_name, meta?.unit) }
	                    })

	                    let deterministicNameMatches = 0
	                    for (const r of preAiUnresolved) {
	                        const realCode = String(r.test_code ?? '').toUpperCase()
	                        if (!realCode || analyteMap.has(realCode)) continue
	                        const machineTokens = [normalizeAnalyteName(r.name), normalizeAnalyteName(r.test_code)].filter(Boolean)
	                        if (machineTokens.length === 0) continue
	                        // normalizeAnalyteName() drops '%' and '#', so GRAN% and GRAN#
	                        // produce the same token. Compare the quantity kind before
	                        // accepting the match, or the count silently wins the race.
	                        const machineKind = quantityKind(r.name || r.test_code, r.unit)
	                        const matches = analyteCandidates
	                            .filter((c) => machineTokens.some((t) => c.tokens.has(t)))
	                            .filter((c) => !quantityKindsConflict(machineKind, c.kind))
	                        if (matches.length !== 1) continue // skip ambiguous / no match → let AI decide
	                        const hit = matches[0].expected
	                        analyteMap.set(realCode, {
	                            analyte_id: hit.analyte_id,
	                            lab_analyte_id: hit.lab_analyte_id || null,
	                            analyte_name: hit.analyte_name,
	                            test_group_id: hit.test_group_id,
	                            order_test_group_id: null,
	                            order_test_id: hit.order_test_id,
	                            confidence: 1.0,
	                            mapping_source: 'deterministic_name_code',
	                        })
	                        deterministicNameMatches++
	                    }
	                    console.log(`DEBUG: Deterministic name/code fallback mapped ${deterministicNameMatches} analyte(s)`)
	                }

	                const unresolvedClinicalResults = clinicalResults.filter((r: any) => {
	                    const code = String(r.test_code ?? '').toUpperCase()
	                    return code && !analyteMap.has(code)
	                })

	                let aiMappings = { mappings: [] as any[] }
	                if (unresolvedClinicalResults.length > 0) {
	                const mappingPrompt = `
You are a laboratory data mapper. Match machine analyzer results to expected lab analytes.
Output ONLY valid JSON. No markdown fences, no explanation.

MACHINE RESULTS:
${JSON.stringify(unresolvedClinicalResults.map((r: any) => ({ test_code: r.test_code, name: r.name, value: r.value, unit: r.unit })), null, 2)}

EXPECTED ANALYTES FOR THIS ORDER (these are the ONLY valid targets):
${JSON.stringify(mappableAnalytes.map(a => {
    const meta = expectedMeta.get(expectedKey(a))
    return {
        analyte_id: a.analyte_id,
        analyte_name: a.analyte_name,
        analyte_code: meta?.code || null,
        expected_unit: meta?.unit || null,
        test_group_id: a.test_group_id,
        order_test_id: a.order_test_id
    }
}), null, 2)}

TASK: Map each machine result to the correct analyte_id from the expected list.
"machine_code" MUST be copied VERBATIM from the machine result's "test_code"
field (e.g. "6690-2"), NOT the name/mnemonic. The name is only a hint for matching.

HARD RULES:
1. A percentage and an absolute count are DIFFERENT parameters. "GRAN%" (unit %)
   and "GRAN#" (unit 10*9/L) must never map to the same analyte. Match the
   machine unit against expected_unit: a "%" result belongs only to a percentage
   analyte, a count/concentration result only to a count analyte.
2. Each expected analyte may be used AT MOST ONCE. If two machine results seem to
   fit the same analyte, map only the one whose unit matches expected_unit.
3. If a machine result has no correct target in the expected list, OMIT it. Do not
   force it onto the nearest name — an unmapped result is fine, a wrong one is not.

Consider common abbreviations:
- WBC = White Blood Cell / Total White Blood Cell Count
- RBC = Red Blood Cell Count
- HGB = Hemoglobin
- HCT = Hematocrit
- PLT = Platelet Count
- MCV = Mean Corpuscular Volume
- MCH = Mean Corpuscular Hemoglobin
- MCHC = Mean Corpuscular Hemoglobin Concentration
- GRAN/NEUT, LYM, MID/MONO carry a "%" or "#" suffix that decides rule 1

OUTPUT ONLY valid JSON in this exact format (no markdown, no explanation).
Note machine_code is the exact test_code (here "6690-2"), even though the name is "WBC":
{
  "mappings": [
    {
      "machine_code": "6690-2",
      "analyte_id": "uuid-here",
      "analyte_name": "matched name",
      "test_group_id": "uuid-here",
      "order_test_id": "uuid-here",
      "confidence": 0.95
    }
  ]
}
`

                const aiMappingResult = await anthropic.messages.create({
                  model: MODEL,
                  max_tokens: 4096,
                  messages: [{ role: 'user', content: mappingPrompt }]
                })
                const aiMappingText = (aiMappingResult.content[0] as { type: string; text: string }).text
                console.log(`[analyzer-ai-mapping] raw_response ${JSON.stringify({
                  raw_message_id: record.id,
                  order_id: sample.order_id,
                  unresolved_codes: unresolvedClinicalResults.map((r: any) => r.test_code),
                  response: aiMappingText.slice(0, 2000),
                })}`)

                // Robust JSON extraction
                const mappingJsonMatch = aiMappingText.match(/\{[\s\S]*\}/)
                const mappingJsonStr = mappingJsonMatch ? mappingJsonMatch[0] : aiMappingText.trim()

	                try {
	                    aiMappings = JSON.parse(mappingJsonStr)
	                } catch (e) {
	                    console.error("AI mapping returned invalid JSON:", aiMappingText)
	                    statusLog += "AI mapping failed. "
	                    aiMappings = { mappings: [] }
	                }
	                }

                // Build lookup map from AI mappings.
                // The AI may echo either the machine test_code ("6690-2") or the
                // mnemonic name ("WBC") in machine_code, but the downstream lookup
                // keys strictly on the result's test_code. Reconcile the AI's answer
                // back to the original result (by test_code OR name) and key
                // analyteMap by the REAL test_code so the mapping is never lost.
                if (aiMappings.mappings && Array.isArray(aiMappings.mappings)) {
                    const realCodeByToken = new Map<string, string>() // normalized token -> real test_code
                    for (const r of unresolvedClinicalResults) {
                        const realCode = String(r.test_code ?? '').toUpperCase()
                        if (!realCode) continue
                        for (const token of [r.test_code, r.name]) {
                            const key = normalizeAnalyteName(token)
                            if (key && !realCodeByToken.has(key)) realCodeByToken.set(key, realCode)
                        }
                    }

                    for (const mapping of aiMappings.mappings) {
                        if (!mapping.machine_code || !mapping.analyte_id) continue
                        const realCode =
                            realCodeByToken.get(normalizeAnalyteName(mapping.machine_code)) ||
                            String(mapping.machine_code).toUpperCase()
                        if (analyteMap.has(realCode)) continue
                        // Resolve lab_analyte_id from the mappable (non-calculated) list.
                        // A machine value must never be written to a formula analyte,
                        // even if the model suggests one.
                        const expectedForAi = mappableAnalytes.find((a: any) => a.analyte_id === mapping.analyte_id)
                        if (!expectedForAi) {
                            console.log(`[analyzer-ai-mapping] rejected_target ${JSON.stringify({
                              raw_message_id: record.id,
                              order_id: sample.order_id,
                              machine_code: realCode,
                              analyte_id: mapping.analyte_id,
                              reason: 'not a mappable expected analyte (calculated or not in order)',
                            })}`)
                            continue
                        }
                        analyteMap.set(realCode, {
                            analyte_id: mapping.analyte_id,
                            lab_analyte_id: expectedForAi.lab_analyte_id || null,
                            // Trust the order for identity/routing; the model only picks the target.
                            analyte_name: expectedForAi.analyte_name || mapping.analyte_name,
                            test_group_id: expectedForAi.test_group_id || mapping.test_group_id,
                            order_test_group_id: null,
                            order_test_id: expectedForAi.order_test_id || mapping.order_test_id,
                            confidence: mapping.confidence || 0.8,
                            mapping_source: 'ai'
                        })
                    }
                }

                console.log(`DEBUG: Mapped ${analyteMap.size} analytes:`, Array.from(analyteMap.keys()).join(', '))

                // Enrich analyteMap with real order_test_group_id and test_group_id.
                // Orders may use either order_test_groups OR order_tests — try both.
                const mappedAnalyteIds = Array.from(analyteMap.values()).map((m: any) => m.analyte_id)
                if (mappedAnalyteIds.length > 0) {
                    const analyteToOTG = new Map<string, { order_test_group_id: string | null; test_group_id: string; order_test_id?: string | null }>()

                    // Try order_test_groups first
                    const { data: otgRows } = await supabase
                        .from('order_test_groups')
                        .select('id, test_group_id, test_group_analytes!inner(analyte_id)')
                        .eq('order_id', sample.order_id)

                    if (otgRows && otgRows.length > 0) {
                        for (const otg of otgRows) {
                            for (const tga of (otg as any).test_group_analytes || []) {
                                if (mappedAnalyteIds.includes(tga.analyte_id)) {
                                    analyteToOTG.set(tga.analyte_id, {
                                        order_test_group_id: otg.id,
                                        test_group_id: otg.test_group_id,
                                    })
                                }
                            }
                        }
                    }

                    // Fallback: try order_tests if order_test_groups yielded nothing.
                    // Two-step lookup: order_tests → test_group_analytes via test_group_id
                    // (there is no direct FK between order_tests and test_group_analytes).
                    if (analyteToOTG.size === 0) {
                        const { data: otRows } = await supabase
                            .from('order_tests')
                            .select('id, test_group_id')
                            .eq('order_id', sample.order_id)

                        if (otRows && otRows.length > 0) {
                            const tgIds = otRows.map((ot: any) => ot.test_group_id).filter(Boolean) as string[]
                            const { data: tgaRows } = await supabase
                                .from('test_group_analytes')
                                .select('analyte_id, test_group_id')
                                .in('test_group_id', tgIds)

                            if (tgaRows) {
                                // Map test_group_id → order_test so we can look up order_test_id per analyte
                                const tgToOT = new Map<string, { id: string; test_group_id: string }>()
                                for (const ot of otRows) {
                                    if (ot.test_group_id) tgToOT.set(ot.test_group_id, ot as any)
                                }
                                for (const tga of tgaRows) {
                                    if (mappedAnalyteIds.includes(tga.analyte_id)) {
                                        const ot = tgToOT.get(tga.test_group_id)
                                        if (ot) {
                                            analyteToOTG.set(tga.analyte_id, {
                                                order_test_group_id: null, // FK references order_test_groups, not order_tests
                                                test_group_id: tga.test_group_id,
                                                order_test_id: ot.id,
                                            })
                                        }
                                    }
                                }
                            }
                            console.log(`DEBUG: Fell back to order_tests, enriched ${analyteToOTG.size} analytes`)
                        }
                    }

                    // If still nothing, use the first test_group_id from either table as blanket fallback
                    if (analyteToOTG.size === 0) {
                        const { data: fallbackRows } = await supabase
                            .from('order_test_groups')
                            .select('id, test_group_id')
                            .eq('order_id', sample.order_id)
                            .limit(1)
                        const fallback = fallbackRows?.[0] ?? null
                        if (!fallback) {
                            const { data: fallbackOT } = await supabase
                                .from('order_tests')
                                .select('id, test_group_id')
                                .eq('order_id', sample.order_id)
                                .limit(1)
                            if (fallbackOT?.[0]) {
                                for (const id of mappedAnalyteIds) {
                                    analyteToOTG.set(id, {
                                        order_test_group_id: null, // FK references order_test_groups, not order_tests
                                        test_group_id: fallbackOT[0].test_group_id,
                                        order_test_id: fallbackOT[0].id,
                                    })
                                }
                                console.log(`DEBUG: Used order_tests blanket fallback test_group_id=${fallbackOT[0].test_group_id} order_test_id=${fallbackOT[0].id}`)
                            }
                        } else {
                            for (const id of mappedAnalyteIds) {
                                analyteToOTG.set(id, {
                                    order_test_group_id: fallback.id,
                                    test_group_id: fallback.test_group_id,
                                })
                            }
                            console.log(`DEBUG: Used order_test_groups blanket fallback test_group_id=${fallback.test_group_id}`)
                        }
                    }

                    // Always back-fill order_test_id from order_tests using test_group_id.
                    // The order_test_groups path sets order_test_group_id but leaves order_test_id null.
                    const { data: otRowsForId } = await supabase
                        .from('order_tests')
                        .select('id, test_group_id')
                        .eq('order_id', sample.order_id)
                    const tgToOrderTestId = new Map<string, string>()
                    for (const ot of otRowsForId || []) {
                        if (ot.test_group_id) tgToOrderTestId.set(ot.test_group_id, ot.id)
                    }
                    for (const [analyteId, entry] of analyteToOTG) {
                        if (!entry.order_test_id && entry.test_group_id) {
                            const otId = tgToOrderTestId.get(entry.test_group_id)
                            if (otId) entry.order_test_id = otId
                        }
                    }

                    for (const [code, mapping] of analyteMap) {
                        const otgInfo = analyteToOTG.get((mapping as any).analyte_id)
                        if (otgInfo) {
                            analyteMap.set(code, { ...(mapping as any), ...otgInfo })
                        }
                    }
                    console.log(`DEBUG: Enriched ${analyteToOTG.size} analytes with order_test_group_id/order_test_id`)
                }

                // Route each value to a results header for ITS OWN test_group,
                // exactly like manual entry (one header per panel). The single
                // 'Analyzer Result' header (resultHeader) stays as a fallback only
                // for values that carry no test_group_id; it is left untagged so it
                // never competes with a real panel header in v_result_panel_status.
                const testGroupNameById = new Map<string, string>()
                {
                    const allTgIds = [...new Set(
                        (missingAnalytes ?? []).map((a: any) => a.test_group_id).filter(Boolean),
                    )] as string[]
                    if (allTgIds.length > 0) {
                        const { data: tgRows } = await supabase
                            .from('test_groups')
                            .select('id, name')
                            .in('id', allTgIds)
                        for (const tg of tgRows ?? []) testGroupNameById.set(tg.id, tg.name)
                    }
                }

                const groupHeaderCache = new Map<string, string | null>()
                const resolveGroupHeaderId = async (
                    tgId: string | null | undefined,
                    otgId: string | null | undefined,
                    otId: string | null | undefined,
                ): Promise<string> => {
                    const key = String(tgId ?? '')
                    if (!key) return resultHeader.id // no group → generic fallback header
                    if (groupHeaderCache.has(key)) {
                        return groupHeaderCache.get(key) ?? resultHeader.id
                    }
                    const header = await getOrCreateGroupResult(supabase, {
                        orderId: sample.order_id,
                        patientId,
                        patientName,
                        labId: sample.lab_id,
                        testGroupId: key,
                        testGroupName: testGroupNameById.get(key) || 'Analyzer Result',
                        orderTestGroupId: otgId ?? null,
                        orderTestId: otId ?? null,
                    })
                    groupHeaderCache.set(key, header?.id ?? null)
                    return header?.id ?? resultHeader.id
                }

            // D. Insert Result Values with Context
            let mappedCount = 0
            let unmappedCount = 0

            // Preserve exact IDs from mappings; only resolve legacy rows by global analyte_id.
            const labAnalyteIdMap = new Map<string, string>() // analyte_id → lab_analyte_id
            const exactLabAnalyteIds = Array.from(analyteMap.values())
              .map((m: any) => m.lab_analyte_id)
              .filter(Boolean) as string[]
            const analyteIdsNeedingFallback = Array.from(analyteMap.values())
              .filter((m: any) => !m.lab_analyte_id && m.analyte_id)
              .map((m: any) => m.analyte_id) as string[]
            if (analyteIdsNeedingFallback.length > 0) {
              const { data: laRows } = await supabase
                .from('lab_analytes')
                .select('id, analyte_id')
                .eq('lab_id', sample.lab_id)
                .in('analyte_id', [...new Set(analyteIdsNeedingFallback)])
                .order('created_at', { ascending: true })
              if (laRows) {
                for (const la of laRows) {
                  if (!labAnalyteIdMap.has(la.analyte_id)) labAnalyteIdMap.set(la.analyte_id, la.id)
                }
              }
            }

            // Batch-fetch lab_analyte_interface_config (dilution + unit conversion + auto-verify)
            const interfaceConfigMap = new Map<string, {
              multiply_by: number; add_offset: number;
              dilution_factor: number; dilution_mode: string;
              lims_unit: string | null; auto_verify: boolean;
              decimal_places: number | null;
              analyzer_connection_id: string | null
            }>() // lab_analyte_id → config
            const allLabAnalyteIds = [
              ...new Set([...exactLabAnalyteIds, ...labAnalyteIdMap.values()]),
            ]
            if (allLabAnalyteIds.length > 0) {
              const { data: configRows } = await supabase
                .from('lab_analyte_interface_config')
                .select('lab_analyte_id, analyzer_connection_id, multiply_by, add_offset, dilution_factor, dilution_mode, lims_unit, auto_verify, decimal_places')
                .eq('lab_id', sample.lab_id)
                .in('lab_analyte_id', allLabAnalyteIds)
              if (configRows) {
                for (const cfg of configRows) {
                  const existing = interfaceConfigMap.get(cfg.lab_analyte_id)
                  const isSpecific = cfg.analyzer_connection_id && cfg.analyzer_connection_id === record.analyzer_connection_id
                  const isFallback = !cfg.analyzer_connection_id
                  const keepExistingSpecific = existing?.analyzer_connection_id === record.analyzer_connection_id && !isSpecific
                  if ((!isSpecific && !isFallback) || keepExistingSpecific) continue

                  interfaceConfigMap.set(cfg.lab_analyte_id, {
                    multiply_by: Number(cfg.multiply_by ?? 1),
                    add_offset:  Number(cfg.add_offset  ?? 0),
                    dilution_factor: Number(cfg.dilution_factor ?? 1),
                    dilution_mode: String(cfg.dilution_mode ?? 'auto'),
                    lims_unit:   cfg.lims_unit ?? null,
                    auto_verify: cfg.auto_verify ?? false,
                    decimal_places: cfg.decimal_places == null ? null : Number(cfg.decimal_places),
                    analyzer_connection_id: cfg.analyzer_connection_id ?? null,
                  })
                }
                console.log(`DEBUG: Loaded interface config for ${interfaceConfigMap.size} analytes`)
              }
            }

            // Batch-fetch reference ranges from lab_analytes
            const refRangeMap = new Map<string, {
              lab_specific: string | null; ref_generic: string | null;
              ref_male: string | null; ref_female: string | null;
              low_critical: string | null; high_critical: string | null;
              value_type: string | null; expected_normal_values: unknown
            }>()
            if (allLabAnalyteIds.length > 0) {
              const { data: refRows } = await supabase
                .from('lab_analytes')
                .select('id, reference_range, reference_range_male, reference_range_female, lab_specific_reference_range, low_critical, high_critical, value_type, expected_normal_values')
                .eq('lab_id', sample.lab_id)
                .in('id', allLabAnalyteIds)
              if (refRows) {
                for (const la of refRows) {
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
                console.log(`DEBUG: Loaded reference ranges for ${refRangeMap.size} lab_analytes`)
              }
            }

            const mappedCandidates: Array<{
              item: any
              mapping: any
              labAnalyteId: string | null
              finalParamName: string
              finalValue: string
              finalUnit: string
              verifyStatus: string
              fallbackReferenceRange: string
              analyteKey: string
              matchScore: number
            }> = []

            for (const item of parsedData.results) {
                const machineCode = item.test_code?.toUpperCase()
                const normalizedValue = normalizeAnalyzerValue(item.value)

                if (normalizedValue === null) {
                    console.log(`[analyzer-result] skipped_empty_value ${JSON.stringify({
                      raw_message_id: record.id,
                      order_id: sample.order_id,
                      analyzer_code: item.test_code || null,
                      raw_value: item.value ?? null,
                    })}`)
                    continue
                }

                // Only use context-aware lookup from order
                const mapping = analyteMap.get(machineCode)

                if (!mapping) {
                    // Log unmapped analyte
                    console.log(`Unmapped analyte: ${item.test_code} - not found in order context`)
                    statusLog += `Unmapped: ${item.test_code}. `
                    unmappedCount++
                    continue
                }

                // A count must never be stored in a percentage analyte (or the
                // reverse). This is what let GRAN# (6.2, 10*9/L) land on
                // "Granulocyte Percentage" and push out the real GRAN% (68.5 %).
                const expectedForCode = expectedMetaFor(mapping)
                const machineKind = quantityKind(item.name || item.test_code, item.unit)
                const analyteKind = quantityKind(mapping.analyte_name, expectedForCode?.unit)
                if (quantityKindsConflict(machineKind, analyteKind)) {
                    console.log(`[analyzer-result] rejected_kind_mismatch ${JSON.stringify({
                      raw_message_id: record.id,
                      order_id: sample.order_id,
                      analyzer_code: item.test_code || null,
                      analyzer_name: item.name || null,
                      analyzer_unit: item.unit || null,
                      analyte_name: mapping.analyte_name,
                      analyte_unit: expectedForCode?.unit || null,
                      machine_kind: machineKind,
                      analyte_kind: analyteKind,
                      mapping_source: mapping.mapping_source || null,
                    })}`)
                    statusLog += `Rejected ${item.test_code} → ${mapping.analyte_name} (${machineKind} value into ${analyteKind} analyte). `
                    unmappedCount++
                    continue
                }

                // Use mapped name
                const finalParamName = mapping.analyte_name

                // Apply dilution + unit conversion + auto-verify from lab_analyte_interface_config.
                // Manual dilution means the analyzer measured a diluted specimen, so multiply
                // back to the original specimen concentration before unit conversion.
                const labAnalyteId = mapping.lab_analyte_id || labAnalyteIdMap.get(mapping.analyte_id) || null
                const ifCfg = labAnalyteId ? interfaceConfigMap.get(labAnalyteId) : null

                let finalValue = normalizedValue
                let finalUnit  = item.unit
                let verifyStatus = 'pending'

                if (ifCfg) {
                  const raw = parseFloat(finalValue)
                  if (!isNaN(raw)) {
                    const dilutionFactor = ifCfg.dilution_mode === 'manual'
                      ? Math.max(1, ifCfg.dilution_factor || 1)
                      : 1
                    const converted = (raw * dilutionFactor * ifCfg.multiply_by) + ifCfg.add_offset
                    // decimal_places pins the precision after conversion — counts
                    // such as Platelets or TLC are reported as whole numbers even
                    // though the analyzer sends a fractional part.
                    finalValue = ifCfg.decimal_places == null
                      ? formatCalculatedResult(converted)
                      : formatFixedResult(converted, ifCfg.decimal_places)
                  }
                  if (ifCfg.lims_unit) finalUnit = ifCfg.lims_unit
                  if (ifCfg.auto_verify)  verifyStatus = 'approved'
                  console.log(`DEBUG: Conversion applied to ${item.test_code}: ${item.value}${item.unit} → ${finalValue}${finalUnit}`)
                }

                // The analyzer's unit is kept as-is: relabelling a number with the
                // lab's configured unit without a conversion would mislabel it.
                // Fill in only when the machine sent none, and report a genuine
                // disagreement so the lab can add a lab_analyte_interface_config.
                if (!finalUnit && expectedForCode?.unit) {
                  finalUnit = expectedForCode.unit
                } else if (
                  !ifCfg?.lims_unit &&
                  finalUnit &&
                  expectedForCode?.unit &&
                  normalizeUnitForCompare(finalUnit) !== normalizeUnitForCompare(expectedForCode.unit)
                ) {
                  console.log(`[analyzer-result] unit_mismatch ${JSON.stringify({
                    raw_message_id: record.id,
                    order_id: sample.order_id,
                    analyzer_code: item.test_code || null,
                    analyte_name: mapping.analyte_name,
                    analyzer_unit: finalUnit,
                    configured_unit: expectedForCode.unit,
                    note: 'stored the analyzer unit; configure a unit conversion to normalise',
                  })}`)
                }

                const rr = labAnalyteId ? refRangeMap.get(labAnalyteId) : null
                const isMale = patientGender?.toLowerCase().startsWith('m')
                const isFemale = patientGender?.toLowerCase().startsWith('f')
                const savedReferenceRange =
                  rr?.lab_specific ||
                  (isMale ? rr?.ref_male : null) ||
                  (isFemale ? rr?.ref_female : null) ||
                  rr?.ref_generic ||
                  null
                // With the toggle on, the lab's saved range wins and the machine's
                // range (item.reference_range) is only a last resort when the lab
                // has none. With it off, preserve the prior machine-first behaviour.
                const fallbackReferenceRange = useSavedReferenceRanges
                  ? (savedReferenceRange || item.reference_range || '-')
                  : (rr?.lab_specific ||
                     (isMale ? rr?.ref_male : null) ||
                     (isFemale ? rr?.ref_female : null) ||
                     item.reference_range ||
                     rr?.ref_generic ||
                     '-')

                // How well this machine result fits the analyte it claims — used
                // only to settle collisions between two codes wanting one analyte.
                const expectedUnit = normalizeUnitForCompare(expectedForCode?.unit)
                const machineUnit = normalizeUnitForCompare(finalUnit)
                const sourcePriority =
                  mapping.mapping_source === 'test_mappings' ? 20 :
                  mapping.mapping_source === 'deterministic_name_code' ? 10 : 0
                const matchScore =
                  (expectedUnit && machineUnit && expectedUnit === machineUnit ? 100 : 0) +
                  (machineKind !== 'unknown' && machineKind === analyteKind ? 50 : 0) +
                  sourcePriority +
                  Number(mapping.confidence ?? 0) * 5

                mappedCandidates.push({
                  item,
                  mapping,
                  labAnalyteId,
                  finalParamName,
                  finalValue,
                  finalUnit,
                  verifyStatus,
                  fallbackReferenceRange,
                  analyteKey: String(labAnalyteId || mapping.analyte_id),
                  matchScore,
                })
            }

            // result_values holds one row per analyte (uq_rv_result_analyte). Two
            // machine codes resolving to the same analyte used to be decided by
            // message order: the first insert won, the second failed with a
            // duplicate-key error that was only appended to the log. Settle it
            // here on match quality instead, and report what was dropped.
            const bestCandidateByAnalyte = new Map<string, typeof mappedCandidates[number]>()
            for (const candidate of mappedCandidates) {
              const current = bestCandidateByAnalyte.get(candidate.analyteKey)
              if (!current || candidate.matchScore > current.matchScore) {
                bestCandidateByAnalyte.set(candidate.analyteKey, candidate)
              }
            }
            const resolvedCandidates = mappedCandidates.filter(
              (candidate) => bestCandidateByAnalyte.get(candidate.analyteKey) === candidate,
            )
            for (const candidate of mappedCandidates) {
              const winner = bestCandidateByAnalyte.get(candidate.analyteKey)
              if (winner === candidate) continue
              console.log(`[analyzer-result] dropped_duplicate_target ${JSON.stringify({
                raw_message_id: record.id,
                order_id: sample.order_id,
                analyte_name: candidate.finalParamName,
                dropped_code: candidate.item.test_code || null,
                dropped_unit: candidate.finalUnit || null,
                dropped_score: candidate.matchScore,
                kept_code: winner?.item.test_code || null,
                kept_unit: winner?.finalUnit || null,
                kept_score: winner?.matchScore ?? null,
              })}`)
              statusLog += `Dropped ${candidate.item.test_code} → ${candidate.finalParamName} (kept ${winner?.item.test_code}). `
              unmappedCount++
            }

            const candidateTestGroupIds = [
              ...new Set(resolvedCandidates.map((candidate) => candidate.mapping.test_group_id).filter(Boolean)),
            ] as string[]
            const aiEnabledTestGroupIds = new Set<string>()
            if (candidateTestGroupIds.length > 0) {
              const { data: aiGroups, error: aiGroupsError } = await supabase
                .from('test_groups')
                .select('id, ref_range_ai_config')
                .in('id', candidateTestGroupIds)

              if (aiGroupsError) {
                console.warn('Failed to load AI reference range configuration:', aiGroupsError)
              } else {
                for (const group of aiGroups ?? []) {
                  if (group.ref_range_ai_config?.enabled === true) aiEnabledTestGroupIds.add(group.id)
                }
              }
            }

            logAiRefRange('configuration_evaluated', {
              order_id: sample.order_id,
              raw_message_id: record.id,
              candidate_count: resolvedCandidates.length,
              candidate_test_group_ids: candidateTestGroupIds,
              enabled_test_group_ids: [...aiEnabledTestGroupIds],
            })

            const aiResolvedRanges = await resolveAiReferenceRanges(
              sample.order_id,
              resolvedCandidates
                .filter((candidate) => aiEnabledTestGroupIds.has(candidate.mapping.test_group_id))
                .map((candidate) => ({
                  analyte_id: candidate.mapping.analyte_id,
                  lab_analyte_id: candidate.labAnalyteId,
                  analyte_name: candidate.finalParamName,
                  value: candidate.finalValue,
                  unit: candidate.finalUnit,
                  test_group_id: candidate.mapping.test_group_id,
                })),
            )

            for (const candidate of resolvedCandidates) {
                const {
                  item,
                  mapping,
                  labAnalyteId,
                  finalParamName,
                  finalValue,
                  finalUnit,
                  verifyStatus,
                  fallbackReferenceRange,
                } = candidate
                const aiResolution = mapping.test_group_id
                  ? aiResolvedRanges.get(`${mapping.test_group_id}:${labAnalyteId || mapping.analyte_id}`)
                  : null
                const finalReferenceRange = aiResolution?.used_reference_range || fallbackReferenceRange

                // Flag: with the toggle on, compute it from the value vs. the
                // resolved (saved/AI) reference range — never from the analyzer's
                // OBX-8. With it off, keep the machine (or AI) flag as before.
                const rrMeta = labAnalyteId ? refRangeMap.get(labAnalyteId) : null
                let finalFlag: string
                let finalFlagSource: string
                if (useSavedReferenceRanges) {
                  const computed = computeSavedFlag(finalValue, finalReferenceRange, {
                    lowCritical: rrMeta?.low_critical,
                    highCritical: rrMeta?.high_critical,
                    expectedNormalValues: rrMeta?.expected_normal_values,
                    valueType: rrMeta?.value_type,
                  })
                  finalFlag = computed.flag
                  finalFlagSource = computed.source
                } else {
                  finalFlag = aiResolution?.flag || normalizeHl7Flag(item.flag)
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
                  order_id: sample.order_id,
                  raw_message_id: record.id,
                  test_group_id: mapping.test_group_id || null,
                  analyte_id: mapping.analyte_id,
                  analyzer_code: item.test_code || null,
                  range_source: aiResolution ? 'ai' : (useSavedReferenceRanges ? 'lab_saved' : 'analyzer_or_lab'),
                  flag_source: finalFlagSource,
                  fallback_reason: fallbackReason,
                  reference_range: finalReferenceRange,
                  flag: finalFlag,
                })

                const valueResultId = await resolveGroupHeaderId(
                    mapping.test_group_id, mapping.order_test_group_id, mapping.order_test_id,
                )
                const { error: valError } = await supabase.from('result_values').insert({
                    result_id: valueResultId,
                    analyte_id: mapping.analyte_id,
                    lab_analyte_id: labAnalyteId,
                    parameter: finalParamName,
                    analyte_name: finalParamName,
                    value: finalValue,
                    unit: finalUnit,
                    flag: finalFlag,
                    reference_range: finalReferenceRange,
                    reference_range_male: labAnalyteId ? (refRangeMap.get(labAnalyteId)?.ref_male ?? null) : null,
                    reference_range_female: labAnalyteId ? (refRangeMap.get(labAnalyteId)?.ref_female ?? null) : null,
                    extracted_by_ai: true,
                    flag_source: finalFlagSource,
                    verify_status: verifyStatus,
                    order_id: sample.order_id,
                    test_group_id: mapping.test_group_id,
                    order_test_group_id: mapping.order_test_group_id,
                    order_test_id: mapping.order_test_id,
                    lab_id: sample.lab_id
                })

                if (valError) {
                    console.error(`Failed to insert result value for ${item.test_code}`, valError)
                    statusLog += `Error inserting ${item.test_code}: ${valError.message}. `
                    insertErrors.push({
                      analyzer_code: item.test_code ?? null,
                      analyte_name: finalParamName ?? null,
                      message: valError.message,
                    })
                } else {
                    mappedCount++
                }
            }
            statusLog += `Mapped ${mappedCount} analytes. `

            // E. Materialise calculated (formula) analytes.
            // Formulas used to run only in the browser (src/utils/calculationEngine.ts
            // on the entry screen, recalculatePanel on rows that already exist), so an
            // order filled entirely by the analyzer produced no result_values row for
            // its calculated parameters at all — nothing for the verification console
            // to show, and the order never read as complete. Evaluate them here from
            // the values just stored.
            if (mappedCount > 0) {
                try {
                    const { data: savedValues } = await supabase
                        .from('result_values')
                        .select('analyte_id, lab_analyte_id, parameter, value, test_group_id')
                        .eq('order_id', sample.order_id)

                    // uq_rv_result_analyte is keyed on the analyte, so that is the
                    // guard against recomputing something already stored.
                    const alreadyStored = new Set(
                        (savedValues ?? []).map((rv: any) => String(rv.analyte_id)).filter(Boolean),
                    )
                    const sourceValues = (savedValues ?? [])
                        .filter((rv: any) => rv.value !== null && String(rv.value).trim() !== '')
                        .map((rv: any) => ({
                            analyte_id: rv.analyte_id,
                            lab_analyte_id: rv.lab_analyte_id,
                            parameter: rv.parameter,
                            value: String(rv.value),
                        }))

                    const calcTestGroupIds = [...new Set([
                        ...(missingAnalytes ?? []).map((a: any) => a.test_group_id),
                        ...(savedValues ?? []).map((rv: any) => rv.test_group_id),
                    ].filter(Boolean))] as string[]

                    const { results: calcResults, skipped: calcSkipped } = await computeCalculatedResults(supabase, {
                        labId: sample.lab_id,
                        testGroupIds: calcTestGroupIds,
                        sourceValues,
                        patient: { age: patientAge, gender: patientGender },
                    })

                    // Routing (order_test_group_id / order_test_id) for the calculated
                    // analytes comes from the order's own expected-analyte rows.
                    const routingByAnalyte = new Map<string, any>()
                    for (const a of missingAnalytes ?? []) {
                        if (a.lab_analyte_id && !routingByAnalyte.has(String(a.lab_analyte_id))) {
                            routingByAnalyte.set(String(a.lab_analyte_id), a)
                        }
                        if (a.analyte_id && !routingByAnalyte.has(String(a.analyte_id))) {
                            routingByAnalyte.set(String(a.analyte_id), a)
                        }
                    }

                    let calcInserted = 0
                    for (const calc of calcResults) {
                        if (alreadyStored.has(String(calc.analyte_id))) continue

                        const routing =
                            (calc.lab_analyte_id ? routingByAnalyte.get(String(calc.lab_analyte_id)) : null)
                            ?? routingByAnalyte.get(String(calc.analyte_id))
                            ?? null
                        const computedFlag = computeSavedFlag(calc.value, calc.reference_range, {
                            lowCritical: calc.low_critical,
                            highCritical: calc.high_critical,
                            expectedNormalValues: calc.expected_normal_values,
                            valueType: calc.value_type,
                        })

                        const calcResultId = await resolveGroupHeaderId(
                            routing?.test_group_id || calc.test_group_id,
                            routing?.order_test_group_id,
                            routing?.order_test_id,
                        )
                        const { error: calcError } = await supabase.from('result_values').insert({
                            result_id: calcResultId,
                            analyte_id: calc.analyte_id,
                            lab_analyte_id: calc.lab_analyte_id,
                            parameter: calc.parameter,
                            analyte_name: calc.parameter,
                            value: calc.value,
                            unit: calc.unit || '',
                            flag: computedFlag.flag,
                            flag_source: computedFlag.source,
                            reference_range: calc.reference_range || '-',
                            is_auto_calculated: true,
                            calculation_inputs: calc.calculation_inputs,
                            calculated_at: new Date().toISOString(),
                            verify_status: 'pending',
                            order_id: sample.order_id,
                            test_group_id: routing?.test_group_id || calc.test_group_id,
                            order_test_group_id: routing?.order_test_group_id ?? null,
                            order_test_id: routing?.order_test_id ?? null,
                            lab_id: sample.lab_id,
                        })

                        if (calcError) {
                            console.error(`Failed to insert calculated value for ${calc.parameter}`, calcError)
                            statusLog += `Error inserting calculated ${calc.parameter}: ${calcError.message}. `
                            insertErrors.push({
                                analyzer_code: null,
                                analyte_name: calc.parameter,
                                message: calcError.message,
                            })
                        } else {
                            calcInserted++
                        }
                    }

                    calculatedSummary = {
                        inserted: calcInserted,
                        skipped: calcSkipped.map((s) => ({ parameter: s.parameter, reason: s.reason })),
                    }
                    if (calcInserted > 0 || calcSkipped.length > 0) {
                        statusLog += `Calculated ${calcInserted} analyte(s)`
                        if (calcSkipped.length > 0) {
                            statusLog += `, skipped ${calcSkipped.length} (${calcSkipped.map((s) => `${s.parameter}: ${s.reason}`).join('; ')})`
                        }
                        statusLog += '. '
                    }
                    console.log(`[analyzer-result] calculated_analytes ${JSON.stringify({
                        raw_message_id: record.id,
                        order_id: sample.order_id,
                        inserted: calcInserted,
                        skipped: calcSkipped,
                    })}`)
                } catch (calcErr: any) {
                    // A formula problem must never fail the machine results already stored.
                    console.error('Calculated analyte evaluation failed', calcErr)
                    statusLog += `Calculated analyte evaluation failed: ${calcErr?.message ?? calcErr}. `
                }
            }

            // Mark order queue entry as completed now that results are stored
            if (mappedCount > 0) {
                await supabase
                    .from('analyzer_order_queue')
                    .update({ status: 'completed', completed_at: new Date().toISOString() })
                    .eq('order_id', sample.order_id)
                    .in('status', ['acknowledged', 'sent'])
            }

            // F. Save decoded histograms to analyzer_graphs table
            if (octerHistograms.length > 0) {
                statusLog += `Saving ${octerHistograms.length} histograms. `

                // Build associated_test map from AI-parsed graphs (test_code → associated_test)
                const aiGraphMap = new Map<string, string>()
                for (const g of (parsedData.graphs || [])) {
                    if (g.test_code) aiGraphMap.set(g.test_code, g.associated_test ?? '')
                }

                const graphRows = octerHistograms.map(h => ({
                    lab_id: sample.lab_id,
                    order_id: sample.order_id,
                    result_id: resultHeader.id,
                    raw_message_id: record.id,
                    test_code: h.testCode,
                    name: h.name,
                    associated_test: aiGraphMap.get(h.testCode) ?? null,
                    histogram_data: h.data,
                    boundaries: {
                        leftLine: h.leftLine ?? null,
                        rightLine: h.rightLine ?? null,
                        divisionLines: h.divisionLines ?? [],
                    },
                    svg_data: generatedHistogramSVGs.find(s => s.testCode === h.testCode)?.svg ?? null,
                }))

                const { error: graphInsertError } = await supabase
                    .from('analyzer_graphs')
                    .insert(graphRows)

                if (graphInsertError) {
                    console.error('Failed to insert analyzer_graphs', graphInsertError)
                    statusLog += `Error saving histograms: ${graphInsertError.message}. `
                } else {
                    statusLog += `Saved ${graphRows.length} histogram rows. `
                }
            }
            }
        }
    }

    // 6. Update Message Log with complete data including graphs
    const finalResult = {
      ...parsedData,
      processing_log: statusLog,
      extracted_images: embeddedImages.length,
      extracted_waveforms: waveformData.length,
      extracted_histograms: octerHistograms.length,
      graphs_analyzed: parsedData.graphs?.length || 0,
      // Rejected rows used to exist only inside processing_log's free text.
      insert_errors: insertErrors,
      has_errors: insertErrors.length > 0,
      calculated: calculatedSummary,
    };

    await supabase
      .from('analyzer_raw_messages')
      .update({
        ai_status: 'completed',
        ai_result: finalResult,
        ai_confidence: 0.9,
        sample_barcode: parsedData.sample_barcode,
        order_id: foundOrderId,
      })
      .eq('id', record.id)

    return new Response(JSON.stringify({
      success: true,
      log: statusLog,
      images_found: embeddedImages.length,
      waveforms_found: waveformData.length
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })

  } catch (error: any) {
    console.error(error)

    // Mark message as failed so it doesn't stay stuck as 'pending'
    try {
      const supabaseFallback = createClient(
        Deno.env.get('SUPABASE_URL') ?? '',
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
      )
      const payload = await req.clone().json().catch(() => null)
      const recordId = payload?.record?.id
      if (recordId) {
        await supabaseFallback
          .from('analyzer_raw_messages')
          .update({
            ai_status: 'failed',
            ai_result: { error: error.message, failed_at: new Date().toISOString() },
          })
          .eq('id', recordId)
      }
    } catch (_) { /* best effort */ }

    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    })
  }
})
