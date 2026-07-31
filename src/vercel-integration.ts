import type { DevinConnection } from "./connection-store";

interface VercelAccessTokenResponse {
  access_token: string;
  team_id?: string | null;
}

export interface VercelProjectTarget {
  accessToken: string;
  configurationId: string;
  projectId: string;
  teamId?: string;
  nextUrl: string;
  cronSecret: string;
  connectionSecret: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

export function vercelIntegrationRedirectUrl(requestUrl: string): string {
  const configured = process.env.VERCEL_INTEGRATION_REDIRECT_URL;
  if (configured) return configured;
  const productionHost = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (productionHost) {
    return `https://${productionHost}/api/vercel/callback`;
  }
  return new URL("/api/vercel/callback", requestUrl).toString();
}

export async function exchangeVercelInstallationCode(
  code: string,
  redirectUri: string,
  fetcher: typeof fetch = fetch,
): Promise<{ accessToken: string; teamId?: string }> {
  const response = await fetcher("https://api.vercel.com/v2/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: required("VERCEL_INTEGRATION_CLIENT_ID"),
      client_secret: required("VERCEL_INTEGRATION_CLIENT_SECRET"),
      code,
      redirect_uri: redirectUri,
    }),
  });
  if (!response.ok) {
    throw new Error(`Vercel installation exchange failed with HTTP ${response.status}`);
  }
  const payload = (await response.json()) as Partial<VercelAccessTokenResponse>;
  if (!payload.access_token) {
    throw new Error("Vercel installation exchange is missing access_token");
  }
  return {
    accessToken: payload.access_token,
    teamId: payload.team_id ?? undefined,
  };
}

async function putProjectEnvironmentVariable(
  target: VercelProjectTarget,
  key: string,
  value: string,
  fetcher: typeof fetch,
): Promise<void> {
  const url = new URL(
    `/v10/projects/${encodeURIComponent(target.projectId)}/env`,
    "https://api.vercel.com",
  );
  url.searchParams.set("upsert", "true");
  if (target.teamId) url.searchParams.set("teamId", target.teamId);
  const response = await fetcher(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${target.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      key,
      value,
      type: "encrypted",
      target: ["production", "preview", "development"],
    }),
  });
  if (!response.ok) {
    throw new Error(
      `Vercel environment configuration failed for ${key} with HTTP ${response.status}`,
    );
  }
}

export async function configureOutpostProject(
  target: VercelProjectTarget,
  connection: DevinConnection,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const variables: Record<string, string> = {
    CRON_SECRET: target.cronSecret,
    DEVIN_CONNECTION_SECRET: target.connectionSecret,
    DEVIN_OUTPOSTS_TOKEN: connection.accessToken,
    DEVIN_OUTPOST_ID: connection.outpostId,
    DEVIN_API_URL: connection.apiBaseUrl,
    ACCEPTOR_ID: `vercel-sandbox-${connection.outpostId}`,
    ALLOW_MANUAL_DEVIN_CREDENTIALS: "true",
  };
  await Promise.all(
    Object.entries(variables).map(([key, value]) =>
      putProjectEnvironmentVariable(target, key, value, fetcher),
    ),
  );
}

export function safeVercelNextUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "vercel.com"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}
