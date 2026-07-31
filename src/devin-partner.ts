import { createHash, randomBytes } from "node:crypto";
import type { DevinConnection } from "./connection-store";

export interface PkcePair {
  verifier: string;
  challenge: string;
}

interface ConnectionTokenResponse {
  access_token: string;
  account_id: string;
  api_base_url: string;
  outpost_id: string;
  outpost_name: string;
  service_user_id: string;
  token_type: string;
}

export function createPkcePair(): PkcePair {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256")
    .update(verifier)
    .digest("base64url");
  return { verifier, challenge };
}

export function buildDevinConnectUrl(options: {
  callbackUrl: string;
  challenge: string;
}): URL {
  const url = new URL(
    process.env.DEVIN_CONNECT_URL ?? "https://app.devin.ai/outposts/connect",
  );
  url.searchParams.set("callback_url", options.callbackUrl);
  url.searchParams.set(
    "outpost_name",
    process.env.DEVIN_OUTPOST_NAME ?? "vercel-sandbox",
  );
  url.searchParams.set(
    "outpost_image",
    process.env.DEVIN_OUTPOST_IMAGE_URL ??
      "https://assets.vercel.com/image/upload/front/favicon/vercel/180x180.png",
  );
  url.searchParams.set("platform", "linux");
  url.searchParams.set("code_challenge", options.challenge);
  return url;
}

function requiredString(
  response: Partial<ConnectionTokenResponse>,
  key: keyof ConnectionTokenResponse,
): string {
  const value = response[key];
  if (typeof value !== "string" || !value) {
    throw new Error(`Devin connection response is missing ${key}`);
  }
  return value;
}

export async function exchangeConnectionCode(
  code: string,
  verifier: string,
  fetcher: typeof fetch = fetch,
): Promise<DevinConnection> {
  const apiUrl = (
    process.env.DEVIN_API_URL ?? "https://api.devin.ai"
  ).replace(/\/+$/, "");
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
  });
  const response = await fetcher(`${apiUrl}/outposts/connection-token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) {
    throw new Error(`Devin connection exchange failed with HTTP ${response.status}`);
  }

  const payload = (await response.json()) as Partial<ConnectionTokenResponse>;
  const tokenType = requiredString(payload, "token_type");
  if (tokenType.toLowerCase() !== "bearer") {
    throw new Error(`Unsupported Devin token type ${tokenType}`);
  }
  return {
    accessToken: requiredString(payload, "access_token"),
    accountId: requiredString(payload, "account_id"),
    apiBaseUrl: requiredString(payload, "api_base_url").replace(/\/+$/, ""),
    outpostId: requiredString(payload, "outpost_id"),
    outpostName: requiredString(payload, "outpost_name"),
    serviceUserId: requiredString(payload, "service_user_id"),
    connectedAt: new Date().toISOString(),
  };
}

export function callbackUrlFor(requestUrl: string): string {
  const configured = process.env.DEVIN_OAUTH_CALLBACK_URL;
  if (configured) return configured;
  const productionHost = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (productionHost) {
    return `https://${productionHost}/api/devin/callback`;
  }
  return new URL("/api/devin/callback", requestUrl).toString();
}
