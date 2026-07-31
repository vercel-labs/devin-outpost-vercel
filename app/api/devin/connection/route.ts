import { NextResponse } from "next/server";
import { setupSecretMatches } from "../../../../src/connection-crypto";
import {
  deleteDevinConnection,
  getDevinConnectionMetadata,
} from "../../../../src/connection-store";

export const runtime = "nodejs";

function bearerSecret(request: Request): string {
  const authorization = request.headers.get("authorization") ?? "";
  return authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
}

export async function GET(request: Request): Promise<Response> {
  if (!setupSecretMatches(bearerSecret(request))) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  return Response.json(
    { connection: await getDevinConnectionMetadata() },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function DELETE(request: Request): Promise<Response> {
  if (!setupSecretMatches(bearerSecret(request))) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  await deleteDevinConnection();
  return new Response(null, { status: 204 });
}

export async function POST(request: Request): Promise<Response> {
  const form = await request.formData();
  const suppliedSecret = form.get("setup_secret");
  if (
    typeof suppliedSecret !== "string" ||
    !setupSecretMatches(suppliedSecret)
  ) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  await deleteDevinConnection();
  return NextResponse.redirect(new URL("/?disconnected=1", request.url), 303);
}
