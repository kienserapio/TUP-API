# 08 — Source Landscape

**Last verified:** 2026-08-29 (`docs/verification/2026-08-29.txt`)
**Verified by:** pre-build review 2026-08-20, re-verified 2026-08-29 by `scripts/verify-sources.sh`
**Re-verify:** before each phase begins, and monthly thereafter

> [!IMPORTANT]
> **Two facts changed between 2026-08-20 and 2026-08-29, and both are consequential.**
>
> 1. **Taguig is no longer suspended — the site is live.** `https://tupt.edu.ph/` returns
>    HTTP 200 with 55,922 bytes and the title `TUP-T`; there is no `suspendedpage.cgi`
>    redirect and no suspension text. Under the corrected E13 predicate this is *live*.
>    ADR-012's trigger has fired: **build the Taguig adapter** (M9). §6 is updated below.
> 2. **Cavite is down.** Both `tupcavite.edu.ph` and `www.tupcavite.edu.ph` time out
>    after 20–25 s. Confirmed from **two independent networks** on 2026-08-29, which is
>    what upgrades this from "unreachable from here" to a fact about the site. §4.1 has
>    the detail and what to do about it.

This document is the single authoritative record of what each source host actually does. It exists because the v2.0 doc set encoded host facts inline across five documents, and **several of them had drifted within a day of being written** (see [`00-errata.md`](./00-errata.md) E5, E10, E11, E12, E13).

Rules:

1. **No other document states a hostname, a robots fact, or a route.** They link here. Facts stated in one place can be corrected in one place.
2. **Every claim in this document carries a verification date.** A claim with a stale date is a claim to re-check, not a fact.
3. `sources.url` is always constructed from the canonical origin in §1. No adapter hand-writes a hostname.

---

## 1. Canonical origins

**This table is load-bearing. Two of the four campuses serve their content on a host the v2.0 docs did not use.**

| Campus | Canonical origin | Apex | `www` | Notes |
|---|---|---|---|---|
| Manila | `https://tup.edu.ph` | **200** | **intermittent TLS failure** | Use apex. `www` returned `SSL_ERROR_SYSCALL` on one run and 200 on the next. |
| Cavite | `https://www.tupcavite.edu.ph` | **timeout** (2026-08-29) | **timeout** (2026-08-29) | Was 403 / 200 on 2026-08-20. Use `www`. See §4.1. |
| Visayas | `https://tupvisayas.edu.ph` | **200** | not tested | Behind Cloudflare. |
| Taguig | `https://tupt.edu.ph` | **200, live** (2026-08-29) | — | Suspension lifted. See §6. |

Implementation:

```ts
export const CANONICAL_ORIGIN = {
  manila:  'https://tup.edu.ph',
  cavite:  'https://www.tupcavite.edu.ph',
  visayas: 'https://tupvisayas.edu.ph',
  taguig:  'https://tupt.edu.ph',
} as const satisfies Record<CampusSlug, string>;
```

Add a unit test asserting every row in `seeds/` and every `SourceRef.url` produced by `discover()` begins with its campus's canonical origin. This is the cheapest possible guard against E5 recurring, and it catches the failure at build time rather than as a dead `source_url` in a published citation.

---

## 2. Transport and caching behaviour

Verified 2026-08-20.

| Campus | Server | HTTP/2 | `ETag` | `Last-Modified` | `Cache-Control` |
|---|---|---|---|---|---|
| Manila | `Sucuri/Cloudproxy` (WAF in front of Apache 2.4.59 / Debian) | **intermittently fails** | absent | absent | absent |
| Cavite | `nginx` | fine | absent | absent | absent |
| Visayas | `cloudflare` | fine | absent | absent | `no-cache, private` |

### 2.1 Conditional GET does not work anywhere

No live campus emits a cache validator, so **no source can ever return `304`.** This invalidates the fetcher design in [`03-TDD.md §3.2`](./03-TDD.md) steps 3–4 and the `ingest_sources_304_total` metric. See [`00-errata.md`](./00-errata.md) E2 for the corrected content-hash-gating design.

Keep sending `If-None-Match` and `If-Modified-Since` when a previous snapshot recorded a validator — Cavite or Visayas may add one — but never depend on it. Freshness detection is:

```
fetch → hash body → compare to newest snapshot for this source
  match    → verified-unchanged: bump last_verified_at, reset miss_count, stop
  mismatch → new snapshot, continue the pipeline
```

### 2.2 Pin Manila to HTTP/1.1

Manila's HTTP/2 is intermittently unreliable rather than broken. Across two verification runs: one failure with `Error in the HTTP2 framing layer` out of roughly eight requests, and a clean 3/3 on the dedicated stability check. Forced HTTP/1.1 has never failed.

The same intermittence shows up in TLS — `https://www.tup.edu.ph/` failed the handshake with `SSL_ERROR_SYSCALL` on one run and returned 200 on the next. Both symptoms point at the Sucuri edge rather than at the origin.

An intermittent transport fault is worse than a consistent one: it produces rare failures that get misattributed to the parser or blamed on the network. Pin the origin and remove the variable:

```ts
export const ORIGIN_TRANSPORT = {
  'tup.edu.ph': { allowH2: false },   // intermittent h2 framing errors, verified 2026-08-20
} as const;
```

Relying on the retry policy instead would work, but it multiplies request volume against a WAF that counts requests — see §3. Keep the retries as well; pinning reduces the failure rate, it does not eliminate it.

---

## 3. Manila — `tup.edu.ph`

**Stack:** legacy PHP CMS behind a Sucuri WAF. Two generations live simultaneously.
**Unit vocabulary:** 6 **colleges** → `unit_type = 'college'`.

### 3.1 WAF

`Server: Sucuri/Cloudproxy`, `X-Sucuri-ID: 18012`, `X-Sucuri-Cache: HIT`.

The honest bot user-agent was tested and **passes**:

```
TUPOpenDataBot/1.0 (+https://github.com/<org>/tup-open-api; student open-data project)
→ 200, 44,452 bytes                                           [verified 2026-08-20]
```

This is a policy the WAF operator can change at any time, without notice, and it is the most likely single cause of the Manila adapter failing. It is a WAF, not a rate limiter: the failure mode is a hard 403 or a JS challenge, not a slow-down. Treat a sustained Manila 403 as **RB-08**, distinct from RB-02 "site down", because the remedy differs — convert Manila to `method = 'manual'` rather than wait for recovery.

Do not attempt to evade a block. A WAF block is a signal to switch to manual collection and, if it persists, to open the conversation with UITC that [`02-ADRs.md ADR-013`](./02-ADRs.md) deliberately deferred.

### 3.2 robots.txt — **absent**

```
https://tup.edu.ph/robots.txt      → 302 → http://www.tup.edu.ph/404error.php
https://www.tup.edu.ph/robots.txt  → 302 → http://www.tup.edu.ph/404error.php
                                                              [verified 2026-08-20]
```

There is no `robots.txt` on either host. Per RFC 9309 an unavailable robots.txt permits access to any resource.

**This contradicts the v2.0 docs**, which state the `/pages/*` tree is disallowed and build the manual-collection subsystem, ADR-013's rationale, and critical-path task 1.2 on that basis. The supposedly-blocked pages are directly fetchable:

| URL | Result |
|---|---|
| `/pages/students/student-scholarship` | 200, 44,452 b |
| `/pages/admission/undergraduate-programs` | 200, 42,842 b |
| `/page/academics` | 200, 47,556 b |

See [`00-errata.md`](./00-errata.md) E12 and ADR-016 for what this changes and what it does not. In short: **crawl it, keep the manual path as the fallback, and cache the "no robots.txt" fact with a 24-hour TTL** — a site with no robots.txt today can have one tomorrow, and RB-03 must still work when it appears.

### 3.3 Route families

| Route family | Generation | Status | Entities |
|---|---|---|---|
| `/` | — | 200 | campus metadata, nav |
| `/page/{slug}` | legacy | 200 | `academic_units`, campus metadata |
| `/pages/{section}/{slug}` | current | 200 | `program_offerings`, `scholarships`, `documents` |
| `/newspage/{n}` | current | untested | `announcements` |
| `/registrar/services/{slug}` | current | untested | `offices`, procedures |

**Open question Q2 stands and is now more urgent.** With both generations crawlable, the conflict-resolution rule in [`03-TDD.md §4.1`](./03-TDD.md) ("resolve in favour of the manual copy") no longer maps onto anything, since both trees are now `method = 'crawl'`. Replace it with an explicit precedence rule recorded in the adapter:

> Where `/page/*` and `/pages/*` disagree, `/pages/*` wins. Record the losing value in the `change_events` diff so the divergence is visible rather than silently discarded.

Resolve Q2 during Phase 1 by diffing the two trees on a shared topic and recording the finding in the adapter README, as the plan already requires.

**Expectations:** `academic_units {min:5, max:9}`, `program_offerings {min:30, max:120}`.

---

## 4. Cavite — `www.tupcavite.edu.ph`

**Stack:** nginx, server-rendered, strict CSP, HSTS. Clean guessable routes.
**Unit vocabulary:** 5 **departments** → `unit_type = 'department'`. This is the case that justifies [`02-ADRs.md ADR-002`](./02-ADRs.md).

### 4.1 Host

> [!WARNING]
> **Unreachable as of 2026-08-29.** Every request to both hosts timed out after 20–25
> seconds, across two runs an hour apart:
>
> ```
> https://tupcavite.edu.ph/         → curl (28) timeout      [2026-08-29]
> https://www.tupcavite.edu.ph/     → curl (28) timeout      [2026-08-29]
> https://www.tupcavite.edu.ph/programs → curl (28) timeout  [2026-08-29]
> ```
>
> **Confirmed from a second network** on 2026-08-29 by the project owner, so this is the
> site and not the path to it. A timeout is still a weaker finding than a 403 or a 404 —
> it says nothing about *why* — but it is enough to stop claiming a 200 that is not
> there. `campuses.cavite.website_status` is `unavailable`.
>
> **The Cavite adapter cannot be written until it returns.** There are no fixtures to
> write a parser against, and a parser written against guessed markup is one that has
> never seen its own page. When it comes back: re-run `scripts/verify-sources.sh`,
> capture fixtures, and check whether §4.1's 2026-08-20 facts (apex 403, `www` 200, no
> robots.txt) still hold — a site that has been down is a site that may have changed.
> The manual-collection path (`method: 'manual'`) is the fallback if it returns but the
> fetcher still cannot reach it.
>
> Everything below was verified 2026-08-20 and has not been re-confirmed since.

**The apex returned 403 on 2026-08-20.** All routes must use `www`. Verified:

```
https://tupcavite.edu.ph/       → 403   (nginx, static page, Last-Modified 2021-04-29)
https://www.tupcavite.edu.ph/   → 200
```

The apex also serves a **Synology DSM 404 page** at `/robots.txt`, which suggests the apex points at different infrastructure from the `www` host. Do not read anything else into it, and do not probe further — it is not a source.

### 4.2 robots.txt — **absent**

```
https://www.tupcavite.edu.ph/robots.txt → 404 (text/html)     [verified 2026-08-20]
```

Allow-all by RFC 9309. Same 24-hour caching rule as Manila.

### 4.3 Routes

Verified live 2026-08-20 unless marked.

| Route | Status | Entities |
|---|---|---|
| `/programs` | 200, 91 KB | `program_offerings` |
| `/dept/{engineering,dit,ded,dla,dms}` | 200, 98 KB (engineering) | `academic_units` |
| `/news`, `/news/{id}` | 200, 88 KB | `announcements` |
| `/office/{adaa,osa,library,registrar,uitc,ogs,clinic,ohr,ocd,oaf,rne,oirjpo}` | untested | `offices` |
| `/campus-official`, `/bor` | untested | `officials` |
| `/handbook`, `/academic_calendar` | untested | `documents` |
| `/admission` | untested | `procedures` |
| `/transparency-seal`, `/tup-code`, `/tupc-arta`, `/tupc-csmr` | untested | `documents` |
| `/copc_eng`, `/copc_dit`, `/copc_ded` | untested | `program_offerings.accreditation` |
| `/service/procurement`, `/service/qms` | untested | `offices` / `documents` |

**`/news/{id}` is numeric.** Discover IDs from the `/news` index; never increment blindly. Announcement slugs must therefore be derived from the title, which feeds the collision problem in [`00-errata.md`](./00-errata.md) E6 — the `(campus_id, slug)` uniqueness fix is required before this adapter ships.

**Q3 — shared CMS with Manila?** The v2.0 docs flag identical visitor counters as evidence. The server headers now say otherwise: Manila is Apache behind Sucuri, Cavite is nginx with a modern CSP and HSTS. A shared *counter widget* is a much likelier explanation than a shared CMS. Downgrade Q3 from "could halve adapter work" to "probably a shared third-party counter"; verify cheaply during Phase 2 by diffing the two pages' markup, and do not plan on the saving.

**Expectations:** `academic_units {min:4, max:8}`, `offices {min:8, max:20}`, `program_offerings {min:10, max:50}`.

---

## 5. Visayas — `tupvisayas.edu.ph`

**Stack:** Laravel, behind Cloudflare (`cf-ray`, PoP `HKG`). Best-structured of the four.
**Unit vocabulary:** 3 **colleges** → `unit_type = 'college'`.

### 5.1 robots.txt — present, Cloudflare-managed, AI-restrictive

**This is new since the 2026-08-19 survey and it is the most consequential change in the landscape.**

```
User-agent: *
Content-Signal: search=yes,ai-train=no,use=reference
Allow: /

User-agent: Amazonbot                          Disallow: /
User-agent: Applebot-Extended                  Disallow: /
User-agent: Bytespider                         Disallow: /
User-agent: CCBot                              Disallow: /
User-agent: ClaudeBot                          Disallow: /
User-agent: CloudflareBrowserRenderingCrawler  Disallow: /
User-agent: Google-Extended                    Disallow: /
User-agent: GPTBot                             Disallow: /
User-agent: meta-externalagent                 Disallow: /

User-agent: *
Disallow:
                                                              [verified 2026-08-20]
```

The file also declares the Content-Signals to be express reservations of rights under Article 4 of EU Directive 2019/790.

**Reading it.** `TUPOpenDataBot` is not named; `User-agent: *` is `Allow: /`; the crawl is permitted. The signals are, on inspection, favourable to this project:

| Signal | Value | Applies to this project? |
|---|---|---|
| `search` | `yes` | Indexing permitted — covers the REST API and `/v1/search` |
| `ai-train` | **`no`** | Training or fine-tuning prohibited — **this project does not train** |
| `use` | `reference` | AI systems may consume as reference — covers RAG and the MCP server |
| `ai-input` | *unspecified* | Neither granted nor restricted |

**Obligations this creates.**

1. Never use ingested content to train or fine-tune any model. State this in `LICENSE-DATA`, `llms.txt`, and the consumer guide's attribution section.
2. Parse and store `Content-Signal` per domain on every robots fetch (`sources.content_signal`). **If a signal changes, fail the run loudly** rather than continuing — a silently-appearing `ai-input=no` must stop the Visayas pipeline, not be discovered months later.
3. Do not lean on `User-agent: *` as a technicality. TUPV has switched on AI-crawler blocking; a project whose headline feature is an MCP server should say plainly what it does and does not do with the content. See [`07-governance-and-distribution.md §1.3`](./07-governance-and-distribution.md).

**Risk.** These directives are Cloudflare-managed, which means they were enabled with a toggle. The adjacent toggle — Cloudflare's AI-bot **WAF** rule — blocks at the edge with a 403 regardless of robots compliance. **Visayas is the campus most likely to become manual-only.** Keep the manual path warm.

### 5.2 Routes

| Route | Status | Entities |
|---|---|---|
| `/academics/undergraduate-programs` | **200, 61 KB** [2026-08-29] | `program_offerings` — 16 records |
| `/academics` | **200, 36 KB** [2026-08-29] | `academic_units` — 3 colleges, with prose |
| `/academics/{coac,coe,coet}` | **200** [2026-08-29] | college prose; not parsed, `/academics` already has it |
| `/officials` | 200, 58 KB [2026-08-20] | `officials` (with photos) |
| `/news-events`, `/news/{slug}` | untested | `announcements` |
| `/announcements` | untested | `announcements` (`advisory`) |
| `/bid-opportunities` | untested | `announcements` (`bid`) |
| `/jobs/{slug}` | untested | `announcements` (`vacancy`) |
| `/about/{history,mission,mandate,hymn,values}` | untested | prose → `chunks` |
| `/student-services`, `/library`, `/technology`, `/human-resources`, `/sit` | untested | `offices` |
| `/admissions/enrollment-procedure` | untested | `procedures` |
| `/transparency-seal`, `/privacy-notice` | untested | `documents` |

Slug-based news URLs make stable `announcements.slug` straightforward — no ID mapping, unlike Cavite.

**Program slugs are published too.** Each card on `/academics/undergraduate-programs`
links to `/academics/{college}/programs/{program-slug}`, giving a CMS-assigned slug that
survives a title edit. Manila publishes no such field and its adapter has to slugify the
title instead. `.ug-card__years` also publishes duration, which Manila does not.

**Expectations:** `academic_units {min:3, max:5}`, `officials {min:4, max:40}`, `announcements {min:1, max:200}`.

---

## 6. Taguig — `tupt.edu.ph`

**Status: LIVE as of 2026-08-29.** The suspension has been lifted.

```
https://tupt.edu.ph/  → 200, 55,922 bytes, <title>TUP-T</title>   [verified 2026-08-29]
                        no suspendedpage.cgi redirect, no suspension text
```

Against the corrected E13 predicate — 200, final URL not `suspendedpage.cgi`, body over
5,120 bytes, no "suspended"/"coming soon"/"parked" text — this evaluates to **live**.
That is ADR-012's trigger, and it has fired for the first time.

**What this changes.**

- `campuses.taguig.website_status` moves from `suspended` to `active`. `seeds/campuses.yaml`
  is updated; `confidence` stays `low`, because nothing in that row has yet been read
  from a Taguig source — only the status claim has been re-verified.
- The Taguig adapter stops being a stub and becomes real work. It belongs to M9 with the
  other campuses, not to the Manila slice.
- PRD R3 rates "Taguig stays offline indefinitely" as High likelihood. That risk has not
  materialised. The §7 note below — that a diff here changes what the project can do —
  is exactly what happened.

**Previous state, for the record:**

```
https://tupt.edu.ph/  → 302 → https://tupt.edu.ph/cgi-sys/suspendedpage.cgi → 200
                                                              [verified 2026-08-20]
```

Two consequences.

**The liveness probe as specified is broken.** [`02-ADRs.md ADR-012`](./02-ADRs.md) and [`05-deployment-and-operations.md §4`](./05-deployment-and-operations.md) open a GitHub issue "on first 200". The suspension notice *is* a 200, so the probe fires on its first run and every run after. Corrected predicate:

```
live  ⟺  HTTP 200
      ∧  ¬ final_url ~* '/cgi-sys/suspendedpage\.cgi|suspended'
      ∧  byte_size > 5120
      ∧  ¬ body ~* 'suspended|coming soon|under construction|parked'
```

**The diagnosis is better news than "offline".** A suspension is a billing or hosting-policy matter, typically resolved in days or weeks — not an abandoned domain. PRD R3 rates "Taguig stays offline indefinitely" as High likelihood; a suspension makes recovery meaningfully more likely, and the Taguig adapter more likely to be needed than the plan assumes. Keep the stub wired into the pipeline as ADR-012 specifies.

Model it as `campuses.website_status = 'suspended'` — a distinct value from `unavailable`, because it is publishable information that is genuinely useful to a student: *"this campus's site is temporarily down"* is a different fact from *"this campus has no web presence."* See ADR-017.

Until it is crawled: the campus stays hand-seeded, with facts drawn from sibling sites
attributed to the sibling as `source_id`, `confidence = 'low'`, `method = 'seed'`. The
site being reachable does not by itself make anything in that row verified.

### 6.1 Routes  [verified 2026-08-29]

**Unit vocabulary: 4 departments → `unit_type = 'department'`.** Taguig is the second
department campus, and with Cavite unreachable it is the one that actually validates
[`02-ADRs.md ADR-002`](./02-ADRs.md).

| Route | Status | Entities |
|---|---|---|
| `/progoff` | 200, 40 KB | `program_offerings` — 22 records, all on one page |
| `/academics/department/{basd,caad,eaad,maad}` | 200, 41–53 KB | `academic_units` — name, prose, department head |
| `/academics/department` | **404** | no index page; the four slugs are enumerated explicitly |
| `/offices/*` (16 routes) | untested | `offices` |
| `/bor`, `/admin`, `/directory` | untested | `officials` |
| `/newsfeed`, `/newsfeed/{slug}` | untested | `announcements` |
| `/transparency`, `/acadcal`, `/philgeps`, `/bids` | untested | `documents` |

**robots.txt is absent** — `/robots.txt` returns the site's own HTML homepage, which the
fetcher treats as absent (allow-all per RFC 9309, cached 24h).

**The owning department is a CSS class on `/progoff`**, `courses-col eaad`, and nowhere
else on the page. `/academics/department/eaad` misnames itself in its own heading
("Electrical and AlliedDepartment" — a `<span>` with no preceding space); the nav spells
it correctly and the adapter reads the nav.

**Expectations:** `academic_units {min:3, max:8}`, `program_offerings {min:4, max:15}` —
the latter counts published rows, after canonicalisation merges the twelve BET variants
into one offering.

---

## 7. Re-verification

`scripts/verify-sources.sh` reproduces every check in this document. Run it before each phase and monthly thereafter; commit the output to `docs/verification/YYYY-MM-DD.txt` so drift is visible in git history rather than discovered by a broken parser.

The script is polite by construction: one request at a time, 3-second delays, no recursion, HEAD where possible. It is safe to run against production sites.

What it checks:

1. Canonical origin resolves and returns 200; the non-canonical host's behaviour is recorded.
2. `robots.txt` presence, disallow rules for `TUPOpenDataBot`, and `Content-Signal` values.
3. Cache-validator headers (`ETag`, `Last-Modified`, `Cache-Control`).
4. Server header and WAF/CDN identification.
5. HTTP/2 viability over three attempts.
6. The flagship route per campus returns 200 with a plausible byte size.
7. Taguig liveness under the corrected predicate in §6.

**Any diff against this document is a finding, not noise.** A changed `Content-Signal`, a newly-appearing `robots.txt`, a new WAF, or a host that flips from 200 to 403 all change what the project is permitted or able to do. Treat a diff the way the guard treats an anomaly: stop, look, decide — do not proceed on the assumption that it is fine.
