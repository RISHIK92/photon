"use client";

import { useEffect, useState } from "react";
import { GITHUB_STATE_LABEL, getGithubStatus, type GithubStatus } from "@/lib/api";
import { INTEGRATIONS, SCOPE_LABEL, type Integration } from "@/lib/integrations";

/** What the agent can draw on, and what it will be able to.
 *
 * The unbuilt ones are shown for a reason beyond roadmap theatre: the value
 * of this product is the union of its sources, and a dashboard listing one
 * source makes it look like a code search tool. Each entry says what it
 * unlocks as an answer nobody could get today.
 *
 * Rules rather than cards, and the scope stated ONCE rather than on every
 * tile: every live source is workspace-scoped, so repeating that seven times
 * was seven lines of noise hiding the one place it differs — the mailboxes,
 * which are private to the person who connects them. That distinction is the
 * whole reason scope is surfaced at all, and it reads better when it is the
 * only scope label on the screen.
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
  // GitHub's label comes from the shared status rather than a local count,
  // so the card, the dialog and the call setup screen all say the same
  // thing about whether it is connected.
  const [github, setGithub] = useState<GithubStatus | null>(null);
  useEffect(() => {
    getGithubStatus().then(setGithub).catch(() => setGithub(null));
  }, [githubConnected]);

  const live = INTEGRATIONS.filter((i) => i.status === "live");
  const soon = INTEGRATIONS.filter((i) => i.status === "coming_soon");
  const connectable = (key: string) =>
    key === "github" ? onConnectGithub : () => onConnectSource(key);

  return (
    <section className="mt-20">
      <div className="flex items-center gap-4">
        <span className="h-px w-10" style={{ background: "var(--l-rust)" }} />
        <span className="text-[11px] tracking-[0.28em] uppercase l-t-muted">Sources</span>
        <span className="h-px flex-1" style={{ background: "var(--l-rule)" }} />
        <span className="text-[11px] tracking-[0.2em] whitespace-nowrap uppercase l-t-muted">
          {live.length} available
        </span>
      </div>

      <p className="mt-5 max-w-xl text-[13px] leading-relaxed l-t-muted">
        Everything connected here is {SCOPE_LABEL.workspace} — anyone in it can get answers
        from it. Read-only, and scoped to what you select.
      </p>

      <div className="mt-6 grid gap-x-10 md:grid-cols-2 xl:grid-cols-3">
        {live.map((i) => {
          const connected = i.key === "github" && githubConnected > 0;
          return (
            <button
              key={i.key}
              onClick={connectable(i.key)}
              className="l-row group relative block w-full border-t py-4 text-left"
              style={{ borderColor: "var(--l-rule)" }}
            >
              <span className="l-row-rule" style={{ background: "var(--l-rust)" }} />
              <span className="flex items-baseline justify-between gap-3">
                <span className="text-[15px]" style={{ color: "var(--l-ink)" }}>
                  {i.name}
                </span>
                <span
                  className="flex shrink-0 items-center gap-1.5 text-[10px] tracking-[0.16em] whitespace-nowrap uppercase"
                  style={{ color: connected ? "var(--l-rust)" : "var(--l-muted)" }}
                >
                  {connected && <span className="l-dot" style={{ background: "var(--l-rust)" }} />}
                  {connected ? `${githubConnected} connected` : "connect"}
                </span>
              </span>
              <span className="mt-1.5 block text-[13px] leading-snug l-t-2">{i.unlocks}</span>
            </button>
          );
        })}
      </div>

      <div className="mt-12 flex items-center gap-4">
        <span className="text-[10px] tracking-[0.24em] whitespace-nowrap uppercase l-t-muted">
          Coming soon
        </span>
        <span className="h-px flex-1" style={{ background: "var(--l-rule)" }} />
      </div>

      <div className="mt-4 grid gap-x-10 md:grid-cols-2 xl:grid-cols-3">
        {soon.map((i) => (
          <Soon key={i.key} integration={i} />
        ))}
      </div>
    </section>
  );
}

function Soon({ integration }: { integration: Integration }) {
  return (
    <div className="border-t border-dashed py-3.5" style={{ borderColor: "var(--l-rule)" }}>
      <p className="text-[14px] l-t-2">
        {integration.name}
        {/* the only place scope differs from the workspace default, which is
            exactly why it is worth saying here and nowhere else */}
        {integration.scope === "individual" && (
          <span className="ml-2 text-[10px] tracking-[0.16em] uppercase" style={{ color: "var(--l-terra)" }}>
            {SCOPE_LABEL.individual}
          </span>
        )}
      </p>
      <p className="mt-1 text-[12px] leading-snug l-t-muted">{integration.unlocks}</p>
    </div>
  );
}
