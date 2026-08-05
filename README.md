# Devin Outpost on Vercel

Run [Devin Outposts](https://docs.devin.ai/cloud/outposts/overview) sessions in
isolated [Vercel Sandbox](https://vercel.com/docs/sandbox) microVMs.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Ferulkey%2Fdevin-outpost-vercel-install&integration-ids=oac_doeREEVvypk1AfuPfktJzjpZ&project-name=devin-outpost-vercel&repository-name=devin-outpost-vercel)

The deployed control plane runs entirely on Vercel:

- Vercel Cron invokes a bounded Fluid compute function once per minute.
- That function polls Devin's queue every three seconds for 57 seconds and
  starts one durable workflow per pending session.
- Each session workflow provisions a named, persistent Sandbox, starts
  `devin-remote serve`, and sleeps between status checks without holding a
  function open.
- The Sandbox runs the user's commands. Workflow handles monitoring, timeout
  extension, claim release, teardown, and snapshot persistence.

After deployment, no laptop or desktop process needs to remain online. A user
can start the Devin session from a phone or any other device.

## Deploy

Prerequisites: a Devin account with Outposts enabled and administrator access,
and a Vercel Pro or Enterprise team. The one-minute cron schedule and
up-to-24-hour Sandbox sessions require Pro or Enterprise.

1. Click **Deploy with Vercel** above and choose the destination Vercel team.
2. Add **Devin Outposts for Vercel** when the Deploy Button asks for the
   required integration.
3. Sign in to Devin as an administrator, review the suggested outpost name,
   and click **Connect**.
4. Let Vercel finish creating and deploying the project.
5. In Devin, start a session and select the new Vercel outpost as its virtual
   environment.

No Devin token, API key, or setup secret is copied through the browser. The
integration exchanges Devin's short-lived authorization code server-to-server
and adds the encrypted runtime configuration directly to the newly created
Vercel project.

Cron jobs run only on production deployments. The first queue poll occurs
within one minute of deployment; after that, the Fluid dispatcher polls every
three seconds during its 57-second invocation.

## Environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `DEVIN_OUTPOSTS_TOKEN` | Local/manual fallback | Devin v3 service-user token with `account.outposts.machine` scope |
| `DEVIN_OUTPOST_ID` | Local/manual fallback | Outpost ID, such as `outpost_env-...` |
| `ALLOW_MANUAL_DEVIN_CREDENTIALS` | No | Must be `true` to opt into the environment-variable fallback in a Vercel deployment. Local mode does not require it. |
| `CRON_SECRET` | Yes in cloud mode | Random value of at least 16 characters. The Deploy Button integration generates it automatically. Vercel Cron sends it as a bearer token to `/api/cron`. |
| `DEVIN_CONNECTION_SECRET` | No | Separate setup and at-rest encryption secret. The Deploy Button integration generates it automatically. |
| `DEVIN_OAUTH_CALLBACK_URL` | Recommended | Fixed production callback registered with Cognition. Defaults to the Vercel project's production URL. |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | Integration controller only | Store short-lived encrypted PKCE transactions on the hosted integration controller. End-user Outpost projects do not need to configure these values. |
| `ACCEPTOR_ID` | No | Stable worker identity. Cloud mode defaults to `vercel-sandbox-$DEVIN_OUTPOST_ID`. |
| `DEVIN_API_URL` | No | Defaults to `https://api.devin.ai` |
| `DEVIN_WORKER_STATIC_BASE_URL` | No | Defaults to Devin's remote-binary origin |
| `SANDBOX_RUNTIME` | No | Defaults to `node24` |
| `SANDBOX_VCPUS` | No | Defaults to `2` |
| `SANDBOX_TIMEOUT_MS` | No | Initial and extension duration; defaults to 20 minutes |
| `POLL_INTERVAL_MS` | No | Defaults to 3000 ms, matching Modal's scheduler cadence |
| `MAX_CONCURRENT` | No | Maximum active Sandboxes; defaults to 5 |

The Devin access token returned by the partner flow is encrypted with AES-256-
GCM before it is written to Redis. PKCE verifiers are also encrypted, expire
after ten minutes, and are consumed atomically. Vercel provides OIDC
credentials to the Sandbox SDK automatically; do not add `VERCEL_TOKEN`,
`VERCEL_TEAM_ID`, or `VERCEL_PROJECT_ID` to a Vercel deployment.

## Run the orchestrator locally

Local mode remains useful for development. The computer running it must stay
awake and connected for queue polling and session monitoring.

1. Copy `.env.example` to `.env`.
2. Add the Devin variables and the three Vercel access-token variables
   documented in the example.
3. Run:

   ```bash
   npm install
   npm run start:local
   ```

## Lifecycle

| Outposts concept | Implementation |
| --- | --- |
| Worker / acceptor | Stable `ACCEPTOR_ID`, shared by the dispatcher and session workflows |
| Machine per session | One Vercel Sandbox microVM |
| Session state | Named persistent Sandbox restored from its newest snapshot |
| Network restrictions | Devin hostname and IP allowlists map to Sandbox firewall rules |
| Session end | Clean `devin-remote` exit or terminal Devin status triggers release and `sandbox.stop()` |
| Failure | Nonzero remote exits fail the session; provisioning failures release the claim and stop the Sandbox |

The orchestrator enforces Devin's server-assigned claim deadline before
provisioning, after Sandbox creation, and before starting `devin-remote`.
Sandbox lifetime is extended when less than ten minutes remain. Each stop keeps
only the newest snapshot.

## Development

```bash
npm test
npm run typecheck
npm run build
```

`SPEC.md` contains the detailed design, verified behavior, and remaining
partner-integration work.
