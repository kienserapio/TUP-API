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

echo "── parse-purity gate (ADR-005, docs/14 §3.4) ──"
# `parse` must be a pure function of its bytes. A clock or a random number inside an
# adapter makes the golden fixture tests — half of all test effort here — impossible.
if grep -rInE "Date\.now|Math\.random|crypto\.randomUUID|new Date\(\s*\)" \
     packages/adapters/src 2>/dev/null | grep -v '^\s*[0-9]*:\s*[/*]'; then
  echo "FAIL: an adapter reads the clock or generates randomness. Timestamps come from the pipeline."
  fail=1
else
  echo "ok"
fi

echo "── adapters-cannot-fetch gate (ADR-005) ──"
# The politeness layer is structurally unbypassable only while adapters have no way to
# reach the network. An import is the whole attack surface, so grep for the import.
if grep -rInE "from '(undici|node:https?|node:fs|node:fs/promises)'|require\('(undici|node:https?)'\)|@tup/core/http|globalThis\.fetch" \
     packages/adapters/src 2>/dev/null; then
  echo "FAIL: an adapter imports a network or filesystem client. Fetching is centralised."
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
