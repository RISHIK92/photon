"use client";

import { useEffect, useRef } from "react";
import type { Caption } from "@/lib/captions";

/** The live transcript, with the two sides visually separated: the human
 * speaker on the left in slate, Photon on the right in indigo, each with its
 * own avatar, name label and bubble. Interim (non-final) segments render
 * dimmed with a pulsing caret so it's obvious which line is still being
 * transcribed rather than settled. */
export default function CaptionsPanel({
  captions,
  connected = true,
}: {
  captions: Caption[];
  connected?: boolean;
}) {
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [captions]);

  return (
    <div className="flex flex-col min-h-0">
      <div className="flex items-center justify-between mb-1 shrink-0">
        <h2 className="text-xs uppercase tracking-wide text-neutral-500">Live transcript</h2>
        <div className="flex items-center gap-3 text-[10px] text-neutral-500">
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-slate-400" /> Caller
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-indigo-400" /> Photon
          </span>
        </div>
      </div>

      <div className="bg-neutral-900 border border-neutral-800 rounded p-3 h-36 overflow-y-auto space-y-2">
        {captions.length === 0 && (
          <p className="text-neutral-600 text-xs">
            {connected ? "Waiting for someone to speak…" : "Join the call to see live captions."}
          </p>
        )}
        {captions.map((c) => (
          <CaptionRow key={c.id} caption={c} />
        ))}
        <div ref={endRef} />
      </div>
    </div>
  );
}

function CaptionRow({ caption }: { caption: Caption }) {
  const isAgent = caption.speaker === "agent";
  return (
    <div className={`flex gap-2 ${isAgent ? "flex-row-reverse" : "flex-row"}`}>
      <div
        className={`shrink-0 w-6 h-6 rounded-full grid place-items-center text-[10px] font-semibold ${
          isAgent ? "bg-indigo-600 text-white" : "bg-slate-600 text-white"
        }`}
        aria-hidden
      >
        {isAgent ? "P" : caption.name.slice(0, 1).toUpperCase()}
      </div>

      <div className={`max-w-[80%] flex flex-col ${isAgent ? "items-end" : "items-start"}`}>
        <span
          className={`text-[10px] font-medium mb-0.5 ${
            isAgent ? "text-indigo-300" : "text-slate-300"
          }`}
        >
          {caption.name}
        </span>
        <div
          className={`rounded-lg px-2.5 py-1.5 text-xs leading-relaxed ${
            isAgent
              ? "bg-indigo-500/15 border border-indigo-500/40 text-indigo-50 rounded-tr-none"
              : "bg-slate-500/10 border border-slate-600/50 text-neutral-100 rounded-tl-none"
          } ${caption.final ? "" : "opacity-70 italic"}`}
        >
          {caption.text}
          {!caption.final && <span className="ml-1 inline-block animate-pulse">▍</span>}
        </div>
      </div>
    </div>
  );
}
