import os from "node:os";
import { getDevinConnection } from "./connection-store";

export interface Config {
  /** v3 service-user token with the `account.outposts.machine` scope. */
  devinToken: string;
  /** Outpost to serve (`outpost_env-...`). */
  outpostId: string;
  /** Devin API base URL. */
  devinApiUrl: string;
  /** Base URL devin-remote binaries are published to. */
  staticBaseUrl: string;
  /** Stable worker identity for claims. Never share across machines. */
  acceptorId: string;
  /** Sandbox sizing. */
  sandboxRuntime: string;
  sandboxVcpus: number;
  sandboxTimeoutMs: number;
  /** Queue and session-status poll cadence (ms). */
  pollIntervalMs: number;
  /** Max sessions served concurrently by this orchestrator. */
  maxConcurrent: number;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function integer(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got ${raw}`);
  }
  return parsed;
}

export async function loadConfig(): Promise<Config> {
  const connection = await getDevinConnection();
  if (!connection) {
    throw new Error(
      "No Devin connection. Connect Devin in the deployed setup page or set DEVIN_OUTPOSTS_TOKEN and DEVIN_OUTPOST_ID.",
    );
  }
  // In a deployed Vercel Function, the Sandbox SDK obtains OIDC from the
  // request context. It is not guaranteed to exist in process.env. Outside
  // Vercel, require either a pulled OIDC token or explicit API credentials.
  if (!process.env.VERCEL && !process.env.VERCEL_OIDC_TOKEN) {
    required("VERCEL_TOKEN");
    required("VERCEL_TEAM_ID");
    required("VERCEL_PROJECT_ID");
  }
  return {
    devinToken: connection.accessToken,
    outpostId: connection.outpostId,
    devinApiUrl: connection.apiBaseUrl,
    staticBaseUrl:
      process.env.DEVIN_WORKER_STATIC_BASE_URL ??
      "https://static.devin.ai/devin-rs/remote",
    acceptorId:
      process.env.ACCEPTOR_ID ??
      (process.env.VERCEL
        ? `vercel-sandbox-${connection.outpostId}`
        : `vercel-sandbox-${os.hostname()}`),
    sandboxRuntime: process.env.SANDBOX_RUNTIME ?? "node24",
    // Cognition documents no machine size minimum (overview §Machine
    // dependencies), so default to the cheapest sensible box; bump per
    // outpost via SANDBOX_VCPUS for heavier repos.
    sandboxVcpus: integer("SANDBOX_VCPUS", 2),
    // Short timeout + the extend loop caps stranded-sandbox cost when the
    // orchestrator dies without cleanup. Mid-session timeout death is cheap:
    // the stop snapshots, the session requeues, the next claim restores.
    sandboxTimeoutMs: integer("SANDBOX_TIMEOUT_MS", 20 * 60 * 1000),
    // Match Modal's Devin Outpost scheduler default.
    pollIntervalMs: integer("POLL_INTERVAL_MS", 3000),
    maxConcurrent: integer("MAX_CONCURRENT", 5),
  };
}
