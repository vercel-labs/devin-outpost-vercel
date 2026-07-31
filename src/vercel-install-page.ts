function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

const pageStyle = `
  :root { color-scheme: light dark; font-family: Geist, ui-sans-serif, system-ui, sans-serif; }
  body { display: grid; min-height: 100vh; margin: 0; place-items: center; background: #fff; color: #111; }
  main { box-sizing: border-box; width: min(480px, calc(100% - 32px)); padding: 32px; border: 1px solid #ddd; border-radius: 16px; text-align: center; }
  h1 { margin: 0 0 12px; font-size: 24px; }
  p { margin: 0 0 24px; color: #666; line-height: 1.5; }
  a { display: inline-block; padding: 12px 18px; border-radius: 8px; background: #111; color: #fff; font-weight: 600; text-decoration: none; }
  [role="status"] { min-height: 24px; margin-top: 20px; font-size: 14px; color: #666; }
  @media (prefers-color-scheme: dark) {
    body { background: #000; color: #fafafa; }
    main { border-color: #333; }
    p, [role="status"] { color: #aaa; }
    a { background: #fafafa; color: #111; }
  }
`;

export function renderVercelInstallPage(connectUrl: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Connect Devin</title>
  <style>${pageStyle}</style>
</head>
<body>
  <main>
    <h1>Connect Devin</h1>
    <p>Authorize this Vercel project to run Devin sessions in isolated Vercel Sandboxes.</p>
    <a href="${escapeHtml(connectUrl)}">Continue to Devin</a>
    <div role="status">You will return to Vercel after authorizing Devin.</div>
  </main>
</body>
</html>`;
}

export function renderDevinConnectedPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Devin connected</title>
  <style>${pageStyle}</style>
</head>
<body>
  <main>
    <h1>Devin connected</h1>
    <p>Your Outpost credentials were added to the Vercel project. You can close this window.</p>
    <button type="button" onclick="window.close()">Close window</button>
  </main>
  <script>window.close()</script>
</body>
</html>`;
}
