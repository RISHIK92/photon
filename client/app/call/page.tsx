"use client";

import "@livekit/components-styles";
import { useCallback, useState } from "react";
import { LiveKitRoom, VideoConference } from "@livekit/components-react";
import { AgentAnswer } from "@/lib/evidence";
import EvidencePanel from "./EvidencePanel";
import AccountSummary from "./AccountSummary";
import CaptionsBridge from "./CaptionsBridge";

const BRAIN_API_URL = process.env.NEXT_PUBLIC_BRAIN_API_URL || "http://localhost:8000";

type ConnState = "idle" | "connecting" | "connected" | "error";
type Turn = { role: "user" | "agent"; question?: string; result?: AgentAnswer };
type TokenData = { url: string; token: string };

export default function CallPage() {
  const [identity, setIdentity] = useState("");
  const [state, setState] = useState<ConnState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [tokenData, setTokenData] = useState<TokenData | null>(null);
  const [captions, setCaptions] = useState<string[]>([]);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [textInput, setTextInput] = useState("");
  const [textBusy, setTextBusy] = useState(false);

  const connect = useCallback(async () => {
    if (!identity.trim()) {
      setError("Enter a name first.");
      return;
    }
    setState("connecting");
    setError(null);
    try {
      const res = await fetch(
        `/api/livekit-token?room=photon&identity=${encodeURIComponent(identity)}`
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "failed to get a token");
      setTokenData({ url: data.url, token: data.token });
      setState("connected");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setState("error");
    }
  }, [identity]);

  const onDisconnected = useCallback(() => {
    setState("idle");
    setTokenData(null);
  }, []);

  const onCaption = useCallback((text: string) => {
    setCaptions((prev) => [...prev.slice(-8), text]);
  }, []);

  const askByText = useCallback(async () => {
    const question = textInput.trim();
    if (!question || textBusy) return;
    setTextInput("");
    setTurns((prev) => [...prev, { role: "user", question }, { role: "agent" }]);
    setTextBusy(true);
    try {
      const res = await fetch(`${BRAIN_API_URL}/api/agent/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      });
      const result: AgentAnswer = await res.json();
      setTurns((prev) => {
        const next = [...prev];
        next[next.length - 1] = { role: "agent", result };
        return next;
      });
    } catch (e) {
      setTurns((prev) => {
        const next = [...prev];
        next[next.length - 1] = {
          role: "agent",
          result: {
            answer: `Error reaching the agent: ${e instanceof Error ? e.message : String(e)}`,
            claims: [],
            confidence: "low",
            abstained: true,
            escalation: null,
            tool_trace: [],
          },
        };
        return next;
      });
    } finally {
      setTextBusy(false);
    }
  }, [textInput, textBusy]);

  return (
    <div className="h-screen bg-neutral-950 text-neutral-100 flex flex-col overflow-hidden">
      <header className="border-b border-neutral-800 px-6 py-4 shrink-0">
        <h1 className="text-lg font-semibold">Meridian support call</h1>
        <p className="text-sm text-neutral-400">
          Talk to Photon, Meridian&apos;s support agent — it&apos;s listening the whole time,
          no wake word needed. Use the text box on the right if audio isn&apos;t working.
        </p>
      </header>

      <main className="flex-1 grid grid-cols-1 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] gap-6 p-6 min-h-0 overflow-hidden">
        <section className="flex flex-col gap-3 min-h-0">
          {state !== "connected" || !tokenData ? (
            <div className="flex flex-col gap-3 max-w-sm">
              <input
                className="bg-neutral-900 border border-neutral-700 rounded px-3 py-2 text-sm"
                placeholder="Your name"
                value={identity}
                onChange={(e) => setIdentity(e.target.value)}
              />
              <button
                onClick={connect}
                disabled={state === "connecting"}
                className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 rounded px-4 py-2 text-sm font-medium"
              >
                {state === "connecting" ? "Connecting…" : "Join call"}
              </button>
              {error && <p className="text-red-400 text-sm">{error}</p>}
            </div>
          ) : (
            <>
              {/* The actual meeting room — real video tiles, screen-share
                  viewer, and mic/camera/screen-share/leave controls, all
                  from LiveKit's own prefab rather than a hand-rolled
                  hidden-audio div. This is what makes it look like a call. */}
              <div className="flex-1 min-h-0 rounded-lg overflow-hidden border border-neutral-800">
                <LiveKitRoom
                  serverUrl={tokenData.url}
                  token={tokenData.token}
                  connect
                  audio
                  video={false}
                  data-lk-theme="default"
                  onDisconnected={onDisconnected}
                  style={{ height: "100%" }}
                >
                  <VideoConference />
                  <CaptionsBridge onCaption={onCaption} />
                </LiveKitRoom>
              </div>

              <div className="shrink-0">
                <h2 className="text-xs uppercase tracking-wide text-neutral-500 mb-1">
                  Live captions
                </h2>
                <div className="bg-neutral-900 border border-neutral-800 rounded p-2 h-20 overflow-y-auto text-xs space-y-1">
                  {captions.length === 0 && <p className="text-neutral-600">…</p>}
                  {captions.map((c, i) => (
                    <p key={i}>{c}</p>
                  ))}
                </div>
              </div>
            </>
          )}

          {/* Note: this evidence panel currently only reflects the text-input
              path on the right. The voice path (call-agent's orchestrator)
              speaks its answer via TTS but doesn't yet broadcast the
              structured result back to the browser — see CLAUDE.md Phase 5. */}
        </section>

        <section className="flex flex-col min-h-0 h-full bg-neutral-900/30 border border-neutral-800 rounded-lg p-4">
          <div className="flex-1 min-h-0 overflow-y-auto">
            {turns.length === 0 ? <AccountSummary /> : <EvidencePanel turns={turns} />}
          </div>

          <div className="flex gap-2 mt-4 pt-4 border-t border-neutral-800 shrink-0">
            <input
              className="flex-1 bg-neutral-900 border border-neutral-700 rounded px-3 py-2 text-sm"
              placeholder="Ask a question…"
              value={textInput}
              onChange={(e) => setTextInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && askByText()}
            />
            <button
              onClick={askByText}
              disabled={textBusy}
              className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 rounded px-4 py-2 text-sm font-medium"
            >
              {textBusy ? "Asking…" : "Ask"}
            </button>
          </div>
        </section>
      </main>
    </div>
  );
}
