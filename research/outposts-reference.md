> ## Documentation Index
> Fetch the complete documentation index at: https://docs.devin.ai/llms.txt
> Use this file to discover all available pages before exploring further.

# Reference

> CLI commands, fleet API endpoints, and the worker spawn contract

Complete reference for the Outposts surface area: the worker CLI, the fleet API, the `devin-remote` binary distribution, and the spawn contract for custom orchestrators.

## Authentication

Workers and orchestrators authenticate with a [v3 API token](/api-reference/v3/overview) belonging to a service user. The role assigned to the service user grants the token its Outposts scopes:

| Role permission                                    | Token scope                     | Grants                                                     |
| -------------------------------------------------- | ------------------------------- | ---------------------------------------------------------- |
| **Use outpost machine** (`UseOutpostsMachine`)     | `account.outposts.machine`      | Reading the queue and claiming/releasing sessions          |
| **Manage outposts** (`ManageOutpostsOrchestrator`) | `account.outposts.orchestrator` | Creating and deleting outposts (implies the machine scope) |

Outposts are scoped to your **account** and shared across all of its organizations.

## CLI

### `devin worker start`

Polls an outpost's queue, claims sessions, downloads the correct `devin-remote` binary, and serves sessions. Run it from the directory containing the session's checked-out repositories.

```bash theme={null}
devin worker start --outpost=<outpost_id>
```

| Flag                               | Environment variable           | Description                                                                                                                                                                    |
| ---------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--outpost`                        | —                              | Only claim sessions from this outpost. If omitted in an interactive terminal, the worker prompts you to pick from your account's outposts.                                     |
| `--session` (alias `--session-id`) | —                              | Claim and serve one specific session, then exit.                                                                                                                               |
| `--acceptor-id`                    | `DEVIN_WORKER_ACCEPTOR_ID`     | Stable worker identity used for claims, renewals, and restart recovery. Defaults to a generated ID persisted under the worker data directory. Never share one across machines. |
| `--token`                          | `DEVIN_OUTPOSTS_TOKEN`         | Auth token for the worker. If both are unset, the command errors.                                                                                                              |
| `--once`                           | —                              | Exit after serving one session instead of returning to the queue.                                                                                                              |
| `--api-url`                        | `DEVIN_API_URL`                | Devin API base URL. Defaults to `https://api.devin.ai`.                                                                                                                        |
| `--cache-dir`                      | `DEVIN_WORKER_CACHE_DIR`       | Directory where downloaded `devin-remote` binaries are cached. Defaults to `~/.devin/worker/cache`.                                                                            |
| `--static-base-url`                | `DEVIN_WORKER_STATIC_BASE_URL` | Base URL `devin-remote` binaries are published to.                                                                                                                             |
| `--gateway-url`                    | `DEVIN_OUTPOST_GATEWAY_URL`    | Outpost gateway URL fallback when the claim response does not carry one.                                                                                                       |
| `--remote-binary-sha`              | `DEVIN_WORKER_REMOTE_SHA`      | Fallback `devin-remote` git SHA when the session does not pin one. When neither is set, the latest published SHA is used.                                                      |
| `--pty-bridge-port`                | `DEVIN_PTY_BRIDGE_PORT`        | Fixed PTY bridge port. Defaults to a free port allocated per session.                                                                                                          |
| `--poll-interval-secs`             | —                              | Seconds between queue polls and session status checks. Defaults to `5`.                                                                                                        |

The worker's environment can also carry `DEVIN_CHROME_PATH` to point sessions at a Chrome/Chromium binary for browser features.

### `devin worker outpost create`

Creates an outpost — a named queue of sessions served by your infrastructure. Requires the orchestrator scope.

```bash theme={null}
devin worker outpost create <name> --platform <platform> --description "..."
```

| Argument / flag | Description                                                 |
| --------------- | ----------------------------------------------------------- |
| `<name>`        | Unique (per account) outpost name, e.g. `rhel`, `gpu-h200`. |
| `--platform`    | Machine platform: `linux`, `macos`, or `windows`.           |
| `--description` | Human-readable description shown in the web app.            |

Prints the new outpost's ID (`outpost_env-...`). You can also create outposts in the web app under **Settings → Environment → Outposts**.

### `devin worker outpost delete`

Deletes an outpost. Requires the orchestrator scope.

```bash theme={null}
devin worker outpost delete <outpost_id>
```

## Fleet API

All endpoints live under `https://api.devin.ai/opbeta/outposts/` and take a bearer token:

```bash theme={null}
curl -H "Authorization: Bearer $DEVIN_API_TOKEN" ...
```

Resources follow a Kubernetes-style `metadata` / `spec` / `status` shape, and the queue follows Kubernetes list-then-watch semantics with at-least-once delivery.

### Objects

#### Queue entry (`devins`)

Each queued session is represented by one queue entry:

| Field                    | Description                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------- |
| `metadata.session_id`    | The session (devin) ID.                                                                                 |
| `metadata.outpost_id`    | The outpost the session is queued on.                                                                   |
| `metadata.created_at`    | When the session was enqueued (Unix timestamp).                                                         |
| `metadata.updated_at`    | When this object last changed (Unix timestamp).                                                         |
| `spec.kind`              | `new` or `resume`.                                                                                      |
| `spec.platform`          | Machine platform, e.g. `linux`.                                                                         |
| `spec.remote_binary_sha` | Short commit SHA of the `devin-remote` binary the worker should run; `null` means the worker's default. |
| `spec.network_policy`    | The session's effective network policy (see below).                                                     |
| `status.phase`           | Queue phase: `pending` or `claimed`.                                                                    |
| `status.acceptor_id`     | Worker that currently holds the claim, if claimed.                                                      |
| `status.claim_deadline`  | When the current claim expires and the session returns to the queue.                                    |
| `status.session_status`  | Coarse status of the underlying session: `pending`, `running`, `suspended`, or `terminated`.            |
| `status.connect_token`   | Gateway connect token; only returned from a successful claim.                                           |
| `status.gateway_url`     | Public websocket URL of the outpost gateway; only returned from a successful claim.                     |

`spec.network_policy` reports whether the session's network access is restricted (`enabled`) and the allowed destinations (`allow`): hostname globs (`{"hostname": ...}`), IPv4 addresses/CIDRs (`{"ipv4": ...}`), or IPv6 addresses/CIDRs (`{"ipv6": ...}`).

#### Outpost

| Field                  | Description                                          |
| ---------------------- | ---------------------------------------------------- |
| `metadata.outpost_id`  | The outpost ID (`outpost_env-...`).                  |
| `metadata.account_id`  | Account that owns the outpost.                       |
| `metadata.created_at`  | When the outpost was created (Unix timestamp).       |
| `spec.name`            | Unique (per account) outpost name.                   |
| `spec.platform`        | Machine platform; `null` means the default platform. |
| `spec.description`     | Human-readable description.                          |
| `status.queue_depth`   | Number of pending (unclaimed) sessions in the queue. |
| `status.active_claims` | Number of unexpired claims held by workers.          |

### List queued sessions

```
GET /opbeta/outposts/devins
```

| Query param   | Description                                                                                                                                                                                                     |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `outpost`     | Filter by outpost ID. Applies to both list and watch.                                                                                                                                                           |
| `phase`       | Filter by queue phase (`pending` or `claimed`). Ignored when watching.                                                                                                                                          |
| `acceptor_id` | Filter by claiming worker. Ignored when watching.                                                                                                                                                               |
| `first`       | Maximum rows per list page, 1–200. Defaults to 100.                                                                                                                                                             |
| `cursor`      | Opaque cursor from a previous list response or watch event (the two are interchangeable). For a list, returns rows at or after this position; for a watch, replays changes after it before streaming live ones. |
| `watch`       | Stream changes as SSE instead of listing.                                                                                                                                                                       |

Example response:

```json theme={null}
{
  "items": [
    {
      "metadata": {
        "session_id": "devin-...",
        "outpost_id": "outpost_env-...",
        "created_at": 1781050000,
        "updated_at": 1781050000
      },
      "spec": {
        "kind": "new",
        "platform": "linux",
        "remote_binary_sha": null
      },
      "status": {
        "phase": "pending",
        "acceptor_id": null,
        "claim_deadline": null,
        "session_status": "pending"
      }
    }
  ],
  "cursor": "djE6MTc4MTA1MDAwMC4w",
  "has_next_page": false,
  "total": 1
}
```

Pagination and delivery semantics:

* Pass each response's `cursor` into the next request while `has_next_page` is `true`.
* Delivery is at-least-once: a session at a page boundary can appear in both pages, so upsert entries by `metadata.session_id` rather than treating every item as new (the claim CAS makes duplicates harmless).
* When `has_next_page` becomes `false`, save the returned cursor as the starting position for a watch.

### Watch for changes

```
GET /opbeta/outposts/devins?watch=true&cursor=<cursor>
```

Streams Server-Sent Events. `MODIFIED` events fire when a session's queue entry changes (newly queued sessions also arrive as `MODIFIED`); `DELETED` events fire when it is removed. Each SSE `data` field contains:

```json theme={null}
{
  "type": "MODIFIED",
  "object": {
    "metadata": {
      "session_id": "devin-...",
      "outpost_id": "outpost_env-...",
      "created_at": 1781050000,
      "updated_at": 1781050100
    },
    "spec": {
      "kind": "new",
      "platform": "linux",
      "remote_binary_sha": null
    },
    "status": {
      "phase": "pending",
      "acceptor_id": null,
      "claim_deadline": null,
      "session_status": "pending"
    }
  },
  "cursor": "djE6MTc4MTA1MDEwMC4w"
}
```

Watch semantics:

* Persist each event's top-level `cursor` after processing it; reconnect with the last persisted cursor to replay changes that occurred while disconnected.
* Delivery is at-least-once — tolerate duplicate events.
* Streams end after at most five minutes; a reconnecting watch loop is expected.
* `phase` and `acceptor_id` filters are ignored when `watch=true`; filter watched events using the fields in each event's `object`.
* Omitting the cursor starts from the beginning, so use list-then-watch for normal reconciliation.

### Get a queue entry

```
GET /opbeta/outposts/devins/{session_id}
```

Returns the queue entry for one session.

### Claim a session

```
POST /opbeta/outposts/devins/{session_id}/claim
```

```json theme={null}
{ "acceptor_id": "worker-1" }
```

Atomically claims the session for the given worker identity. If another worker claimed it first, the request fails with `409`. A successful claim response includes `status.connect_token` and `status.gateway_url` — the credentials `devin-remote` needs to connect (see the [spawn contract](#spawn-contract)).

Claiming promises that a worker will be ready within the server-assigned claim deadline (`status.claim_deadline`); expired claims return to the queue automatically.

### Release a claim

```
POST /opbeta/outposts/devins/{session_id}/release
```

```json theme={null}
{ "acceptor_id": "worker-1" }
```

Releases the worker's claim so the session returns to the queue immediately (e.g. when provisioning fails).

### Outposts

```
GET    /opbeta/outposts/outposts                 # list outposts
POST   /opbeta/outposts/outposts                 # create an outpost
GET    /opbeta/outposts/outposts/{outpost_id}    # get an outpost
DELETE /opbeta/outposts/outposts/{outpost_id}    # delete an outpost
```

Create request body:

```json theme={null}
{
  "name": "my-outpost",
  "platform": "linux",
  "description": "Dev boxes in our VPC"
}
```

Create, get, and delete require the orchestrator scope; each outpost response reports live `status.queue_depth` and `status.active_claims`.

## Remote binary distribution

The `devin worker start` command automatically downloads the correct `devin-remote` binary. Custom orchestrators that do not use the Devin CLI can fetch it directly from:

```
https://static.devin.ai/devin-rs/remote/
```

**Determine the latest version:**

```bash theme={null}
# Returns the git SHA of the latest published binary for your platform
curl -fsSL "https://static.devin.ai/devin-rs/remote/latest_linux_x64"
```

**Download and verify:**

```bash theme={null}
SHA=$(curl -fsSL "https://static.devin.ai/devin-rs/remote/latest_linux_x64")

# Download the binary
curl -fL "https://static.devin.ai/devin-rs/remote/devin-remote_${SHA}_linux_x64" \
  -o devin-remote

# Download and verify the checksum
curl -fsSL "https://static.devin.ai/devin-rs/remote/devin-remote_${SHA}_linux_x64.sha256" \
  -o devin-remote.sha256
echo "$(cat devin-remote.sha256)  devin-remote" | sha256sum -c

chmod +x devin-remote
```

**Available platforms:**

| Suffix            | OS / Architecture   |
| ----------------- | ------------------- |
| `linux_x64`       | Linux x86\_64       |
| `macos_arm64`     | macOS Apple Silicon |
| `windows_x64.exe` | Windows x86\_64     |

If the session's queue entry includes a `spec.remote_binary_sha`, use that SHA instead of `latest` — it pins the session to a specific tested version.

## Spawn contract

If your orchestrator launches `devin-remote` itself instead of using `devin worker start`, spawn it as:

```bash theme={null}
devin-remote serve
```

with the following environment variables:

| Variable                      | Required             | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DEVIN_OUTPOST_GATEWAY_URL`   | Yes                  | Outpost gateway base URL, e.g. `wss://outpost-gateway.devin.ai`.                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `DEVIN_OUTPOST_CONNECT_TOKEN` | Yes                  | Bearer connect token for the gateway, from the claim response.                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `DEVIN_OUTPOST_SESSION_ID`    | Yes                  | The session ID being served. All three `DEVIN_OUTPOST_*` variables must be set together.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `DEVIN_REMOTE_STATE_DIR`      | Strongly recommended | Per-session state directory where the remote stores its credentials, tokens, and shell-integration files. Use a unique directory per session (e.g. `~/.devin/worker/sessions/<session_id>`, which is what `devin worker` uses). If unset, the remote falls back to a shared system-wide default (`/opt/.devin` on Linux, `~/.devin` on macOS, `C:\ProgramData\devin` on Windows), which must then exist and be writable — and which leaks per-session state across concurrent sessions. Always set this. |
| `DEVIN_CHROME_PATH`           | Optional             | Path to a Chrome/Chromium binary on the box for the browser tool (there is no Devin-managed Chrome on Outposts).                                                                                                                                                                                                                                                                                                                                                                                         |
| `DEVIN_OUTPOST_DESKTOP`       | Optional             | Set to `true` to enable the desktop (VNC) stream. It is lazy on the remote side — nothing is captured until a viewer connects — so it is safe to enable unconditionally.                                                                                                                                                                                                                                                                                                                                 |

Give the remote a clean environment containing only the variables above plus basic system variables (`PATH`, `HOME`, `USER`, `LOGNAME`, `TMPDIR`, `LANG`, `TZ`, and — for the desktop stream's screen capture on Linux/X11 — `DISPLAY`, `WAYLAND_DISPLAY`, `XAUTHORITY`). Do not leak anything the agent should not be able to see into the remote: it is inherited by the agent's shell.

Additional lifecycle expectations:

* **Working directory**: launch the remote from the directory containing the session's repositories (the same rule as `devin worker start`).
* **Session end**: when the session ends (sleeps or terminates), Devin notifies the remote and it exits with status 0 on its own. Treat a clean exit as the end of the session: confirm the queue entry's `status.session_status` is `suspended` or `terminated` (the status update can lag the exit by a few seconds, so re-read a few times), then release the claim. As a fallback, also poll `status.session_status` while the remote runs and kill the process yourself once it reaches `terminated` (or the queue entry disappears).
