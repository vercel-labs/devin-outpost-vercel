import assert from "node:assert/strict";
import { test } from "node:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { ClaimLostError, DevinFleetClient, resolveRemoteSha } from "../src/devin.js";
import { sandboxNameFor } from "../src/session.js";

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
