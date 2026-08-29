#!/usr/bin/env bash
# Grep-based CI gates. Twenty minutes to write, and each prevents a class of failure
# that is otherwise invisible until production. docs/14-testing-strategy.md §9
set -uo pipefail
fail=0

echo "── personal-data gate (PRD C1) ──"
# Adapters must never authenticate or touch the student information systems.
if grep -rInE "headers.*(Cookie|Authorization)|aims\.tup|ers\.tup" \
     packages/adapters apps/ingest 2>/dev/null | grep -v '^\s*//'; then
  echo "FAIL: an adapter sends credentials or references AIMS/ERS. PRD C1 is architectural."
  fail=1
else
  echo "ok"
fi

echo "── no-live-network-in-tests gate ──"
# Tests run against committed fixtures. Politeness (PRD C2/C3) before determinism.
# A TUP hostname as an expected VALUE is fine and in fact required — docs/08 §1 asks
# for exactly that assertion. What must never appear is a test that FETCHES one.
if grep -rInE "(fetch|axios|got|undici|request|createConnection|\.get)\s*\(\s*[\"'\`]https?://(www\.)?(tup|tupcavite|tupvisayas|tupt)\.edu\.ph" \
     test/ 2>/dev/null; then
  echo "FAIL: test code performs a live request against a TUP host."
  fail=1
else
  echo "ok"
fi

echo "── secrets gate ──"
if git ls-files --error-unmatch .env >/dev/null 2>&1; then
  echo "FAIL: .env is tracked by git. Remove it and rotate every credential it held."
  fail=1
else
  echo "ok"
fi

exit $fail
