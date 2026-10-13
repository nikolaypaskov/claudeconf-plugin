// catalog.mjs — the bundle's integrity catalog (PLAN.md AD2). `harness-catalog.json`, shipped
// beside the checker, maps every RELEASED harness-scripts version to the exact file set of the
// `harness/` directory and each file's sha256. A consumer vendors that directory to
// `.claudeconf/bin/`; check A17 compares what is there against the catalog the CHECKER ships —
// never against hashes the consumer could edit alongside the files.
//
// Dependency-free: Node builtins only.

import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * `{ files: { "<relpath>": "<sha256>" }, problems: string[] }` for every entry under `dir`.
 * A symlink, or anything that is not a regular file or directory, is a PROBLEM, never followed:
 * a link is how a vendored tree points somewhere the catalog never saw.
 */
export function hashTree(dir) {
  const files = {};
  const problems = [];
  const walk = (current) => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      const rel = relative(dir, path).split(sep).join('/');
      const st = lstatSync(path);
      if (st.isSymbolicLink()) problems.push(`${rel} is a symlink`);
      else if (st.isDirectory()) walk(path);
      else if (st.isFile())
        files[rel] = createHash('sha256').update(readFileSync(path)).digest('hex');
      else problems.push(`${rel} is not a regular file`);
    }
  };
  walk(dir);
  return { files, problems };
}

/** Compares a hashed tree with one catalog entry: missing, extra and edited files. */
export function compareToEntry(tree, entry) {
  const missing = Object.keys(entry).filter((f) => !(f in tree));
  const extra = Object.keys(tree).filter((f) => !(f in entry));
  const edited = Object.keys(entry).filter((f) => f in tree && tree[f] !== entry[f]);
  return { missing, extra, edited };
}
