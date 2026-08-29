# Taguig adapter — `tupt.edu.ph`

**Canonical origin:** `https://tupt.edu.ph` — [`docs/08 §1`](../../../../docs/08-source-landscape.md)
**Unit vocabulary:** 4 **departments** → `unit_type = 'department'` ([ADR-002](../../../../docs/02-ADRs.md))
**Fixtures captured:** 2026-08-29

---

## Why this stopped being a stub

[ADR-012](../../../../docs/02-ADRs.md) modelled Taguig as a first-class campus with an
adapter whose `discover()` yields nothing, because the host served a cPanel suspension
notice. It also specified the trigger for changing that: *on first 200, open an issue —
build the adapter.*

Re-verification on **2026-08-29** found `https://tupt.edu.ph/` returning HTTP 200 with
55,922 bytes and `<title>TUP-T</title>`, no `suspendedpage.cgi` redirect and no
suspension text. Under the corrected [E13](../../../../docs/00-errata.md) predicate that
is live. The trigger fired, and this is the adapter.

PRD R3 rated "Taguig stays offline indefinitely" as High likelihood. It did not happen.

---

## Route inventory

| Route | Yields | Status |
|---|---|---|
| `/progoff` | `program_offering` × 22 | **Used.** Every degree on one page. |
| `/academics/department/{basd,caad,eaad,maad}` | `academic_unit` × 4 | **Used.** Name, description, department head. |
| `/academics/department` | — | **404.** There is no index page; the four slugs are enumerated explicitly. |
| `/offices/*` (16 routes) | `offices` | Not used. Needs the `offices` entity type. |
| `/bor`, `/admin`, `/directory` | `officials` | Not used. |
| `/newsfeed`, `/newsfeed/{slug}` | `announcements` | Not used. |
| `/transparency`, `/acadcal`, `/philgeps`, `/bids` | `documents` | Not used. |

---

## Quirks worth knowing

- **The owning department is a CSS class**, not markup structure: `<div class="col-lg-4
  col-sm-8 courses-col eaad">`. It is the only place `/progoff` states which department
  teaches a degree. The parser matches that class against the four known slugs and, when
  it finds none, publishes the offering with `unit_slug: null` **and a warning** rather
  than guessing — a wrong department is worse than a missing one.
- **`/academics/department/eaad` misnames itself.** Its `h2.about-title` renders as
  "Electrical and AlliedDepartment": the heading wraps "Department" in a `<span>` with no
  preceding whitespace. The nav on every page says "Electrical and Allied Department".
  The parser reads the nav and keeps the heading as a fallback, and emits a warning
  naming both, so the discrepancy is recorded rather than silently resolved.
- **Department heads are published, faculty lists are not.** `head_name` and `head_title`
  come from the profile block, and **only when its caption actually says "Head"**. Every
  department page also lists 10–20 faculty members with photographs; those are people
  acting in a professional capacity whose names this project has no reason to
  republish ([PRD C1](../../../../docs/01-PRD.md)).
- **`a.category` carries a program code** ("BSCE") next to each title. It is not used:
  `program_offerings` has no code column, and adding one would have meant a schema
  migration during Phase 2 — the thing that phase exists to avoid. The code is available
  in the fixture if a future entity ever wants it.
- **This is the second department campus.** Cavite was meant to be the case that
  validates ADR-002's `unit_type` discriminator; with Cavite unreachable, Taguig
  validated it instead. `GET /v1/programs/bsee` returns Manila (college), Visayas
  (college) and Taguig (**department**) — the difference visible in the payload.

## Expectations

```ts
academic_unit:     { min: 3, max: 8  }   // observed 4
program_offering:  { min: 4, max: 15 }   // 22 records parsed, 8 offerings published
```

Full-run ranges, counting **published rows**. The first run of this adapter quarantined
on a range set from the parsed count (22) instead of the published one (8) — the guard
working exactly as designed, and the reason that distinction is now spelled out in
`Expectation`'s doc comment.
