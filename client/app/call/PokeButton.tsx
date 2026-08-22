"use client";

import { useCallback, useEffect, useState } from "react";
import { useRoomContext } from "@livekit/components-react";

/** "Ask Photon" — the multi-party addressing signal.
 *
 * LiveKit's agent session listens to exactly one participant at a time, so
 * this is not merely an intent hint: it is what tells the agent whose
 * microphone to be on. That also makes attribution certain, which matters
 * because the answer may draw on the asker's own private sources.
 *
 * The payload carries no identity on purpose — the agent reads the sender
 * from the packet, which LiveKit authenticates. Anything we put in the body
 * would be self-asserted and therefore worthless.
 */
const POKE_TOPIC = "photon.poke";
const WINDOW_SECONDS = 45;

export default function PokeButton() {
  const room = useRoomContext();
  const [until, setUntil] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (until === null) return;
    const handle = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(handle);
  }, [until]);

  const remaining = until ? Math.max(0, Math.ceil((until - now) / 1000)) : 0;
  const listening = remaining > 0;

  const poke = useCallback(async () => {
    try {
      await room.localParticipant.publishData(new Uint8Array(), {
        reliable: true,
        topic: POKE_TOPIC,
      });
      setUntil(Date.now() + WINDOW_SECONDS * 1000);
      setNow(Date.now());
    } catch {
      // Nothing to recover: the agent simply hasn't been addressed.
    }
  }, [room]);

  return (
    <button
      onClick={poke}
      className={`rounded px-3 py-1.5 text-sm font-medium border transition-colors ${
        listening
          ? "border-emerald-500/60 bg-emerald-500/10 text-emerald-300"
          : "border-indigo-500/60 bg-indigo-500/10 text-indigo-300 hover:bg-indigo-500/20"
      }`}
      title="The agent listens to you for the next 45 seconds"
    >
      {listening ? `Listening to you · ${remaining}s` : "Ask Photon"}
    </button>
  );
}
