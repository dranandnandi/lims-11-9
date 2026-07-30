// Percentage vs absolute-count discrimination for analyzer results.
//
// Haematology analyzers report the same mnemonic twice: GRAN# (6.2 10*9/L) and
// GRAN% (68.5 %). index.ts normalizeAnalyteName() strips '#' and '%', so both
// collapse to "gran" and either one could land on a percentage analyte — the
// first one in the HL7 message won and the other was rejected by
// uq_rv_result_analyte. Classifying both sides keeps a count out of a percentage
// analyte (and vice versa).

export type QuantityKind = 'percent' | 'absolute' | 'unknown'

export function unitQuantityKind(unit: unknown): QuantityKind {
  const u = String(unit ?? '').trim().toLowerCase()
  if (!u) return 'unknown'
  if (u === '%' || u.includes('percent')) return 'percent'
  if (/(10\s*[*^]?\s*\d|\/\s*[lu]l?\b|\/l\b|\/ul\b|\/µl\b|\/mm3\b|cells|g\/dl|mg\/dl|fl\b|pg\b|iu\/|u\/l|mmol|µmol|umol|ng\/|pmol)/.test(u)) {
    return 'absolute'
  }
  return 'unknown'
}

export function labelQuantityKind(label: unknown): QuantityKind {
  const raw = String(label ?? '')
  if (!raw.trim()) return 'unknown'
  if (/%|percent/i.test(raw)) return 'percent'
  if (/#|\babs\b|absolute|\bcount\b/i.test(raw)) return 'absolute'
  return 'unknown'
}

// The label ('GRAN%', 'Granulocyte Percentage') is the stronger signal because it
// is explicit; the unit is the fallback when the name says nothing.
export function quantityKind(label: unknown, unit: unknown): QuantityKind {
  const fromLabel = labelQuantityKind(label)
  return fromLabel !== 'unknown' ? fromLabel : unitQuantityKind(unit)
}

export function quantityKindsConflict(a: QuantityKind, b: QuantityKind): boolean {
  return a !== 'unknown' && b !== 'unknown' && a !== b
}

export function normalizeUnitForCompare(unit: unknown): string {
  return String(unit ?? '').toLowerCase().replace(/\s+/g, '').replace(/\*/g, '^')
}
