/**
 * Tests for the deterministic reference range resolver.
 *
 * Run with: npm run test:ranges
 *
 * The repo has no test runner, so this bundles the resolver with esbuild (already
 * a vite dependency) into a temp file and asserts against it with plain node.
 * Adding a framework for one pure module was not worth the dependency.
 */

import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = mkdtempSync(join(tmpdir(), 'ref-range-'));
const outFile = join(outDir, 'resolver.mjs');

// esbuild's JS API rather than the CLI: spawning npx.cmd fails with EINVAL on
// Windows under recent Node.
await build({
  entryPoints: [join(repoRoot, 'src/utils/referenceRangeResolver.ts')],
  bundle: true,
  format: 'esm',
  outfile: outFile,
  logLevel: 'warning',
});

const {
  resolveReferenceRange, selectMatchingRule, patientAgeInDays, normalizeGender,
  normalizePregnancy, agePartsToDays, daysToAgeParts, describeRule,
  findRuleConflicts, buildRangeContext,
} = await import(pathToFileURL(outFile).href);

process.on('exit', () => { try { rmSync(outDir, { recursive: true, force: true }); } catch {} });

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; } else { fail++; console.log(`FAIL ${name}\n  got  ${g}\n  want ${w}`); }
};

// --- helpers ---
eq('gender M', normalizeGender('M'), 'male');
eq('gender male lower', normalizeGender('male'), 'male');
eq('gender FEMALE', normalizeGender('FEMALE'), 'female');
eq('gender blank', normalizeGender(''), null);
eq('gender other', normalizeGender('Transgender'), 'other');
eq('preg trimester', normalizePregnancy('Trimester 2'), true);
eq('preg not', normalizePregnancy('Not Pregnant'), false);
eq('preg lactating', normalizePregnancy('Lactating'), false);
eq('preg blank', normalizePregnancy(''), null);

eq('age 30y', patientAgeInDays({age: 30, age_unit: 'years'}), 10957);
eq('age 6m', patientAgeInDays({age: 6, age_unit: 'months'}), 182);
eq('age 10d', patientAgeInDays({age: 10, age_unit: 'days'}), 10);
eq('age dob', patientAgeInDays({dob: '2000-01-01'}, new Date('2020-01-01T00:00:00Z')), 7305);
eq('age none', patientAgeInDays({}), null);
eq('roundtrip 12y', daysToAgeParts(agePartsToDays(12,'years')), {value:12, unit:'years'});

const FB = { reference_range: '10 - 20', reference_range_male: '13 - 17', reference_range_female: '12 - 15', low_critical: '5', high_critical: '30' };

// --- no rules: legacy chain ---
let r = resolveReferenceRange([], { gender: 'Male' }, FB);
eq('legacy male', [r.range_text, r.source, r.low, r.high], ['13 - 17','gender_column',13,17]);
r = resolveReferenceRange(null, { gender: 'Other' }, FB);
eq('legacy default', [r.range_text, r.source], ['10 - 20','lab_default']);
r = resolveReferenceRange(null, {}, { reference_range: '' });
eq('legacy none', [r.range_text, r.source], ['','none']);
eq('legacy criticals', [r.low_critical, r.high_critical], [null, null]);

// --- specificity ---
const rules = [
  { id: 'any',       range_text: '70 - 110' },
  { id: 'fasting',   sample_condition: 'Fasting Sample', range_text: '70 - 100' },
  { id: 'pp',        sample_condition: 'Post Prandial',  range_text: '< 140' },
  { id: 'female',    gender: 'female', range_text: '65 - 105' },
  { id: 'peds',      age_max_days: 5478, range_text: '60 - 100' },
  { id: 'fem-fast',  gender: 'female', sample_condition: 'Fasting Sample', range_text: '68 - 99' },
];

eq('cond beats gender',
   selectMatchingRule(rules, { gender: 'female', sampleCondition: 'Post Prandial' }).id, 'pp');
eq('most specific wins',
   selectMatchingRule(rules, { gender: 'Female', sampleCondition: 'fasting sample' }).id, 'fem-fast');
eq('condition case-insensitive',
   selectMatchingRule(rules, { sampleCondition: 'FASTING SAMPLE' }).id, 'fasting');
eq('gender only', selectMatchingRule(rules, { gender: 'F' }).id, 'female');
eq('male falls to any', selectMatchingRule(rules, { gender: 'M' }).id, 'any');
eq('peds by age', selectMatchingRule(rules, { gender: 'M', ageInDays: 3650 }).id, 'peds');
eq('adult skips peds', selectMatchingRule(rules, { gender: 'M', ageInDays: 10000 }).id, 'any');
// An age-scoped rule must not match an unknown age.
eq('unknown age skips age rule',
   selectMatchingRule([{id:'peds', age_max_days: 5478, range_text:'60 - 100'}], { gender: 'M' }), null);

// --- operator ranges parse ---
r = resolveReferenceRange(rules, { sampleCondition: 'Post Prandial' }, FB);
eq('pp parsed', [r.range_text, r.low, r.high, r.source, r.rule_id], ['< 140', null, 140, 'rule', 'pp']);

// --- precomputed numerics win over parsing ---
r = resolveReferenceRange([{ id:'x', range_text:'See note', range_low: 4, range_high: 9 }], {}, FB);
eq('precomputed', [r.low, r.high], [4, 9]);

// --- rule criticals override fallback, else inherit ---
r = resolveReferenceRange([{ id:'x', range_text:'1 - 2', low_critical: 0.5 }], {}, FB);
eq('crit mix', [r.low_critical, r.high_critical], [0.5, 30]);

// --- inactive + blank rules ignored ---
eq('inactive skipped',
   selectMatchingRule([{id:'a', range_text:'1-2', is_active:false},{id:'b', range_text:'3-4'}], {}).id, 'b');
eq('blank text skipped',
   selectMatchingRule([{id:'a', range_text:'   '},{id:'b', range_text:'3-4'}], {}).id, 'b');

// --- priority tie-break, then narrower band ---
eq('priority wins', selectMatchingRule([
  { id:'lo', gender:'male', range_text:'1-2', priority: 0 },
  { id:'hi', gender:'male', range_text:'3-4', priority: 5 },
], { gender:'male' }).id, 'hi');
eq('narrower band wins', selectMatchingRule([
  { id:'wide',   age_min_days: 0,    age_max_days: 36525, range_text:'1-2' },
  { id:'narrow', age_min_days: 6570, age_max_days: 10950, range_text:'3-4' },
], { ageInDays: 8000 }).id, 'narrow');

// --- determinism: identical inputs, shuffled rule order ---
const shuffled = [...rules].reverse();
eq('order independent',
   selectMatchingRule(shuffled, { gender:'Female', sampleCondition:'Fasting Sample' }).id,
   selectMatchingRule(rules,    { gender:'Female', sampleCondition:'Fasting Sample' }).id);

// --- pregnancy ---
const pregRules = [
  { id:'np', pregnancy: false, range_text:'0.4 - 4.0' },
  { id:'p1', pregnancy: true,  range_text:'0.1 - 2.5' },
];
eq('pregnant', selectMatchingRule(pregRules, { pregnancy: true }).id, 'p1');
eq('unknown pregnancy no match', selectMatchingRule(pregRules, {}), null);

// --- describeRule ---
eq('describe', describeRule({ id:'x', gender:'female', age_min_days: 4383, age_max_days: 18263, sample_condition:'Fasting Sample', range_text:'1-2' }),
   'Female, 12-50y, Fasting Sample');
eq('describe bare', describeRule({ id:'x', range_text:'1-2' }), 'Default');

// --- conflicts ---
const conflicts = findRuleConflicts([
  { id:'a', age_min_days: 0,   age_max_days: 3650, range_text:'1-2' },
  { id:'b', age_min_days: 3000, age_max_days: 7300, range_text:'3-4' },
]);
eq('overlap detected', conflicts.map(c => c.kind), ['overlap']);
const gaps = findRuleConflicts([
  { id:'a', age_min_days: 0,    age_max_days: 3650,  range_text:'1-2' },
  { id:'b', age_min_days: 7300, age_max_days: 20000, range_text:'3-4' },
]);
eq('gap detected', gaps.map(c => c.kind), ['gap']);

// --- buildRangeContext ---
const ctx = buildRangeContext({
  patient: { gender: 'F', age: 28, age_unit: 'years' },
  patientContext: { pregnancy_status: 'Trimester 1' },
  sampleCondition: 'Fasting Sample',
});
eq('ctx', [ctx.gender, ctx.pregnancy, ctx.sampleCondition, ctx.ageInDays], ['female', true, 'fasting sample', 10227]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
