"use client";

import { useEffect, useState } from "react";
import {
  connectConnector,
  connectJira,
  getConnectorProviders,
  startSlackInstall,
  uploadCustomDoc,
  type ProviderField,
} from "@/lib/api";

/** One modal, per-source forms.
 *
 * The generic connectors (Linear, Notion, Datadog) render from the server's
 * own field list, so adding a provider needs no change here — the same
 * definition that validates the request describes the form, and the two
 * cannot drift apart.
 *
 * Jira, Slack and custom docs are hand-written because each is genuinely
 * different: a site URL plus an account, an OAuth redirect, and a file
 * upload are not variations of one form.
 */
export default function ConnectSourceModal({
  sourceKey,
  onClose,
  onConnected,
}: {
  sourceKey: string;
  onClose: () => void;
  onConnected: () => void;
}) {
  const [fields, setFields] = useState<ProviderField[] | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const generic = ["linear", "notion", "datadog"].includes(sourceKey);

  useEffect(() => {
    if (!generic) return;
    getConnectorProviders()
      .then((all) => setFields(all[sourceKey]?.fields ?? []))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [generic, sourceKey]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (generic) {
        const credentials: Record<string, string> = {};
        const config: Record<string, string> = {};
        for (const f of fields ?? []) {
          (f.config ? config : credentials)[f.key] = values[f.key] ?? "";
        }
        await connectConnector(sourceKey, credentials, config);
      } else if (sourceKey === "jira") {
        await connectJira(values.site_url ?? "", values.account_email ?? "", values.api_token ?? "");
      } else if (sourceKey === "slack") {
        const { url } = await startSlackInstall();
        window.location.href = url;
        return;
      } else if (sourceKey === "custom_docs") {
        const form = new FormData();
        if (values.title) form.append("title", values.title);
        form.append("text", values.text ?? "");
        const doc = await uploadCustomDoc(form);
        setDone(`Indexed “${doc.title}” into ${doc.chunk_count} chunks.`);
        onConnected();
        return;
      }
      onConnected();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const label = sourceKey.replace(/_/g, " ");

  return (
    <div className="fixed inset-0 bg-black/70 flex items-start justify-center overflow-y-auto p-6 z-50">
      <div className="bg-neutral-950 border border-neutral-800 rounded-lg max-w-lg w-full p-5 my-8">
        <div className="flex items-start justify-between mb-3">
          <h2 className="text-base font-semibold capitalize">Connect {label}</h2>
          <button onClick={onClose} className="text-sm text-neutral-500 hover:text-neutral-200">
            close
          </button>
        </div>

        {sourceKey === "slack" && (
          <p className="text-sm text-neutral-400 mb-4">
            You&apos;ll be taken to Slack to choose a workspace and which channels the bot can
            read. It only ever reads channels it has been added to, and asks for no write access.
          </p>
        )}

        {sourceKey === "custom_docs" && (
          <>
            <p className="text-sm text-neutral-400 mb-3">
              Paste a business flow, runbook or escalation policy. Markdown headings become
              sections, so the agent can cite the right part rather than the whole document.
            </p>
            <input
              className="w-full bg-neutral-900 border border-neutral-700 rounded px-3 py-2 text-sm mb-2"
              placeholder="Title (e.g. Support escalation policy)"
              value={values.title ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, title: e.target.value }))}
            />
            <textarea
              className="w-full bg-neutral-900 border border-neutral-700 rounded px-3 py-2 text-sm font-mono h-48 mb-2"
              placeholder={"# Refunds\nRefunds over $500 need finance approval…"}
              value={values.text ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, text: e.target.value }))}
            />
          </>
        )}

        {sourceKey === "jira" && (
          <div className="flex flex-col gap-2 mb-2">
            <Field label="Site URL" help="https://yourcompany.atlassian.net">
              <input
                className="w-full bg-neutral-900 border border-neutral-700 rounded px-3 py-2 text-sm"
                placeholder="https://yourcompany.atlassian.net"
                value={values.site_url ?? ""}
                onChange={(e) => setValues((v) => ({ ...v, site_url: e.target.value }))}
              />
            </Field>
            <Field label="Account email" help="The Atlassian account the API token belongs to">
              <input
                className="w-full bg-neutral-900 border border-neutral-700 rounded px-3 py-2 text-sm"
                value={values.account_email ?? ""}
                onChange={(e) => setValues((v) => ({ ...v, account_email: e.target.value }))}
              />
            </Field>
            <Field
              label="API token"
              help="id.atlassian.com → Security → API tokens. The connection sees exactly what you can see."
            >
              <input
                type="password"
                className="w-full bg-neutral-900 border border-neutral-700 rounded px-3 py-2 text-sm"
                value={values.api_token ?? ""}
                onChange={(e) => setValues((v) => ({ ...v, api_token: e.target.value }))}
              />
            </Field>
          </div>
        )}

        {generic && (
          <div className="flex flex-col gap-2 mb-2">
            {(fields ?? []).map((f) => (
              <Field key={f.key} label={f.label} help={f.help}>
                <input
                  type={f.secret ? "password" : "text"}
                  className="w-full bg-neutral-900 border border-neutral-700 rounded px-3 py-2 text-sm"
                  value={values[f.key] ?? ""}
                  onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                />
              </Field>
            ))}
            {fields === null && <p className="text-sm text-neutral-500">Loading…</p>}
          </div>
        )}

        {error && <p className="text-red-400 text-sm mt-2">{error}</p>}
        {done && <p className="text-emerald-400 text-sm mt-2">{done}</p>}

        <div className="flex items-center gap-3 mt-4">
          <button
            onClick={submit}
            disabled={busy}
            className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 rounded px-4 py-2 text-sm font-medium"
          >
            {busy ? "Checking…" : sourceKey === "slack" ? "Continue to Slack" : "Connect"}
          </button>
          <button onClick={onClose} className="text-sm text-neutral-400 hover:text-neutral-100">
            Cancel
          </button>
        </div>
        <p className="text-[10px] text-neutral-600 mt-3">
          Credentials are encrypted before they are stored, and are never returned by the API.
        </p>
      </div>
    </div>
  );
}

function Field({
  label,
  help,
  children,
}: {
  label: string;
  help?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-xs text-neutral-400">{label}</span>
      {children}
      {help && <span className="block text-[10px] text-neutral-600 mt-0.5">{help}</span>}
    </label>
  );
}
