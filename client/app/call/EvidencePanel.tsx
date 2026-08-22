"use client";

import { useMemo, useRef, useState } from "react";
import CodeSnippet from "./CodeSnippet";
import {
  AgentAnswer,
  CITATION_RE,
  Evidence,
  SOURCE_ICON,
  buildEvidenceMap,
  findProvenanceChain,
} from "@/lib/evidence";

type Turn = { role: "user" | "agent"; question?: string; result?: AgentAnswer };

const CONFIDENCE_COLOR: Record<string, string> = {
  high: "text-emerald-400",
  medium: "text-amber-400",
  low: "text-red-400",
};

function AnswerText({
  text,
  evidenceMap,
  onCite,
}: {
  text: string;
  evidenceMap: Map<string, Evidence>;
  onCite: (id: string) => void;
}) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  const re = new RegExp(CITATION_RE);
  let key = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(<span key={key++}>{text.slice(last, m.index)}</span>);
    const id = m[1];
    const known = evidenceMap.has(id);
    parts.push(
      <button
        key={key++}
        onClick={() => known && onCite(id)}
        className={`inline-flex items-center rounded px-1.5 py-0.5 mx-0.5 text-xs font-mono align-middle ${
          known
            ? "bg-indigo-900/60 text-indigo-300 hover:bg-indigo-800 cursor-pointer"
            : "bg-red-900/60 text-red-300 cursor-not-allowed"
        }`}
        title={known ? evidenceMap.get(id)!.locator : "unresolved citation"}
      >
        {known ? (evidenceMap.get(id)!.source_type === "code" ? "💻" : SOURCE_ICON[evidenceMap.get(id)!.source_type]) : "⚠️"}
      </button>
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(<span key={key++}>{text.slice(last)}</span>);
  return <p className="leading-relaxed">{parts}</p>;
}

function EvidenceCard({
  ev,
  highlighted,
  cardRef,
}: {
  ev: Evidence;
  highlighted: boolean;
  cardRef: (el: HTMLDivElement | null) => void;
}) {
  return (
    <div
      ref={cardRef}
      className={`border rounded-lg p-3 text-sm transition-colors ${
        highlighted ? "border-indigo-500 bg-indigo-950/40" : "border-neutral-800 bg-neutral-900"
      }`}
    >
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-mono text-neutral-500">
          {SOURCE_ICON[ev.source_type]} {ev.source_type}
        </span>
        <span className="text-xs text-neutral-600">score {ev.score.toFixed(2)}</span>
      </div>
      {ev.source_type === "code" ? (
        // Code gets real line numbers and highlighting; prose does not need
        // either, and a monospace block would make a Slack message harder
        // to read rather than easier.
        <CodeSnippet locator={ev.locator} code={ev.snippet} />
      ) : (
        <>
          <div className="font-mono text-xs text-neutral-400 mb-1 break-all">{ev.locator}</div>
          <pre className="text-xs text-neutral-300 whitespace-pre-wrap break-words max-h-32 overflow-y-auto">
            {ev.snippet}
          </pre>
        </>
      )}
    </div>
  );
}

function ProvenanceStrip({ chain }: { chain: Evidence[] }) {
  return (
    <div className="mb-4">
      <h3 className="text-xs uppercase tracking-wide text-neutral-500 mb-2">
        Provenance — why this exists
      </h3>
      <div className="flex items-center gap-2 overflow-x-auto pb-2">
        {chain.map((ev, i) => (
          <div key={ev.id} className="flex items-center gap-2 shrink-0">
            <div className="border border-neutral-700 bg-neutral-900 rounded-lg px-3 py-2 max-w-[220px]">
              <div className="text-xs font-mono text-neutral-500 mb-0.5">
                {SOURCE_ICON[ev.source_type]} {ev.source_type}
              </div>
              <div className="text-xs text-neutral-300 truncate">{ev.locator}</div>
            </div>
            {i < chain.length - 1 && <span className="text-neutral-600">→</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function EvidencePanel({ turns }: { turns: Turn[] }) {
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const latest = [...turns].reverse().find((t) => t.role === "agent" && t.result);
  const evidenceMap = useMemo(
    () => (latest?.result ? buildEvidenceMap(latest.result.tool_trace) : new Map()),
    [latest]
  );
  const provenanceChain = useMemo(
    () => (latest?.result ? findProvenanceChain(latest.result.tool_trace) : null),
    [latest]
  );

  const scrollToEvidence = (id: string) => {
    setHighlightedId(id);
    cardRefs.current.get(id)?.scrollIntoView({ behavior: "smooth", block: "center" });
    window.setTimeout(() => setHighlightedId((cur) => (cur === id ? null : cur)), 2000);
  };

  return (
    <div className="flex flex-col gap-4 h-full">
      <div className="flex-1 overflow-y-auto space-y-4 min-h-0">
        {turns.map((t, i) =>
          t.role === "user" ? (
            <div key={i} className="text-neutral-200 text-sm">
              <span className="text-xs uppercase tracking-wide text-neutral-500 mr-2">you</span>
              {t.question}
            </div>
          ) : (
            <div key={i} className="border border-neutral-800 rounded-lg p-3 bg-neutral-900/50">
              {t.result ? (
                <>
                  <AnswerText
                    text={t.result.answer}
                    evidenceMap={buildEvidenceMap(t.result.tool_trace)}
                    onCite={scrollToEvidence}
                  />
                  <div className="flex items-center gap-3 mt-2 text-xs">
                    <span className={CONFIDENCE_COLOR[t.result.confidence]}>
                      confidence: {t.result.confidence}
                    </span>
                    {t.result.abstained && <span className="text-amber-400">abstained</span>}
                    {t.result.escalation && (
                      <span className="text-neutral-500">→ {t.result.escalation}</span>
                    )}
                  </div>
                  {t.result.tool_trace.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mt-2">
                      {t.result.tool_trace.map((tr, j) => (
                        <span
                          key={j}
                          className="text-[10px] font-mono bg-neutral-800 text-neutral-400 rounded px-1.5 py-0.5"
                        >
                          {tr.tool} · {tr.ms}ms
                        </span>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <span className="text-neutral-500 text-sm animate-pulse">thinking…</span>
              )}
            </div>
          )
        )}
      </div>

      {latest?.result && evidenceMap.size > 0 && (
        <div className="border-t border-neutral-800 pt-4 max-h-[45%] overflow-y-auto shrink-0">
          {provenanceChain && <ProvenanceStrip chain={provenanceChain} />}
          <h3 className="text-xs uppercase tracking-wide text-neutral-500 mb-2">
            Evidence ({evidenceMap.size})
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {[...evidenceMap.values()].map((ev) => (
              <EvidenceCard
                key={ev.id}
                ev={ev}
                highlighted={highlightedId === ev.id}
                cardRef={(el) => {
                  if (el) cardRefs.current.set(ev.id, el);
                }}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}