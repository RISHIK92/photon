"use client";

import { useEffect, useState } from "react";
import { getGithubAppInfo, type GithubAppInfo } from "@/lib/api";

/** Shown BEFORE handing the user off to GitHub.
 *
 * Installing a GitHub App is a decision with consequences that are hard to
 * see from GitHub's own screen: which account it lands on, which repos it
 * can read, and — for a private org — that the source will be cloned and
 * sent to third-party embedding and LLM providers. Worse, the most common
 * failure here is silent: a user-owned private App simply does not offer
 * the organisation as an install target, and people assume they picked the
 * wrong menu item.
 *
 * So this checks the App's real state via GitHub first and says
 * specifically what will happen, rather than showing generic instructions
 * the user has to map onto their own case.
 */
export default function ConnectGithubDialog({
  onCancel,
  onConfirm,
  busy,
}: {
  onCancel: () => void;
  onConfirm: () => void;
  busy: boolean;
}) {
  const [info, setInfo] = useState<GithubAppInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);

  useEffect(() => {
    getGithubAppInfo()
      .then(setInfo)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const blockedForOrgs = info ? !info.org_install_supported : false;

  return (
    <div className="fixed inset-0 bg-black/70 flex items-start justify-center overflow-y-auto p-6 z-50">
      <div className="bg-neutral-950 border border-neutral-800 rounded-lg max-w-2xl w-full p-6 my-8">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <h2 className="text-lg font-semibold">Connect GitHub</h2>
            <p className="text-sm text-neutral-400">
              Here&apos;s what happens, before you leave for GitHub.
            </p>
          </div>
          <button onClick={onCancel} className="text-neutral-500 hover:text-neutral-200 text-sm">
            close
          </button>
        </div>

        {error && <p className="text-red-400 text-sm mb-4">{error}</p>}
        {!info && !error && <p className="text-sm text-neutral-500">Checking the app…</p>}

        {info && (
          <>
            {blockedForOrgs && (
              <div className="border border-amber-600/50 bg-amber-500/5 rounded p-3 mb-4 text-sm">
                <p className="text-amber-300 font-medium mb-1">
                  Installing on an organization needs one change first
                </p>
                <p className="text-neutral-300">
                  This app is owned by{" "}
                  <span className="font-mono">@{info.owner_login}</span> (a personal account) and is
                  private, so GitHub will only offer that account as an install target — an
                  organization like a private company org won&apos;t appear in the list.
                </p>
                <p className="text-neutral-400 mt-2">To install it on an organization, either:</p>
                <ul className="list-disc ml-5 mt-1 text-neutral-400 space-y-1">
                  <li>
                    <span className="text-neutral-200">Transfer it to the org</span> — keeps it
                    private and correctly scoped. You must be an owner of that org.
                  </li>
                  <li>
                    <span className="text-neutral-200">Make it public</span> — quicker, but then
                    anyone with the link can install it.
                  </li>
                </ul>
                <a
                  href={`${info.settings_url}#advanced`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-block mt-2 text-indigo-400 hover:text-indigo-300"
                >
                  Open app settings → Advanced ↗
                </a>
                <p className="text-neutral-500 mt-2 text-xs">
                  Installing on your personal account works right now without any of this.
                </p>
              </div>
            )}

            <ol className="space-y-3 text-sm mb-4">
              <Step n={1} title="Choose where to install">
                GitHub will ask which account or organization. Only accounts you own (or can
                request access to) appear.
              </Step>
              <Step n={2} title="Choose which repositories">
                Pick <span className="text-neutral-200">Only select repositories</span> rather than
                all — you can add more later without reinstalling, and the picker here always shows
                the current list.
              </Step>
              <Step n={3} title="Approve the permissions">
                This app asks for{" "}
                <span className="font-mono text-neutral-200">
                  {Object.entries(info.permissions)
                    .map(([k, v]) => `${k}: ${v}`)
                    .join(", ")}
                </span>
                . Read-only, and no write access to anything.
              </Step>
              <Step n={4} title="Come back and pick repos to index">
                You&apos;ll land back here with the repo list, an estimate of how long indexing
                takes, and nothing imported until you choose.
              </Step>
            </ol>

            <div className="border border-neutral-800 rounded p-3 text-sm mb-4">
              <p className="text-neutral-300 font-medium mb-1">What happens to the code</p>
              <p className="text-neutral-400">
                Selected repos are cloned to this server, parsed, and split into chunks. Those
                chunks are sent to the embedding provider to build the search index, and relevant
                snippets are sent to the language model when someone asks a question. For a private
                or proprietary codebase, that&apos;s a deliberate decision worth making consciously.
              </p>
            </div>

            <label className="flex items-start gap-2 text-sm text-neutral-300 mb-4">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
                className="mt-1"
              />
              <span>I understand where the code is sent, and I&apos;m choosing the repositories.</span>
            </label>

            <div className="flex items-center gap-3">
              <button
                onClick={onConfirm}
                disabled={!acknowledged || busy}
                className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 rounded px-4 py-2 text-sm font-medium"
              >
                {busy ? "Opening GitHub…" : "Continue to GitHub"}
              </button>
              <button
                onClick={onCancel}
                className="text-sm text-neutral-400 hover:text-neutral-100"
              >
                Cancel
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="shrink-0 w-5 h-5 rounded-full bg-neutral-800 text-neutral-300 grid place-items-center text-xs">
        {n}
      </span>
      <span>
        <span className="text-neutral-200">{title}</span>
        <span className="text-neutral-400"> — {children}</span>
      </span>
    </li>
  );
}
