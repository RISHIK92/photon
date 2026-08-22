import { AccessToken } from "livekit-server-sdk";
import { NextRequest, NextResponse } from "next/server";

// Server-side only — holds LIVEKIT_API_SECRET. Mints a join token for the
// browser; the browser never sees the secret itself.
export async function GET(req: NextRequest) {
  const room = req.nextUrl.searchParams.get("room") || "photon";
  const identity = req.nextUrl.searchParams.get("identity");

  if (!identity) {
    return NextResponse.json({ error: "identity is required" }, { status: 400 });
  }

  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const url = process.env.NEXT_PUBLIC_LIVEKIT_URL;

  if (!apiKey || !apiSecret || !url) {
    return NextResponse.json({ error: "LiveKit is not configured on the server" }, { status: 500 });
  }

  const at = new AccessToken(apiKey, apiSecret, { identity, ttl: "1h" });
  at.addGrant({ room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true });
  const token = await at.toJwt();

  return NextResponse.json({ token, url, room, identity });
}
