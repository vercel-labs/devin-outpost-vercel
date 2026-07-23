# devin-outpost-vercel

Run [Devin Outposts](https://docs.devin.ai/cloud/outposts/overview) sessions in
[Vercel Sandbox](https://vercel.com/docs/sandbox) microVMs.

A small orchestrator that watches an outpost's queue, and for each pending
session: claims it, boots an isolated Firecracker microVM via the Sandbox SDK,
runs `devin-remote serve` inside it per Devin's documented
[spawn contract](https://docs.devin.ai/cloud/outposts/reference#spawn-contract),
and stops the sandbox when the session ends. Sandboxes are named per session
and persistent, so suspended sessions resume from a filesystem snapshot.

Status: live-tested end-to-end against a real Devin account (Outposts alpha) on
Vercel Sandbox. The full lifecycle is verified: claim, provision, bootstrap,
spawn, monitor, clean suspend, and resume from a filesystem snapshot. See `SPEC.md` for the doc-grounded design.

## Run it

Prereqs: Node 20+, a Devin account with Outposts (alpha) enabled, a Vercel
team on Pro or Enterprise (sandbox sessions up to 24 h).

1. Create an outpost (prints `outpost_env-...`):

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
| Worker / acceptor | This process (`ACCEPTOR_ID`, stable per machine) |
| Machine per session | One Vercel Sandbox microVM (`node24`, 4 vCPU default) |
| `kind: resume` | Named persistent sandbox restored from its snapshot |
| Session end | `devin-remote` exits 0 -> confirm status -> release claim -> `sandbox.stop()` |
| Failure / crash | Claim released (or expires at the deadline) and the session requeues |

## Not in v1

- Chrome and ffmpeg (Devin browser + screen recording) — needs a custom VCR image
- Mapping the session's `spec.network_policy` onto Sandbox `networkPolicy`
- SSE watch (poll every 5 s instead)
- The partner PKCE connect flow (requires Cognition to allowlist a callback URL)

## Tests

```bash
npm test        # fleet API client against a mock server
npm run typecheck
```
