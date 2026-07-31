import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, test } from "node:test";
import {
  decryptConnectionPayload,
  encryptConnectionPayload,
  setupSecretMatches,
  signBrowserState,
  verifyBrowserState,
} from "../src/connection-crypto.js";
import {
  buildDevinConnectUrl,
  createPkcePair,
  exchangeConnectionCode,
} from "../src/devin-partner.js";
import { getDevinConnection } from "../src/connection-store.js";
import {
  configureOutpostProject,
  exchangeVercelInstallationCode,
  safeVercelNextUrl,
} from "../src/vercel-integration.js";
import {
  renderDevinConnectedPage,
  renderVercelInstallPage,
} from "../src/vercel-install-page.js";

const originalCronSecret = process.env.CRON_SECRET;
const originalVercel = process.env.VERCEL;
const originalManualOptIn = process.env.ALLOW_MANUAL_DEVIN_CREDENTIALS;
const originalDevinToken = process.env.DEVIN_OUTPOSTS_TOKEN;
const originalOutpostId = process.env.DEVIN_OUTPOST_ID;
const originalIntegrationClientId = process.env.VERCEL_INTEGRATION_CLIENT_ID;
const originalIntegrationClientSecret =
  process.env.VERCEL_INTEGRATION_CLIENT_SECRET;

afterEach(() => {
  for (const [name, value] of [
    ["CRON_SECRET", originalCronSecret],
    ["VERCEL", originalVercel],
    ["ALLOW_MANUAL_DEVIN_CREDENTIALS", originalManualOptIn],
    ["DEVIN_OUTPOSTS_TOKEN", originalDevinToken],
    ["DEVIN_OUTPOST_ID", originalOutpostId],
    ["VERCEL_INTEGRATION_CLIENT_ID", originalIntegrationClientId],
    ["VERCEL_INTEGRATION_CLIENT_SECRET", originalIntegrationClientSecret],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

test("connection payloads are encrypted and authenticated", () => {
  process.env.CRON_SECRET = "test-secret-with-at-least-16-characters";
  const payload = { accessToken: "cog_secret", outpostId: "outpost_env-1" };
  const envelope = encryptConnectionPayload(payload);

  assert.doesNotMatch(envelope, /cog_secret/);
  assert.deepEqual(decryptConnectionPayload(envelope), payload);
  const tampered = `${envelope.slice(0, -1)}${envelope.endsWith("A") ? "B" : "A"}`;
  assert.throws(() => decryptConnectionPayload(tampered));
});

test("browser state signatures reject tampering", () => {
  process.env.CRON_SECRET = "test-secret-with-at-least-16-characters";
  const signed = signBrowserState("state-123");
  assert.equal(verifyBrowserState(signed), "state-123");
  assert.equal(verifyBrowserState(`${signed}x`), null);
});

test("setup secret comparison requires the exact configured secret", () => {
  process.env.CRON_SECRET = "test-secret-with-at-least-16-characters";
  assert.equal(
    setupSecretMatches("test-secret-with-at-least-16-characters"),
    true,
  );
  assert.equal(setupSecretMatches("wrong-secret-with-at-least-16"), false);
});

test("PKCE uses an S256 challenge and Devin partner parameters", () => {
  const pair = createPkcePair();
  assert.equal(
    pair.challenge,
    createHash("sha256").update(pair.verifier).digest("base64url"),
  );
  const url = buildDevinConnectUrl({
    callbackUrl: "https://example.com/api/devin/callback",
    challenge: pair.challenge,
  });
  assert.equal(url.origin, "https://app.devin.ai");
  assert.equal(url.pathname, "/outposts/connect");
  assert.equal(
    url.searchParams.get("callback_url"),
    "https://example.com/api/devin/callback",
  );
  assert.equal(url.searchParams.get("platform"), "linux");
  assert.equal(url.searchParams.get("code_challenge"), pair.challenge);
  assert.equal(url.searchParams.get("outpost_name"), "vercel-sandbox");
});

test("connection-code exchange is form encoded and maps the response", async () => {
  let requestBody = "";
  const connection = await exchangeConnectionCode(
    "single-use-code",
    "pkce-verifier",
    async (_input, init) => {
      requestBody = String(init?.body);
      return Response.json({
        access_token: "cog_token",
        account_id: "account-1",
        api_base_url: "https://api.devin.ai/",
        outpost_id: "outpost_env-1",
        outpost_name: "Vercel Sandbox",
        service_user_id: "service-user-1",
        token_type: "Bearer",
      });
    },
  );

  assert.deepEqual(Object.fromEntries(new URLSearchParams(requestBody)), {
    grant_type: "authorization_code",
    code: "single-use-code",
    code_verifier: "pkce-verifier",
  });
  assert.equal(connection.accessToken, "cog_token");
  assert.equal(connection.apiBaseUrl, "https://api.devin.ai");
  assert.equal(connection.outpostId, "outpost_env-1");
});

test("connection-code exchange does not include a failed response body", async () => {
  await assert.rejects(
    exchangeConnectionCode(
      "bad-code",
      "bad-verifier",
      async () => new Response("sensitive upstream detail", { status: 400 }),
    ),
    /HTTP 400/,
  );
});

test("cloud deployments fail closed on accidentally bundled manual credentials", async () => {
  process.env.VERCEL = "1";
  process.env.DEVIN_OUTPOSTS_TOKEN = "cog_accidentally_bundled";
  process.env.DEVIN_OUTPOST_ID = "outpost_env-accidental";
  delete process.env.ALLOW_MANUAL_DEVIN_CREDENTIALS;

  assert.equal(await getDevinConnection(), null);
  process.env.ALLOW_MANUAL_DEVIN_CREDENTIALS = "true";
  assert.equal(
    (await getDevinConnection())?.outpostId,
    "outpost_env-accidental",
  );
});

test("Vercel installation codes are exchanged with the configured integration", async () => {
  process.env.VERCEL_INTEGRATION_CLIENT_ID = "oac_test";
  process.env.VERCEL_INTEGRATION_CLIENT_SECRET = "secret_test";
  let requestBody = "";
  const result = await exchangeVercelInstallationCode(
    "install-code",
    "https://example.com/api/vercel/callback",
    async (_input, init) => {
      requestBody = String(init?.body);
      return Response.json({
        access_token: "vercel-install-token",
        team_id: "team_test",
      });
    },
  );

  assert.deepEqual(Object.fromEntries(new URLSearchParams(requestBody)), {
    client_id: "oac_test",
    client_secret: "secret_test",
    code: "install-code",
    redirect_uri: "https://example.com/api/vercel/callback",
  });
  assert.deepEqual(result, {
    accessToken: "vercel-install-token",
    teamId: "team_test",
  });
});

test("integration configures the Deploy Button project without user-entered secrets", async () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  await configureOutpostProject(
    {
      accessToken: "vercel-install-token",
      configurationId: "icfg_test",
      projectId: "prj_test",
      teamId: "team_test",
      nextUrl: "https://vercel.com/new/continue",
      cronSecret: "generated-cron-secret",
      connectionSecret: "generated-connection-secret",
    },
    {
      accessToken: "cog_token",
      accountId: "account-1",
      apiBaseUrl: "https://api.devin.ai",
      outpostId: "outpost_env-1",
      outpostName: "Vercel Sandbox",
      serviceUserId: "service-user-1",
      connectedAt: "2026-07-30T00:00:00.000Z",
    },
    async (input, init) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return Response.json({ created: true });
    },
  );

  assert.equal(requests.length, 7);
  for (const request of requests) {
    assert.match(
      request.url,
      /^https:\/\/api\.vercel\.com\/v10\/projects\/prj_test\/env\?/,
    );
    assert.equal(new URL(request.url).searchParams.get("teamId"), "team_test");
    assert.equal(new URL(request.url).searchParams.get("upsert"), "true");
    assert.equal(request.body.type, "encrypted");
    assert.deepEqual(request.body.target, [
      "production",
      "preview",
      "development",
    ]);
  }
  assert.deepEqual(
    new Set(requests.map((request) => request.body.key)),
    new Set([
      "CRON_SECRET",
      "DEVIN_CONNECTION_SECRET",
      "DEVIN_OUTPOSTS_TOKEN",
      "DEVIN_OUTPOST_ID",
      "DEVIN_API_URL",
      "ACCEPTOR_ID",
      "ALLOW_MANUAL_DEVIN_CREDENTIALS",
    ]),
  );
});

test("Vercel completion redirects are restricted to vercel.com", () => {
  assert.equal(
    safeVercelNextUrl("https://vercel.com/new/continue"),
    "https://vercel.com/new/continue",
  );
  assert.equal(safeVercelNextUrl("https://example.com/steal"), null);
  assert.equal(safeVercelNextUrl("not-a-url"), null);
});

test("Vercel install page preserves the popup and escapes the Devin URL", () => {
  const page = renderVercelInstallPage(
    'https://app.devin.ai/outposts/connect?challenge="unsafe"&platform=linux',
  );
  assert.match(page, /target="_blank"/);
  assert.match(page, /fetch\("\/api\/vercel\/status"/);
  assert.match(page, /challenge=&quot;unsafe&quot;&amp;platform=linux/);
  assert.doesNotMatch(page, /challenge="unsafe"/);
  assert.match(page, /window\.location\.replace\(result\.nextUrl\)/);
});

test("Devin completion page closes its authorization window", () => {
  const page = renderDevinConnectedPage();
  assert.match(page, /Devin connected/);
  assert.match(page, /window\.close\(\)/);
});
