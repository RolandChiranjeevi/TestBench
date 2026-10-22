#!/usr/bin/env bash
# Smoke test for the Docker image. It checks the things that break on a new platform or after a change:
# the image refuses to start without a password, the native database module loads, the login works,
# the web app is served, and Chromium can render a PDF report.
#
# Usage: scripts/docker-smoke.sh [image]        (default image: testbench:latest)
# Runs in CI (see .github/workflows/ci.yml) and works the same on your own machine.
set -euo pipefail

IMAGE="${1:-testbench:latest}"
NAME="testbench-smoke-$$"
PORT="${SMOKE_PORT:-14100}"
PASSWORD="smoke-test-password"
BASE="http://127.0.0.1:${PORT}"
JAR="$(mktemp)"
PDF="$(mktemp)"

cleanup() {
  docker rm -f -v "$NAME" >/dev/null 2>&1 || true
  rm -f "$JAR" "$PDF"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  docker logs --tail 40 "$NAME" >&2 2>&1 || true
  exit 1
}
ok() { echo "ok: $*"; }

HDR=(-H 'X-Testbench: 1' -H 'Content-Type: application/json')

# 1. Safe by default: listening on the network without a password must be refused.
out="$(docker run --rm "$IMAGE" 2>&1)" && fail "the image started without a password"
echo "$out" | grep -q "Refusing to listen" || fail "expected the refusal message, got: $out"
ok "refuses to start without a password"

# 2. Start it with a password and wait for the health check.
docker run -d --name "$NAME" -p "127.0.0.1:${PORT}:4100" -e TESTBENCH_PASSWORD="$PASSWORD" "$IMAGE" >/dev/null
for _ in $(seq 1 45); do
  status="$(docker inspect -f '{{.State.Health.Status}}' "$NAME" 2>/dev/null || echo starting)"
  [ "$status" = "healthy" ] && break
  [ "$(docker inspect -f '{{.State.Running}}' "$NAME")" = "true" ] || fail "the container stopped"
  sleep 2
done
[ "${status:-}" = "healthy" ] || fail "not healthy after 90 seconds (status: ${status:-unknown})"
ok "container is healthy"

# 3. Everything is behind the login until you sign in.
code="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/projects")"
[ "$code" = "401" ] || fail "expected 401 without signing in, got $code"
code="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/")"
[ "$code" = "302" ] || fail "expected a redirect to the login page, got $code"
ok "API and app are behind the login"

code="$(curl -s -o /dev/null -w '%{http_code}' "${HDR[@]}" -X POST -d '{"password":"wrong password"}' "$BASE/api/login")"
[ "$code" = "401" ] || fail "expected 401 for a wrong password, got $code"
curl -fsS -c "$JAR" -o /dev/null "${HDR[@]}" -X POST -d "{\"password\":\"$PASSWORD\"}" "$BASE/api/login" || fail "login failed"
ok "login works"

# 4. The web app is served, and the database works (demo project).
curl -fsS -b "$JAR" "$BASE/" | grep -q 'id="root"' || fail "the web app was not served"
curl -fsS -b "$JAR" -o /dev/null "${HDR[@]}" -X POST -d '{}' "$BASE/api/demo" || fail "could not create the demo project"
ok "web app served and database works"

# 5. A PDF report can be rendered (needs Chromium inside the image).
milestone="$(curl -fsS -b "$JAR" "$BASE/api/projects/1/milestones" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)"
[ -n "$milestone" ] || fail "the demo project has no sprint"
curl -fsS -b "$JAR" -o "$PDF" "$BASE/api/milestones/${milestone}/report.pdf" || fail "PDF export failed"
[ "$(head -c 4 "$PDF")" = "%PDF" ] || fail "the report is not a PDF"
ok "PDF report rendered ($(wc -c < "$PDF" | tr -d ' ') bytes)"

echo "Smoke test passed for $IMAGE"
