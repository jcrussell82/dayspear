#!/usr/bin/env bash
# TEST ONLY — starts a local stand-in for a Supabase project without Docker:
# Postgres + Supabase Auth (GoTrue) + PostgREST + the `api` Edge Function (Deno) + a gateway.
# For everyday local development, use the Supabase CLI instead (`supabase start`).
#
#   STACK_BIN=/path/to/binaries test/stack/stack.sh start   # needs: postgres 16, postgrest, auth (GoTrue + migrations/), deno
#   test/stack/stack.sh stop
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; APP="$(cd "$HERE/../.." && pwd)"
BIN="${STACK_BIN:-/tmp/claude-0/bin}"; PGBIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
RUN="${STACK_DIR:-/tmp/dayspear-stack}"; PGPORT=54322
JWT_SECRET="super-secret-jwt-token-with-at-least-32-characters-long"
APP_URL="${APP_URL:-http://localhost:5173}"

stop() {
  for f in "$RUN"/*.pid; do [ -f "$f" ] && kill "$(cat "$f")" 2>/dev/null || true; rm -f "$f"; done
  if [ -d "$RUN/pg" ]; then as_pg "$PGBIN/pg_ctl" -D "$RUN/pg" -m fast stop >/dev/null 2>&1 || true; fi
}
as_pg() { if [ "$(id -u)" = 0 ]; then runuser -u "${PGUSER_OS:-claude}" -- "$@"; else "$@"; fi; }
jwt() { node -e "const c=require('crypto');const b=o=>Buffer.from(JSON.stringify(o)).toString('base64url');const h=b({alg:'HS256',typ:'JWT'}),p=b({role:'$1',iss:'supabase',iat:1700000000,exp:2000000000});console.log(h+'.'+p+'.'+c.createHmac('sha256','$JWT_SECRET').update(h+'.'+p).digest('base64url'))"; }

if [ "${1:-start}" = stop ]; then stop; exit 0; fi
stop; rm -rf "$RUN"; mkdir -p "$RUN"; chmod 777 "$RUN"
ANON=$(jwt anon); SERVICE=$(jwt service_role)

# Postgres
as_pg "$PGBIN/initdb" -D "$RUN/pg" -U postgres --auth=trust -E UTF8 >/dev/null
as_pg "$PGBIN/pg_ctl" -D "$RUN/pg" -o "-p $PGPORT -k $RUN -c listen_addresses=127.0.0.1" -l "$RUN/pg.log" start >/dev/null
for i in $(seq 1 30); do psql -h 127.0.0.1 -p $PGPORT -U postgres -tAc 'select 1' >/dev/null 2>&1 && break; sleep 0.2; done
psql -h 127.0.0.1 -p $PGPORT -U postgres -q -v ON_ERROR_STOP=1 -f "$HERE/bootstrap.sql"

# Supabase Auth (creates the auth schema), then DaySpear's own migrations
export API_EXTERNAL_URL=http://127.0.0.1:54321/auth/v1 GOTRUE_JWT_SECRET="$JWT_SECRET" GOTRUE_SITE_URL="$APP_URL" GOTRUE_DB_DRIVER=postgres DATABASE_URL="postgres://supabase_auth_admin:authpass@127.0.0.1:$PGPORT/postgres" GOTRUE_DB_NAMESPACE=auth
(cd "$BIN/auth" && ./auth migrate >"$RUN/auth-migrate.log" 2>&1)
for f in "$APP"/supabase/migrations/*.sql; do psql -h 127.0.0.1 -p $PGPORT -U postgres -q -v ON_ERROR_STOP=1 -f "$f"; done

(cd "$BIN/auth" && GOTRUE_JWT_SECRET="$JWT_SECRET" GOTRUE_JWT_EXP=3600 GOTRUE_JWT_AUD=authenticated GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated GOTRUE_JWT_ADMIN_ROLES=service_role \
  API_EXTERNAL_URL=http://127.0.0.1:54321/auth/v1 GOTRUE_SITE_URL="$APP_URL" GOTRUE_URI_ALLOW_LIST="$APP_URL" GOTRUE_API_HOST=127.0.0.1 PORT=9999 \
  GOTRUE_EXTERNAL_EMAIL_ENABLED=true GOTRUE_MAILER_AUTOCONFIRM=false GOTRUE_MAILER_SECURE_EMAIL_CHANGE_ENABLED=false GOTRUE_MAILER_OTP_EXP=600 \
  GOTRUE_SMTP_HOST=127.0.0.1 GOTRUE_SMTP_PORT=2525 GOTRUE_SMTP_USER=x GOTRUE_SMTP_PASS=x GOTRUE_SMTP_ADMIN_EMAIL=no-reply@dayspear.test GOTRUE_SMTP_SENDER_NAME=DaySpear \
  GOTRUE_MAILER_TEMPLATES_MAGIC_LINK=http://127.0.0.1:54321/_tpl/magic_link.html GOTRUE_MAILER_TEMPLATES_CONFIRMATION=http://127.0.0.1:54321/_tpl/confirmation.html \
  GOTRUE_MAILER_TEMPLATES_EMAIL_CHANGE=http://127.0.0.1:54321/_tpl/email_change.html \
  GOTRUE_RATE_LIMIT_EMAIL_SENT=10000 GOTRUE_RATE_LIMIT_OTP=10000 GOTRUE_RATE_LIMIT_VERIFY=10000 GOTRUE_RATE_LIMIT_TOKEN_REFRESH=10000 GOTRUE_SMTP_MAX_FREQUENCY=1ns \
  GOTRUE_EXTERNAL_PHONE_ENABLED=false \
  nohup ./auth serve >"$RUN/auth.log" 2>&1 & echo $! >"$RUN/auth.pid")

PGRST_DB_URI="postgres://authenticator:authpass@127.0.0.1:$PGPORT/postgres" PGRST_DB_SCHEMAS=public PGRST_DB_ANON_ROLE=anon PGRST_JWT_SECRET="$JWT_SECRET" PGRST_SERVER_PORT=54330 PGRST_SERVER_HOST=127.0.0.1 \
  nohup "$BIN/postgrest" >"$RUN/rest.log" 2>&1 & echo $! >"$RUN/rest.pid"

node "$HERE/gateway.mjs" >"$RUN/gateway.log" 2>&1 & echo $! >"$RUN/gateway.pid"

(cd "$APP/supabase/functions/api" && SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_SERVICE_ROLE_KEY="$SERVICE" APP_URL="$APP_URL" ALLOWED_ORIGINS="$APP_URL,http://localhost:5173" \
  STRIPE_SECRET_KEY="${STRIPE_SECRET_KEY:-sk_test_fake}" STRIPE_WEBHOOK_SECRET="${STRIPE_WEBHOOK_SECRET:-whsec_test_local}" STRIPE_PRICE_TEAM=price_team_test STRIPE_PRICE_BUSINESS=price_biz_test \
  STRIPE_API_BASE=http://127.0.0.1:54350 ADMIN_EMAILS="${ADMIN_EMAILS:-admin@dayspear.test}" DENO_DIR="$RUN/deno" \
  nohup "$BIN/deno" run --allow-net --allow-env "$HERE/fn-local.ts" >"$RUN/fn.log" 2>&1 & echo $! >"$RUN/fn.pid")

for i in $(seq 1 60); do curl -sf http://127.0.0.1:54321/functions/v1/api/health >/dev/null 2>&1 && curl -sf http://127.0.0.1:54321/auth/v1/health >/dev/null 2>&1 && break; sleep 0.25; done
cat >"$RUN/env.json" <<JSON
{"url":"http://127.0.0.1:54321","anon":"$ANON","service":"$SERVICE","pg":"postgres://postgres@127.0.0.1:$PGPORT/postgres"}
JSON
echo "stack up: http://127.0.0.1:54321 (details in $RUN/env.json)"
