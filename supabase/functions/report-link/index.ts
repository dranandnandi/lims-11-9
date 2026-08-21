// Purpose: Public, token-bearer endpoint behind a report's permanent link.
//          The token IS the credential -- nothing here needs a session, and the
//          bearer already knows everything this returns.
//
// Why it exists: generate-pdf-letterhead can only publish a URL after PDF.co
// renders AND the file is downloaded AND uploaded to the reports bucket. That
// tail is up to ~65s of retries. This endpoint lets a link be handed out before
// any of it finishes: it resolves to whatever is live right now (PDF.co temp
// file early, permanent storage later) without the shared URL ever changing.
//
// Route:  GET|HEAD /report-link/<token>.pdf         -> 302 to the live PDF
//         GET      /report-link?token=...           -> same
//         GET      /report-link/<token>?format=json -> resolution state, for polling
// Auth:   verify_jwt = false

import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
};

// Never let a browser or WhatsApp cache the hop itself -- the target changes
// underneath the token as generation progresses.
const NO_STORE = {
  "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
  "Pragma": "no-cache",
};

// Phase 0 keeps this off: a stray token open must not enqueue PDF work while we
// are still validating the resolver against historical orders.
const ALLOW_REGENERATE =
  (Deno.env.get("REPORT_LINK_ALLOW_REGENERATE") ?? "false").toLowerCase() ===
    "true";

function serviceClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );
}

/**
 * A URL that lives on PDF.co (or the S3 bucket it hands back) is temporary and
 * dies within the hour. uploadPdfToStorage's final fallback writes exactly such
 * a URL into reports.pdf_url, so we must never mistake one for permanent.
 */
function isEphemeralUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  return /pdf\.co|pdf-temp-files|pdfco/i.test(url);
}

/** Which reports column backs each variant. Mirrors generate-pdf-letterhead. */
const VARIANT_COLUMN: Record<string, string> = {
  final: "pdf_url",
  print: "print_pdf_url",
  compact: "compact_ecopy_url",
};

/** When that column was written -- used to age out ephemeral URLs found there. */
const VARIANT_STAMP_COLUMN: Record<string, string> = {
  final: "pdf_generated_at",
  print: "print_pdf_generated_at",
  compact: "compact_ecopy_generated_at",
};

// PDF.co signs its S3 links for 3600s. Stay inside that so we never hand a
// patient a URL that answers with a 403 XML error page.
const EPHEMERAL_LIFETIME_MS = 55 * 60 * 1000;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      ...corsHeaders,
      ...NO_STORE,
      "Content-Type": "application/json",
    },
  });
}

function redirect(url: string) {
  return new Response(null, {
    status: 302,
    headers: { ...corsHeaders, ...NO_STORE, Location: url },
  });
}

const PAGE_CSS = [
  "body{margin:0;min-height:100vh;display:flex;align-items:center;",
  "justify-content:center;font-family:system-ui,-apple-system,sans-serif;",
  "background:#f6f8fb;color:#1f2937}",
  ".card{text-align:center;padding:2rem;max-width:22rem}",
  ".spin{width:2.5rem;height:2.5rem;margin:0 auto 1.25rem;",
  "border:3px solid #dbeafe;border-top-color:#2563eb;border-radius:50%;",
  "animation:s .9s linear infinite}",
  "@keyframes s{to{transform:rotate(360deg)}}",
  "h1{font-size:1.05rem;font-weight:600;margin:0 0 .4rem}",
  "p{font-size:.85rem;color:#6b7280;margin:0;line-height:1.5}",
].join("");

function shell(title: string, bodyHtml: string, extraHead = "") {
  return [
    "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">",
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">",
    extraHead,
    "<title>", title, "</title><style>", PAGE_CSS, "</style></head>",
    "<body><div class=\"card\">", bodyHtml, "</div></body></html>",
  ].join("");
}

/** Shown while the PDF genuinely is not ready yet. Refreshes itself. */
function waitingPage(message: string, retryAfter = 3) {
  const html = shell(
    "Preparing your report",
    [
      "<div class=\"spin\"></div>",
      "<h1>Preparing your report</h1><p>", message, "</p>",
    ].join(""),
    "<meta http-equiv=\"refresh\" content=\"" + retryAfter + "\">",
  );
  return new Response(html, {
    status: 202,
    headers: {
      ...corsHeaders,
      ...NO_STORE,
      "Content-Type": "text/html; charset=utf-8",
      "Retry-After": String(retryAfter),
    },
  });
}

function errorPage(title: string, message: string, status: number) {
  const html = shell(
    title,
    "<h1>" + title + "</h1><p>" + message + "</p>",
  );
  return new Response(html, {
    status,
    headers: {
      ...corsHeaders,
      ...NO_STORE,
      "Content-Type": "text/html; charset=utf-8",
    },
  });
}

/** Pull the token out of either /report-link/<token>.pdf or ?token=<token>. */
function extractToken(url: URL): string | null {
  const q = url.searchParams.get("token");
  if (q) return q.trim();

  const parts = url.pathname.split("/").filter(Boolean);
  const idx = parts.lastIndexOf("report-link");
  const raw = idx >= 0 && parts.length > idx + 1
    ? parts[idx + 1]
    : parts[parts.length - 1];
  if (!raw || raw === "report-link") return null;
  return raw.replace(/\.pdf$/i, "").trim();
}

type Resolution = {
  state: "permanent" | "temp" | "generating" | "failed" | "not_found";
  url: string | null;
  detail: string;
};

async function resolve(
  supabase: ReturnType<typeof serviceClient>,
  token: string,
): Promise<{ resolution: Resolution; link: Record<string, any> | null }> {
  const { data: link } = await supabase
    .from("report_links")
    .select("*")
    .eq("token", token)
    .maybeSingle();

  if (!link) {
    return {
      link: null,
      resolution: { state: "not_found", url: null, detail: "Unknown token" },
    };
  }

  // 1. Already permanent. Nothing else can beat this.
  if (link.permanent_url && !isEphemeralUrl(link.permanent_url)) {
    return {
      link,
      resolution: {
        state: "permanent",
        url: link.permanent_url,
        detail: "Storage URL",
      },
    };
  }

  // 2. Derive from the reports row. This is what makes the endpoint work on
  //    historical orders with zero changes to generate-pdf-letterhead: any
  //    already-completed report resolves straight out of the existing column.
  const variant = String(link.variant ?? "final");
  const column = VARIANT_COLUMN[variant] ?? "pdf_url";
  const stampColumn = VARIANT_STAMP_COLUMN[variant] ?? "pdf_generated_at";
  const { data: report } = await supabase
    .from("reports")
    .select(column + ", " + stampColumn + ", generated_date, status, report_status")
    .eq("order_id", link.order_id)
    .maybeSingle();

  const reportUrl: string | null = report
    ? ((report as Record<string, any>)[column] ?? null)
    : null;
  const reportStamp: string | null = report
    ? ((report as Record<string, any>)[stampColumn] ??
      (report as Record<string, any>).generated_date ?? null)
    : null;

  if (reportUrl && !isEphemeralUrl(reportUrl)) {
    // Backfill so the next open is a single table read.
    await supabase
      .from("report_links")
      .update({ permanent_url: reportUrl, status: "permanent" })
      .eq("token", token);
    return {
      link,
      resolution: {
        state: "permanent",
        url: reportUrl,
        detail: "Backfilled from reports." + column,
      },
    };
  }

  // 3. A live PDF.co temp file -- either published early by the generator, or
  //    left in reports.pdf_url by uploadPdfToStorage's final fallback.
  const tempCandidates: Array<
    { url: string; expires: string | null; from: string }
  > = [];
  if (link.temp_url) {
    tempCandidates.push({
      url: link.temp_url,
      expires: link.temp_expires_at ?? null,
      from: "report_links.temp_url",
    });
  }
  if (reportUrl && isEphemeralUrl(reportUrl)) {
    // uploadPdfToStorage's final fallback wrote a PDF.co URL here and recorded
    // no expiry of its own. Age it from when the column was stamped -- without
    // this we would redirect to a long-dead S3 link that answers 403 with an
    // XML error body, which is worse than an honest "not available" page.
    tempCandidates.push({
      url: reportUrl,
      expires: reportStamp
        ? new Date(new Date(reportStamp).getTime() + EPHEMERAL_LIFETIME_MS)
          .toISOString()
        : new Date(0).toISOString(),
      from: "reports." + column,
    });
  }

  for (const candidate of tempCandidates) {
    const expired = candidate.expires
      ? new Date(candidate.expires).getTime() < Date.now()
      : false;
    if (!expired) {
      return {
        link,
        resolution: {
          state: "temp",
          url: candidate.url,
          detail: "Temporary URL from " + candidate.from,
        },
      };
    }
  }

  // 4. Still being generated?
  const { data: job } = await supabase
    .from("pdf_generation_queue")
    .select("status, progress_stage, progress_percent")
    .eq("order_id", link.order_id)
    .maybeSingle();

  if (job && ["pending", "processing", "queued"].includes(String(job.status))) {
    return {
      link,
      resolution: {
        state: "generating",
        url: null,
        detail: String(job.progress_stage ?? "Queued"),
      },
    };
  }

  // 5. Nothing live. Either it never generated, or the temp URL aged out before
  //    the upload succeeded -- the exact case that used to leave a dead link.
  if (ALLOW_REGENERATE) {
    await supabase
      .from("pdf_generation_queue")
      .upsert(
        {
          order_id: link.order_id,
          lab_id: link.lab_id,
          status: "pending",
          priority: 1,
        },
        { onConflict: "order_id" },
      );
    return {
      link,
      resolution: {
        state: "generating",
        url: null,
        detail: "Re-queued for generation",
      },
    };
  }

  return {
    link,
    resolution: {
      state: "failed",
      url: null,
      detail: job
        ? "Generation job status: " + job.status
        : "No PDF available for this order yet",
    },
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    return json({ error: "Method not allowed" }, 405);
  }

  try {
    const url = new URL(req.url);
    const token = extractToken(url);
    const wantsJson = url.searchParams.get("format") === "json";

    if (!token) {
      return wantsJson
        ? json({ error: "Missing token" }, 400)
        : errorPage("Invalid link", "This report link is malformed.", 400);
    }

    const supabase = serviceClient();
    const { resolution, link } = await resolve(supabase, token);

    // Count real opens only. HEAD is almost always a link previewer
    // (WhatsApp/Gmail) fetching before a human ever taps.
    if (link && req.method === "GET" && !wantsJson) {
      supabase
        .from("report_links")
        .update({
          last_accessed_at: new Date().toISOString(),
          access_count: (Number(link.access_count) || 0) + 1,
        })
        .eq("token", token)
        .then(
          () => {},
          (e: unknown) => console.warn("access bump failed:", e),
        );
    }

    if (wantsJson) {
      return json({
        token,
        state: resolution.state,
        detail: resolution.detail,
        url: resolution.url,
        order_id: link?.order_id ?? null,
        variant: link?.variant ?? null,
        status: link?.status ?? null,
        access_count: link?.access_count ?? null,
      }, resolution.state === "not_found" ? 404 : 200);
    }

    switch (resolution.state) {
      case "permanent":
      case "temp":
        return redirect(resolution.url!);
      case "generating":
        return waitingPage(
          resolution.detail + ". This page refreshes on its own.",
        );
      case "not_found":
        return errorPage(
          "Link not found",
          "This report link is not recognised. Please ask the lab for a new one.",
          404,
        );
      default:
        return errorPage(
          "Report unavailable",
          "The report could not be prepared. Please contact the lab.",
          503,
        );
    }
  } catch (err) {
    console.error("report-link error:", err);
    return errorPage(
      "Something went wrong",
      "Please try again in a moment.",
      500,
    );
  }
});
