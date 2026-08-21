/**
 * Stable, shareable report links.
 *
 * A report's storage URL embeds a generation timestamp
 * (`<orderId>_1787073939732.pdf`), so every regeneration mints a new URL and
 * orphans the previous one -- anything already sent to a patient then points at
 * a stale file. These helpers return a token URL instead, which resolves to
 * whichever copy is live right now and never changes for the life of the report.
 *
 * The token exists before the PDF does, which is the point: a link can be shown
 * or sent immediately, without waiting for generate-pdf-letterhead to finish its
 * render -> download -> upload chain.
 *
 * Kept deliberately separate from the PDF preview path. Preview and auto-print
 * need the real file and must keep awaiting the edge function's pdfUrl; only
 * sharing benefits from resolving early.
 */

import { supabase } from './supabase';

export type ReportLinkVariant = 'final' | 'print' | 'compact';

/**
 * Public prefix for a token URL, used as `<prefix>/<token>.pdf`. Must match
 * REPORT_LINK_PUBLIC_BASE in generate-pdf-letterhead, so a link built here is
 * byte-identical to one the edge function puts in a WhatsApp message.
 *
 * The fallback is the resolver's own origin, NOT `window.location.origin + /r`.
 * The short path only works once the /r/* rule in netlify.toml has shipped;
 * before that the SPA catch-all swallows it and serves index.html, so the link
 * silently opens the app instead of the report. Defaulting to the function URL
 * is uglier but always correct -- set VITE_REPORT_LINK_PUBLIC_BASE to the short
 * form deliberately, once the redirect is actually live.
 */
const RAW_PUBLIC_BASE = (
  import.meta.env.VITE_REPORT_LINK_PUBLIC_BASE ||
  `${(import.meta.env.VITE_SUPABASE_URL || '').replace(/\/+$/, '')}/functions/v1/report-link`
).replace(/\/+$/, '');

/**
 * A base configured without a scheme ("app.limsapp.in/r") is treated by the
 * browser as a RELATIVE path, so window.open resolves it against the app origin
 * and the SPA catch-all serves index.html -- the link silently opens the app
 * instead of the report, with no error anywhere. Normalise it instead.
 */
const PUBLIC_BASE = /^https?:\/\//i.test(RAW_PUBLIC_BASE) || RAW_PUBLIC_BASE.startsWith('/')
  ? RAW_PUBLIC_BASE
  : `https://${RAW_PUBLIC_BASE}`;

if (RAW_PUBLIC_BASE && PUBLIC_BASE !== RAW_PUBLIC_BASE) {
  console.warn(
    `[reportLink] VITE_REPORT_LINK_PUBLIC_BASE is missing a scheme; assuming https:// (${PUBLIC_BASE}).`
  );
}

export function buildReportLinkUrl(token: string): string {
  return `${PUBLIC_BASE}/${token}.pdf`;
}

/**
 * Returns the stable link for an order, creating the token if it does not exist.
 *
 * Safe to call before generation starts. Returns null rather than throwing: a
 * missing link must degrade to "use the direct URL", never break the caller.
 */
export async function getShareableReportLink(
  orderId: string,
  variant: ReportLinkVariant = 'final'
): Promise<string | null> {
  if (!orderId) return null;

  try {
    // Read first -- RLS-scoped, and avoids an RPC round trip on the common path.
    const { data: existing } = await supabase
      .from('report_links')
      .select('token')
      .eq('order_id', orderId)
      .eq('variant', variant)
      .maybeSingle();

    if (existing?.token) return buildReportLinkUrl(existing.token);

    // ensure_report_link is SECURITY DEFINER and verifies the caller belongs to
    // the order's lab, so this cannot mint a token for another lab's report.
    const { data: token, error } = await supabase.rpc('ensure_report_link', {
      p_order_id: orderId,
      p_variant: variant,
    });

    if (error) {
      console.warn('[reportLink] ensure_report_link failed:', error.message);
      return null;
    }
    return token ? buildReportLinkUrl(token) : null;
  } catch (err) {
    console.warn('[reportLink] lookup threw:', err);
    return null;
  }
}

/** Current resolution state, for showing "still preparing" in the UI. */
export async function getReportLinkState(
  orderId: string,
  variant: ReportLinkVariant = 'final'
): Promise<'pending' | 'temp' | 'permanent' | 'failed' | null> {
  try {
    const { data } = await supabase
      .from('report_links')
      .select('status')
      .eq('order_id', orderId)
      .eq('variant', variant)
      .maybeSingle();
    return (data?.status as any) ?? null;
  } catch {
    return null;
  }
}
