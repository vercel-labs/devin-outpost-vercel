import { Sandbox } from "@vercel/sandbox";
import { start } from "workflow/api";
import { loadConfig } from "./config";
import { DevinFleetClient } from "./devin";
import { serveSessionWorkflow } from "../workflows/session";

async function activeSandboxCount(outpostId: string): Promise<number> {
  const listed = await Sandbox.list({
    tags: { "devin-outpost": outpostId.slice(0, 63) },
  });
  const sandboxes = await listed.toArray();
  return sandboxes.filter((sandbox) =>
    ["pending", "running", "stopping", "snapshotting"].includes(sandbox.status),
  ).length;
}

export async function dispatchPendingSessions(
  excludedSessionIds: string[],
): Promise<string[]> {
  const config = await loadConfig();
  const fleet = new DevinFleetClient(config.devinApiUrl, config.devinToken);
  const capacity = Math.max(
    0,
    config.maxConcurrent - (await activeSandboxCount(config.outpostId)),
  );
  if (capacity === 0) {
    console.log("Hosted dispatcher is at sandbox capacity");
    return [];
  }

  const excluded = new Set(excludedSessionIds);
  const pending = (await fleet.listPending(config.outpostId))
    .filter(
      (entry) =>
        entry.spec.platform === "linux" &&
        !excluded.has(entry.metadata.session_id),
    )
    .slice(0, capacity);

  const started: string[] = [];
  for (const entry of pending) {
    const sessionId = entry.metadata.session_id;
    const run = await start(serveSessionWorkflow, [sessionId]);
    console.log(`[${sessionId}] queued hosted workflow ${run.runId}`);
    started.push(sessionId);
  }
  return started;
}
