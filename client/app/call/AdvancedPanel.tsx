"use client";

import { useEffect, useState } from "react";
import { fmtMs, turnTotals, type Stage, type ToolCall, type TurnTrace } from "@/lib/trace";

/** The "advanced" view that sits beside the transcript: what the agent is
 * doing internally, right now — stage by stage, tool by tool, with real
 * latencies. Everything here comes from live events (lib/trace.ts); nothing
 * is estimated or interpolated on the client. */
export default function AdvancedPanel({ turns }: { turns: TurnTrace[] }) {
  const current = turns[turns.length - 1];
  const older = turns.slice(0, -1).reverse();

  return (
    <div className="flex flex-col min-h-0">
      <div className="flex items-center justify-between mb-1 shrink-0">
        <h2 className="text-xs uppercase tracking-wide text-neutral-500">Advanced · agent pipeline</h2>
        {current && <LiveClock turn={current} />}
      </div>

      <div className="bg-neutral-900 border border-neutral-800 rounded p-3 h-36 overflow-y-auto text-xs">
        {!current ? (
          <p className="text-neutral-600">
            Idle. Ask a question by voice or text and every plan, tool call and LLM hop shows up here as it
            happens.
          </p>
        ) : (
          <TurnView turn={current} />
        )}
        {older.length > 0 && (
          <div className="mt-3 pt-2 border-t border-neutral-800 space-y-1">
            {older.map((t) => (
              <PreviousTurn key={t.id} turn={t} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Ticks while a turn is in flight so latency is visible as it accrues,
 * not only once the turn is over. Freezes on the server-reported total the
 * moment the turn ends — the server's number is the authoritative one
 * (it excludes network and render time). */
function LiveClock({ turn }: { turn: TurnTrace }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (turn.status !== "running") return;
    const handle = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(handle);
  }, [turn.status, turn.id]);

  const elapsed = turn.totalMs ?? now - turn.startedAt;
  const running = turn.status === "running";

  return (
    <div className="flex items-center gap-2">
      <span
        className={`text-[10px] px-1.5 py-0.5 rounded border ${
          turn.source === "voice"
            ? "border-emerald-600/50 text-emerald-300"
            : "border-sky-600/50 text-sky-300"
        }`}
      >
        {turn.source}
      </span>
      <span
        className={`font-mono text-[11px] tabular-nums ${running ? "text-amber-300" : "text-neutral-300"}`}
      >
        {running && <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse mr-1" />}
        {fmtMs(elapsed)}
      </span>
    </div>
  );
}

function TurnView({ turn }: { turn: TurnTrace }) {
  const totals = turnTotals(turn);
  // Bars are scaled against the slowest step in THIS turn, so one 9s
  // compose doesn't flatten every tool call into an invisible sliver.
  const slowest = Math.max(
    1,
    ...turn.stages.map((s) => s.ms ?? 0),
    ...turn.tools.map((c) => c.ms ?? 0)
  );

  const rows: { stage: Stage; tools: ToolCall[] }[] = turn.stages.map((stage) => ({
    stage,
    // Tool calls hang off the plan round that chose them.
    tools: stage.key.startsWith("plan-")
      ? turn.tools.filter((c) => `plan-${c.round}` === stage.key)
      : [],
  }));

  return (
    <div className="space-y-1.5">
      <p className="text-neutral-400 truncate" title={turn.question}>
        {turn.question ? `“${turn.question}”` : "…"}
      </p>

      {rows.map(({ stage, tools }) => (
        <div key={stage.key}>
          <Row
            label={stage.label}
            detail={stage.detail}
            ms={stage.ms}
            state={stage.state}
            slowest={slowest}
            marker={stage.marker}
          />
          {tools.map((call) => (
            <div key={call.id} className="ml-3 border-l border-neutral-800 pl-2">
              <Row
                label={call.tool}
                mono
                detail={[
                  argsSummary(call.args),
                  call.evidenceCount !== undefined ? `${call.evidenceCount} evidence` : undefined,
                  call.note || undefined,
                ]
                  .filter(Boolean)
                  .join(" · ")}
                ms={call.ms}
                state={call.ms === undefined ? "running" : call.status === "error" ? "failed" : "done"}
                slowest={slowest}
              />
            </div>
          ))}
        </div>
      ))}

      {turn.error && <p className="text-red-400">error: {turn.error}</p>}

      {turn.status !== "running" && (
        <p className="text-[10px] text-neutral-500 pt-1 border-t border-neutral-800">
          total {fmtMs(turn.totalMs ?? 0)} · {totals.toolCount} tool call
          {totals.toolCount === 1 ? "" : "s"} {fmtMs(totals.toolMs)} · llm {fmtMs(totals.llmMs)}
          {turn.confidence && ` · confidence ${turn.confidence}`}
          {turn.abstained && " · abstained"}
        </p>
      )}
    </div>
  );
}

function Row({
  label,
  detail,
  ms,
  state,
  slowest,
  mono,
  marker,
}: {
  label: string;
  detail?: string;
  ms?: number;
  state: "running" | "done" | "failed";
  slowest: number;
  mono?: boolean;
  marker?: boolean;
}) {
  const color =
    state === "running" ? "bg-amber-400" : state === "failed" ? "bg-red-500" : "bg-indigo-400";
  const width = marker || ms === undefined ? 0 : Math.max(2, ((ms ?? 0) / slowest) * 100);

  return (
    <div className="flex items-baseline gap-2 py-0.5">
      <span
        className={`shrink-0 w-1.5 h-1.5 rounded-full ${color} ${state === "running" ? "animate-pulse" : ""}`}
      />
      <span className={`shrink-0 ${mono ? "font-mono text-indigo-200" : "text-neutral-200"}`}>{label}</span>
      {detail && <span className="text-neutral-500 truncate">{detail}</span>}
      <span className="flex-1 min-w-[12px] h-1 relative">
        {width > 0 && (
          <span
            className={`absolute inset-y-0 left-0 rounded-sm ${color} opacity-40`}
            style={{ width: `${width}%` }}
          />
        )}
      </span>
      <span className="shrink-0 font-mono tabular-nums text-neutral-400 text-[11px]">
        {state === "running" ? "running…" : ms !== undefined && !marker ? fmtMs(ms) : ""}
      </span>
    </div>
  );
}

function PreviousTurn({ turn }: { turn: TurnTrace }) {
  const totals = turnTotals(turn);
  return (
    <p className="text-[10px] text-neutral-600 truncate">
      {fmtMs(turn.totalMs ?? 0)} · {totals.toolCount} tool{totals.toolCount === 1 ? "" : "s"} ·{" "}
      {turn.abstained ? "abstained" : turn.confidence ?? turn.status} — {turn.question}
    </p>
  );
}

function argsSummary(args: Record<string, unknown>): string | undefined {
  const parts = Object.entries(args)
    // repo_id is forced by the loop on every repo-scoped tool and is a
    // long UUID — it's noise in a one-line summary.
    .filter(([k]) => k !== "repo_id")
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`);
  if (parts.length === 0) return undefined;
  const joined = parts.join(", ");
  return joined.length > 60 ? `${joined.slice(0, 57)}…` : joined;
}
