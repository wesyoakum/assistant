export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/privacy") {
      return html(privacyPage);
    }

    if (url.pathname === "/whats-new") {
      return html(whatsNewPage);
    }

    if (url.pathname === "/claude") {
      return html(claudePage);
    }

    return html(landingPage);
  },
};

function html(body: string): Response {
  return new Response(body, {
    headers: { "Content-Type": "text/html;charset=UTF-8" },
  });
}

const landingPage = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>WHY Lab</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #EDE3D1; color: #1F2024;
      display: flex; justify-content: center; align-items: center;
      min-height: 100vh; padding: 24px;
    }
    .card {
      max-width: 480px; text-align: center;
    }
    h1 { font-size: 48px; font-weight: 700; color: #143F47; margin-bottom: 8px; }
    .subtitle { font-size: 18px; color: #5b5d61; margin-bottom: 32px; }
    .description { font-size: 15px; color: #3d3f44; line-height: 1.6; margin-bottom: 32px; }
    .button {
      display: inline-block; background: #143F47; color: #EDE3D1;
      padding: 14px 28px; border-radius: 10px; text-decoration: none;
      font-weight: 600; font-size: 16px;
    }
    .button:hover { background: #1a5060; }
    .footer { margin-top: 48px; font-size: 13px; color: #5b5d61; }
    .footer a { color: #3D7F94; }
  </style>
</head>
<body>
  <div class="card">
    <h1>WHY Lab</h1>
    <p class="subtitle">Sensor sandbox for iOS</p>
    <p class="description">
      Motion, audio spectrum, camera + YOLO object detection, LiDAR depth,
      ARKit ball tracking, BLE scanning, weather, game controllers, and more.
      A playground for iPhone hardware.
    </p>
    <a class="button" href="#">TestFlight coming soon</a>
    <div class="footer">
      <a href="/privacy">Privacy</a> &middot;
      <a href="/whats-new">What's New</a>
    </div>
  </div>
</body>
</html>`;

const whatsNewPage = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>What's New - WHY Lab</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #EDE3D1; color: #1F2024;
      display: flex; justify-content: center;
      min-height: 100vh; padding: 48px 24px;
    }
    .content { max-width: 600px; }
    h1 { font-size: 32px; font-weight: 700; color: #143F47; margin-bottom: 16px; }
    p { font-size: 16px; color: #5b5d61; line-height: 1.6; }
    a { color: #3D7F94; }
  </style>
</head>
<body>
  <div class="content">
    <h1>What's New</h1>
    <p>Release notes will appear here once WHY Lab ships its first build.</p>
    <p style="margin-top: 24px;"><a href="/">&larr; Back</a></p>
  </div>
</body>
</html>`;

const claudePage = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CLAUDE.md - WHY Lab</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #EDE3D1; color: #1F2024;
      display: flex; justify-content: center;
      min-height: 100vh; padding: 48px 24px;
    }
    .content { max-width: 600px; }
    h1 { font-size: 32px; font-weight: 700; color: #143F47; margin-bottom: 16px; }
    p { font-size: 16px; color: #5b5d61; line-height: 1.6; }
    a { color: #3D7F94; }
  </style>
</head>
<body>
  <div class="content">
    <h1>CLAUDE.md</h1>
    <p>Project brief will be rendered here once WHY Lab has its own CLAUDE.md.</p>
    <p style="margin-top: 24px;"><a href="/">&larr; Back</a></p>
  </div>
</body>
</html>`;

const privacyPage = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Privacy - WHY Lab</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #EDE3D1; color: #1F2024;
      display: flex; justify-content: center;
      min-height: 100vh; padding: 48px 24px;
    }
    .content { max-width: 600px; }
    h1 { font-size: 32px; font-weight: 700; color: #143F47; margin-bottom: 16px; }
    h2 { font-size: 20px; font-weight: 600; color: #143F47; margin-top: 24px; margin-bottom: 8px; }
    p { font-size: 15px; color: #3d3f44; line-height: 1.6; margin-bottom: 12px; }
    a { color: #3D7F94; }
  </style>
</head>
<body>
  <div class="content">
    <h1>Privacy Policy</h1>
    <p><em>Last updated: May 2026</em></p>

    <h2>What WHY Lab collects</h2>
    <p>
      WHY Lab is a sensor sandbox. All sensor data (motion, audio, camera,
      LiDAR, BLE, location) is processed on-device and is never uploaded to
      our servers unless you explicitly use a feature that requires it
      (e.g., Claude vision detection sends a single photo to our API for
      analysis).
    </p>

    <h2>Authentication</h2>
    <p>
      Sign-in uses Google OAuth. Your Google email and profile name are
      stored on our server to identify your account. Google access tokens
      are encrypted at rest and never sent to the app.
    </p>

    <h2>Third-party services</h2>
    <p>
      Claude vision detection sends images to Anthropic's API via our
      backend. Weather data is fetched from Open-Meteo. No other data
      leaves your device.
    </p>

    <h2>Contact</h2>
    <p>Questions? Reach out at the email on the App Store listing.</p>
    <p style="margin-top: 24px;"><a href="/">&larr; Back</a></p>
  </div>
</body>
</html>`;
