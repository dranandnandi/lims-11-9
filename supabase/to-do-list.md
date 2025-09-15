Awesome—here are drop-in, modular snippets to make this screen feel modern, clean, and maintainable. They’re Tailwind-first, TypeScript-ready, and designed to slot into your existing file with minimal churn.

---

# 1) Tiny utility

```ts
// src/utils/cn.ts
export function cn(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}
```

---

# 2) Debounced search hook (smoother typing)

```ts
// src/hooks/useDebouncedValue.ts
import { useEffect, useState } from "react";

export function useDebouncedValue<T>(value: T, delay = 300) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}
```

---

# 3) Header with quick stats + refresh

```tsx
// src/components/reports/ReportsHeader.tsx
import { RefreshCw } from "lucide-react";

interface Props {
  onRefresh: () => void;
  total: number;
  finalReady: number;
  drafts: number;
}

export default function ReportsHeader({ onRefresh, total, finalReady, drafts }: Props) {
  return (
    <div className="bg-white border-b px-6 py-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Reports</h1>
          <p className="text-gray-600 mt-1">Generate and manage lab reports</p>
        </div>
        <button
          onClick={onRefresh}
          className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-white hover:bg-blue-700"
        >
          <RefreshCw className="h-4 w-4" />
          Refresh
        </button>
      </div>

      {/* quick stats */}
      <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
        <StatCard label="Total Orders" value={total} />
        <StatCard label="Ready for Final" value={finalReady} tone="green" />
        <StatCard label="Drafts" value={drafts} tone="blue" />
      </div>
    </div>
  );
}

function StatCard({ label, value, tone = "slate" }: { label: string; value: number | string; tone?: "slate" | "green" | "blue" }) {
  const map = {
    slate: "bg-slate-50 text-slate-700",
    green: "bg-green-50 text-green-700",
    blue:  "bg-blue-50 text-blue-700",
  } as const;

  return (
    <div className={`rounded-lg border border-gray-200 px-4 py-3 ${map[tone]}`}>
      <div className="text-xs font-medium">{label}</div>
      <div className="text-xl font-semibold mt-1">{value}</div>
    </div>
  );
}
```

**Use in page:** compute counts with `useMemo` from your `orderGroups`.

---

# 4) Compact, modern filter bar (segmented dates + debounced search)

```tsx
// src/components/reports/ReportsFilters.tsx
import { Search } from "lucide-react";
import { useDebouncedValue } from "../../hooks/useDebouncedValue";

type DateFilter = 'today' | 'yesterday' | 'week' | 'month' | 'all';

interface Props {
  search: string;
  onSearch: (s: string) => void;
  dateFilter: DateFilter;
  onDateFilter: (d: DateFilter) => void;
  onSelectAll: () => void;
  onClear:  () => void;
}

const dateTabs: { key: DateFilter; label: string }[] = [
  { key: 'today',     label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'week',      label: 'This Week' },
  { key: 'month',     label: 'This Month' },
  { key: 'all',       label: 'All' },
];

export default function ReportsFilters({
  search, onSearch, dateFilter, onDateFilter, onSelectAll, onClear,
}: Props) {
  const [local, setLocal] = React.useState(search);
  const debounced = useDebouncedValue(local, 300);

  React.useEffect(() => { onSearch(debounced); }, [debounced]);

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 mb-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        {/* search */}
        <div className="relative md:w-[420px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <input
            value={local}
            onChange={(e) => setLocal(e.target.value)}
            placeholder="Search patient, test, sample, order…"
            className="w-full pl-10 pr-3 py-2 rounded-lg border border-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        {/* segmented date selector */}
        <div className="inline-flex rounded-lg border border-gray-200 overflow-hidden">
          {dateTabs.map(({ key, label }) => (
            <button
              key={key}
              onClick={() => onDateFilter(key)}
              className={[
                "px-3 py-2 text-sm",
                key === dateFilter ? "bg-blue-600 text-white" : "hover:bg-gray-50"
              ].join(" ")}
            >
              {label}
            </button>
          ))}
        </div>

        {/* bulk selection */}
        <div className="flex gap-2">
          <button onClick={onSelectAll} className="px-3 py-2 text-sm border rounded-lg hover:bg-gray-50">
            Select All
          </button>
          <button onClick={onClear} className="px-3 py-2 text-sm border rounded-lg hover:bg-gray-50">
            Clear
          </button>
        </div>
      </div>
    </div>
  );
}
```

---

# 5) Status pill (final/draft/ready/pending)

```tsx
// src/components/reports/ReportStatusPill.tsx
interface Props {
  hasFinal?: boolean;
  hasDraft?: boolean;
  isReady?: boolean;
}

export default function ReportStatusPill({ hasFinal, hasDraft, isReady }: Props) {
  if (hasFinal)  return <Pill label="Final Available" tone="green" />;
  if (hasDraft)  return <Pill label="Draft Available" tone="blue" />;
  if (isReady)   return <Pill label="Ready to Generate" tone="slate" />;
  return <Pill label="Pending Verification" tone="amber" />;
}

function Pill({ label, tone }: { label: string; tone: "green" | "blue" | "amber" | "slate" }) {
  const map = {
    green: "bg-green-100 text-green-800",
    blue:  "bg-blue-100 text-blue-800",
    amber: "bg-amber-100 text-amber-800",
    slate: "bg-slate-100 text-slate-800",
  } as const;

  return <span className={`inline-block rounded px-2 py-1 text-xs font-medium ${map[tone]}`}>{label}</span>;
}
```

---

# 6) Actions (view/download/generate) grouped + responsive

```tsx
// src/components/reports/ReportActions.tsx
import { Eye, Download } from "lucide-react";

interface Props {
  isGenerating: boolean;
  isReady: boolean;
  hasFinal?: boolean;
  hasDraft?: boolean;
  onView: () => void;
  onGenerateDraft: () => void;
  onGenerateFinal: () => void;
  onOpenFinal?: () => void;
  onOpenDraft?: () => void;
}

export default function ReportActions({
  isGenerating, isReady, hasFinal, hasDraft,
  onView, onGenerateDraft, onGenerateFinal, onOpenFinal, onOpenDraft
}: Props) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button onClick={onView} className="inline-flex items-center gap-1 text-blue-600 hover:text-blue-700 text-sm">
        <Eye className="h-4 w-4" /> View
      </button>

      {isReady ? (
        hasFinal ? (
          <button
            onClick={onOpenFinal}
            className="inline-flex items-center gap-1 text-green-600 hover:text-green-700 text-sm"
            title="Download final report"
          >
            <Download className="h-4 w-4" /> Download Final
          </button>
        ) : (
          <button
            onClick={onGenerateFinal}
            disabled={isGenerating}
            className={`inline-flex items-center gap-2 text-sm rounded px-2 py-1 ${
              isGenerating
                ? "opacity-50 cursor-not-allowed text-green-600"
                : "text-green-600 hover:text-green-700"
            }`}
            title="Generate final report"
          >
            {isGenerating
              ? (<span className="h-4 w-4 border-b-2 border-green-600 rounded-full animate-spin" />)
              : (<Download className="h-4 w-4" />)}
            {isGenerating ? "Generating…" : "Generate Final"}
          </button>
        )
      ) : (
        <button
          onClick={onGenerateDraft}
          disabled={isGenerating}
          className={`inline-flex items-center gap-2 text-sm rounded px-2 py-1 ${
            isGenerating
              ? "opacity-50 cursor-not-allowed text-amber-600"
              : "text-amber-600 hover:text-amber-700"
          }`}
          title="Generate draft report"
        >
          {isGenerating
            ? (<span className="h-4 w-4 border-b-2 border-amber-600 rounded-full animate-spin" />)
            : (<Download className="h-4 w-4" />)}
          {isGenerating ? "Generating…" : "Generate Draft"}
        </button>
      )}

      {hasDraft && !isGenerating && onOpenDraft && (
        <button
          onClick={onOpenDraft}
          className="inline-flex items-center gap-1 text-blue-600 hover:text-blue-700 text-sm"
          title="Open draft"
        >
          <Download className="h-4 w-4" /> View Draft
        </button>
      )}
    </div>
  );
}
```

---

# 7) Empty state & skeletons

```tsx
// src/components/reports/EmptyState.tsx
import { FileText } from "lucide-react";
export default function EmptyState({ title="No approved results", hint="Try changing filters or refresh." }) {
  return (
    <div className="p-10 text-center text-gray-500">
      <FileText className="mx-auto mb-3 h-10 w-10 text-gray-300" />
      <p className="font-medium">{title}</p>
      <p className="text-sm mt-1">{hint}</p>
    </div>
  );
}
```

```tsx
// src/components/reports/TableSkeleton.tsx
export default function TableSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div className="p-4">
      <div className="animate-pulse space-y-3">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="h-10 rounded bg-gray-100" />
        ))}
      </div>
    </div>
  );
}
```

---

# 8) Orders table (sticky header, zebra, compact)

```tsx
// src/components/reports/OrdersTable.tsx
import ReportStatusPill from "./ReportStatusPill";
import ReportActions from "./ReportActions";
import { format } from "date-fns";

interface ApprovedResultLite {
  has_final_report?: boolean;
  has_draft_report?: boolean;
  final_report?: any;
  draft_report?: any;
}
interface Group {
  order_id: string;
  patient_full_name: string;
  age: number;
  gender: string;
  order_date: string;
  sample_ids: string[];
  verified_by: string;
  verified_at: string;
  test_names: string[];
  is_report_ready?: boolean;
  results: ApprovedResultLite[];
}

interface Props {
  groups: Group[];
  isGenerating: boolean;
  selected: Set<string>;
  onToggleSelect: (orderId: string) => void;
  onView: (orderId: string) => void;
  onGenerateDraft: (orderId: string) => void;
  onGenerateFinal: (orderId: string) => void;
}

export default function OrdersTable({
  groups, isGenerating, selected,
  onToggleSelect, onView, onGenerateDraft, onGenerateFinal
}: Props) {
  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
      <div className="max-h-[65vh] overflow-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 z-10 bg-gray-50">
            <tr className="text-left text-xs uppercase text-gray-500">
              <Th>Order</Th>
              <Th>Patient</Th>
              <Th>Tests</Th>
              <Th>Samples</Th>
              <Th>Order Date</Th>
              <Th>Approved By</Th>
              <Th>Approved At</Th>
              <Th>Report</Th>
              <Th>Actions</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {groups.map((g, idx) => {
              const first = g.results?.[0] as ApprovedResultLite | undefined;
              return (
                <tr key={g.order_id} className={idx % 2 ? "bg-white" : "bg-slate-50/30 hover:bg-slate-50"}>
                  <Td>
                    <label className="inline-flex items-center gap-2">
                      <input
                        type="checkbox"
                        className="rounded"
                        checked={selected.has(g.order_id)}
                        onChange={() => onToggleSelect(g.order_id)}
                      />
                      <span className="font-mono text-[11px] text-gray-500">{g.order_id.slice(0, 8)}…</span>
                    </label>
                  </Td>
                  <Td>
                    <div className="font-medium text-gray-900">{g.patient_full_name}</div>
                    <div className="text-xs text-gray-500">{g.age}y {g.gender}</div>
                  </Td>
                  <Td>
                    <div className="max-w-xs truncate" title={g.test_names.join(", ")}>
                      {g.test_names.join(", ")}
                    </div>
                  </Td>
                  <Td>
                    <div className="truncate max-w-[160px]" title={g.sample_ids.join(", ")}>
                      {g.sample_ids.join(", ")}
                    </div>
                  </Td>
                  <Td>{g.order_date ? format(new Date(g.order_date), "MMM d, yyyy") : "-"}</Td>
                  <Td>{g.verified_by || "-"}</Td>
                  <Td>{g.verified_at ? format(new Date(g.verified_at), "MMM d, yyyy h:mm a") : "-"}</Td>
                  <Td>
                    <ReportStatusPill
                      hasFinal={first?.has_final_report}
                      hasDraft={first?.has_draft_report}
                      isReady={g.is_report_ready}
                    />
                  </Td>
                  <Td>
                    <ReportActions
                      isGenerating={isGenerating}
                      isReady={!!g.is_report_ready}
                      hasFinal={first?.has_final_report}
                      hasDraft={first?.has_draft_report}
                      onView={() => onView(g.order_id)}
                      onGenerateDraft={() => onGenerateDraft(g.order_id)}
                      onGenerateFinal={() => onGenerateFinal(g.order_id)}
                      onOpenFinal={() => {
                        const url = (first as any)?.final_report?.pdf_url;
                        if (url) window.open(url, "_blank");
                      }}
                      onOpenDraft={() => {
                        const url = (first as any)?.draft_report?.pdf_url;
                        if (url) window.open(url, "_blank");
                      }}
                    />
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const Th = ({ children }: { children: React.ReactNode }) => (
  <th className="px-4 py-3 sticky top-0 whitespace-nowrap">{children}</th>
);
const Td = ({ children }: { children: React.ReactNode }) => (
  <td className="px-4 py-3 align-top">{children}</td>
);
```

---

# 9) Integrate in your `Reports.tsx` (only the changed bits)

```tsx
// import the new components at the top
import ReportsHeader from "../components/reports/ReportsHeader";
import ReportsFilters from "../components/reports/ReportsFilters";
import OrdersTable from "../components/reports/OrdersTable";
import EmptyState from "../components/reports/EmptyState";
import TableSkeleton from "../components/reports/TableSkeleton";

// ...inside component:
const finalReadyCount = useMemo(
  () => orderGroups.filter(g => g.is_report_ready && !(g.results[0] as any)?.has_final_report).length,
  [orderGroups]
);
const draftCount = useMemo(
  () => orderGroups.filter(g => (g.results[0] as any)?.has_draft_report).length,
  [orderGroups]
);

// ⚠️ small correctness fix: make "all must be ready" logic actually AND across results
// Replace your current creation of group.is_report_ready with this after the loop for 'r':
// Start each group as true, then AND per result.
const orderGroups: OrderGroup[] = useMemo(() => {
  const map = new Map<string, OrderGroup>();
  for (const r of approvedResults) {
    let group = map.get(r.order_id);
    if (!group) {
      group = {
        order_id: r.order_id,
        patient_id: r.patient_id,
        patient_full_name: r.patient_full_name,
        age: r.age,
        gender: r.gender,
        order_date: r.order_date,
        sample_ids: [r.sample_id],
        verified_at: r.verified_at,
        verified_by: r.verified_by,
        test_names: [r.test_name],
        results: [r],
        is_report_ready: true, // start true, AND per-result below
      };
      map.set(r.order_id, group);
    } else {
      group.results.push(r);
      if (!group.sample_ids.includes(r.sample_id)) group.sample_ids.push(r.sample_id);
      if (!group.test_names.includes(r.test_name)) group.test_names.push(r.test_name);
      if (new Date(r.verified_at) > new Date(group.verified_at)) {
        group.verified_at = r.verified_at;
        group.verified_by = r.verified_by;
      }
    }
    // AND logic
    group.is_report_ready = group.is_report_ready && !!r.is_report_ready;
  }
  return Array.from(map.values()).sort(
    (a, b) => new Date(b.verified_at).getTime() - new Date(a.verified_at).getTime()
  );
}, [approvedResults]);

// ...in JSX:
<div className="min-h-screen bg-gray-50">
  <ReportsHeader
    onRefresh={loadApprovedResults}
    total={orderGroups.length}
    finalReady={finalReadyCount}
    drafts={draftCount}
  />

  <div className="p-6">
    <ReportsFilters
      search={filters.search}
      onSearch={(s) => setFilters({ ...filters, search: s })}
      dateFilter={filters.dateFilter}
      onDateFilter={(d) => setFilters({ ...filters, dateFilter: d })}
      onSelectAll={selectAllOrders}
      onClear={clearSelection}
    />

    {/* Results */}
    {loading ? (
      <TableSkeleton />
    ) : orderGroups.length === 0 ? (
      <EmptyState />
    ) : (
      <OrdersTable
        groups={orderGroups as any}
        isGenerating={isGenerating}
        selected={selectedOrders}
        onToggleSelect={toggleOrderSelection}
        onView={handleView}
        onGenerateDraft={(id) => handleDownload(id, true)}
        onGenerateFinal={(id) => handleDownload(id, false)}
      />
    )}
  </div>

  {/* existing PDF modal unchanged */}
  <PDFProgressModal
    isVisible={isGenerating}
    stage={stage}
    progress={progress}
    onClose={resetState}
  />
</div>
```

---


