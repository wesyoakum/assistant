interface Env {
  TRIGGER_RESULTS: KVNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/privacy") {
      return html(privacyPage);
    }

    if (url.pathname === "/usage") {
      return html(usagePage);
    }

    if (url.pathname === "/trigger") {
      return html(triggerPage);
    }

    if (url.pathname === "/segment") {
      return html(segmentPage);
    }

    if (url.pathname === "/lab") {
      return html(labPage);
    }

    if (url.pathname === "/api/trigger" && request.method === "POST") {
      return handleTriggerProxy(request);
    }

    if (url.pathname === "/api/segment" && request.method === "POST") {
      return handleSegmentProxy(request);
    }

    // Routine posts results here
    if (url.pathname === "/api/trigger-results" && request.method === "POST") {
      return handleResultPost(request, env);
    }

    // Trigger page polls here
    if (url.pathname.startsWith("/api/trigger-results/") && request.method === "GET") {
      const sessionId = url.pathname.split("/api/trigger-results/")[1];
      return handleResultGet(sessionId, env);
    }

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    return html(homePage);
  },
};

async function handleResultPost(request: Request, env: Env): Promise<Response> {
  try {
    const { result_key, session_id, status, output } = await request.json() as {
      result_key?: string;
      session_id?: string;
      status?: string;
      output?: string;
    };
    const key = result_key || session_id;
    if (!key) {
      return Response.json({ error: "Missing result_key or session_id" }, { status: 400 });
    }
    const result = {
      result_key: key,
      status: status || "complete",
      output: output || "",
      posted_at: new Date().toISOString(),
    };
    // Store for 24 hours
    await env.TRIGGER_RESULTS.put(key, JSON.stringify(result), { expirationTtl: 86400 });
    return Response.json({ ok: true });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}

async function handleResultGet(sessionId: string, env: Env): Promise<Response> {
  if (!sessionId) {
    return Response.json({ error: "Missing session_id" }, { status: 400 });
  }
  const data = await env.TRIGGER_RESULTS.get(sessionId);
  if (!data) {
    return Response.json({ status: "pending" });
  }
  return Response.json(JSON.parse(data));
}

async function handleSegmentProxy(request: Request): Promise<Response> {
  try {
    const { workflowUrl, apiKey, image, classes } = await request.json() as {
      workflowUrl?: string;
      apiKey?: string;
      image?: { type: string; value: string };
      classes?: string;
    };
    if (!workflowUrl || !apiKey || !image) {
      return Response.json({ error: "Missing workflowUrl, apiKey, or image" }, { status: 400 });
    }
    const res = await fetch(workflowUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        inputs: {
          image,
          classes: classes || "",
        },
      }),
    });
    const text = await res.text();
    let data: unknown;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    return Response.json(data, { status: res.status });
  } catch (e: any) {
    return Response.json({ error: e.message || "Proxy error" }, { status: 500 });
  }
}

async function handleTriggerProxy(request: Request): Promise<Response> {
  try {
    const { apiKey, triggerUrl, text } = await request.json() as {
      apiKey?: string;
      triggerUrl?: string;
      text?: string;
    };
    if (!apiKey || !triggerUrl) {
      return Response.json({ error: { message: "Missing apiKey or triggerUrl" } }, { status: 400 });
    }

    const body: Record<string, string> = {};
    if (text) body.text = text;

    const res = await fetch(triggerUrl, {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + apiKey,
        "anthropic-beta": "experimental-cc-routine-2026-04-01",
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const data = await res.json();
    return Response.json(data, { status: res.status });
  } catch (e: any) {
    return Response.json({ error: { message: e.message || "Proxy error" } }, { status: 500 });
  }
}

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
    nav { width: 100%; max-width: 480px; display: flex; justify-content: center; gap: 24px; padding: 16px 0; margin-bottom: 16px; }
    nav a { font-size: 14px; color: #666; text-decoration: none; font-weight: 500; }
    nav a:hover { color: #4285F4; }
    nav a.active { color: #4285F4; font-weight: 700; }
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
  <nav>
    <a href="/" class="active">Home</a>
    <a href="/privacy">Privacy</a>
    <a href="/usage">Usage</a>
    <a href="/trigger">Trigger</a>
    <a href="/segment">Segment</a>
  </nav>
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
    <footer>whyapp</footer>
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
    nav { max-width: 640px; margin: 0 auto; display: flex; gap: 24px; padding: 16px 0; }
    nav a { font-size: 14px; color: #666; text-decoration: none; font-weight: 500; }
    nav a:hover { color: #4285F4; }
    nav a.active { color: #4285F4; font-weight: 700; }
    footer { margin-top: 48px; padding-top: 16px; border-top: 1px solid #eee; font-size: 14px; color: #aaa; }
  </style>
</head>
<body>
  <nav>
    <a href="/">Home</a>
    <a href="/privacy" class="active">Privacy</a>
    <a href="/usage">Usage</a>
    <a href="/trigger">Trigger</a>
  </nav>
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

    <footer>whyapp</footer>
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
    nav { max-width: 900px; margin: 0 auto; display: flex; gap: 24px; padding: 16px 0; }
    nav a { font-size: 14px; color: #666; text-decoration: none; font-weight: 500; }
    nav a:hover { color: #4285F4; }
    nav a.active { color: #4285F4; font-weight: 700; }
  </style>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"></script>
</head>
<body>
  <nav>
    <a href="/">Home</a>
    <a href="/privacy">Privacy</a>
    <a href="/usage" class="active">Usage</a>
  </nav>
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

const triggerPage = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Trigger Routine — whyapp</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f5f5f5; color: #222; padding: 16px; }
    .container { max-width: 600px; margin: 0 auto; }
    h1 { font-size: 24px; font-weight: 700; margin-bottom: 4px; }
    .subtitle { font-size: 14px; color: #888; margin-bottom: 20px; }
    nav { max-width: 600px; margin: 0 auto; display: flex; gap: 24px; padding: 16px 0; }
    nav a { font-size: 14px; color: #666; text-decoration: none; font-weight: 500; }
    nav a:hover { color: #4285F4; }
    nav a.active { color: #4285F4; font-weight: 700; }
    .section { background: #fff; border-radius: 12px; padding: 16px; margin-bottom: 16px; }
    .section label { display: block; font-size: 12px; color: #888; text-transform: uppercase; font-weight: 600; margin-bottom: 6px; }
    .section input, .section textarea { width: 100%; padding: 10px 12px; border: 1px solid #ddd; border-radius: 8px; font-size: 14px; font-family: inherit; }
    .section textarea { min-height: 80px; resize: vertical; }
    .key-row { display: flex; gap: 8px; }
    .key-row input { flex: 1; }
    .btn-small { padding: 10px 16px; border: 1px solid #ddd; border-radius: 8px; background: #fff; font-size: 13px; cursor: pointer; white-space: nowrap; }
    .btn-small:hover { background: #f5f5f5; }
    .fire-btn {
      width: 100%; padding: 14px; border: none; border-radius: 12px;
      background: #4285F4; color: #fff; font-size: 16px; font-weight: 600;
      cursor: pointer; transition: background 0.2s;
    }
    .fire-btn:hover { background: #3367d6; }
    .fire-btn:disabled { background: #a4c2f4; cursor: not-allowed; }
    .status { margin-top: 12px; font-size: 14px; color: #666; }
    .status.error { color: #e53e3e; }
    .status.success { color: #38a169; }
    .result { background: #fff; border-radius: 12px; padding: 16px; margin-top: 16px; }
    .result-title { font-size: 12px; color: #888; text-transform: uppercase; font-weight: 600; margin-bottom: 8px; }
    .result pre { background: #f8f8f8; border-radius: 8px; padding: 12px; font-size: 12px; overflow-x: auto; white-space: pre-wrap; word-break: break-all; }
    .result a { color: #4285F4; font-size: 13px; text-decoration: none; display: inline-block; margin-top: 8px; }
    .result a:hover { text-decoration: underline; }
    .history { background: #fff; border-radius: 12px; padding: 16px; margin-top: 16px; }
    .history-title { font-size: 12px; color: #888; text-transform: uppercase; font-weight: 600; margin-bottom: 8px; }
    .history-item { padding: 8px 0; border-bottom: 1px solid #f0f0f0; font-size: 13px; display: flex; justify-content: space-between; align-items: center; }
    .history-item:last-child { border-bottom: none; }
    .history-item .time { color: #888; }
    .history-item a { color: #4285F4; text-decoration: none; font-size: 12px; }
    .clear-btn { font-size: 12px; color: #aaa; background: none; border: none; cursor: pointer; margin-top: 8px; }
    .clear-btn:hover { color: #e53e3e; }
    .saved-badge { font-size: 11px; color: #38a169; margin-left: 8px; }
  </style>
</head>
<body>
  <nav>
    <a href="/">Home</a>
    <a href="/privacy">Privacy</a>
    <a href="/usage">Usage</a>
    <a href="/trigger" class="active">Trigger</a>
  </nav>
  <div class="container">
    <h1>Trigger Routine</h1>
    <p class="subtitle">Fire a Claude Code routine via API</p>

    <div class="section">
      <label>API Token <span id="savedBadge" class="saved-badge" style="display:none">saved</span></label>
      <div class="key-row">
        <input id="apiKey" type="password" placeholder="sk-ant-oat01-..." />
        <button class="btn-small" id="saveBtn">Save</button>
        <button class="btn-small" id="clearKeyBtn">Clear</button>
      </div>
    </div>

    <div class="section">
      <label>Trigger URL</label>
      <input id="triggerUrl" type="text" value="https://api.anthropic.com/v1/claude_code/routines/trig_01Vt4Cvnebv8NYdArZFqLu6F/fire" />
    </div>

    <div class="section">
      <label>Context (optional)</label>
      <textarea id="contextText" placeholder="Optional text to pass to the routine..."></textarea>
    </div>

    <button class="fire-btn" id="fireBtn">Fire Routine</button>
    <div id="status" class="status"></div>
    <div id="resultBox"></div>
    <div id="historyBox"></div>
  </div>

  <script>
    const LS_KEY = "whyapp_trigger_apikey";
    const LS_URL = "whyapp_trigger_url";
    const LS_HISTORY = "whyapp_trigger_history";

    const apiKeyInput = document.getElementById("apiKey");
    const triggerUrlInput = document.getElementById("triggerUrl");
    const contextText = document.getElementById("contextText");
    const fireBtn = document.getElementById("fireBtn");
    const saveBtn = document.getElementById("saveBtn");
    const clearKeyBtn = document.getElementById("clearKeyBtn");
    const savedBadge = document.getElementById("savedBadge");
    const statusEl = document.getElementById("status");
    const resultBox = document.getElementById("resultBox");
    const historyBox = document.getElementById("historyBox");

    // Load saved values
    const savedKey = localStorage.getItem(LS_KEY);
    if (savedKey) { apiKeyInput.value = savedKey; savedBadge.style.display = "inline"; }
    const savedUrl = localStorage.getItem(LS_URL);
    if (savedUrl) triggerUrlInput.value = savedUrl;

    saveBtn.addEventListener("click", () => {
      const key = apiKeyInput.value.trim();
      if (key) {
        localStorage.setItem(LS_KEY, key);
        savedBadge.style.display = "inline";
      }
      const url = triggerUrlInput.value.trim();
      if (url) localStorage.setItem(LS_URL, url);
    });

    clearKeyBtn.addEventListener("click", () => {
      localStorage.removeItem(LS_KEY);
      apiKeyInput.value = "";
      savedBadge.style.display = "none";
    });

    triggerUrlInput.addEventListener("change", () => {
      localStorage.setItem(LS_URL, triggerUrlInput.value.trim());
    });

    fireBtn.addEventListener("click", fire);

    async function fire() {
      const key = apiKeyInput.value.trim();
      const url = triggerUrlInput.value.trim();
      if (!key) { showStatus("Enter your API token", "error"); return; }
      if (!url) { showStatus("Enter a trigger URL", "error"); return; }

      fireBtn.disabled = true;
      fireBtn.textContent = "Firing...";
      showStatus("Sending request...", "");
      resultBox.innerHTML = "";

      try {
        const ctx = contextText.value.trim();
        const resultKey = crypto.randomUUID();
        const fullContext = "RESULT_KEY: " + resultKey + (ctx ? "\\n\\n" + ctx : "");

        const res = await fetch("/api/trigger", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ apiKey: key, triggerUrl: url, text: fullContext })
        });

        const data = await res.json();

        if (!res.ok) {
          showStatus("Error " + res.status + ": " + (data.error?.message || JSON.stringify(data)), "error");
          resultBox.innerHTML = '<div class="result"><div class="result-title">Response</div><pre>' + JSON.stringify(data, null, 2) + '</pre></div>';
          return;
        }

        showStatus("Routine fired! Waiting for results...", "success");
        let resultHtml = '<div class="result"><div class="result-title">Session</div>';
        if (data.claude_code_session_url) {
          resultHtml += '<a href="' + data.claude_code_session_url + '" target="_blank">Open session in Claude &rarr;</a>';
        }
        resultHtml += '<div id="pollStatus" style="margin-top:12px;font-size:13px;color:#888">Polling for results...</div>';
        resultHtml += '<div id="routineOutput"></div>';
        resultHtml += '</div>';
        resultBox.innerHTML = resultHtml;

        // Poll for results using the result key we passed in context
        pollForResults(resultKey);

        // Save to history
        const history = JSON.parse(localStorage.getItem(LS_HISTORY) || "[]");
        history.unshift({
          time: new Date().toISOString(),
          resultKey: resultKey,
          sessionId: data.claude_code_session_id || null,
          sessionUrl: data.claude_code_session_url || null,
          context: ctx ? ctx.slice(0, 100) : null
        });
        if (history.length > 20) history.length = 20;
        localStorage.setItem(LS_HISTORY, JSON.stringify(history));
        renderHistory();

      } catch (e) {
        showStatus("Request failed: " + e.message, "error");
      } finally {
        fireBtn.disabled = false;
        fireBtn.textContent = "Fire Routine";
      }
    }

    function showStatus(msg, type) {
      statusEl.textContent = msg;
      statusEl.className = "status" + (type ? " " + type : "");
    }

    let pollTimer = null;
    function pollForResults(sessionId) {
      let attempts = 0;
      const maxAttempts = 60; // 5 min at 5s intervals
      const pollStatus = document.getElementById("pollStatus");
      const routineOutput = document.getElementById("routineOutput");

      function poll() {
        attempts++;
        fetch("/api/trigger-results/" + sessionId)
          .then(r => r.json())
          .then(data => {
            if (data.status === "pending") {
              if (attempts >= maxAttempts) {
                pollStatus.textContent = "Timed out waiting for results. The routine may still be running.";
                pollStatus.style.color = "#e53e3e";
                return;
              }
              pollStatus.textContent = "Waiting for results... (" + (attempts * 5) + "s)";
              pollTimer = setTimeout(poll, 5000);
            } else {
              pollStatus.textContent = "Results received!";
              pollStatus.style.color = "#38a169";
              routineOutput.innerHTML = '<div class="result-title" style="margin-top:12px">Output</div><pre style="background:#f8f8f8;border-radius:8px;padding:12px;font-size:13px;white-space:pre-wrap;word-break:break-word;line-height:1.6">' + escapeHtml(data.output || "(no output)") + '</pre>';
            }
          })
          .catch(() => {
            pollStatus.textContent = "Poll error. Retrying...";
            if (attempts < maxAttempts) pollTimer = setTimeout(poll, 5000);
          });
      }
      poll();
    }

    function loadResult(resultKey) {
      const routineOutput = document.getElementById("routineOutput");
      if (!routineOutput) {
        resultBox.innerHTML = '<div class="result"><div id="pollStatus" style="font-size:13px;color:#888">Loading...</div><div id="routineOutput"></div></div>';
      }
      fetch("/api/trigger-results/" + resultKey)
        .then(r => r.json())
        .then(data => {
          const out = document.getElementById("routineOutput") || resultBox;
          if (data.status === "pending") {
            out.innerHTML = '<p style="color:#888;font-size:13px;margin-top:8px">No results yet for this run.</p>';
          } else {
            out.innerHTML = '<div class="result-title" style="margin-top:12px">Output</div><pre style="background:#f8f8f8;border-radius:8px;padding:12px;font-size:13px;white-space:pre-wrap;word-break:break-word;line-height:1.6">' + escapeHtml(data.output || "(no output)") + '</pre>';
          }
          const ps = document.getElementById("pollStatus");
          if (ps) ps.style.display = "none";
        });
    }

    function escapeHtml(s) {
      return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
    }

    function renderHistory() {
      const history = JSON.parse(localStorage.getItem(LS_HISTORY) || "[]");
      if (history.length === 0) { historyBox.innerHTML = ""; return; }

      let html = '<div class="history"><div class="history-title">Recent Runs</div>';
      for (const h of history) {
        const time = new Date(h.time).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
        html += '<div class="history-item"><span class="time">' + time + '</span>';
        if (h.context) html += '<span style="color:#666;margin:0 8px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + h.context + '</span>';
        if (h.resultKey) html += '<a href="#" onclick="loadResult(\\'' + h.resultKey + '\\');return false" style="margin-right:8px">View results</a>';
        if (h.sessionUrl) html += '<a href="' + h.sessionUrl + '" target="_blank">Session</a>';
        html += '</div>';
      }
      html += '<button class="clear-btn" onclick="localStorage.removeItem(\\'whyapp_trigger_history\\');historyBox.innerHTML=\\'\\'">Clear history</button>';
      html += '</div>';
      historyBox.innerHTML = html;
    }

    renderHistory();
  </script>
</body>
</html>`;

const segmentPage = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Roboflow Segmentation — whyapp</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f5f5f5; color: #222; padding: 16px; }
    .container { max-width: 720px; margin: 0 auto; }
    h1 { font-size: 24px; font-weight: 700; margin-bottom: 4px; }
    .subtitle { font-size: 14px; color: #888; margin-bottom: 20px; }
    nav { max-width: 720px; margin: 0 auto; display: flex; gap: 24px; padding: 16px 0; }
    nav a { font-size: 14px; color: #666; text-decoration: none; font-weight: 500; }
    nav a:hover { color: #4285F4; }
    nav a.active { color: #4285F4; font-weight: 700; }
    .section { background: #fff; border-radius: 12px; padding: 16px; margin-bottom: 12px; }
    .section label { display: block; font-size: 12px; color: #888; text-transform: uppercase; font-weight: 600; margin-bottom: 6px; }
    .section input[type=text], .section input[type=password] { width: 100%; padding: 10px 12px; border: 1px solid #ddd; border-radius: 8px; font-size: 14px; font-family: inherit; }
    .key-row { display: flex; gap: 8px; align-items: center; }
    .key-row input[type=text] { flex: 1; }
    .btn-small { padding: 10px 14px; border: 1px solid #ddd; border-radius: 8px; background: #fff; font-size: 13px; cursor: pointer; white-space: nowrap; }
    .btn-small:hover { background: #f5f5f5; }
    .fire-btn { width: 100%; padding: 14px; border: none; border-radius: 12px; background: #4285F4; color: #fff; font-size: 16px; font-weight: 600; cursor: pointer; }
    .fire-btn:hover { background: #3367d6; }
    .fire-btn:disabled { background: #a4c2f4; cursor: not-allowed; }
    .status { margin-top: 12px; font-size: 14px; color: #666; }
    .status.error { color: #e53e3e; }
    .status.success { color: #38a169; }
    .result { background: #fff; border-radius: 12px; padding: 16px; margin-top: 16px; }
    .result-title { font-size: 12px; color: #888; text-transform: uppercase; font-weight: 600; margin-bottom: 8px; }
    .canvas-wrap { width: 100%; overflow-x: auto; background: #f8f8f8; border-radius: 8px; }
    canvas { display: block; max-width: 100%; }
    pre { background: #f8f8f8; border-radius: 8px; padding: 12px; font-size: 12px; overflow-x: auto; white-space: pre-wrap; word-break: break-all; max-height: 320px; }
    .preds-table { width: 100%; font-size: 13px; border-collapse: collapse; margin-top: 8px; }
    .preds-table th { text-align: left; padding: 6px 8px; border-bottom: 1px solid #eee; color: #888; font-weight: 600; }
    .preds-table td { padding: 6px 8px; border-bottom: 1px solid #f5f5f5; }
    .swatch { display: inline-block; width: 12px; height: 12px; border-radius: 3px; margin-right: 6px; vertical-align: middle; }
    .saved-badge { font-size: 11px; color: #38a169; margin-left: 8px; }
  </style>
</head>
<body>
  <nav>
    <a href="/">Home</a>
    <a href="/privacy">Privacy</a>
    <a href="/usage">Usage</a>
    <a href="/trigger">Trigger</a>
    <a href="/segment" class="active">Segment</a>
  </nav>
  <div class="container">
    <h1>Roboflow Segmentation</h1>
    <p class="subtitle">Test the general-segmentation workflow</p>

    <div class="section">
      <label>API Key <span id="savedBadge" class="saved-badge" style="display:none">saved</span></label>
      <div class="key-row">
        <input id="apiKey" type="password" placeholder="Roboflow API key" />
        <button class="btn-small" id="saveBtn">Save</button>
        <button class="btn-small" id="clearKeyBtn">Clear</button>
      </div>
    </div>

    <div class="section">
      <label>Workflow URL</label>
      <input id="workflowUrl" type="text" value="https://serverless.roboflow.com/wally-yokel/workflows/general-segmentation-api" />
    </div>

    <div class="section">
      <label>Image</label>
      <div class="key-row">
        <input id="imageUrl" type="text" placeholder="https://example.com/photo.jpg" />
        <button class="btn-small" id="uploadBtn">Upload file</button>
        <input id="imageFile" type="file" accept="image/*" style="display:none" />
      </div>
      <div id="fileLabel" style="font-size:12px;color:#888;margin-top:6px"></div>
    </div>

    <div class="section">
      <label>Classes (comma-separated)</label>
      <input id="classes" type="text" value="person, dog, cat" />
    </div>

    <button class="fire-btn" id="runBtn">Run Segmentation</button>
    <div id="status" class="status"></div>
    <div id="resultBox"></div>
  </div>

  <script>
    const LS_KEY = "whyapp_segment_apikey";
    const LS_URL = "whyapp_segment_url";
    const LS_CLASSES = "whyapp_segment_classes";
    const LS_IMAGE_URL = "whyapp_segment_image_url";

    const apiKeyInput = document.getElementById("apiKey");
    const workflowUrlInput = document.getElementById("workflowUrl");
    const imageUrlInput = document.getElementById("imageUrl");
    const imageFile = document.getElementById("imageFile");
    const uploadBtn = document.getElementById("uploadBtn");
    const fileLabel = document.getElementById("fileLabel");
    const classesInput = document.getElementById("classes");
    const runBtn = document.getElementById("runBtn");
    const saveBtn = document.getElementById("saveBtn");
    const clearKeyBtn = document.getElementById("clearKeyBtn");
    const savedBadge = document.getElementById("savedBadge");
    const statusEl = document.getElementById("status");
    const resultBox = document.getElementById("resultBox");

    let uploadedBase64 = null;
    let uploadedDataUrl = null;

    // Load saved values
    const savedKey = localStorage.getItem(LS_KEY);
    if (savedKey) { apiKeyInput.value = savedKey; savedBadge.style.display = "inline"; }
    const savedUrl = localStorage.getItem(LS_URL);
    if (savedUrl) workflowUrlInput.value = savedUrl;
    const savedClasses = localStorage.getItem(LS_CLASSES);
    if (savedClasses) classesInput.value = savedClasses;
    const savedImageUrl = localStorage.getItem(LS_IMAGE_URL);
    if (savedImageUrl) imageUrlInput.value = savedImageUrl;

    saveBtn.addEventListener("click", () => {
      const k = apiKeyInput.value.trim();
      if (k) { localStorage.setItem(LS_KEY, k); savedBadge.style.display = "inline"; }
      localStorage.setItem(LS_URL, workflowUrlInput.value.trim());
    });
    clearKeyBtn.addEventListener("click", () => {
      localStorage.removeItem(LS_KEY);
      apiKeyInput.value = "";
      savedBadge.style.display = "none";
    });
    classesInput.addEventListener("change", () => localStorage.setItem(LS_CLASSES, classesInput.value.trim()));
    imageUrlInput.addEventListener("change", () => localStorage.setItem(LS_IMAGE_URL, imageUrlInput.value.trim()));

    uploadBtn.addEventListener("click", () => imageFile.click());
    imageFile.addEventListener("change", () => {
      const f = imageFile.files && imageFile.files[0];
      if (!f) return;
      fileLabel.textContent = f.name + " (" + Math.round(f.size / 1024) + " KB)";
      const reader = new FileReader();
      reader.onload = () => {
        uploadedDataUrl = reader.result;
        uploadedBase64 = uploadedDataUrl.split(",")[1];
        imageUrlInput.value = "";
      };
      reader.readAsDataURL(f);
    });
    imageUrlInput.addEventListener("input", () => {
      if (imageUrlInput.value.trim()) {
        uploadedBase64 = null;
        uploadedDataUrl = null;
        fileLabel.textContent = "";
        imageFile.value = "";
      }
    });

    runBtn.addEventListener("click", run);

    function showStatus(msg, type) {
      statusEl.textContent = msg;
      statusEl.className = "status" + (type ? " " + type : "");
    }

    async function run() {
      const apiKey = apiKeyInput.value.trim();
      const workflowUrl = workflowUrlInput.value.trim();
      const classes = classesInput.value.trim();
      const url = imageUrlInput.value.trim();

      if (!apiKey) { showStatus("Enter your Roboflow API key", "error"); return; }
      if (!workflowUrl) { showStatus("Enter the workflow URL", "error"); return; }
      if (!url && !uploadedBase64) { showStatus("Provide an image URL or upload a file", "error"); return; }

      const image = url
        ? { type: "url", value: url }
        : { type: "base64", value: uploadedBase64 };
      const displaySrc = url || uploadedDataUrl;

      runBtn.disabled = true;
      runBtn.textContent = "Running...";
      showStatus("Calling Roboflow...", "");
      resultBox.innerHTML = "";

      const t0 = performance.now();
      try {
        const res = await fetch("/api/segment", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workflowUrl, apiKey, image, classes }),
        });
        const data = await res.json();
        const elapsed = ((performance.now() - t0) / 1000).toFixed(2);

        if (!res.ok) {
          showStatus("Error " + res.status + " (" + elapsed + "s)", "error");
          resultBox.innerHTML = '<div class="result"><div class="result-title">Response</div><pre>' + escapeHtml(JSON.stringify(data, null, 2)) + '</pre></div>';
          return;
        }
        showStatus("Done in " + elapsed + "s", "success");
        renderResult(data, displaySrc);
      } catch (e) {
        showStatus("Request failed: " + e.message, "error");
      } finally {
        runBtn.disabled = false;
        runBtn.textContent = "Run Segmentation";
      }
    }

    function findPredictions(node, out) {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) { node.forEach(n => findPredictions(n, out)); return; }
      if (Array.isArray(node.predictions) && node.predictions.length && typeof node.predictions[0] === "object" && "class" in node.predictions[0]) {
        out.push(node);
      }
      for (const k of Object.keys(node)) {
        if (k === "predictions") continue;
        findPredictions(node[k], out);
      }
    }

    const PALETTE = ["#4285F4","#EA4335","#FBBC04","#34A853","#7c3aed","#f59e0b","#10b981","#ef4444","#06b6d4","#a855f7"];

    function renderResult(data, displaySrc) {
      const found = [];
      findPredictions(data, found);

      let html = '<div class="result"><div class="result-title">Image with predictions</div>';
      html += '<div class="canvas-wrap"><canvas id="overlayCanvas"></canvas></div>';
      html += '<div id="predsTable"></div>';
      html += '</div>';
      html += '<div class="result"><div class="result-title">Raw response</div><pre>' + escapeHtml(JSON.stringify(data, null, 2)) + '</pre></div>';
      resultBox.innerHTML = html;

      const canvas = document.getElementById("overlayCanvas");
      const tableHost = document.getElementById("predsTable");
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => drawOverlay(canvas, img, found, tableHost);
      img.onerror = () => {
        canvas.width = 1; canvas.height = 1;
        tableHost.innerHTML = '<div style="color:#aaa;font-size:13px;margin-top:8px">Could not load image for overlay. (Cross-origin block?) Raw response is below.</div>';
        if (found.length) renderTable(found[0], tableHost, []);
      };
      img.src = displaySrc;
    }

    function drawOverlay(canvas, img, found, tableHost) {
      const W = img.naturalWidth, H = img.naturalHeight;
      canvas.width = W;
      canvas.height = H;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0);

      if (!found.length) {
        tableHost.innerHTML = '<div style="color:#aaa;font-size:13px;margin-top:8px">No predictions found in response.</div>';
        return;
      }

      const block = found[0];
      const refW = block.image && block.image.width || W;
      const refH = block.image && block.image.height || H;
      const sx = W / refW, sy = H / refH;

      const classColors = {};
      let palIdx = 0;
      const colorFor = (c) => {
        if (!classColors[c]) classColors[c] = PALETTE[palIdx++ % PALETTE.length];
        return classColors[c];
      };

      ctx.lineWidth = Math.max(2, Math.round(W / 400));
      ctx.font = Math.max(14, Math.round(W / 60)) + "px sans-serif";

      for (const p of block.predictions) {
        const color = colorFor(p.class);
        ctx.strokeStyle = color;
        ctx.fillStyle = color + "33";

        if (Array.isArray(p.points) && p.points.length > 2) {
          ctx.beginPath();
          p.points.forEach((pt, i) => {
            const x = pt.x * sx, y = pt.y * sy;
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          });
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
        } else if (typeof p.x === "number" && typeof p.width === "number") {
          const x = (p.x - p.width / 2) * sx, y = (p.y - p.height / 2) * sy;
          ctx.strokeRect(x, y, p.width * sx, p.height * sy);
          ctx.fillRect(x, y, p.width * sx, p.height * sy);
        }

        // Label
        const lx = (p.x - (p.width || 0) / 2) * sx;
        const ly = (p.y - (p.height || 0) / 2) * sy;
        const label = p.class + " " + (p.confidence ? (p.confidence * 100).toFixed(1) + "%" : "");
        const tw = ctx.measureText(label).width + 8;
        const th = parseInt(ctx.font, 10) + 6;
        ctx.fillStyle = color;
        ctx.fillRect(lx, Math.max(0, ly - th), tw, th);
        ctx.fillStyle = "#fff";
        ctx.fillText(label, lx + 4, Math.max(th - 4, ly - 4));
      }

      renderTable(block, tableHost, classColors);
    }

    function renderTable(block, host, classColors) {
      const preds = block.predictions || [];
      let html = '<table class="preds-table"><thead><tr><th>#</th><th>Class</th><th>Confidence</th><th>Bbox (x,y,w,h)</th><th>Mask pts</th></tr></thead><tbody>';
      preds.forEach((p, i) => {
        const color = (classColors && classColors[p.class]) || "#888";
        const bbox = (typeof p.x === "number") ? Math.round(p.x) + ", " + Math.round(p.y) + ", " + Math.round(p.width || 0) + ", " + Math.round(p.height || 0) : "—";
        const mask = Array.isArray(p.points) ? p.points.length : 0;
        html += '<tr><td>' + (i + 1) + '</td><td><span class="swatch" style="background:' + color + '"></span>' + escapeHtml(p.class || "") + '</td><td>' + (p.confidence ? (p.confidence * 100).toFixed(1) + "%" : "—") + '</td><td>' + bbox + '</td><td>' + mask + '</td></tr>';
      });
      html += '</tbody></table>';
      host.innerHTML = html;
    }

    function escapeHtml(s) {
      return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
    }
  </script>
</body>
</html>`;

const LAB_BUILD_URL = "https://expo.dev/accounts/wesyoakum/projects/whylab/builds/b32cb9c6-faa9-4f91-88c9-2e6a0b618955";
const LAB_BUILD_VERSION = "1.24.2";
const LAB_QR_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAcIAAAHCAQAAAABUY/ToAAAD+klEQVR4nO1cbY6bMBAdD0j7k0g9wB6FvUGP1DPtDeAoOUCl5GckVlPN2GNMW+rEYZusmfcjIuAnEfL05sPGjqAMIxYSAYyZA2ZHrMGYOWB2xBqMmQNmR6zBmDlgdsQajJkDZkeswZg1PiEX0PojGF0LyQec5UNHvT34bkuARSyGMa98Qj0xTgBENEFQSXdxAN3kR7g3aGSQJuH2bHPAnTHP6i/jAYAGPuqPLbi3M3vT4cPJKLGqJ7jb24EFHA9j3vyE+qOqZHwNFgTQRff5B/NqoDGrekLt3066XiTDWVA/AFAFvxON+eka6lgoZ3af71OromkmGA8/W+jfv03EV1M12b+SA+6ECWmaDA1Bf1r9AEgS8OFr/U405if7EM0nJAsaDw170wTefcZXqdCWMc3+lRxwZz7UTSB2QwPnz95z5ByFC/6qDDYfqlEJeK+GehUIkRxJp4iFxGqSUl8aRyIpP8xiWWVKwGImqHTUbmIdT4NvKopoYpXPMB+qUQlYzITgKqoXSazDEedDwYw4ls0uZT5UoRLwfh9iJAEtxjKKFySq+RzJYll9SsBtNETiPiHFluyalmpKGJYPVaYEvDunJm0S+ew6Kge0TBMzCmWaaahCJeA2PcYuuM9vdTz0SXqkmZH5UGVKwE36Q+D71HJ6NqNm0T3ia6ahGpWA98eySTOepBoDLfB9Os3uIzmS+VCFSsAtcmoIaLQ/pMvP5h7jHN8sltWmBLyT6XiVmYiG6CRHISmCGNqcO8jHE9xtCbCIxTBmFuQjkwQqjlvBc+QrqEupkHQOzXzoGuD+8iGKyc483UpzGJtDm+VDNSoBi5nwZ2N6SlpDJBry1VhsNJoP1agE3KK2J8mHwmxG9JxTnHjVGXzTUJVKwPt7jA0tekHBkSD2GPXNIfOhSpWAm2hokGoszpyFZvW0CGMqJKvta1MCbrSOEXStkOTPy4lXH+mYYvlQjUrAjdYxTouQpc1qXb0Yp0PMhypUAhYzIU1x5IR2ipIZ/CG+o2ixrFol4CbvdfTErye+O5bKgV/kuDia3+bgtxXdg+8Wjfnsaz9AEutlP/EU18JK1Wax7HrgDmMZ+eAVFuYnidKgygmz+pYPVagE3GzfDyebf0gmPfJORIL+9OGSr4+/29uBBRwPY2ZBaQ0WotX8LplAW9Qh0llddiVwp0ya97Aa3cvyjdeLcz+OL7aH1Vf6P/8nswu1vciHhvMLe87FrySSjawAziKfsJvVV/2dtwMLOLvcO2b0yuCdGlhIfORkH7R++GhluwY5R+OrHD3qbtGYT/iEnO1xngHmBqzCmDlgdsQajJkDZkeswZg5YHbEGoyZA2ZHrMGYOWB2BOyc+QtGv5etEadGUwAAAABJRU5ErkJggg==";

const labPage = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>WHY Lab — Install</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #111; color: #fff; min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 24px; }
    h1 { font-size: 32px; font-weight: 700; margin-bottom: 8px; }
    .subtitle { font-size: 14px; color: #888; margin-bottom: 24px; }
    .qr { margin-bottom: 16px; background: #fff; padding: 16px; border-radius: 16px; }
    .qr img { display: block; width: 256px; height: 256px; image-rendering: pixelated; }
    .build-info { font-size: 13px; color: #aaa; margin-bottom: 8px; text-align: center; }
    a.build-link { color: #4285F4; text-decoration: none; font-size: 14px; display: block; text-align: center; }
    a.build-link:hover { text-decoration: underline; }
    nav { width: 100%; max-width: 400px; display: flex; justify-content: center; gap: 24px; padding: 16px 0; margin-bottom: 16px; }
    nav a { font-size: 14px; color: #666; text-decoration: none; font-weight: 500; }
    nav a:hover { color: #4285F4; }
    nav a.active { color: #4285F4; font-weight: 700; }
  </style>
</head>
<body>
  <nav>
    <a href="/">Home</a>
    <a href="/lab" class="active">Lab</a>
    <a href="/privacy">Privacy</a>
  </nav>
  <h1>WHY Lab</h1>
  <p class="subtitle">Scan to install the latest build</p>
  <div class="qr"><img src="data:image/png;base64,` + LAB_QR_BASE64 + `" alt="QR code" /></div>
  <div class="build-info">v` + LAB_BUILD_VERSION + `</div>
  <a class="build-link" href="` + LAB_BUILD_URL + `" target="_blank">Install &rarr;</a>

  <div style="margin-top: 48px; border-top: 1px solid #333; padding-top: 32px; width: 100%; max-width: 400px; text-align: center;">
    <h2 style="font-size: 20px; font-weight: 600; margin-bottom: 8px;">Remote Control</h2>
    <p class="subtitle" style="margin-bottom: 16px;">Paste a session URL to generate a QR code</p>
    <input id="rcUrl" type="text" placeholder="https://claude.ai/code/..." style="width: 100%; padding: 10px 12px; border: 1px solid #333; border-radius: 8px; font-size: 14px; background: #222; color: #fff; margin-bottom: 16px;" />
    <div id="rcQr" style="display: none; background: #fff; padding: 16px; border-radius: 16px; display: inline-block;">
      <img id="rcImg" style="display: block; width: 256px; height: 256px;" alt="QR code" />
    </div>
  </div>
  <script>
    var rcInput = document.getElementById("rcUrl");
    var rcQr = document.getElementById("rcQr");
    var rcImg = document.getElementById("rcImg");
    rcQr.style.display = "none";
    rcInput.addEventListener("input", function() {
      var url = rcInput.value.trim();
      if (url && url.startsWith("http")) {
        rcImg.src = "https://api.qrserver.com/v1/create-qr-code/?size=256x256&data=" + encodeURIComponent(url);
        rcQr.style.display = "inline-block";
      } else {
        rcQr.style.display = "none";
      }
    });
  <\/script>
</body>
</html>`;
