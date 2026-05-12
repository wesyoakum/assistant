#!/usr/bin/env bash
# Idempotent first-time deploy helper for the whyapp Worker.
# Run from anywhere; the script cd's to apps/api itself.
set -euo pipefail

cd "$(dirname "$0")/.."

W="pnpm exec wrangler"

step() { printf "\n\033[1;34m==> %s\033[0m\n" "$*"; }
ok()   { printf "    \033[32m✓\033[0m %s\n" "$*"; }
note() { printf "    %s\n" "$*"; }

step "Cloudflare login"
if $W whoami >/dev/null 2>&1; then
  ok "already logged in"
else
  note "opening browser..."
  $W login
fi

step "R2 bucket: whyapp-files"
if $W r2 bucket create whyapp-files 2>&1 | tee /tmp/whyapp-r2.out | grep -qi "already exists\|already in use"; then
  ok "exists"
else
  ok "created"
fi

step "Queue: whyapp-tasks"
if $W queues create whyapp-tasks 2>&1 | tee /tmp/whyapp-q.out | grep -qi "already exists\|already in use"; then
  ok "exists"
else
  ok "created"
fi

step "D1 migrations (whyapp-db, remote)"
$W d1 migrations apply whyapp-db --remote

step "Secrets"
EXISTING="$($W secret list 2>/dev/null || echo '[]')"

put_secret() {
  local name="$1"
  local generator="${2:-}"
  if printf "%s" "$EXISTING" | grep -q "\"$name\""; then
    ok "$name already set"
    return
  fi
  if [ -n "$generator" ]; then
    note "auto-generating $name"
    eval "$generator" | $W secret put "$name"
  else
    note "paste value for $name (input hidden):"
    $W secret put "$name"
  fi
}

put_secret OAUTH_ENCRYPTION_KEY  "openssl rand -base64 32"
put_secret SESSION_JWT_SECRET    "openssl rand -base64 48"
put_secret GOOGLE_CLIENT_SECRET  ""
put_secret ANTHROPIC_API_KEY     ""

step "Deploy"
$W deploy

step "Done"
note "verify: curl https://api.whyapp.us/health"
