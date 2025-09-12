// supabase/functions/process-workflow-result/index.ts
// Full pipeline with task runner, Gemini 2.5 Flash

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_URL = (model: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(Deno.env.get("ALLGOOGLE_KEY") ?? "")}`;

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
  );

  try {
    const body = await req.json();
    const {
      workflowInstanceId,
      stepId = "final_results",
      results = {},
      userId,
      orderId,
      testGroupId,
      labId,
      testCode,
    } = body;

    // 1) Save raw to workflow_results (idempotent by instance+step)
    const qcSummary = buildQcSummary(results);
    const { data: wr, error: wrErr } = await supabase
      .from("workflow_results")
      .upsert(
        {
          workflow_instance_id: workflowInstanceId,
          step_id: stepId,
          order_id: orderId ?? null,
          patient_id: results.patient_id ?? null,
          lab_id: labId ?? null,
          test_group_id: testGroupId ?? null,
          test_name: results.test_name ?? body.testName ?? "Workflow Test",
          test_code: testCode ?? null,
          review_status: results.review_status ?? null,
          sample_id: results.sample_id ?? null,
          qc_summary: qcSummary || null,
          payload: body,
          status: "received",
          created_by: userId ?? null,
        },
        { onConflict: "workflow_instance_id,step_id" }
      )
      .select()
      .single();
    if (wrErr) throw wrErr;

    // 2) Load workflow config from test_workflow_map -> workflow_ai_configs
    const cfg = await loadWorkflowAIConfig(supabase, { labId, testGroupId, testCode });
    if (!cfg) return json({ error: "No active workflow config found" }, 400);

    // 3) Load tasks for this workflow version
    const tasks = await loadWorkflowTasks(supabase, cfg.workflow_version_id);

    // 4) Run tasks in order -> build normalized analytes
    let normalized: any = { meta: {}, analytes: {} };
    for (const t of tasks) {
      const t0 = performance.now();
      try {
        const inputs = await pickTaskInputs(supabase, wr.id, t.input_selector);
        const out = await runTaskWithGeminiOrTool(t, inputs, results);
        await logTaskRun(supabase, wr.id, t.id, "ok", { inputs, params: t.params }, out, Math.round(performance.now() - t0));
        normalized.analytes = { ...normalized.analytes, ...mapOutputs(out, t.output_map) };
      } catch (err) {
        await logTaskRun(supabase, wr.id, t.id, "error", {}, { error: String(err) }, Math.round(performance.now() - t0));
      }
    }

    // Merge simple raw fields using analyte_map
    normalized = mergeRawFields(normalized, results, cfg.analyte_map);
    if (qcSummary) normalized.meta.qc_summary = qcSummary;

    // 5) AI Parser (Gemini) — ensure strict normalized JSON shape
    const parserStart = performance.now();
    const parsed = await runGeminiParser(cfg, { raw: results, partial: normalized });
    await logAiRun(
      supabase,
      wr.id,
      "parser",
      GEMINI_MODEL,
      { raw: results, partial: normalized },
      parsed,
      true,
      Math.round(performance.now() - parserStart)
    );

    // 6) Deterministic rules validation
    const hardIssues = hardValidate(parsed, cfg);
    for (const is of hardIssues) await insertIssue(supabase, wr.id, is);

    // 7) AI Validator (Gemini) — double-check
    const validatorStart = performance.now();
    const audit = await runGeminiValidator(cfg, { raw: results, normalized: parsed, rules: pickRules(cfg) });
    await logAiRun(
      supabase,
      wr.id,
      "validator",
      GEMINI_MODEL,
      { raw: results, normalized: parsed, rules: pickRules(cfg) },
      audit,
      true,
      Math.round(performance.now() - validatorStart)
    );

    const aiIssues = Array.isArray(audit?.issues) ? audit.issues : [];
    for (const is of aiIssues) await insertIssue(supabase, wr.id, is);

    const blocking = [...hardIssues, ...aiIssues].some((x) => (x.severity || "error") === "error");
    if (blocking && (audit?.status === "fail")) {
      await supabase.from("workflow_results").update({ status: "error" }).eq("id", wr.id);
      return json({ status: "fail", workflow_result_id: wr.id, issues: hardIssues.concat(aiIssues) });
    }

    // 8) Commit to canonical results + result_values
    const resultRow = await upsertResults(supabase, {
      orderId: orderId ?? null,
      workflowInstanceId,
      userId: userId ?? null,
      results,
      testName: results.test_name ?? "Workflow Test",
      qcSummary,
    });
    await upsertResultValuesFromParsed(supabase, resultRow.id, orderId ?? null, parsed);

    // 9) Mark committed + optional progress update
    await supabase
      .from("workflow_results")
      .update({ status: "committed", committed_at: new Date().toISOString() })
      .eq("id", wr.id);

    await updateWorkflowProgress(supabase, workflowInstanceId, stepId);

    return json({
      status: blocking ? "warn" : "ok",
      workflow_result_id: wr.id,
      result_id: resultRow.id,
    });
  } catch (e) {
    console.error("process-workflow-result error:", e);
    return json({ error: String(e) }, 500);
  }
});

/* ------------------------------ helpers -------------------------------- */

function json(d: unknown, status = 200) {
  return new Response(JSON.stringify(d), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function buildQcSummary(results: Record<string, unknown>) {
  const parts: string[] = [];
  if (results?.cup_seal_intact != null) parts.push(`Cup seal: ${results.cup_seal_intact}`);
  if (results?.qc_strip_valid != null) parts.push(`Strip QC: ${results.qc_strip_valid}`);
  return parts.join(" | ");
}

/* --------- config + tasks --------- */

async function loadWorkflowAIConfig(
  supabase: any,
  args: { labId?: string | null; testGroupId?: string | null; testCode?: string | null }
) {
  // Prefer test_group mapping; fallback to test_code mapping
  let binding: any = null;

  if (args.labId && args.testGroupId) {
    const { data } = await supabase
      .from("test_workflow_map")
      .select("*")
      .eq("lab_id", args.labId)
      .eq("test_group_id", args.testGroupId)
      .eq("is_default", true)
      .order("priority", { ascending: false })
      .limit(1);
    binding = data?.[0] ?? null;
  }

  if (!binding && args.labId && args.testCode) {
    const { data } = await supabase
      .from("test_workflow_map")
      .select("*")
      .eq("lab_id", args.labId)
      .eq("test_code", args.testCode)
      .eq("is_default", true)
      .order("priority", { ascending: false })
      .limit(1);
    binding = data?.[0] ?? null;
  }

  if (!binding) return null;

  const { data: cfg } = await supabase
    .from("workflow_ai_configs")
    .select("*")
    .eq("workflow_version_id", binding.workflow_version_id)
    .limit(1)
    .maybeSingle();

  return cfg || null;
}

async function loadWorkflowTasks(supabase: any, workflowVersionId: string) {
  const { data } = await supabase
    .from("workflow_tasks")
    .select("*")
    .eq("workflow_version_id", workflowVersionId)
    .eq("enabled", true)
    .order("run_order", { ascending: true });
  return data ?? [];
}

async function pickTaskInputs(supabase: any, workflowResultId: string, selector: any) {
  if (selector?.attachment_tag) {
    const { data } = await supabase
      .from("attachments")
      .select("file_url,file_type,tag")
      .eq("related_table", "workflow_results")
      .eq("related_id", workflowResultId)
      .eq("tag", selector.attachment_tag);
    return { attachments: data ?? [] };
  }
  if (selector?.text_fields) return { text_fields: selector.text_fields };
  return {};
}

function mergeRawFields(n: any, raw: any, analyteMap: any) {
  const map = analyteMap || {};
  for (const [k, v] of Object.entries(raw || {})) {
    if (["string", "number", "boolean"].includes(typeof v)) {
      const canon = (map as any)[k] ?? k;
      if (!n.analytes[canon]) n.analytes[canon] = { value: String(v), unit: "" };
    }
  }
  return n;
}

function mapOutputs(out: any, outputMap: any) {
  const placed: any = {};
  const m = outputMap || {};
  for (const [k, obj] of Object.entries<any>(out?.analytes ?? {})) {
    const canon = m[k] ?? k;
    placed[canon] = obj;
  }
  return placed;
}

/* ------------- task runner (Gemini + optional microservices) ------------- */

async function runTaskWithGeminiOrTool(task: any, inputs: any, raw: any) {
  if (task.type === "vision_color") {
    const img = inputs.attachments?.[0]?.file_url;
    const mime = inputs.attachments?.[0]?.file_type ?? "image/jpeg";
    if (!img) throw new Error("No image for vision_color");

    const prompt =
      "Classify urine strip color into one of: Straw, Yellow, Amber, Dark Yellow. Respond JSON: {\"color\":\"<one>\"}";
    const res = await geminiJSON({ prompt, imageUrl: img, mimeType: mime });
    return { analytes: { color: { value: res.color ?? "", unit: "" } } };
  }

  if (task.type === "ocr") {
    const img = inputs.attachments?.[0]?.file_url;
    const mime = inputs.attachments?.[0]?.file_type ?? "image/jpeg";
    if (!img) throw new Error("No image for ocr");

    const prompt =
      "Read pH and Specific Gravity (SG) from the image if visible. Respond JSON: {\"ph\":\"\",\"sg\":\"\"}";
    const res = await geminiJSON({ prompt, imageUrl: img, mimeType: mime });
    return {
      analytes: {
        ph: { value: res.ph ?? "", unit: "" },
        sg: { value: res.sg ?? "", unit: "" },
      },
    };
  }

  if (task.type === "text_extract") {
    const out: any = { analytes: {} };
    for (const f of inputs.text_fields ?? []) {
      if (raw?.[f] != null) out.analytes[f] = { value: String(raw[f]), unit: "" };
    }
    return out;
  }

  if (task.type === "cell_count") {
    const img = inputs.attachments?.[0]?.file_url;
    if (!img) throw new Error("No image for cell_count");
    if (!task.tool_url) throw new Error("cell_count tool_url not configured");

    const r = await fetch(task.tool_url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image_url: img, params: task.params }),
    });
    const j = await r.json();
    const out: any = { analytes: {} };
    for (const [k, v] of Object.entries(j)) out.analytes[k] = { value: v, unit: "cells/HPF" };
    return out;
  }

  if (task.type === "custom_webhook") {
    if (!task.tool_url) throw new Error("custom_webhook tool_url not configured");
    const r = await fetch(task.tool_url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inputs, params: task.params, raw }),
    });
    return await r.json();
  }

  return { analytes: {} };
}

/* ------------- Gemini calls ------------- */

async function geminiJSON(args: { prompt: string; imageUrl?: string; mimeType?: string }) {
  const { prompt, imageUrl, mimeType } = args;
  const url = GEMINI_URL(GEMINI_MODEL);

  const parts: any[] = [{ text: prompt }];

  if (imageUrl) {
    const { base64, mime } = await fetchAsBase64(imageUrl, mimeType);
    parts.push({
      inlineData: {
        mimeType: mime,
        data: base64,
      },
    });
  }

  const body = {
    generationConfig: { responseMimeType: "application/json" },
    contents: [{ role: "user", parts }],
  };

  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const j = await r.json();
  const text = j?.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

async function runGeminiParser(cfg: any, payload: any) {
  const prompt = [
    cfg.parser_prompt,
    "",
    "INPUT (JSON):",
    JSON.stringify({ analyte_map: cfg.analyte_map || {}, unit_map: cfg.unit_map || {}, input: payload }),
    "",
    'Respond ONLY as JSON in shape: {"meta":{"sample_id":...,"review_status":...},"analytes":{"<canonical>":{"value":"","unit":""}}}',
  ].join("\n");

  return await geminiJSON({ prompt });
}

async function runGeminiValidator(cfg: any, payload: any) {
  const prompt = [
    cfg.validator_prompt,
    "",
    "RAW, NORMALIZED, RULES:",
    JSON.stringify(payload),
    "",
    'Return ONLY JSON: {"status":"ok|warn|fail","issues":[{"severity":"error|warn","field":"...","message":"...","suggestion":"..."}]}',
  ].join("\n");

  return await geminiJSON({ prompt });
}

async function fetchAsBase64(url: string, hintMime?: string) {
  const resp = await fetch(url);
  const ab = await resp.arrayBuffer();
  const base64 = arrayBufferToBase64(ab);
  // prefer Content-Type header if present
  const mime = resp.headers.get("content-type") || hintMime || "application/octet-stream";
  return { base64, mime };
}

function arrayBufferToBase64(buffer: ArrayBuffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const len = bytes.length;
  for (let i = 0; i < len; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/* ------------- Validation + logging ------------- */

function pickRules(cfg: any) {
  return {
    required_fields: cfg?.required_fields || [],
    numeric_rules: cfg?.numeric_rules || {},
    enum_rules: cfg?.enum_rules || {},
  };
}

function hardValidate(parsed: any, cfg: any) {
  const issues: any[] = [];
  const rules = pickRules(cfg);
  const analytes = parsed?.analytes || {};

  for (const f of rules.required_fields || []) {
    const present = f in (parsed?.meta || {}) || f in analytes;
    if (!present)
      issues.push({ severity: "error", field: f, code: "required", message: `Missing required field: ${f}` });
  }

  for (const [k, rule] of Object.entries<any>(rules.numeric_rules || {})) {
    const v = analytes?.[k]?.value ?? analytes?.[k]?.value;
    const num = typeof v === "string" ? parseFloat(v as string) : (v as number);
    if (typeof num === "number" && isFinite(num)) {
      if (rule.min != null && num < rule.min)
        issues.push({ severity: "warn", field: k, code: "below_min", message: `Value ${num} < min ${rule.min}` });
      if (rule.max != null && num > rule.max)
        issues.push({ severity: "warn", field: k, code: "above_max", message: `Value ${num} > max ${rule.max}` });
    }
  }

  for (const [k, arr] of Object.entries<any>(rules.enum_rules || {})) {
    const v = analytes?.[k]?.value;
    if (v != null && !arr.includes(String(v))) {
      issues.push({ severity: "warn", field: k, code: "enum_mismatch", message: `Unexpected value '${v}' for ${k}` });
    }
  }
  return issues;
}

async function logAiRun(
  supabase: any,
  workflow_result_id: string,
  kind: "parser" | "validator",
  model: string,
  request: any,
  response: any,
  ok: boolean,
  duration_ms: number
) {
  await supabase.from("ai_runs").insert({
    workflow_result_id,
    kind,
    model,
    request,
    response,
    ok,
    duration_ms,
  });
}

async function insertIssue(supabase: any, workflow_result_id: string, issue: any) {
  await supabase.from("ai_issues").insert({
    workflow_result_id,
    severity: issue.severity || "warn",
    field: issue.field || null,
    code: issue.code || null,
    message: issue.message || String(issue),
    suggestion: issue.suggestion || null,
  });
}

/* ------------- Canonical commit ------------- */

async function upsertResults(
  supabase: any,
  args: {
    orderId: string | null;
    workflowInstanceId: string;
    userId: string | null;
    results: Record<string, unknown>;
    testName: string;
    qcSummary: string | null;
  }
) {
  let existing: any = null;
  if (args.orderId) {
    const { data } = await supabase
      .from("results")
      .select("*")
      .eq("order_id", args.orderId)
      .eq("test_name", args.testName)
      .limit(1);
    existing = data?.[0] ?? null;
  }

  const base = {
    order_id: args.orderId,
    workflow_instance_id: args.workflowInstanceId,
    patient_id: (args.results["patient_id"] as string) ?? null,
    patient_name: (args.results["patient_name"] as string) ?? "Workflow Patient",
    test_name: args.testName,
    status: "Entered",
    entered_by: args.userId ?? "system",
    entered_date: new Date().toISOString().split("T")[0],
    technician_id: args.userId ?? null,
    result_date: new Date().toISOString(),
    notes: (args.results["notes"] as string) ?? (args.results["final_report"] as string) ?? "",
  };

  if (existing) {
    const { data, error } = await supabase.from("results").update(base).eq("id", existing.id).select().single();
    if (error) throw error;
    return data;
  } else {
    const { data, error } = await supabase.from("results").insert(base).select().single();
    if (error) throw error;
    return data;
  }
}

async function upsertResultValuesFromParsed(
  supabase: any,
  resultId: string,
  orderId: string | null,
  parsed: any
) {
  const analytes = parsed?.analytes || {};
  const names = Object.keys(analytes);

  // Lookup analyte meta
  let meta = new Map<string, any>();
  if (names.length) {
    const { data } = await supabase
      .from("analytes")
      .select("id,name,unit,reference_range")
      .in("name", names);
    meta = new Map((data ?? []).map((r: any) => [r.name, r]));
  }

  // Idempotent write
  await supabase.from("result_values").delete().eq("result_id", resultId);

  const rows: any[] = [];
  for (const [name, obj] of Object.entries<any>(analytes)) {
    const m = meta.get(name);
    rows.push({
      result_id: resultId,
      analyte_id: m?.id ?? null,
      analyte_name: name,
      parameter: name,
      value: String(obj?.value ?? ""),
      unit: obj?.unit ?? m?.unit ?? "",
      reference_range: m?.reference_range ?? "",
      flag: null,
      order_id: orderId,
    });
  }

  if (parsed?.meta?.qc_summary) {
    rows.push({
      result_id: resultId,
      analyte_id: null,
      analyte_name: "QC Summary",
      parameter: "QC Summary",
      value: String(parsed.meta.qc_summary),
      unit: "",
      reference_range: "",
      flag: null,
      order_id: orderId,
    });
  }

  if (rows.length) {
    const { error } = await supabase.from("result_values").insert(rows);
    if (error) throw error;
  }
}

/* ------------- Progress ------------- */

async function updateWorkflowProgress(supabase: any, instanceId: string, completedStepId: string) {
  const { data: instance } = await supabase
    .from("order_workflow_instances")
    .select("*")
    .eq("id", instanceId)
    .single();

  if (instance) {
    const update: any = { current_step_id: completedStepId, updated_at: new Date().toISOString() };
    if (completedStepId === "final_results" || completedStepId.includes("complete")) {
      update.completed_at = new Date().toISOString();
    }
    await supabase.from("order_workflow_instances").update(update).eq("id", instanceId);
  }
}
