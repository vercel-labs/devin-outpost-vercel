import { sleep } from "workflow";
import {
  cleanupSessionStep,
  monitorSessionStep,
  provisionAndStartSessionStep,
} from "./steps";

const SUSPENDED_STRIKES = 3;
const FINAL_STATUS_ATTEMPTS = 5;

export interface HostedSessionResult {
  sessionId: string;
  outcome: "completed" | "ended-externally" | "failed" | "claim-lost";
  detail?: string;
}

export async function serveSessionWorkflow(
  sessionId: string,
): Promise<HostedSessionResult> {
  "use workflow";

  console.log(`[${sessionId}] hosted session workflow starting`);
  const started = await provisionAndStartSessionStep(sessionId);
  if (!started.started) {
    return {
      sessionId,
      outcome: started.reason === "claim-lost" ? "claim-lost" : "failed",
      detail: started.detail,
    };
  }

  let suspendedStrikes = 0;
  let finalStatusAttempts = 0;
  for (;;) {
    await sleep(`${started.pollIntervalMs}ms`);
    const probe = await monitorSessionStep(sessionId, started.sandboxName);

    if (probe.queueStatus === "suspended") {
      suspendedStrikes += 1;
    } else if (
      probe.queueStatus !== null &&
      probe.queueStatus !== "terminated"
    ) {
      suspendedStrikes = 0;
    }

    if (
      probe.queueStatus === null ||
      probe.queueStatus === "terminated" ||
      suspendedStrikes >= SUSPENDED_STRIKES
    ) {
      await cleanupSessionStep(sessionId, started.sandboxName, "session end");
      return { sessionId, outcome: "ended-externally" };
    }

    if (probe.remoteState === "running") continue;

    if (probe.exitCode !== 0) {
      await cleanupSessionStep(
        sessionId,
        started.sandboxName,
        `devin-remote exit ${probe.exitCode}`,
      );
      return {
        sessionId,
        outcome: "failed",
        detail: `devin-remote exited with code ${probe.exitCode}`,
      };
    }

    finalStatusAttempts += 1;
    if (
      probe.queueStatus === "suspended" ||
      finalStatusAttempts >= FINAL_STATUS_ATTEMPTS
    ) {
      await cleanupSessionStep(
        sessionId,
        started.sandboxName,
        "clean remote exit",
      );
      return { sessionId, outcome: "completed" };
    }
  }
}
