import { setTimeout as sleep } from "node:timers/promises";
import { loadConfig } from "../../../src/config";
import { getDevinConnection } from "../../../src/connection-store";
import { dispatchPendingSessions } from "../../../src/dispatch";

export const runtime = "nodejs";
export const maxDuration = 90;

const DISPATCH_WINDOW_MS = 57_000;

function isAuthorized(request: Request): boolean {
  const cronSecret = process.env.CRON_SECRET;
  return Boolean(
    cronSecret &&
      request.headers.get("authorization") === `Bearer ${cronSecret}`,
  );
}

export async function GET(request: Request): Promise<Response> {
  if (!isAuthorized(request)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  if (!(await getDevinConnection())) {
    return Response.json({ ok: true, configured: false, started: [] });
  }

  const config = await loadConfig();
  const pollIntervalMs = Math.max(1000, config.pollIntervalMs);
  const startedAt = Date.now();
  const deadline = startedAt + DISPATCH_WINDOW_MS;
  const started = new Set<string>();

  for (let nextPollAt = startedAt; nextPollAt <= deadline; ) {
    try {
      const batch = await dispatchPendingSessions([...started]);
      for (const sessionId of batch) started.add(sessionId);
    } catch (error) {
      console.error("Hosted queue poll failed", error);
    }

    nextPollAt += pollIntervalMs;
    if (nextPollAt > deadline) break;
    await sleep(Math.max(0, nextPollAt - Date.now()));
  }

  return Response.json({ ok: true, started: [...started] });
}
