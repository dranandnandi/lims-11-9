// AI-Powered Order Dispatch
// For push analyzers, stores an outbound ORM^O01 order.
// For analyzer-initiated worklist analyzers, stores an ORR^O02 response payload
// that the bridge can serve when the analyzer queries by sample barcode.

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { GoogleGenerativeAI } from 'npm:@google/generative-ai'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface TestMapping {
  lims_code: string
  analyzer_code: string
  analyzer_display?: string | null
  analyzer_code_system?: string | null
  mapping_type?: string
  direction?: string
  hl7_field?: string | null
  value_map?: Record<string, unknown>
  metadata?: Record<string, unknown>
  confidence: number
  from_cache: boolean
  source?: 'lab_mapping' | 'profile_mapping' | 'ai' | 'fallback'
  lab_analyte_id?: string
  sample_type?: string
  specimen?: SpecimenMapping
}

interface LabAnalyteInfo {
  lab_analyte_id: string
  code: string
  name: string
  test_group_id?: string
  sample_type?: string
}

interface SpecimenMapping {
  lims_code: string
  analyzer_code: string
  analyzer_display?: string | null
  analyzer_code_system?: string | null
  hl7_field?: string | null
  value_map?: Record<string, unknown>
  metadata?: Record<string, unknown>
  source: 'lab_mapping' | 'profile_mapping'
}

interface OrderPayload {
  order_id: string
  sample_barcode: string
  analyzer_connection_id: string
  tests: string[]
  lab_analytes?: LabAnalyteInfo[]
  sample_type?: string
  patient?: {
    name: string
    dob?: string
    gender?: string
  }
  priority?: number
}

function normalizeHl7Sex(gender?: string): string {
  const value = (gender || '').trim().toLowerCase()
  if (!value) return ''
  if (['m', 'male'].includes(value)) return 'M'
  if (['f', 'female'].includes(value)) return 'F'
  if (['o', 'other', 'non-binary', 'nonbinary'].includes(value)) return 'O'
  if (['u', 'unknown', 'undisclosed', 'na', 'n/a'].includes(value)) return 'U'
  return String(gender).trim().slice(0, 1).toUpperCase()
}

function compactHl7Timestamp(date = new Date()): string {
  return date.toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)
}

function formatHl7Dob(dob?: string): string {
  if (!dob) return ''
  const digits = String(dob).replace(/\D/g, '')
  if (digits.length >= 14) return digits.slice(0, 14)
  if (digits.length >= 8) return `${digits.slice(0, 8)}000000`

  const parsed = new Date(dob)
  if (Number.isNaN(parsed.getTime())) return ''
  return `${parsed.toISOString().slice(0, 10).replace(/-/g, '')}000000`
}

// Strip whitespace and stray segment/field breaks from a single HL7 component.
// Analyzer-side code matching is usually exact-string, so trailing spaces in
// OBR-4 (e.g. "Random Blood Sugar ^...") silently break mapping on the instrument.
function cleanHl7Component(value: unknown): string {
  return String(value ?? '').replace(/[\r\n|]+/g, ' ').trim()
}

// Trim each component of a caret-composite code ("code^display^system") without
// collapsing the composite itself.
function cleanHl7Composite(value: unknown): string {
  return String(value ?? '')
    .split('^')
    .map((component) => cleanHl7Component(component))
    .join('^')
}

function getProfileSetting(profile: any, key: string, fallback = ''): string {
  return String(profile?.connection_settings?.[key] ?? profile?.[key] ?? fallback)
}

function isAnalyzerInitiated(profile: any, connection: any): boolean {
  const flow = connection?.config?.worklist_flow ?? profile?.connection_settings?.worklist_flow
  const responseType = profile?.ai_parsing_hints?.worklist_response_type
  return flow === 'analyzer_initiated' || responseType === 'ORR^O02'
}

function analyzerProtocol(profile: any): string {
  return String(profile?.protocol || 'HL7').trim().toUpperCase()
}

function normalizeSpecimenType(value?: string | null): string {
  const normalized = String(value ?? '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_')
  const aliases: Record<string, string> = {
    BLOOD: 'WHOLE_BLOOD',
    EDTA_BLOOD: 'WHOLE_BLOOD',
    EDTA_WHOLE_BLOOD: 'WHOLE_BLOOD',
  }
  return aliases[normalized] || normalized
}

function specimenField(mapping?: SpecimenMapping): string {
  return String(
    mapping?.hl7_field || mapping?.metadata?.astm_field || mapping?.metadata?.field || '',
  ).trim().toUpperCase()
}

function specimenCode(mapping?: SpecimenMapping): string {
  if (!mapping) return ''
  if (mapping.analyzer_code.includes('^')) return cleanHl7Composite(mapping.analyzer_code)
  const code = cleanHl7Component(mapping.analyzer_code)
  const display = cleanHl7Component(mapping.analyzer_display || mapping.lims_code)
  const system = cleanHl7Component(mapping.analyzer_code_system || 'LOCAL')
  return `${code}^${display}^${system}`
}

function supportsSpecimenField(protocol: string, mapping?: SpecimenMapping): boolean {
  const field = specimenField(mapping)
  if (protocol === 'ASTM') return field === 'O-16'
  return ['OBR-15', 'SPM-4', 'OBX-3'].includes(field)
}

interface ValidationWarning {
  type: 'low_confidence_mapping' | 'empty_analyzer_code' | 'unresolved_specimen'
  message: string
  lims_code?: string
  analyzer_code?: string
  confidence?: number
  sample_type?: string
}

// Non-blocking pre-send validation. Surfaces the exact conditions that produce a
// weak outbound message (fallback/AI-only mappings, empty codes, unmapped
// specimens) so they are visible on the queue entry and comm log instead of
// silently going out. The message is still staged/sent.
function validateOutboundMessage(
  mappedTests: TestMapping[],
  unresolvedSpecimenTypes: string[],
): ValidationWarning[] {
  const warnings: ValidationWarning[] = []

  for (const test of mappedTests) {
    const code = cleanHl7Component(test.analyzer_code)
    if (!code) {
      warnings.push({
        type: 'empty_analyzer_code',
        lims_code: test.lims_code,
        message: `Test "${test.lims_code}" has no analyzer code — OBR-4 will be empty.`,
      })
    }
    if (test.source === 'fallback' || test.source === 'ai' || (test.confidence ?? 1) < 0.9) {
      warnings.push({
        type: 'low_confidence_mapping',
        lims_code: test.lims_code,
        analyzer_code: code,
        confidence: test.confidence,
        message: `Test "${test.lims_code}" resolved via ${test.source ?? 'unknown'} mapping (confidence ${test.confidence}). ` +
          `Configure an explicit order_service mapping to the analyzer's master test code.`,
      })
    }
  }

  for (const sampleType of unresolvedSpecimenTypes) {
    warnings.push({
      type: 'unresolved_specimen',
      sample_type: sampleType,
      message: `Specimen "${sampleType}" has no specimen_mode mapping — the specimen field (e.g. OBR-15) will be blank.`,
    })
  }

  return warnings
}

function universalServiceId(test: TestMapping, profile: any): string {
  const fromMetadata = test.metadata?.universal_service_id
  if (typeof fromMetadata === 'string' && fromMetadata) return cleanHl7Composite(fromMetadata)

  const code = cleanHl7Component(test.analyzer_code)
  if (code.includes('^')) return cleanHl7Composite(code)

  const display = cleanHl7Component(test.analyzer_display || test.lims_code)
  const system = cleanHl7Component(
    test.analyzer_code_system || getProfileSetting(profile, 'obr4_coding_system', 'LOCAL'),
  )
  return `${code}^${display}^${system}`
}

function buildHl7Payload(
  payload: OrderPayload,
  mappedTests: TestMapping[],
  profile: any,
  messageControlId: string,
  messageType: 'ORM^O01' | 'ORR^O02',
) {
  const timestamp = compactHl7Timestamp()
  const patientSuffix = getProfileSetting(profile, 'patient_id_suffix', '')
  const diagnosticServiceId = getProfileSetting(profile, 'diagnostic_service_id', '')
  const characterSet = profile?.hl7_character_set || profile?.connection_settings?.character_set || ''
  const protocolVersion = profile?.protocol_version || profile?.connection_settings?.hl7_version || '2.5.1'

  return {
    message: {
      type: messageType,
      control_id: messageControlId,
      timestamp,
      protocol_version: protocolVersion,
      character_set: characterSet,
    },
    patient: {
      id: `${payload.sample_barcode}${patientSuffix}`,
      name: payload.patient?.name || '',
      dob: formatHl7Dob(payload.patient?.dob),
      gender: normalizeHl7Sex(payload.patient?.gender),
    },
    orc: {
      order_control: messageType === 'ORR^O02'
        ? getProfileSetting(profile, 'order_control_orr', 'AF')
        : getProfileSetting(profile, 'order_control_orm', 'NW'),
      placer_order_number: payload.sample_barcode,
      order_status: getProfileSetting(profile, 'order_status_orm', 'IP'),
    },
    obr: mappedTests.map((test, index) => ({
      set_id: index + 1,
      placer_order_number: payload.sample_barcode,
      filler_order_number: messageType === 'ORR^O02' ? payload.sample_barcode : '',
      universal_service_id: universalServiceId(test, profile),
      priority: payload.priority === 1 ? 'S' : 'R',
      requested_datetime: timestamp,
      diagnostic_serv_sect_id: diagnosticServiceId,
      lims_code: test.lims_code,
      specimen: test.specimen
        ? {
            sample_type: test.sample_type,
            field: specimenField(test.specimen),
            code: specimenCode(test.specimen),
            analyzer_code: test.specimen.analyzer_code,
            observation_id: test.specimen.metadata?.observation_id,
            value: test.specimen.value_map?.[normalizeSpecimenType(test.sample_type)] ??
              test.specimen.value_map?.default,
          }
        : null,
    })),
    obx: messageType === 'ORR^O02'
      ? [
          {
            set_id: 1,
            value_type: 'IS',
            observation_id: '08002^Blood Mode^99MRC',
            value: String(mappedTests[0]?.value_map?.blood_mode ?? 'W'),
            status: 'F',
          },
          {
            set_id: 2,
            value_type: 'IS',
            observation_id: '08003^Test Mode^99MRC',
            value: String(mappedTests[0]?.value_map?.test_mode ?? 'CBC+DIFF'),
            status: 'F',
          },
        ]
      : [],
  }
}

function generateHL7Order(
  payload: OrderPayload,
  mappedTests: TestMapping[],
  messageControlId: string,
  profile: any,
): { hl7Message: string; hl7Payload: Record<string, unknown> } {
  const hl7Payload = buildHl7Payload(payload, mappedTests, profile, messageControlId, 'ORM^O01')
  const p = hl7Payload as any
  const segments: string[] = []

  segments.push([
    'MSH',
    '^~\\&',
    'LIMSV2',
    'LAB',
    'ANALYZER',
    'ANALYZER',
    p.message.timestamp,
    '',
    'ORM^O01',
    messageControlId,
    'P',
    p.message.protocol_version,
  ].join('|'))

  if (payload.patient) {
    segments.push([
      'PID',
      '1',
      '',
      p.patient.id,
      '',
      p.patient.name,
      '',
      p.patient.dob,
      p.patient.gender,
    ].join('|'))
  }

  segments.push([
    'ORC',
    p.orc.order_control,
    p.orc.placer_order_number,
    '',
    '',
    p.orc.order_status,
  ].join('|'))

  for (const obr of p.obr) {
    const obrFields = [
      'OBR',
      String(obr.set_id),
      obr.placer_order_number,
      obr.filler_order_number,
      obr.universal_service_id,
      obr.priority,
      obr.requested_datetime,
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      obr.specimen?.field === 'OBR-15' ? obr.specimen.code : '',
    ]
    segments.push(obrFields.join('|'))

    if (obr.specimen?.field === 'SPM-4') {
      segments.push([
        'SPM',
        String(obr.set_id),
        obr.placer_order_number,
        '',
        obr.specimen.code,
      ].join('|'))
    }
  }

  return { hl7Message: segments.join('\r') + '\r', hl7Payload }
}

function generateHL7WorklistResponse(
  payload: OrderPayload,
  mappedTests: TestMapping[],
  messageControlId: string,
  profile: any,
): { hl7Message: string; hl7Payload: Record<string, unknown> } {
  const hl7Payload = buildHl7Payload(payload, mappedTests, profile, messageControlId, 'ORR^O02')
  const p = hl7Payload as any
  const segments: string[] = []

  segments.push([
    'MSH',
    '^~\\&',
    'LIMSV2',
    'LAB',
    'ANALYZER',
    '',
    p.message.timestamp,
    '',
    'ORR^O02',
    messageControlId,
    'P',
    p.message.protocol_version,
    '',
    '',
    '',
    '',
    '',
    p.message.character_set,
  ].join('|'))

  segments.push(['MSA', 'AA', messageControlId].join('|'))
  segments.push([
    'PID',
    '1',
    '',
    p.patient.id,
    '',
    p.patient.name,
    '',
    p.patient.dob,
    p.patient.gender,
  ].join('|'))
  segments.push(['ORC', p.orc.order_control, p.orc.placer_order_number].join('|'))

  for (const obr of p.obr) {
    const obrFields = [
      'OBR',
      String(obr.set_id),
      obr.placer_order_number,
      obr.filler_order_number,
      obr.universal_service_id,
      '',
      obr.requested_datetime,
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      obr.requested_datetime,
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      obr.diagnostic_serv_sect_id,
    ]
    if (obr.specimen?.field === 'OBR-15') obrFields[15] = obr.specimen.code
    segments.push(obrFields.join('|'))

    if (obr.specimen?.field === 'SPM-4') {
      segments.push([
        'SPM',
        String(obr.set_id),
        obr.placer_order_number,
        '',
        obr.specimen.code,
      ].join('|'))
    }
  }

  for (const obr of p.obr) {
    if (obr.specimen?.field !== 'OBX-3') continue
    segments.push([
      'OBX',
      String(p.obx.length + obr.set_id),
      'IS',
      String(obr.specimen.observation_id || obr.specimen.code),
      '',
      String(obr.specimen.value || obr.specimen.analyzer_code),
      '',
      '',
      '',
      '',
      '',
      'F',
    ].join('|'))
  }

  for (const obx of p.obx) {
    segments.push([
      'OBX',
      String(obx.set_id),
      obx.value_type,
      obx.observation_id,
      '',
      obx.value,
      '',
      '',
      '',
      '',
      '',
      obx.status,
    ].join('|'))
  }

  return { hl7Message: segments.join('\r') + '\r', hl7Payload }
}

function astmRepeatDelimiter(profile: any): string {
  const configured = astmDelimiter(profile?.repetition_delimiter || profile?.connection_settings?.repetition_delimiter)
  return configured || '~'
}

function astmDelimiter(value: unknown, fallback = ''): string {
  const raw = String(value ?? '').trim()
  if (!raw) return fallback
  if (raw === '\\\\') return '\\'
  return raw.slice(0, 1)
}

function astmTestCode(test: TestMapping): string {
  const fromMetadata = test.metadata?.astm_test_code
  if (typeof fromMetadata === 'string' && fromMetadata) return cleanHl7Component(fromMetadata)
  return cleanHl7Component(test.analyzer_code || test.lims_code)
}

function astmTestField(test: TestMapping, componentDelimiter: string): string {
  const fromMetadata = test.metadata?.astm_test_field
  if (typeof fromMetadata === 'string' && fromMetadata) return fromMetadata

  const code = astmTestCode(test)
  const display = cleanHl7Component(test.analyzer_display || test.lims_code || code)
  return [code, '', '', display].join(componentDelimiter)
}

function astmReceiverId(profile: any): string {
  return String(
    profile?.connection_settings?.astm_receiver_id ||
      profile?.connection_settings?.receiver_id ||
      profile?.connection_settings?.instrument_identifier ||
      profile?.astm_receiver_id ||
      profile?.receiver_id ||
      profile?.model ||
      profile?.name ||
      'ANALYZER',
  ).trim()
}

function buildAstmPayload(
  payload: OrderPayload,
  mappedTests: TestMapping[],
  profile: any,
  messageControlId: string,
  messageType: 'ASTM_ORDER' | 'ASTM_WORKLIST',
) {
  const timestamp = compactHl7Timestamp()
  const repeatDelimiter = astmRepeatDelimiter(profile)
  const componentDelimiter = astmDelimiter(profile?.component_delimiter, '^')
  const escapeDelimiter = astmDelimiter(profile?.escape_delimiter, '\\')
  const subcomponentDelimiter = astmDelimiter(profile?.subcomponent_delimiter, '&')
  const protocolVersion = profile?.protocol_version || 'E1394-97'
  const testField = mappedTests
    .map((test) => astmTestField(test, componentDelimiter))
    .join(repeatDelimiter)

  const receiverId = astmReceiverId(profile)

  return {
    protocol: 'ASTM',
    message: {
      type: messageType,
      control_id: messageControlId,
      timestamp,
      protocol_version: protocolVersion,
      receiver_id: receiverId,
    },
    delimiters: {
      field: '|',
      repeat: repeatDelimiter,
      component: componentDelimiter,
      escape: escapeDelimiter,
      subcomponent: subcomponentDelimiter,
    },
    patient: {
      id: payload.sample_barcode,
      name: payload.patient?.name || '',
      dob: formatHl7Dob(payload.patient?.dob).slice(0, 8),
      gender: normalizeHl7Sex(payload.patient?.gender),
    },
    order: {
      sample_id: payload.sample_barcode,
      priority: payload.priority === 1 ? 'S' : 'R',
      requested_datetime: timestamp,
      test_field: testField,
      specimen: mappedTests[0]?.specimen
        ? {
            sample_type: mappedTests[0].sample_type,
            analyzer_code: mappedTests[0].specimen?.analyzer_code,
            field: mappedTests[0].specimen?.metadata?.astm_field ||
              mappedTests[0].specimen?.hl7_field,
          }
        : null,
    },
    tests: mappedTests.map((test) => ({
      lims_code: test.lims_code,
      analyzer_code: astmTestCode(test),
      analyzer_display: test.analyzer_display || test.lims_code,
      test_field: astmTestField(test, componentDelimiter),
    })),
  }
}

function generateASTMOrder(
  payload: OrderPayload,
  mappedTests: TestMapping[],
  messageControlId: string,
  profile: any,
  messageType: 'ASTM_ORDER' | 'ASTM_WORKLIST',
): { hl7Message: string; hl7Payload: Record<string, unknown> } {
  const astmPayload = buildAstmPayload(payload, mappedTests, profile, messageControlId, messageType)
  const p = astmPayload as any
  const delimiterDeclaration = `${p.delimiters.escape}${p.delimiters.component}${p.delimiters.subcomponent}${p.delimiters.repeat}`
  const segments: string[] = []

  segments.push([
    'H',
    delimiterDeclaration,
    '',
    '',
    'LIMSV2',
    '',
    '',
    '',
    '',
    p.message.receiver_id || 'ANALYZER',
    '',
    'P',
    p.message.protocol_version,
    p.message.timestamp,
  ].join('|'))

  segments.push([
    'P',
    '1',
    '',
    p.patient.id,
    '',
    p.patient.name,
    '',
    p.patient.dob,
    p.patient.gender,
  ].join('|'))

  p.tests.forEach((test: any, index: number) => {
    const orderFields = [
      'O',
      String(index + 1),
      p.order.sample_id,
      '',
      test.test_field,
      p.order.priority,
      p.order.requested_datetime,
      '',
      '',
      '',
      '',
      'A',
    ]
    if (String(p.order.specimen?.field || '').toUpperCase() === 'O-16') {
      while (orderFields.length <= 16) orderFields.push('')
      orderFields[16] = p.order.specimen.analyzer_code
    }
    segments.push(orderFields.join('|'))
  })

  if (p.tests.length === 0) {
    const orderFields = [
      'O',
      '1',
      p.order.sample_id,
      '',
      p.order.test_field,
      p.order.priority,
      p.order.requested_datetime,
      '',
      '',
      '',
      '',
      'A',
    ]
    segments.push(orderFields.join('|'))
  }

  segments.push(['L', '1', 'N'].join('|'))

  return { hl7Message: segments.join('\r') + '\r', hl7Payload: astmPayload }
}

async function resolveSpecimenMappings(
  supabase: any,
  labId: string,
  analyzerProfileId: string,
  analyzerConnectionId: string | null,
  sampleTypes: string[],
): Promise<{ mappings: Map<string, SpecimenMapping>; unresolved: string[] }> {
  const normalizedTypes = [...new Set(sampleTypes.map(normalizeSpecimenType).filter(Boolean))]
  const mappings = new Map<string, SpecimenMapping>()
  if (normalizedTypes.length === 0) return { mappings, unresolved: [] }

  let labQuery = supabase
    .from('test_mappings')
    .select('*')
    .eq('lab_id', labId)
    .eq('mapping_type', 'specimen_mode')
    .in('direction', ['outbound', 'bidirectional'])

  if (analyzerConnectionId) {
    labQuery = labQuery.or(
      `analyzer_connection_id.eq.${analyzerConnectionId},analyzer_profile_id.eq.${analyzerProfileId},analyzer_id.eq.${analyzerProfileId}`,
    )
  } else {
    labQuery = labQuery.or(`analyzer_profile_id.eq.${analyzerProfileId},analyzer_id.eq.${analyzerProfileId}`)
  }

  const [{ data: labRows }, { data: profileRows }] = await Promise.all([
    labQuery,
    supabase
      .from('analyzer_profile_code_mappings')
      .select('*')
      .eq('analyzer_profile_id', analyzerProfileId)
      .eq('mapping_type', 'specimen_mode')
      .in('direction', ['outbound', 'bidirectional'])
      .eq('is_active', true),
  ])

  for (const row of profileRows ?? []) {
    const key = normalizeSpecimenType(row.lims_code)
    if (!normalizedTypes.includes(key)) continue
    mappings.set(key, {
      lims_code: row.lims_code,
      analyzer_code: row.analyzer_code,
      analyzer_display: row.analyzer_display,
      analyzer_code_system: row.analyzer_code_system,
      hl7_field: row.hl7_field,
      value_map: row.value_map ?? {},
      metadata: row.metadata ?? {},
      source: 'profile_mapping',
    })
  }

  const specificity = (row: any) => {
    if (analyzerConnectionId && row.analyzer_connection_id === analyzerConnectionId) return 3
    if (row.analyzer_profile_id === analyzerProfileId || row.analyzer_id === analyzerProfileId) return 2
    return 1
  }
  const labSpecificity = new Map<string, number>()
  for (const row of labRows ?? []) {
    const key = normalizeSpecimenType(row.lims_code)
    if (!normalizedTypes.includes(key)) continue
    const score = specificity(row)
    if ((labSpecificity.get(key) ?? 0) > score) continue
    labSpecificity.set(key, score)
    mappings.set(key, {
      lims_code: row.lims_code,
      analyzer_code: row.analyzer_code,
      analyzer_display: row.analyzer_display ?? row.test_name,
      analyzer_code_system: row.analyzer_code_system,
      hl7_field: row.hl7_field,
      value_map: row.value_map ?? {},
      metadata: row.metadata ?? {},
      source: 'lab_mapping',
    })
  }

  // Specimen send must be explicitly mapped. Inferred ASTM specimen values can
  // land in vendor-specific O fields and make the analyzer reject the order.
  const unresolved = normalizedTypes.filter(type => !mappings.has(type))

  return {
    mappings,
    unresolved: normalizedTypes.filter(type => !mappings.has(type)),
  }
}

function getCommonSpecimenCode(sampleType: string): string | null {
  const normalized = sampleType.toLowerCase().trim()
  const specimenCodes: Record<string, string> = {
    serum: 'SER',
    ser: 'SER',
    plasma: 'PLAS',
    plas: 'PLAS',
    'whole blood': 'WB',
    blood: 'WB',
    wb: 'WB',
    'edta blood': 'EDTA',
    edta: 'EDTA',
    urine: 'UR',
    ur: 'UR',
    'spot urine': 'UR',
    '24h urine': 'UR24',
    '24hr urine': 'UR24',
    csf: 'CSF',
    'cerebrospinal fluid': 'CSF',
    stool: 'STL',
    faeces: 'STL',
    feces: 'STL',
    sputum: 'SPT',
    swab: 'SWB',
    'throat swab': 'SWB',
    'nasal swab': 'SWB',
    tissue: 'TIS',
    biopsy: 'TIS',
    'synovial fluid': 'SNV',
    'pleural fluid': 'PLR',
    'ascitic fluid': 'ASC',
    'peritoneal fluid': 'ASC',
    saliva: 'SAL',
    semen: 'SEM',
    'seminal fluid': 'SEM',
    'amniotic fluid': 'AMN',
    'bone marrow': 'BM',
    hair: 'HAR',
    nail: 'NAL',
    'citrate blood': 'CIT',
    citrate: 'CIT',
    'fluoride blood': 'FL',
    fluoride: 'FL',
    heparin: 'HEP',
    'heparin blood': 'HEP',
  }
  return specimenCodes[normalized] || null
}

async function mapTestCodesWithAI(
  supabase: any,
  genAI: GoogleGenerativeAI,
  labId: string,
  analyzerProfileId: string,
  analyzerConnectionId: string | null,
  limsCodes: string[],
  labAnalytes?: LabAnalyteInfo[],
): Promise<TestMapping[]> {
  const mappedTests: TestMapping[] = []
  const unmappedCodes: string[] = []
  const unmappedLabAnalytes: LabAnalyteInfo[] = []

  const canSendMapping = (row: any) => row?.supports_order_send !== false

  const pushMapping = (limsCode: string, row: any, source: TestMapping['source'], labAnalyteId?: string) => {
    mappedTests.push({
      lims_code: cleanHl7Component(limsCode),
      analyzer_code: cleanHl7Component(row.analyzer_code),
      analyzer_display: row.analyzer_display == null ? null : cleanHl7Component(row.analyzer_display),
      analyzer_code_system: row.analyzer_code_system == null ? null : cleanHl7Component(row.analyzer_code_system),
      mapping_type: row.mapping_type ?? 'order_service',
      direction: row.direction ?? 'outbound',
      hl7_field: row.hl7_field ?? null,
      value_map: row.value_map ?? {},
      metadata: row.metadata ?? {},
      confidence: row.ai_confidence ?? 1,
      from_cache: true,
      source,
      lab_analyte_id: labAnalyteId,
    })
  }

  const uniqueLabAnalytes = Array.from(
    new Map((labAnalytes ?? []).map((la) => [la.lab_analyte_id, la])).values(),
  )
  const labAnalyteIds = uniqueLabAnalytes.map((la) => la.lab_analyte_id).filter(Boolean)
  const lookupCodes = [
    ...new Set([
      ...limsCodes,
      ...uniqueLabAnalytes.map((la) => la.code),
    ].filter(Boolean)),
  ]
  const mappingSpecificity = (row: any) => {
    if (analyzerConnectionId && row.analyzer_connection_id === analyzerConnectionId) return 3
    if (row.analyzer_profile_id === analyzerProfileId || row.analyzer_id === analyzerProfileId) return 2
    return 1
  }
  const setPreferredMapping = (map: Map<string, any>, key: string, row: any) => {
    const existing = map.get(key)
    if (!existing || mappingSpecificity(row) > mappingSpecificity(existing)) {
      map.set(key, row)
    }
  }

  // 1. PRIMARY: Lookup by lab_analyte_id (most specific)
  const labAnalyteMappings = new Map<string, any>()
  if (labAnalyteIds.length > 0) {
    let laQuery = supabase
      .from('test_mappings')
      .select('*')
      .eq('lab_id', labId)
      .eq('mapping_type', 'order_service')
      .in('direction', ['outbound', 'bidirectional'])
      .in('lab_analyte_id', labAnalyteIds)

    if (analyzerConnectionId) {
      laQuery = laQuery.or(`analyzer_connection_id.eq.${analyzerConnectionId},analyzer_connection_id.is.null`)
    }

    const { data: laRows } = await laQuery
    for (const row of laRows ?? []) {
      if (row.lab_analyte_id) {
        setPreferredMapping(labAnalyteMappings, row.lab_analyte_id, row)
      }
    }
  }

  // 2. FALLBACK: Lookup by lims_code (legacy/backward compat)
  const profileMappings = new Map<string, any>()
  const { data: profileRows } = await supabase
    .from('analyzer_profile_code_mappings')
    .select('*')
    .eq('analyzer_profile_id', analyzerProfileId)
    .eq('mapping_type', 'order_service')
    .in('direction', ['outbound', 'bidirectional'])
    .eq('is_active', true)
    .in('lims_code', lookupCodes)

  for (const row of profileRows ?? []) {
    profileMappings.set(String(row.lims_code).toUpperCase(), row)
  }

  const labCodeMappings = new Map<string, any>()
  let labQuery = supabase
    .from('test_mappings')
    .select('*')
    .eq('lab_id', labId)
    .eq('mapping_type', 'order_service')
    .in('direction', ['outbound', 'bidirectional'])
    .in('lims_code', lookupCodes)

  if (analyzerConnectionId) {
    labQuery = labQuery.or(`analyzer_connection_id.eq.${analyzerConnectionId},analyzer_profile_id.eq.${analyzerProfileId},analyzer_id.eq.${analyzerProfileId}`)
  } else {
    labQuery = labQuery.or(`analyzer_profile_id.eq.${analyzerProfileId},analyzer_id.eq.${analyzerProfileId}`)
  }

  const { data: labRows } = await labQuery
  for (const row of labRows ?? []) {
    setPreferredMapping(labCodeMappings, String(row.lims_code).toUpperCase(), row)
  }

  // 3. Resolution: lab_analyte_id first, then lims_code, then profile, else unmapped
  if (uniqueLabAnalytes.length > 0) {
    // New path: resolve using lab_analyte_id
    for (const la of uniqueLabAnalytes) {
      const laMapping = labAnalyteMappings.get(la.lab_analyte_id)
      if (laMapping) {
        if (!canSendMapping(laMapping)) continue
        pushMapping(la.code, laMapping, 'lab_mapping', la.lab_analyte_id)
        continue
      }

      const codeKey = String(la.code).toUpperCase()
      const codeMapping = labCodeMappings.get(codeKey)
      if (codeMapping) {
        if (!canSendMapping(codeMapping)) continue
        pushMapping(la.code, codeMapping, 'lab_mapping', la.lab_analyte_id)
        continue
      }

      const profileMapping = profileMappings.get(codeKey)
      if (profileMapping) {
        if (!canSendMapping(profileMapping)) continue
        pushMapping(la.code, profileMapping, 'profile_mapping', la.lab_analyte_id)
        continue
      }

      unmappedLabAnalytes.push(la)
      unmappedCodes.push(la.code)
    }
  } else {
    // Legacy path: resolve using lims_code only
    for (const limsCode of limsCodes) {
      const key = String(limsCode).toUpperCase()
      const labMapping = labCodeMappings.get(key)
      const profileMapping = profileMappings.get(key)

      if (labMapping) {
        if (!canSendMapping(labMapping)) continue
        pushMapping(limsCode, labMapping, 'lab_mapping')
      } else if (profileMapping) {
        if (!canSendMapping(profileMapping)) continue
        pushMapping(limsCode, profileMapping, 'profile_mapping')
      } else {
        unmappedCodes.push(limsCode)
      }
    }
  }

  // 4. AI fallback for unmapped codes
  if (unmappedCodes.length > 0) {
    const { data: profile } = await supabase
      .from('analyzer_profiles')
      .select('*')
      .eq('id', analyzerProfileId)
      .single()

    const { data: existingMappings } = await supabase
      .from('test_mappings')
      .select('lims_code, analyzer_code')
      .eq('lab_id', labId)
      .or(`analyzer_id.eq.${analyzerProfileId},analyzer_profile_id.eq.${analyzerProfileId}`)
      .gt('usage_count', 0)
      .limit(50)

    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' })
    const prompt = `You are a laboratory interface expert. Map LIMS test codes to analyzer order service codes.

ANALYZER PROFILE:
- Manufacturer: ${profile?.manufacturer || 'Unknown'}
- Model: ${profile?.model || 'Unknown'}
- Protocol: ${profile?.protocol || 'HL7'}
- Supported Tests: ${profile?.supported_tests?.join(', ') || 'Various'}

EXISTING SUCCESSFUL MAPPINGS:
${existingMappings?.map((m: any) => `${m.lims_code} -> ${m.analyzer_code}`).join('\n') || 'None yet'}

CODES TO MAP:
${unmappedCodes.join(', ')}

SPECIMEN NOTE:
Specimen/sample type is mapped independently through mapping_type=specimen_mode.
Do not invent specimen codes or include them in order_service mappings.

OUTPUT ONLY valid JSON:
{
  "mappings": [
    {"lims_code": "CBC", "analyzer_code": "00001", "analyzer_display": "Automated Count", "analyzer_code_system": "99MRC", "confidence": 0.95}
  ]
}`

    try {
      const result = await model.generateContent(prompt)
      const text = result.response.text()
      const jsonMatch = text.match(/\{[\s\S]*\}/)

      if (jsonMatch) {
        const aiResult = JSON.parse(jsonMatch[0])

        for (const mapping of aiResult.mappings || []) {
          const matchedLa = unmappedLabAnalytes.find(
            (la) => String(la.code).toUpperCase() === String(mapping.lims_code).toUpperCase()
          )

          mappedTests.push({
            lims_code: cleanHl7Component(mapping.lims_code),
            analyzer_code: cleanHl7Component(mapping.analyzer_code),
            analyzer_display: cleanHl7Component(mapping.analyzer_display || mapping.lims_code),
            analyzer_code_system: cleanHl7Component(mapping.analyzer_code_system || 'LOCAL'),
            mapping_type: 'order_service',
            direction: 'outbound',
            value_map: {},
            metadata: {},
            confidence: mapping.confidence || 0.7,
            from_cache: false,
            source: 'ai',
            lab_analyte_id: matchedLa?.lab_analyte_id,
          })

          await supabase.rpc('save_ai_mapping', {
            p_lab_id: labId,
            p_lims_code: mapping.lims_code,
            p_analyzer_code: mapping.analyzer_code,
            p_analyzer_id: analyzerProfileId,
            p_confidence: mapping.confidence || 0.7,
            p_test_name: mapping.analyzer_display || mapping.lims_code,
            p_lab_analyte_id: matchedLa?.lab_analyte_id || null,
          })
        }
      }
    } catch (e) {
      console.error('AI mapping failed:', e)
      for (const code of unmappedCodes) {
        const matchedLa = unmappedLabAnalytes.find(
          (la) => String(la.code).toUpperCase() === String(code).toUpperCase()
        )
        const cleanCode = cleanHl7Component(code)
        mappedTests.push({
          lims_code: cleanCode,
          analyzer_code: cleanCode,
          analyzer_display: cleanCode,
          analyzer_code_system: 'LOCAL',
          mapping_type: 'order_service',
          direction: 'outbound',
          value_map: {},
          metadata: {},
          confidence: 0.5,
          from_cache: false,
          source: 'fallback',
          lab_analyte_id: matchedLa?.lab_analyte_id,
        })
      }
    }
  }

  return mappedTests
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const payload: OrderPayload = await req.json()

    if (!payload.order_id || !payload.sample_barcode || !payload.tests?.length) {
      return new Response(JSON.stringify({
        error: 'Missing required fields: order_id, sample_barcode, tests',
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 400,
      })
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    )
    const genAI = new GoogleGenerativeAI(Deno.env.get('GEMINI_API_KEY') || '')

    const { data: connection, error: connError } = await supabase
      .from('analyzer_connections')
      .select('*, profile:analyzer_profiles(*)')
      .eq('id', payload.analyzer_connection_id)
      .single()

    if (connError || !connection) {
      return new Response(JSON.stringify({ error: 'Analyzer connection not found' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 404,
      })
    }

    const baseProfile = connection.profile ?? {}
    const connectionConfig = connection.config ?? {}

    // Receive-only analyzers must never have an order/worklist staged for them.
    // Results are still ingested by barcode via process-analyzer-result.
    if (connectionConfig.direction === 'receive_only') {
      return new Response(JSON.stringify({
        success: true,
        skipped: true,
        reason: 'Receive-only analyzer — orders are not sent to this instrument',
        analyzer_connection_id: payload.analyzer_connection_id,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const profile = {
      ...baseProfile,
      connection_settings: {
        ...(baseProfile.connection_settings ?? {}),
        ...connectionConfig,
      },
      ai_parsing_hints: {
        ...(baseProfile.ai_parsing_hints ?? {}),
        ...(connectionConfig.ai_parsing_hints ?? {}),
      },
    }
    const analyzerInitiated = isAnalyzerInitiated(profile, connection)
    const protocol = analyzerProtocol(profile)
    const initialMessageType = protocol === 'ASTM'
      ? (analyzerInitiated ? 'ASTM_WORKLIST' : 'ASTM_ORDER')
      : (analyzerInitiated ? 'ORR^O02' : 'ORM^O01')
    const messageControlId = `LIMS${Date.now()}`

    const { data: queueEntry, error: queueError } = await supabase
      .from('analyzer_order_queue')
      .insert({
        lab_id: connection.lab_id,
        analyzer_connection_id: payload.analyzer_connection_id,
        order_id: payload.order_id,
        sample_barcode: payload.sample_barcode,
        patient_name: payload.patient?.name || null,
        patient_dob: payload.patient?.dob || null,
        patient_gender: payload.patient?.gender || null,
        requested_tests: payload.tests,
        status: 'pending',
        ai_status: 'processing',
        priority: payload.priority || 5,
        message_control_id: messageControlId,
        flow_type: analyzerInitiated ? 'analyzer_initiated' : 'lims_push',
        request_message_type: analyzerInitiated ? null : initialMessageType,
        response_message_type: analyzerInitiated ? initialMessageType : null,
      })
      .select()
      .single()

    if (queueError) {
      throw new Error(`Queue entry failed: ${queueError.message}`)
    }

    const mappedTests = await mapTestCodesWithAI(
      supabase,
      genAI,
      connection.lab_id,
      connection.profile_id || 'generic-hl7',
      payload.analyzer_connection_id,
      payload.tests,
      payload.lab_analytes,
    )

    const sampleTypeByLabAnalyte = new Map(
      (payload.lab_analytes ?? []).map(item => [
        item.lab_analyte_id,
        item.sample_type || payload.sample_type || '',
      ]),
    )
    const sampleTypes = [
      payload.sample_type || '',
      ...(payload.lab_analytes ?? []).map(item => item.sample_type || ''),
    ].filter(Boolean)
    const specimenResolution = await resolveSpecimenMappings(
      supabase,
      connection.lab_id,
      connection.profile_id || 'generic-hl7',
      payload.analyzer_connection_id,
      sampleTypes,
    )
    const unsupportedSpecimenTypes = [...specimenResolution.mappings.entries()]
      .filter(([, mapping]) => !supportsSpecimenField(protocol, mapping))
      .map(([sampleType]) => sampleType)
    const unresolvedSpecimenTypes = [
      ...new Set([...specimenResolution.unresolved, ...unsupportedSpecimenTypes]),
    ]

    for (const test of mappedTests) {
      const sampleType = test.lab_analyte_id
        ? sampleTypeByLabAnalyte.get(test.lab_analyte_id) || payload.sample_type || ''
        : payload.sample_type || ''
      test.sample_type = sampleType
      const mapping = specimenResolution.mappings.get(normalizeSpecimenType(sampleType))
      test.specimen = supportsSpecimenField(protocol, mapping) ? mapping : undefined
    }

    const generated = protocol === 'ASTM'
      ? generateASTMOrder(
          payload,
          mappedTests,
          messageControlId,
          profile,
          analyzerInitiated ? 'ASTM_WORKLIST' : 'ASTM_ORDER',
        )
      : analyzerInitiated
        ? generateHL7WorklistResponse(payload, mappedTests, messageControlId, profile)
        : generateHL7Order(payload, mappedTests, messageControlId, profile)
    const messageType = initialMessageType
    const validationWarnings = validateOutboundMessage(mappedTests, unresolvedSpecimenTypes)

    await supabase
      .from('analyzer_order_queue')
      .update({
        status: 'mapped',
        ai_status: 'completed',
        mapped_at: new Date().toISOString(),
        resolved_tests: mappedTests,
        hl7_message: generated.hl7Message,
        hl7_payload: generated.hl7Payload,
        request_message_type: analyzerInitiated ? null : messageType,
        response_message_type: analyzerInitiated ? messageType : null,
        ai_mapping_log: {
          timestamp: new Date().toISOString(),
          protocol,
          total_tests: payload.tests.length,
          cached_mappings: mappedTests.filter((t) => t.from_cache).length,
          ai_mappings: mappedTests.filter((t) => !t.from_cache).length,
          average_confidence: mappedTests.reduce((sum, t) => sum + t.confidence, 0) / mappedTests.length,
          unresolved_specimen_types: unresolvedSpecimenTypes,
          validation_warnings: validationWarnings,
        },
      })
      .eq('id', queueEntry.id)

    await supabase
      .from('analyzer_comm_log')
      .insert({
        lab_id: connection.lab_id,
        analyzer_connection_id: payload.analyzer_connection_id,
        direction: 'SEND',
        message_type: messageType,
        message_control_id: messageControlId,
        message_preview: generated.hl7Message.slice(0, 500),
        message_size: generated.hl7Message.length,
        success: true,
        order_id: payload.order_id,
        queue_id: queueEntry.id,
        // Summarised into error_message so warnings are visible in the log stream
        // without a schema change; success stays true (non-blocking).
        error_message: validationWarnings.length
          ? `${validationWarnings.length} validation warning(s): ${validationWarnings.map((w) => w.type).join(', ')}`
          : null,
      })

    return new Response(JSON.stringify({
      success: true,
      queue_id: queueEntry.id,
      message_control_id: messageControlId,
      mapped_tests: mappedTests,
      unresolved_specimen_types: unresolvedSpecimenTypes,
      validation_warnings: validationWarnings,
      hl7_message: generated.hl7Message,
      hl7_payload: generated.hl7Payload,
      flow_type: analyzerInitiated ? 'analyzer_initiated' : 'lims_push',
      response_message_type: messageType,
      stats: {
        total_tests: payload.tests.length,
        cached: mappedTests.filter((t) => t.from_cache).length,
        ai_mapped: mappedTests.filter((t) => !t.from_cache).length,
        avg_confidence: (mappedTests.reduce((sum, t) => sum + t.confidence, 0) / mappedTests.length).toFixed(2),
      },
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (error: any) {
    console.error('Dispatch error full:', error?.message, JSON.stringify(error))
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    })
  }
})
