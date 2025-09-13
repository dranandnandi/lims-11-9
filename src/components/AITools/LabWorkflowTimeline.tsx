// File: src/components/AI/LabWorkflowTimeline.tsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Microscope,
  TestTube2,
  Camera,
  Brain,
  ClipboardCheck,
  Pipette,
  FileText,
  CheckCircle2,
  XCircle,
  Circle,
  CircleDot,
  ChevronDown,
} from "lucide-react";

export type StepPhase = "idle" | "running" | "done" | "error";

export type LabStep = {
  id: "prep" | "attach" | "vision" | "nlp" | "match" | "fill" | "final";
  label: string;                // e.g. "Prep"
  status: string;               // e.g. "Sample received"
  phase: StepPhase;             // idle | running | done | error
  timestamp?: string;           // ISO string; will render [HH:MM:SS]
  detail?: string;              // optional expandable detail snippet
};

type Props = {
  steps: LabStep[];
  compact?: boolean;            // compact mode: show only rows, no detail chevrons
  autoscroll?: boolean;         // default true (scroll to latest)
};

const iconById: Record<LabStep["id"], React.ComponentType<any>> = {
  prep: Microscope,
  attach: TestTube2,
  vision: Camera,
  nlp: Brain,
  match: ClipboardCheck,
  fill: Pipette,
  final: FileText,
};

const phaseColor = (p: StepPhase) =>
  ({
    idle: "text-slate-400",
    running: "text-sky-300",
    done: "text-green-300",
    error: "text-red-300",
  }[p]);

const dotStyle = (p: StepPhase) =>
  ({
    idle: "bg-slate-700 border-slate-600",
    running: "bg-sky-400 border-sky-300 animate-pulse",
    done: "bg-green-400 border-green-300",
    error: "bg-red-400 border-red-300",
  }[p]);

const statusIcon = (p: StepPhase) =>
  p === "done" ? CheckCircle2 : p === "error" ? XCircle : p === "running" ? CircleDot : Circle;

const tsFmt = (iso?: string) => {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

const LabWorkflowTimeline: React.FC<Props> = ({ steps, compact = false, autoscroll = true }) => {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const wrapRef = useRef<HTMLDivElement>(null);

  // keep latest visible
  useEffect(() => {
    if (!autoscroll || !wrapRef.current) return;
    wrapRef.current.scrollTop = wrapRef.current.scrollHeight;
  }, [steps, autoscroll]);

  const rendered = useMemo(
    () =>
      steps.map((s, i) => {
        const Icon = iconById[s.id];
        const StatIcon = statusIcon(s.phase);
        const color = phaseColor(s.phase);
        const dot = dotStyle(s.phase);
        const key = `${s.id}-${i}`;
        const showDetail = !!s.detail && open[key];

        return (
          <div key={key} className="relative pl-8">
            {/* vertical line */}
            {i !== steps.length - 1 && (
              <div className="absolute left-3 top-7 bottom-0 w-px bg-slate-700/60" />
            )}

            {/* dot */}
            <div className={`absolute left-1.5 top-2 h-3.5 w-3.5 rounded-full border ${dot}`} />

            {/* row */}
            <div
              className={`rounded-md px-2.5 py-2 transition-colors ${showDetail ? "bg-slate-800/70" : "hover:bg-slate-800/40"}`}
            >
              <div className="flex items-start gap-2">
                <div className={`mt-0.5 ${color}`}>
                  <Icon className="h-4 w-4" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-mono text-slate-400">[{tsFmt(s.timestamp)}]</span>
                    <span className="text-sm font-semibold text-slate-100">{s.label}</span>
                    <span className={`inline-flex items-center gap-1 text-xs ${color}`}>
                      <StatIcon className="h-3.5 w-3.5" />
                      {s.phase === "idle"
                        ? "Waiting"
                        : s.phase === "running"
                        ? "Running"
                        : s.phase === "done"
                        ? "Done"
                        : "Error"}
                    </span>
                  </div>
                  <div className="text-sm text-slate-300/90 truncate">{s.status}</div>
                </div>

                {/* expander */}
                {!compact && s.detail && (
                  <button
                    onClick={() => setOpen((prev) => ({ ...prev, [key]: !prev[key] }))}
                    className="ml-2 text-slate-300/80 hover:text-white transition"
                    aria-label="Toggle details"
                  >
                    <ChevronDown
                      className={`h-4 w-4 transition-transform ${showDetail ? "rotate-180" : ""}`}
                    />
                  </button>
                )}
              </div>

              {/* details */}
              {!compact && showDetail && (
                <div className="mt-2 rounded-md border border-slate-700 bg-slate-900/80 p-3">
                  <pre className="whitespace-pre-wrap break-words text-xs text-slate-200/90">
                    {s.detail}
                  </pre>
                </div>
              )}
            </div>
          </div>
        );
      }),
    [steps, open]
  );

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900 text-slate-100">
      <div className="px-3 py-2 border-b border-slate-700">
        <div className="text-xs uppercase tracking-wide text-slate-400">Lab Workflow Tracker</div>
      </div>
      <div ref={wrapRef} className="max-h-56 overflow-auto px-3 py-2 space-y-2">
        {steps.length ? rendered : (
          <div className="text-xs text-slate-400 px-1 py-2">No activity yet. Start processing to see the specimen journey.</div>
        )}
      </div>
    </div>
  );
};

export default LabWorkflowTimeline;
