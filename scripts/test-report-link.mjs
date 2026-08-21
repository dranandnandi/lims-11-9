/**
 * Phase 0 + Phase 1 harness for the pre-generated report link (report-link fn).
 *
 * Run with: npm run test:report-link -- <command> [args]
 *
 * Nothing here touches generate-pdf-letterhead. Phase 0 proves the resolver
 * against reports that already exist; Phase 1 fakes the PDF.co temp leg by
 * writing report_links directly, so the full temp -> permanent handover is
 * validated before a single line of the generator changes.
 *
 * Commands
 *   audit                      Survey what is in the DB: completed reports,
 *                              storage-backed vs PDF.co-backed pdf_url, labs.
 *   pick [n]                   List n candidate completed orders (default 10).
 *   seed <orderId...>          Create stable tokens via ensure_report_link().
 *   seed --auto [n]            Pick n candidates and seed them in one go.
 *   list                       Show every seeded link and its current state.
 *   check <token>              Resolve one token: JSON state, the 302 Location,
 *                              and a HEAD against the target (type + size).
 *   check-all                  Run check over every seeded token.
 *   by-order <orderId>         Everything about one order: queue, reports row,
 *                              every link row, and a live resolve. Use this
 *                              right after generating from the Reports page.
 *   enable-lab <labId> [on|off]  Flip labs.report_link_enabled. PRODUCTION
 *                              BEHAVIOUR CHANGE -- run deliberately.
 *   simulate-temp <token> <url>  Phase 1: clear permanent_url, install a live
 *                              PDF.co temp URL, then resolve.
 *   expire-temp <token>        Phase 1: backdate temp_expires_at to prove the
 *                              resolver stops trusting a dead temp URL.
 *   promote <token> [url]      Phase 1: set permanent_url (defaults to the
 *                              order's real reports.pdf_url) and re-resolve --
 *                              the same token must now serve storage.
 *   reset <token>              Back to pending: both URLs cleared.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------- env

function loadEnv() {
  const out = {};
  for (const file of ['.env', '.env.local']) {
    let raw;
    try {
      raw = readFileSync(join(repoRoot, file), 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      let v = m[2].trim();
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) {
        v = v.slice(1, -1);
      }
      out[m[1]] = v;
    }
  }
  return { ...out, ...process.env };
}

const env = loadEnv();
const SUPABASE_URL = env.VITE_SUPABASE_URL || env.SUPABASE_URL;
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error(
    'Missing VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env',
  );
  process.exit(1);
}

const FN_BASE = `${SUPABASE_URL.replace(/\/+$/, '')}/functions/v1/report-link`;
const db = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
});

// ---------------------------------------------------------------- helpers

const isEphemeral = (u) => !!u && /pdf\.co|pdf-temp-files|pdfco/i.test(u);
const tokenUrl = (t) => `${FN_BASE}/${t}.pdf`;

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

function die(msg) {
  console.error(c.red(msg));
  process.exit(1);
}

/** Resolve a token exactly as a patient's browser would, without following. */
async function resolveToken(token) {
  const out = { token, url: tokenUrl(token) };

  const jsonRes = await fetch(`${FN_BASE}/${token}?format=json`);
  out.httpJson = jsonRes.status;
  try {
    out.state = await jsonRes.json();
  } catch {
    out.state = { parseError: await jsonRes.text() };
  }

  const hop = await fetch(out.url, { redirect: 'manual' });
  out.hopStatus = hop.status;
  out.location = hop.headers.get('location');
  out.cacheControl = hop.headers.get('cache-control');

  if (out.location) {
    try {
      // HEAD the real target: this is what proves the redirect lands on a PDF
      // and not on an expired-link error page.
      const head = await fetch(out.location, { method: 'HEAD' });
      out.targetStatus = head.status;
      out.targetType = head.headers.get('content-type');
      out.targetBytes = head.headers.get('content-length');
      if (!head.ok || !/pdf/i.test(out.targetType || '')) {
        // Some CDNs refuse HEAD; fall back to a ranged GET.
        const ranged = await fetch(out.location, {
          headers: { Range: 'bytes=0-1023' },
        });
        out.targetStatus = ranged.status;
        out.targetType = ranged.headers.get('content-type');
        const buf = new Uint8Array(await ranged.arrayBuffer());
        out.magic = new TextDecoder().decode(buf.slice(0, 5));
        out.targetBytes = out.targetBytes || String(buf.length) + '+';
      }
    } catch (e) {
      out.targetError = e.message;
    }
  }
  return out;
}

function printResolution(r) {
  const st = r.state?.state ?? '?';
  const badge = st === 'permanent'
    ? c.green('PERMANENT')
    : st === 'temp'
    ? c.yellow('TEMP')
    : st === 'generating'
    ? c.cyan('GENERATING')
    : c.red(st.toUpperCase());

  console.log(`\n${c.bold(r.token)}  ${badge}`);
  console.log(`  link      ${r.url}`);
  console.log(`  detail    ${r.state?.detail ?? '-'}`);
  console.log(`  hop       ${r.hopStatus}  ${c.dim(r.cacheControl ?? '')}`);
  if (r.location) {
    const kind = isEphemeral(r.location) ? c.yellow('pdf.co') : c.green('storage');
    console.log(`  ->        ${kind} ${r.location.slice(0, 110)}`);
    const okTarget = r.targetStatus === 200 || r.targetStatus === 206;
    console.log(
      `  target    ${okTarget ? c.green(r.targetStatus) : c.red(r.targetStatus)}` +
        `  ${r.targetType ?? '?'}  ${r.targetBytes ?? '?'} bytes` +
        (r.magic ? `  magic=${JSON.stringify(r.magic)}` : ''),
    );
    if (r.targetError) console.log(`  ${c.red('target error: ' + r.targetError)}`);
  }
}

// ---------------------------------------------------------------- commands

async function cmdAudit() {
  console.log(c.bold('\n=== What is actually in the database ===\n'));

  const { count: reportCount } = await db
    .from('reports')
    .select('id', { count: 'exact', head: true });
  console.log(`reports rows                        ${reportCount ?? '?'}`);

  const { count: withPdf } = await db
    .from('reports')
    .select('id', { count: 'exact', head: true })
    .not('pdf_url', 'is', null);
  console.log(`  with pdf_url                      ${withPdf ?? '?'}`);

  const { count: ephemeral } = await db
    .from('reports')
    .select('id', { count: 'exact', head: true })
    .or('pdf_url.ilike.%pdf.co%,pdf_url.ilike.%pdf-temp-files%');
  const bad = ephemeral ?? 0;
  console.log(
    `  ${bad > 0 ? c.red('pdf_url is a PDF.co temp URL') : 'pdf_url is a PDF.co temp URL'}` +
      `      ${bad > 0 ? c.red(String(bad)) : '0'}` +
      (bad > 0 ? c.dim('   <- already-dead links, repairable once tokens exist') : ''),
  );

  const { count: withPrint } = await db
    .from('reports')
    .select('id', { count: 'exact', head: true })
    .not('print_pdf_url', 'is', null);
  console.log(`  with print_pdf_url                ${withPrint ?? '?'}`);

  const { count: withCompact } = await db
    .from('reports')
    .select('id', { count: 'exact', head: true })
    .not('compact_ecopy_url', 'is', null);
  console.log(`  with compact_ecopy_url            ${withCompact ?? '?'}`);

  const { count: linkCount, error: linkErr } = await db
    .from('report_links')
    .select('token', { count: 'exact', head: true });
  console.log(
    `report_links rows                   ${
      linkErr ? c.red('table missing - run the migration') : linkCount
    }`,
  );

  const { data: labs } = await db
    .from('labs')
    .select('id, name, report_link_enabled')
    .order('name');
  if (labs) {
    console.log(`\nlabs (${labs.length}) and enrolment flag:`);
    for (const l of labs) {
      console.log(
        `  ${l.report_link_enabled ? c.green('ON ') : c.dim('off')}  ${l.name}  ${c.dim(l.id)}`,
      );
    }
  }

  if (bad > 0) {
    const { data: rows } = await db
      .from('reports')
      .select('order_id, pdf_url, generated_date')
      .or('pdf_url.ilike.%pdf.co%,pdf_url.ilike.%pdf-temp-files%')
      .limit(10);
    console.log(c.red('\nsample dead links:'));
    for (const r of rows ?? []) {
      console.log(`  ${r.order_id}  ${c.dim(r.generated_date ?? '')}`);
    }
  }
}

async function cmdPick(n = 10) {
  const { data, error } = await db
    .from('reports')
    .select('order_id, pdf_url, print_pdf_url, generated_date, status, report_status')
    .not('pdf_url', 'is', null)
    .order('generated_date', { ascending: false })
    .limit(Number(n) * 3);
  if (error) die(error.message);

  const good = (data ?? []).filter((r) => !isEphemeral(r.pdf_url)).slice(0, Number(n));
  console.log(c.bold(`\n${good.length} candidate completed orders:\n`));
  for (const r of good) {
    console.log(
      `  ${r.order_id}  ${c.dim((r.generated_date ?? '').slice(0, 19))}  ` +
        `${r.report_status ?? r.status ?? '-'}${r.print_pdf_url ? '  +print' : ''}`,
    );
  }
  console.log(
    c.dim(`\nSeed them all with:  npm run test:report-link -- seed --auto ${good.length}`),
  );
  return good.map((r) => r.order_id);
}

async function cmdSeed(args) {
  let orderIds = args.filter((a) => !a.startsWith('--'));
  if (args.includes('--auto')) {
    const n = orderIds[0] ?? 10;
    orderIds = await cmdPick(n);
  }
  if (!orderIds.length) die('Give order ids, or use: seed --auto 10');

  console.log(c.bold('\nSeeding tokens:\n'));
  for (const orderId of orderIds) {
    const { data, error } = await db.rpc('ensure_report_link', {
      p_order_id: orderId,
      p_variant: 'final',
    });
    if (error) {
      console.log(`  ${c.red('FAIL')} ${orderId}  ${error.message}`);
      continue;
    }
    console.log(`  ${c.green('ok')}  ${orderId}\n      ${tokenUrl(data)}`);
  }
}

async function cmdList() {
  const { data, error } = await db
    .from('report_links')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) die(error.message);
  if (!data?.length) return console.log('No report_links rows yet.');

  console.log(c.bold(`\n${data.length} seeded links:\n`));
  for (const l of data) {
    const target = l.permanent_url
      ? c.green('permanent')
      : l.temp_url
      ? c.yellow('temp')
      : c.dim('none');
    console.log(
      `  ${l.token}  ${l.status.padEnd(9)} ${target}  ` +
        `opens=${l.access_count}  ${c.dim(l.order_id)}`,
    );
  }
}

async function cmdCheck(tokens) {
  if (!tokens.length) die('Give at least one token.');
  let pass = 0, fail = 0;
  for (const t of tokens) {
    const r = await resolveToken(t);
    printResolution(r);
    const ok = r.hopStatus === 302 &&
      (r.targetStatus === 200 || r.targetStatus === 206);
    ok ? pass++ : fail++;
  }
  console.log(
    `\n${c.bold('Result:')} ${c.green(pass + ' serving')} / ` +
      `${fail ? c.red(fail + ' not serving') : '0 not serving'}`,
  );
  if (fail) process.exitCode = 1;
}

async function cmdCheckAll() {
  const { data } = await db
    .from('report_links')
    .select('token')
    .order('created_at', { ascending: false })
    .limit(50);
  await cmdCheck((data ?? []).map((r) => r.token));
}

async function cmdSimulateTemp(token, url) {
  if (!token || !url) die('Usage: simulate-temp <token> <pdfco-temp-url>');
  const { error } = await db
    .from('report_links')
    .update({
      permanent_url: null,
      temp_url: url,
      temp_expires_at: new Date(Date.now() + 55 * 60_000).toISOString(),
      status: 'temp',
    })
    .eq('token', token);
  if (error) die(error.message);
  console.log(c.yellow('\nInstalled temp URL, permanent cleared. Resolving...'));
  await cmdCheck([token]);
}

async function cmdExpireTemp(token) {
  if (!token) die('Usage: expire-temp <token>');
  const { error } = await db
    .from('report_links')
    .update({ temp_expires_at: new Date(Date.now() - 60_000).toISOString() })
    .eq('token', token);
  if (error) die(error.message);
  console.log(
    c.yellow('\nBackdated temp_expires_at. Resolver must now refuse the temp URL...'),
  );
  const r = await resolveToken(token);
  printResolution(r);
}

async function cmdPromote(token, url) {
  if (!token) die('Usage: promote <token> [permanent-url]');
  let permanent = url;
  if (!permanent) {
    const { data: link } = await db
      .from('report_links')
      .select('order_id')
      .eq('token', token)
      .maybeSingle();
    if (!link) die('Unknown token.');
    const { data: rep } = await db
      .from('reports')
      .select('pdf_url')
      .eq('order_id', link.order_id)
      .maybeSingle();
    if (!rep?.pdf_url || isEphemeral(rep.pdf_url)) {
      die('No storage-backed reports.pdf_url for this order - pass a URL explicitly.');
    }
    permanent = rep.pdf_url;
  }
  const { error } = await db
    .from('report_links')
    .update({ permanent_url: permanent, status: 'permanent' })
    .eq('token', token);
  if (error) die(error.message);
  console.log(
    c.green('\nPromoted to permanent. The SAME token must now serve storage...'),
  );
  await cmdCheck([token]);
}

/** Everything known about one order's link -- the post-generation check. */
async function cmdByOrder(orderId) {
  if (!orderId) die('Usage: by-order <orderId>');

  const { data: links } = await db
    .from('report_links')
    .select('*')
    .eq('order_id', orderId);
  const { data: rep } = await db
    .from('reports')
    .select('pdf_url, print_pdf_url, compact_ecopy_url, pdf_generated_at, status, report_status')
    .eq('order_id', orderId)
    .maybeSingle();
  const { data: job } = await db
    .from('pdf_generation_queue')
    .select('status, progress_stage, progress_percent, started_at, completed_at')
    .eq('order_id', orderId)
    .maybeSingle();

  console.log(c.bold(`\nOrder ${orderId}\n`));
  console.log('  queue     ', job ? `${job.status} ${c.dim(job.progress_stage ?? '')}` : c.dim('no job'));
  console.log('  reports   ', rep
    ? `${rep.report_status ?? rep.status ?? '-'}  ${
        isEphemeral(rep.pdf_url) ? c.red('pdf_url is EPHEMERAL') : c.green('pdf_url is storage')
      }`
    : c.dim('no reports row'));
  if (rep?.pdf_url) console.log('            ', c.dim(rep.pdf_url.slice(0, 100)));

  if (!links?.length) {
    console.log(c.yellow('\n  No report_links row -- lab is probably not enrolled.'));
    return;
  }
  for (const l of links) {
    console.log(
      `\n  variant=${l.variant} status=${l.status} opens=${l.access_count}` +
      `${l.first_shared_at ? ' shared' : ''}`,
    );
    console.log('    permanent ', l.permanent_url ? c.green(l.permanent_url.slice(0, 95)) : c.dim('null'));
    console.log('    temp      ', l.temp_url ? c.yellow(l.temp_url.slice(0, 95)) : c.dim('null'));
    if (l.temp_expires_at) {
      const mins = Math.round((new Date(l.temp_expires_at).getTime() - Date.now()) / 60000);
      console.log('    temp exp  ', `${l.temp_expires_at} (${mins}m)`);
    }
    const r = await resolveToken(l.token);
    printResolution(r);
  }
}

/** Flips the per-lab enrolment gate. This is a production behaviour change. */
async function cmdEnableLab(labId, onOff = 'on') {
  if (!labId) die('Usage: enable-lab <labId> [on|off]');
  const enabled = onOff !== 'off';
  const { data, error } = await db
    .from('labs')
    .update({ report_link_enabled: enabled })
    .eq('id', labId)
    .select('id, name, report_link_enabled');
  if (error) die(error.message);
  if (!data?.length) die('No lab matched that id.');
  console.log(
    `${data[0].name}: report_link_enabled = ` +
      (data[0].report_link_enabled ? c.green('true') : c.dim('false')),
  );
}

async function cmdReset(token) {
  if (!token) die('Usage: reset <token>');
  const { error } = await db
    .from('report_links')
    .update({
      permanent_url: null,
      temp_url: null,
      temp_expires_at: null,
      status: 'pending',
    })
    .eq('token', token);
  if (error) die(error.message);
  console.log('Reset to pending.');
}

// ---------------------------------------------------------------- dispatch

const [cmd, ...rest] = process.argv.slice(2);

switch (cmd) {
  case 'audit':         await cmdAudit(); break;
  case 'pick':          await cmdPick(rest[0] ?? 10); break;
  case 'seed':          await cmdSeed(rest); break;
  case 'list':          await cmdList(); break;
  case 'check':         await cmdCheck(rest); break;
  case 'by-order':      await cmdByOrder(rest[0]); break;
  case 'enable-lab':    await cmdEnableLab(rest[0], rest[1]); break;
  case 'check-all':     await cmdCheckAll(); break;
  case 'simulate-temp': await cmdSimulateTemp(rest[0], rest[1]); break;
  case 'expire-temp':   await cmdExpireTemp(rest[0]); break;
  case 'promote':       await cmdPromote(rest[0], rest[1]); break;
  case 'reset':         await cmdReset(rest[0]); break;
  default:
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8')
      .split('*/')[0].replace(/^\/\*\*?/, '').replace(/^ \* ?/gm, ''));
}
