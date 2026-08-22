"use client";

import "@livekit/components-styles";
import { useCallback, useState } from "react";
import { LiveKitRoom, VideoConference } from "@livekit/components-react";
import { AgentAnswer } from "@/lib/evidence";
import { getWorkspaceId } from "@/lib/api";
import EvidencePanel from "./EvidencePanel";
import AccountSummary from "./AccountSummary";
import CaptionsBridge from "./CaptionsBridge";
import CaptionsPanel from "./CaptionsPanel";
import TraceBridge from "./TraceBridge";
import AdvancedPanel from "./AdvancedPanel";
import { mergeCaption, type Caption } from "@/lib/captions";
import { applyTraceEvent, type TraceEvent, type TurnTrace } from "@/lib/trace";

const BRAIN_API_URL = process.env.NEXT_PUBLIC_BRAIN_API_URL || "http://localhost:8000";

type ConnState = "idle" | "connecting" | "connected" | "error";
type Turn = { role: "user" | "agent"; question?: string; result?: AgentAnswer };
type TokenData = { url: string; token: string };

export default function CallPage() {
  const [identity, setIdentity] = useState("");
  const [state, setState] = useState<ConnState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [tokenData, setTokenData] = useState<TokenData | null>(null);
  const [captions, setCaptions] = useState<Caption[]>([]);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [traces, setTraces] = useState<TurnTrace[]>([]);
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

  const onCaption = useCallback((caption: Caption) => {
    setCaptions((prev) => mergeCaption(prev, caption));
  }, []);

  // One reducer for both feeds: voice events arrive over the LiveKit data
  // channel (TraceBridge), text events over SSE from askByText below.
  const onTraceEvent = useCallback((event: TraceEvent, fallbackTurnId = "voice") => {
    setTraces((prev) => applyTraceEvent(prev, event, fallbackTurnId));
  }, []);

  const onVoiceTraceEvent = useCallback(
    (event: TraceEvent) => onTraceEvent(event, "voice"),
    [onTraceEvent]
  );

  const askByText = useCallback(async () => {
    const question = textInput.trim();
    if (!question || textBusy) return;
    setTextInput("");
    setTurns((prev) => [...prev, { role: "user", question }, { role: "agent" }]);
    setTextBusy(true);

    const turnId = `text-${Date.now()}`;
    const fail = (message: string) => {
      setTurns((prev) => {
        const next = [...prev];
        next[next.length - 1] = {
          role: "agent",
          result: {
            answer: message,
            claims: [],
            confidence: "low",
            abstained: true,
            escalation: null,
            tool_trace: [],
          },
        };
        return next;
      });
    };

    try {
      // The event stream, not the plain POST: same answer, but the
      // advanced panel gets each plan/tool/compose step as it happens
      // instead of a single silent wait of tens of seconds.
      // Best-effort: this join page isn't behind login, but if this
      // browser also has a workspace selected from the dashboard, use it
      // so the agent can disambiguate across that workspace's repos
      // instead of falling back to the single seed repo. See CLAUDE.md's
      // multi-repo disambiguation note — the agent endpoint itself is
      // still unauthenticated, so this is client-asserted, not verified.
      const workspace_id = getWorkspaceId() || undefined;
      const res = await fetch(`${BRAIN_API_URL}/api/agent/ask/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, workspace_id }),
      });
      if (!res.ok || !res.body) throw new Error(`brain-api returned ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let result: AgentAnswer | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE frames are separated by a blank line; a chunk can split one
        // in half, so keep the trailing partial frame in the buffer.
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const line = frame.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          const event = JSON.parse(line.slice(6)) as TraceEvent;
          onTraceEvent(event, turnId);
          if (event.type === "turn.done") result = event.result as AgentAnswer;
          if (event.type === "turn.error") throw new Error(String(event.error));
        }
      }

      if (!result) throw new Error("the stream ended before the answer arrived");
      const answer = result;
      setTurns((prev) => {
        const next = [...prev];
        next[next.length - 1] = { role: "agent", result: answer };
        return next;
      });
    } catch (e) {
      fail(`Error reaching the agent: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setTextBusy(false);
    }
  }, [textInput, textBusy, onTraceEvent]);

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
                  <TraceBridge onEvent={onVoiceTraceEvent} />
                </LiveKitRoom>
              </div>

            </>
          )}

          {/* Transcript and the advanced pipeline view side by side — what
              was said on the left, what the agent did about it on the
              right, sharing one timeline. Outside the connected branch on
              purpose: the text fallback works without joining the call, and
              its pipeline is worth watching either way. */}
          <div className="shrink-0 grid grid-cols-1 lg:grid-cols-2 gap-4 mt-auto">
            <CaptionsPanel captions={captions} connected={state === "connected"} />
            <AdvancedPanel turns={traces} />
          </div>

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
