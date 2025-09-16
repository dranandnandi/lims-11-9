---
# LIMS — Git, Workflow & Migration Guide

> **Audience:** Engineers & AI assistants working on this repo.  
> **Goal:** Ensure safe, repeatable changes across **code + database** with multi‑lab tenancy, RLS, billing, and the **Accounts** layer.

---

## 1) One‑Minute Overview

- **Branching:** Trunk‑based with short‑lived feature branches. Protected `main`.
- **Commits:** **Conventional Commits** (`feat:`, `fix:`, `db:`, …) with clear scopes.
- **DB migrations:** Idempotent SQL, committed in `db/migrations/`. Test locally, then stage, then prod.
- **Release:** PR → squash merge → tag (`vX.Y.Z`) → deploy. Hotfix off tag.
- **Non‑negotiables:** Always pass **`lab_id`**, respect **RLS**, never expose **service role** to frontend.

---

## 2) Repository Conventions

```

/db
  /migrations             # SQL, forward-only, idempotent
  /seeds                  # optional seed data per env
/docs
  README-LIMS.md          # product & architecture rationale (this project)
  GIT-INSTRUCTIONS.md     # this file
/src
  /components
  /pages
  /utils/supabase.ts      # data-access wrapper (ensure lab_id is set)
  ...

.env.example              # sample env variables (NO secrets checked in)
CHANGELOG.md              # generated from commits (optional)
```

### Environments
- **local** → developer machine (Supabase local or remote dev instance)
- **staging** → realistic data, mirrors prod RLS and settings
- **prod** → protected

Make sure `.env.local`, `.env.staging`, `.env.production` are maintained separately.

---

## 3) Branching Strategy

**Trunk‑based** (recommended):
- `main`: protected. Only PRs land here.
- **feature branches**: `feat/<topic>`, `fix/<topic>`, `db/<topic>`, e.g.
  - `feat/order-form-accounts`
  - `db/add-accounts-layer`
  - `fix/cash-recon-variance`
- **hotfix branches**: `hotfix/<ticket-or-bug>` created from a **release tag** (see §9).

> If your team prefers Gitflow, adapt names (`develop`, `release/*`). The rest of this guide still applies.

---

## 4) Commit Messages — Conventional Commits

Use **type(scope): subject**. Scopes are optional but encouraged.

**Types**
- `feat:` new user‑visible functionality
- `fix:` bug fix
- `db:` schema/migrations/backfills
- `refactor:` no behavior change
- `perf:`, `test:`, `docs:`, `build:`, `ci:`, `chore:`, `revert:`

**Examples**
- `db(accounts): add account_id to invoices & orders`
- `feat(billing): payment capture supports credit_adjustment`
- `fix(orders): pass lab_id on create to avoid RLS errors`

---

## 5) Database Migrations (Supabase / Postgres)

**File layout**
- Place SQL in `db/migrations/<YYYYMMDD-HHMMSS>__<slug>.sql`
- Prefer **idempotent** SQL (`IF NOT EXISTS`, guarded `DO $$ … $$` blocks).
- Include **indexes** and **RLS** policies near the table creation for cohesion.

**Creating a migration**
```bash
# Option A: using Supabase CLI (recommended)
supabase migration new "add-accounts-layer"

# Option B: manual file
mkdir -p db/migrations
$EDITOR db/migrations/20250916-1200__add-accounts-layer.sql
```

**Idempotency checklist**
- `CREATE TABLE IF NOT EXISTS`
- For columns: test with catalog query before `ALTER TABLE ... ADD COLUMN`
- For triggers/policies: `DROP TRIGGER IF EXISTS`, `DROP POLICY IF EXISTS` then `CREATE`

**Local test (with Supabase CLI)**
```bash
# Start local stack (first time will pull containers)
supabase start

# Reset & apply all migrations locally (DANGEROUS: wipes local DB)
supabase db reset

# Or push incremental changes to local DB
supabase db push
```

**Staging** → **Prod** promotion
1. Apply migration to **staging**.
2. Run smoke tests (see §10) with a staging user bound to a known `lab_id`.
3. Review logs for RLS errors.
4. Apply to **prod** during a safe window.

**Rollback policy**
- Prefer **forward‑only** migrations; write a **reversal migration** if needed (e.g., drop col, rename back).
- Data‑destructive changes require explicit export & backup steps in PR description.

**Seeding & Backfills**
- Put one‑off backfills in `/db/seeds/<YYYYMMDD>__*.sql` or alongside the migration with guards.
- Example: backfill `lab_id` for legacy rows for a given lab:
```sql
UPDATE public.patients
SET lab_id = 'YOUR-LAB-UUID'
WHERE lab_id IS NULL;
```

---

## 6) Supabase & RLS Guardrails

- **Never** ship frontend code that uses a **service role** key.
- All read/write queries must include or infer **`lab_id`**.
- RLS policies should:
  - Allow `SELECT/INSERT/UPDATE` **only** where `users.lab_id = <table>.lab_id`.
  - Be symmetrical: `USING` matches `WITH CHECK` for insert/update.
- Add simple developer **RLS tests** (see §10).

**Common RLS errors**:
- *“new row violates row-level security policy”* → not passing `lab_id` on insert.
- *“select not allowed”* → wrong joins; fetch `lab_id` first, or use a view that enforces it.

---

## 7) App Coding Conventions (Schema-aware)

- Always **propagate `lab_id`** in create paths (`patients`, `orders`, `invoices`, `payments`, etc.).
- Respect **Bill‑to precedence**: `account_id` (if present) → `location_id` → self.
- **Discount** precedence: Manual > Account > Location > Doctor.
- **Cash** payments must include a **`location_id`** (for reconciliation).
- **Credit** ledger entries should associate to an **`account_id`** where possible; else to `location_id`.

---

## 8) PR Process

**PR Template (copy into `.github/PULL_REQUEST_TEMPLATE.md`)**
```markdown
## Summary
- What changed (feature/bug/db) and why

## Screenshots / Demos
- GIFs or images of UI changes

## DB
- [ ] Migration included (path: db/migrations/...)
- [ ] Idempotent & reviewed
- [ ] Staging applied & verified

## RLS
- [ ] lab_id passed in all new create paths
- [ ] Policies confirmed for new/changed tables

## Tests
- [ ] Local pass (unit/integration)
- [ ] Staging smoke pass

## Rollout
- [ ] Docs updated (README-LIMS.md)
- [ ] Feature flag (if risk)
```

**Review checklist**
- Does every write include `lab_id`?
- Do queries only fetch tenant rows (`lab_id` filter or join)?
- Do invoices/tests reflect partial billing correctly?
- Are payments tied to `location_id` when cash, or to `account_id` when credit adjustments?
- Are migrations re‑runnable and safe?

---

## 9) Releases & Hotfixes

**Release tagging**
```bash
# After merging to main
git checkout main && git pull
# Optional: bump version via changesets or manual
git tag vX.Y.Z -m "LIMS release vX.Y.Z"
git push origin vX.Y.Z
```

**Deploy** the tagged commit. Verify:
- DB migrations applied
- RLS paths OK
- Billing + cash reconciliation smoke tests

**Hotfix**
```bash
git checkout -b hotfix/fix-billing vX.Y.Z
# commit fix
git push -u origin hotfix/fix-billing
# PR to main → merge → tag vX.Y.(Z+1)
```

---

## 10) Testing & Smoke Scripts

**Local unit/integration**
```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run dev
```

**Minimal RLS smoke (psql)**
```sql
-- Pretend as user U with lab_id = L
-- SELECT should return only rows with lab_id = L
SELECT count(*) FROM orders WHERE lab_id = 'L';
-- INSERT should succeed only when lab_id = L
INSERT INTO orders (id, lab_id, patient_id, payment_type)
VALUES (gen_random_uuid(), 'L', '...', 'self');
```

**Billing flow smoke**
1. Create **order** (self) → select tests → **invoice** → cash **payment** → see it in **cash reconciliation** for the chosen location/date.
2. Create **order** (credit) with **Account** → partial invoice → **credit_adjustment** payment → verify **AR** entry in `credit_transactions` for that **account_id`**.
3. Create **order** (credit) w/o Account but **Location** → partial invoices → capture payments → verify AR for **location_id**.

---

## 11) Feature Flags (Optional but recommended)

Use a simple flags object or remote config to gate risky features:
- `billing.accounts.enabled`
- `billing.partialInvoices.enabled`
- `cashReconciliation.enabled`

Ship dormant to prod, enable per environment.

---

## 12) Troubleshooting (Real errors we saw)

- **`column "location_id" does not exist`** → apply the migration adding it, or verify environment DB is current.
- **`result_values.unit` NOT NULL violation** → backfill defaults or relax constraint before import.
- **`relation "public.lab_members" does not exist`** → earlier policy assumed that table; switch RLS to use `public.users.lab_id` (Option A).
- **Mysterious empty queries** → RLS filters out rows; check `lab_id` propagation.

---

## 13) Security Notes

- Keep **service role** keys **server-only**.
- Rotate keys on leaks or after CI vendor changes.
- Limit DB extensions to those required (e.g., `pgcrypto` for UUIDs).

---

## 14) Appendix — Useful Commands
```bash
# Rebase feature branch on latest main
git fetch origin
git rebase origin/main

# Squash commits locally (before PR)
git reset --soft origin/main
git commit -m "feat(billing): add PaymentCapture w/ account credit adjustment"

# Generate changelog (if using conventional-changelog/standard-version)
npx standard-version
git push --follow-tags origin main
```

---

**Final Notes for Future Maintainers**
- Read **README-LIMS.md** for deep product & schema rationale.
- Keep DB changes **idempotent** and **tenant-safe**.
- When in doubt, add a smoke test in staging before shipping.

applyTo: '**'
---
Provide project context and coding guidelines that AI should follow when generating code, answering questions, or reviewing changes.
Always show details
# Create a comprehensive README for the LIMS project with phases, schema, and rationale
readme = r"""# LIMS — Multi-Lab, Location, Doctor, Billing & Accounts Layer (Project README)

> **Purpose:** This README captures *what changed*, *why it changed*, and *how the pieces fit together* so any engineer or AI assistant can continue the work confidently. It summarizes architecture, database migrations, UI flows, and conventions implemented across Phases 1–4, including the optional **Accounts (B2B bill-to)** layer.

---

## TL;DR (What you can rely on)

- **Multi-lab** tenancy via `lab_id` on core tables + RLS by `users.lab_id`.
- **Masters:** `doctors`, `locations` (+ cash support), and optional **`accounts`** (B2B bill-to: hospital/corporate/insurer).
- **Orders** now carry: `referring_doctor_id`, `location_id`, `payment_type`, and optional **`account_id`**.
- **Order tests → Invoices** with **partial billing** support; **discounts** can be manual or defaulted (Account > Location > Doctor).
- **Payments** (cash/card/upi/bank/**credit_adjustment**) and **Cash Reconciliation** per **location/shift**.
- **Credit** ledger posts to **Account** (preferred) or **Location** for non-self payments.
- **Attachments:** test request form (TRF) can be uploaded at **order** level.
- All migrations written **idempotently** (safe to re-run).

---

## Problem We Solved (Intent)

1. **Unify Order → Invoice** flow and allow **partial billing** at test level.
2. **Make billing flexible:** self-pay, location-credit, or B2B **Account** bill-to.
3. **Track cash** at collection centers and reconcile daily by **location** and **shift**.
4. **Keep data tenant-safe:** every row belongs to a **lab** via `lab_id` + RLS.
5. Improve **UI ergonomics:** compact Order form that can expand; TRF upload; invoice creation from Order; payment capture and cash reconciliation UIs.

---

## Domain Model (Key entities)



Lab ─┬─ Users
├─ Doctors
├─ Locations (collection centers, clinics, walk-in, home collection)
├─ Accounts (B2B bill-to: hospital/corporate/insurer/clinic/doctor/other) ← optional
└─ Patients
└─ Orders
├─ OrderTests
└─ Invoices
├─ InvoiceItems
├─ Payments (cash/card/upi/bank/credit_adjustment)
└─ CreditTransactions (AR to Account or Location)

Always show details

**Notes**
- *Processing vs Collection:* `orders.location_id` represents **collection/origin**. Processing center (if needed later) can be a separate `processing_location_id` column (deferred).
- *Bill-to precedence:* **Account** (if present) else **Location**, else **Self**.

---

## Multi-Tenancy & Security

- Every core table is **scoped by `lab_id`**.
- **RLS** policies use `public.users.lab_id` to ensure tenant isolation.
- New tables (`doctors`, `locations`, `accounts`, `payments`, `cash_register`, `credit_transactions`) enable RLS and indexes on `lab_id`.

---

## Database Changes (Summary)

> All migrations were written **idempotently** using `IF NOT EXISTS` or guarded `DO $$` blocks.

### Masters
- **`doctors`**: `lab_id`, `name`, `specialization`, `preferred_contact`, `report_delivery_method`, `default_discount_percent`, `is_active`, timestamps.
- **`locations`**: `lab_id`, identity & address, `supports_cash_collection`, `default_discount_percent`, `credit_limit`, `payment_terms`, `is_active`.
- **`accounts`** (optional): `lab_id`, `name`, `code?`, `type` (`hospital|corporate|insurer|clinic|doctor|other`), `default_discount_percent`, `credit_limit`, `payment_terms`, billing contact & address, `is_active`.

### Patients & Orders
- **`patients`**: defaults — `default_doctor_id`, `default_location_id`, `default_payment_type`.
- **`orders`**: `referring_doctor_id`, `location_id`, `payment_type` (`self|credit|insurance|corporate`), `billing_status` (`pending|partial|billed`), optional **`account_id`**.

### Billing
- **`order_tests`**: `invoice_id`, `is_billed`, `billed_at`, `billed_amount`.
- **`invoices`**: totals with discount fields (`total_before_discount`, `total_discount`, `total_after_discount`), `is_partial`, `parent_invoice_id`, `location_id`, `referring_doctor_id`, `payment_type`, optional **`account_id`**.
- **`invoice_items`**: `order_test_id`, `discount_type` (`percent|flat`), `discount_value`, `discount_amount`, `discount_reason`.
- **`payments`**: `invoice_id`, `amount`, `payment_method` (`cash|card|upi|bank|credit_adjustment`), `payment_reference`, `payment_date`, `location_id?`, `account_id?`, `notes`.
- **`cash_register`**: per `lab_id + location_id + register_date + shift` with `opening_balance`, `system_amount`, `actual_amount`, `variance`, `reconciled` flags.
- **`credit_transactions`**: AR ledger with `transaction_type` (`credit|payment|adjustment`), tying to **`account_id`** or `location_id` (+ `invoice_id`/`patient_id`).

### Triggers (Quality of life)
- **Invoice account fallback:** if `invoices.account_id` null but `order_id` present → copy from `orders.account_id`.
- **Credit tx account fallback:** if `credit_transactions.account_id` null but `invoice_id` present → copy from `invoices.account_id`.

---

## Phased App Changes (What the UI does now)

### Phase 1 — Schema & Wiring
- Add billing columns to `orders`, `order_tests`, `invoices`.
- Create `locations`, `doctors` (masters), cash/credit tables, indexes, RLS.
- **Outcome:** DB can track billing per test, partial invoices, and cash vs credit.

### Phase 2 — Masters & Patient Registration
- CRUD for **Locations** and **Doctors**; capture doctor/location defaults on **Patients**.
- **PatientForm** enhancements (defaults to `payment_type`, doctor, location).
- **Outcome:** Clean master data + better patient defaults.

### Phase 3 — Order Management (+ Accounts)
- **OrderForm** unified & cleaned (search patient, select tests, doctor, location, **optional Account**, payment type, priority, TRF upload).
- Dashboard now creates orders using a real `handleAddOrder` (lab-scoped) and passes through **`account_id`** if selected.
- **CreateInvoiceModal**: picks unbilled tests → builds invoice; **discount precedence** = Manual > Account > Location > Doctor; marks `order_tests` as billed; sets `billing_status` to `partial|billed`; posts **credit** to Account (preferred) or Location on non-self payment types.
- **Outcome:** End-to-end Order → Invoice pipeline with partial billing + Accounts.

### Phase 4 — Billing & Cash Reconciliation (+ Account aware)
- **Billing page** lists invoices with **Bill To** (Account/Location/Self), status filters, and opens **PaymentCapture**.
- **PaymentCapture**: shows bill-to; records payments; enables **`credit_adjustment`** for account-billed invoices (ledger move, no cash).
- **CashReconciliation**: aggregates **cash** by date/location/shift from `payments.payment_method='cash'` and writes to `cash_register`; allows entering **actual amount** and stores `variance` + notes.
- **Outcome:** Clear picture of who pays (patient vs account), where cash sits (location), and ledger status.

---

## Billing Logic (Single source of truth)

1. **Order → Invoice**
   - User selects unbilled tests → creates an invoice.
   - Supports **partial** invoices and **multiple** invoices per order.
2. **Discounts**
   - Default % from **Account** or **Location** or **Doctor** (in that order).
   - Manual line/global discounts override defaults.
3. **Payments & Status**
   - `payments` sum vs invoice total updates the UI status (`Unpaid|Partial|Paid`). (If you want automatic status updates, add a trigger or job.)
4. **Credit Posting**
   - If payment type is `credit|corporate|insurance`, create **credit** ledger entry under **Account** (if selected) else under **Location**.
   - **Cash** always posts with a `location_id` into payments (and later reconciled).

---

## Attachments (TRF)
- TRF upload during order creation (or later) is stored via the existing attachment system with:
  - `related_table='orders'`, `related_id=<order_id>`, `file_type='test_request_form'`.
- Displayed in result verification console for lab staff reference.

---

## Conventions & Helper APIs

- **Database wrapper (`database.*`)**
  - `orders.create`, `orders.update`, `orders.getById`
  - `orderTests.getUnbilledByOrder`, `orderTests.markAsBilled`
  - `invoices.create`, `invoices.getById|getAll|getByStatus`
  - `invoiceItems.create|getByInvoice`
  - `patients.getAll|getById|create`
  - `doctors.getAll|getById`
  - `locations.getAll|getById|checkCreditLimit`
  - `accounts.getAll|getById|checkCreditLimit`
  - `payments.create|getByInvoice|getByDateRange`
  - `cashRegister.getOrCreate|update|reconcile`
- **UI Rules**
  - For non-self payments, require a **Bill-to** (prefer **Account**, or **Location** if no account).
  - Show **Bill To** on invoice UI surfaces.
  - Use **credit_adjustment** only for account-billed invoices (no cash).

---

## Known Issues Resolved During Migration

- **Missing `lab_id`** on legacy rows: added backfills (e.g., patients) and ensured app now sets `lab_id` in create paths.
- **`location_id` does not exist** errors: surfaced where columns weren’t yet added; addressed in schema migrations.
- **`result_values.unit` NOT NULL**: old rows missing `unit` triggered violations; handled by backfilling a sensible default or relaxing constraint where appropriate.
- **RLS**: ensure policies exist before enabling, and that service calls set `lab_id` consistently.

---

## How to Run Migrations (Order & Idempotency)

1. Create/extend **doctors** and **locations** with RLS (Option A: `users.lab_id`).
2. Add new columns on **patients**, **orders**, **order_tests**, **invoices**.
3. Create **payments**, **cash_register**, **credit_transactions**.
4. **Accounts** layer (optional, but now included): table + add `account_id` to **orders**, **invoices**, **credit_transactions** + convenience triggers.
5. Backfill `lab_id` on legacy tables (patients, orders, etc.).
6. Validate RLS access using a test user bound to a `lab_id`.

> All ALTER/CREATE guarded with checks. Running the script twice is safe.

---

## Testing Checklist (Manual)

- Create patient → order (self) → add tests → create invoice → capture cash → reconcile location.
- Create patient → order (**credit**, **Account** chosen) → partial invoice → capture **credit_adjustment** → confirm credit ledger entry to **Account**.
- Create patient → order (**credit**, **no Account**, **Location** chosen) → partial invoices → payments (mix cash/bank) → ledger to **Location**.
- Discounts: verify default % from Account/Location/Doctor and that manual overrides apply line/global.
- TRF upload: verify storage + appears in verification console.
- Multi-lab: confirm user from Lab A cannot see Lab B rows.

---

## Future-Proofing (Next steps you can add later)

- Separate `collection_location_id` vs `processing_location_id` on **orders** if operationally needed.
- Auto-status update trigger on **invoices** (compute `Paid|Partial|Unpaid` from `payments`).
- Statements & aging reports for **Accounts** and **Locations**.
- Optional **Accounts** on **payments** (already supported for credit adjustments) and **cash_register** summaries per user/shift.
- Line-level taxes/GST if required by region, printable invoice PDFs.

---

## Glossary

- **Account:** A B2B bill-to entity (hospital/corporate/insurer/clinic/doctor/other). Optional; if present it owns AR.
- **Location:** A collection/partner place (clinic, walk-in, hospital ward, home collection hub). Can have **cash box**.
- **Credit Adjustment:** A non-cash ledger movement against an Account to settle or reduce AR (no money collected).

---

## What to Tell a Future AI Assistant

- Respect **lab_id** and RLS in every query/insert.
- When creating **orders** or **invoices**, pass through optional **`account_id`** and **`location_id`**.
- For non-self payments: prefer **Account**; else **Location** as bill-to. Use `credit_adjustment` when settling AR without cash.
- Discounts cascade: **Manual > Account > Location > Doctor** (current policy).
- Cash reconciliation always aggregates **payments where `payment_method='cash'` grouped by location/date/shift`**.

---

*End of README.*
"""

# Write file
path = "/mnt/data/README-LIMS.md"
with open(path, "w", encoding="utf-8") as f:
    f.write(readme)

path


All set! I’ve created a comprehensive README you can ship with the repo.