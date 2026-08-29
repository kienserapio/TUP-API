/**
 * Local structural copies of the record shapes in `packages/schemas`, shared by every
 * adapter.
 *
 * Adapters are typed against the shape they must emit, and the pipeline validates
 * every record with the Zod schema before anything is published (docs/03 §3.4). The
 * duplication is deliberate: `packages/adapters` depends on nothing that could give
 * an adapter author a way to reach the network or the database.
 */
export interface AcademicUnitRecord {
  slug: string;
  name: string;
  abbreviation: string | null;
  unit_type: 'college' | 'department' | 'institute' | 'center' | 'program_group';
  description: string | null;
  head_name: string | null;
  head_title: string | null;
  emails: string[];
  website: string | null;
  status: 'active' | 'unknown' | 'removed';
}

export interface ProgramOfferingRecord {
  source_name: string;
  slug: string;
  local_name: string | null;
  unit_slug: string | null;
  majors: string[];
  years: number | null;
  status: 'active' | 'suspended' | 'phased_out' | 'unknown' | 'removed';
  accreditation: Record<string, unknown> | null;
  curriculum_url: string | null;
}
