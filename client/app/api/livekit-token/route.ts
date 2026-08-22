import { AccessToken } from "livekit-server-sdk";
import { NextRequest, NextResponse } from "next/server";

const BRAIN_API = process.env.NEXT_PUBLIC_BRAIN_API_URL || "http://localhost:8000";

/** Mints a LiveKit join token. Server-side only — holds LIVEKIT_API_SECRET,
 * which the browser never sees.
 *
 * The identity is derived from the caller's own session, NEVER from a query
 * parameter. It used to be `?identity=whatever-you-type`, which meant
 * anyone could join as anyone — and now that the agent attributes each
 * spoken turn to a participant identity (and may use that person's private
 * sources to answer), a forgeable identity would be a way to read someone
 * else's data by simply typing their name.
 *
 * Guests are still allowed: no token means a guest identity, which the
 * agent treats as viewer-level with workspace-scoped sources only.
 */
export async function GET(req: NextRequest) {
  const room = req.nextUrl.searchParams.get("room") || "photon";
  const guestName = (req.nextUrl.searchParams.get("name") || "").trim().slice(0, 40);
  const authHeader = req.headers.get("authorization");

  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const url = process.env.NEXT_PUBLIC_LIVEKIT_URL;
  if (!apiKey || !apiSecret || !url) {
    return NextResponse.json({ error: "LiveKit is not configured on the server" }, { status: 500 });
  }

  let identity: string;
  let name: string;
  let metadata: Record<string, unknown>;

  if (authHeader) {
    // Verified against the API rather than decoded here: the signing key
    // lives in the backend, and a token this route merely *parsed* would be
    // trivially forgeable.
    const me = await fetch(`${BRAIN_API}/api/auth/me`, { headers: { authorization: authHeader } });
    if (!me.ok) {
      return NextResponse.json({ error: "Your session expired — sign in again" }, { status: 401 });
    }
    const user = await me.json();
    identity = `user:${user.id}`;
    name = user.email;
    metadata = { user_id: user.id, email: user.email, guest: false };
  } else {
    if (!guestName) {
      return NextResponse.json({ error: "A name is required to join as a guest" }, { status: 400 });
    }
    // Random suffix so two guests typing the same name don't collide into
    // one LiveKit identity (which would silently disconnect the first).
    identity = `guest:${crypto.randomUUID().slice(0, 8)}`;
    name = guestName;
    metadata = { guest: true, display_name: guestName };
  }

  const at = new AccessToken(apiKey, apiSecret, {
    identity,
    name,
    ttl: "1h",
    // Read by the agent to resolve a speaker to a user without trusting
    // anything the client says at runtime — LiveKit signs this.
    metadata: JSON.stringify(metadata),
  });
  at.addGrant({ room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true });

  return NextResponse.json({ token: await at.toJwt(), url, room, identity, name });
}
