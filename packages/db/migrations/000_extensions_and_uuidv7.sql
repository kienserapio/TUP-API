-- 000 — extensions and the uuidv7 polyfill
-- docs/10-data-dictionary.md §2.1  [E4]
-- Supabase runs Postgres 17, which has no built-in uuidv7(); that arrived in PG 18.
-- Delete this function and use the built-in when Supabase ships PG 18.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_bytes; NOT uuid-ossp

-- Supabase installs pgcrypto into the `extensions` schema, a local container into
-- `public`. Postgres silently skips schemas in search_path that do not exist, so
-- naming both makes this function portable across the two.  docs/15 §4
CREATE OR REPLACE FUNCTION uuidv7() RETURNS uuid
LANGUAGE plpgsql VOLATILE
SET search_path = pg_catalog, public, extensions
AS $$
DECLARE
  ts_ms bigint := (extract(epoch FROM clock_timestamp()) * 1000)::bigint;
  bytes bytea  := substring(int8send(ts_ms) FROM 3 FOR 6) || gen_random_bytes(10);
BEGIN
  -- version 7 in the high nibble of byte 7
  bytes := set_byte(bytes, 6, (get_byte(bytes, 6) & 15) | 112);
  -- RFC 4122 variant in the top two bits of byte 9
  bytes := set_byte(bytes, 8, (get_byte(bytes, 8) & 63) | 128);
  RETURN encode(bytes, 'hex')::uuid;
END $$;

-- Time-ordering is the only reason v7 was chosen over v4. A polyfill that produced
-- valid-but-unordered UUIDs would pass every other check, so assert it at migrate time.
DO $$
DECLARE a uuid; b uuid;
BEGIN
  a := uuidv7();
  PERFORM pg_sleep(0.01);
  b := uuidv7();
  ASSERT a < b, format('uuidv7 not time-ordered: %s >= %s', a, b);
  ASSERT substring(a::text, 15, 1) = '7', format('wrong version nibble: %s', a);
  ASSERT substring(b::text, 20, 1) IN ('8','9','a','b'), format('wrong variant: %s', b);
END $$;
