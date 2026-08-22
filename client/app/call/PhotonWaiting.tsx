"use client";

/** The waiting state, in the landing page's visual language.
 *
 * A spinner would say "something is happening". This has to say something
 * more specific: a person is being asked, and the wait ends when they
 * answer — not on a timer. So the streak repeats rather than spins, and the
 * copy names who is deciding.
 */
export default function PhotonWaiting({
  meetingCode,
  name,
  denied,
}: {
  meetingCode: string;
  name: string;
  denied?: boolean;
}) {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] text-center px-6">
      <div className="relative w-full max-w-sm h-16 mb-8 overflow-hidden">
        {!denied && (
          <>
            <span className="l-photon-loop" />
            <span className="l-ring-loop" />
          </>
        )}
      </div>

      {denied ? (
        <>
          <h1 className="text-lg font-semibold text-neutral-100">Not admitted</h1>
          <p className="text-sm text-neutral-400 mt-2 max-w-sm">
            Someone in the call declined this request. If that wasn&apos;t expected, ask them
            directly — requesting again won&apos;t change it.
          </p>
        </>
      ) : (
        <>
          <h1 className="text-lg font-semibold text-neutral-100">Waiting to be let in</h1>
          <p className="text-sm text-neutral-400 mt-2 max-w-sm">
            Someone already in <span className="font-mono text-neutral-300">{meetingCode}</span> has
            to admit you. They&apos;ll see you as{" "}
            <span className="text-neutral-200">{name}</span>.
          </p>
          <p className="text-xs text-neutral-600 mt-4">
            Keep this open — you&apos;ll join automatically the moment they do.
          </p>
        </>
      )}
    </div>
  );
}
