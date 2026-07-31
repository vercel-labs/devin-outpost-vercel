import { NextResponse } from "next/server";
import { verifyBrowserState } from "../../../../src/connection-crypto";
import { getVercelCompletion } from "../../../../src/connection-store";

export const runtime = "nodejs";

function stateCookie(request: Request): string | undefined {
  return (request.headers.get("cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("devin_connection_state="))
    ?.slice("devin_connection_state=".length);
}

export async function GET(request: Request): Promise<Response> {
  const cookie = stateCookie(request);
  const stateId = cookie
    ? verifyBrowserState(decodeURIComponent(cookie))
    : null;
  if (!stateId) {
    return Response.json({ status: "invalid" }, { status: 400 });
  }

  const completion = await getVercelCompletion(stateId);
  if (!completion) {
    return Response.json(
      { status: "pending" },
      { status: 202, headers: { "Cache-Control": "no-store" } },
    );
  }

  const response = NextResponse.json(completion);
  response.cookies.set("devin_connection_state", "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 0,
    path: "/api",
  });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
