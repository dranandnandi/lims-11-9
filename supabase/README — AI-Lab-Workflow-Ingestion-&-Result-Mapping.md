# README — AI Lab Workflow Ingestion & Result Mapping

*Last updated: 12 Sep 2025 (IST)*

## 1) What this is

A configurable pipeline that ingests **workflow payloads + attachments**, runs **AI/CV tasks**, performs **AI parsing + AI validation**, and commits **clean results** into our canonical tables (`results`, `result_values`). It’s driven by **DB configs** (no code redeploy to change behavior) and uses **Gemini `gemini-2.5-flash`** via the Edge Function:

```
/functions/v1/process-workflow-result
```

---

## 2) High-level flow

1. **Ingest** → Client posts JSON (and uploads files to Storage).
2. **Persist raw** → Save everything to `workflow_results` (universal inbox).
3. **Resolve workflow** → Use `test_workflow_map` → `workflow_versions` → `workflow_ai_configs`.
4. **Task runner** → Execute per-workflow tasks (vision\_color, ocr, cell\_count, text\_extract, custom\_webhook), consuming attachments by **tag**.
5. **AI Parser** → Normalize to canonical analyte JSON.
6. **Deterministic validation** → Required fields, ranges, enums.
7. **AI Validator** → Double-check raw vs normalized and rules → `ok | warn | fail`.
8. **Commit** → If ok/warn, write to `results` + `result_values`. If fail, mark `workflow_results.status = 'error'` and log issues.
9. **Audit & Logs** → `ai_runs`, `ai_issues`, `task_runs` capture everything.

---

## 3) Key components

### Edge Function

* **File:** `supabase/functions/process-workflow-result/index.ts`
* **Model:** Gemini `gemini-2.5-flash`
* **Secrets:**

  * `ALLGOOGLE_KEY` (Gemini)
  * `SUPABASE_SERVICE_ROLE_KEY` (Supabase)

### Storage & Attachments

* Bucket: `attachments`
* Table: `attachments`
* **Tag files** to route them to tasks (e.g., `dipstick_photo`, `microscopy_slide`, `report_pdf`).
  *Tags are conventions per workflow—**not** hard-coded enums.*

---

## 4) Database schema (summary of what matters)

### Existing (we reuse)

* `workflow_versions` (your versioned definitions table)
* `test_workflow_map` (binding: lab/test\_group/analyte/test\_code → workflow\_version\_id)
* `results`, `result_values`, `analytes`
* `attachments` (+ we added `attachments.tag`)

### New tables (added)

* `workflow_results` — universal inbox (raw payloads, status, qc\_summary, errors)
* `workflow_ai_configs` — prompts, analyte/unit maps, rules per workflow version
* `workflow_tasks` — ordered task stack (vision\_color / ocr / text\_extract / cell\_count / custom\_webhook)
* `task_runs` — per-task execution logs
* `ai_runs` — parser/validator requests & responses
* `ai_issues` — structured findings (error/warn/info)
* `analyte_aliases` — optional synonyms

> Idempotency: `(workflow_instance_id, step_id)` is unique in `workflow_results` so client retries don’t duplicate.

---

## 5) Configuration model (how behavior is controlled)

* **Binding:** A row in `test_workflow_map` selects a `workflow_version_id` for a given `(lab_id, test_group_id | analyte_id | test_code)` (using `is_default`, `priority`).
* **AI config (`workflow_ai_configs`):**

  * `parser_prompt`, `validator_prompt`
  * `analyte_map` (aliases → canonical), `unit_map`
  * `required_fields`, `numeric_rules`, `enum_rules`, `flags_rules`
* **Tasks (`workflow_tasks`):**

  * `type` ∈ {`vision_color`, `ocr`, `text_extract`, `cell_count`, `custom_webhook`}
  * `input_selector` (e.g., `{"attachment_tag":"dipstick_photo"}`)
  * `params` for tool/model
  * `output_map` (task output keys → canonical analyte names)
  * `run_order`, `enabled`

### Attachment tagging (routing)

* Choose tags that make sense for each workflow (not fixed):

  * Example: `dipstick_photo` → color/ocr tasks
  * Example: `microscopy_slide` → cell count
  * Example: `report_pdf` → text extraction fallback
* Ensure your upload flow sets `attachments.tag` accordingly.

---

## 6) What the Edge Function does (in plain English)

* Accepts POST payload `{ workflowInstanceId, stepId, results, userId, orderId, labId, testGroupId, testCode }`.
* Writes a row in `workflow_results` (status `received`).
* Looks up the active workflow via `test_workflow_map` → loads `workflow_ai_configs` + `workflow_tasks`.
* Runs each task in order; each can:

  * Call Gemini for **vision** / **OCR** / **text**,
  * Or call your microservice (e.g., **cell\_count** endpoint).
* Builds an interim normalized object (canonical analytes).
* Runs **Gemini parser** (strict JSON), then deterministic rules (required/range/enum).
* Runs **Gemini validator** (status + issues).
* If OK/WARN → upserts into `results` and completely rewrites `result_values` for that result.
  Adds a “QC Summary” value row if present.
* If FAIL → marks `workflow_results.status = 'error'`.
* Logs to `ai_runs`, `ai_issues`, `task_runs`.
* Optionally advances `order_workflow_instances` progress.

---

## 7) Seed example: Urine R/M (concept)

> You’ll create:

* One `workflow_versions` row (you already have versions; pick the right `id`).
* One `workflow_ai_configs` row with:

  * **Parser prompt** + **Validator prompt**
  * `analyte_map` for: Color, Clarity, pH, Specific Gravity, Leukocytes, Nitrite, Protein, Glucose, Ketone, Urobilinogen, Bilirubin, Volume
  * Rules: required fields (`color`, `clarity`, `ph`, `sg`), numeric pH range, enum lists for color/clarity
* Several `workflow_tasks` rows, e.g.:

  1. `vision_color` reading `dipstick_photo`
  2. `ocr` for `ph`/`sg` on `dipstick_photo`
  3. `text_extract` for `volume_ml` or `report_pdf`
  4. `cell_count` for `microscopy_slide` (your microservice)

Then make a `test_workflow_map` default pointing to this `workflow_version_id` for your Urine R/M test group/code.

---

## 8) Payload & attachments (shape to expect)

**Example** (urine test):

```json
{
  "workflowInstanceId": "uuid",
  "stepId": "final_results",
  "orderId": "uuid",
  "labId": "uuid",
  "testGroupId": "uuid",
  "testCode": "Urine R/M",
  "userId": "uuid",
  "results": {
    "patient_id": "uuid",
    "patient_name": "John Doe",
    "review_status": "completed",
    "sample_id": "ABC-123",
    "color": "Straw",
    "clarity": "Milky",
    "ph": "8.5",
    "sg": "1.030",
    "leukocyte": "Trace",
    "nitrite": "Negative",
    "volume_ml": "20",
    "cup_seal_intact": "Yes",
    "qc_strip_valid": "Yes"
  }
}
```

**Attachments:** upload separately to Storage then insert rows in `attachments` with:

* `related_table = 'workflow_results'`
* `related_id = <workflow_results.id>`
* `tag` = one of your configured tags (e.g., `dipstick_photo`, `microscopy_slide`)

---

## 9) Deploy & verify

1. **Secrets:** set `ALLGOOGLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`.
2. **SQL:** run migrations for the new tables (done) and add seed rows for your target workflow.
3. **Deploy:** push the Edge Function.
4. **Smoke test:** POST a small payload + one tagged attachment. Check:

   * `workflow_results` row created/updated
   * `task_runs`, `ai_runs`, `ai_issues` populated
   * `results` and `result_values` created/updated (or `status='error'` on fail)

---

## 10) Extending to new tests

For a new test (e.g., **CBC**):

1. Add a **`workflow_versions`** row for CBC (or reuse an existing one).
2. Insert a **`workflow_ai_configs`** row (CBC analyte map, parser/validator prompts, rules).
3. Insert **`workflow_tasks`** that make sense (e.g., OCR from analyzer printout, custom normalization).
4. Add/Update **`test_workflow_map`** default for that test group/code.
5. Align **attachment tags** used by the uploader with your tasks’ `input_selector.attachment_tag`.

*No code changes required.*

---

## 11) Observability & troubleshooting

* **Failures**: `workflow_results.status = 'error'` with details in `ai_issues`.
* **Task problems**: see `task_runs.response`.
* **AI behaviors**: see `ai_runs.request/response` (parser & validator).
* **Duplicates**: prevented by `(workflow_instance_id, step_id)` unique index.

---

## 12) Security & RLS (quick notes)

* Edge Function uses **service role** (bypasses RLS).
* If enabling RLS on new tables, add policies for service role or use secure RPCs.
* Attachments: keep bucket public only if required; otherwise, use signed URLs.

---

## 13) FAQ

* **Are attachment tags fixed?** No. They’re conventions saved in DB task configs; pick tags per workflow.
* **Where do I change prompts/rules/mappings?** In `workflow_ai_configs` (DB), not code.
* **How to add a new analyzer output?** Add/adjust `workflow_tasks` and `output_map`; update `analyte_map` and rules if needed.
* **Numeric ranges/flags?** Put in `numeric_rules` / `flags_rules`; the deterministic validator enforces/warns.

---

## 14) One-minute checklist

* [ ] `workflow_results` exists
* [ ] `workflow_ai_configs` seeded (prompts + analyte\_map + rules)
* [ ] `workflow_tasks` seeded (types, input selectors, output\_map, run\_order)
* [ ] `test_workflow_map` default points to the version
* [ ] Attachments uploaded with correct `tag`
* [ ] Secrets present: `ALLGOOGLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
* [ ] Edge Function deployed, smoke test passing

---

**That’s it.** This README is the contract for how the AI ingestion works and how to configure new workflows without touching code.
