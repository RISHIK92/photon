"use client";

import { useEffect, useState } from "react";
import {
  getCallOptions,
  type CallOptions,
  type CallSource,
} from "@/lib/api";

/** Chosen before joining: what the agent is for, which language, and which
 * sources it may use.
 *
 * Sources are shown even when unavailable, with a Connect action, because
 * "Jira isn't here" is more useful than Jira silently not existing — the
 * most common support question of all is "is this a known issue", and a
 * user who can't see that Jira is disconnected will assume the agent
 * checked and found nothing.
 */
export default function CallSetup({
  onStart,
  onConnectSource,
  busy,
}: {
  onStart: (config: { bot_types: string[]; language_mode: string; enabled_sources: string[] }) => void;
  onConnectSource: (sourceKey: string) => void;
  busy: boolean;
}) {
  const [options, setOptions] = useState<CallOptions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [botTypes, setBotTypes] = useState<string[]>(["support"]);
  const [language, setLanguage] = useState("english");
  const [sources, setSources] = useState<string[]>([]);
  const [showMore, setShowMore] = useState(false);

  useEffect(() => {
    getCallOptions()
      .then((o) => {
        setOptions(o);
        setSources(o.default_enabled);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  if (error) return <p className="text-red-400 text-sm">{error}</p>;
  if (!options) return <p className="text-neutral-500 text-sm">Loading call options…</p>;

  const toggle = (list: string[], key: string) =>
    list.includes(key) ? list.filter((k) => k !== key) : [...list, key];

  // Primary vs "more" mirrors how often each is reached for on a support
  // call, not the order they were built in.
  const PRIMARY = ["github", "custom_docs", "slack", "jira"];
  const primary = options.sources.filter((s) => PRIMARY.includes(s.key));
  const secondary = options.sources.filter((s) => !PRIMARY.includes(s.key));
  const internalCaution = botTypes.some(
    (k) => options.bot_types.find((b) => b.key === k)?.internal_caution
  );

  return (
    <div className="flex flex-col gap-6 max-w-2xl">
      <section>
        <h3 className="text-xs uppercase tracking-wide text-neutral-500 mb-2">
          What is this call for?
        </h3>
        <div className="flex flex-wrap gap-2">
          {options.bot_types.map((b) => {
            const on = botTypes.includes(b.key);
            return (
              <button
                key={b.key}
                onClick={() => setBotTypes((prev) => toggle(prev, b.key))}
                title={b.description}
                className={`rounded border px-3 py-1.5 text-sm ${
                  on
                    ? "border-indigo-500/60 bg-indigo-500/10 text-indigo-200"
                    : "border-neutral-700 text-neutral-400 hover:text-neutral-200"
                }`}
              >
                {b.label}
                {b.internal_caution && <span className="ml-1 text-amber-400">·internal</span>}
              </button>
            );
          })}
        </div>
        {internalCaution && (
          <p className="text-xs text-amber-300/90 mt-2">
            Knowledge transfer allows internal detail — commercial terms, incident history,
            reasoning you would not say to a customer. The agent will flag it if a guest who
            isn&apos;t a workspace member is on the call, but don&apos;t pick this for a customer call.
          </p>
        )}
      </section>

      <section>
        <h3 className="text-xs uppercase tracking-wide text-neutral-500 mb-2">Language</h3>
        <div className="flex flex-wrap gap-2">
          {options.language_modes.map((m) => (
            <button
              key={m.key}
              onClick={() => setLanguage(m.key)}
              className={`rounded border px-3 py-1.5 text-sm text-left ${
                language === m.key
                  ? "border-indigo-500/60 bg-indigo-500/10 text-indigo-200"
                  : "border-neutral-700 text-neutral-400 hover:text-neutral-200"
              }`}
            >
              {m.label}
              <span className="block text-[10px] text-neutral-500">{m.detail}</span>
            </button>
          ))}
        </div>
      </section>

      <section>
        <h3 className="text-xs uppercase tracking-wide text-neutral-500 mb-2">
          Sources the agent may use
        </h3>
        <div className="flex flex-col gap-2">
          {primary.map((s) => (
            <SourceRow
              key={s.key}
              source={s}
              enabled={sources.includes(s.key)}
              onToggle={() => setSources((prev) => toggle(prev, s.key))}
              onConnect={() => onConnectSource(s.key)}
            />
          ))}
        </div>

        {!showMore ? (
          <button
            onClick={() => setShowMore(true)}
            className="text-xs text-neutral-400 hover:text-neutral-100 mt-2"
          >
            More sources ({secondary.length})
          </button>
        ) : (
          <div className="flex flex-col gap-2 mt-2">
            {secondary.map((s) => (
              <SourceRow
                key={s.key}
                source={s}
                enabled={sources.includes(s.key)}
                onToggle={() => setSources((prev) => toggle(prev, s.key))}
                onConnect={() => onConnectSource(s.key)}
              />
            ))}
          </div>
        )}
      </section>

      <div className="flex items-center gap-3">
        <button
          onClick={() => onStart({ bot_types: botTypes, language_mode: language, enabled_sources: sources })}
          disabled={busy || botTypes.length === 0}
          className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 rounded px-4 py-2 text-sm font-medium"
        >
          {busy ? "Starting…" : "Start call"}
        </button>
        <p className="text-xs text-neutral-500">
          {sources.length === 0
            ? "No sources selected — the agent will have nothing to answer from."
            : `${sources.length} source${sources.length === 1 ? "" : "s"} enabled`}
        </p>
      </div>
    </div>
  );
}

function SourceRow({
  source,
  enabled,
  onToggle,
  onConnect,
}: {
  source: CallSource;
  enabled: boolean;
  onToggle: () => void;
  onConnect: () => void;
}) {
  if (source.coming_soon) {
    return (
      <div className="flex items-center gap-3 border border-neutral-800 rounded px-3 py-2 opacity-60">
        <span className="text-sm text-neutral-400 flex-1">{source.label}</span>
        <span className="text-[10px] text-neutral-500 border border-neutral-700 rounded px-1.5 py-0.5">
          soon
        </span>
      </div>
    );
  }

  return (
    <div
      className={`flex items-center gap-3 border rounded px-3 py-2 ${
        enabled && source.available ? "border-emerald-700/50 bg-emerald-500/5" : "border-neutral-800"
      }`}
    >
      <input
        type="checkbox"
        checked={enabled && source.available}
        disabled={!source.available}
        onChange={onToggle}
        className="shrink-0"
      />
      <span className="text-sm text-neutral-200 flex-1">
        {source.label}
        <span className="block text-[10px] text-neutral-500">{source.detail}</span>
      </span>
      {!source.available && (
        <button
          onClick={onConnect}
          className="text-xs border border-indigo-500/60 text-indigo-300 hover:bg-indigo-500/10 rounded px-2 py-1"
        >
          Connect
        </button>
      )}
    </div>
  );
}
