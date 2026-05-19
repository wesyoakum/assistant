export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/privacy") {
      return html(privacyPage);
    }

    return html(homePage);
  },
};

function html(body: string): Response {
  return new Response(body, {
    headers: { "Content-Type": "text/html;charset=UTF-8" },
  });
}

const homePage = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>whyapp — Your Personal Assistant</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #fff;
      color: #111;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .container { max-width: 480px; text-align: center; }
    h1 { font-size: 48px; font-weight: 700; margin-bottom: 12px; }
    .tagline { font-size: 20px; color: #666; margin-bottom: 32px; line-height: 1.5; }
    .features { text-align: left; margin-bottom: 32px; }
    .features li {
      font-size: 16px;
      color: #444;
      padding: 8px 0;
      list-style: none;
    }
    .features li::before { content: "\\2022"; color: #4285F4; font-weight: bold; margin-right: 10px; }
    .badge {
      display: inline-block;
      background: #4285F4;
      color: #fff;
      padding: 12px 28px;
      border-radius: 12px;
      font-size: 16px;
      font-weight: 600;
      text-decoration: none;
      margin-bottom: 24px;
    }
    footer { margin-top: 48px; font-size: 14px; color: #aaa; }
    footer a { color: #888; text-decoration: none; }
    footer a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="container">
    <h1>whyapp</h1>
    <p class="tagline">Collects your email, calendar, and files — plus a plain chat.</p>
    <ul class="features">
      <li>Gmail collection (read-only, stored raw)</li>
      <li>Google Calendar and iCal feed viewing</li>
      <li>Document, image, and voice capture (stored, not analyzed)</li>
      <li>Generic chat assistant — no steering or saved context</li>
    </ul>
    <a class="badge" href="#">Available via TestFlight</a>
    <footer>
      <a href="/privacy">Privacy Policy</a>
    </footer>
  </div>
</body>
</html>`;

const privacyPage = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Privacy Policy — whyapp</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #fff;
      color: #333;
      padding: 24px;
      line-height: 1.7;
    }
    .container { max-width: 640px; margin: 0 auto; }
    h1 { font-size: 32px; font-weight: 700; margin-bottom: 8px; color: #111; }
    .updated { font-size: 14px; color: #999; margin-bottom: 32px; }
    h2 { font-size: 20px; font-weight: 600; margin-top: 28px; margin-bottom: 8px; color: #111; }
    p { margin-bottom: 16px; font-size: 16px; }
    ul { margin-bottom: 16px; padding-left: 24px; }
    li { margin-bottom: 6px; font-size: 16px; }
    a { color: #4285F4; text-decoration: none; }
    a:hover { text-decoration: underline; }
    footer { margin-top: 48px; padding-top: 16px; border-top: 1px solid #eee; font-size: 14px; color: #aaa; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Privacy Policy</h1>
    <p class="updated">Last updated: May 12, 2026</p>

    <h2>Overview</h2>
    <p>whyapp ("the App") is a personal assistant application for individual use. This policy describes how we handle your data.</p>

    <h2>Data We Collect</h2>
    <p>When you sign in with Google, we access:</p>
    <ul>
      <li><strong>Google account info</strong> — name, email address, and profile picture for authentication.</li>
      <li><strong>Gmail (read-only)</strong> — email subjects, senders, dates, and body text, stored as collected. We do not send, modify, or delete emails.</li>
      <li><strong>Google Calendar</strong> — event details (titles, times, locations) for display and to create events you request.</li>
    </ul>

    <h2>How We Use Your Data</h2>
    <ul>
      <li><strong>Email & calendar</strong> — Collected and displayed in the app. No analysis, scoring, or classification is performed.</li>
      <li><strong>Captures</strong> — Photos, documents, and voice memos you submit are stored as-is and are not analyzed.</li>
      <li><strong>Chat</strong> — Messages you send in the chat are forwarded to Anthropic's Claude API to generate a reply, and the transcript is stored so the conversation persists. No personal context, preferences, or other data is injected into the chat.</li>
    </ul>

    <h2>Data Storage and Security</h2>
    <ul>
      <li>Your data is stored on Cloudflare's infrastructure (D1 database, R2 storage).</li>
      <li>Google OAuth tokens are encrypted at rest using AES-GCM encryption.</li>
      <li>Your Google tokens never leave the server — the mobile app only holds a session token.</li>
      <li>Uploaded files are stored in a private R2 bucket accessible only to your account.</li>
    </ul>

    <h2>Third-Party Services</h2>
    <ul>
      <li><strong>Google</strong> — OAuth authentication, Gmail API, Google Calendar API.</li>
      <li><strong>Anthropic (Claude)</strong> — Processes chat messages only. See <a href="https://www.anthropic.com/privacy">Anthropic's Privacy Policy</a>.</li>
      <li><strong>Cloudflare</strong> — Hosting, database, and file storage.</li>
    </ul>

    <h2>Data Sharing</h2>
    <p>We do not sell, rent, or share your personal data with third parties for marketing purposes. Data is only shared with the third-party services listed above as necessary to provide the App's functionality.</p>

    <h2>Data Retention</h2>
    <p>Your data is retained as long as your account is active. You can request deletion of your data by contacting us. Signing out removes your session but does not delete stored data.</p>

    <h2>Your Rights</h2>
    <p>You can revoke the App's access to your Google account at any time via <a href="https://myaccount.google.com/permissions">Google Account Permissions</a>.</p>

    <h2>Children</h2>
    <p>The App is not intended for use by children under 13.</p>

    <h2>Changes</h2>
    <p>We may update this policy from time to time. Changes will be reflected on this page with an updated date.</p>

    <h2>Contact</h2>
    <p>For questions about this privacy policy, contact us at the email associated with this app's developer account.</p>

    <footer>
      <a href="/">Home</a>
    </footer>
  </div>
</body>
</html>`;
