"use client";

import { buildEvidenceMap, type Evidence } from "@/lib/evidence";
import CodeSnippet from "./CodeSnippet";
import type { AgentAnswer } from "@/lib/evidence";

/** Every piece of code the agent has cited this call, in one place.
 *
 * Read-only on purpose: this is what the answers were grounded in, not a
 * scratchpad. Deduplicated by locator, because the same file gets cited
 * across several turns and a stack of identical snippets is not a record. */
export default function CodePanel({ turns }: { turns: { result?: AgentAnswer }[] }) {
  const byLocator = new Map<string, Evidence>();
  for (const turn of turns) {
    if (!turn.result) continue;
    for (const ev of buildEvidenceMap(turn.result.tool_trace).values()) {
      if (ev.source_type === "code" && !byLocator.has(ev.locator)) byLocator.set(ev.locator, ev);
    }
  }
  const snippets = [...byLocator.values()];

  return (
    <div className="h-full overflow-y-auto px-5 py-4">
      {snippets.length === 0 ? (
        <p className="mt-6 text-[13px] leading-relaxed l-t-muted">
          No code cited yet. Ask something about the codebase and whatever the answer was
          grounded in appears here, with the real line numbers from the file — so someone can
          say “line 47” and everyone lands in the same place.
        </p>
      ) : (
        <ul className="space-y-5">
          {snippets.map((ev) => (
            <li key={ev.locator}>
              <CodeSnippet locator={ev.locator} code={ev.snippet} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
