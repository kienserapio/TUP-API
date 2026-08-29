/**
 * Writes openapi.json from the routes that actually run.
 *
 * CI fails if the committed file differs — the spec drift gate. Because the document
 * is generated from the same Zod schemas the handlers validate against, a contract
 * change cannot happen silently; it arrives as a reviewable diff.
 * docs/05-deployment-and-operations.md §3.2.
 */
import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../app.js';

const out = resolve(dirname(fileURLToPath(import.meta.url)), '../../openapi.json');
const doc = createApp().getOpenAPI31Document({
  openapi: '3.1.0',
  info: { title: 'TUP Open Data API', version: '0.1.0' },
});

await writeFile(out, `${JSON.stringify(doc, null, 2)}\n`);
console.log(`Wrote ${out}`);
