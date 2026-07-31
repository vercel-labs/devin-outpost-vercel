import { Sandbox } from "@vercel/sandbox";
import type { Config } from "./config.js";
import {
  DevinFleetClient,
  resolveRemoteSha,
  type QueueEntry,
  type SessionStatus,
} from "./devin.js";

export const WORKSPACE_DIR = "/vercel/sandbox/workspace";
export const DEVIN_DIR = "/vercel/sandbox/.devin";

/**
 * Consecutive `suspended` liveness reads tolerated before concluding the
 * remote missed the session-end notification. The status can briefly read
 * suspended mid-session (observed by modal-devin; not in Devin's docs).
 */
const SUSPENDED_STRIKES = 3;

/** Re-reads of the final status after a clean remote exit (docs: the status
 * update can lag the exit by a few seconds, so re-read a few times). */
const FINAL_STATUS_ATTEMPTS = 5;

/** Extend the sandbox session when less than this remains. */
const TIMEOUT_HEADROOM_MS = 10 * 60 * 1000;

/**
 * Dropped `command.wait()` long-polls tolerated before giving up on the
 * remote. Observed live 2026-07-23: the wait connection drops about every
 * 15 min on an idle session (`TypeError: fetch failed`); re-attach via
 * `sandbox.getCommand()` instead of failing the serve. A genuinely dead
 * sandbox is still caught by the session_status watchdog.
 */
const WAIT_REATTACH_LIMIT = 1000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Devin documents when the claim expires but not its wire format. Live
 * reference implementations use Unix seconds; accepting milliseconds and ISO
 * strings keeps the orchestrator compatible with both observed representations.
 */
export function claimDeadlineEpochMs(
  deadline: number | string | null,
): number | null {
  if (deadline === null) return null;

  const numeric =
    typeof deadline === "number" ? deadline : Number(deadline.trim());
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric >= 1_000_000_000_000 ? numeric : numeric * 1000;
  }

  if (typeof deadline === "string") {
    const parsed = Date.parse(deadline);
    if (Number.isFinite(parsed)) return parsed;
  }

  throw new Error(`unsupported claim deadline ${JSON.stringify(deadline)}`);
}

export function assertClaimActive(
  deadline: number | string | null,
  stage: string,
): void {
  const expiresAt = claimDeadlineEpochMs(deadline);
  if (expiresAt !== null && Date.now() >= expiresAt) {
    throw new Error(`claim deadline expired before ${stage}`);
  }
}

function log(sessionId: string, message: string): void {
  console.log(`[${sessionId}] ${message}`);
}

/** Sandbox names: keep it deterministic per session for kind=resume restores. */
export function sandboxNameFor(sessionId: string): string {
  return sessionId.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 63);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function bootstrapScript(staticBaseUrl: string, sha: string): string {
  const quotedDevinDir = shellQuote(DEVIN_DIR);
  const quotedWorkspaceDir = shellQuote(WORKSPACE_DIR);
  const quotedSha = shellQuote(sha);
  const binaryUrl = shellQuote(
    `${staticBaseUrl}/devin-remote_${sha}_linux_x64`,
  );
  const checksumUrl = shellQuote(
    `${staticBaseUrl}/devin-remote_${sha}_linux_x64.sha256`,
  );
  // Exact download-and-verify sequence from the Outposts reference
  // (§Remote binary distribution), made idempotent so kind=resume sandboxes
  // restored from a snapshot skip the download when the pinned SHA matches.
  return `
set -euo pipefail
mkdir -p ${quotedDevinDir}/bin ${quotedDevinDir}/state ${quotedWorkspaceDir}
cd ${quotedDevinDir}/bin
if [ ! -x devin-remote ] || [ "$(cat devin-remote.sha 2>/dev/null)" != ${quotedSha} ]; then
  curl -fL ${binaryUrl} -o devin-remote.tmp
  curl -fsSL ${checksumUrl} -o devin-remote.sha256
  echo "$(cat devin-remote.sha256)  devin-remote.tmp" | sha256sum -c
  mv devin-remote.tmp devin-remote
  chmod +x devin-remote
  printf '%s\n' ${quotedSha} > devin-remote.sha
fi
`.trim();
}

export interface SessionResult {
  sessionId: string;
  outcome: "completed" | "ended-externally" | "failed";
  detail?: string;
}

export interface SessionDependencies {
  getOrCreateSandbox?: typeof Sandbox.getOrCreate;
}

/**
 * Serve one claimed session in a Vercel Sandbox, per the Outposts
 * orchestration loop: provision -> bootstrap -> spawn devin-remote ->
 * monitor -> release + stop.
 */
export async function runSession(
  client: DevinFleetClient,
  config: Config,
  claim: QueueEntry,
  dependencies: SessionDependencies = {},
): Promise<SessionResult> {
  const sessionId = claim.metadata.session_id;
  const { connect_token: connectToken, gateway_url: gatewayUrl } = claim.status;
  if (!connectToken || !gatewayUrl) {
    // The claim response is documented to carry both; without them the
    // remote cannot connect, so requeue the session instead of holding it.
    await releaseSafely(client, config, sessionId, "claim missing gateway credentials");
    return {
      sessionId,
      outcome: "failed",
      detail: "claim response missing connect_token/gateway_url",
    };
  }

  let sandbox: Sandbox | undefined;
  let claimHeld = true;
  let serveOver = false;
  try {
    assertClaimActive(claim.status.claim_deadline, "binary resolution");
    const sha = await resolveRemoteSha(
      config.staticBaseUrl,
      claim.spec.remote_binary_sha,
    );

    // Named + persistent (the default) so kind=resume sessions restore the
    // same filesystem the previous run snapshotted on stop.
    const getOrCreateSandbox =
      dependencies.getOrCreateSandbox ?? Sandbox.getOrCreate.bind(Sandbox);
    sandbox = await getOrCreateSandbox({
      name: sandboxNameFor(sessionId),
      runtime: config.sandboxRuntime,
      resources: { vcpus: config.sandboxVcpus },
      timeout: config.sandboxTimeoutMs,
      tags: { "devin-outpost": claim.metadata.outpost_id.slice(0, 63) },
      // Devin only resumes the latest state; without this, every sleep/stop
      // stacks another snapshot that lives out its 30-day TTL.
      keepLastSnapshots: { count: 1 },
    });
    assertClaimActive(claim.status.claim_deadline, "sandbox bootstrap");
    log(sessionId, `sandbox ${sandbox.name} ready (kind=${claim.spec.kind}, sha=${sha})`);

    const bootstrap = await sandbox.runCommand("bash", ["-c", bootstrapScript(config.staticBaseUrl, sha)]);
    if (bootstrap.exitCode !== 0) {
      throw new Error(
        `bootstrap failed (exit ${bootstrap.exitCode}): ${await bootstrap.stderr()}`,
      );
    }
    assertClaimActive(claim.status.claim_deadline, "devin-remote spawn");

    // Spawn contract (reference §Spawn contract): `devin-remote serve` with
    // exactly the DEVIN_OUTPOST_* credentials plus a per-session state dir.
    // runCommand env is additive to the sandbox's own base environment, so
    // nothing from the orchestrator's environment leaks into the agent shell.
    const remote = await sandbox.runCommand({
      cmd: `${DEVIN_DIR}/bin/devin-remote`,
      args: ["serve"],
      cwd: WORKSPACE_DIR,
      detached: true,
      env: {
        DEVIN_OUTPOST_GATEWAY_URL: gatewayUrl,
        DEVIN_OUTPOST_CONNECT_TOKEN: connectToken,
        DEVIN_OUTPOST_SESSION_ID: sessionId,
        DEVIN_REMOTE_STATE_DIR: `${DEVIN_DIR}/state/${sandboxNameFor(sessionId)}`,
      },
    });
    log(sessionId, "devin-remote serving");

    let remoteExited = false;
    // The wait long-poll rejects with an undici HeadersTimeoutError after
    // ~300s (observed live; Node's default headersTimeout). Re-attach to the
    // same command by ID (sdk-reference §sandbox.getCommand) so a transient
    // drop doesn't end the serve. `serveOver` stops the loop once the status
    // watchdog has ended the session, so it doesn't keep polling a stopped
    // sandbox.
    const remoteDone = (async () => {
      let handle = remote;
      for (let drops = 1; ; drops++) {
        try {
          return await handle.wait();
        } catch (error) {
          if (serveOver || drops >= WAIT_REATTACH_LIMIT) throw error;
          const cause = error instanceof Error && error.cause ? ` (cause: ${String(error.cause)})` : "";
          log(sessionId, `remote wait dropped (${drops}), re-attaching: ${String(error)}${cause}`);
        }
        await sleep(Math.min(drops * 2000, 30_000));
        if (serveOver) throw new Error("serve ended while re-attaching");
        try {
          handle = await sandbox.getCommand(remote.cmdId);
        } catch (error) {
          log(sessionId, `re-attach failed, will retry: ${String(error)}`);
        }
      }
    })().then((finished) => {
      remoteExited = true;
      return finished;
    });
    // The status watchdog can end the session while this promise is still
    // pending; keep a rejection handler attached so that path can't crash the
    // process with an unhandled rejection.
    remoteDone.catch(() => {});

    // Monitor per reference §lifecycle expectations: poll session_status
    // while the remote runs; kill once terminated or the entry disappears.
    let suspendedStrikes = 0;
    let endedExternally = false;
    while (!remoteExited) {
      await Promise.race([remoteDone, sleep(config.pollIntervalMs)]);
      if (remoteExited) break;

      const expiresAt = sandbox.expiresAt?.getTime();
      if (
        expiresAt !== undefined &&
        expiresAt - Date.now() < TIMEOUT_HEADROOM_MS
      ) {
        try {
          await sandbox.extendTimeout(config.sandboxTimeoutMs);
          log(sessionId, "extended sandbox timeout");
        } catch (error) {
          log(sessionId, `extendTimeout failed, retrying next poll: ${String(error)}`);
        }
      }

      let status: SessionStatus | null;
      try {
        const entry = await client.getEntry(sessionId);
        status = entry === null ? null : entry.status.session_status;
      } catch (error) {
        log(sessionId, `liveness lookup failed, retrying: ${String(error)}`);
        continue;
      }
      if (status === "suspended") {
        suspendedStrikes += 1;
        if (suspendedStrikes < SUSPENDED_STRIKES) continue;
      } else if (status !== null && status !== "terminated") {
        suspendedStrikes = 0;
        continue;
      }
      log(
        sessionId,
        `session is ${status ?? "gone from the queue"} while the remote is running; stopping sandbox`,
      );
      endedExternally = true;
      break;
    }

    if (!endedExternally) {
      const finished = await remoteDone;
      log(sessionId, `devin-remote exited with code ${finished.exitCode}`);
      if (finished.exitCode !== 0) {
        throw new Error(`devin-remote exited with code ${finished.exitCode}`);
      }
      // Docs: confirm suspended/terminated before releasing; the status can
      // lag the exit by a few seconds.
      await confirmSessionEnded(client, sessionId, config.pollIntervalMs);
    }

    await releaseSafely(client, config, sessionId, "session end");
    claimHeld = false;
    return {
      sessionId,
      outcome: endedExternally ? "ended-externally" : "completed",
    };
  } catch (error) {
    return { sessionId, outcome: "failed", detail: String(error) };
  } finally {
    serveOver = true;
    if (claimHeld) {
      // Covers provisioning/bootstrap failures: the session requeues
      // immediately instead of waiting out the claim deadline.
      await releaseSafely(client, config, sessionId, "failure cleanup");
    }
    if (sandbox) {
      try {
        await sandbox.stop(); // persistent: snapshots for a future resume
      } catch (error) {
        log(sessionId, `sandbox stop failed: ${String(error)}`);
      }
    }
  }
}

async function confirmSessionEnded(
  client: DevinFleetClient,
  sessionId: string,
  pollIntervalMs: number,
): Promise<void> {
  for (let attempt = 1; attempt <= FINAL_STATUS_ATTEMPTS; attempt++) {
    try {
      const entry = await client.getEntry(sessionId);
      const status = entry?.status.session_status;
      if (!entry || status === "suspended" || status === "terminated") return;
      log(sessionId, `final status still ${status} (${attempt}/${FINAL_STATUS_ATTEMPTS})`);
    } catch (error) {
      log(sessionId, `final status lookup failed: ${String(error)}`);
    }
    await sleep(pollIntervalMs);
  }
  log(sessionId, "session end not confirmed; releasing anyway");
}

async function releaseSafely(
  client: DevinFleetClient,
  config: Config,
  sessionId: string,
  reason: string,
): Promise<void> {
  try {
    await client.release(sessionId, config.acceptorId);
    log(sessionId, `released claim (${reason})`);
  } catch (error) {
    log(sessionId, `failed to release claim after ${reason}: ${String(error)}`);
  }
}
