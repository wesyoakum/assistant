export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/privacy") {
      return html(privacyPage);
    }

    if (url.pathname === "/usage") {
      return html(usagePage);
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
    <p class="tagline">A personal assistant that learns how you prioritize what matters.</p>
    <ul class="features">
      <li>Smart email triage with Eisenhower matrix prioritization</li>
      <li>Google Calendar integration with suggested events</li>
      <li>Document, image, and voice capture with AI analysis</li>
      <li>Conversational assistant that learns your context</li>
      <li>Trainable priority system that adapts to your feedback</li>
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
      <li><strong>Gmail (read-only)</strong> — email subjects, senders, dates, and body text for triage classification. We do not send, modify, or delete emails.</li>
      <li><strong>Google Calendar</strong> — event details (titles, times, locations) for display and to create events you approve.</li>
    </ul>

    <h2>How We Use Your Data</h2>
    <ul>
      <li><strong>Email triage</strong> — Emails are analyzed by Anthropic's Claude AI to generate priority scores, summaries, and suggested actions.</li>
      <li><strong>Calendar</strong> — Events are displayed in the app. The AI may suggest new events based on email content; these are only created with your explicit approval.</li>
      <li><strong>Captures</strong> — Photos, documents, and voice memos you submit are analyzed by Claude AI for triage.</li>
      <li><strong>Context</strong> — Personal context you share (names, relationships, preferences) is stored to improve prioritization.</li>
      <li><strong>Feedback</strong> — When you correct priorities, that feedback trains future classifications for your account only.</li>
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
      <li><strong>Anthropic (Claude)</strong> — AI processing for email classification, document analysis, and chat. Email content and captures are sent to Anthropic's API for analysis. See <a href="https://www.anthropic.com/privacy">Anthropic's Privacy Policy</a>.</li>
      <li><strong>Cloudflare</strong> — Hosting, database, and file storage.</li>
      <li><strong>Expo</strong> — Push notification delivery.</li>
    </ul>

    <h2>Data Sharing</h2>
    <p>We do not sell, rent, or share your personal data with third parties for marketing purposes. Data is only shared with the third-party services listed above as necessary to provide the App's functionality.</p>

    <h2>Data Retention</h2>
    <p>Your data is retained as long as your account is active. You can request deletion of your data by contacting us. Signing out removes your session but does not delete stored data.</p>

    <h2>Your Rights</h2>
    <p>You can revoke the App's access to your Google account at any time via <a href="https://myaccount.google.com/permissions">Google Account Permissions</a>. You can view and delete stored context entries in the App's Settings screen.</p>

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

const usagePage = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>API Usage — whyapp</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f5f5f5; color: #222; padding: 16px; }
    .container { max-width: 900px; margin: 0 auto; }
    h1 { font-size: 24px; font-weight: 700; margin-bottom: 4px; }
    .subtitle { font-size: 14px; color: #888; margin-bottom: 20px; }
    .auth { margin-bottom: 20px; }
    .auth input { width: 100%; padding: 10px 12px; border: 1px solid #ddd; border-radius: 8px; font-size: 14px; }
    .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; margin-bottom: 24px; }
    .card { background: #fff; border-radius: 12px; padding: 16px; }
    .card .label { font-size: 12px; color: #888; text-transform: uppercase; font-weight: 600; margin-bottom: 4px; }
    .card .value { font-size: 28px; font-weight: 700; }
    .card .detail { font-size: 12px; color: #aaa; margin-top: 2px; }
    .chart-section { background: #fff; border-radius: 12px; padding: 16px; margin-bottom: 16px; }
    .chart-title { font-size: 14px; font-weight: 600; margin-bottom: 12px; color: #444; }
    canvas { width: 100% !important; height: 200px !important; }
    .recent { background: #fff; border-radius: 12px; padding: 16px; }
    .recent-title { font-size: 14px; font-weight: 600; margin-bottom: 12px; color: #444; }
    .recent-table { width: 100%; font-size: 12px; border-collapse: collapse; overflow-x: auto; display: block; }
    .recent-table th { text-align: left; padding: 6px 8px; border-bottom: 1px solid #eee; color: #888; font-weight: 600; white-space: nowrap; }
    .recent-table td { padding: 6px 8px; border-bottom: 1px solid #f5f5f5; white-space: nowrap; }
    .loading { text-align: center; padding: 40px; color: #aaa; }
    .error { color: #e53e3e; padding: 12px; background: #fff5f5; border-radius: 8px; margin-bottom: 16px; }
  </style>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"></script>
</head>
<body>
  <div class="container">
    <h1>API Usage</h1>
    <p class="subtitle">Anthropic Claude API spend tracking</p>
    <div class="auth">
      <input id="token" type="password" placeholder="Paste your session token" />
    </div>
    <div id="content" class="loading">Enter your session token above to load usage data</div>
  </div>

  <script>
    const API = "https://api.whyapp.us";
    const tokenInput = document.getElementById("token");
    const content = document.getElementById("content");
    let debounce;
    const charts = [];

    tokenInput.addEventListener("input", () => { clearTimeout(debounce); debounce = setTimeout(load, 500); });
    if (location.hash.startsWith("#token=")) { tokenInput.value = location.hash.slice(7); load(); }

    async function apiFetch(path) {
      const token = tokenInput.value.trim();
      if (!token) throw new Error("No token");
      const res = await fetch(API + path, { headers: { Authorization: "Bearer " + token } });
      if (!res.ok) throw new Error("API error " + res.status);
      return res.json();
    }

    const fmt = (cents) => "$" + (cents / 100).toFixed(2);

    function buildCumulative(rows, timeKey) {
      const buckets = {};
      for (const r of rows) {
        if (!buckets[r[timeKey]]) buckets[r[timeKey]] = 0;
        buckets[r[timeKey]] += r.cost;
      }
      const keys = Object.keys(buckets).sort();
      let running = 0;
      return keys.map(k => { running += buckets[k]; return { t: k, cost: buckets[k], cum: Math.round(running * 100) / 100 }; });
    }

    async function load() {
      const token = tokenInput.value.trim();
      if (!token) { content.innerHTML = '<div class="loading">Enter your session token above</div>'; return; }
      content.innerHTML = '<div class="loading">Loading...</div>';
      charts.forEach(c => c.destroy());
      charts.length = 0;

      try {
        const [summary, cumulative, daily, minutes2h, minutes48h, recent] = await Promise.all([
          apiFetch("/usage/summary"),
          apiFetch("/usage/cumulative"),
          apiFetch("/usage/daily"),
          apiFetch("/usage/minutes"),
          apiFetch("/usage/minutes48"),
          apiFetch("/usage/recent"),
        ]);

        let html = "";

        // 1. Cumulative spend by minute (last 2h) — top
        html += '<div class="chart-section"><div class="chart-title">Spend by Minute (last 2 hours)</div><canvas id="chartMin2h"></canvas></div>';

        // 2. Cumulative spend by minute (last 48h)
        html += '<div class="chart-section"><div class="chart-title">Spend by Minute (last 48 hours)</div><canvas id="chartMin48h"></canvas></div>';

        // 3. Spend by day bar graph
        html += '<div class="chart-section"><div class="chart-title">Spend by Day</div><canvas id="chartDayBar"></canvas></div>';

        // 4. Dollar summary cards
        html += '<div class="cards">';
        html += card("Today", fmt(summary.today.costCents), summary.today.calls + " calls");
        html += card("7 Days", fmt(summary.week.costCents), summary.week.calls + " calls");
        html += card("30 Days", fmt(summary.month.costCents), summary.month.calls + " calls");
        html += card("All Time", fmt(summary.allTime.costCents), summary.allTime.calls + " calls");
        html += "</div>";

        // 5. Cumulative all-time line
        html += '<div class="chart-section"><div class="chart-title">Cumulative Spend (all time)</div><canvas id="chartCum"></canvas></div>';

        // 6. Recent calls
        html += '<div class="recent"><div class="recent-title">Recent API Calls</div>';
        html += '<table class="recent-table"><thead><tr><th>Time</th><th>Purpose</th><th>Input</th><th>Output</th><th>Cache</th><th>Cost</th></tr></thead><tbody>';
        for (const call of recent.calls.slice(0, 30)) {
          const time = new Date(call.created_at + "Z").toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
          html += "<tr><td>" + time + "</td><td>" + call.purpose + "</td><td>" + (call.input_tokens||0).toLocaleString() + "</td><td>" + (call.output_tokens||0).toLocaleString() + "</td><td>" + (call.cache_read_tokens||0).toLocaleString() + "</td><td>" + fmt(call.cost_cents) + "</td></tr>";
        }
        html += "</tbody></table></div>";

        content.innerHTML = html;

        const lineOpts = () => ({
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: true, position: "top", labels: { font: { size: 11 } } } },
          scales: {
            x: { ticks: { maxTicksLimit: 10, font: { size: 9 } }, grid: { display: false } },
            y: { beginAtZero: true, ticks: { callback: v => "$" + (v/100).toFixed(2), font: { size: 10 } } }
          },
          elements: { point: { radius: 0, hitRadius: 8 }, line: { tension: 0.3, borderWidth: 2 } }
        });

        // Chart 1: minutes last 2h
        const min2h = buildCumulative(minutes2h.minutes, "minute");
        if (min2h.length > 0) {
          charts.push(new Chart(document.getElementById("chartMin2h"), {
            type: "line",
            data: {
              labels: min2h.map(r => new Date(r.t + "Z").toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })),
              datasets: [
                { label: "Cumulative", data: min2h.map(r => r.cum), borderColor: "#4285F4", backgroundColor: "rgba(66,133,244,0.1)", fill: true },
                { label: "Per Minute", data: min2h.map(r => Math.round(r.cost * 100) / 100), borderColor: "#10b981", backgroundColor: "rgba(16,185,129,0.1)", fill: true }
              ]
            },
            options: lineOpts()
          }));
        }

        // Chart 2: minutes last 48h
        const min48h = buildCumulative(minutes48h.minutes, "minute");
        if (min48h.length > 0) {
          charts.push(new Chart(document.getElementById("chartMin48h"), {
            type: "line",
            data: {
              labels: min48h.map(r => new Date(r.t + "Z").toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })),
              datasets: [
                { label: "Cumulative", data: min48h.map(r => r.cum), borderColor: "#4285F4", backgroundColor: "rgba(66,133,244,0.1)", fill: true },
                { label: "Per Minute", data: min48h.map(r => Math.round(r.cost * 100) / 100), borderColor: "#7c3aed", backgroundColor: "rgba(124,58,237,0.1)", fill: true }
              ]
            },
            options: lineOpts()
          }));
        }

        // Chart 3: daily bar graph (spend per day, stacked by purpose)
        const days = {};
        for (const row of daily.daily) {
          if (!days[row.day]) days[row.day] = { classify: 0, chat: 0, other: 0 };
          const bucket = row.purpose.startsWith("classify") ? "classify" : row.purpose === "chat" ? "chat" : "other";
          days[row.day][bucket] += row.cost;
        }
        const dayKeys = Object.keys(days).sort().slice(-30);
        if (dayKeys.length > 0) {
          charts.push(new Chart(document.getElementById("chartDayBar"), {
            type: "bar",
            data: {
              labels: dayKeys.map(d => new Date(d + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })),
              datasets: [
                { label: "Classify", data: dayKeys.map(d => Math.round((days[d]?.classify || 0) * 100) / 100), backgroundColor: "#4285F4" },
                { label: "Chat", data: dayKeys.map(d => Math.round((days[d]?.chat || 0) * 100) / 100), backgroundColor: "#7c3aed" },
                { label: "Other", data: dayKeys.map(d => Math.round((days[d]?.other || 0) * 100) / 100), backgroundColor: "#f59e0b" },
              ]
            },
            options: {
              responsive: true, maintainAspectRatio: false,
              plugins: { legend: { display: true, position: "top", labels: { font: { size: 11 } } } },
              scales: {
                x: { stacked: true, ticks: { maxTicksLimit: 15, font: { size: 9 } }, grid: { display: false } },
                y: { stacked: true, beginAtZero: true, ticks: { callback: v => "$" + (v/100).toFixed(2), font: { size: 10 } } }
              }
            }
          }));
        }

        // Chart 4: cumulative all-time
        if (cumulative.cumulative.length > 0) {
          charts.push(new Chart(document.getElementById("chartCum"), {
            type: "line",
            data: {
              labels: cumulative.cumulative.map(r => new Date(r.day + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })),
              datasets: [
                { label: "Cumulative", data: cumulative.cumulative.map(r => r.cumulativeCost), borderColor: "#4285F4", backgroundColor: "rgba(66,133,244,0.1)", fill: true },
              ]
            },
            options: lineOpts()
          }));
        }

      } catch (e) {
        content.innerHTML = '<div class="error">' + e.message + '</div>';
      }
    }

    function card(label, value, detail) {
      return '<div class="card"><div class="label">' + label + '</div><div class="value">' + value + '</div><div class="detail">' + detail + '</div></div>';
    }
  </script>
</body>
</html>`;
