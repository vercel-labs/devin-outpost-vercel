import os from "node:os";

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
  /** Queue poll cadence (ms). Same default as `devin worker start`: 5s. */
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

export function loadConfig(): Config {
  // The Sandbox SDK reads VERCEL_TOKEN / VERCEL_TEAM_ID / VERCEL_PROJECT_ID (or
  // VERCEL_OIDC_TOKEN) from the environment itself; we only validate presence
  // so failures surface at startup instead of on the first claimed session.
  if (!process.env.VERCEL_OIDC_TOKEN) {
    required("VERCEL_TOKEN");
    required("VERCEL_TEAM_ID");
    required("VERCEL_PROJECT_ID");
  }
  return {
    devinToken: required("DEVIN_OUTPOSTS_TOKEN"),
    outpostId: required("DEVIN_OUTPOST_ID"),
    devinApiUrl: process.env.DEVIN_API_URL ?? "https://api.devin.ai",
    staticBaseUrl:
      process.env.DEVIN_WORKER_STATIC_BASE_URL ??
      "https://static.devin.ai/devin-rs/remote",
    acceptorId: process.env.ACCEPTOR_ID ?? `vercel-sandbox-${os.hostname()}`,
    sandboxRuntime: process.env.SANDBOX_RUNTIME ?? "node24",
    sandboxVcpus: integer("SANDBOX_VCPUS", 4),
    sandboxTimeoutMs: integer("SANDBOX_TIMEOUT_MS", 4 * 60 * 60 * 1000),
    pollIntervalMs: integer("POLL_INTERVAL_MS", 5000),
    maxConcurrent: integer("MAX_CONCURRENT", 5),
  };
}
