# Visayas adapter — `tupvisayas.edu.ph`

**Canonical origin:** `https://tupvisayas.edu.ph` — [`docs/08 §1`](../../../../docs/08-source-landscape.md)
**Unit vocabulary:** 3 **colleges** → `unit_type = 'college'` ([ADR-002](../../../../docs/02-ADRs.md))
**Stack:** Laravel behind Cloudflare. The best-structured of the four sites.
**Fixtures captured:** 2026-08-29

---

## Route inventory

| Route | Yields | Status |
|---|---|---|
| `/academics` | `academic_unit` × 3 | **Used.** "Our Colleges" cards with real prose. |
| `/academics/undergraduate-programs` | `program_offering` × 16 | **Used.** One `.ug-card` per degree. |
| `/academics/{coac,coe,coet}` | college prose | Not used — `/academics` already names and describes all three. |
| `/officials` | `officials` | Not used. Needs the `officials` entity type first. |
| `/news-events`, `/announcements`, `/bid-opportunities`, `/jobs/{slug}` | `announcements` | Not used. Phase 2+. |
| `/about/{history,mission,mandate,hymn,values}` | prose → `chunks` | Not used. Phase 3. |
| `/admissions/enrollment-procedure` | `procedures` | Not used. |

`discover()` yields two URLs. The three per-college pages are deliberately **not** in the
list: `/academics` already carries each college's name, slug and description, so adding
them would triple the request count and the maintenance surface for a `head_name` the
page does not publish anyway.

---

## The Content-Signal position — D6

`tupvisayas.edu.ph/robots.txt` is Cloudflare-managed and serves

```
User-agent: *
Content-Signal: search=yes,ai-train=no,use=reference
Allow: /
```

followed by `Disallow: /` groups for nine named AI crawlers — Amazonbot,
Applebot-Extended, Bytespider, CCBot, ClaudeBot, CloudflareBrowserRenderingCrawler,
Google-Extended, GPTBot, meta-externalagent — and declares the signals an express
reservation of rights under Article 4 of EU Directive 2019/790.

**Decision, taken 2026-08-29: crawl, and comply literally.** `TUPOpenDataBot` is not
named and `User-agent: *` is `Allow: /`, so the crawl is permitted — but the project does
not rest on that technicality. Concretely:

1. **Never train or fine-tune on ingested content.** `search=yes` permits indexing and
   `use=reference` permits AI systems to consume the content as reference, which is what
   this project does. `ai-train=no` prohibits training, which it does not do.
2. **The signal is stored and enforced.** `sources.content_signal` holds the parsed
   value per domain, and `assertContentSignalUnchanged` **fails the run** if it changes
   rather than logging and continuing. A silently-appearing `ai-input=no` stops the
   Visayas pipeline instead of being discovered months later
   ([errata E11](../../../../docs/00-errata.md)).
3. **The position is stated openly**, not buried in a robots technicality —
   [`docs/07 §1.3`](../../../../docs/07-governance-and-distribution.md), and it belongs in
   `LICENSE-DATA` and `llms.txt` when those are written.

**Risk.** These directives were enabled with a Cloudflare toggle. The adjacent toggle —
Cloudflare's AI-bot WAF rule — blocks at the edge with a 403 regardless of robots
compliance. Visayas remains the campus most likely to become manual-only; the
`method: 'manual'` path exists and is tested for exactly this.

---

## Quirks worth knowing

- **The college is read from each card's own link**, `/academics/{college}/programs/{slug}`,
  not from the enclosing `.ug-college-group`. The href is the record's own claim about
  where it belongs; the grouping is layout, and layout is what a redesign moves.
- **The slug comes from the href, not the title.** Unlike Manila, this site publishes a
  CMS-assigned program slug that survives a title edit — which is what
  [`docs/11 §7`](../../../../docs/11-adapter-guide.md) means by "derived from a durable
  field, not a title that can be edited".
- **Years are published** (`.ug-card__years`, e.g. "4 years") and parsed. Manila does not
  publish them, so Manila's offerings carry `years: null`. That asymmetry is real data,
  not a parser gap.
- **`.ug-card__desc` is dropped.** `program_offerings` has no description column, and
  adding one would have meant a schema migration — which
  [`docs/04 §2`](../../../../docs/04-implementation-plan.md) makes the Phase 2 failure
  condition. The gate held: adding this campus needed zero migrations.
- **"Bachelor of Engineering Technology: Major in X"** — this campus uses a colon before
  "Major", Manila uses none, Taguig uses none and sometimes "option in" as well. All
  three resolve to the one `bet` award; see the rule at the foot of
  [`seeds/programs.yaml`](../../../../seeds/programs.yaml).

## Expectations

```ts
academic_unit:     { min: 3, max: 5  }   // observed 3
program_offering:  { min: 4, max: 15 }   // 16 records parsed, 8 offerings published
```

Full-run ranges, counting **published rows** — canonicalisation merges the nine BET
variants into one offering before the guard sees them.
