/**
 * Snapshot storage. Immutable, never deleted — the only way to debug a parser
 * regression six months later, and the only way to roll back bad published data
 * (docs/03 §2.2).
 *
 * Keyed by `content_hash`, so a page that changes once a year is stored once, not
 * once per run. That is what keeps "snapshots retained indefinitely" compatible with
 * a 1 GB free tier — errata E18.
 */
import { gzip, gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export interface PutResult {
  storageKey: string;
  /** False when this exact content was already stored. Errata E18. */
  wrote: boolean;
  byteSize: number;
}

export interface SnapshotStore {
  put(campusSlug: string, hash: string, body: Buffer): Promise<PutResult>;
  get(storageKey: string): Promise<Buffer | null>;
  has(storageKey: string): Promise<boolean>;
}

export function storageKeyFor(campusSlug: string, hash: string): string {
  return `${campusSlug}/${hash.slice(0, 2)}/${hash}.gz`;
}

export class FilesystemSnapshotStore implements SnapshotStore {
  constructor(private readonly root: string) {}

  private pathFor(key: string): string {
    return resolve(this.root, key);
  }

  async has(storageKey: string): Promise<boolean> {
    try {
      await stat(this.pathFor(storageKey));
      return true;
    } catch {
      return false;
    }
  }

  async put(campusSlug: string, hash: string, body: Buffer): Promise<PutResult> {
    const storageKey = storageKeyFor(campusSlug, hash);
    const path = this.pathFor(storageKey);
    if (await this.has(storageKey)) {
      return { storageKey, wrote: false, byteSize: body.byteLength };
    }
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, await gzipAsync(body));
    return { storageKey, wrote: true, byteSize: body.byteLength };
  }

  async get(storageKey: string): Promise<Buffer | null> {
    try {
      return await gunzipAsync(await readFile(this.pathFor(storageKey)));
    } catch {
      return null;
    }
  }
}

export class MemorySnapshotStore implements SnapshotStore {
  readonly objects = new Map<string, Buffer>();

  put(campusSlug: string, hash: string, body: Buffer): Promise<PutResult> {
    const storageKey = storageKeyFor(campusSlug, hash);
    if (this.objects.has(storageKey)) {
      return Promise.resolve({ storageKey, wrote: false, byteSize: body.byteLength });
    }
    this.objects.set(storageKey, body);
    return Promise.resolve({ storageKey, wrote: true, byteSize: body.byteLength });
  }

  get(storageKey: string): Promise<Buffer | null> {
    return Promise.resolve(this.objects.get(storageKey) ?? null);
  }

  has(storageKey: string): Promise<boolean> {
    return Promise.resolve(this.objects.has(storageKey));
  }
}

/**
 * Supabase Storage over its S3-compatible REST surface. Used only in production —
 * the service role key bypasses every row-level protection and is server-side only
 * (docs/15 §3.2).
 */
export class SupabaseSnapshotStore implements SnapshotStore {
  constructor(
    private readonly url: string,
    private readonly serviceRoleKey: string,
    private readonly bucket = 'snapshots',
  ) {}

  private endpoint(key: string): string {
    return `${this.url.replace(/\/$/, '')}/storage/v1/object/${this.bucket}/${key}`;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      authorization: `Bearer ${this.serviceRoleKey}`,
      apikey: this.serviceRoleKey,
      ...extra,
    };
  }

  async has(storageKey: string): Promise<boolean> {
    const res = await fetch(this.endpoint(storageKey), {
      method: 'HEAD',
      headers: this.headers(),
    });
    return res.ok;
  }

  async put(campusSlug: string, hash: string, body: Buffer): Promise<PutResult> {
    const storageKey = storageKeyFor(campusSlug, hash);
    if (await this.has(storageKey)) {
      return { storageKey, wrote: false, byteSize: body.byteLength };
    }
    const compressed = await gzipAsync(body);
    const res = await fetch(this.endpoint(storageKey), {
      method: 'POST',
      headers: this.headers({
        'content-type': 'application/gzip',
        'cache-control': 'max-age=31536000',
      }),
      body: new Uint8Array(compressed),
    });
    if (!res.ok && res.status !== 409) {
      throw new Error(`Snapshot upload failed: ${res.status} ${await res.text()}`);
    }
    return { storageKey, wrote: res.status !== 409, byteSize: body.byteLength };
  }

  async get(storageKey: string): Promise<Buffer | null> {
    const res = await fetch(this.endpoint(storageKey), { headers: this.headers() });
    if (!res.ok) return null;
    return gunzipAsync(Buffer.from(await res.arrayBuffer()));
  }
}

/**
 * Filesystem unless explicitly told otherwise.
 *
 * Deliberately NOT "Supabase whenever the credentials happen to be present". A
 * developer with deployment values in `.env` and local overrides in `.env.local`
 * (docs/15 §3) would otherwise have every local run write snapshots into the
 * production bucket while reading from a local database. The switch is explicit:
 * `SNAPSHOT_STORE=supabase`, or `NODE_ENV=production`.
 */
export function createSnapshotStore(cwd: string = process.cwd()): SnapshotStore {
  const requested =
    process.env['SNAPSHOT_STORE'] ??
    (process.env['NODE_ENV'] === 'production' ? 'supabase' : 'filesystem');

  if (requested === 'supabase') {
    const url = process.env['SUPABASE_URL'];
    const key = process.env['SUPABASE_SERVICE_ROLE_KEY'];
    if (!url || !key) {
      throw new Error(
        'SNAPSHOT_STORE=supabase needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. ' +
          'They belong in Fly/GitHub secrets, never in a commit — docs/15 §3.2.',
      );
    }
    return new SupabaseSnapshotStore(url, key);
  }

  return new FilesystemSnapshotStore(join(cwd, '.snapshots'));
}
