import { assertEquals } from 'jsr:@std/assert@1'
import { quantityKind, quantityKindsConflict, normalizeUnitForCompare } from './quantityKind.ts'

// The Mindray 3-part message that mis-populated order 2607250007: MID#/GRAN#
// (counts) and MID%/GRAN% (percentages) share a mnemonic once '#'/'%' is stripped.
const MACHINE_RESULTS: Array<[name: string, unit: string, expected: string]> = [
  ['WBC', '10*9/L', 'absolute'],
  ['LYM#', '10*9/L', 'absolute'],
  ['LYM%', '%', 'percent'],
  ['RBC', '10*12/L', 'absolute'],
  ['HGB', 'g/dL', 'absolute'],
  ['MCV', 'fL', 'absolute'],
  ['MCH', 'pg', 'absolute'],
  ['MCHC', 'g/dL', 'absolute'],
  ['RDW-CV', '%', 'percent'],
  ['RDW-SD', 'fL', 'absolute'],
  ['HCT', '%', 'percent'],
  ['PLT', '10*9/L', 'absolute'],
  ['MPV', 'fL', 'absolute'],
  ['PDW', '', 'unknown'],
  ['PCT', '%', 'percent'],
  ['MID#', '10*9/L', 'absolute'],
  ['MID%', '%', 'percent'],
  ['GRAN#', '10*9/L', 'absolute'],
  ['GRAN%', '%', 'percent'],
  ['PLCC', '10*9/L', 'absolute'],
  ['PLCR', '%', 'percent'],
]

Deno.test('machine mnemonics classify by suffix then unit', () => {
  for (const [name, unit, expected] of MACHINE_RESULTS) {
    assertEquals(quantityKind(name, unit), expected, `${name} (${unit})`)
  }
})

// Analyte names as configured in the CBC (3-Part) panel on the affected order.
const ANALYTES: Array<[name: string, unit: string, expected: string]> = [
  ['Granulocyte Percentage', '%', 'percent'],
  ['Lymphocytes (%)', '%', 'percent'],
  ['Monocytes (%)', '%', 'percent'],
  ['Eosinophils (%)', '%', 'percent'],
  ['Total WBC Count', '10*9/L', 'absolute'],
  ['Platelet Count', '10*9/L', 'absolute'],
  ['Hemoglobin', 'g/dL', 'absolute'],
  ['Hematocrit', '%', 'percent'],
  ['Mean Corpuscular Volume (MCV)', 'fL', 'absolute'],
  // A lab that left the unit blank stays 'unknown' — never a false rejection.
  ['Monocytes', '', 'unknown'],
]

Deno.test('analyte names classify by name then configured unit', () => {
  for (const [name, unit, expected] of ANALYTES) {
    assertEquals(quantityKind(name, unit), expected, `${name} (${unit})`)
  }
})

Deno.test('GRAN# is rejected for a percentage analyte, GRAN% is accepted', () => {
  const analyte = quantityKind('Granulocyte Percentage', '%')
  assertEquals(quantityKindsConflict(quantityKind('GRAN#', '10*9/L'), analyte), true)
  assertEquals(quantityKindsConflict(quantityKind('GRAN%', '%'), analyte), false)
})

Deno.test('MID# is rejected for Monocytes (%), MID% is accepted', () => {
  const analyte = quantityKind('Monocytes (%)', '%')
  assertEquals(quantityKindsConflict(quantityKind('MID#', '10*9/L'), analyte), true)
  assertEquals(quantityKindsConflict(quantityKind('MID%', '%'), analyte), false)
})

Deno.test('an unknown side never conflicts', () => {
  assertEquals(quantityKindsConflict(quantityKind('PDW', ''), quantityKind('PDW', '')), false)
  assertEquals(quantityKindsConflict(quantityKind('GRAN#', '10*9/L'), quantityKind('Monocytes', '')), false)
})

Deno.test('unit comparison ignores spacing and * vs ^', () => {
  assertEquals(normalizeUnitForCompare('10*9/L'), normalizeUnitForCompare('10^9 / l'))
  assertEquals(normalizeUnitForCompare('%'), normalizeUnitForCompare(' % '))
})

// Scoring mirrors the collision resolver in index.ts: on a tie for one analyte,
// the candidate whose unit matches the analyte's configured unit must win.
Deno.test('collision scoring prefers the unit-matching candidate', () => {
  const analyteUnit = '%'
  const score = (machineName: string, machineUnit: string) => {
    const aKind = quantityKind('Granulocyte Percentage', analyteUnit)
    const mKind = quantityKind(machineName, machineUnit)
    return (normalizeUnitForCompare(analyteUnit) === normalizeUnitForCompare(machineUnit) ? 100 : 0)
      + (mKind !== 'unknown' && mKind === aKind ? 50 : 0)
  }
  const gran = score('GRAN#', '10*9/L')
  const granPct = score('GRAN%', '%')
  assertEquals(granPct > gran, true)
})
