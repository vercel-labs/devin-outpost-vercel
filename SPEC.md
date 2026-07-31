# Devin Outpost on Vercel: integration spec

Status: the core Sandbox lifecycle is live-tested. The Fluid compute,
Workflow, Deploy Button storage, and Devin PKCE connection paths are
implemented and deployed. The live Cognition acceptance test reaches consent
and is blocked only on Cognition's callback allowlist.

## Goal

Serve Devin Cloud sessions inside Vercel Sandbox microVMs without requiring a
user-operated laptop or daemon.

## Sources

Authoritative Devin sources:

- [Reference](https://docs.devin.ai/cloud/outposts/reference)
- [Orchestration](https://docs.devin.ai/cloud/outposts/orchestration)
- [Overview](https://docs.devin.ai/cloud/outposts/overview)
- [Partner integrations](https://docs.devin.ai/cloud/outposts/partners)

Authoritative Vercel sources:

- [Vercel Sandbox](https://vercel.com/docs/sandbox)
- [Fluid compute](https://vercel.com/docs/fluid-compute)
- [Vercel Workflow](https://vercel.com/docs/workflows)
- [Cron Jobs](https://vercel.com/docs/cron-jobs)
- [Deploy Button](https://vercel.com/docs/deploy-button)

Exact snapshots of the five Devin Outposts pages are stored under `research/`.

## Cloud architecture

```text
Vercel Cron, once/minute
        |
        v
Fluid route /api/cron
        |
        +--poll every 3s for 57s---------------->  Devin queue
        |
        | starts one durable workflow per pending session
        v
session Workflow
        |
        | claim + provision + bootstrap + detached spawn
        v
named persistent Vercel Sandbox  --WSS-->  Devin Outpost gateway
        ^
        | short monitor step, then durable sleep
        +--------------------------------------
```

The dispatcher is a bounded Fluid function invocation. Long-lived execution
happens in the Sandbox. The per-session Workflow stores orchestration progress
and suspends without compute between status checks, so a session is not coupled
to one function instance or function-duration limit.

The local daemon in `src/index.ts` remains available through
`npm run start:local`, but it is not used by the cloud deployment.

## Queue and dispatch

1. Vercel Cron calls `/api/cron` on the production deployment every minute.
2. The route fails closed unless `Authorization` equals
   `Bearer $CRON_SECRET`.
3. The Fluid route lists pending sessions every `POLL_INTERVAL_MS` for 57
   seconds. The default checks at seconds 0, 3, ... 57.
4. An individual failed queue check is logged; the bounded dispatcher continues
   with its next scheduled check.
5. It filters for `spec.platform == "linux"`, checks active Sandboxes tagged
   for the outpost, and starts at most `MAX_CONCURRENT` session workflows.
6. Overlapping dispatcher invocations are safe. Devin's atomic claim is the
   final coordination primitive; a `409` means another workflow won.

The cron floor is one minute on Vercel Pro and Enterprise. The bounded Fluid
dispatcher keeps normal queue latency near three seconds, matching Modal's
default scheduler cadence, without paying for a durable Workflow step per poll.
At the default, an always-on deployment performs about 864,000 queue checks per
30-day month; operators can raise `POLL_INTERVAL_MS` to trade latency for fewer
Devin API requests.

## Session lifecycle

1. **Claim.** `POST /opbeta/outposts/devins/{session_id}/claim` with the stable
   `ACCEPTOR_ID`. Success supplies the connect token, gateway URL, and claim
   deadline.
2. **Enforce the deadline.** The implementation accepts observed Unix seconds,
   Unix milliseconds, and ISO timestamps. It checks the deadline before binary
   resolution, after Sandbox provisioning, and before remote startup.
3. **Provision.** `Sandbox.getOrCreate()` uses a deterministic per-session
   name, persistent storage, the configured runtime and vCPU count, and
   `keepLastSnapshots: { count: 1 }`.
4. **Apply network policy.** A disabled Devin policy maps to `allow-all`. An
   enabled empty policy maps to `deny-all`. Hostname globs map to domain
   allowlists, and individual IPv4/IPv6 addresses become `/32` or `/128`
   Sandbox subnet rules.
5. **Bootstrap.** Resolve the pinned `remote_binary_sha`, or Devin's latest SHA
   when absent. Download `devin-remote`, verify its SHA-256 checksum, and make
   it executable. All values interpolated into the shell script are quoted.
6. **Spawn.** Start a detached supervisor under
   `/vercel/sandbox/.devin/runner/<session>`. An advisory file lock prevents a
   retry from launching a second remote. The supervisor records its PID and
   final exit code while credentials remain command environment variables.
7. **Monitor.** The workflow sleeps between checks. Each monitor step:
   - verifies the named Sandbox is still running;
   - extends it when `sandbox.expiresAt` is less than ten minutes away;
   - reads the supervisor state;
   - reads Devin's `session_status`.
8. **End.** A missing or terminated queue entry ends immediately. Three
   consecutive suspended reads are tolerated before teardown because suspended
   was observed transiently during live testing.
9. **Exit handling.** Exit code 0 is the only clean remote exit. The workflow
   gives Devin's final status up to five reads to catch up. A nonzero exit
   returns a failed result.
10. **Cleanup.** Release the claim and stop the Sandbox. Stopping creates the
    persistent snapshot used by a future resume.

Workflow's Vercel backend encrypts workflow inputs and step results before
writing them to its event log. The gateway connect token is additionally kept
inside the claim-and-start step and is not returned as workflow state.

## Authentication and configuration

| Variable | Cloud | Local | Purpose |
| --- | --- | --- | --- |
| `DEVIN_OUTPOSTS_TOKEN` | Manual fallback | Required | v3 service-user bearer with `account.outposts.machine` |
| `DEVIN_OUTPOST_ID` | Manual fallback | Required | queue to serve |
| `ALLOW_MANUAL_DEVIN_CREDENTIALS` | Required for hosted fallback | Not used | explicit opt-in that prevents accidental use of a developer `.env` in cloud |
| `CRON_SECRET` | Required | Not used | protects the cron route |
| `DEVIN_CONNECTION_SECRET` | Optional | Not used | separate setup/encryption key; domain-separated keys derive from `CRON_SECRET` when absent |
| `DEVIN_OAUTH_CALLBACK_URL` | Recommended | Optional | fixed partner callback registered with Cognition |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | Required for PKCE | Not used | injected by the Upstash Marketplace integration |
| `ACCEPTOR_ID` | Optional | Optional | stable worker identity |
| `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID` | Not used | Required without OIDC | Sandbox SDK access-token auth |
| `SANDBOX_VCPUS`, `SANDBOX_RUNTIME`, `SANDBOX_TIMEOUT_MS`, `POLL_INTERVAL_MS`, `MAX_CONCURRENT` | Optional | Optional | sizing and cadence |

Vercel supplies OIDC authentication to Sandbox and Workflow automatically in a
deployment. The Deploy Button requests only the cron/setup secret and requires
the Upstash integration. After deployment, an administrator connects Devin:

1. A secret-protected POST creates an S256 PKCE verifier and challenge.
2. The encrypted verifier is stored in Redis with a ten-minute TTL.
3. A signed, HttpOnly, SameSite=Lax cookie binds the browser to that
   transaction. Cognition's current partner URL does not document `state`.
4. The callback atomically consumes the transaction and exchanges Cognition's
   single-use code server to server.
5. The access token and outpost metadata are encrypted with AES-256-GCM before
   Redis storage. Cron and Workflow steps load this connection at runtime.

The setup secret prevents an unauthenticated visitor from replacing a
customer's connection. Disconnect deletes the local encrypted credential; the
current Cognition partner document does not specify a token-revocation
endpoint.

## Verified behavior

Live testing on July 22–23, 2026 verified:

- claim, Sandbox provisioning, binary download, and checksum validation;
- `devin-remote` connection;
- clean suspend, automatic snapshot, restore, and wake;
- recovery from dropped `command.wait()` requests in local mode;
- upgrade to a newly pinned remote binary after snapshot restore;
- one-snapshot retention.

Local verification on July 30, 2026 covers:

- clean production compilation with the registered session workflow and its
  Vercel handler routes;
- claim-deadline parsing and rejection;
- nonzero remote exits;
- provisioning failure cleanup;
- deterministic restore and bounded snapshots;
- timeout extension based on `expiresAt`;
- external termination cleanup;
- Devin-to-Sandbox network-policy translation;
- PKCE S256 generation and partner request parameters;
- authenticated encryption and browser-state tamper rejection;
- form-encoded connection-token exchange and response validation.

## Packaging

`vercel.json` explicitly enables Fluid compute in `iad1`, where Vercel
Workflow's managed backend currently stores workflow state. It also registers
the production cron schedule.

The README Deploy Button clones the public repository, requires the Upstash
Marketplace integration (`oac_V3R1GIpkoJorr6fqyiwdhl17`), creates a Vercel
project, and requests the one operator-provided secret. Upstash injects its
credentials into all project environments. Publishing the repository as a
curated Vercel Template is a separate catalog action.

## Remaining launch work

| Requirement | Owner | Status |
| --- | --- | --- |
| Deploy to a production Vercel project and run a full cloud session | Vercel | Open |
| Validate acceptance criteria and failure recovery with Cognition | Vercel + Cognition | Open |
| Publish as a curated Vercel Template | Vercel | Open |
| PKCE callback, browser correlation, and encrypted token storage | Vercel | Implemented; live test pending |
| Allowlist `https://devin-outpost-vercel.playground-vercel.tools/api/devin/callback` | Cognition | Blocking; live Create returned “Callback URL is not on the allowed callbacks list” |
| Support dynamic callbacks or standard OAuth `state` for arbitrary Deploy Button URLs | Cognition | Open |
| Chromium and ffmpeg image for browser and recording support | Vercel | Open if launch scope includes them |
| Confirm maximum suspended-session lifetime | Cognition | Open |
| Set snapshot expiry from that lifetime | Vercel | Blocked on Cognition |
| Coordinate changelog and co-launch | Vercel + Cognition | Open |

Manual machine token and outpost ID environment variables remain available for
local development and as a fallback. The partner flow is ready for a fixed
production callback test once Cognition allowlists that URL.
