import { APIError, Sandbox } from "@vercel/sandbox";
import { FatalError } from "workflow";
import { loadConfig } from "../src/config.js";
import {
  ClaimLostError,
  DevinFleetClient,
  resolveRemoteSha,
  type SessionStatus,
} from "../src/devin.js";
import { toSandboxNetworkPolicy } from "../src/network-policy.js";
import {
  assertClaimActive,
  bootstrapScript,
  DEVIN_DIR,
  sandboxNameFor,
  WORKSPACE_DIR,
} from "../src/session.js";

const TIMEOUT_HEADROOM_MS = 10 * 60 * 1000;

async function client(): Promise<{
  config: Awaited<ReturnType<typeof loadConfig>>;
  fleet: DevinFleetClient;
}> {
  const config = await loadConfig();
  return {
    config,
    fleet: new DevinFleetClient(config.devinApiUrl, config.devinToken),
  };
}

function runnerDirectory(sessionId: string): string {
  return `${DEVIN_DIR}/runner/${sandboxNameFor(sessionId)}`;
}

async function getSandboxIfPresent(name: string): Promise<Sandbox | undefined> {
  try {
    return await Sandbox.get({ name, resume: false });
  } catch (error) {
    if (error instanceof APIError && error.response.status === 404) {
      return undefined;
    }
    throw error;
  }
}

function remoteSupervisorScript(sessionId: string): string {
  const runnerDir = runnerDirectory(sessionId);
  return `
set -euo pipefail
mkdir -p '${runnerDir}'
exec 9>'${runnerDir}/launch.lock'
if ! flock -n 9; then
  exit 0
fi
rm -f '${runnerDir}/exit-code'
printf '%s\n' "$$" > '${runnerDir}/supervisor.pid'
set +e
'${DEVIN_DIR}/bin/devin-remote' serve
code=$?
set -e
printf '%s\n' "$code" > '${runnerDir}/exit-code'
rm -f '${runnerDir}/supervisor.pid'
exit "$code"
`.trim();
}

export type StartSessionResult =
  | {
      started: true;
      sandboxName: string;
      pollIntervalMs: number;
    }
  | {
      started: false;
      reason: "claim-lost" | "failed";
      detail: string;
    };

export async function provisionAndStartSessionStep(
  sessionId: string,
): Promise<StartSessionResult> {
  "use step";

  const { config, fleet } = await client();
  let sandbox: Sandbox | undefined;
  let claimHeld = false;
  try {
    const queued = await fleet.getEntry(sessionId);
    if (!queued || queued.spec.platform !== "linux") {
      throw new FatalError("session is no longer a pending Linux session");
    }

    const claim = await fleet.claim(sessionId, config.acceptorId);
    claimHeld = true;
    const connectToken = claim.status.connect_token;
    const gatewayUrl = claim.status.gateway_url;
    if (!connectToken || !gatewayUrl) {
      throw new FatalError("claim response is missing gateway credentials");
    }

    assertClaimActive(claim.status.claim_deadline, "binary resolution");
    const sha = await resolveRemoteSha(
      config.staticBaseUrl,
      claim.spec.remote_binary_sha,
    );
    const sandboxName = sandboxNameFor(sessionId);
    sandbox = await Sandbox.getOrCreate({
      name: sandboxName,
      runtime: config.sandboxRuntime,
      resources: { vcpus: config.sandboxVcpus },
      timeout: config.sandboxTimeoutMs,
      networkPolicy: toSandboxNetworkPolicy(claim.spec.network_policy),
      tags: { "devin-outpost": claim.metadata.outpost_id.slice(0, 63) },
      keepLastSnapshots: { count: 1 },
    });
    assertClaimActive(claim.status.claim_deadline, "sandbox bootstrap");

    const bootstrap = await sandbox.runCommand("bash", [
      "-c",
      bootstrapScript(config.staticBaseUrl, sha),
    ]);
    if (bootstrap.exitCode !== 0) {
      throw new Error(
        `bootstrap failed (exit ${bootstrap.exitCode}): ${await bootstrap.stderr()}`,
      );
    }
    assertClaimActive(claim.status.claim_deadline, "devin-remote spawn");

    await sandbox.runCommand({
      cmd: "bash",
      args: ["-c", remoteSupervisorScript(sessionId)],
      cwd: WORKSPACE_DIR,
      detached: true,
      env: {
        DEVIN_OUTPOST_GATEWAY_URL: gatewayUrl,
        DEVIN_OUTPOST_CONNECT_TOKEN: connectToken,
        DEVIN_OUTPOST_SESSION_ID: sessionId,
        DEVIN_REMOTE_STATE_DIR: `${DEVIN_DIR}/state/${sandboxName}`,
      },
    });
    console.log(`[${sessionId}] devin-remote started in sandbox ${sandboxName}`);
    return {
      started: true,
      sandboxName,
      pollIntervalMs: config.pollIntervalMs,
    };
  } catch (error) {
    if (claimHeld) {
      try {
        await fleet.release(sessionId, config.acceptorId);
      } catch (releaseError) {
        console.error(
          `[${sessionId}] release after start failure failed`,
          releaseError,
        );
      }
    }
    if (sandbox) {
      try {
        await sandbox.stop();
      } catch (stopError) {
        console.error(`[${sessionId}] stop after start failure failed`, stopError);
      }
    }
    if (error instanceof ClaimLostError) {
      console.log(`[${sessionId}] another worker won the claim`);
      return {
        started: false,
        reason: "claim-lost",
        detail: error.message,
      };
    }
    if (error instanceof FatalError) {
      return {
        started: false,
        reason: "failed",
        detail: error.message,
      };
    }
    throw error;
  }
}

export interface SessionProbe {
  queueStatus: SessionStatus | null;
  remoteState: "running" | "exited";
  exitCode: number | null;
}

export async function monitorSessionStep(
  sessionId: string,
  sandboxName: string,
): Promise<SessionProbe> {
  "use step";

  const { config, fleet } = await client();
  const sandbox = await getSandboxIfPresent(sandboxName);
  if (!sandbox || sandbox.status !== "running") {
    return {
      queueStatus:
        (await fleet.getEntry(sessionId))?.status.session_status ?? null,
      remoteState: "exited",
      exitCode: 1,
    };
  }

  const expiresAt = sandbox.expiresAt?.getTime();
  if (
    expiresAt !== undefined &&
    expiresAt - Date.now() < TIMEOUT_HEADROOM_MS
  ) {
    await sandbox.extendTimeout(config.sandboxTimeoutMs);
    console.log(`[${sessionId}] extended sandbox timeout`);
  }

  const runnerDir = runnerDirectory(sessionId);
  const process = await sandbox.runCommand("bash", [
    "-c",
    `if [ -s '${runnerDir}/exit-code' ]; then printf 'exited:'; cat '${runnerDir}/exit-code'; elif [ -s '${runnerDir}/supervisor.pid' ] && kill -0 "$(cat '${runnerDir}/supervisor.pid')" 2>/dev/null; then printf 'running'; else printf 'exited:1'; fi`,
  ]);
  if (process.exitCode !== 0) {
    throw new Error(`failed to inspect devin-remote in ${sandboxName}`);
  }

  const processState = (await process.stdout()).trim();
  const queueStatus =
    (await fleet.getEntry(sessionId))?.status.session_status ?? null;
  if (processState === "running") {
    return { queueStatus, remoteState: "running", exitCode: null };
  }
  const match = /^exited:(-?\d+)$/.exec(processState);
  if (!match) throw new Error(`unexpected supervisor state ${processState}`);
  return {
    queueStatus,
    remoteState: "exited",
    exitCode: Number.parseInt(match[1]!, 10),
  };
}

export async function cleanupSessionStep(
  sessionId: string,
  sandboxName: string,
  reason: string,
): Promise<void> {
  "use step";

  const { config, fleet } = await client();
  try {
    await fleet.release(sessionId, config.acceptorId);
  } catch (error) {
    console.error(`[${sessionId}] claim release failed during ${reason}`, error);
  }

  const sandbox = await getSandboxIfPresent(sandboxName);
  if (sandbox && ["pending", "running"].includes(sandbox.status)) {
    await sandbox.stop();
  }
  console.log(`[${sessionId}] hosted cleanup complete (${reason})`);
}
