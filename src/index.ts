import { loadConfig } from "./config.js";
import { ClaimLostError, DevinFleetClient } from "./devin.js";
import { runSession } from "./session.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const config = await loadConfig();
  const client = new DevinFleetClient(config.devinApiUrl, config.devinToken);
  const active = new Map<string, Promise<unknown>>();
  let shuttingDown = false;

  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received; waiting for ${active.size} active session(s)`);
    // Sessions in flight release their own claims in runSession's cleanup;
    // stop claiming new ones and let the loop drain.
    void Promise.allSettled([...active.values()]).then(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  console.log(
    `Serving outpost ${config.outpostId} as ${config.acceptorId} ` +
      `(sandboxes: ${config.sandboxVcpus} vCPU ${config.sandboxRuntime}, ` +
      `max ${config.maxConcurrent} concurrent)`,
  );

  while (!shuttingDown) {
    try {
      if (active.size < config.maxConcurrent) {
        const pending = await client.listPending(config.outpostId);
        for (const entry of pending) {
          if (shuttingDown || active.size >= config.maxConcurrent) break;
          const sessionId = entry.metadata.session_id;
          if (active.has(sessionId)) continue;
          // Sandbox microVMs are Linux x86_64; skip sessions for other platforms.
          if (entry.spec.platform !== "linux") continue;

          let claim;
          try {
            // Claim before provisioning; a 409 means another worker won the
            // race, which is normal operation.
            claim = await client.claim(sessionId, config.acceptorId);
          } catch (error) {
            if (error instanceof ClaimLostError) continue;
            throw error;
          }
          console.log(
            `[${sessionId}] claimed (kind=${claim.spec.kind}, deadline=${claim.status.claim_deadline})`,
          );
          const task = runSession(client, config, claim)
            .then((result) => {
              console.log(
                `[${sessionId}] done: ${result.outcome}` +
                  (result.detail ? ` (${result.detail})` : ""),
              );
            })
            .finally(() => active.delete(sessionId));
          active.set(sessionId, task);
        }
      }
    } catch (error) {
      console.error(`Queue poll failed: ${String(error)}`);
    }
    await sleep(config.pollIntervalMs);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
