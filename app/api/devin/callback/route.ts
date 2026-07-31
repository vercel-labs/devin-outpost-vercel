import { NextResponse } from "next/server";
import { verifyBrowserState } from "../../../../src/connection-crypto";
import {
  consumePkceTransaction,
  saveDevinConnection,
} from "../../../../src/connection-store";
import {
  callbackUrlFor,
  exchangeConnectionCode,
} from "../../../../src/devin-partner";
import { configureOutpostProject } from "../../../../src/vercel-integration";

export const runtime = "nodejs";

function errorResponse(message: string, status: number): Response {
  return new Response(message, {
    status,
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
  const cookieHeader = request.headers.get("cookie") ?? "";
  const stateCookie = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("devin_connection_state="))
    ?.slice("devin_connection_state=".length);
  if (!code || !stateCookie) {
    return errorResponse("The Devin connection callback is incomplete.", 400);
  }

  const stateId = verifyBrowserState(decodeURIComponent(stateCookie));
  if (!stateId) {
    return errorResponse("The Devin connection state is invalid.", 400);
  }
  const transaction = await consumePkceTransaction(stateId);
  if (!transaction) {
    return errorResponse("The Devin connection has expired or was already used.", 400);
  }
  if (transaction.callbackUrl !== callbackUrlFor(request.url)) {
    return errorResponse("The Devin callback URL does not match this connection.", 400);
  }

  try {
    const connection = await exchangeConnectionCode(code, transaction.verifier);
    if (transaction.vercelProject) {
      await configureOutpostProject(transaction.vercelProject, connection);
    } else {
      await saveDevinConnection(connection);
    }
  } catch (error) {
    console.error(
      "Devin connection exchange failed",
      error instanceof Error ? error.message : "unknown error",
    );
    return errorResponse("Devin could not complete the connection.", 502);
  }

  const response = NextResponse.redirect(
    transaction.vercelProject?.nextUrl ??
      new URL("/?connected=1", request.url).toString(),
    303,
  );
  response.cookies.set("devin_connection_state", "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 0,
    path: "/api/devin/callback",
  });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
