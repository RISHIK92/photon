"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import AuthGuard from "../AuthGuard";
import ConnectGithubDialog from "./ConnectGithubDialog";
import SourcesGrid from "./SourcesGrid";
import ConnectSourceModal from "./ConnectSourceModal";
import {
  connectRepo,
  createWorkspace,
  deleteRepo,
  getWorkspaceId,
  estimateIngest,
  importGithubRepos,
  listGithubInstallations,
  listInstallationRepos,
  type IngestEstimate,
  listRepos,
  listWorkspaces,
  logout,
  setWorkspaceId,
  startGithubInstall,
  type GithubRepoOption,
  type Repo,
  type Workspace,
} from "@/lib/api";

// RepoStatus is uppercase on the wire (PENDING / INGESTING / READY /
// FAILED). Compared case-insensitively so a future enum rename to
// lowercase doesn't silently freeze the list at "pending" forever, which
// is exactly what happened the first time.
const ACTIVE = new Set(["pending", "ingesting"]);
const isActive = (status: string) => ACTIVE.has(status.toLowerCase());
const isReady = (status: string) => status.toLowerCase() === "ready";

export default function DashboardPage() {
  return (
    <AuthGuard>
      <Suspense fallback={null}>
        <Dashboard />
      </Suspense>
    </AuthGuard>
  );
}

function Dashboard() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [ghConnecting, setGhConnecting] = useState(false);
  const [ghInstallationId, setGhInstallationId] = useState<number | null>(null);
  const [ghEstimate, setGhEstimate] = useState<IngestEstimate | null>(null);
  // The install hand-off is gated behind a pre-flight dialog: it is the one
  // step that leaves our UI, grants access to source code, and is easy to
  // get wrong silently (a user-owned private app simply won't list the org).
  const [showConnectDialog, setShowConnectDialog] = useState(false);
  const [ghInstallCount, setGhInstallCount] = useState(0);
  // Which source's connect form is open, and where to return afterwards
  // (the call page sends ?connect=slack&return=/call?code=abcd-efgh so a
  // user who left a call mid-setup lands back in the same one).
  const [connectSource, setConnectSource] = useState<string | null>(null);
  const [returnTo, setReturnTo] = useState<string | null>(null);
  const [ghRepos, setGhRepos] = useState<GithubRepoOption[]>([]);
  const [ghSelected, setGhSelected] = useState<Set<number>>(new Set());
  const [ghBusy, setGhBusy] = useState(false);
  const [ghError, setGhError] = useState<string | null>(null);
  // Presentation state: the workspace menu, the inline "new workspace" form
  // (a window.prompt is both ugly and unstyleable), the collapsed URL field,
  // and which repo is one click from being removed.
  const [wsMenu, setWsMenu] = useState(false);
  const [newWs, setNewWs] = useState<string | null>(null);
  const [showUrlField, setShowUrlField] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const newWsRef = useRef<HTMLInputElement>(null);

  const refreshRepos = useCallback(async () => {
    try {
      setRepos(await listRepos());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const ws = await listWorkspaces();
        setWorkspaces(ws);
        const selected = getWorkspaceId() && ws.some((w) => w.id === getWorkspaceId())
          ? getWorkspaceId()!
          : ws[0]?.id;
        if (selected) {
          setWorkspaceId(selected);
          setCurrent(selected);
        }
        await refreshRepos();
        // Connected-source count on first paint, not only after returning
        // from a GitHub install redirect.
        try {
          setGhInstallCount((await listGithubInstallations()).length);
        } catch {
          /* the sources grid just shows "connect" instead of a count */
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [refreshRepos]);

  // Ingestion runs in Celery and takes ~1 minute, so the list has to move on
  // its own — otherwise a repo sits at "pending" until someone reloads.
  useEffect(() => {
    if (!repos.some((r) => isActive(r.status))) return;
    const handle = setInterval(refreshRepos, 3000);
    return () => clearInterval(handle);
  }, [repos, refreshRepos]);

  const openRepoPicker = useCallback(async (installationId: number) => {
    setGhError(null);
    setGhBusy(true);
    try {
      const { repos: options } = await listInstallationRepos(installationId);
      setGhInstallationId(installationId);
      setGhRepos(options);
      setGhSelected(new Set(options.filter((r) => !r.already_imported).map((r) => r.id)));
    } catch (e) {
      setGhError(e instanceof Error ? e.message : String(e));
    } finally {
      setGhBusy(false);
    }
  }, []);

  // Re-estimate whenever the selection changes. Debounced because ticking
  // several boxes quickly would otherwise fire a request per click, and the
  // answer is a coarse range — it does not need to track every keystroke.
  useEffect(() => {
    const chosen = ghRepos.filter((r) => ghSelected.has(r.id) && !r.already_imported);
    if (chosen.length === 0) {
      // Clearing goes through the same timer as setting, so neither path
      // updates state synchronously from the effect body.
      const clear = setTimeout(() => setGhEstimate(null), 0);
      return () => clearTimeout(clear);
    }
    const handle = setTimeout(() => {
      estimateIngest({ size_kb: chosen.map((r) => r.size_kb) })
        .then(setGhEstimate)
        // An estimate is a convenience; failing to get one must not block
        // the import button.
        .catch(() => setGhEstimate(null));
    }, 250);
    return () => clearTimeout(handle);
  }, [ghRepos, ghSelected]);

  useEffect(() => {
    const source = searchParams.get("connect");
    const back = searchParams.get("return");
    // Deferred a frame rather than set straight from the effect body: these
    // open a dialog, so a cascading render on mount is exactly what we do
    // not want, and one frame is imperceptible for a modal.
    const id = requestAnimationFrame(() => {
      if (back) setReturnTo(back);
      if (source) {
        // GitHub has its own pre-flight dialog; everything else uses the
        // generic connect modal.
        if (source === "github") setShowConnectDialog(true);
        else setConnectSource(source);
      }
    });
    return () => cancelAnimationFrame(id);
  }, [searchParams]);

  // GitHub redirects back here after an installation with ?installation=connected
  // but no installation_id — the app may have multiple installations, so we
  // just open the picker for the most recently created one.
  useEffect(() => {
    if (searchParams.get("installation") !== "connected") return;
    router.replace("/dashboard");
    (async () => {
      try {
        const installations = await listGithubInstallations();
        setGhInstallCount(installations.length);
        const latest = installations[installations.length - 1];
        if (latest) await openRepoPicker(latest.installation_id);
      } catch (e) {
        setGhError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [searchParams, router, openRepoPicker]);

  const connectGithub = async () => {
    setGhError(null);
    setGhConnecting(true);
    try {
      const { url } = await startGithubInstall();
      window.location.href = url;
    } catch (e) {
      setGhError(e instanceof Error ? e.message : String(e));
      setGhConnecting(false);
    }
  };

  const toggleGhRepo = (id: number) => {
    setGhSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const importSelected = async () => {
    if (ghInstallationId === null) return;
    const chosen = ghRepos.filter((r) => ghSelected.has(r.id) && !r.already_imported);
    if (chosen.length === 0) return;
    setGhBusy(true);
    setGhError(null);
    try {
      await importGithubRepos(ghInstallationId, chosen);
      await openRepoPicker(ghInstallationId);
      await refreshRepos();
    } catch (e) {
      setGhError(e instanceof Error ? e.message : String(e));
    } finally {
      setGhBusy(false);
    }
  };

  const switchWorkspace = async (id: string) => {
    setWorkspaceId(id);
    setCurrent(id);
    setRepos([]);
    setWsMenu(false);
    await refreshRepos();
  };

  const addWorkspace = async () => {
    const name = newWs?.trim();
    if (!name) return;
    try {
      const ws = await createWorkspace(name);
      setWorkspaces((prev) => [...prev, ws]);
      setNewWs(null);
      await switchWorkspace(ws.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    const source = url.trim();
    if (!source) return;
    setBusy(true);
    setError(null);
    try {
      const name = source.replace(/\.git$/, "").split("/").slice(-2).join("/");
      await connectRepo(name, source);
      setUrl("");
      setShowUrlField(false);
      await refreshRepos();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const ready = repos.filter((r) => isReady(r.status));
  const indexing = repos.filter((r) => isActive(r.status));
  const workspace = workspaces.find((w) => w.id === current);
  const firstRun = repos.length === 0 && ghInstallCount === 0;

  return (
    <div className="l-landing min-h-screen">
      {connectSource && (
        <ConnectSourceModal
          sourceKey={connectSource}
          onClose={() => setConnectSource(null)}
          onConnected={() => {
            refreshRepos();
            if (returnTo) window.location.href = returnTo;
          }}
        />
      )}
      {showConnectDialog && (
        <ConnectGithubDialog
          busy={ghConnecting}
          onCancel={() => setShowConnectDialog(false)}
          onConfirm={connectGithub}
        />
      )}

      <header
        className="sticky top-0 z-30 border-b px-6 py-4 backdrop-blur-xl md:px-10"
        style={{ borderColor: "var(--l-rule)", background: "rgba(255,253,248,.82)" }}
      >
        <div className="mx-auto flex max-w-5xl items-center gap-5">
          <Link
            href="/"
            className="text-[24px] leading-none italic"
            style={{ fontFamily: "var(--font-display)", color: "var(--l-ink)" }}
          >
            photon
          </Link>

          <span className="h-4 w-px" style={{ background: "var(--l-rule)" }} />

          {/* workspace menu — a real menu, not a native select on paper */}
          <div className="relative">
            <button
              onClick={() => setWsMenu((v) => !v)}
              className="flex items-center gap-2 text-[12px] tracking-[0.14em] uppercase l-quiet"
            >
              <span style={{ color: "var(--l-ink)" }}>{workspace?.name ?? "…"}</span>
              <span style={{ fontSize: 9 }}>{wsMenu ? "▲" : "▼"}</span>
            </button>
            {wsMenu && (
              <>
                <button
                  className="fixed inset-0 z-10 cursor-default"
                  aria-label="Close menu"
                  onClick={() => setWsMenu(false)}
                />
                <div className="l-sheet absolute left-0 top-8 z-20 w-64 p-2">
                  {workspaces.map((w) => (
                    <button
                      key={w.id}
                      onClick={() => switchWorkspace(w.id)}
                      className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[13px] transition-colors hover:bg-[rgba(28,25,23,.04)]"
                      style={{ color: w.id === current ? "var(--l-ink)" : "var(--l-ink-2)" }}
                    >
                      <span
                        className="l-dot shrink-0"
                        style={{ background: w.id === current ? "var(--l-rust)" : "var(--l-rule)" }}
                      />
                      <span className="truncate">{w.name}</span>
                      {w.is_personal && (
                        <span className="ml-auto text-[10px] tracking-[0.18em] uppercase l-t-muted">
                          personal
                        </span>
                      )}
                    </button>
                  ))}
                  <div className="my-2 h-px" style={{ background: "var(--l-rule)" }} />
                  <button
                    onClick={() => {
                      setNewWs("");
                      setWsMenu(false);
                      requestAnimationFrame(() => newWsRef.current?.focus());
                    }}
                    className="w-full rounded-lg px-3 py-2 text-left text-[12px] tracking-[0.14em] uppercase l-quiet"
                  >
                    + New workspace
                  </button>
                </div>
              </>
            )}
          </div>

          <div className="flex-1" />

          <Link href="/call" className="l-btn">
            Start a call
          </Link>
          <button
            onClick={() => {
              logout();
              router.replace("/login");
            }}
            className="text-[12px] tracking-[0.14em] uppercase l-quiet"
          >
            Sign out
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 pb-24 md:px-10">
        {newWs !== null && (
          <div className="mt-8 flex items-center gap-3">
            <input
              ref={newWsRef}
              className="l-input max-w-xs"
              placeholder="Workspace name"
              value={newWs}
              onChange={(e) => setNewWs(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") addWorkspace();
                if (e.key === "Escape") setNewWs(null);
              }}
            />
            <button onClick={addWorkspace} disabled={!newWs.trim()} className="l-btn">
              Create
            </button>
            <button onClick={() => setNewWs(null)} className="text-[12px] uppercase l-quiet">
              Cancel
            </button>
          </div>
        )}

        {/* what the agent can currently answer from — the actual state of
            this workspace, stated before anything asks to be configured */}
        <section className="pt-14">
          <div className="flex items-center gap-4">
            <span className="h-px w-10" style={{ background: "var(--l-rust)" }} />
            <span className="text-[11px] tracking-[0.28em] uppercase l-t-muted">
              This workspace
            </span>
            <span className="h-px flex-1" style={{ background: "var(--l-rule)" }} />
          </div>

          <div className="mt-8 grid gap-10 md:grid-cols-[1.15fr_1fr]">
            <div>
              <h1
                className="text-[clamp(28px,3.4vw,42px)] leading-[1.12]"
                style={{ color: "var(--l-ink)" }}
              >
                {firstRun ? (
                  <>
                    Nothing connected yet — so it{" "}
                    <span style={{ fontFamily: "var(--font-display)", fontStyle: "italic" }}>
                      knows nothing
                    </span>
                    .
                  </>
                ) : ready.length === 0 ? (
                  <>
                    Reading now. It will answer{" "}
                    <span style={{ fontFamily: "var(--font-display)", fontStyle: "italic" }}>
                      from this
                    </span>{" "}
                    shortly.
                  </>
                ) : (
                  <>
                    Ready for calls, from{" "}
                    <span style={{ fontFamily: "var(--font-display)", fontStyle: "italic" }}>
                      {ready.length} {ready.length === 1 ? "repository" : "repositories"}
                    </span>
                    .
                  </>
                )}
              </h1>
              <p className="mt-5 max-w-md text-[15px] leading-relaxed l-t-2">
                {firstRun
                  ? "Connect a source and pick what it may read. Nothing is indexed until you choose it, and it abstains rather than guessing about anything it has not read."
                  : indexing.length > 0
                    ? `${indexing.length} ${indexing.length === 1 ? "repository is" : "repositories are"} being cloned, parsed and indexed. This page updates itself; you can leave it.`
                    : "Ask it anything grounded in what is connected below. Every answer names its source, and it says so out loud when the evidence runs out."}
              </p>
            </div>

            <div className="grid grid-cols-3 gap-6 self-start">
              {[
                [String(ghInstallCount), ghInstallCount === 1 ? "source" : "sources"],
                [String(ready.length), "ready"],
                [String(indexing.length), "indexing"],
              ].map(([n, l], i) => (
                <div
                  key={l}
                  className="border-t pt-4"
                  style={{ borderColor: i === 1 ? "var(--l-rust)" : "var(--l-rule)" }}
                >
                  <div
                    className="leading-none"
                    style={{ fontFamily: "var(--font-display)", fontSize: 40, color: "var(--l-ink)" }}
                  >
                    {n}
                  </div>
                  <div className="mt-3 text-[10px] tracking-[0.2em] uppercase l-t-muted">{l}</div>
                </div>
              ))}
            </div>
          </div>

          {error && (
            <p className="l-note mt-8 pl-4 text-[13px] l-t-2" style={{ borderLeft: "1px solid var(--l-rust)" }}>
              {error}
            </p>
          )}
        </section>

        {/* first run: say what the three steps are, rather than showing a
            grid of cards and hoping the order is obvious */}
        {firstRun && (
          <section className="mt-16">
            <div className="grid gap-px md:grid-cols-3">
              {[
                ["I", "Connect a source", "GitHub, Slack, Jira and the rest. Read-only, and scoped to what you select."],
                ["II", "Choose what it reads", "Pick the repositories and channels. Indexing takes seconds, not an afternoon."],
                ["III", "Join a call", "It listens, answers in about a second and a half, and shows you where each answer came from."],
              ].map(([n, t, d]) => (
                <div key={n} className="border-t py-8 pr-8" style={{ borderColor: "var(--l-rule)" }}>
                  <span
                    className="italic leading-none"
                    style={{ fontFamily: "var(--font-display)", fontSize: 34, color: "var(--l-rust)" }}
                  >
                    {n}
                  </span>
                  <h3 className="mt-4 text-[18px]" style={{ color: "var(--l-ink)" }}>
                    {t}
                  </h3>
                  <p className="mt-2 text-[14px] leading-relaxed l-t-2">{d}</p>
                </div>
              ))}
            </div>
          </section>
        )}

        <SourcesGrid
          githubConnected={ghInstallCount}
          onConnectGithub={() => {
            setGhError(null);
            setShowConnectDialog(true);
          }}
          onConnectSource={(key) => setConnectSource(key)}
        />

        {ghError && (
          <p className="l-note mt-6 pl-4 text-[13px] l-t-2" style={{ borderLeft: "1px solid var(--l-rust)" }}>
            {ghError}
          </p>
        )}

        {/* the repo picker, once GitHub has been installed */}
        {ghInstallationId !== null && (
          <section className="l-sheet mt-10 p-6">
            <div className="flex items-center justify-between">
              <h3 className="text-[16px]" style={{ color: "var(--l-ink)" }}>
                Choose repositories to import
              </h3>
              <button onClick={() => setGhInstallationId(null)} className="text-[12px] uppercase l-quiet">
                Close
              </button>
            </div>

            {ghBusy && ghRepos.length === 0 ? (
              <p className="mt-4 text-[14px] l-t-muted">Loading repositories…</p>
            ) : (
              <>
                <div className="mt-5 flex items-center gap-4">
                  <button
                    onClick={() =>
                      setGhSelected(new Set(ghRepos.filter((r) => !r.already_imported).map((r) => r.id)))
                    }
                    className="text-[11px] tracking-[0.16em] uppercase l-quiet"
                  >
                    Select all
                  </button>
                  <button
                    onClick={() => setGhSelected(new Set())}
                    className="text-[11px] tracking-[0.16em] uppercase l-quiet"
                  >
                    Clear
                  </button>
                  <span className="text-[11px] tracking-[0.16em] uppercase l-t-muted">
                    {ghSelected.size} selected
                  </span>
                </div>

                <ul className="mt-4 max-h-72 overflow-y-auto pr-2">
                  {ghRepos.map((r) => (
                    <li key={r.id}>
                      <label
                        className="flex cursor-pointer items-center gap-3 border-b py-3 text-[14px]"
                        style={{ borderColor: "var(--l-rule)" }}
                      >
                        <input
                          type="checkbox"
                          disabled={r.already_imported}
                          checked={r.already_imported || ghSelected.has(r.id)}
                          onChange={() => toggleGhRepo(r.id)}
                          className="accent-[color:var(--l-rust)]"
                        />
                        <span
                          className="truncate"
                          style={{ color: r.already_imported ? "var(--l-muted)" : "var(--l-ink)" }}
                        >
                          {r.full_name}
                        </span>
                        {r.private && (
                          <span
                            className="rounded-full px-2 py-0.5 text-[10px] tracking-[0.14em] uppercase l-t-muted"
                            style={{ border: "1px solid var(--l-rule)" }}
                          >
                            private
                          </span>
                        )}
                        {r.already_imported && (
                          <span className="ml-auto text-[10px] tracking-[0.16em] uppercase l-t-rust">
                            imported
                          </span>
                        )}
                      </label>
                    </li>
                  ))}
                </ul>

                <div className="mt-5 flex flex-wrap items-center gap-4">
                  <button onClick={importSelected} disabled={ghBusy || ghSelected.size === 0} className="l-btn">
                    {ghBusy ? "Importing…" : `Import ${ghSelected.size} repo${ghSelected.size === 1 ? "" : "s"}`}
                  </button>
                  {ghEstimate && (
                    <p className="text-[12px] l-t-muted">
                      about <span className="l-t-ink">{ghEstimate.range_human}</span> to parse and index
                      {ghEstimate.calibrated
                        ? ` · from ${ghEstimate.sample_size} previous imports`
                        : " · rough, not yet calibrated here"}
                    </p>
                  )}
                </div>
              </>
            )}
          </section>
        )}

        {/* what it has read */}
        <section className="mt-20">
          <div className="flex items-center gap-4">
            <span className="h-px w-10" style={{ background: "var(--l-rust)" }} />
            <span className="text-[11px] tracking-[0.28em] uppercase l-t-muted">Repositories</span>
            <span className="h-px flex-1" style={{ background: "var(--l-rule)" }} />
            <button
              onClick={() => setShowUrlField((v) => !v)}
              className="text-[11px] tracking-[0.16em] uppercase whitespace-nowrap l-quiet"
            >
              {showUrlField ? "Cancel" : "+ Paste a public URL"}
            </button>
          </div>

          {showUrlField && (
            <form onSubmit={add} className="mt-6 flex flex-wrap items-center gap-3">
              <input
                className="l-input max-w-md flex-1"
                placeholder="https://github.com/org/repo"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                autoFocus
              />
              <button disabled={busy || !url.trim()} className="l-btn">
                {busy ? "Connecting…" : "Connect"}
              </button>
              <p className="w-full text-[12px] l-t-muted">
                Public repositories only. For anything private, connect GitHub above so access is
                scoped and revocable.
              </p>
            </form>
          )}

          {repos.length === 0 ? (
            <p className="mt-8 max-w-lg text-[15px] leading-relaxed l-t-muted">
              Nothing indexed in this workspace yet. Connect a source above — cloning, parsing and
              embedding a mid-sized repository takes about seventeen seconds.
            </p>
          ) : (
            <ul className="mt-6">
              {repos.map((r) => (
                <li
                  key={r.id}
                  className="l-row group relative grid items-center gap-4 border-b py-5 md:grid-cols-[1fr_auto_auto]"
                  style={{ borderColor: "var(--l-rule)" }}
                >
                  <span className="l-row-rule" style={{ background: "var(--l-rust)" }} />
                  <div className="min-w-0">
                    <p className="truncate text-[15px]" style={{ color: "var(--l-ink)" }}>
                      {r.name}
                    </p>
                    <p className="mt-1 truncate text-[13px] l-t-muted">
                      {isReady(r.status)
                        ? `${r.file_count} files · ${r.function_count} functions` +
                          (r.ingest_seconds ? ` · indexed in ${Math.round(r.ingest_seconds)}s` : "")
                        : r.error_message || "Cloning, parsing and embedding…"}
                    </p>
                    {isActive(r.status) && <span className="l-indeterminate mt-3 block max-w-xs" />}
                  </div>

                  <StatusPill status={r.status} />

                  {confirmRemove === r.id ? (
                    <span className="flex items-center gap-3 text-[11px] tracking-[0.16em] uppercase">
                      <button
                        onClick={async () => {
                          setConfirmRemove(null);
                          await deleteRepo(r.id);
                          refreshRepos();
                        }}
                        className="l-t-rust"
                      >
                        Remove
                      </button>
                      <button onClick={() => setConfirmRemove(null)} className="l-quiet">
                        Keep
                      </button>
                    </span>
                  ) : (
                    <button
                      onClick={() => setConfirmRemove(r.id)}
                      className="text-[11px] tracking-[0.16em] uppercase opacity-0 transition-opacity group-hover:opacity-100 l-quiet"
                    >
                      Remove
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        {ready.length > 0 && (
          <section className="mt-20 flex flex-wrap items-center justify-between gap-6 border-t pt-10" style={{ borderColor: "var(--l-rule)" }}>
            <p className="max-w-md text-[15px] leading-relaxed l-t-2">
              It has read this workspace. Open a room, share the code, and ask it something you
              would have had to go looking for.
            </p>
            <Link href="/call" className="l-btn">
              Start a call
            </Link>
          </section>
        )}
      </main>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const normalised = status.toLowerCase();
  const label = normalised === "ready" ? "ready" : normalised === "failed" ? "failed" : "indexing";
  const live = normalised !== "ready" && normalised !== "failed";
  return (
    <span
      className="flex shrink-0 items-center gap-2 rounded-full px-3 py-1 text-[10px] tracking-[0.18em] uppercase"
      style={{
        border: "1px solid var(--l-rule)",
        color: normalised === "failed" ? "var(--l-rust)" : "var(--l-ink-2)",
      }}
    >
      <span
        className={live ? "l-dot l-dot-live" : "l-dot"}
        style={live ? undefined : { background: normalised === "failed" ? "var(--l-rust)" : "var(--l-ink)" }}
      />
      {label}
    </span>
  );
}
