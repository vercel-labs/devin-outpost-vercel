import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import {
  setupSecretMatches,
  signBrowserState,
} from "../../../../src/connection-crypto";
import { savePkceTransaction } from "../../../../src/connection-store";
import {
  buildDevinConnectUrl,
  callbackUrlFor,
  createPkcePair,
} from "../../../../src/devin-partner";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  const form = await request.formData();
  const suppliedSecret = form.get("setup_secret");
  if (
    typeof suppliedSecret !== "string" ||
    !setupSecretMatches(suppliedSecret)
  ) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const callbackUrl = callbackUrlFor(request.url);
  const stateId = randomBytes(24).toString("base64url");
  const pkce = createPkcePair();
  await savePkceTransaction(stateId, {
    verifier: pkce.verifier,
    callbackUrl,
    createdAt: new Date().toISOString(),
  });

  const response = NextResponse.redirect(
    buildDevinConnectUrl({
      callbackUrl,
      challenge: pkce.challenge,
    }),
    303,
  );
  response.cookies.set("devin_connection_state", signBrowserState(stateId), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 10 * 60,
    path: "/api/devin/callback",
  });
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}
