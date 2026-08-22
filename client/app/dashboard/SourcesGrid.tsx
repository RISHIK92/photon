"use client";

import { INTEGRATIONS, SCOPE_LABEL, type Integration } from "@/lib/integrations";

/** What the agent can draw on, and what it will be able to.
 *
 * The unbuilt ones are shown for a reason beyond roadmap theatre: the value
 * of this product is the union of its sources, and a dashboard listing one
 * source makes it look like a code search tool. Each entry says what it
 * unlocks as an answer nobody could get today, and whether it would be
 * shared or private — the distinction people need to understand BEFORE
 * connecting a mailbox.
 */
export default function SourcesGrid({
  githubConnected,
  onConnectGithub,
}: {
  githubConnected: number;
  onConnectGithub: () => void;
}) {
  const live = INTEGRATIONS.filter((i) => i.status === "live");
  const soon = INTEGRATIONS.filter((i) => i.status === "coming_soon");

  return (
    <section className="mb-8">
      <h2 className="text-sm uppercase tracking-wide text-neutral-500 mb-2">Sources</h2>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {live.map((i) => (
          <button
            key={i.key}
            onClick={onConnectGithub}
            className="text-left border border-emerald-700/60 bg-emerald-500/5 rounded p-3 hover:bg-emerald-500/10 transition-colors"
          >
            <div className="flex items-center justify-between">
              <span className="text-sm text-neutral-100">{i.name}</span>
              <span className="text-[10px] text-emerald-300 border border-emerald-600/50 rounded px-1.5 py-0.5">
                {githubConnected > 0
                  ? `${githubConnected} connected`
                  : "connect"}
              </span>
            </div>
            <p className="text-xs text-neutral-400 mt-1">{i.unlocks}</p>
            <p className="text-[10px] text-neutral-600 mt-1">{SCOPE_LABEL[i.scope]}</p>
          </button>
        ))}

        {soon.map((i) => (
          <ComingSoon key={i.key} integration={i} />
        ))}
      </div>
    </section>
  );
}

function ComingSoon({ integration }: { integration: Integration }) {
  return (
    <div
      className="border border-neutral-800 rounded p-3 opacity-70"
      aria-disabled
      title="Not available yet"
    >
      <div className="flex items-center justify-between">
        <span className="text-sm text-neutral-300">{integration.name}</span>
        <span className="text-[10px] text-neutral-500 border border-neutral-700 rounded px-1.5 py-0.5">
          soon
        </span>
      </div>
      <p className="text-xs text-neutral-500 mt-1">{integration.unlocks}</p>
      <p className="text-[10px] text-neutral-600 mt-1">
        will be {SCOPE_LABEL[integration.scope]}
      </p>
    </div>
  );
}
