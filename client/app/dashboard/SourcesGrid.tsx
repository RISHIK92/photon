"use client";

import { useEffect, useState } from "react";
import {
  GITHUB_STATE_LABEL,
  disableMock,
  enableMock,
  getGithubStatus,
  getMockStatus,
  type GithubStatus,
  type MockProvider,
} from "@/lib/api";
import { INTEGRATIONS, SCOPE_LABEL, type Integration } from "@/lib/integrations";

const MOCK_PROVIDERS = new Set<string>(["github", "slack", "jira", "linear", "notion", "datadog"]);

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
  canConnect = true,
  canUseMock = true,
}: {
  githubConnected: number;
  onConnectGithub: () => void;
  onConnectSource: (key: string) => void;
  /** Connecting a source is OWNER-only server-side (require_role(OWNER) in
   * routers/connectors.py, github_app.py, jira.py, slack.py) — false disables
   * the tiles instead of letting a viewer/member click into a 403. */
  canConnect?: boolean;
  /** Enabling mock data is MEMBER-level server-side (routers/mock.py),
   * same as adding a repo — false disables the "try with mock data" links. */
  canUseMock?: boolean;
}) {
  // GitHub's label comes from the shared status rather than a local count,
  // so the card, the dialog and the call setup screen all say the same
  // thing about whether it is connected.
  const [github, setGithub] = useState<GithubStatus | null>(null);
  useEffect(() => {
    getGithubStatus().then(setGithub).catch(() => setGithub(null));
  }, [githubConnected]);

  // Which providers already have fictional [MOCK] data for this workspace
  // (server/app/routers/mock.py) — a workspace's own testing aid, never a
  // real connection, so it's tracked and shown separately from `connected`.
  const [mock, setMock] = useState<Record<string, boolean>>({});
  const [mockBusy, setMockBusy] = useState<string | null>(null);
  const refreshMock = () => getMockStatus().then(setMock).catch(() => {});
  useEffect(() => {
    refreshMock();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [githubConnected]);

  const tryMock = async (key: MockProvider) => {
    setMockBusy(key);
    try {
      await enableMock(key);
      await refreshMock();
    } finally {
      setMockBusy(null);
    }
  };

  const turnOffMock = async (key: MockProvider) => {
    setMockBusy(key);
    try {
      await disableMock(key);
      await refreshMock();
    } finally {
      setMockBusy(null);
    }
  };

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
      {!canConnect && (
        <p className="mt-2 text-[12px] l-t-muted">
          Only an owner of this workspace can connect a new source.
        </p>
      )}

      <div className="mt-6 grid gap-x-10 md:grid-cols-2 xl:grid-cols-3">
        {live.map((i) => {
          const connected = i.key === "github" && githubConnected > 0;
          const mocked = MOCK_PROVIDERS.has(i.key) && mock[i.key];
          return (
            <div
              key={i.key}
              className="l-row group relative border-t py-4"
              style={{ borderColor: "var(--l-rule)" }}
            >
              <span className="l-row-rule" style={{ background: "var(--l-rust)" }} />
              <button
                onClick={connectable(i.key)}
                disabled={!canConnect}
                title={canConnect ? undefined : "Only an owner can connect a new source"}
                className="block w-full text-left disabled:cursor-not-allowed disabled:opacity-50"
              >
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

              {MOCK_PROVIDERS.has(i.key) && (
                <div className="mt-2">
                  {mocked ? (
                    <span className="inline-flex items-center gap-2">
                      <span
                        className="inline-flex items-center gap-1.5 text-[10px] tracking-[0.14em] uppercase"
                        style={{ color: "var(--l-terra)" }}
                        title="Fictional [MOCK] data — not a real connection"
                      >
                        <span className="l-dot" style={{ background: "var(--l-terra)" }} />
                        mock data active
                      </span>
                      <button
                        onClick={() => turnOffMock(i.key as MockProvider)}
                        disabled={mockBusy === i.key || !canUseMock}
                        className="text-[10px] tracking-[0.14em] uppercase underline decoration-dotted l-t-muted disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {mockBusy === i.key ? "removing…" : "turn off"}
                      </button>
                    </span>
                  ) : (
                    <button
                      onClick={() => tryMock(i.key as MockProvider)}
                      disabled={mockBusy === i.key || !canUseMock}
                      className="text-[10px] tracking-[0.14em] uppercase underline decoration-dotted l-t-muted disabled:cursor-not-allowed disabled:no-underline disabled:opacity-50"
                      title={
                        !canUseMock
                          ? "Only a member or owner can add mock data"
                          : "Adds fictional [MOCK] data so the agent has something to answer from — not a real connection"
                      }
                    >
                      {mockBusy === i.key ? "adding mock data…" : "try with mock data"}
                    </button>
                  )}
                </div>
              )}
            </div>
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
