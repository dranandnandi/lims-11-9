# Stable PDF links — porting playbook

How to give any pdf.co HTML→PDF pipeline a permanent, shareable URL that works
*before* the PDF finishes uploading. Written from the LIMS implementation
(2026-08-19) so it can be repeated in another app.

## The problem this solves

A typical pdf.co flow is: render HTML → get a temp URL → download it → upload to
storage → hand out the storage URL. That has three defects:

1. **Nothing is shareable until the whole chain finishes.** Measured in LIMS:
   the PDF existed at pdf.co after **2.2s**, but the caller waited **11.5s** —
   the extra 9.3s was a settle delay, a failed first download (pdf.co 404s if you
   fetch too early), backoff, re-download, upload, and DB writes.
2. **Storage URLs embed a timestamp** (`<id>_1787073939732.pdf`), so every
   regeneration mints a new URL and orphans whatever was already sent.
3. **Failed uploads poison the DB.** If the download retries all fail and the
   code falls back to "just use the pdf.co URL", that temp URL gets stored and
   sent. pdf.co signs its S3 links for exactly **3600s**, so those become dead
   links within the hour, permanently. LIMS had **27** such rows.

The fix: mint an unguessable token *before* generation, and resolve it at open
time to whatever copy is live right now.

## 1. Schema

```sql
CREATE TABLE public.report_links (
  token           text PRIMARY KEY,
  order_id        uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  lab_id          uuid NOT NULL,
  variant         text NOT NULL DEFAULT 'final',   -- 'final' | 'print' | ...
  permanent_url   text,          -- storage URL; NEVER a pdf.co URL
  temp_url        text,          -- pdf.co URL, published early
  temp_expires_at timestamptz,
  status          text NOT NULL DEFAULT 'pending', -- pending|temp|permanent|failed
  first_shared_at timestamptz,
  last_accessed_at timestamptz,
  access_count    integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_report_links_order_variant ON report_links (order_id, variant);
```

Plus a race-safe minting function — concurrent callers must converge on one
token per (record, variant):

```sql
CREATE FUNCTION public.ensure_report_link(p_order_id uuid, p_variant text DEFAULT 'final')
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_token text; v_lab_id uuid;
BEGIN
  SELECT token INTO v_token FROM report_links
   WHERE order_id = p_order_id AND variant = p_variant;
  IF v_token IS NOT NULL THEN RETURN v_token; END IF;

  SELECT lab_id INTO v_lab_id FROM orders WHERE id = p_order_id;
  IF v_lab_id IS NULL THEN RAISE EXCEPTION 'order % not found', p_order_id; END IF;

  INSERT INTO report_links (token, order_id, lab_id, variant)
  VALUES (replace(gen_random_uuid()::text, '-', ''), p_order_id, v_lab_id, p_variant)
  ON CONFLICT (order_id, variant) DO NOTHING
  RETURNING token INTO v_token;

  IF v_token IS NULL THEN   -- lost the race; read the winner
    SELECT token INTO v_token FROM report_links
     WHERE order_id = p_order_id AND variant = p_variant;
  END IF;
  RETURN v_token;
END $$;
```

Enable RLS scoped to the tenant. The resolver reads with the **service role**,
because the whole point is that an anonymous bearer of the token can resolve it.

Add a per-tenant gate (`labs.report_link_enabled`) so rollout is incremental.
Default it `false`, flip to `true` once proven.

## 2. The resolver edge function

One function, `verify_jwt = false`. Route `GET /report-link/<token>.pdf`.
Keep the `.pdf` suffix — WhatsApp/Gmail/iOS sniff extensions before Content-Type.

Resolution order:

1. `permanent_url` set (and not ephemeral) → **302**
2. else derive from the reports table (`pdf_url`); if it's a real storage URL,
   backfill `permanent_url` and **302**
3. else an unexpired `temp_url` → **302**
4. else a job still running → **202** + self-refreshing "preparing" page
5. else → re-enqueue generation (behind a flag) or an honest error page

```ts
const isEphemeral = (u) => !!u && /pdf\.co|pdf-temp-files|pdfco/i.test(u);
```

Return `302`, never proxy — proxying burns egress on every open and pdf.co
streams fine directly. Send `Cache-Control: no-store`: the target changes
underneath the token.

Do **not** count `HEAD` as an open. Link previewers hit every URL before a human
does; counting them corrupts your access stats.

## 3. Three hooks in the generator

Everything is best-effort — wrap each in try/catch and never let it affect PDF
output.

**(a) Before rendering** — reserve the token:

```ts
const token = await ensureReportLinkToken(supabase, orderId, 'final');
```

**(b) The instant pdf.co returns** — publish the temp URL. This is where the
9-second saving comes from:

```ts
await supabase.from('report_links')
  .update({ temp_url: pdfCoUrl,
            temp_expires_at: new Date(Date.now() + 55*60_000).toISOString(),
            status: 'temp' })
  .eq('order_id', orderId).eq('variant', 'final')
  .is('permanent_url', null);      // never clobber a real URL
```

55 minutes, not 60 — stay inside pdf.co's 3600s signature.

**(c) After upload** — stamp the permanent URL, and **refuse ephemeral input**:

```ts
if (/pdf\.co|pdf-temp-files/i.test(url)) return;  // the whole point
```

If the upload failed and the code fell back to the pdf.co URL, this guard leaves
the token on `temp`, so the resolver can still regenerate later instead of
freezing a link that dies in an hour.

If the pipeline produces several PDFs (eCopy + print), give each its own
variant/token — you get both temp URLs at the same moment.

## 4. Public URL shape

Emit `<prefix>/<token>.pdf` where prefix is configurable on **both** sides
(edge secret + frontend env), and keep them identical so a link built in the UI
matches one sent over WhatsApp.

Short branded path via a redirect rule, which **must** precede the SPA catch-all:

```toml
[[redirects]]
  from = "/r/*"
  to = "https://<functions-host>/functions/v1/report-link/:splat"
  status = 302
  force = true
```

Use `302`, not a `200` proxy — the resolver's own response is a redirect, and
proxying a redirect is ill-defined.

## 5. Frontend (optional but where the UX win lands)

- Reserve the token *before* invoking generation; it's valid immediately.
- Stop awaiting the generate call. Release the UI when the link becomes
  **viewable** (`status = temp`), not when the token merely exists — at t=0 it
  only serves the "preparing" page, so a View button would open a spinner.
- Keep auto-print on the **real** storage URL; a print bridge cannot consume the
  resolver's HTML wait page.
- Let generation failures still surface even though nothing awaits them.
- Gate action buttons on link readiness, not on job status. In LIMS the queue
  sits in `processing` for the whole upload tail, which kept Download/Print
  disabled long after the PDF was usable.

## Gotchas that cost real time

- **A scheme-less base URL silently breaks everything.** `app.example.in/r` is a
  *relative* URL — the browser resolves it against the app origin and the SPA
  catch-all serves `index.html`. The link opens your app, with no error anywhere.
  Normalise it: prepend `https://` when the value has no scheme.
- **Masked env vars.** Netlify shows secret values as `****`; editing and saving
  stores the mask *as the value*. The deployed bundle then contains
  `"****************in/r"`. Delete and re-create the variable rather than editing,
  and don't mark a public URL prefix as secret.
- **A URL from the reports table carries no expiry**, so an ephemeral one there
  looks live forever. Age it from the row's generated-at timestamp, otherwise you
  redirect to a dead S3 link that answers `403` with an XML body — worse than an
  honest error page.
- **Cached / early-return paths bypass the hooks.** Any "already generated,
  returning existing URL" branch returns before token creation, so those records
  never get a token. Decide deliberately whether to mint there too.
- **Don't put the token in a WhatsApp attachment URL.** Providers fetch it
  server-side, once, and may not follow a 302. Text link = token, attachment =
  direct storage URL.
- **Deferred sends freeze the attachment URL.** If a notification is queued with
  a URL captured at generation time and sent hours later, an ephemeral URL will
  be dead by then. Re-resolve at send time.
- **Never point a token at another record's file** while testing. Reset it.

## Verifying

Resolve the token without following, then check the target separately:

```bash
curl -s -o /dev/null -w "%{http_code} -> %{redirect_url}\n" "<link>"
curl -sL -o /tmp/r.pdf -w "%{http_code} %{content_type} %{size_download}\n" "<link>"
head -c 5 /tmp/r.pdf     # must be %PDF-
```

A 200 with `text/html` means the SPA swallowed it. A 403 with `<?xml` means you
redirected to an expired pdf.co URL.
