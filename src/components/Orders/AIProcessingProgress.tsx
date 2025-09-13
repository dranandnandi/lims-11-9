import React from "react";
import { CheckCircle2, AlertTriangle, Loader2, FileText, Brain, Wand2 } from "lucide-react";
import LabWorkflowTimeline, { LabStep } from "../AITools/LabWorkflowTimeline";

export type StepKey = "upload" | "ocr" | "nlp" | "match" | "fill" | "done";
export type StepState = "idle" | "running" | "ok" | "warn" | "err";

export type AIStep = {
  key: StepKey;
  label: string;
  desc: string;
  state: StepState;
  meta?: Record<string, any>;
};

type AIUiMode = "legacy" | "timeline";

interface AIProcessingProgressProps {
  steps: AIStep[];
  logs: string[];
  rightPanel?: React.ReactNode;
  mode?: AIUiMode;          // <— optional toggle, default 'legacy'
  timelineSteps?: LabStep[];        // <— timeline steps to render
  progress?: number;        // <— progress percentage for timeline mode
  onProcessClick?: () => void;      // <— process button handler
  canProcess?: boolean;     // <— whether process button is enabled
}

export function percentFromSteps(steps: AIStep[]) {
  const weights: Record<StepKey, number> = { upload: 5, ocr: 30, nlp: 30, match: 20, fill: 10, done: 5 };
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  const earned = steps.reduce((sum, s) => sum + (["ok", "warn"].includes(s.state) ? weights[s.key] : 0), 0);
  return Math.round((earned / total) * 100);
}

const iconFor = (k: StepKey, state: StepState) => {
  const base = "h-4 w-4";
  if (state === "running") return <Loader2 className={`${base} animate-spin text-blue-600`} />;
  if (state === "ok") return <CheckCircle2 className={`${base} text-green-600`} />;
  if (state === "warn") return <AlertTriangle className={`${base} text-amber-600`} />;
  if (state === "err") return <AlertTriangle className={`${base} text-red-600`} />;
  switch (k) {
    case "upload": return <FileText className={`${base} text-gray-500`} />;
    case "ocr": return <Wand2 className={`${base} text-gray-500`} />;
    case "nlp": return <Brain className={`${base} text-gray-500`} />;
    default: return <FileText className={`${base} text-gray-500`} />;
  }
};

const statePill = (s: StepState) => {
  const map: Record<StepState, string> = {
    idle: "bg-gray-100 text-gray-700",
    running: "bg-blue-100 text-blue-700",
    ok: "bg-green-100 text-green-700",
    warn: "bg-amber-100 text-amber-700",
    err: "bg-red-100 text-red-700",
  };
  return map[s] || map.idle;
};

export default function AIProcessingProgress(props: AIProcessingProgressProps) {
  const uiMode: AIUiMode = props.mode ?? "legacy";

  if (uiMode === "timeline") {
    return (
      <div className="space-y-3">
        {/* small header + progress from your existing props if you have them */}
        {typeof props.progress === "number" && (
          <div className="rounded-md border border-slate-200 p-3">
            <div className="flex items-center justify-between text-sm text-slate-600 mb-1">
              <span>AI Processing</span>
              <span>{Math.round(props.progress)}%</span>
            </div>
            <div className="h-2 w-full bg-slate-200 rounded-full overflow-hidden">
              <div
                className="h-2 bg-blue-600 transition-all"
                style={{ width: `${Math.round(props.progress)}%` }}
              />
            </div>
          </div>
        )}

        {/* NEW: lab timeline */}
        <LabWorkflowTimeline steps={props.timelineSteps || []} />

        {/* your existing "Process with AI" trigger */}
        {props.onProcessClick && (
          <div className="pt-1">
            <button
              onClick={props.onProcessClick}
              disabled={!props.canProcess}
              className="w-full inline-flex items-center justify-center px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-300"
            >
              Process with AI
            </button>
          </div>
        )}
      </div>
    );
  }

  // fallback: render your current (legacy) UI unchanged
  const { steps, logs, rightPanel } = props;
  const pct = percentFromSteps(steps);
  
  return (
    <div className="border border-purple-200 rounded-lg overflow-hidden">
      {/* Header with progress */}
      <div className="bg-gradient-to-r from-purple-50 to-blue-50 p-3 border-b border-purple-200">
        <div className="flex items-center gap-3">
          <div className="flex-1">
            <div className="flex items-center justify-between text-sm text-purple-900">
              <span className="font-medium">AI Processing</span>
              <span className="font-semibold">{pct}%</span>
            </div>
            <div className="w-full bg-purple-100 rounded-full h-2 mt-1">
              <div className="h-2 rounded-full bg-purple-500" style={{ width: `${pct}%` }} />
            </div>
          </div>
          {rightPanel}
        </div>
      </div>

      {/* Body: steps + logs */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-0">
        {/* Steps */}
        <div className="md:col-span-2 p-3">
          <ol className="space-y-3">
            {steps.map((s) => (
              <li key={s.key} className="flex items-start gap-3">
                <div className="mt-0.5">{iconFor(s.key, s.state)}</div>
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <div className="font-medium text-gray-900">{s.label}</div>
                    <span className={`px-2 py-0.5 rounded-full text-xs ${statePill(s.state)}`}>
                      {s.state === "idle" ? "waiting" :
                       s.state === "running" ? "processing…" :
                       s.state === "ok" ? "done" :
                       s.state === "warn" ? "partial" : "error"}
                    </span>
                  </div>
                  <div className="text-sm text-gray-600">{s.desc}</div>
                  {/* tasteful, non-sensitive meta */}
                  {s.meta && (
                    <div className="mt-1 text-xs text-gray-500">
                      {Object.entries(s.meta).slice(0, 3).map(([k, v]) => (
                        <span key={k} className="mr-3">
                          <span className="font-medium">{k}:</span> {String(v)}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </div>

        {/* Logs (read-only, subtle) */}
        <div className="border-t md:border-t-0 md:border-l border-gray-200 bg-gray-50 p-3">
          <div className="text-xs font-medium text-gray-700 mb-2">Activity</div>
          <div className="h-40 overflow-auto text-xs leading-5">
            {logs.length === 0 ? (
              <div className="text-gray-400">No messages yet…</div>
            ) : (
              logs.map((l, i) => (
                <div key={i} className="text-gray-700">
                  {l}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
