# Devin Outpost on Vercel Sandbox — integration spec

Status: draft v1 (2026-07-22, Elisabeth). Doc-grounded per /docs-ground-truth; every claim cites its source.
Goal: a custom Outposts orchestrator that serves Devin Cloud sessions inside Vercel Sandbox microVMs,
matching what Modal/E2B/Daytona/Cloudflare shipped as launch partners on 2026-07-21.

## Sources

Authoritative (Devin):
- `research/outposts-reference.md` — https://docs.devin.ai/cloud/outposts/reference (fleet API, spawn contract, binary distribution)
- `research/outposts-orchestration.md` — https://docs.devin.ai/cloud/outposts/orchestration (the loop we implement)
- `research/outposts-overview.md` — https://docs.devin.ai/cloud/outposts/overview (machine deps, integrations list)
- `research/outposts-partners.md` — https://docs.devin.ai/cloud/outposts/partners (PKCE partner flow; marked "rough notes, may change")

Authoritative (Vercel): https://vercel.com/docs/sandbox (sdk-reference, concepts/authentication,
concepts/runtimes, pricing; snapshot consulted 2026-06-30).

Secondary (working partner example, not truth): `research/modal-devin/` (modal-labs/modal-devin) and
`research/devin-outpost-k8s/` (CognitionAI reference operator).

## Architecture

One long-running Node.js daemon ("orchestrator"). No inbound ports; everything is outbound HTTPS/WSS
(overview: "Workers only need outbound HTTPS access"). Per pending session it provisions one Vercel
Sandbox, runs `devin-remote serve` inside it, and tears down on session end. This is the documented
custom-orchestrator path (orchestration.md §"Building a custom orchestrator"), NOT the CLI path — see
"Why not the CLI" below.

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

## Session lifecycle (doc-cited)

1. **Poll queue.** `GET /opbeta/outposts/devins?outpost=<id>&phase=pending`, Bearer v3 service-user
   token with `account.outposts.machine` scope (reference §Authentication, §List queued sessions).
   Upsert by `metadata.session_id`; delivery is at-least-once (reference §pagination). v1 polls every
   `POLL_INTERVAL` (5s, same default as `devin worker start --poll-interval-secs`); SSE watch is a
   listed follow-up.
2. **Filter.** Only `spec.platform == "linux"` (Sandbox is Linux x64; reference §platforms table).
3. **Claim before provisioning.** `POST /devins/{session_id}/claim {"acceptor_id"}`. Atomic CAS; 409
   means another worker won — "normal operation, not an error" (orchestration §Centralization-free
   scheduling). Success returns `status.connect_token`, `status.gateway_url`, `status.claim_deadline`;
   worker must be ready before the deadline or the claim expires back to the queue (reference §Claim).
4. **Provision.** `Sandbox.getOrCreate({ name: "devin-<session_id>", runtime, resources.vcpus,
   timeout, tags })` (sdk-reference §Sandbox.getOrCreate). Named + persistent-by-default sandboxes give
   us `spec.kind == "resume"` nearly for free: stop snapshots the filesystem, get-by-name restores it
   (sdk-reference §Sandbox.create: "persistent by default"). On any provisioning failure → release the
   claim immediately (orchestration §3).
5. **Bootstrap** (one `runCommand` bash script, idempotent):
   - SHA = `spec.remote_binary_sha` if pinned, else `GET https://static.devin.ai/devin-rs/remote/latest_linux_x64`
     (reference §Remote binary distribution: "If the session's queue entry includes a spec.remote_binary_sha, use that").
   - `curl -fL .../devin-remote_${SHA}_linux_x64`, verify `.sha256` with `sha256sum -c`, `chmod +x`
     (exact commands from reference §Download and verify).
   - `git` is required (overview §Machine dependencies) and preinstalled in Sandbox (runtimes.md §Available packages). ✓
6. **Spawn** per the spawn contract (reference §Spawn contract), detached:
   - `devin-remote serve` with exactly: `DEVIN_OUTPOST_GATEWAY_URL`, `DEVIN_OUTPOST_CONNECT_TOKEN`,
     `DEVIN_OUTPOST_SESSION_ID`, plus `DEVIN_REMOTE_STATE_DIR=/vercel/sandbox/.devin/state/<session_id>`
     ("Always set this" — reference). Clean env: pass only these; do not leak orchestrator secrets
     ("Do not leak anything the agent should not be able to see" — reference).
   - cwd = `/vercel/sandbox/workspace` (repos dir; the remote clones via git — overview lists git "for
     cloning and all repository operations").
7. **Monitor** (two signals, per reference §lifecycle expectations):
   - Poll `GET /devins/{session_id}` → `status.session_status` while the remote runs; kill the sandbox
     once it reaches `terminated` or the queue entry disappears. modal-devin additionally tolerates N
     consecutive `suspended` reads before acting (their comment: status "can briefly read suspended") —
     we copy that guard (secondary source, labeled).
   - When the detached command exits (clean exit 0 = session ended), re-read `session_status` a few
     times until `suspended`/`terminated` ("the status update can lag the exit by a few seconds, so
     re-read a few times" — reference), then release the claim.
   - Extend the sandbox timeout as it runs low (`sandbox.timeout` remaining ms + `extendTimeout()`,
     sdk-reference §extendTimeout), up to the plan max.
8. **Teardown.** `sandbox.stop()` (auto-snapshot on stop for persistence). Release claim if still held.
   On SIGINT/SIGTERM: release all held claims so sessions requeue instantly (reference §Release).

## Why not `devin worker start` inside the sandbox

The CLI path would be simpler, but modal-devin's source records (comment dated, "verified live
2026-07-19") that the CLI cannot parse the claim-mode hand-off and they fell back to an undocumented
`DEVIN_REMOTE_SESSION_TOKEN` env var. That variable appears nowhere in Devin's docs. We build on the
*documented* spawn contract (`devin-remote serve` + three `DEVIN_OUTPOST_*` vars) instead. UNVERIFIED
whether the CLI bug still exists; irrelevant to our path.

## Auth & config (all via env)

| Var | Side | Source |
|---|---|---|
| `DEVIN_OUTPOSTS_TOKEN` | Devin fleet API bearer | v3 service-user token, machine scope (reference §Authentication) |
| `DEVIN_OUTPOST_ID` | which queue to serve | `devin worker outpost create` prints it (reference §CLI) |
| `DEVIN_API_URL` | default `https://api.devin.ai` | reference §Fleet API |
| `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID` | Sandbox SDK auth outside Vercel | authentication.md §Access tokens |
| `ACCEPTOR_ID` | stable worker identity; never shared across machines | orchestration §Centralization-free scheduling |
| `SANDBOX_VCPUS` (default 4), `SANDBOX_RUNTIME` (default `node24`), `SANDBOX_TIMEOUT_MS` (default 4h), `POLL_INTERVAL_MS` (default 5000), `MAX_CONCURRENT` (default 5) | sizing | sdk-reference §Sandbox.create; pricing.md |

## Fit & limits (quantified)

- Sandbox max session: 45 min Hobby / **24 h Pro+Enterprise** (pricing.md §Max Runtime Duration). Long
  Devin sessions beyond 24 h would hit the wall; suspend/resume via persistent sandboxes is the answer.
- vCPU allocation rate: Pro 200 vCPU/min → 50 concurrent 4-vCPU session starts/min (pricing.md §rate limits).
- >~16 coordinators watching one outpost → contact Cognition account team first (orchestration note).
- Outposts is alpha, multi-tenant Devin only, not Dedicated Tenant (overview §Limitations).

## v1 scope cuts (explicit)

- **Chrome/ffmpeg absent** → Devin's browser + screen-recording features unavailable (overview
  §Machine dependencies marks both optional). Follow-up: VCR custom image with Chromium + ffmpeg
  (sdk-reference `image:` param).
- **`spec.network_policy` not enforced.** Queue entries carry hostname/CIDR allowlists (reference
  §Queue entry); Sandbox has `networkPolicy` on create (sdk-reference). Mapping one to the other is a
  natural v2 and a differentiator vs other partners.
- **Polling, not SSE watch.** Docs support both; watch streams end ≤5 min and need reconnect loops
  (reference §Watch semantics).
- **PKCE partner flow** (partners.md) is the productized "click Connect in Devin" experience. Needs
  Cognition to allowlist our callback URL — a Jared conversation, not code. v1 uses a manually created
  outpost + token.

## Open questions (not answerable from docs)

1. Which Vercel team/project should own the outpost sandboxes for a live test? (Billing lands there.)
2. Do we have a Devin account with Outposts (alpha) enabled? The PKCE flow needs Cognition to enable
   the account + allowlist callbacks — ask Jared in #shared-cognition.
3. Claim-deadline headroom: the deadline value is server-assigned and its typical magnitude is
   undocumented; sandbox cold start (ms) + binary download should fit comfortably, but UNVERIFIED
   until a live run.
4. Does `devin-remote` need anything beyond git at runtime that AL2023 lacks? UNVERIFIED until live run.
