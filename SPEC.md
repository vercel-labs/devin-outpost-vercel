# Devin Outpost on Vercel Sandbox - integration spec

Status: core lifecycle implemented and live-tested; public partner packaging is
pending.

Goal: serve Devin Cloud sessions inside Vercel Sandbox microVMs through a
custom Outposts orchestrator.

## Sources

Authoritative (Devin):

- [Reference](https://docs.devin.ai/cloud/outposts/reference): Fleet API,
  binary distribution, and spawn contract.
- [Orchestration](https://docs.devin.ai/cloud/outposts/orchestration): queue,
  claim, worker, and teardown lifecycle.
- [Overview](https://docs.devin.ai/cloud/outposts/overview): requirements and
  limitations.
- [Partner integrations](https://docs.devin.ai/cloud/outposts/partners): PKCE
  connection flow. Cognition marks this flow as early and subject to change.

Authoritative (Vercel):

- [Vercel Sandbox](https://vercel.com/docs/sandbox): authentication, runtimes,
  SDK, persistence, pricing, and limits.

Local snapshots of the Devin pages are stored under `research/`.

## Architecture

One long-running Node.js daemon watches a Devin outpost queue. For each pending
session, it provisions one Vercel Sandbox, runs `devin-remote serve`, and stops
the sandbox when the session ends. The worker needs outbound HTTPS and WSS; it
does not expose an inbound port.

```
Devin Cloud (agent loop + queue)            Orchestrator (this repo)             Vercel Sandbox
 GET  /opbeta/outposts/devins?phase=pending ──poll──▶ pick pending linux session
 POST /devins/{id}/claim {acceptor_id}      ◀─claim── (409 = lost race, skip)
   └─ returns connect_token + gateway_url            Sandbox.getOrCreate(devin-<id>)
                                                     bootstrap: curl devin-remote + sha256 -c
                                                     runCommand detached: devin-remote serve ─▶ wss──▶ outpost gateway
 GET /devins/{id} (session_status poll)     ◀─watchdog loop─┐
 POST /devins/{id}/release                  ◀─on exit────── └─ sandbox.stop() (persistent snapshot)
```

## Session lifecycle

1. **Poll queue.** `GET /opbeta/outposts/devins?outpost=<id>&phase=pending`, Bearer v3 service-user
   token with `account.outposts.machine` scope (reference §Authentication, §List queued sessions).
   Upsert by `metadata.session_id`; delivery is at-least-once. The current
   implementation polls every 5 seconds. Devin also supports a reconnecting SSE
   watch.
2. **Filter.** Only `spec.platform == "linux"` (Sandbox is Linux x64; reference §platforms table).
3. **Claim before provisioning.** `POST /devins/{session_id}/claim {"acceptor_id"}`. Atomic CAS; 409
   means another worker won. Success returns `status.connect_token`,
   `status.gateway_url`, and `status.claim_deadline`. The worker must be ready
   before that deadline or the claim returns to the queue.
4. **Provision.** `Sandbox.getOrCreate({ name: "devin-<session_id>", runtime, resources.vcpus,
   timeout, tags, keepLastSnapshots })`. The deterministic name restores the
   session's latest persistent snapshot regardless of whether Devin reports
   `spec.kind` as `new` or `resume`. Provisioning failures release the claim.
5. **Bootstrap** (one `runCommand` bash script, idempotent):
   - SHA = `spec.remote_binary_sha` if pinned, else `GET https://static.devin.ai/devin-rs/remote/latest_linux_x64`
     (reference §Remote binary distribution).
   - `curl -fL .../devin-remote_${SHA}_linux_x64`, verify `.sha256` with `sha256sum -c`, `chmod +x`
     (reference §Download and verify).
   - `git` is required by Devin and preinstalled in the Sandbox runtime.
6. **Spawn** per the spawn contract (reference §Spawn contract), detached:
   - `devin-remote serve` with exactly: `DEVIN_OUTPOST_GATEWAY_URL`, `DEVIN_OUTPOST_CONNECT_TOKEN`,
     `DEVIN_OUTPOST_SESSION_ID`, plus `DEVIN_REMOTE_STATE_DIR=/vercel/sandbox/.devin/state/<session_id>`
     as strongly recommended by Devin.
   - cwd = `/vercel/sandbox/workspace`.
7. **Monitor** using two signals:
   - Poll `GET /devins/{session_id}` → `status.session_status` while the remote runs; kill the sandbox
     once it reaches `terminated` or the queue entry disappears. The
     implementation tolerates three consecutive `suspended` reads before
     acting because this status was observed transiently during live testing.
   - When the detached command exits (clean exit 0 = session ended), re-read `session_status` a few
     times until `suspended`/`terminated`, then release the claim.
   - Extend the sandbox timeout as it runs low (`sandbox.timeout` remaining ms + `extendTimeout()`,
     SDK reference §extendTimeout), up to the plan max.
8. **Teardown.** `sandbox.stop()` (auto-snapshot on stop for persistence). Release claim if still held.
   The deployed service must allow cleanup to complete during graceful
   shutdown. If the process dies, the claim expires and the 20-minute sandbox
   timeout limits stranded compute.

## Auth & config (all via env)

| Var | Side | Source |
|---|---|---|
| `DEVIN_OUTPOSTS_TOKEN` | Devin fleet API bearer | v3 service-user token, machine scope (reference §Authentication) |
| `DEVIN_OUTPOST_ID` | which queue to serve | `devin worker outpost create` prints it (reference §CLI) |
| `DEVIN_API_URL` | default `https://api.devin.ai` | reference §Fleet API |
| `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID` | Sandbox SDK auth outside Vercel | authentication.md §Access tokens |
| `ACCEPTOR_ID` | stable worker identity; set explicitly in production and never share across machines | reference §CLI |
| `SANDBOX_VCPUS` (default 2), `SANDBOX_RUNTIME` (default `node24`), `SANDBOX_TIMEOUT_MS` (default 1200000), `POLL_INTERVAL_MS` (default 5000), `MAX_CONCURRENT` (default 5) | sizing | Sandbox SDK |

## Verified behavior

Live testing on July 22-23, 2026 verified:

- Claim, Sandbox provisioning, binary download and SHA verification, and
  `devin-remote` connection.
- Clean suspend, automatic snapshot on stop, restore, and wake from the same
  filesystem state.
- Recovery from dropped `command.wait()` long polls by reattaching to the same
  detached command with `sandbox.getCommand()`.
- Upgrade to a newly pinned `devin-remote` binary after restoring a snapshot.
- Snapshot storage remains bounded with `keepLastSnapshots: { count: 1 }`.

Vercel Sandbox sessions can run for up to 24 hours on Pro and Enterprise. The
orchestrator starts with a 20-minute timeout and extends it when less than 10
minutes remain. Persistent snapshots carry the filesystem across sessions and
expire 30 days after last use by default.

## Public launch requirements and ownership

| Requirement | Owner | Status |
| --- | --- | --- |
| Supervised long-running deployment with stable `ACCEPTOR_ID` | Vercel | Open |
| Recover sessions already claimed by the same acceptor after a restart | Vercel | Open |
| Map `spec.network_policy` to Sandbox `networkPolicy` | Vercel | Open |
| Chromium + ffmpeg image for browser and recording support | Vercel | Open, if included at launch |
| PKCE callback, state validation, and encrypted token storage | Vercel | Open |
| Allowlist Vercel's exact PKCE callback URL | Cognition | Open |
| Confirm maximum suspended-session lifetime | Cognition | Open |
| Choose snapshot retention from that lifetime and cleanup behavior | Vercel | Blocked on Cognition |
| Validate public-integration acceptance criteria | Vercel + Cognition | Open |
| Coordinate changelog and co-launch | Vercel + Cognition | Open |

The current manual-token flow is suitable for continued testing and Cognition
review. It should not be presented as the finished customer-facing integration
until the required launch items above are closed.
