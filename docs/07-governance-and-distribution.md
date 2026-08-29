# 07 — Governance and Distribution

---

> [!IMPORTANT]
> **Amended 2026-08-20.** **§1.3 needs a new subsection.** `tupvisayas.edu.ph` now serves Cloudflare-managed robots directives blocking ClaudeBot, GPTBot, CCBot and others, and declares `Content-Signal: search=yes, ai-train=no, use=reference` as an express reservation of rights. This project is permitted to crawl and is not a training crawler, but the position needs stating openly rather than resting on a `User-agent: *` technicality. See [`00-errata.md`](./00-errata.md) E11 and [`08-source-landscape.md §5.1`](./08-source-landscape.md).

## 1. Legal posture

*Not legal advice. This is the reasoning the project operates on; confirm anything consequential with someone qualified.*

### 1.1 Copyright

**Section 176, RA 8293 (Intellectual Property Code):** no copyright subsists in works of the Government of the Philippines. Prior approval of the originating agency is required to exploit such works **for profit**.

TUP is a state university. Its public institutional publications — program listings, mandates, citizen's charters, handbooks — plausibly fall under this provision. This is a materially stronger position than scraping a private company's site.

Two consequences the project accepts deliberately:

1. **The for-profit caveat is why this stays free.** Monetizing would activate the approval requirement. Non-commercial operation avoids that entirely and keeps the posture clean. This is a real constraint on the business model, not just a preference.
2. **The project claims no ownership of the underlying content.** It claims only the normalization, schema, and code.

### 1.2 Data privacy

**RA 10173 (Data Privacy Act)** is why PRD constraint C1 exists.

| Category | In scope | Reasoning |
|---|---|---|
| Programs, units, offices, procedures | Yes | Not personal data at all |
| Officials' names, titles, official emails | Yes | Public figures acting in official capacity; published by the institution itself |
| Officials' personal contact details | No | Not needed; excluded even where published |
| Any student data | **Never** | Would make the project a personal information controller with registration, consent, and breach-notification obligations it cannot discharge |

C1 is enforced architecturally, not by policy: no auth code in the ingestion layer, no credential fields in the schema, and a CI check rejecting any adapter that sends `Cookie` or `Authorization` headers or references AIMS/ERS hosts.

### 1.3 robots.txt

robots.txt is a directive to automated crawlers. It is not an access control mechanism and it is not law. The project honors it mechanically for automated fetching (PRD C2) while treating human collection of public pages as a separate, legitimate activity.

This distinction is real and worth stating plainly: a student opening a public university page in a browser and saving it is not crawling. The `method = 'manual'` source type encodes that difference in the data model, so provenance stays honest about how each record was obtained.

### 1.4 Institutional permission

Per ADR-013, no permission is sought before launch. The project operates entirely within what is available without it. The `sources.method` enum means that if automated crawling of currently-blocked routes is ever wanted, enabling it is a config change rather than a redesign.

If TUP ever objects, the response is compliance, not argument — see §4.

---

## 2. Licensing

Split licensing, because code and data have different concerns.

| Asset | License | Rationale |
|---|---|---|
| Source code | **MIT** | Maximum reuse; other schools should be able to fork this for their own institution |
| Dataset (API output, dumps) | **CC-BY-4.0** | Requires attribution to the project *and* to TUP as originating source |
| Documentation | **CC-BY-4.0** | Same |
| Raw snapshots | Not redistributed | Verbatim copies of TUP pages; retained internally for provenance only |

Snapshots are deliberately not published. They are internal evidence and debugging material, not a redistribution channel.

### Required attribution

```
Data from TUP Open Data API (https://<domain>),
aggregated from official TUP campus websites.
Unofficial — not affiliated with or endorsed by the
Technological University of the Philippines.
```

`LICENSE` (MIT), `LICENSE-DATA` (CC-BY-4.0), and `NOTICE` live at the repo root.

---

## 3. Unofficial status

Stated prominently on the docs site, the repo README, and in the API's own `/v1/health` and `llms.txt` output:

> **This is an unofficial, independent, student-built project.** It is not affiliated with, endorsed by, or operated by the Technological University of the Philippines. Data is aggregated from public TUP websites and may be incomplete or out of date. For official information, consult the relevant TUP office.

This is not boilerplate hedging. It is what makes the project safe to run and safe to use. A student making an enrollment or financial decision needs to know they are reading an aggregation, not a registrar's record.

---

## 4. Takedown and objection policy

Published at `<domain>/takedown`.

1. Any TUP office may request removal of any content, for any reason, with no justification required.
2. Acknowledged within 24 hours; actioned within 48.
3. The URL pattern goes into `excluded_sources`, which is checked before every fetch and every publish — so removals survive re-crawls automatically rather than depending on anyone remembering.
4. Canonical rows and chunks are deleted. Snapshots are retained unless deletion is explicitly requested.
5. Confirmation sent to the requester.

**Comply first, discuss later, if at all.** The project's value depends on being obviously good-faith. Arguing over a takedown would cost more than any single page is worth.

---

## 5. Continuity — the graduation problem

The author graduates in 2027. Most student projects die at that point. This one is designed not to.

### 5.1 Structural measures

| Measure | Status | Deadline |
|---|---|---|
| Repo under an org, not a personal account | Planned | Before public launch |
| ≥2 maintainers with deploy access | Planned | Phase 5 |
| Secrets in a shared vault, not one laptop | Planned | Phase 0 |
| Domain registered to the org | Planned | Before launch |
| Billing on an org account with a shared payment method | Planned | Phase 4 |
| All runbooks written | Planned | Phase 5 |
| Recorded architecture walkthrough | Planned | Phase 5 |

Ownership question Q5 (GDGoC TUP Manila vs. a neutral `tup-open-data` org) should be resolved before launch. A neutral org is probably better: it survives changes in chapter leadership and does not imply Google affiliation.

### 5.2 The real continuity test

Not "is the code documented" but: **can a new contributor add a campus adapter without talking to the original author?**

That is why `CONTRIBUTING.md` must contain:
- The adapter definition-of-done checklist (TDD Appendix)
- The slug stability rule and why it is a contract
- How to add and regenerate fixtures
- Why `parse()` must be pure
- Why the guard must never be bypassed

### 5.3 Handover to TUP

A standing, written offer: if UITC or any campus wants to adopt, fork, or take ownership of this project, it is theirs — code, data, domain, and documentation, at no cost and with transition support.

Making this offer explicit and public costs nothing and reframes the project from "someone scraping our site" to "someone who built us something." That framing is worth more than any negotiation.

---

## 6. Distribution

### 6.1 Sequence

**Soft launch** — repo public, docs live, no announcement. Run for two weeks. Watch for quarantine events and data errors. Fix quietly.

**Community launch** — in order of natural fit:
1. GDG on Campus TUP Manila — where you have standing
2. DEVCON Manila — the developer community most likely to build on it
3. TUP student orgs and USGs — the users
4. PH dev communities (Reddit r/phclassifieds dev threads, PH tech Discords, Hacker News if it holds up)

**Ecosystem** — publish the SDK to npm, submit the MCP server to MCP directories, write a technical post about the multi-campus normalization problem. That post is the most reusable artifact: the "four sites, three vocabularies, one schema" problem is common to every university system in the country.

### 6.2 What makes it get used

Ranked by actual impact:

1. **Working examples that copy-paste and run.** More important than reference docs.
2. **The flagship query in the first paragraph.** `GET /v1/programs/bsce` returning three campuses is the thirty-second pitch.
3. **The MCP server.** Zero-integration usage for anyone building an agent.
4. **Honest gap documentation.** Telling people what is missing builds more trust than claiming completeness.
5. **Fast response to data-error reports.** One quick fix converts a reporter into a contributor.

### 6.3 Reusability beyond TUP

The architecture — per-institution adapters, a `unit_type` discriminator, canonical-vs-offering split, provenance on every row, anomaly guard — generalizes to any Philippine university system. PUP, and the SUC network broadly, have identical problems.

Keeping `packages/ingest-core` genuinely institution-agnostic costs almost nothing during Phase 1 and makes a future `pup-open-api` a fork rather than a rewrite. This is the same portable-core pattern used in the DEVCON Jumpstart Kit, applied to a different domain.

---

## 7. Community

### 7.1 Contribution types wanted

| Type | Difficulty | Value |
|---|---|---|
| Data error reports | Trivial | **Highest** — catches what freshness tracking cannot |
| Fixture updates after a redesign | Low | High |
| New adapter for a new campus/extension | Medium | High |
| New entity type | Medium | Medium |
| Client libraries in other languages | Medium | Medium |
| Core pipeline improvements | High | Medium |

Data error reports are the highest-value contribution and the easiest to make. The freshness system tells you when something was last verified; it cannot tell you the source was wrong in the first place. Only a human who knows TUP can.

### 7.2 Standards

- Every adapter PR needs fixtures. No exceptions.
- Every schema change needs a migration and an ADR if it is contested.
- Breaking API changes need a version bump and a 6-month parallel-run of the previous version.
- Slugs are permanent. Renames create aliases and 301s.
- No PR that touches authentication, credentials, or student data. There is no version of that which is in scope.

### 7.3 Code of conduct

Contributor Covenant 2.1. This will be used mostly by students, some of them new to open source — the tone of early issue threads sets whether they come back.
