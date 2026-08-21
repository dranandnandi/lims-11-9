/**
 * Tests for the WhatsApp sender cascade (location -> lab -> current user).
 *
 * Run with: npm run test:whatsapp-sender
 *
 * Follows the same shape as test-reference-range-resolver.mjs: no test runner in
 * the repo, so esbuild (already a vite dependency) bundles the module and plain
 * node asserts against it.
 *
 * The browser resolver imports the real supabase client, so this exercises the
 * Deno mirror instead, which takes its client as an argument. The two are
 * hand-kept in step; the cascade they encode is identical.
 */

import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = mkdtempSync(join(tmpdir(), 'wa-sender-'));
const outFile = join(outDir, 'sender.mjs');

await build({
  entryPoints: [join(repoRoot, 'supabase/functions/_shared/whatsappSender.ts')],
  bundle: true,
  format: 'esm',
  outfile: outFile,
  logLevel: 'warning',
});

const { resolveWhatsAppSender, formatPhoneForSender } =
  await import(pathToFileURL(outFile).href);

process.on('exit', () => { try { rmSync(outDir, { recursive: true, force: true }); } catch {} });

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`ok   ${name}`); }
  else { fail++; console.log(`FAIL ${name}\n       got  ${g}\n       want ${w}`); }
};

/** Minimal stand-in for the supabase client: two tables of plain rows. */
function fakeClient({ labs = {}, locations = {} } = {}) {
  return {
    from(table) {
      const rows = table === 'labs' ? labs : locations;
      let wanted = null;
      const q = {
        select() { return q; },
        eq(_col, value) { wanted = value; return q; },
        maybeSingle() { return Promise.resolve({ data: rows[wanted] ?? null, error: null }); },
      };
      return q;
    },
  };
}

const LAB = 'lab-1';
const labs = { [LAB]: { whatsapp_user_id: 'user-lab', country_code: '+91' } };

// --- cascade ---------------------------------------------------------------
eq('lab default when no location given',
  await resolveWhatsAppSender(fakeClient({ labs }), { labId: LAB }),
  { userId: 'user-lab', countryCode: '+91', source: 'lab', locationId: null });

eq('branch sender wins over lab default',
  await resolveWhatsAppSender(
    fakeClient({ labs, locations: { 'loc-a': { id: 'loc-a', name: 'Branch A', whatsapp_user_id: 'user-a', whatsapp_country_code: null } } }),
    { labId: LAB, locationId: 'loc-a' }),
  { userId: 'user-a', countryCode: '+91', source: 'location', locationId: 'loc-a' });

eq('branch with no sender inherits the lab',
  await resolveWhatsAppSender(
    fakeClient({ labs, locations: { 'loc-b': { id: 'loc-b', name: 'Branch B', whatsapp_user_id: null, whatsapp_country_code: null } } }),
    { labId: LAB, locationId: 'loc-b' }),
  { userId: 'user-lab', countryCode: '+91', source: 'lab', locationId: null });

eq('two branches resolve to different senders',
  await Promise.all(['loc-a', 'loc-b'].map(id => resolveWhatsAppSender(
    fakeClient({ labs, locations: {
      'loc-a': { id: 'loc-a', name: 'A', whatsapp_user_id: 'user-a', whatsapp_country_code: null },
      'loc-b': { id: 'loc-b', name: 'B', whatsapp_user_id: 'user-b', whatsapp_country_code: null },
    } }),
    { labId: LAB, locationId: id }).then(r => r.userId))),
  ['user-a', 'user-b']);

// A branch's dialling code describes the region it serves, so it must survive
// inheriting the lab's sender account.
eq('branch overrides only the country code',
  await resolveWhatsAppSender(
    fakeClient({ labs, locations: { 'loc-c': { id: 'loc-c', name: 'C', whatsapp_user_id: null, whatsapp_country_code: '+971' } } }),
    { labId: LAB, locationId: 'loc-c' }),
  { userId: 'user-lab', countryCode: '+971', source: 'lab', locationId: null });

eq('branch overrides sender and country code together',
  await resolveWhatsAppSender(
    fakeClient({ labs, locations: { 'loc-d': { id: 'loc-d', name: 'D', whatsapp_user_id: 'user-d', whatsapp_country_code: '+971' } } }),
    { labId: LAB, locationId: 'loc-d' }),
  { userId: 'user-d', countryCode: '+971', source: 'location', locationId: 'loc-d' });

eq('unconfigured lab yields no sender',
  await resolveWhatsAppSender(fakeClient({ labs: { [LAB]: { whatsapp_user_id: null, country_code: '+91' } } }), { labId: LAB }),
  { userId: null, countryCode: '+91', source: 'none', locationId: null });

eq('missing location falls back rather than throwing',
  await resolveWhatsAppSender(fakeClient({ labs }), { labId: LAB, locationId: 'does-not-exist' }),
  { userId: 'user-lab', countryCode: '+91', source: 'lab', locationId: null });

eq('no labId short-circuits',
  (await resolveWhatsAppSender(fakeClient({ labs }), { labId: '' })).source, 'none');

// --- phone formatting ------------------------------------------------------
eq('10 digits gets the code',    formatPhoneForSender('9876543210', '+91'), '+919876543210');
eq('leading zero stripped',      formatPhoneForSender('09876543210', '+91'), '+919876543210');
eq('punctuation ignored',        formatPhoneForSender('+91 98765-43210', '+91'), '+919876543210');
eq('already prefixed',           formatPhoneForSender('919876543210', '+91'), '+919876543210');
eq('branch country code used',   formatPhoneForSender('5012345678', '+971'), '+9715012345678');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
