"use client";

import { useEffect } from "react";
import { RoomEvent } from "livekit-client";
import { useRoomContext } from "@livekit/components-react";

/** Must render inside <LiveKitRoom> — useRoomContext() only resolves there.
 * Forwards STT captions out to the page so they can sit outside the
 * VideoConference prefab instead of fighting its own layout for space. */
export default function CaptionsBridge({ onCaption }: { onCaption: (text: string) => void }) {
  const room = useRoomContext();

  useEffect(() => {
    const handler = (segments: { text: string }[]) => {
      for (const s of segments) if (s.text) onCaption(s.text);
    };
    room.on(RoomEvent.TranscriptionReceived, handler);
    return () => {
      room.off(RoomEvent.TranscriptionReceived, handler);
    };
  }, [room, onCaption]);

  return null;
}
