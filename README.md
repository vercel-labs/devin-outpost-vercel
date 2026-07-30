# devin-outpost-vercel

Run [Devin Outposts](https://docs.devin.ai/cloud/outposts/overview) sessions in
[Vercel Sandbox](https://vercel.com/docs/sandbox) microVMs.

A small orchestrator that watches an outpost's queue, and for each pending
session: claims it, boots an isolated Firecracker microVM via the Sandbox SDK,
runs `devin-remote serve` inside it per Devin's documented
[spawn contract](https://docs.devin.ai/cloud/outposts/reference#spawn-contract),
and stops the sandbox when the session ends. Sandboxes are named per session
and persistent, so suspended sessions resume from a filesystem snapshot.

The core lifecycle has been live-tested end to end against a real Devin
account: claim, provision, bootstrap, spawn, monitor, clean suspend, snapshot,
restore, and wake. See `SPEC.md` for the design, verified behavior, and launch
requirements.

## Run manually

Prereqs: Node 20+, a Devin account with Outposts (alpha) enabled, a Vercel
team on Pro or Enterprise (sandbox sessions up to 24 h).

1. Create an outpost in Devin under **Settings → Environment → Outposts**.
   Alternatively, use the CLI with a token that has the
   `account.outposts.orchestrator` scope:

   ```bash
   devin worker outpost create vercel-sandbox --platform linux \
     --description "Vercel Sandbox microVMs"
   ```

2. Copy `.env.example` to `.env` and fill in the Devin service-user token
   (machine scope), the outpost ID, and Vercel access-token credentials.

3. Install and start:

   ```bash
   npm install
   npm start
   ```

4. In Devin Cloud, start a session on the `vercel-sandbox` machine. The
   orchestrator claims it and serves it from a fresh sandbox.

## How it maps

| Outposts concept | This orchestrator |
| --- | --- |
| Worker / acceptor | This process (`ACCEPTOR_ID`; set it explicitly and keep it stable in production) |
| Machine per session | One Vercel Sandbox microVM (`node24`, 2 vCPU default) |
| Session state | Named persistent sandbox restored from its latest snapshot |
| Session end | `devin-remote` exits 0 -> confirm status -> release claim -> `sandbox.stop()` |
| Failure / crash | Claim released (or expires at the deadline) and the session requeues |

The initial session timeout is 20 minutes. The orchestrator extends it whenever
less than 10 minutes remain, up to the Vercel plan limit. Each stop retains only
the newest snapshot.

## Public integration requirements

The live-tested manual flow is complete. A public partner integration also
requires:

- **Vercel:** deploy the orchestrator as a supervised long-running service,
  with a stable `ACCEPTOR_ID` and restart recovery for claimed sessions.
- **Vercel:** map Devin's `spec.network_policy` to Sandbox `networkPolicy`.
- **Vercel:** provide a custom image with Chromium and ffmpeg if browser and
  screen-recording support are part of the launch.
- **Vercel + Cognition:** implement the
  [PKCE connection flow](https://docs.devin.ai/cloud/outposts/partners).
  Vercel owns the callback and secure token storage; Cognition must allowlist
  the exact callback URL.
- **Cognition:** confirm the expected maximum suspended-session lifetime so
  Vercel can set snapshot retention without risking lost session state.

Polling every 5 seconds is used instead of the optional SSE watch.

## Tests

```bash
npm test        # fleet API client against a mock server
npm run typecheck
```
