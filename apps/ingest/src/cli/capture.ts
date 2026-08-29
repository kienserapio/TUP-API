/**
 * `pnpm capture --url=<url> --out=fixtures/manila/`
 *
 * The ONLY command in this repo that touches a live TUP site, and it is manual by
 * design — docs/15 §6. Never wire it into a test, a watch loop, or CI. It exists so a
 * fixture can be captured once, deliberately, off-peak, and then committed; every
 * other command in the project reads that committed copy.
 *
 * Politeness is inherited, not reimplemented: this drives the same Fetcher as the
 * pipeline, so the allowlist, robots check, per-domain delay, and user-agent are
 * identical to a real run.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
  contentHash,
  Fetcher,
  FETCH_POLICY,
  undiciClient,
  closeHttpClients,
  campusOf,
  type ManifestFile,
} from '@tup/core';

interface Args {
  url: string;
  out: string;
  name?: string;
  collectedBy: string;
  note?: string;
}

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string>();
  for (const arg of argv) {
    const match = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    if (match?.[1]) flags.set(match[1], match[2] ?? 'true');
  }
  const url = flags.get('url');
  if (!url) {
    throw new Error(
      'Usage: pnpm capture --url=https://tup.edu.ph/... [--out=fixtures/manila/] [--name=programs] [--note="..."]',
    );
  }
  const campus = campusOf(url);
  const args: Args = {
    url,
    out: flags.get('out') ?? `fixtures/${campus ?? 'unknown'}/`,
    collectedBy: flags.get('collected-by') ?? process.env['USER'] ?? 'unknown',
  };
  const name = flags.get('name');
  if (name) args.name = name;
  const note = flags.get('note');
  if (note) args.note = note;
  return args;
}

/** `/pages/admission/undergraduate-programs` → `pages-admission-undergraduate-programs`. */
function defaultName(url: string): string {
  const path = new URL(url).pathname.replace(/^\/+|\/+$/g, '');
  return path === '' ? 'index' : path.replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase();
}

/** pnpm runs workspace scripts with cwd inside the package; fixtures live at the root. */
function workspaceRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    dir = dirname(dir);
  }
  return process.cwd();
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const outDir = resolve(workspaceRoot(), args.out);
  await mkdir(outDir, { recursive: true });

  // Explicitly live, explicitly one page. `mode` is not read from the environment
  // here: FETCH_MODE=fixtures is correct for every other command and would make this
  // one silently do nothing useful.
  const fetcher = new Fetcher({ mode: 'live', client: undiciClient });

  console.log(`user-agent: ${FETCH_POLICY.userAgent}`);
  console.log(`fetching   ${args.url}`);

  const outcome = await fetcher.fetch({
    url: args.url,
    entityTypes: [],
    method: 'crawl',
  });

  if (outcome.status !== 'fetched') {
    const detail =
      outcome.status === 'failed'
        ? outcome.error
        : outcome.status === 'blocked'
          ? outcome.reason
          : outcome.status;
    throw new Error(`capture failed (${outcome.status}): ${detail}`);
  }

  const { snapshot } = outcome;
  const captureDate = snapshot.fetchedAt.toISOString().slice(0, 10);
  const stem = args.name ?? defaultName(args.url);
  // Filenames carry the capture date; a three-year-old fixture is still a valid
  // regression test — docs/14 §3.3.
  const file = `${stem}-${captureDate}.html`;
  await writeFile(join(outDir, file), snapshot.body);

  const manifestPath = join(outDir, 'MANIFEST.json');
  const manifest: ManifestFile = existsSync(manifestPath)
    ? (JSON.parse(await readFile(manifestPath, 'utf8')) as ManifestFile)
    : { files: [] };

  manifest.files = manifest.files.filter((entry) => entry.url !== args.url);
  manifest.files.push({
    file,
    url: args.url,
    collected_at: snapshot.fetchedAt.toISOString(),
    collected_by: args.collectedBy,
    sha256: contentHash(snapshot.body),
    content_type: snapshot.contentType,
    http_status: snapshot.httpStatus,
    ...(args.note ? { note: args.note } : {}),
  });
  manifest.files.sort((a, b) => (a.file < b.file ? -1 : 1));
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(`wrote      ${join(args.out, file)} (${snapshot.body.byteLength} bytes)`);
  console.log(`manifest   ${join(args.out, basename(manifestPath))}`);
  console.log(`sha256     ${contentHash(snapshot.body)}`);
  await closeHttpClients();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
