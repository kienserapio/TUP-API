# Manila adapter — `tup.edu.ph`

**Canonical origin:** `https://tup.edu.ph` (apex, never `www`) — [`docs/08 §1`](../../../../docs/08-source-landscape.md)
**Unit vocabulary:** 6 **colleges** → `unit_type = 'college'` ([ADR-002](../../../../docs/02-ADRs.md))
**Transport:** pinned to HTTP/1.1. Sucuri edge, intermittent h2 framing errors — [`docs/08 §2.2`](../../../../docs/08-source-landscape.md)
**Fixtures captured:** 2026-08-29

---

## Route inventory

| Route | Yields | Status |
|---|---|---|
| `/page/academics` | `academic_unit` × 6 | **Used.** Legacy generation, current content. |
| `/courses/academics/{college}` | `program_offering` | **Used.** 89 offerings across the six colleges. |
| `/pages/admission/undergraduate-programs` | — | **Not used.** Google Drive PDF embed, no HTML. |
| `/pagecollege/academics/{college}` | college prose | Not used. History/goals text; Phase 3 chunk candidate. |
| `/pages/academics/{college}` | college prose | Not used. Current-generation twin of the above, HTTP 200. |
| `/faculty/academics/{college}` | `officials` | Not used. Phase 2+. |
| `/newspage/{n}` | `announcements` | Not used. Phase 2+. |

`discover()` yields seven URLs: one academics page and six college course pages. No recursion, no ID
incrementing, every URL built from `CANONICAL_ORIGIN.manila` ([`docs/11 §2`](../../../../docs/11-adapter-guide.md)).

---

## Open question Q2 — is `/page/*` authoritative or abandoned?

[`docs/03 §4.1`](../../../../docs/03-TDD.md) asks this and [`docs/08 §3.3`](../../../../docs/08-source-landscape.md)
calls it "more urgent" now that both generations are crawlable.

**Answer, verified 2026-08-29: `/page/*` is neither authoritative nor abandoned — it is the only
machine-readable source for the academic-unit list, and the two generations do not overlap.**

Evidence:

1. `/page/academics` returns 200 with a real HTML table of the six colleges, each with a link and a
   paragraph of current prose. It is the source this adapter parses for `academic_unit`.
2. `/pages/admission/undergraduate-programs` — the current-generation page the docs expected to carry
   program offerings — returns 200 and 42 KB of markup whose entire content region is:

   ```html
   <embed height="900px" src="https://drive.google.com/file/d/1J07…/preview" width="100%">
   ```

   There is no program list in the HTML. Not one occurrence of the string "Bachelor".
   `parseAdmissionProgramsPage()` asserts this, so the day it changes back a fixture test fails
   rather than the finding quietly rotting.
3. Program data lives at a **third** route family the doc set does not record:
   `/courses/academics/{college}` — a two-level Bootstrap accordion, level group → program, with
   CMS-assigned durable ids. 89 offerings across the six colleges.
4. Both `/pagecollege/academics/coe` and `/pages/academics/coe` return 200 and render the same
   college. The generations coexist rather than one superseding the other.

**Consequence for the precedence rule.** [`docs/08 §3.3`](../../../../docs/08-source-landscape.md)
proposes "where `/page/*` and `/pages/*` disagree, `/pages/*` wins". Today they cannot disagree about
anything this adapter reads: the units come only from `/page/*` and the offerings come only from
`/courses/*`. The rule is correct in principle and currently inert. Leave it written down; the day a
`/pages/*` unit list appears it becomes load-bearing.

---

## Quirks worth knowing

- **The college list is rendered twice per page.** The main nav emits bare
  `<a href="pagecollege/academics/coe">` with no text; the footer's "University Colleges" block emits
  the same href with `title="College of Engineering"`. The parser groups by slug and takes the first
  non-empty title. The legacy table renders names in ALL CAPS, so titles are the only correctly-cased
  source — title-casing the table text would be inventing data.
- **Slugs must not be length-capped.** CIT lists six degrees that differ only after ~90 characters
  ("…major in Mechanical Engineering Technology option in Foundry Technology" vs "…option in Welding
  Technology"). An 80-character cap silently merged five of them into one row during development.
  This is precisely the silent-loss failure golden fixtures exist to catch, and it is why `slugify`
  here does not truncate.
- **Graduate programs are in scope and mostly unmatched.** COE alone lists twenty MS/ME variants with
  "major in …" suffixes. They publish with `program_id = NULL` and appear in `pnpm ingest:unmatched`
  for a human to resolve into `seeds/programs.yaml`. Never auto-create a canonical program from a
  fuzzy match ([ADR-003](../../../../docs/02-ADRs.md)).
- **robots.txt is absent** on both `tup.edu.ph` and `www.tup.edu.ph`; the apex redirects
  `/robots.txt` to `http://www.tup.edu.ph/404error.php`, which leaves the allowlist and is therefore
  refused by the fetcher and recorded as "absent" — allow-all per RFC 9309, cached for 24 hours, not
  a permanent grant ([`docs/00-errata.md`](../../../../docs/00-errata.md) E12).

## Verification

**Ten records spot-checked by hand against the source, 2026-08-29 — 10/10 correct.**

docs/11 §7 calls this "the one people skip and the only one that catches a parser that
is confidently wrong — reading the right element for the wrong field". Sampled every
ninth row of `GET /v1/offerings?campus=manila`, and for each one confirmed that the
`source_name` appears verbatim on the page the record cites, that `provenance.source_url`
is the college page it was actually parsed from, and that `unit.ref` matches that page:

| Offering | Unit | Verbatim on cited page |
|---|---|---|
| `bachelor-in-graphics-technology-major-in-architecture-technology` | `manila/cafa` | yes |
| `bachelor-of-engineering-technology-major-in-instrumentation-and-control-technology` | `manila/cit` | yes |
| `bachelor-of-engineering-technology-major-in-railway-technology` | `manila/cit` | yes |
| `bachelor-of-technology-and-livelihood-education-major-in-home-economics` | `manila/cie` | yes |
| `bsee` | `manila/coe` | yes |
| `bt-nutrition-and-food-technology` | `manila/cit` | yes |
| `master-of-arts-in-industrial-education-major-in-administration-and-supervision` | `manila/cie` | yes |
| `master-of-science-in-civil-engineering-major-in-general-civil-engineering` | `manila/coe` | yes |
| `master-of-science-in-mechanical-engineering-major-in-production-technology` | `manila/coe` | yes |
| `masters-of-engineering-program-in-mechanical-engineering-major-in-refrigeration-and-airconditioning-option` | `manila/coe` | yes |

The verbatim half of that check is now generalised to all 95 records by a fixture test,
so it holds on every run rather than on the day someone remembered to look. The half a
machine cannot do — deciding that these are the right *fields* — is what the table above
records.

## Expectations

```ts
academic_unit:     { min: 5,  max: 9   }   // observed 6
program_offering:  { min: 30, max: 120 }   // observed 89
```

Full-run ranges. The guard applies them only under `--full`; on an incremental run most sources are
unchanged and the counts are legitimately partial ([errata E3](../../../../docs/00-errata.md)).
