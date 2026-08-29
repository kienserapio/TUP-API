-- 003 — the synthetic seed source
-- docs/10-data-dictionary.md §5.1
-- Hand-seeded rows still need a source_id: every row must be attributable.
-- Hand curation is a STRONGER provenance claim than a scrape, not a weaker one.

INSERT INTO sources (url, origin, domain, entity_types, method, status, crawl_enabled, notes)
VALUES ('seed://tup-open-api/seeds', 'seed://tup-open-api', 'seed',
        ARRAY['campus','academic_unit','program']::entity_type[], 'seed', 'active', false,
        'Hand-curated seed data from seeds/*.yaml. Not fetched.')
ON CONFLICT (url) DO NOTHING;
