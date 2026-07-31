import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { signBrowserState } from "../../../../src/connection-crypto";
import { savePkceTransaction } from "../../../../src/connection-store";
import {
  buildDevinConnectUrl,
  callbackUrlFor,
  createPkcePair,
} from "../../../../src/devin-partner";
import {
  exchangeVercelInstallationCode,
  safeVercelNextUrl,
  vercelIntegrationRedirectUrl,
} from "../../../../src/vercel-integration";
import { renderVercelInstallPage } from "../../../../src/vercel-install-page";

export const runtime = "nodejs";

function badRequest(message: string): Response {
  return new Response(message, {
    status: 400,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
      "Referrer-Policy": "no-referrer",
    },
  });
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const configurationId = url.searchParams.get("configurationId");
  const projectId = url.searchParams.get("currentProjectId");
  const teamId = url.searchParams.get("teamId") ?? undefined;
  const nextUrl = safeVercelNextUrl(url.searchParams.get("next") ?? "");
  if (!code || !configurationId || !projectId || !nextUrl) {
    return badRequest("The Vercel installation callback is incomplete.");
  }

  const redirectUri = vercelIntegrationRedirectUrl(request.url);
  const installation = await exchangeVercelInstallationCode(code, redirectUri);
  const stateId = randomBytes(24).toString("base64url");
  const pkce = createPkcePair();
  const callbackUrl = callbackUrlFor(request.url);
  await savePkceTransaction(stateId, {
    verifier: pkce.verifier,
    callbackUrl,
    createdAt: new Date().toISOString(),
    vercelProject: {
      accessToken: installation.accessToken,
      configurationId,
      projectId,
      teamId: teamId ?? installation.teamId,
      nextUrl,
      cronSecret: randomBytes(32).toString("base64url"),
      connectionSecret: randomBytes(32).toString("base64url"),
    },
  });

  const connectUrl = buildDevinConnectUrl({
    callbackUrl,
    challenge: pkce.challenge,
  });
  const response = new NextResponse(renderVercelInstallPage(connectUrl.toString()), {
    status: 200,
    headers: {
      "Cache-Control": "no-store",
      "Content-Security-Policy":
        "default-src 'none'; connect-src 'self'; form-action https://app.devin.ai; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      "Content-Type": "text/html; charset=utf-8",
      "Referrer-Policy": "no-referrer",
    },
  });
  response.cookies.set("devin_connection_state", signBrowserState(stateId), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 10 * 60,
    path: "/api",
  });
  return response;
}
