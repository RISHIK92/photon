"use client";

import { useEffect, useState } from "react";
import { listWorkspaces, updateWorkspace } from "@/lib/api";

const DEFAULT_NAME = "Photon";

/** Name the agent.
 *
 * Not decoration: this is what the agent calls itself in every answer, what
 * it announces when it joins a call, and — the part that surprises people —
 * the wake word it answers to. Rename it to Ava and "Photon, what's the
 * retry policy" stops working, which is correct but worth saying out loud
 * in the UI rather than letting someone discover it mid-call.
 */
export default function AgentNameCard({ workspaceId }: { workspaceId: string | null }) {
  const [name, setName] = useState("");
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!workspaceId) return;
    listWorkspaces()
      .then((all) => {
        const current = all.find((w) => w.id === workspaceId);
        setName(current?.agent_name ?? "");
        setSaved(current?.agent_name ?? null);
      })
      .catch(() => undefined);
  }, [workspaceId]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const updated = await updateWorkspace({ agent_name: name.trim() });
      setSaved(updated.agent_name ?? null);
      setName(updated.agent_name ?? "");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const effective = (name.trim() || DEFAULT_NAME);
  const dirty = (name.trim() || null) !== saved;

  return (
    <section className="mb-8">
      <h2 className="text-sm uppercase tracking-wide text-neutral-500 mb-2">Agent name</h2>
      <div className="border border-neutral-800 rounded p-3">
        <div className="flex items-center gap-2">
          <input
            className="flex-1 bg-neutral-900 border border-neutral-700 rounded px-3 py-2 text-sm"
            placeholder={DEFAULT_NAME}
            value={name}
            maxLength={40}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && dirty && save()}
          />
          <button
            onClick={save}
            disabled={busy || !dirty}
            className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 rounded px-3 py-2 text-sm"
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
        <p className="text-xs text-neutral-500 mt-2">
          Callers say <span className="text-neutral-300">&ldquo;{effective}, …&rdquo;</span> to
          address it, and it introduces itself with this name. Leave blank to use{" "}
          {DEFAULT_NAME}.
        </p>
        {error && <p className="text-xs text-red-400 mt-1">{error}</p>}
      </div>
    </section>
  );
}
