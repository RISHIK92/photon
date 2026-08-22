"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Room,
  RoomEvent,
  Track,
  RemoteTrack,
  RemoteTrackPublication,
  RemoteParticipant,
  LocalParticipant,
} from "livekit-client";

const BRAIN_API_URL = process.env.NEXT_PUBLIC_BRAIN_API_URL || "http://localhost:8000";

type ConnState = "idle" | "connecting" | "connected" | "error";

type TextTurn = { role: "user" | "agent"; text: string; abstained?: boolean };

export default function CallPage() {
  const [identity, setIdentity] = useState("");
  const [state, setState] = useState<ConnState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [micOn, setMicOn] = useState(false);
  const [screenOn, setScreenOn] = useState(false);
  const [captions, setCaptions] = useState<string[]>([]);
  const [textTurns, setTextTurns] = useState<TextTurn[]>([]);
  const [textInput, setTextInput] = useState("");
  const [textBusy, setTextBusy] = useState(false);

  const roomRef = useRef<Room | null>(null);
  const audioContainerRef = useRef<HTMLDivElement | null>(null);

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

      const room = new Room();
      roomRef.current = room;

      room.on(RoomEvent.Disconnected, () => setState("idle"));

      room.on(
        RoomEvent.TrackSubscribed,
        (track: RemoteTrack, _pub: RemoteTrackPublication, participant: RemoteParticipant) => {
          if (track.kind === Track.Kind.Audio) {
            const el = track.attach();
            audioContainerRef.current?.appendChild(el);
          }
        }
      );

      room.on(RoomEvent.TranscriptionReceived, (segments) => {
        const lines = segments.map((s) => s.text).filter(Boolean);
        if (lines.length) setCaptions((prev) => [...prev.slice(-8), ...lines]);
      });

      await room.connect(data.url, data.token);
      setState("connected");

      const lp: LocalParticipant = room.localParticipant;
      await lp.setMicrophoneEnabled(true);
      setMicOn(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setState("error");
    }
  }, [identity]);

  const disconnect = useCallback(async () => {
    await roomRef.current?.disconnect();
    roomRef.current = null;
    setState("idle");
    setMicOn(false);
    setScreenOn(false);
  }, []);

  const toggleMic = useCallback(async () => {
    const lp = roomRef.current?.localParticipant;
    if (!lp) return;
    await lp.setMicrophoneEnabled(!micOn);
    setMicOn(!micOn);
  }, [micOn]);

  const toggleScreenShare = useCallback(async () => {
    const lp = roomRef.current?.localParticipant;
    if (!lp) return;
    try {
      await lp.setScreenShareEnabled(!screenOn);
      setScreenOn(!screenOn);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [screenOn]);

  const askByText = useCallback(async () => {
    const question = textInput.trim();
    if (!question || textBusy) return;
    setTextInput("");
    setTextTurns((prev) => [...prev, { role: "user", text: question }]);
    setTextBusy(true);
    try {
      const res = await fetch(`${BRAIN_API_URL}/api/agent/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      });
      const result = await res.json();
      setTextTurns((prev) => [
        ...prev,
        { role: "agent", text: result.answer || "(no answer)", abstained: result.abstained },
      ]);
    } catch (e) {
      setTextTurns((prev) => [
        ...prev,
        { role: "agent", text: `Error reaching the agent: ${e instanceof Error ? e.message : String(e)}` },
      ]);
    } finally {
      setTextBusy(false);
    }
  }, [textInput, textBusy]);

  useEffect(() => {
    return () => {
      roomRef.current?.disconnect();
    };
  }, []);

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 flex flex-col">
      <header className="border-b border-neutral-800 px-6 py-4">
        <h1 className="text-lg font-semibold">Meridian support call</h1>
        <p className="text-sm text-neutral-400">
          Talk to Photon, Meridian&apos;s support agent — say &quot;Photon&quot; to get its
          attention, or use the text box below if audio isn&apos;t working.
        </p>
      </header>

      <main className="flex-1 grid grid-cols-1 md:grid-cols-2 gap-6 p-6">
        <section className="flex flex-col gap-4">
          {state !== "connected" ? (
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
            <div className="flex flex-col gap-4">
              <div className="flex gap-3">
                <button
                  onClick={toggleMic}
                  className={`rounded px-4 py-2 text-sm font-medium ${
                    micOn ? "bg-neutral-800" : "bg-red-900"
                  }`}
                >
                  {micOn ? "Mute mic" : "Unmute mic"}
                </button>
                <button
                  onClick={toggleScreenShare}
                  className={`rounded px-4 py-2 text-sm font-medium ${
                    screenOn ? "bg-indigo-700" : "bg-neutral-800"
                  }`}
                >
                  {screenOn ? "Stop sharing screen" : "Share screen"}
                </button>
                <button
                  onClick={disconnect}
                  className="rounded px-4 py-2 text-sm font-medium bg-neutral-800 hover:bg-neutral-700"
                >
                  Leave
                </button>
              </div>

              <div>
                <h2 className="text-sm font-medium text-neutral-400 mb-2">Live captions</h2>
                <div className="bg-neutral-900 border border-neutral-800 rounded p-3 h-40 overflow-y-auto text-sm space-y-1">
                  {captions.length === 0 && <p className="text-neutral-600">…</p>}
                  {captions.map((c, i) => (
                    <p key={i}>{c}</p>
                  ))}
                </div>
              </div>
            </div>
          )}

          <div ref={audioContainerRef} className="hidden" />
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-medium text-neutral-400">
            Text fallback (works even if audio is disabled)
          </h2>
          <div className="flex-1 bg-neutral-900 border border-neutral-800 rounded p-3 overflow-y-auto space-y-3 min-h-[300px]">
            {textTurns.map((t, i) => (
              <div key={i} className={t.role === "user" ? "text-neutral-200" : "text-indigo-300"}>
                <span className="text-xs uppercase tracking-wide text-neutral-500 mr-2">
                  {t.role}
                </span>
                {t.text}
                {t.abstained && (
                  <span className="ml-2 text-xs text-amber-400">(abstained)</span>
                )}
              </div>
            ))}
          </div>
          <div className="flex gap-2">
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
