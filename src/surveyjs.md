Goal

Run per-test-group and per-analyte procedural flows (Basic/Pro) using SurveyJS.

No new tables. Only touch existing workflow_* tables (plus small additions to test_workflow_map you asked for).

A) Database changes (workflow tables only)
1) test_workflow_map – add finer targets

Add analyte & test-group linkage so a flow can be chosen at the group or analyte level (legacy test_code still works).

-- Add targets (nullable)
ALTER TABLE public.test_workflow_map
  ADD COLUMN IF NOT EXISTS test_group_id uuid,
  ADD COLUMN IF NOT EXISTS analyte_id uuid;

-- FKs
ALTER TABLE public.test_workflow_map
  ADD CONSTRAINT IF NOT EXISTS test_workflow_map_test_group_id_fkey
  FOREIGN KEY (test_group_id) REFERENCES public.test_groups(id) ON DELETE CASCADE;

ALTER TABLE public.test_workflow_map
  ADD CONSTRAINT IF NOT EXISTS test_workflow_map_analyte_id_fkey
  FOREIGN KEY (analyte_id) REFERENCES public.analytes(id) ON DELETE CASCADE;

-- Ensure at least one target present
ALTER TABLE public.test_workflow_map
  DROP CONSTRAINT IF EXISTS chk_twm_target_present;
ALTER TABLE public.test_workflow_map
  ADD CONSTRAINT chk_twm_target_present
  CHECK (analyte_id IS NOT NULL OR test_group_id IS NOT NULL OR test_code IS NOT NULL);

-- Lookups & "one default" per scope
CREATE INDEX IF NOT EXISTS idx_twm_group_lookup   ON public.test_workflow_map (lab_id, test_group_id);
CREATE INDEX IF NOT EXISTS idx_twm_analyte_lookup ON public.test_workflow_map (lab_id, analyte_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_twm_default_by_group
ON public.test_workflow_map (lab_id, test_group_id)
WHERE is_default = true AND test_group_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_twm_default_by_analyte
ON public.test_workflow_map (lab_id, analyte_id)
WHERE is_default = true AND analyte_id IS NOT NULL;


Backfill (once): set test_group_id on existing rows by joining test_code → test_groups.code (you already have this), then gradually phase out test_code.

2) workflow_versions – store SurveyJS + rules in JSON (no DDL needed)

Use workflow_versions.definition (jsonb) to store:

The SurveyJS template (UI).

The validation rules (server uses them).

Optional UI hints (labels, help text) and role flags.

Recommended JSON shape

{
  "ui": {
    "engine": "surveyjs",
    "template": { /* SurveyJS JSON: pages, elements, triggers */ }
  },
  "rules": {
    "mode": "PRO",                       // or BASIC
    "steps": [
      { "no": 1, "target_volume_ul": 120, "tolerance_pct": 5,
        "allowed_pipettes": ["P200"] }
    ],
    "pipettes": {
      "QR-P200-017": { "model": "P200", "min_ul": 20, "max_ul": 200 }
    }
  },
  "meta": { "title": "CBC – Pipette Check v1", "owner": "Lab QA" }
}

3) Resolver function (precedence)

Choose the right workflow_version_id per (lab, test_group, analyte).

CREATE OR REPLACE FUNCTION public.resolve_workflow_version_id(
  p_lab_id uuid, p_test_group_id uuid, p_analyte_id uuid
) RETURNS uuid
LANGUAGE sql STABLE AS $$
  WITH pick AS (
    -- 1) analyte-level default
    SELECT workflow_version_id, 1 AS pr
    FROM public.test_workflow_map
    WHERE lab_id = p_lab_id AND analyte_id = p_analyte_id AND is_default = true

    UNION ALL
    -- 2) group-level default
    SELECT workflow_version_id, 2
    FROM public.test_workflow_map
    WHERE lab_id = p_lab_id AND test_group_id = p_test_group_id AND is_default = true

    UNION ALL
    -- 3) legacy by code (optional)
    SELECT m.workflow_version_id, 3
    FROM public.test_workflow_map m
    JOIN public.test_groups g ON g.id = p_test_group_id
    WHERE m.lab_id = p_lab_id AND m.test_code = g.code AND m.is_default = true
  )
  SELECT workflow_version_id FROM pick ORDER BY pr LIMIT 1;
$$;


No schema changes needed for order_workflow_instances and workflow_step_events. We’ll just use them.

B) Server endpoints (Edge/Netlify)

All keys live server-side. These are small, fast functions.

GET /flow/resolve
Query: labId, testGroupId, analyteId
Return: { workflowVersionId, definition } (the JSON above).

Internally calls resolve_workflow_version_id(...).

If null, return 404 (UI can fall back to Basic default).

POST /event (audit everything)
Body: { instanceId, stepId, eventType, payload }

Inserts row into workflow_step_events.

POST /validate-step
Body: { workflowVersionId, stepNo, inputs }

Loads workflow_versions.definition->rules.

Validates pipette/volume/dilution, etc.

Returns { ok, messages }. Also logs an event (VALIDATE_OK/VALIDATE_FAIL).

POST /start
Body: { orderId, workflowVersionId }

Creates order_workflow_instances (if not present). Returns instanceId.

POST /complete
Body: { instanceId, surveyResult }

Sets completed_at in order_workflow_instances.

Writes one 'COMPLETE' event with the full surveyResult JSON (this is the artifact you’ll reuse later).

You can combine (2) & (3) if you prefer a single /event that sometimes validates.

C) UI implementation (React/Capacitor + SurveyJS)
1) Resolve & load

At run time (for each order / test group / analyte):

Call /flow/resolve → get { workflowVersionId, definition }.

If none, show Basic form (minimal checks).

If found and definition.ui.engine === 'surveyjs':

Construct new Survey.Model(definition.ui.template).

2) Provide runtime variables

Before rendering:

survey.setVariable("orderId", orderId);
survey.setVariable("testGroupId", testGroupId);
survey.setVariable("analyteId", analyteId);
survey.setVariable("instanceId", instanceId);


You can show hints using these variables inside SurveyJS.

3) Wire validations (non-blocking UX)

onValueChanged (debounced 300–500 ms): call /validate-step with { workflowVersionId, stepNo, inputs }.

Set a hidden field like __validate_result with the response; use an Expression question to show ✅/❌ and messages.

Disable Next/Complete until __validate_result.ok === true.

Example (client):

survey.onValueChanged.add(async (_, opt) => {
  if (!shouldValidate(opt.question?.name)) return;
  const res = await post('/validate-step', { workflowVersionId, stepNo: currentStep, inputs: survey.data });
  survey.setValue('__validate_result', res);
  await post('/event', { instanceId, stepId: currentStep, eventType: res.ok ? 'VALIDATE_OK' : 'VALIDATE_FAIL', payload: res });
});

4) Audit trail

onCurrentPageChanged → POST /event with eventType: 'NEXT', payload: current page data.

onUploadFiles (if you allow photos/QR) → upload to Supabase Storage; reference the URL in the event payload (or store via attachments separately if you want—no schema change needed).

onComplete → POST /complete with full survey.data.

5) Multi-analyte orchestration

For a test group with multiple analytes:

Resolve for each analyte; deduplicate by workflowVersionId.

If a group-level flow exists and analyte flows are identical → run once.

If some analytes map to different flows → run group flow first (common steps), then analyte-specific subflows (only for those analytes).

D) Basic vs Pro (both supported)

BASIC: a tiny SurveyJS template (single page) or even plain form; still logs to workflow_step_events and writes one 'COMPLETE' with the JSON.

PRO: full SurveyJS with step-wise interlocks, validations, and device scans.

Distinguish via definition.rules.mode or by mapping different workflow_version_ids in test_workflow_map.

E) RLS & permissions (quick rules of thumb)

workflow_versions: read allowed to lab staff (by lab scope in workflows.lab_id via join) and system admins.

test_workflow_map: tenant-scoped by lab_id.

order_workflow_instances & workflow_step_events: user must belong to the order’s lab_id; write only by authenticated users.

All server endpoints must re-assert lab_id from JWT and cross-check inputs.

F) Rollout checklist (1–2 hours of SQL + config)

Run the ALTER TABLEs and create indexes + function.

Seed one workflow_versions with a small SurveyJS template and rules.

Add a row in test_workflow_map for your lab:

(lab_id, test_group_id, workflow_version_id, is_default=true).

Implement /flow/resolve, /validate-step, /event, /start, /complete.

In UI, add a SurveyJS runner component:

loadFlow() → survey = new Survey.Model(template); bind handlers; render.

Smoke test:

Start → validate a step → next → complete → verify rows in workflow_step_events and order_workflow_instances.completed_at.

What you get

Zero new tables; only small additions to test_workflow_map and a SQL function.

SurveyJS flows fully versioned inside workflow_versions.definition.

Clean audit trail per order with workflow_step_events.

Fine-grained mapping at group and analyte levels, with a simple precedence rule.

Easy to extend (new versions = new rows in workflow_versions).