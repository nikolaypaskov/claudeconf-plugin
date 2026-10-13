#!/usr/bin/env node
// check-project-checks.mjs — constitution §4.4 / contract §1 "Project-check assertion".
//
// Proves every project-owned check DECLARED in `.claudeconf/manifest.json` projectChecks[]
// still resolves at every tier it claims:
//
//   pre-commit | pre-push | gate  a job of that name in the MERGED hook configuration
//                                 (`lefthook dump -f json`) that is not inert and whose
//                                 command EXECUTES the declared `run` substring;
//   ci                            a job id or step name in `manifest.ci.workflow` that is
//                                 REACHABLE (its own `if:`, its `needs` closure followed
//                                 transitively, its matrix) and whose command EXECUTES the
//                                 declared `run` substring.
//
// A name is not protection and neither is a command that does nothing: a no-op (`true`, `:`,
// a bare `echo`, empty), a version/help probe, an inert job (`skip: true`, an `only:`, or a
// `skip` list that cannot be shown to narrow), a match inside a shell comment, a match inside a
// statically dead construct, and a match that only ever appears inside a quoted string are all
// NOT satisfied. Neither is a command whose control flow this script will not guess at: an
// `if false` wrapped in anything but the simplest shape is UNRESOLVED, never assumed live and
// never assumed dead (contract §2.3, spec §5 R-C5/R-I3).
//
// SIGNAL-BEARING (contract §2.3/§3.3): a declared check that runs but cannot FAIL — a
// demonstrated swallow, or a status path this reader cannot show — is not satisfied.
//
// This file ships in the claudeconf bundle and is VENDORED into the project at
// `.claudeconf/bin/` together with `lib/` (contract §1, profile 6), so it carries ZERO
// third-party dependencies and runs on nothing but Node, the harness runtime. The plugin's vendored
// YAML parser
// is deliberately not used: it does not ship with a generated harness. The workflow scanner
// below is a minimal, honest reader of the keys these rules need — it is NOT a YAML parser,
// and anything it cannot resolve confidently is exit 2 with the reason, never a silent pass.
//
// The command reader is SHARED with the checker's W12 (`lib/shell.mjs`), and so is the pinned
// config map (`lib/tool-configs.mjs`): one implementation, not three kept in step by a test.
//
// Usage: node .claudeconf/bin/check-project-checks.mjs [--root <dir>]
// Exit:  0 every declared check is satisfied (or none are declared)
//        1 a declared check is NOT satisfied — each listed as `<name>@<tier>` with the reason
//        2 usage or environment error (unusable manifest, unresolvable runner, unparseable
//          workflow) — always with an actionable message

import { execFileSync } from 'node:child_process';
import console from 'node:console';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import process from 'node:process';
import {
  analyseCommand,
  classifyWork,
  continueOnErrorVerdict,
  executableText,
  firstLine,
  liveStatements,
  locateInStatement,
  runContains,
  signalVerdict,
  splitTopLevel,
  tokenize,
  Unresolved,
} from './lib/shell.mjs';
import { pinnedConfigFor } from './lib/tool-configs.mjs';

const USAGE = 'usage: check-project-checks.mjs [--root <dir>]';
const MANIFEST_REL = '.claudeconf/manifest.json';
const MANAGED_HOOK_REL = '.claudeconf/lefthook.yml';
const HOOK_TIERS = ['pre-commit', 'pre-push', 'gate'];
const TIERS = [...HOOK_TIERS, 'ci'];
const NAME_RX = /^[A-Za-z0-9._-]+$/;

/** Contract §2.4 — the CLOSED managed-name set a project-owned check may never reuse. */
const MANAGED_NAMES = new Set([
  'format',
  'format-check',
  'lint',
  'typecheck',
  'unit',
  'unit-changed',
  'unit-full',
  'unit-coverage',
  'e2e',
  'sast',
  'secret-scan',
  'dependency-audit',
  'build',
  'tool-versions',
  'workflow-audit',
  'suppressions',
  'project-checks',
]);

// ---------------------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------------------

/** An unusable input or environment. Never a pass, never exit 1 — this is not a verdict. */
function usageError(message, ...remediation) {
  console.error(`project-checks: ${message}`);
  for (const line of remediation) console.error(`  ${line}`);
  process.exit(2);
}

// ---------------------------------------------------------------------------------------
// Shell-command analysis and propagation (contract §3.3 — mirrors the reference W12/W20)
// ---------------------------------------------------------------------------------------
//
// Signal-bearing is a POSITIVE obligation: a command qualifies only when there is a
// demonstrable path by which the invoked tool's non-zero exit becomes the command's non-zero
// exit. This reader never hunts for known ways of discarding a status — that list was written
// twice and was one shape short both times. Two rules govern the answer, and both are the
// contract's:
//
//   Unresolvability is a FLOOR, never a ceiling. The strongest DEMONSTRATED verdict wins; a
//   command that demonstrably discards its status does not become unresolved because it also
//   contains a construct this reader cannot parse — otherwise one `$( )` beside a swallow
//   launders a FAIL and the safety valve becomes the bypass.
//
//   CONSERVATIVE means do not GUESS, not refuse whatever looks complex. A here-document body
//   is DATA, nested groups are parsed, and only a genuinely unreadable construct collapses to
//   an OPAQUE token, so the surrounding structure stays analysable and the unreadable part
//   does not spread to swallow the whole command.
//
// The two exemptions §3.3 defines — an ADVISORY milestone (constitution §2's mode column) and
// an ADVISORY tier (§1's) — are structurally INAPPLICABLE here, which is why this artifact
// reads no mode table and hardcodes no list of either: a `projectChecks` entry names no
// milestone, and contract §2.3 accepts only tiers §1 records BLOCKING (`edit`, the one
// advisory tier, is not an accepted value). If §2.3 ever admits an advisory tier, the
// exemption has to be read there from the recorded mode, exactly as the reference does.
//
// The pinned-config map turns a work UNKNOWN into a PASS exactly as the checker does. No W12
// outcome reads a work UNKNOWN — `blocksWiring` blocks on FAIL and on a CONTROL unknown only —
// so it changes no verdict here; it is wired so the two readers cannot drift apart.

/**
 * A text artifact, decoded and newline-normalised the SAME way in BOTH runtimes.
 *
 * Node's UTF-8 decode substitutes U+FFFD for an undecodable byte while Python's raises, and
 * Python's text mode silently translates CRLF while Node's does not. Either difference alone
 * makes the two forms answer differently on a file a real project can commit — a
 * Windows-authored workflow, one stray latin-1 byte in a comment — so both are pinned here,
 * once, and every artifact read goes through this function.
 */
function readText(path) {
  return readFileSync(path, 'utf8').replace(/\r\n?/g, '\n');
}

function jobRun(def) {
  return typeof def.run === 'string' ? def.run : '';
}

/**
 * EVERY command a job executes, flattening lefthook's nested groups.
 *
 * The runner's nesting shape is `job.group.jobs` — verified against the pinned runner, which
 * DROPS a `job.jobs` key entirely — and the old reader walked the shape that does not exist. A
 * job carrying only a group therefore had no command at all: `no command to judge`, INFO, and a
 * `|| true` inside the group neutered the suppression ledger with a zero-FAIL run. Every reader
 * of a job's command goes through here, so the nesting is handled once rather than per check.
 */
function jobCommands(def, depth = 0) {
  if (!def || typeof def !== 'object' || depth > 4) return [];
  const own = jobRun(def);
  if (own) return [own];
  const inner = def.group && Array.isArray(def.group.jobs) ? def.group.jobs : [];
  return inner.flatMap((job) => jobCommands(job, depth + 1));
}

/**
 * How to SAY a non-PASS signal verdict: a DEMONSTRATED swallow, or one that cannot be shown.
 *
 * Both tiers report through here. The hook tier used to consult the verdict for `FAIL` alone
 * and let everything else fall through as satisfied, which answered "runs" for a command whose
 * propagation was never established — a `case`-wrapped one, for instance. Anything that is not
 * PASS is not satisfied; only the wording distinguishes the two.
 */
function signalPhrase(status) {
  return status === 'FAIL' ? 'is not signal-bearing' : 'cannot be shown to be signal-bearing';
}

/** The shared verdict for "the declared `run` substring must execute in this command". */
function runMatchReason(command, needle) {
  const verdict = runContains(command, needle);
  if (verdict === true) return null;
  const where = `\`${firstLine(command).trim()}\``;
  if (verdict === false) return `\`${needle}\` is not in an executed position of ${where}`;
  return (
    `\`${needle}\` appears only inside a quoted string or an unresolvable construct in ` +
    `${where} — it is not shown to execute`
  );
}

// ---------------------------------------------------------------------------------------
// Workflow scanner — NOT a YAML parser. Fails loud on anything it cannot resolve.
// ---------------------------------------------------------------------------------------

/** Thrown by the scanner; the caller turns it into an exit-2 message naming the line. */
class ScanError extends Error {}

function scanFail(line, message) {
  throw new ScanError(line ? `line ${line}: ${message}` : message);
}

function indentOf(line) {
  return line.length - line.replace(/^ +/, '').length;
}

function isSkippable(line) {
  const t = line.trim();
  return t === '' || t.startsWith('#');
}

/** Strips a YAML `#` comment (outside quotes) from a value or a key line. */
function yamlStripComment(text) {
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '#' && (i === 0 || /\s/.test(text[i - 1]))) {
      return text.slice(0, i);
    }
  }
  return text;
}

/** Unquotes a scalar. Only the escapes GitHub workflows actually use are honoured. */
function unquote(value, line) {
  const v = value.trim();
  if (v.length >= 2 && v[0] === "'" && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  if (v.length >= 2 && v[0] === '"' && v.endsWith('"')) {
    return v
      .slice(1, -1)
      .replace(/\\(["\\/])/g, '$1')
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t');
  }
  if (v.startsWith('&') || v.startsWith('*')) {
    scanFail(line, 'YAML anchors and aliases are not supported by this scanner');
  }
  return v;
}

/**
 * The child line range of the key at `start` (1-based `lines` index semantics are avoided:
 * every index here is 0-based). Children are the following lines indented deeper than `indent`,
 * with interleaved blank/comment lines absorbed.
 */
function childRange(lines, start, end, indent) {
  let last = start;
  for (let i = start + 1; i < end; i++) {
    if (isSkippable(lines[i])) continue;
    const ind = indentOf(lines[i]);
    // A block SEQUENCE may sit flush with its key: `steps:` followed by `- name:` at the SAME
    // indent is legal and common YAML. Refusing it exited 2 on a working harness, which is the
    // strict-direction failure the contract warns about — the owner's only move is a bypass.
    if (ind < indent) break;
    if (ind === indent && !(isSeqItem(lines[i]) && flushSequence(lines, start, end, indent))) {
      break;
    }
    last = i;
  }
  return [start + 1, last + 1];
}

function isSeqItem(line) {
  return /^ *-( |$)/.test(line);
}

/**
 * Is the key at `start` followed by a sequence written FLUSH with it? True only when the key
 * carries no inline value and the very next content line is a `- ` item at the key's own
 * indent — so an ordinary sibling key still ends the range.
 */
function flushSequence(lines, start, end, indent) {
  const head = lines[start].match(/^ *([A-Za-z0-9_.-]+):(?: (.*)|)$/);
  if (!head || yamlStripComment(head[2] ?? '').trim() !== '') return false;
  for (let i = start + 1; i < end; i++) {
    if (isSkippable(lines[i])) continue;
    return indentOf(lines[i]) === indent && isSeqItem(lines[i]);
  }
  return false;
}

/**
 * Reads a block mapping into ordered entries `{ key, value, start, end, line }` where `value`
 * is the raw inline text after the colon (comment-stripped) and `[start, end)` is the child
 * range. Anything that is not a plain `key:` line at the block's own indent is a scan failure.
 */
function readMap(lines, start, end) {
  const entries = [];
  let indent = null;
  for (let i = start; i < end; i++) {
    if (isSkippable(lines[i])) continue;
    const ind = indentOf(lines[i]);
    if (indent === null) indent = ind;
    if (ind > indent) continue; // belongs to the previous key's child range
    if (ind < indent) scanFail(i + 1, 'unexpected dedent inside a mapping');
    // A `- ` item at the mapping's own indent belongs to the flush sequence of the key above.
    if (isSeqItem(lines[i]) && entries.length) continue;
    // Checked before the key pattern, which cannot match `<<` and would otherwise report a
    // merge key through the generic branch — the same refusal with a less useful reason.
    if (/^ *<<\s*:/.test(lines[i])) {
      scanFail(i + 1, 'YAML merge keys are not supported by this scanner');
    }
    const m = lines[i].match(/^ *([A-Za-z0-9_.-]+):(?: (.*)|)$/);
    if (!m) {
      if (lines[i].trim().startsWith('-')) scanFail(i + 1, 'expected a mapping key, found a list');
      scanFail(i + 1, `cannot read \`${lines[i].trim()}\` as a mapping key`);
    }
    const [cs, ce] = childRange(lines, i, end, indent);
    entries.push({
      key: m[1],
      value: yamlStripComment(m[2] ?? '').trim(),
      start: cs,
      end: ce,
      indent,
      line: i + 1,
    });
  }
  return entries;
}

/** Reads a block sequence into item line ranges `[start, end)`. */
function readSeq(lines, start, end) {
  const items = [];
  let indent = null;
  let contentAt = null;
  for (let i = start; i < end; i++) {
    if (isSkippable(lines[i])) continue;
    const ind = indentOf(lines[i]);
    if (indent === null) {
      indent = ind;
      contentAt = itemContentIndent(lines[i]);
    }
    if (ind > indent) {
      // A `- ` line deeper than the items but no deeper than an item's own KEYS is a sibling
      // that was mis-indented, not a nested list. YAML rejects the file outright, so the
      // declared check produces no signal at all — reading it as a nested value would report a
      // workflow GitHub refuses to run as satisfied.
      if (isSeqItem(lines[i]) && ind <= contentAt) {
        scanFail(i + 1, `sequence items are indented inconsistently (${indent} then ${ind})`);
      }
      continue;
    }
    if (ind < indent) scanFail(i + 1, 'unexpected dedent inside a sequence');
    if (!isSeqItem(lines[i])) scanFail(i + 1, 'expected a `- ` sequence item');
    const [, ce] = childRange(lines, i, end, indent);
    items.push([i, ce]);
  }
  return items;
}

/** The column at which a `- ` item's own keys start. */
function itemContentIndent(line) {
  const dash = line.indexOf('-');
  const rest = line.slice(dash + 1);
  return dash + 1 + (rest.length - rest.replace(/^ +/, '').length);
}

/**
 * Turns one `- key: value` item into a mapping block: the leading dash is blanked out so the
 * first inline key lines up with the item's own keys, which the mapping reader then handles.
 */
function seqItemMap(lines, start, end) {
  const head = lines[start];
  const dash = head.indexOf('-');
  const rest = head.slice(dash + 1);
  if (rest.trim() === '') return readMap(lines, start + 1, end);
  const contentAt = dash + 1 + (rest.length - rest.replace(/^ +/, '').length);
  const copy = lines.slice();
  copy[start] = ' '.repeat(contentAt) + head.slice(contentAt);
  return readMap(copy, start, end);
}

/** A scalar value: inline, or a literal block scalar. Folded (`>`) scalars fail loud. */
function scalarValue(lines, entry) {
  const raw = entry.value;
  if (/^[>|]/.test(raw)) {
    if (raw[0] === '>') scanFail(entry.line, 'folded (`>`) block scalars are not supported');
    if (!/^\|[-+]?$/.test(raw)) scanFail(entry.line, `unsupported block scalar header \`${raw}\``);
    const body = [];
    let blockIndent = null;
    for (let i = entry.start; i < entry.end; i++) {
      if (lines[i].trim() === '') {
        body.push('');
        continue;
      }
      const ind = indentOf(lines[i]);
      if (blockIndent === null) {
        // The block's indentation is set by its first non-blank line and must be deeper than
        // the key's own. A LESS-indented line later on is a YAML error, not content: blindly
        // slicing it eats its leading characters and INVENTS a command — a silent misread,
        // which is the one thing this scanner promises never to do.
        if (ind <= entry.indent) {
          scanFail(i + 1, 'block scalar content is not indented past its key');
        }
        blockIndent = ind;
      } else if (ind < blockIndent) {
        scanFail(i + 1, `block scalar line is indented less than the block (${blockIndent})`);
      }
      body.push(lines[i].slice(blockIndent));
    }
    while (body.length && body[body.length - 1] === '') body.pop();
    return raw === '|-' ? body.join('\n') : `${body.join('\n')}\n`;
  }
  if (raw === '') {
    if (entry.end > entry.start) {
      scanFail(entry.line, `\`${entry.key}:\` has no inline value and is not a block scalar`);
    }
    return null;
  }
  if (raw.startsWith('{') || raw.startsWith('[')) {
    scanFail(entry.line, `\`${entry.key}:\` uses a flow collection where a scalar is required`);
  }
  return unquote(raw, entry.line);
}

/** A list value: an inline flow sequence of scalars, a single scalar, or a block sequence. */
function listValue(lines, entry) {
  const raw = entry.value;
  if (raw.startsWith('[')) {
    if (!raw.endsWith(']')) scanFail(entry.line, 'unterminated flow sequence');
    const inner = raw.slice(1, -1).trim();
    if (inner === '') return [];
    if (inner.includes('{')) scanFail(entry.line, 'flow mappings are not supported');
    return inner.split(',').map((s) => unquote(s, entry.line));
  }
  if (raw !== '') return [unquote(raw, entry.line)];
  if (entry.end <= entry.start) return null;
  return readSeq(lines, entry.start, entry.end).map(([s, e]) => {
    const head = lines[s];
    const item = head.slice(head.indexOf('-') + 1).trim();
    if (item === '' || e > s + 1) scanFail(s + 1, 'expected a scalar sequence item');
    return unquote(yamlStripComment(item), s + 1);
  });
}

/**
 * Scans a GitHub workflow for the keys the resolution rules need: job ids, each job's `if`,
 * `needs` and `strategy.matrix`, and each step's `name`, `if`, `run`, `uses` and `with.args`.
 * Everything else is skipped by indentation. Throws ScanError on anything ambiguous.
 */
function scanWorkflow(text) {
  const lines = text.split('\n');
  let sawContent = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*\t/.test(lines[i])) scanFail(i + 1, 'tab indentation is not valid YAML');
    const t = lines[i].trim();
    if (t === '---' && sawContent) scanFail(i + 1, 'multi-document workflows are not supported');
    if (t === '...') scanFail(i + 1, 'multi-document workflows are not supported');
    if (t !== '' && !t.startsWith('#') && t !== '---') sawContent = true;
  }
  const jobsLines = lines
    .map((l, i) => (/^jobs:\s*(#.*)?$/.test(l) ? i : -1))
    .filter((i) => i >= 0);
  if (!jobsLines.length) {
    const inline = lines.findIndex((l) => /^jobs:\s*\S/.test(l));
    if (inline >= 0) scanFail(inline + 1, '`jobs:` is not a block mapping');
    scanFail(0, 'no top-level `jobs:` mapping in the workflow');
  }
  if (jobsLines.length > 1) scanFail(jobsLines[1] + 1, 'duplicate top-level `jobs:` key');

  const from = jobsLines[0] + 1;
  let to = lines.length;
  for (let i = from; i < lines.length; i++) {
    if (isSkippable(lines[i])) continue;
    if (indentOf(lines[i]) === 0) {
      to = i;
      break;
    }
  }
  const jobs = [];
  const seen = new Set();
  for (const entry of readMap(lines, from, to)) {
    if (entry.value !== '') scanFail(entry.line, `job \`${entry.key}\` is not a block mapping`);
    if (seen.has(entry.key)) scanFail(entry.line, `duplicate job id \`${entry.key}\``);
    seen.add(entry.key);
    jobs.push(readJob(lines, entry));
  }
  if (!jobs.length) scanFail(jobsLines[0] + 1, '`jobs:` declares no jobs');
  return jobs;
}

function readJob(lines, jobEntry) {
  const job = {
    id: jobEntry.key,
    line: jobEntry.line,
    if: null,
    needs: [],
    matrix: undefined,
    shell: null,
    continueOnError: null,
    steps: [],
  };
  for (const entry of readMap(lines, jobEntry.start, jobEntry.end)) {
    if (entry.key === 'if') job.if = scalarValue(lines, entry);
    else if (entry.key === 'needs') job.needs = listValue(lines, entry) ?? [];
    else if (entry.key === 'strategy') job.matrix = readMatrix(lines, entry);
    else if (entry.key === 'continue-on-error') job.continueOnError = scalarValue(lines, entry);
    else if (entry.key === 'defaults') job.shell = readDefaultShell(lines, entry);
    else if (entry.key === 'steps') job.steps = readSteps(lines, entry, job);
  }
  return job;
}

/** `defaults.run.shell` — a job-wide shell whose error handling is not the provider default. */
function readDefaultShell(lines, defaultsEntry) {
  if (defaultsEntry.value !== '') {
    scanFail(defaultsEntry.line, '`defaults:` is not a block mapping');
  }
  for (const entry of readMap(lines, defaultsEntry.start, defaultsEntry.end)) {
    if (entry.key !== 'run') continue;
    if (entry.value !== '') scanFail(entry.line, '`defaults.run:` is not a block mapping');
    for (const inner of readMap(lines, entry.start, entry.end)) {
      if (inner.key === 'shell') return scalarValue(lines, inner);
    }
  }
  return null;
}

/** A step's effective shell: its own, else its job's `defaults.run.shell`. */
function stepShell(step) {
  return step.shell ?? step.job?.shell ?? null;
}

/**
 * `strategy.matrix` reduced to what reachability needs: absent, a scalar (schedules nothing),
 * empty (schedules nothing), or a mapping with its dimensions and `include` length.
 */
function readMatrix(lines, strategyEntry) {
  if (strategyEntry.value !== '') {
    scanFail(strategyEntry.line, '`strategy:` is not a block mapping');
  }
  const matrix = readMap(lines, strategyEntry.start, strategyEntry.end).find(
    (e) => e.key === 'matrix',
  );
  if (!matrix) return undefined;
  if (matrix.value !== '') {
    if (listLength(lines, matrix) === 0) return { kind: 'map', dims: [], include: null };
    if (matrix.value.startsWith('[') || matrix.value.startsWith('{')) {
      scanFail(matrix.line, '`matrix:` uses a flow collection this scanner cannot expand');
    }
    return { kind: 'scalar' };
  }
  if (matrix.end <= matrix.start) return { kind: 'empty' };
  const dims = [];
  let include = null;
  for (const entry of readMap(lines, matrix.start, matrix.end)) {
    if (entry.key === 'exclude') continue;
    if (entry.key === 'include') {
      include = listLength(lines, entry);
      continue;
    }
    // Only a value that IS a list and is EMPTY expands to nothing; `os:` with no items is
    // YAML null, which the reference implementation does not count as an empty dimension.
    dims.push(listLength(lines, entry) === 0);
  }
  return { kind: 'map', dims, include };
}

/**
 * Is this value a list, and is it empty? `null` when it is not a list at all, `0` for an empty
 * one, `1` for a non-empty one — the rules only ever ask "is it a list of length zero".
 *
 * Comparing the raw text against the two characters `[]` was a bug: `os: [ ]` is the same
 * empty sequence spelled with a space, and reading it as a POPULATED dimension reports a job
 * GitHub never schedules as satisfied.
 */
function listLength(lines, entry) {
  const raw = entry.value;
  if (raw.startsWith('[')) {
    if (!raw.endsWith(']')) scanFail(entry.line, 'unterminated flow sequence');
    return raw.slice(1, -1).trim() === '' ? 0 : 1;
  }
  if (raw !== '') return null; // a scalar is not a list
  if (entry.end <= entry.start) return null; // `key:` with no children is YAML null
  for (let i = entry.start; i < entry.end; i++) {
    if (isSkippable(lines[i])) continue;
    // A block sequence always has at least one item — an empty one is YAML null, above.
    return /^ *-( |$)/.test(lines[i]) ? 1 : null;
  }
  return null;
}

function readSteps(lines, stepsEntry, job) {
  if (stepsEntry.value !== '') scanFail(stepsEntry.line, '`steps:` is not a block sequence');
  const steps = [];
  for (const [s, e] of readSeq(lines, stepsEntry.start, stepsEntry.end)) {
    const step = {
      name: '',
      if: null,
      run: '',
      uses: '',
      args: '',
      shell: null,
      continueOnError: null,
      line: s + 1,
      job,
    };
    for (const entry of seqItemMap(lines, s, e)) {
      if (entry.key === 'name') step.name = scalarValue(lines, entry) ?? '';
      else if (entry.key === 'if') step.if = scalarValue(lines, entry);
      else if (entry.key === 'run') step.run = scalarValue(lines, entry) ?? '';
      else if (entry.key === 'uses') step.uses = scalarValue(lines, entry) ?? '';
      else if (entry.key === 'shell') step.shell = scalarValue(lines, entry);
      else if (entry.key === 'continue-on-error') {
        step.continueOnError = scalarValue(lines, entry);
      } else if (entry.key === 'with') {
        if (entry.value !== '') scanFail(entry.line, '`with:` is not a block mapping');
        const args = readMap(lines, entry.start, entry.end).find((w) => w.key === 'args');
        if (args) step.args = scalarValue(lines, args) ?? '';
      }
    }
    steps.push(step);
  }
  return steps;
}

/**
 * The command a step executes: its `run`, or a docker action's `args` prefixed by the image's
 * binary name (the image IS the executable, so `args: filesystem .` runs
 * `trufflehog filesystem .`).
 */
function stepCommand(step) {
  if (step.run) return step.run;
  if (step.uses.startsWith('docker://')) {
    const image = basename(step.uses.slice('docker://'.length).split('@')[0].split(':')[0]);
    const args = step.args.trim();
    if (!args) return image;
    return tokenize(args)[0] === image ? args : `${image} ${args}`;
  }
  return '';
}

// ---------------------------------------------------------------------------------------
// Reachability — existence is not reachability (contract §3.3, spec §5 R-I3)
// ---------------------------------------------------------------------------------------

/** Can this `if:` be shown TRUE for the authoritative pull-request event? */
function conditionVerdict(expr) {
  if (expr === undefined || expr === null || expr === true) return null;
  const text = String(expr)
    .replace(/^\$\{\{/, '')
    .replace(/\}\}$/, '')
    .trim();
  if (!text || text === 'true') return null;
  if (text === 'false') return 'always false';
  let unknown = false;
  for (const part of text.split('&&').map((p) => p.trim())) {
    if (/^github\.event_name\s*==\s*'pull_request'$/.test(part)) continue;
    if (/^github\.event_name\s*!=\s*'pull_request'$/.test(part)) {
      return `\`${part}\` excludes pull_request`;
    }
    unknown = true;
  }
  return unknown ? `\`${text}\` cannot be shown true for the pull-request event` : null;
}

/**
 * Reachability of a CI job/step for the authoritative pull-request event. Returns null when
 * reachable, else the reason. `seen` is a PER-PATH visited set: a diamond is not a cycle.
 */
function reachability(jobs, job, step, seen = new Set()) {
  if (!job) return 'job could not be located';
  if (seen.has(job.id)) return `cyclic \`needs\` at ${job.id}`;
  const path = new Set(seen).add(job.id);
  const matrix = job.matrix;
  if (matrix !== undefined) {
    if (matrix.kind === 'scalar' || matrix.kind === 'empty')
      return 'strategy.matrix schedules nothing';
    const emptyDim = matrix.dims.some((d) => d);
    if (emptyDim || (!matrix.dims.length && matrix.include === 0)) {
      return 'strategy.matrix expands to zero combinations';
    }
    if (!matrix.dims.length && matrix.include === null) {
      return 'strategy.matrix cannot be expanded statically';
    }
  }
  const jobIf = conditionVerdict(job.if);
  if (jobIf) return `job \`${job.id}\` if: ${jobIf}`;
  if (step) {
    const stepIf = conditionVerdict(step.if);
    if (stepIf) return `step \`${step.name}\` if: ${stepIf}`;
  }
  for (const need of job.needs) {
    const dep = jobs.find((j) => j.id === need);
    if (!dep) return `\`needs: ${need}\` does not exist`;
    const depReason = reachability(jobs, dep, null, path);
    if (depReason) return `via needs → ${depReason}`;
  }
  return null;
}

// ---------------------------------------------------------------------------------------
// Environment — the merged hook configuration
// ---------------------------------------------------------------------------------------

function resolveFrom(base, p) {
  return isAbsolute(p) ? p : resolve(base, p);
}

function whichOnPath(name) {
  for (const dir of (process.env.PATH || '').split(':').filter(Boolean)) {
    const candidate = join(dir, name);
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // not there; keep looking
    }
  }
  return null;
}

/** The `lefthook:` runner path pinned by the managed hook config, if it declares one. */
function configuredRunner(root) {
  const path = join(root, MANAGED_HOOK_REL);
  if (!existsSync(path)) return null;
  for (const line of readText(path).split('\n')) {
    const m = line.match(/^lefthook:(?: (.*)|)$/);
    if (m) {
      const value = yamlStripComment(m[1] ?? '').trim();
      if (value) return value.replace(/^["']|["']$/g, '');
    }
  }
  return null;
}

/**
 * Resolves the hook runner the way the INSTALLED SHIM does, so the assertion reads the config
 * the binary that actually runs the hooks would read: `$LEFTHOOK_BIN` → the `lefthook:` path
 * in the managed config → `lefthook` on PATH → `node_modules/.bin/lefthook`.
 */
function resolveRunner(root) {
  const candidates = [];
  if (process.env.LEFTHOOK_BIN) {
    const named = resolveFrom(root, process.env.LEFTHOOK_BIN);
    // The shim falls THROUGH a missing $LEFTHOOK_BIN to the next candidate; an assertion must
    // not. Silently reading the merged config of a runner the operator did not name is the
    // F12 hazard itself, so an explicitly named path that is not there is an error.
    if (!existsSync(named)) {
      usageError(
        `$LEFTHOOK_BIN=${process.env.LEFTHOOK_BIN} does not exist`,
        `it resolves to ${named}`,
        'point it at the pinned runner, or unset it to use the configured path / PATH',
      );
    }
    candidates.push({ path: named, source: '$LEFTHOOK_BIN' });
  }
  const configured = configuredRunner(root);
  if (configured) {
    candidates.push({
      path: resolveFrom(root, configured),
      source: `${MANAGED_HOOK_REL} lefthook:`,
    });
  }
  const onPath = whichOnPath('lefthook');
  if (onPath) candidates.push({ path: onPath, source: 'PATH' });
  candidates.push({
    path: join(root, 'node_modules', '.bin', 'lefthook'),
    source: 'node_modules/.bin',
  });
  for (const c of candidates) if (c.path && existsSync(c.path)) return c;
  return null;
}

function capture(bin, args, cwd) {
  try {
    return { status: 0, stdout: execFileSync(bin, args, { cwd, encoding: 'utf8' }), stderr: '' };
  } catch (e) {
    // A SPAWN failure (missing, not executable) has a runtime-specific message in every
    // language; normalising it keeps the two forms one artifact on a path a user really hits.
    const spawned = typeof e.status === 'number';
    return {
      status: spawned ? e.status : 1,
      stdout: e.stdout ?? '',
      stderr: spawned ? (e.stderr ?? '') : `cannot execute ${bin}`,
    };
  }
}

/**
 * The MERGED hook configuration the runner actually executes. `lefthook dump` resolves the
 * repository through git, so a root that is not the git top level would silently dump SOMEONE
 * ELSE'S configuration — that is an environment error, never a verdict.
 */
function mergedHookJobs(root) {
  const top = capture('git', ['rev-parse', '--show-toplevel'], root);
  if (top.status !== 0) {
    usageError(
      `${root} is not inside a git repository, so the merged hook configuration cannot be read`,
      'the hook runner resolves its configuration through git — run this from the project' +
        ' repository',
    );
  }
  let toplevel = top.stdout.trim();
  try {
    toplevel = realpathSync(toplevel);
  } catch {
    // keep the reported path; the comparison below will report the mismatch
  }
  if (toplevel !== realpathSync(root)) {
    usageError(
      `${root} is not the git top level (${toplevel} is)`,
      'the hook runner resolves its configuration through git, so a dump taken here would',
      'describe a different repository — run the assertion from the repository root',
    );
  }
  const runner = resolveRunner(root);
  if (!runner) {
    usageError(
      'no hook runner resolved, so a declared pre-commit/pre-push/gate check cannot be proven',
      'looked at $LEFTHOOK_BIN, the `lefthook:` path in .claudeconf/lefthook.yml, PATH,',
      'and node_modules/.bin/lefthook — install the pinned runner or set LEFTHOOK_BIN',
    );
  }
  const out = capture(runner.path, ['dump', '-f', 'json'], root);
  if (out.status !== 0) {
    usageError(
      `\`${runner.path} dump -f json\` failed (resolved from ${runner.source})`,
      firstLine(out.stderr.trim()) || 'no error output',
    );
  }
  let dump;
  try {
    dump = JSON.parse(out.stdout);
  } catch (e) {
    usageError(`the hook runner's dump is not valid JSON: ${e.message}`);
  }
  const jobs = [];
  for (const [hook, node] of Object.entries(dump ?? {})) {
    if (!node || typeof node !== 'object' || !Array.isArray(node.jobs)) continue;
    for (const job of node.jobs) {
      if (!job || typeof job !== 'object') continue;
      jobs.push({ hook, name: typeof job.name === 'string' ? job.name : '', def: job });
      for (const nested of Array.isArray(job.jobs) ? job.jobs : []) {
        if (nested && typeof nested === 'object') {
          jobs.push({
            hook,
            name: typeof nested.name === 'string' ? nested.name : '',
            def: nested,
          });
        }
      }
    }
  }
  return jobs;
}

// ---------------------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------------------

function blocksWiring(verdict) {
  return verdict.status === 'FAIL' || (verdict.status === 'UNKNOWN' && verdict.kind === 'control');
}

/**
 * Is a wired hook job actually going to run something? `skip: true` and a non-empty `only:`
 * disable it as thoroughly as `run: true` does — the runner prints it as skipped by condition
 * and exits 0 GREEN. A LIST-valued `skip` (`[merge, rebase]`) is a legitimate narrowing and is
 * not treated as inert.
 */

/**
 * Skip conditions this checker can DEMONSTRATE narrow the job — an ALLOWLIST, deliberately.
 *
 * `skip: [{ref: "*"}]` and `skip: [{run: "true"}]` match in every context and disable the job
 * unconditionally (verified against the pinned runner: `skipped-by-glob (skip) by condition`),
 * which is `skip: true` with one extra line. Enumerating the DANGEROUS shapes is the mistake
 * §2.4 and managed-job identity already refuse to make: the dangerous shape nobody enumerated
 * is the one that gets used. So this names what is ACCEPTED, and everything else — including
 * every shape a future runner release invents — is unresolved.
 */
const NARROWING_STATES = new Set(['merge', 'rebase', 'merge-commit']);
const UNIVERSAL_REFS = new Set(['*', '**', '*/*', '']);

function narrowingElement(element) {
  if (typeof element === 'string') {
    return NARROWING_STATES.has(element.trim())
      ? null
      : `\`${element}\` is not a git state this checker can show narrows the job`;
  }
  if (element && typeof element === 'object' && !Array.isArray(element)) {
    const keys = Object.keys(element);
    if (keys.length === 1 && keys[0] === 'ref') {
      const ref = element.ref;
      if (typeof ref !== 'string' || UNIVERSAL_REFS.has(ref.trim())) {
        return `\`ref: ${JSON.stringify(ref)}\` matches every ref, so it narrows nothing`;
      }
      return null;
    }
    return `\`${JSON.stringify(element)}\` is not a condition this checker can evaluate`;
  }
  return `\`${JSON.stringify(element)}\` is not a recognised skip condition`;
}

/**
 * File filters this checker can DEMONSTRATE still leave files to run on — an ALLOWLIST, for the
 * same reason `skip` is one. Runner-verified on the pinned runner with one staged `a.ts` and a
 * job whose command exits 7: `exclude: [a-z]*`, `*.*` and `?*` each report
 * `no files for inspection` and the hook exits 0, while `*.md` exits 1. A denylist of the eight
 * literals someone thought of accepts every pattern nobody thought of.
 *
 * Accepted: a pattern whose only metacharacters are `*`/`**` AND which still contains a literal
 * name character, so some path is demonstrably outside it (`*.lock`, `package-lock.json`,
 * `src/**`). Everything else — character classes, `?`, braces, and wildcard-only patterns such
 * as a bare star, `*.*` and a recursive star-slash-star — is UNRESOLVED.
 */
function unfilteredBy(value) {
  const list = Array.isArray(value) ? value : [value];
  if (!list.length) return null;
  for (const element of list) {
    if (typeof element !== 'string') {
      return `\`${JSON.stringify(element)}\` is not a pattern this checker can evaluate`;
    }
    const pattern = element.trim();
    if (/[?[\]{}!]/.test(pattern)) {
      return (
        `\`${pattern}\` uses a glob construct this checker cannot bound, so it cannot be ` +
        'shown to leave any file'
      );
    }
    const literal = pattern.replace(/\*+/g, '').replace(/[./\\]/g, '');
    if (!literal) {
      return (
        `\`${pattern}\` has no literal component, so it can match every file and leave the ` +
        'job nothing to run on'
      );
    }
  }
  return null;
}

/** null when the whole list demonstrably narrows; otherwise why it does not. */
function unnarrowedBy(list) {
  if (!Array.isArray(list) || !list.length) return 'an empty condition list narrows nothing';
  for (const element of list) {
    const why = narrowingElement(element);
    if (why) return why;
  }
  return null;
}

/**
 * Is a wired hook job actually going to run something? `skip: true` and `only:` disable it as
 * thoroughly as `run: true` does — the runner prints it as skipped by condition and exits 0
 * GREEN. A LIST-valued `skip` is judged against the allowlist above: live when every element
 * demonstrably narrows, UNRESOLVED otherwise, which never satisfies a requirement.
 */
function inertnessOf(ctx, def, opts = {}) {
  if (def?.skip === true) {
    return { status: 'FAIL', kind: 'control', why: '`skip: true` — the job never runs' };
  }
  if (Array.isArray(def?.skip)) {
    const why = unnarrowedBy(def.skip);
    if (why) {
      return {
        status: 'UNKNOWN',
        kind: 'control',
        why: `\`skip: ${JSON.stringify(def.skip)}\` cannot be shown to narrow the job — ${why}`,
      };
    }
  }
  const only = def?.only;
  const hasOnly =
    only !== undefined && only !== null && only !== false && !(Array.isArray(only) && !only.length);
  if (hasOnly) {
    // `only` INVERTS the `skip` reading: it names the only contexts in which the job runs, so a
    // literal-ref `only` leaves the check inert everywhere else — runner-verified, a gate job
    // with `only: [{ref: main}]` exits 1 on `main` and 0 on a feature branch, which is the
    // branch the gate exists to check before a PR. Nothing this checker can read demonstrates
    // that a condition INCLUDES the pre-merge context, so an `only` is never shown to leave the
    // job live.
    return {
      status: 'UNKNOWN',
      kind: 'control',
      why:
        `\`only: ${JSON.stringify(only)}\` cannot be shown to include the pre-merge context ` +
        `— the job is inert wherever the condition does not hold`,
    };
  }
  const filter = def?.exclude;
  if (filter !== undefined && filter !== null) {
    const why = unfilteredBy(filter);
    if (why) {
      return {
        status: 'UNKNOWN',
        kind: 'control',
        why:
          `\`exclude: ${JSON.stringify(filter)}\` cannot be shown to leave the job any files ` +
          `— ${why}`,
      };
    }
  }
  const commands = jobCommands(def ?? {});
  if (!commands.length) {
    if (def?.group) {
      return {
        status: 'FAIL',
        kind: 'control',
        why: 'the job is an EMPTY group, so it runs nothing',
      };
    }
    return { status: 'UNKNOWN', kind: 'work', why: 'no command' };
  }
  const command = commands.join('\n');
  // Classify the statement that INVOKES the declared check. Reading the command's head instead
  // called `echo src | xargs mytool` a no-op, because `echo` is what the head happens to be.
  // The reference selects it by MILESTONE tool; a project check names a `run` substring, so the
  // needle is the locator here — the same statement either way.
  let statement = command;
  if (opts.needle) {
    const invocation = commandInvokesNeedle(command, opts.needle);
    if (invocation) statement = invocation;
  }
  const analysis = analyseCommand(statement, ctx.pkg);
  return {
    ...classifyWork(analysis, analysis.args, ctx.workOptions?.(analysis) ?? {}),
    kind: 'work',
  };
}

/**
 * The statement of `command` that runs the declared `run` substring, or null. The reference
 * locates it by milestone tool; a `projectChecks` entry binds a command substring instead, so
 * the needle is the locator — the purpose (classify the statement that does the work, not the
 * command's head) is identical.
 */
function commandInvokesNeedle(command, needle) {
  const locate = (text) => runContains(text, needle) === true;
  let statements;
  try {
    statements = liveStatements(command);
  } catch (e) {
    if (!(e instanceof Unresolved)) throw e;
    statements = executableText(command)
      .split('\n')
      .flatMap((line) => splitTopLevel(line, ';'))
      .map((text) => text.trim())
      .filter(Boolean);
  }
  for (const statement of statements) {
    const hit = locateInStatement(statement, locate);
    if (hit) return hit.pipeline[hit.pipeIndex];
  }
  return null;
}

/** A declared check at a hook tier: the job must exist, be live, and run the declared work. */
function resolveHookTier(ctx, hookJobs, name, tier, needle) {
  const job = hookJobs.find((j) => j.hook === tier && j.name === name);
  if (!job) {
    return {
      reason: `no job named "${name}" in the merged \`${tier}\` configuration`,
      command: '',
    };
  }
  const inert = inertnessOf(ctx, job.def, { needle });
  if (blocksWiring(inert)) return { reason: `the job is inert — ${inert.why}`, command: '' };
  // Every command the job runs, lefthook's nested `group:` flattened — the runner's real
  // nesting shape, and the one a `|| true` hides in when only `run:` is read.
  const commands = jobCommands(job.def);
  const holder = commands.find((c) => runContains(c, needle) === true) ?? commands.join('\n');
  const signal = signalVerdict(ctx, holder, { needle });
  if (signal.status !== 'PASS') {
    return {
      reason:
        `the declared check ${signalPhrase(signal.status)} — ${signal.why}; a check that ` +
        `cannot turn red is the same signal as a deleted one`,
      command: holder,
    };
  }
  return { reason: runMatchReason(holder, needle), command: holder };
}

/** A declared check at the `ci` tier: located, REACHABLE, signal-bearing, running the work. */
function resolveCiTier(ctx, jobs, workflowPath, name, needle) {
  const job = jobs.find((j) => j.id === name) ?? null;
  const step = jobs.flatMap((j) => j.steps).find((s) => s.name === name) ?? null;
  if (!job && !step) {
    return { reason: `no job id or step name "${name}" in ${workflowPath}`, command: '' };
  }
  const owner = step ? step.job : job;
  const target = step ?? (job ? (job.steps.find((s) => stepCommand(s)) ?? null) : null);
  // The matched step is `step` when the entry named a STEP and `target` when it named a JOB
  // ID; either way the step whose command is READ must have its own `if` evaluated, not only
  // its job's (contract §3.3 reachability).
  const unreachable = reachability(jobs, owner, step ?? target);
  if (unreachable) return { reason: unreachable, command: '' };
  const command = target ? stepCommand(target) : '';
  const analysis = analyseCommand(command, ctx.pkg);
  const work = classifyWork(analysis, analysis.args, ctx.workOptions?.(analysis) ?? {});
  if (work.status === 'FAIL') return { reason: work.why, command };
  for (const [scope, value] of [
    ['step', target ? target.continueOnError : null],
    ['job', owner ? owner.continueOnError : null],
  ]) {
    const coe = continueOnErrorVerdict(value);
    if (!coe) continue;
    return {
      reason:
        coe.status === 'UNKNOWN'
          ? `\`continue-on-error: ${coe.text}\` on the ${scope} is expression-valued — ` +
            'whether a failure can surface cannot be established'
          : `\`continue-on-error: true\` on the ${scope} swallows the result — the check ` +
            'runs and can never turn anything red',
      command,
    };
  }
  const signal = signalVerdict(ctx, command, {
    needle,
    ci: true,
    shell: target ? stepShell(target) : null,
  });
  if (signal.status !== 'PASS') {
    return { reason: `the declared check ${signalPhrase(signal.status)} — ${signal.why}`, command };
  }
  return { reason: runMatchReason(command, needle), command };
}

// ---------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------

function parseArgs(argv) {
  let root = process.cwd();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') {
      const value = argv[i + 1];
      if (!value) usageError('--root needs a directory', USAGE);
      root = resolve(value);
      i++;
    } else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else {
      usageError(`unknown argument ${JSON.stringify(argv[i])}`, USAGE);
    }
  }
  return root;
}

function readJson(path, what) {
  // The runtimes' own I/O and JSON-parse messages differ word for word, so neither is quoted:
  // this artifact is one contract in two languages, and a diverging error message on a path as
  // ordinary as "the manifest is missing" would make that claim false.
  if (!existsSync(path)) usageError(`${what} does not exist`);
  let text;
  try {
    text = readText(path);
  } catch {
    usageError(`${what} cannot be read`);
  }
  try {
    return JSON.parse(text);
  } catch {
    usageError(
      `${what} is not valid JSON`,
      'a JSON formatter will point at the offending position',
    );
  }
}

/** Every declaration is validated before anything is resolved: a bad manifest is exit 2. */
function validate(checks) {
  const seen = new Set();
  for (const check of checks) {
    if (!check || typeof check !== 'object' || Array.isArray(check)) {
      usageError(`${MANIFEST_REL}: every projectChecks entry must be an object`);
    }
    const { name, tiers, run } = check;
    if (typeof name !== 'string' || !NAME_RX.test(name)) {
      usageError(
        `${MANIFEST_REL}: projectChecks name ${JSON.stringify(name)} is invalid`,
        'names match ^[A-Za-z0-9._-]+$ (contract §2.3)',
      );
    }
    if (seen.has(name)) usageError(`${MANIFEST_REL}: duplicate projectChecks name "${name}"`);
    seen.add(name);
    if (MANAGED_NAMES.has(name)) {
      usageError(
        `${MANIFEST_REL}: projectChecks name "${name}" is a MANAGED name (contract §2.4)`,
        'a project-owned check may never reuse one — it would resolve against the managed job',
        "and report a control as present while the project's own check is gone",
      );
    }
    if (!Array.isArray(tiers) || !tiers.length || tiers.some((t) => !TIERS.includes(t))) {
      usageError(
        `${MANIFEST_REL}: projectChecks "${name}" tiers ${JSON.stringify(tiers)} is invalid`,
        `each tier is one of ${TIERS.join(', ')} and the array is non-empty (contract §2.3)`,
      );
    }
    if (typeof run !== 'string' || !run.trim()) {
      usageError(
        `${MANIFEST_REL}: projectChecks "${name}" has no \`run\` (contract §2.3, spec §5 R-C5)`,
        `name-only protection is not protection: a job named "${name}" running \`exit 0\``,
        'satisfies the name and checks nothing — record the command substring that must execute',
      );
    }
  }
}

function main(argv) {
  const root = parseArgs(argv);
  if (!existsSync(root)) usageError(`--root ${root} does not exist`, USAGE);
  const manifest = readJson(join(root, MANIFEST_REL), MANIFEST_REL);
  const checks = manifest?.projectChecks;
  if (!Array.isArray(checks)) {
    usageError(
      `${MANIFEST_REL}: projectChecks is REQUIRED (contract §2.3) and is ${
        checks === undefined ? 'absent' : 'not an array'
      }`,
      'an EMPTY array is the explicit "this project declares no checks of its own";',
      'an absent key is not the same statement and is never read as one',
    );
  }
  validate(checks);
  if (!checks.length) {
    console.log(
      `project-checks: none declared — ${MANIFEST_REL} projectChecks is an empty array, ` +
        'the explicit statement that this project owns no checks (never "none detected")',
    );
    return 0;
  }

  const tiersUsed = new Set(checks.flatMap((c) => c.tiers));
  const pkgPath = join(root, 'package.json');
  const pkg = existsSync(pkgPath) ? readJson(pkgPath, 'package.json') : null;
  // The reader's context: `root` so an indirection whose body is IN THE REPOSITORY (a Makefile
  // target, a project shell script) can be followed, `pkg` so an `npm run <script>` can be.
  const ctx = { root, pkg };
  // The same pinned-config lookup the checker injects (lib/tool-configs.mjs).
  ctx.workOptions = (analysis, tool) => {
    const configFile = pinnedConfigFor(root, tool ?? analysis.tool);
    return configFile ? { configFile } : {};
  };

  const hookJobs = [...tiersUsed].some((t) => HOOK_TIERS.includes(t)) ? mergedHookJobs(root) : [];

  let workflowJobs = [];
  let workflowPath = '';
  if (tiersUsed.has('ci')) {
    workflowPath = manifest?.ci?.workflow;
    if (typeof workflowPath !== 'string' || !workflowPath) {
      usageError(`${MANIFEST_REL}: ci.workflow is required to resolve a \`ci\` project check`);
    }
    const abs = resolve(root, workflowPath);
    if (abs !== root && !abs.startsWith(root + sep)) {
      usageError(`${MANIFEST_REL}: ci.workflow ${workflowPath} points outside the project`);
    }
    if (!existsSync(abs)) usageError(`${workflowPath}: the CI workflow does not exist`);
    try {
      workflowJobs = scanWorkflow(readText(abs));
    } catch (e) {
      if (!(e instanceof ScanError)) throw e;
      usageError(
        `${workflowPath}: ${e.message}`,
        'this assertion reads the workflow with a deliberately minimal scanner and refuses to',
        'guess — simplify the construct above, or resolve the check by hand and re-run',
      );
    }
  }

  const satisfied = [];
  const failures = [];
  for (const { name, tiers, run } of checks) {
    for (const tier of tiers) {
      const result =
        tier === 'ci'
          ? resolveCiTier(ctx, workflowJobs, workflowPath, name, run)
          : resolveHookTier(ctx, hookJobs, name, tier, run);
      if (result.reason) failures.push(`${name}@${tier}: ${result.reason}`);
      else
        satisfied.push(
          `  ok  ${name}@${tier}: \`${run}\` runs in \`${firstLine(result.command).trim()}\``,
        );
    }
  }
  for (const line of satisfied) console.log(line);
  if (failures.length) {
    console.error('project-checks: declared checks not satisfied:');
    for (const line of failures) console.error(`  - ${line}`);
    console.error(
      'a regeneration or an edit dropped or neutered them — restore the job/step, or update',
    );
    console.error(`${MANIFEST_REL} projectChecks[] through a reviewed change (contract §1/§2.3)`);
    return 1;
  }
  console.log(`project-checks: ${checks.length} declared, all satisfied`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
