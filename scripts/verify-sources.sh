#!/usr/bin/env bash
# verify-sources.sh — re-verify every factual claim in docs/08-source-landscape.md
#
# Polite by construction: one request at a time, DELAY seconds between requests,
# no recursion, no crawling. Safe to run against production TUP sites.
#
# Usage:
#   ./scripts/verify-sources.sh                       # human-readable to stdout
#   ./scripts/verify-sources.sh > docs/verification/$(date +%F).txt
#
# Any diff against docs/08-source-landscape.md is a FINDING, not noise.

set -uo pipefail

DELAY="${DELAY:-3}"
TIMEOUT="${TIMEOUT:-20}"
BOT_UA="TUPOpenDataBot/1.0 (+https://github.com/kienserapio/TUP-API; student open-data project)"

pause() { sleep "$DELAY"; }

hr()  { printf '%s\n' "------------------------------------------------------------"; }
sec() { printf '\n============================================================\n%s\n============================================================\n' "$1"; }

# status <label> <url> — follow redirects, report code, final URL, size, protocol
status() {
  local label="$1" url="$2" extra="${3:-}"
  printf '  %-56s ' "$label"
  # shellcheck disable=SC2086
  curl -sS -o /dev/null -L --max-time "$TIMEOUT" -A "$BOT_UA" $extra \
    -w 'HTTP %{http_code}  h%{http_version}  %{size_download}b  final=%{url_effective}\n' \
    "$url" 2>&1 || printf 'REQUEST FAILED\n'
  pause
}

# headers <label> <url> — report the headers that drive fetcher design
headers() {
  local label="$1" url="$2" extra="${3:-}"
  printf '  %s\n' "$label"
  # shellcheck disable=SC2086
  curl -sSI -L --max-time "$TIMEOUT" -A "$BOT_UA" $extra "$url" 2>&1 \
    | grep -iE '^(HTTP/|server:|etag:|last-modified:|cache-control:|cf-ray:|x-sucuri|alt-svc:)' \
    | sed 's/^/      /' || printf '      (no headers)\n'
  printf '      validators: '
  # shellcheck disable=SC2086
  if curl -sSI -L --max-time "$TIMEOUT" -A "$BOT_UA" $extra "$url" 2>/dev/null \
       | grep -qiE '^(etag|last-modified):'; then
    printf 'PRESENT — conditional GET viable\n'
  else
    printf 'ABSENT — must use content-hash gating (errata E2)\n'
  fi
  pause
}

# robots <label> <origin> — presence, our-UA rules, Content-Signal
robots() {
  local label="$1" origin="$2"
  printf '  %s %s/robots.txt\n' "$label" "$origin"
  local body code
  code=$(curl -sS -o /tmp/_robots.$$ -L --max-time "$TIMEOUT" -A "$BOT_UA" -w '%{http_code}' "$origin/robots.txt" 2>/dev/null)
  body=$(cat /tmp/_robots.$$ 2>/dev/null); rm -f /tmp/_robots.$$
  printf '      HTTP %s\n' "$code"
  if [ "$code" != "200" ] || printf '%s' "$body" | grep -qiE '<html|<!doctype'; then
    printf '      ABSENT (non-200 or HTML body) — allow-all per RFC 9309\n'
    printf '      NOTE: cache this fact with a 24h TTL; a robots.txt can appear at any time\n'
  else
    printf '      PRESENT\n'
    printf '%s' "$body" | grep -iE '^[[:space:]]*content-signal:' | sed 's/^/      SIGNAL: /' \
      || printf '      SIGNAL: (none)\n'
    printf '%s' "$body" | grep -icE '^[[:space:]]*user-agent:' \
      | sed 's/^/      user-agent groups: /'
    if printf '%s' "$body" | grep -qiE '^[[:space:]]*user-agent:[[:space:]]*TUPOpenDataBot'; then
      printf '      *** TUPOpenDataBot IS NAMED EXPLICITLY — read the group before crawling ***\n'
    fi
    printf '%s' "$body" | grep -iE '^[[:space:]]*(user-agent|disallow|allow|crawl-delay|sitemap):' \
      | sed 's/^/      | /'
  fi
  pause
}

# h2check <label> <url> — HTTP/2 stability over 3 attempts
h2check() {
  local label="$1" url="$2" i fails=0
  printf '  %-56s ' "$label"
  for i in 1 2 3; do
    curl -sS -o /dev/null --max-time "$TIMEOUT" -A "$BOT_UA" "$url" >/dev/null 2>&1 || fails=$((fails+1))
    pause
  done
  if [ "$fails" -gt 0 ]; then
    printf 'UNSTABLE — %d/3 failed, pin origin to HTTP/1.1\n' "$fails"
  else
    printf 'stable (3/3)\n'
  fi
}

printf 'TUP source landscape verification\n'
printf 'run at: %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
printf 'user-agent: %s\n' "$BOT_UA"
printf 'delay: %ss between requests\n' "$DELAY"

sec "1. CANONICAL ORIGINS  (expected: manila=apex, cavite=www, visayas=apex)"
status 'manila   apex   https://tup.edu.ph/'             'https://tup.edu.ph/'
status 'manila   www    https://www.tup.edu.ph/'         'https://www.tup.edu.ph/'
status 'cavite   apex   https://tupcavite.edu.ph/'       'https://tupcavite.edu.ph/'
status 'cavite   www    https://www.tupcavite.edu.ph/'   'https://www.tupcavite.edu.ph/'
status 'visayas  apex   https://tupvisayas.edu.ph/'      'https://tupvisayas.edu.ph/'

sec "2. ROBOTS.TXT AND CONTENT SIGNALS"
robots 'manila '  'https://tup.edu.ph'
robots 'cavite '  'https://www.tupcavite.edu.ph'
robots 'visayas'  'https://tupvisayas.edu.ph'

sec "3. TRANSPORT AND CACHE VALIDATORS  (expected: NO validators anywhere)"
headers 'manila  /pages/students/student-scholarship'   'https://tup.edu.ph/pages/students/student-scholarship' '--http1.1'
hr
headers 'cavite  /programs'                             'https://www.tupcavite.edu.ph/programs'
hr
headers 'visayas /academics/undergraduate-programs'     'https://tupvisayas.edu.ph/academics/undergraduate-programs'

sec "4. HTTP/2 STABILITY  (expected: manila UNSTABLE)"
h2check 'manila  /page/academics'                       'https://tup.edu.ph/page/academics'
h2check 'cavite  /programs'                             'https://www.tupcavite.edu.ph/programs'
h2check 'visayas /officials'                            'https://tupvisayas.edu.ph/officials'

sec "5. FLAGSHIP ROUTES  (expected: all 200 with plausible size)"
status 'manila  /pages/admission/undergraduate-programs' 'https://tup.edu.ph/pages/admission/undergraduate-programs' '--http1.1'
status 'manila  /pages/students/student-scholarship'     'https://tup.edu.ph/pages/students/student-scholarship'     '--http1.1'
status 'manila  /page/academics'                         'https://tup.edu.ph/page/academics'                         '--http1.1'
status 'cavite  /programs'                               'https://www.tupcavite.edu.ph/programs'
status 'cavite  /dept/engineering'                       'https://www.tupcavite.edu.ph/dept/engineering'
status 'cavite  /news'                                   'https://www.tupcavite.edu.ph/news'
status 'visayas /academics/undergraduate-programs'       'https://tupvisayas.edu.ph/academics/undergraduate-programs'
status 'visayas /officials'                              'https://tupvisayas.edu.ph/officials'

sec "6. TAGUIG LIVENESS  (corrected predicate — errata E13)"
TAGUIG_FINAL=$(curl -sS -o /tmp/_taguig.$$ -L --max-time "$TIMEOUT" -A "$BOT_UA" -w '%{url_effective}' 'https://tupt.edu.ph/' 2>/dev/null)
TAGUIG_CODE=$(curl -sS -o /dev/null -L --max-time "$TIMEOUT" -A "$BOT_UA" -w '%{http_code}' 'https://tupt.edu.ph/' 2>/dev/null)
TAGUIG_SIZE=$(wc -c < /tmp/_taguig.$$ 2>/dev/null | tr -d ' ')
TAGUIG_BODY=$(cat /tmp/_taguig.$$ 2>/dev/null); rm -f /tmp/_taguig.$$
printf '  HTTP %s  final=%s  bytes=%s\n' "$TAGUIG_CODE" "$TAGUIG_FINAL" "$TAGUIG_SIZE"
LIVE=yes
[ "$TAGUIG_CODE" = "200" ] || LIVE=no
printf '%s' "$TAGUIG_FINAL" | grep -qiE 'suspendedpage\.cgi|suspended' && LIVE=no
[ "${TAGUIG_SIZE:-0}" -gt 5120 ] 2>/dev/null || LIVE=no
printf '%s' "$TAGUIG_BODY" | grep -qiE 'suspended|coming soon|under construction|parked' && LIVE=no
if [ "$LIVE" = "yes" ]; then
  printf '  *** TAGUIG IS LIVE — open an issue: build the adapter (ADR-012) ***\n'
else
  printf '  not live (suspended/placeholder) — website_status stays "suspended"\n'
fi

sec "DONE"
printf 'Diff this output against docs/08-source-landscape.md.\n'
printf 'Any difference is a finding: it changes what the project may or can do.\n'
