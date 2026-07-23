> ## Documentation Index
> Fetch the complete documentation index at: https://docs.devin.ai/llms.txt
> Use this file to discover all available pages before exploring further.

# Orchestration

> Provision machines and run workers automatically as sessions queue

An orchestrator watches the outposts API for sessions waiting on an outpost, provisions a VM or container for each one, and starts the worker inside it. This page describes the orchestration loop: polling the queue, claiming sessions, running workers, and tearing machines down.

If you just want to serve sessions from a machine you already have, start with the [quickstart](/cloud/outposts/quickstart) — no orchestrator is required. If you run on a supported platform, an [integration](/cloud/outposts/overview#integrations) may already implement this loop for you. For the full API and CLI surface, see the [reference](/cloud/outposts/reference).

<Note>
  Running on Kubernetes? [devin-outpost-k8s](https://github.com/CognitionAI/devin-outpost-k8s)
  is an open-source operator that implements this loop for you: it watches the
  queue, claims pending sessions, and runs each one as a worker pod on any
  certified cluster (GKE, EKS, ...). Install it with its Helm chart instead of
  building your own orchestrator.
</Note>

## The core flow

### 1. Register an outpost

An outpost is a named queue of sessions served by many workers on your infrastructure (for example, `rhel`, `gpu-h200`, or `my-outpost`). Create one with `devin worker outpost create`:

```bash theme={null}
devin worker outpost create <name> --platform <platform> --description "..."
```

Once registered, the outpost appears as a machine option in Devin Cloud (alongside Ubuntu, Windows, etc.) when starting a session. Sessions targeting it wait in its queue until a worker claims them.

<Note>
  In the fleet API, outposts are represented as `outposts` resources, scoped to
  your account (shared across all of its organizations). See the
  [outposts endpoints](/cloud/outposts/reference#outposts).
</Note>

### 2. Watch the fleet API for waiting sessions

Your orchestrator lists pending sessions for the outposts it serves:

```bash theme={null}
curl -H "Authorization: Bearer $DEVIN_API_TOKEN" \
  "https://api.devin.ai/opbeta/outposts/devins?outpost=<outpost_id>&phase=pending"
```

Then it keeps its view current with a Server-Sent Events (SSE) watch, resuming from the list's final cursor:

```bash theme={null}
curl -N -H "Authorization: Bearer $DEVIN_API_TOKEN" \
  "https://api.devin.ai/opbeta/outposts/devins?outpost=<outpost_id>&watch=true&cursor=<cursor>"
```

This is the standard Kubernetes-style list-then-watch pattern: page through the list with the response cursor, then start a watch from where the list left off, persisting each event's cursor so you can reconnect without missing changes. Delivery is at-least-once, so upsert by `metadata.session_id` and tolerate duplicates. See [List queued sessions](/cloud/outposts/reference#list-queued-sessions) and [Watch for changes](/cloud/outposts/reference#watch-for-changes) for query parameters, response shapes, and full pagination semantics.

### 3. Claim before provisioning

Before starting a machine for a session, atomically claim it so no other worker picks it up. Pass an `acceptor_id` — a self-reported identity for your worker:

```bash theme={null}
curl -X POST -H "Authorization: Bearer $DEVIN_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"acceptor_id": "worker-1"}' \
  "https://api.devin.ai/opbeta/outposts/devins/{session_id}/claim"
```

Claims are atomic: if another worker claimed the session first, you get a `409`. Claiming promises that a worker will be ready within the server-assigned claim deadline (`status.claim_deadline`); expired claims return to the queue automatically. If provisioning fails, [release the claim](/cloud/outposts/reference#release-a-claim) so the session returns to the queue immediately.

### 4. Spawn a machine and run the worker

For each claimed session, provision a VM or container from your image. Inside it, run the worker from the directory where the session's repositories are already checked out:

```bash theme={null}
cd /path/to/repos
devin worker start --session=<session_id> --outpost=<outpost_id> --acceptor-id=<worker_id>
```

Pass the same `--acceptor-id` you used for the API claim, and provide the token via `--token` or `DEVIN_OUTPOSTS_TOKEN` (see the [full flag list](/cloud/outposts/reference#devin-worker-start)). The worker connects out to Devin's cloud, marks the session ready, and begins executing tool calls.

### 5. Terminate the machine when the worker exits

When `devin worker start` exits, the session is over (or has been suspended). Terminate the VM or container. If your outpost is resumable, snapshot the machine before terminating so you can restore it if the session resumes.

Your orchestrator can track its claimed sessions and their states:

```bash theme={null}
curl -H "Authorization: Bearer $DEVIN_API_TOKEN" \
  "https://api.devin.ai/opbeta/outposts/devins?phase=claimed&acceptor_id=worker-1"
```

Each entry reports a `status.session_status` of `pending`, `running`, `suspended`, or `terminated`.

## Centralization-free scheduling

<Note>
  Planning to run more than \~16 coordinators (workers or orchestrators
  watching and claiming from an outpost)? Contact your account team first — larger
  fleets amplify claim contention and queue read load, and we want to make
  sure the outpost is provisioned for it.
</Note>

You don't need a central scheduler to run a fleet. The queue API is designed so that many independent workers can serve the same outpost without talking to each other:

* **Claims are the only coordination primitive.** Every worker independently watches the queue and races to claim pending sessions. The claim is an atomic compare-and-swap on the server: exactly one worker wins, and every loser gets a `409` and simply moves on to the next pending session. Losing a claim race is normal operation, not an error.
* **Each worker has its own identity.** The `acceptor_id` scopes a worker's claims, renewals, and restart recovery to that worker alone. `devin worker start` generates and persists one automatically per machine, so a fleet needs no identity configuration. Never share an acceptor ID (or a copied worker data directory) across machines — colliding workers will steal each other's claims.
* **Failures self-heal.** If a worker dies after claiming, its claim expires at the claim deadline and the session returns to the queue for another worker to pick up. No fleet-level health tracking is required.

This means scaling out is just running the worker on more machines pointed at the same outpost: N machines serve N concurrent sessions, and the rest wait as pending.

## Building a custom orchestrator

Everything `devin worker start` does is available directly through the fleet API, so you can replace the CLI entirely: fetch the `devin-remote` binary from Devin's static distribution and launch it yourself with the documented environment. See [Remote binary distribution](/cloud/outposts/reference#remote-binary-distribution) and the [spawn contract](/cloud/outposts/reference#spawn-contract) in the reference.
