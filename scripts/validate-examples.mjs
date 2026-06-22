// Validates every vendored example harness in examples/<name>/.claudeconf/manifest.json
// against the core of the claudeconf self-verify contract: exactly the nine milestones,
// each with a tool, a pinned (non-floating) version, and a non-empty tiers array.
import { readdirSync, existsSync, readFileSync } from "node:fs";

const REQUIRED = [
  "format", "lint", "typecheck", "unit", "e2e",
  "sast", "secret-scan", "dependency-audit", "build",
];

let checked = 0;

for (const dir of readdirSync("examples", { withFileTypes: true })) {
  if (!dir.isDirectory()) continue;
  const path = `examples/${dir.name}/.claudeconf/manifest.json`;
  if (!existsSync(path)) continue;

  const manifest = JSON.parse(readFileSync(path, "utf8"));
  const keys = Object.keys(manifest.milestones ?? {});
  if (keys.length !== 9 || !REQUIRED.every((k) => keys.includes(k))) {
    throw new Error(`${path}: must contain exactly the nine milestones`);
  }

  for (const [milestone, entry] of Object.entries(manifest.milestones)) {
    if (!entry.tool) throw new Error(`${path}: ${milestone} has no tool`);
    if (entry.version !== "n/a" && /[\^~><=*xX]/.test(entry.version)) {
      throw new Error(`${path}: ${milestone} has a floating version "${entry.version}"`);
    }
    if (!Array.isArray(entry.tiers) || entry.tiers.length === 0) {
      throw new Error(`${path}: ${milestone} has an empty tiers array`);
    }
  }

  console.log(`ok: ${path} — 9 milestones, all pinned`);
  checked++;
}

if (checked === 0) throw new Error("no example manifests found under examples/");
console.log(`validated ${checked} example manifest(s)`);
