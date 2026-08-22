"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import AuthGuard from "../AuthGuard";
import ConnectGithubDialog from "./ConnectGithubDialog";
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
  const [ghRepos, setGhRepos] = useState<GithubRepoOption[]>([]);
  const [ghSelected, setGhSelected] = useState<Set<number>>(new Set());
  const [ghBusy, setGhBusy] = useState(false);
  const [ghError, setGhError] = useState<string | null>(null);

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
      setGhEstimate(null);
      return;
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

  // GitHub redirects back here after an installation with ?installation=connected
  // but no installation_id — the app may have multiple installations, so we
  // just open the picker for the most recently created one.
  useEffect(() => {
    if (searchParams.get("installation") !== "connected") return;
    router.replace("/dashboard");
    (async () => {
      try {
        const installations = await listGithubInstallations();
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
    await refreshRepos();
  };

  const addWorkspace = async () => {
    const name = prompt("Workspace name");
    if (!name?.trim()) return;
    try {
      const ws = await createWorkspace(name.trim());
      setWorkspaces((prev) => [...prev, ws]);
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
      await refreshRepos();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100">
      {showConnectDialog && (
        <ConnectGithubDialog
          busy={ghConnecting}
          onCancel={() => setShowConnectDialog(false)}
          onConfirm={connectGithub}
        />
      )}
      <header className="border-b border-neutral-800 px-6 py-3 flex items-center gap-4">
        <span className="font-semibold">Photon</span>
        <select
          value={current ?? ""}
          onChange={(e) => switchWorkspace(e.target.value)}
          className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-sm"
        >
          {workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
              {w.is_personal ? " (personal)" : ""}
            </option>
          ))}
        </select>
        <button onClick={addWorkspace} className="text-sm text-neutral-400 hover:text-neutral-100">
          + workspace
        </button>
        <div className="flex-1" />
        <a href="/call" className="text-sm text-indigo-400 hover:text-indigo-300">
          Open call
        </a>
        <button
          onClick={() => {
            logout();
            router.replace("/login");
          }}
          className="text-sm text-neutral-400 hover:text-neutral-100"
        >
          Sign out
        </button>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-8">
        <section className="mb-8">
          <h2 className="text-sm uppercase tracking-wide text-neutral-500 mb-2">Sources</h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <button
              onClick={() => {
                setGhError(null);
                setShowConnectDialog(true);
              }}
              disabled={ghConnecting}
              className="text-left border border-emerald-700/60 bg-emerald-500/5 hover:bg-emerald-500/10 disabled:opacity-50 rounded p-3"
            >
              <p className="text-sm">GitHub</p>
              <p className="text-xs text-neutral-500">
                {ghConnecting ? "Redirecting to GitHub…" : "Connect an org or account"}
              </p>
            </button>
            <SourceCard name="Slack" status="not connected yet" />
            <SourceCard name="Email / Outlook" status="not connected yet" />
          </div>

          {ghError && <p className="text-red-400 text-sm mt-3">{ghError}</p>}

          {ghInstallationId !== null && (
            <div className="mt-4 border border-neutral-800 rounded p-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-medium">Choose repositories to import</h3>
                <button
                  onClick={() => setGhInstallationId(null)}
                  className="text-xs text-neutral-500 hover:text-neutral-200"
                >
                  close
                </button>
              </div>
              {ghBusy && ghRepos.length === 0 ? (
                <p className="text-sm text-neutral-500">Loading repositories…</p>
              ) : (
                <>
                  <ul className="space-y-1 max-h-64 overflow-y-auto">
                    {ghRepos.map((r) => (
                      <li key={r.id} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          disabled={r.already_imported}
                          checked={r.already_imported || ghSelected.has(r.id)}
                          onChange={() => toggleGhRepo(r.id)}
                        />
                        <span className={r.already_imported ? "text-neutral-600" : ""}>
                          {r.full_name}
                        </span>
                        {r.private && (
                          <span className="text-[10px] text-neutral-600 border border-neutral-800 rounded px-1">
                            private
                          </span>
                        )}
                        {r.already_imported && (
                          <span className="text-[10px] text-emerald-400">already imported</span>
                        )}
                      </li>
                    ))}
                  </ul>
                  <div className="mt-3 flex items-center gap-3">
                    <button
                      onClick={importSelected}
                      disabled={ghBusy || ghSelected.size === 0}
                      className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 rounded px-4 py-2 text-sm font-medium"
                    >
                      {ghBusy ? "Importing…" : `Import ${ghSelected.size} repo${ghSelected.size === 1 ? "" : "s"}`}
                    </button>
                    {ghEstimate && (
                      <p className="text-xs text-neutral-500">
                        about <span className="text-neutral-300">{ghEstimate.range_human}</span> to
                        parse and index
                        {ghEstimate.calibrated
                          ? ` · from ${ghEstimate.sample_size} previous imports`
                          : " · rough, not yet calibrated here"}
                      </p>
                    )}
                  </div>
                </>
              )}
            </div>
          )}
        </section>

        <section>
          <h2 className="text-sm uppercase tracking-wide text-neutral-500 mb-2">Repositories</h2>

          <form onSubmit={add} className="flex gap-2 mb-4">
            <input
              className="flex-1 bg-neutral-900 border border-neutral-700 rounded px-3 py-2 text-sm"
              placeholder="https://github.com/org/repo"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <button
              disabled={busy}
              className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 rounded px-4 py-2 text-sm font-medium"
            >
              {busy ? "Connecting…" : "Connect"}
            </button>
          </form>

          {error && <p className="text-red-400 text-sm mb-3">{error}</p>}

          {repos.length === 0 ? (
            <p className="text-neutral-600 text-sm">
              No repositories in this workspace yet. Connect one above — it clones, parses and
              embeds in about a minute.
            </p>
          ) : (
            <ul className="space-y-2">
              {repos.map((r) => (
                <li
                  key={r.id}
                  className="border border-neutral-800 rounded p-3 flex items-center gap-3"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm truncate">{r.name}</p>
                    <p className="text-xs text-neutral-500 truncate">
                      {r.status.toLowerCase() === "ready"
                        ? `${r.file_count} files · ${r.function_count} functions` +
                          (r.ingest_seconds ? ` · parsed in ${Math.round(r.ingest_seconds)}s` : "")
                        : r.error_message || r.status}
                    </p>
                  </div>
                  <StatusPill status={r.status} />
                  <button
                    onClick={async () => {
                      await deleteRepo(r.id);
                      refreshRepos();
                    }}
                    className="text-xs text-neutral-500 hover:text-red-400"
                  >
                    remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}

function SourceCard({ name, status, active }: { name: string; status: string; active?: boolean }) {
  return (
    <div
      className={`border rounded p-3 ${
        active ? "border-emerald-700/60 bg-emerald-500/5" : "border-neutral-800"
      }`}
    >
      <p className="text-sm">{name}</p>
      <p className="text-xs text-neutral-500">{status}</p>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const normalised = status.toLowerCase();
  const tone =
    normalised === "ready"
      ? "border-emerald-600/50 text-emerald-300"
      : normalised === "failed"
        ? "border-red-600/50 text-red-300"
        : "border-amber-600/50 text-amber-300";
  return (
    <span className={`text-[10px] px-2 py-0.5 rounded border shrink-0 ${tone}`}>{normalised}</span>
  );
}
