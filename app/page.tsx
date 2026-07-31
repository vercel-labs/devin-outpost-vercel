import { getDevinConnectionMetadata } from "../src/connection-store";

export const dynamic = "force-dynamic";

export default async function Home() {
  let connection = null;
  let storageReady = true;
  try {
    connection = await getDevinConnectionMetadata();
  } catch {
    storageReady = false;
  }
  const cronReady = Boolean(
    (process.env.DEVIN_CONNECTION_SECRET ?? process.env.CRON_SECRET)?.length &&
      (process.env.DEVIN_CONNECTION_SECRET ?? process.env.CRON_SECRET)!.length >=
        16,
  );

  return (
    <main>
      <h1>Devin Outpost on Vercel</h1>
      {connection ? (
        <>
          <p>
            Devin is connected. Vercel Cron can now dispatch pending sessions
            into isolated Sandboxes.
          </p>
          {connection.source === "partner" && (
            <form action="/api/devin/connection" method="post">
              <label>
                Setup secret
                <input
                  name="setup_secret"
                  type="password"
                  autoComplete="current-password"
                  required
                />
              </label>
              <button type="submit">Disconnect Devin</button>
            </form>
          )}
        </>
      ) : (
        <>
          <p>
            Connect a Devin administrator account to create a Linux outpost and
            its scoped service-user credential.
          </p>
          {!storageReady && (
            <p>
              The Upstash database is unavailable. Attach the included storage
              integration before connecting Devin.
            </p>
          )}
          {!cronReady && (
            <p>
              Set <code>CRON_SECRET</code> to a random value of at least 16
              characters before connecting Devin.
            </p>
          )}
          <form action="/api/devin/connect" method="post">
            <label>
              Setup secret
              <input
                name="setup_secret"
                type="password"
                autoComplete="current-password"
                required
              />
            </label>
            <button type="submit" disabled={!storageReady || !cronReady}>
              Connect Devin
            </button>
          </form>
        </>
      )}
      <p>
        The control plane runs on Fluid compute, with Workflow persisting each
        session&apos;s monitoring loop between checks. Your laptop does not need
        to stay on.
      </p>
    </main>
  );
}
