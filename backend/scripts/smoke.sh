#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Backend integration smoke test — boots the real server against a throwaway
# SQLite DB and asserts the security / optimistic-locking behaviour that unit
# tests can't cover (auth, report workflow, IDOR, param validation, rate caps).
#
# Run from anywhere:  npm run smoke   (or: bash scripts/smoke.sh)
# Exits non-zero if any assertion fails — safe to gate a deploy on.
#
# Requires: the DB seed password below to match init-db.js (default users).
# ─────────────────────────────────────────────────────────────────────────────
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # backend/
cd "$HERE"

PORT="${SMOKE_PORT:-3399}"
SEED_PW="${SMOKE_SEED_PW:-ChangeMe!2026}"
export DATA_DIR="$(mktemp -d)"
export JWT_SECRET="smoke-test-secret-0123456789abcdef0123456789abcd"
export PORT
export EMAIL_ENABLED=""
unset ANTHROPIC_API_KEY
LOG="$DATA_DIR/server.log"

cleanup(){ [ -n "${SRV:-}" ] && kill "$SRV" 2>/dev/null; rm -rf "$DATA_DIR"; }
trap cleanup EXIT

echo "seeding throwaway DB in $DATA_DIR"
node init-db.js >/dev/null 2>&1 || { echo "FATAL: init-db failed"; exit 1; }
node server.js >"$LOG" 2>&1 &
SRV=$!

B="http://127.0.0.1:$PORT"
for i in $(seq 1 40); do
  curl -s -o /dev/null "$B/api/health" 2>/dev/null && break
  if ! kill -0 "$SRV" 2>/dev/null; then echo "FATAL: server exited on boot"; cat "$LOG"; exit 1; fi
  sleep 0.25
done

PASS=0; FAIL=0
chk(){ if [ "$2" = "$3" ]; then echo "  PASS: $1 ($3)"; PASS=$((PASS+1)); else echo "  FAIL: $1 — expected $2 got $3"; FAIL=$((FAIL+1)); fi; }
code(){ curl -s -o /dev/null -w "%{http_code}" "$@"; }
login(){ curl -s -X POST "$B/api/auth/login" -H 'content-type: application/json' \
  -d "{\"username\":\"$1\",\"password\":\"$SEED_PW\"}" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).token||"")}catch{console.log("")}})'; }

TOK_OPS=$(login kostas); TOK_FIN=$(login manos); TOK_ADM=$(login antonis)
[ -z "$TOK_OPS" ] && { echo "FATAL: login failed (seed password mismatch?)"; cat "$LOG"; exit 1; }

AH_OPS="Authorization: Bearer $TOK_OPS"
AH_FIN="Authorization: Bearer $TOK_FIN"
AH_ADM="Authorization: Bearer $TOK_ADM"
CT="content-type: application/json"
C="Coca-Cola"   # in kostas' (ops) portfolio

echo "── H1: report workflow authorization ──"
chk "ops save draft (envelope)"     200 "$(code -X PUT "$B/api/data/2026/$C" -H "$AH_OPS" -H "$CT" -d '{"data":{"status":"draft"},"baseVersion":0}')"
chk "ops save submitted"            200 "$(code -X PUT "$B/api/data/2026/$C" -H "$AH_OPS" -H "$CT" -d '{"data":{"status":"submitted","submittedBy":"Kostas"},"baseVersion":1}')"
chk "ops CANNOT approve"            403 "$(code -X PUT "$B/api/data/2026/$C" -H "$AH_OPS" -H "$CT" -d '{"data":{"status":"approved"},"baseVersion":2}')"
chk "finance CAN approve"           200 "$(code -X PUT "$B/api/data/2026/$C" -H "$AH_FIN" -H "$CT" -d '{"data":{"status":"approved"},"baseVersion":2}')"

echo "── M1: optimistic-lock envelope required ──"
chk "raw body (no envelope)"        400 "$(code -X PUT "$B/api/data/2026/$C" -H "$AH_FIN" -H "$CT" -d '{"status":"draft"}')"
chk "NaN baseVersion"               400 "$(code -X PUT "$B/api/data/2026/$C" -H "$AH_FIN" -H "$CT" -d '{"data":{"status":"draft"},"baseVersion":"x"}')"
chk "stale baseVersion (conflict)"  409 "$(code -X PUT "$B/api/data/2026/$C" -H "$AH_FIN" -H "$CT" -d '{"data":{"status":"draft"},"baseVersion":0}')"

echo "── IDOR + param validation ──"
chk "ops save foreign client"       403 "$(code -X PUT "$B/api/data/2026/Google" -H "$AH_OPS" -H "$CT" -d '{"data":{},"baseVersion":0}')"
chk "overlong client name"          400 "$(code -X PUT "$B/api/data/2026/$(printf 'x%.0s' {1..90})" -H "$AH_FIN" -H "$CT" -d '{"data":{},"baseVersion":0}')"

echo "── finance blob ──"
chk "finance raw body"              400 "$(code -X PUT "$B/api/finance/2026" -H "$AH_FIN" -H "$CT" -d '{"opex":{}}')"
chk "finance envelope ok"           200 "$(code -X PUT "$B/api/finance/2026" -H "$AH_FIN" -H "$CT" -d '{"data":{"opex":{}},"baseVersion":0}')"
chk "ops CANNOT read finance"       403 "$(code "$B/api/finance/2026" -H "$AH_OPS")"

echo "── L8/L7: user create role + audit clamp ──"
chk "admin create bad role"         400 "$(code -X POST "$B/api/users" -H "$AH_ADM" -H "$CT" -d '{"username":"zz","password":"password123","name":"ZZ","role":"Admin","clients":[]}')"
chk "admin create valid role"       200 "$(code -X POST "$B/api/users" -H "$AH_ADM" -H "$CT" -d '{"username":"zz","password":"password123","name":"ZZ","role":"ops","clients":[]}')"
chk "audit limit=-1 (no crash)"     200 "$(code "$B/api/audit?limit=-1" -H "$AH_ADM")"

echo ""
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || { echo "--- server log tail ---"; tail -8 "$LOG"; }
exit "$FAIL"
