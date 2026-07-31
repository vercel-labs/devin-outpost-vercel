# Devin Outpost on Vercel

Run [Devin Outposts](https://docs.devin.ai/cloud/outposts/overview) sessions in
isolated [Vercel Sandbox](https://vercel.com/docs/sandbox) microVMs.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fvercel-labs%2Fdevin-outpost-vercel&env=CRON_SECRET&envDescription=A+random+setup+and+cron+secret+of+at+least+16+characters.&envLink=https%3A%2F%2Fgithub.com%2Fvercel-labs%2Fdevin-outpost-vercel%23environment-variables&integration-ids=oac_V3R1GIpkoJorr6fqyiwdhl17&project-name=devin-outpost-vercel&repository-name=devin-outpost-vercel)

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

1. Click **Deploy with Vercel** above.
2. Approve the required Upstash integration and create its Redis database. It
   stores only the short-lived PKCE handoff and encrypted Devin connection.
3. Enter a random `CRON_SECRET` of at least 16 characters and deploy.
4. Open the production deployment, enter that setup secret, and click
   **Connect Devin**.
5. Approve the outpost in Devin, then select it as a session's virtual
   environment.

The partner callback URL must currently be registered by Cognition before step
4. A live July 30, 2026 test reached Devin's consent screen but **Create**
returned `Callback URL is not on the allowed callbacks list` for:

```text
https://devin-outpost-vercel.playground-vercel.tools/api/devin/callback
```

Cognition's early partner contract requires every callback URL to be sent in
advance and does not document an OAuth `state` parameter. A broadly
self-service Deploy Button therefore still requires Cognition to support
dynamic partner callbacks (or a standard state-bearing OAuth client). The
current signed, single-use browser cookie correlates a callback to the browser
that began the ten-minute PKCE flow.

Cron jobs run only on production deployments. The first queue poll occurs
within one minute of deployment; after that, the Fluid dispatcher polls every
three seconds during its 57-second invocation.

## Environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `DEVIN_OUTPOSTS_TOKEN` | Local/manual fallback | Devin v3 service-user token with `account.outposts.machine` scope |
| `DEVIN_OUTPOST_ID` | Local/manual fallback | Outpost ID, such as `outpost_env-...` |
| `ALLOW_MANUAL_DEVIN_CREDENTIALS` | No | Must be `true` to opt into the environment-variable fallback in a Vercel deployment. Local mode does not require it. |
| `CRON_SECRET` | Yes in cloud mode | Random value of at least 16 characters. Vercel Cron sends it as a bearer token to `/api/cron`. |
| `DEVIN_CONNECTION_SECRET` | No | Separate setup and at-rest encryption secret. Defaults to domain-separated keys derived from `CRON_SECRET`. |
| `DEVIN_OAUTH_CALLBACK_URL` | Recommended | Fixed production callback registered with Cognition. Defaults to the Vercel project's production URL. |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | Yes for partner flow | Injected automatically by the required Upstash Marketplace integration. |
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
