"use client";

/** Offered when someone enables a source that isn't connected yet.
 *
 * "Later" is a first-class choice, not a polite dismissal: people configure
 * a call thirty seconds before it starts, and forcing an OAuth detour then
 * is worse than starting without that source. Accepting leaves the call and
 * returns to it afterwards, which is why the copy says so plainly rather
 * than pretending the connection happens in place.
 */
export default function ConnectSourcePrompt({
  sourceLabel,
  inCall,
  onAccept,
  onLater,
}: {
  sourceLabel: string;
  inCall: boolean;
  onAccept: () => void;
  onLater: () => void;
}) {
  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-6 z-50">
      <div className="bg-neutral-950 border border-neutral-800 rounded-lg max-w-md w-full p-5">
        <h2 className="text-base font-semibold mb-1">Connect {sourceLabel}?</h2>
        <p className="text-sm text-neutral-400">
          {sourceLabel} isn&apos;t connected to this workspace yet, so the agent can&apos;t answer
          from it.
        </p>
        <p className="text-sm text-neutral-400 mt-2">
          {inCall
            ? `Connecting takes you to the setup page and then back into this call — the meeting code stays the same, so nobody else has to rejoin.`
            : `You'll be taken to the setup page, then back here to start the call.`}
        </p>

        <div className="flex items-center gap-3 mt-4">
          <button
            onClick={onAccept}
            className="bg-indigo-600 hover:bg-indigo-500 rounded px-4 py-2 text-sm font-medium"
          >
            Connect now
          </button>
          <button onClick={onLater} className="text-sm text-neutral-400 hover:text-neutral-100">
            Later — start without it
          </button>
        </div>
      </div>
    </div>
  );
}
