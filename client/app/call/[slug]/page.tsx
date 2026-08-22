"use client";

import { use, useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import PhotonWaiting from "../PhotonWaiting";
import { getToken, knockForCall, knockStatus, type Knock } from "@/lib/api";

/** Join a call by link: /call/abcd-efgh
 *
 * The code alone does not admit anyone. It gets you to the door, and
 * someone already inside opens it — because a meeting link forwarded one
 * hop too far should not put a stranger into a live customer call.
 *
 * A signed-in workspace member is admitted immediately by the API; they
 * already have access to everything the call can reach, and making
 * colleagues queue teaches people to click Admit without reading it.
 */
export default function JoinBySlug({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const router = useRouter();

  const [name, setName] = useState("");
  const [knock, setKnock] = useState<Knock | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [signedIn, setSignedIn] = useState(false);

  useEffect(() => setSignedIn(!!getToken()), []);

  const enter = useCallback(
    (knockId?: string) => {
      // The call page mints the LiveKit token, and for a guest it needs the
      // admission proof — the token route verifies it server-side.
      const params = new URLSearchParams({ code: slug });
      if (knockId) params.set("knock", knockId);
      if (name.trim()) params.set("name", name.trim());
      router.replace(`/call?${params}`);
    },
    [router, slug, name]
  );

  const ask = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await knockForCall(slug, name.trim());
      setKnock(result);
      if (result.status === "admitted") enter(result.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // A signed-in member should not have to type their name to join their own
  // team's call, so ask on their behalf as soon as we know who they are.
  useEffect(() => {
    if (signedIn && !knock && !busy) ask();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn]);

  // Poll while waiting. Polling rather than a socket: the waiter is not in
  // the room yet, so there is no room connection to listen on.
  useEffect(() => {
    if (!knock || knock.status !== "pending") return;
    const handle = setInterval(async () => {
      try {
        const next = await knockStatus(slug, knock.id);
        if (next.status !== "pending") {
          setKnock(next);
          if (next.status === "admitted") enter(next.id);
        }
      } catch {
        /* transient; keep waiting rather than dumping someone out of the queue */
      }
    }, 2000);
    return () => clearInterval(handle);
  }, [knock, slug, enter]);

  if (knock && knock.status !== "admitted") {
    return (
      <div className="min-h-screen bg-neutral-950 text-neutral-100">
        <PhotonWaiting
          meetingCode={slug}
          name={name || "you"}
          denied={knock.status === "denied"}
        />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 flex items-center justify-center px-6">
      <div className="w-full max-w-sm">
        <p className="text-xs uppercase tracking-wide text-neutral-500">Joining call</p>
        <h1 className="text-2xl font-mono mt-1">{slug}</h1>
        <p className="text-sm text-neutral-400 mt-2 mb-6">
          Someone in the call will be asked to let you in.
        </p>

        <input
          className="w-full bg-neutral-900 border border-neutral-700 rounded px-3 py-2 text-sm mb-3"
          placeholder="Your name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && name.trim() && ask()}
          autoFocus
        />
        <button
          onClick={ask}
          disabled={busy || !name.trim()}
          className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 rounded px-4 py-2 text-sm font-medium"
        >
          {busy ? "Asking…" : "Ask to join"}
        </button>
        {error && <p className="text-red-400 text-sm mt-3">{error}</p>}
      </div>
    </div>
  );
}
