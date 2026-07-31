import { Redis } from "@upstash/redis";
import {
  decryptConnectionPayload,
  encryptConnectionPayload,
} from "./connection-crypto";

const CONNECTION_KEY = "devin-outpost-vercel:connection:v1";
const PKCE_PREFIX = "devin-outpost-vercel:pkce:v1:";

export interface DevinConnection {
  accessToken: string;
  accountId: string;
  apiBaseUrl: string;
  outpostId: string;
  outpostName: string;
  serviceUserId: string;
  connectedAt: string;
}

export interface DevinConnectionMetadata {
  accountId: string;
  apiBaseUrl: string;
  outpostId: string;
  outpostName: string;
  serviceUserId: string;
  connectedAt: string;
  source: "partner" | "environment";
}

export interface PkceTransaction {
  verifier: string;
  callbackUrl: string;
  createdAt: string;
  vercelProject?: {
    accessToken: string;
    configurationId: string;
    projectId: string;
    teamId?: string;
    nextUrl: string;
    cronSecret: string;
    connectionSecret: string;
  };
}

function redis(): Redis {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    throw new Error(
      "The Upstash integration is not configured (missing KV_REST_API_URL or KV_REST_API_TOKEN)",
    );
  }
  return new Redis({ url, token });
}

export function hasConnectionStore(): boolean {
  return Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

export async function saveDevinConnection(
  connection: DevinConnection,
): Promise<void> {
  await redis().set(CONNECTION_KEY, encryptConnectionPayload(connection));
}

export async function getDevinConnection(): Promise<DevinConnection | null> {
  if (hasConnectionStore()) {
    const stored = await redis().get<string>(CONNECTION_KEY);
    if (stored) return decryptConnectionPayload<DevinConnection>(stored);
  }

  // Never silently use credentials from a developer's local .env in a cloud
  // deployment. Hosted manual credentials require an explicit operator opt-in.
  if (
    process.env.VERCEL &&
    process.env.ALLOW_MANUAL_DEVIN_CREDENTIALS !== "true"
  ) {
    return null;
  }

  const accessToken = process.env.DEVIN_OUTPOSTS_TOKEN;
  const outpostId = process.env.DEVIN_OUTPOST_ID;
  if (!accessToken || !outpostId) return null;
  return {
    accessToken,
    outpostId,
    apiBaseUrl: process.env.DEVIN_API_URL ?? "https://api.devin.ai",
    accountId: "",
    outpostName: outpostId,
    serviceUserId: "",
    connectedAt: "",
  };
}

export async function getDevinConnectionMetadata(): Promise<DevinConnectionMetadata | null> {
  const connection = await getDevinConnection();
  if (!connection) return null;
  return {
    accountId: connection.accountId,
    apiBaseUrl: connection.apiBaseUrl,
    outpostId: connection.outpostId,
    outpostName: connection.outpostName,
    serviceUserId: connection.serviceUserId,
    connectedAt: connection.connectedAt,
    source: connection.connectedAt ? "partner" : "environment",
  };
}

export async function deleteDevinConnection(): Promise<void> {
  if (!hasConnectionStore()) return;
  await redis().del(CONNECTION_KEY);
}

export async function savePkceTransaction(
  stateId: string,
  transaction: PkceTransaction,
): Promise<void> {
  await redis().set(
    `${PKCE_PREFIX}${stateId}`,
    encryptConnectionPayload(transaction),
    { ex: 10 * 60 },
  );
}

export async function consumePkceTransaction(
  stateId: string,
): Promise<PkceTransaction | null> {
  const stored = await redis().getdel<string>(`${PKCE_PREFIX}${stateId}`);
  return stored ? decryptConnectionPayload<PkceTransaction>(stored) : null;
}
