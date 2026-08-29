-- 001 — enums
-- docs/10-data-dictionary.md §2.2  [E1, E13, E15]

-- ASCENDING. Order is semantic: min_confidence uses `confidence >= $1`.
-- THIS ORDER CANNOT BE CHANGED AFTER CREATION. The v2.0 doc had it reversed.
CREATE TYPE confidence_level AS ENUM ('low', 'medium', 'high');

CREATE TYPE ingest_method AS ENUM ('crawl', 'manual', 'partner_feed', 'seed');

-- 'suspended' is distinct from 'unavailable': Taguig is a suspended cPanel account
-- serving HTTP 200, which is a different and more recoverable state.  [E13]
CREATE TYPE source_status AS ENUM ('active', 'unavailable', 'suspended', 'blocked', 'retired');

-- ADR-002: never assume 'college'. Cavite uses departments.
CREATE TYPE unit_type AS ENUM ('college', 'department', 'institute', 'center', 'program_group');

CREATE TYPE degree_level AS ENUM (
  'certificate', 'diploma', 'associate', 'baccalaureate',
  'masters', 'doctorate', 'post_baccalaureate'
);

CREATE TYPE offering_status AS ENUM ('active', 'suspended', 'phased_out', 'unknown', 'removed');

-- The canonical entity list.  [E15]
CREATE TYPE entity_type AS ENUM (
  'campus', 'academic_unit', 'program', 'program_offering',
  'office', 'official', 'announcement', 'document',
  'scholarship', 'fee_estimate', 'procedure'
);
