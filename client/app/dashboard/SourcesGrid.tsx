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
  onConnectSource,
}: {
  githubConnected: number;
  onConnectGithub: () => void;
  onConnectSource: (key: string) => void;
}) {
  const live = INTEGRATIONS.filter((i) => i.status === "live");
  const connectable = (key: string) =>
    key === "github" ? onConnectGithub : () => onConnectSource(key);
  const soon = INTEGRATIONS.filter((i) => i.status === "coming_soon");

  return (
    <section className="mt-20">
      <div className="flex items-center gap-4">
        <span className="h-px w-10" style={{ background: "var(--l-rust)" }} />
        <span className="text-[11px] tracking-[0.28em] uppercase l-t-muted">Sources</span>
        <span className="h-px flex-1" style={{ background: "var(--l-rule)" }} />
        <span className="text-[11px] tracking-[0.2em] uppercase whitespace-nowrap l-t-muted">
          {live.length} available
        </span>
      </div>

      <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {live.map((i) => {
          const connected = i.key === "github" && githubConnected > 0;
          return (
            <button key={i.key} onClick={connectable(i.key)} className="l-card group p-5 text-left">
              <div className="flex items-center justify-between gap-3">
                <span className="text-[16px]" style={{ color: "var(--l-ink)" }}>
                  {i.name}
                </span>
                <span
                  className="flex items-center gap-2 rounded-full px-2.5 py-1 text-[10px] tracking-[0.16em] uppercase whitespace-nowrap"
                  style={{
                    border: "1px solid var(--l-rule)",
                    color: connected ? "var(--l-rust)" : "var(--l-muted)",
                  }}
                >
                  {connected && <span className="l-dot" style={{ background: "var(--l-rust)" }} />}
                  {connected ? `${githubConnected} connected` : "connect"}
                </span>
              </div>
              <p className="mt-3 text-[13px] leading-relaxed l-t-2">{i.unlocks}</p>
              <p className="mt-3 text-[10px] tracking-[0.16em] uppercase l-t-muted">
                {SCOPE_LABEL[i.scope]}
              </p>
            </button>
          );
        })}

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
      className="rounded-[14px] border border-dashed p-5"
      style={{ borderColor: "var(--l-rule)" }}
      aria-disabled
      title="Not available yet"
    >
      <div className="flex items-center justify-between gap-3">
        <span className="text-[16px] l-t-muted">{integration.name}</span>
        <span className="text-[10px] tracking-[0.16em] uppercase l-t-muted">soon</span>
      </div>
      <p className="mt-3 text-[13px] leading-relaxed l-t-muted">{integration.unlocks}</p>
      <p className="mt-3 text-[10px] tracking-[0.16em] uppercase l-t-muted">
        will be {SCOPE_LABEL[integration.scope]}
      </p>
    </div>
  );
}
