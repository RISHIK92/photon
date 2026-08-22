"use client";

import { useEffect, useState } from "react";
import { getCallOptions, type CallSource } from "@/lib/api";

/** The idle state of the evidence panel: what this workspace can actually
 * answer from.
 *
 * This replaced a panel that listed the demo corpus's fictional accounts.
 * Showing invented customers to a real user is worse than showing nothing —
 * it implies the agent knows about them, and the first question asked will
 * be about a company that does not exist.
 */
export default function WorkspaceSummary() {
  const [sources, setSources] = useState<CallSource[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getCallOptions()
      .then((o) => setSources(o.sources.filter((s) => s.available)))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  if (error) return <p className="text-sm text-red-400">{error}</p>;
  if (!sources) return <p className="text-sm text-neutral-600">Loading sources…</p>;

  if (sources.length === 0) {
    return (
      <div className="text-sm">
        <p className="text-neutral-300">Nothing connected yet.</p>
        <p className="text-neutral-500 mt-1">
          The agent answers only from sources you connect — a repository, an uploaded document,
          Slack, Jira. Until then it has nothing to draw on and will say so rather than guess.
        </p>
        <a href="/dashboard" className="inline-block mt-3 text-indigo-400 hover:text-indigo-300">
          Connect a source →
        </a>
      </div>
    );
  }

  return (
    <div>
      <h2 className="text-xs uppercase tracking-wide text-neutral-500 mb-2">
        What this agent can answer from
      </h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {sources.map((s) => (
          <div key={s.key} className="border border-neutral-800 rounded p-2.5">
            <p className="text-sm text-neutral-200">{s.label}</p>
            <p className="text-xs text-neutral-500">{s.detail}</p>
          </div>
        ))}
      </div>
      <p className="text-xs text-neutral-600 mt-3">
        Ask a question by voice (press Ask Photon) or type it below. Every answer cites the
        evidence it came from.
      </p>
    </div>
  );
}
