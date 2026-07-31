import assert from "node:assert/strict";
import { test } from "node:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Sandbox } from "@vercel/sandbox";
import type { Config } from "../src/config.js";
import {
  ClaimLostError,
  DevinFleetClient,
  resolveRemoteSha,
  type QueueEntry,
} from "../src/devin.js";
import {
  claimDeadlineEpochMs,
  runSession,
  sandboxNameFor,
} from "../src/session.js";
import { toSandboxNetworkPolicy } from "../src/network-policy.js";

const ENTRY = {
  metadata: { session_id: "devin-abc123", outpost_id: "outpost_env-1", created_at: 1, updated_at: 1 },
  spec: { kind: "new", platform: "linux", remote_binary_sha: null },
  status: {
    phase: "pending",
    acceptor_id: null,
    claim_deadline: null,
    session_status: "pending",
  },
};

const CONFIG: Config = {
  devinToken: "cog_test",
  outpostId: "outpost_env-1",
  devinApiUrl: "https://api.devin.ai",
  staticBaseUrl: "https://static.devin.ai/devin-rs/remote",
  acceptorId: "worker-1",
  sandboxRuntime: "node24",
  sandboxVcpus: 2,
  sandboxTimeoutMs: 20 * 60 * 1000,
  pollIntervalMs: 1,
  maxConcurrent: 5,
};

function claimedEntry(
  claimDeadline: number | string | null = Math.floor(Date.now() / 1000) + 60,
): QueueEntry {
  return {
    metadata: {
      session_id: "devin-abc123",
      outpost_id: "outpost_env-1",
      created_at: 1,
      updated_at: 1,
    },
    spec: {
      kind: "new",
      platform: "linux",
      remote_binary_sha: "deadbeef123",
    },
    status: {
      phase: "claimed",
      acceptor_id: CONFIG.acceptorId,
      claim_deadline: claimDeadline,
      session_status: "running",
      connect_token: "connect-token",
      gateway_url: "wss://outpost-gateway.devin.ai",
    },
  };
}

function fakeClient(options: {
  statuses?: Array<QueueEntry["status"]["session_status"] | null>;
} = {}): {
  client: DevinFleetClient;
  releases: string[];
} {
  const releases: string[] = [];
  const statuses = [...(options.statuses ?? ["suspended"])];
  const client = {
    async getEntry(sessionId: string): Promise<QueueEntry | null> {
      const status = statuses.shift() ?? "suspended";
      if (status === null) return null;
      const entry = claimedEntry();
      entry.metadata.session_id = sessionId;
      entry.status.session_status = status;
      return entry;
    },
    async release(sessionId: string): Promise<void> {
      releases.push(sessionId);
    },
  } as unknown as DevinFleetClient;
  return { client, releases };
}

function fakeSandbox(options: {
  bootstrapExitCode?: number;
  remoteExitCode?: number;
  remoteWaitsForever?: boolean;
  timeout?: number;
} = {}): {
  sandbox: Sandbox;
  calls: {
    stopped: number;
    extended: number;
    spawned: number;
  };
} {
  const calls = { stopped: 0, extended: 0, spawned: 0 };
  const sandbox = {
    name: "devin-abc123",
    timeout: options.timeout ?? CONFIG.sandboxTimeoutMs,
    expiresAt:
      options.timeout === undefined
        ? new Date(Date.now() + CONFIG.sandboxTimeoutMs)
        : new Date(Date.now() + options.timeout),
    async runCommand(command: string | { cmd: string }): Promise<unknown> {
      if (typeof command === "string") {
        return {
          exitCode: options.bootstrapExitCode ?? 0,
          async stderr(): Promise<string> {
            return "bootstrap stderr";
          },
        };
      }
      calls.spawned += 1;
      return {
        cmdId: "cmd-1",
        wait: options.remoteWaitsForever
          ? () => new Promise(() => {})
          : async () => ({ exitCode: options.remoteExitCode ?? 0 }),
      };
    },
    async getCommand(): Promise<never> {
      throw new Error("not expected");
    },
    async extendTimeout(): Promise<void> {
      calls.extended += 1;
    },
    async stop(): Promise<void> {
      calls.stopped += 1;
    },
  } as unknown as Sandbox;
  return { sandbox, calls };
}

function serve(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}

test("listPending pages with cursors and dedupes by session_id", async () => {
  const requests: string[] = [];
  const { url, close } = await serve((req, res) => {
    requests.push(req.url!);
    const cursor = new URL(req.url!, "http://x").searchParams.get("cursor");
    res.setHeader("content-type", "application/json");
    if (!cursor) {
      // Page-boundary duplicate: the same entry appears on both pages.
      res.end(JSON.stringify({ items: [ENTRY], cursor: "c1", has_next_page: true, total: 2 }));
    } else {
      const second = structuredClone(ENTRY);
      second.metadata.session_id = "devin-def456";
      res.end(JSON.stringify({ items: [ENTRY, second], cursor: "c2", has_next_page: false, total: 2 }));
    }
  });
  try {
    const client = new DevinFleetClient(url, "cog_test");
    const entries = await client.listPending("outpost_env-1");
    assert.equal(entries.length, 2);
    assert.deepEqual(
      entries.map((e) => e.metadata.session_id).sort(),
      ["devin-abc123", "devin-def456"],
    );
    assert.equal(requests.length, 2);
    assert.match(requests[0]!, /outpost=outpost_env-1/);
    assert.match(requests[0]!, /phase=pending/);
    assert.match(requests[1]!, /cursor=c1/);
  } finally {
    close();
  }
});

test("claim sends acceptor_id and surfaces 409 as ClaimLostError", async () => {
  let body = "";
  let auth = "";
  const { url, close } = await serve((req, res) => {
    auth = req.headers.authorization ?? "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (req.url!.endsWith("/devin-taken/claim")) {
        res.statusCode = 409;
        res.end("{}");
      } else {
        const claimed = structuredClone(ENTRY);
        claimed.status = {
          ...claimed.status,
          phase: "claimed",
          connect_token: "tok",
          gateway_url: "wss://gw",
        } as typeof claimed.status & { connect_token: string; gateway_url: string };
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(claimed));
      }
    });
  });
  try {
    const client = new DevinFleetClient(url, "cog_test");
    const claimed = await client.claim("devin-abc123", "worker-1");
    assert.equal(auth, "Bearer cog_test");
    assert.deepEqual(JSON.parse(body), { acceptor_id: "worker-1" });
    assert.equal(claimed.status.connect_token, "tok");
    assert.equal(claimed.status.gateway_url, "wss://gw");
    await assert.rejects(client.claim("devin-taken", "worker-1"), ClaimLostError);
  } finally {
    close();
  }
});

test("getEntry returns null on 404 (queue entry gone)", async () => {
  const { url, close } = await serve((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  try {
    const client = new DevinFleetClient(url, "cog_test");
    assert.equal(await client.getEntry("devin-gone"), null);
  } finally {
    close();
  }
});

test("resolveRemoteSha prefers the session's pinned SHA", async () => {
  assert.equal(await resolveRemoteSha("http://unused.invalid", "abc1234"), "abc1234");
});

test("resolveRemoteSha fetches and validates latest_linux_x64", async () => {
  const { url, close } = await serve((req, res) => {
    assert.equal(req.url, "/latest_linux_x64");
    res.end("deadbeef123\n");
  });
  try {
    assert.equal(await resolveRemoteSha(url, null), "deadbeef123");
  } finally {
    close();
  }
  const bad = await serve((_req, res) => res.end("<html>error</html>"));
  try {
    await assert.rejects(resolveRemoteSha(bad.url, null), /Unexpected SHA/);
  } finally {
    bad.close();
  }
});

test("sandboxNameFor produces stable, sanitized names", () => {
  assert.equal(sandboxNameFor("devin-Abc_123"), "devin-abc-123");
  assert.equal(sandboxNameFor("devin-abc"), sandboxNameFor("devin-abc"));
  assert.ok(sandboxNameFor("x".repeat(100)).length <= 63);
});

test("toSandboxNetworkPolicy maps Devin hostnames and IPs", () => {
  assert.equal(toSandboxNetworkPolicy(undefined), "allow-all");
  assert.equal(
    toSandboxNetworkPolicy({ enabled: true, allow: [] }),
    "deny-all",
  );
  assert.deepEqual(
    toSandboxNetworkPolicy({
      enabled: true,
      allow: [
        { hostname: "*.example.com" },
        { ipv4: "192.0.2.4" },
        { ipv4: "10.0.0.0/8" },
        { ipv6: "2001:db8::1" },
      ],
    }),
    {
      allow: ["*.example.com"],
      subnets: {
        allow: ["192.0.2.4/32", "10.0.0.0/8", "2001:db8::1/128"],
      },
    },
  );
});

test("claimDeadlineEpochMs accepts Unix seconds, milliseconds, and ISO strings", () => {
  assert.equal(claimDeadlineEpochMs(1_800_000_000), 1_800_000_000_000);
  assert.equal(claimDeadlineEpochMs(1_800_000_000_000), 1_800_000_000_000);
  assert.equal(
    claimDeadlineEpochMs("2027-01-15T08:00:00Z"),
    Date.parse("2027-01-15T08:00:00Z"),
  );
  assert.equal(claimDeadlineEpochMs(null), null);
  assert.throws(() => claimDeadlineEpochMs("not-a-deadline"), /unsupported claim deadline/);
});

test("runSession rejects an expired claim before provisioning", async () => {
  const { client, releases } = fakeClient();
  let provisioned = false;
  const result = await runSession(
    client,
    CONFIG,
    claimedEntry(Math.floor(Date.now() / 1000) - 1),
    {
      getOrCreateSandbox: async () => {
        provisioned = true;
        return fakeSandbox().sandbox;
      },
    },
  );

  assert.equal(result.outcome, "failed");
  assert.match(result.detail ?? "", /claim deadline expired/);
  assert.equal(provisioned, false);
  assert.deepEqual(releases, ["devin-abc123"]);
});

test("runSession treats a nonzero devin-remote exit as failure and cleans up", async () => {
  const { client, releases } = fakeClient();
  const { sandbox, calls } = fakeSandbox({ remoteExitCode: 7 });
  const result = await runSession(client, CONFIG, claimedEntry(), {
    getOrCreateSandbox: async () => sandbox,
  });

  assert.equal(result.outcome, "failed");
  assert.match(result.detail ?? "", /devin-remote exited with code 7/);
  assert.deepEqual(releases, ["devin-abc123"]);
  assert.equal(calls.spawned, 1);
  assert.equal(calls.stopped, 1);
});

test("runSession stops and releases after a bootstrap failure", async () => {
  const { client, releases } = fakeClient();
  const { sandbox, calls } = fakeSandbox({ bootstrapExitCode: 2 });
  const result = await runSession(client, CONFIG, claimedEntry(), {
    getOrCreateSandbox: async () => sandbox,
  });

  assert.equal(result.outcome, "failed");
  assert.match(result.detail ?? "", /bootstrap failed/);
  assert.deepEqual(releases, ["devin-abc123"]);
  assert.equal(calls.spawned, 0);
  assert.equal(calls.stopped, 1);
});

test("runSession restores by deterministic name and bounds snapshot retention", async () => {
  const { client, releases } = fakeClient();
  const { sandbox, calls } = fakeSandbox();
  let createOptions: Parameters<typeof Sandbox.getOrCreate>[0];
  const result = await runSession(client, CONFIG, claimedEntry(), {
    getOrCreateSandbox: async (options) => {
      createOptions = options;
      return sandbox;
    },
  });

  assert.equal(result.outcome, "completed");
  assert.equal(createOptions!.name, "devin-abc123");
  assert.deepEqual(createOptions!.keepLastSnapshots, { count: 1 });
  assert.deepEqual(releases, ["devin-abc123"]);
  assert.equal(calls.stopped, 1);
});

test("runSession extends a low timeout and stops an externally ended session", async () => {
  const { client, releases } = fakeClient({ statuses: ["running", "terminated"] });
  const { sandbox, calls } = fakeSandbox({
    remoteWaitsForever: true,
    timeout: 1,
  });
  const result = await runSession(client, CONFIG, claimedEntry(), {
    getOrCreateSandbox: async () => sandbox,
  });

  assert.equal(result.outcome, "ended-externally");
  assert.ok(calls.extended >= 1);
  assert.deepEqual(releases, ["devin-abc123"]);
  assert.equal(calls.stopped, 1);
});
