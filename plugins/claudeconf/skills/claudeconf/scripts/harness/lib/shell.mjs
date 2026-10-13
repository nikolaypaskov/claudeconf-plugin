// shell.mjs — the ONE shell reader shared by the bundled checker and the vendored
// support scripts (PLAN.md AD4). It answers two questions about a hook or CI command, statically:
// which TOOL does it invoke, and does a failure of that tool reach the command's exit status?
//
// No policy. The only files it reads are the ones a command itself names — a `make` target's
// Makefile, a project shell script — relative to `ctx.root`. Callers pass a context object
// carrying `root`, `pkg` (the parsed package.json, for `npm run <script>` resolution) and,
// optionally, `workOptions(analysis)` returning `{ configFile }` when the caller knows a pinned
// config drives the tool.
// Moved verbatim from claudeconf-check.mjs; behaviour is pinned by the checker's test suite and a
// before/after verdict diff over the exemplars, this repository and six consumer repositories.

import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

/** Reads a file as UTF-8; never throws — `{ text: null, error }` when it cannot be read. */
export function safeRead(path) {
  try {
    return { text: readFileSync(path, 'utf8'), error: null };
  } catch (e) {
    return { text: null, error: e.message };
  }
}

/** Normalises a name for tolerant comparison: lowercase, alphanumerics only. */
export function norm(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/** Strips a trailing ` # comment` that is not inside quotes. */
export function stripComment(cmd) {
  const s = String(cmd ?? '');
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) {
      return s.slice(0, i).trimEnd();
    }
  }
  return s;
}

/**
 * A command's EXECUTABLE text: every line stripped of its shell comment.
 *
 * This is the ONE way command text is prepared for matching anywhere in this file. Matching a
 * raw `run:` block lets a comment answer for the command — `# runs tsc under the hood` beside
 * `true` reads as a typecheck — and that is a class of bug, not a site: every tool-token
 * search, every fetch/install/package-runner scan, and the command analyser all route here.
 * The single deliberate exception is D5, which reconciles VERSION CLAIMS and therefore MUST
 * read comments (a stale `# 1.27.0` beside a digest is exactly the drift it exists to catch).
 */
export function executableText(command) {
  return String(command ?? '')
    .split('\n')
    .map(stripComment)
    .join('\n');
}

/** Splits a shell command into whitespace-delimited tokens, honouring simple quoting. */
export function tokenize(cmd) {
  const tokens = [];
  let current = '';
  let quote = null;
  for (const c of String(cmd ?? '')) {
    if (quote) {
      if (c === quote) quote = null;
      else current += c;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (/\s/.test(c)) {
      if (current) tokens.push(current);
      current = '';
    } else {
      current += c;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

/** The command's leading segment, with any `&&`/`||`/`;` continuation removed. */
export function primarySegment(cmd) {
  const line =
    executableText(cmd)
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean) ?? '';
  const segments = line.split(/\s*(?:&&|\|\||;)\s*/).filter((seg) => seg.trim());
  return segments[0] ?? '';
}

export function firstLine(s) {
  return String(s ?? '').split('\n')[0];
}

export function escapeRx(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------------------
// Command analysis — which TOOL does a command invoke, and does it do work?
// ---------------------------------------------------------------------------------------

export const SCRIPT_RUNNERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
/**
 * Runners whose first argument NAMES A TASK rather than a target (contract §3.3). `npm test`,
 * `make lint` and `cargo test` all carry their operation in the task definition, so they are not
 * bare invocations — three of the four shipped fixtures failed their own arbiter's default run
 * because this rule read them as "no operational argument".
 */
export const TASK_RUNNERS = new Set([
  'npm',
  'pnpm',
  'yarn',
  'bun',
  'make',
  'cargo',
  'go',
  'mix',
  'rake',
  'just',
  'task',
  'gradle',
  'mvn',
  'dotnet',
  'poetry',
  'uv',
  'tox',
  'nox',
  'hatch',
  'pdm',
  'composer',
  'swift',
]);
/**
 * Wrappers that run another command and report ITS status. `xargs <tool>` is the shape that
 * matters: the reader saw `xargs` as the tool, lost the identity, and then classified the whole
 * pipeline by its head (`echo`) as a no-op — a FAIL on a command the runner exits 1 on.
 */
export const PREFIX_DROP = new Set([
  'sudo',
  'command',
  'env',
  'time',
  'exec',
  '!',
  'xargs',
  'nice',
  'nohup',
  'stdbuf',
]);

/**
 * Reduces a command to `{ tool, candidates, args }`: strips env assignments and wrapper
 * prefixes, resolves `npm run <script>` through package.json, unwraps `python -m <mod>`, and
 * reduces a path to its basename.
 */
export function analyseCommand(cmd, pkg, depth = 0) {
  const segment = primarySegment(cmd);
  let tokens = tokenize(segment);
  while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens = tokens.slice(1);
  while (tokens.length && PREFIX_DROP.has(tokens[0])) tokens = tokens.slice(1);
  // On-demand package runners are their own finding (W13/W15); for tool identity, unwrap them.
  if (tokens[0] === 'npx' || tokens[0] === 'uvx' || tokens[0] === 'pipx') {
    tokens = tokens.slice(1);
    if (tokens[0] === 'run') tokens = tokens.slice(1);
    while (tokens.length && tokens[0].startsWith('-')) tokens = tokens.slice(1);
  } else if ((tokens[0] === 'uv' || tokens[0] === 'poetry') && tokens[1] === 'run') {
    tokens = tokens.slice(2);
  } else if (tokens[0] === 'npm' && tokens[1] === 'exec') {
    tokens = tokens.slice(2);
    while (tokens.length && (tokens[0].startsWith('-') || tokens[0] === '--')) {
      tokens = tokens.slice(1);
    }
  }
  // The bundle's tree scanner (`scan-tree.mjs`, contract §2.5 / AD10) runs the scanner after
  // `--` over the candidate tree and exits with ITS status: for identity, the scanner is the tool.
  if (tokens[0] === 'node' && /(^|\/)scan-tree\.mjs$/.test(tokens[1] ?? '')) {
    const sep = tokens.indexOf('--');
    if (sep !== -1 && sep + 1 < tokens.length) tokens = tokens.slice(sep + 1);
  }
  if (!tokens.length) return { tool: '', candidates: [], args: [], raw: segment };

  let head = tokens[0];
  let args = tokens.slice(1);

  // `npm run <script>` / `npm test` — resolve through package.json scripts.
  if (SCRIPT_RUNNERS.has(head) && pkg?.scripts && depth < 3) {
    let script = null;
    if (args[0] === 'run' || args[0] === 'run-script') script = args[1];
    else if (args[0] && !args[0].startsWith('-') && pkg.scripts[args[0]]) script = args[0];
    if (script && typeof pkg.scripts[script] === 'string') {
      const inner = analyseCommand(pkg.scripts[script], pkg, depth + 1);
      if (inner.tool)
        return { ...inner, raw: segment, resolvedFrom: script, task: `the script \`${script}\`` };
    }
  }

  if (head.includes('/')) head = basename(head);

  let viaTask = null;
  if (/^python[0-9.]*$/.test(head) && args[0] === '-m' && args[1]) {
    viaTask = `the module \`${args[1]}\``;
    head = args[1];
    args = args.slice(2);
  }
  if (TASK_RUNNERS.has(head) && args[0] && !args[0].startsWith('-')) {
    viaTask = `the task \`${args[0]}\``;
  }

  const candidates = [norm(head)];
  const task = viaTask;
  if (args[0]) candidates.push(norm(head + args[0]));
  if (args[1]) candidates.push(norm(head + args[0] + args[1]));
  return { tool: head, candidates, args, raw: segment, task };
}

/**
 * The commands an indirection actually runs, when its definition lives in this repository.
 *
 * Closing `xargs`, `cd &&` and `time` one at a time was the shape-by-shape mistake; the class is
 * "the command names something whose body is in the tree". That is: an npm/pnpm/yarn script
 * (resolved in `analyseCommand`), a project script file, and a `make` target. Following them
 * keeps the indirection from being either a blind spot for identity or a hiding place for a
 * swallow — a `Makefile` target of `true` fails exactly as a bare `true` does.
 */
export function resolveIndirection(ctx, command) {
  const analysis = analyseCommand(command, ctx.pkg);
  if (analysis.resolvedFrom) return null; // already resolved by the script resolver
  const tokens = tokenize(primarySegment(command));
  const head = tokens[0] ?? '';
  if (head === 'make' && tokens[1] && !tokens[1].startsWith('-')) {
    for (const name of ['Makefile', 'makefile', 'GNUmakefile']) {
      const read = safeRead(join(ctx.root, name));
      if (read.text === null) continue;
      const rx = new RegExp(`^${escapeRx(tokens[1])}\\s*:[^=\\n]*\\n((?:\\t[^\\n]*\\n?)+)`, 'm');
      const found = rx.exec(read.text);
      if (found) {
        return {
          source: `${name} target \`${tokens[1]}\``,
          commands: found[1]
            .split('\n')
            .map((l) => l.replace(/^\t[-@+]*/, '').trim())
            .filter(Boolean),
        };
      }
    }
    return null;
  }
  if (/^[.\w][\w./-]*\.(sh|bash|mjs|js|cjs|py)$/.test(head) || head.startsWith('./')) {
    const rel = head.replace(/^\.\//, '');
    const read = safeRead(join(ctx.root, rel));
    if (read.text === null) return null;
    if (/\.(mjs|js|cjs|py)$/.test(rel)) return null; // not a shell script; its body is not shell
    // The FULL text, not the live-line view: propagation needs the control flow an early
    // `exit 1` lives in, and the pin scanner's view deliberately drops exactly that.
    return { source: rel, commands: [read.text] };
  }
  return null;
}

/** Matches a manifest tool name against a command's candidate tokens. */
export function commandMatchesTool(analysis, tool) {
  return analysis.candidates.includes(norm(tool));
}

/** The arguments left after the matched tool's own tokens. */
export function operationalArgs(analysis, tool) {
  const index = analysis.candidates.indexOf(norm(tool));
  if (index <= 0) return analysis.args;
  return analysis.args.slice(index);
}

export const NO_OP_HEADS = new Set(['true', ':', 'echo', 'printf', 'exit']);
export const PROBE_FLAGS = new Set(['--version', '-V', '--help', '-h', 'version', '--usage']);

/**
 * Classifies a command's usefulness (spec §5 R-C3): FAIL for a no-op or a pure version/help
 * probe, PASS when it carries an operational argument, UNKNOWN otherwise.
 */

/**
 * Classifies a command's usefulness (spec §5 R-C3 + controller ruling): FAIL for a no-op or
 * for a command carrying a version/help probe flag AT ALL (a config cannot launder
 * `--version`); PASS when it carries an operational argument OR when the tool's PINNED CONFIG
 * carries the operation (`tsup`, `mypy`, `vitest` are config-driven by design and A12 has
 * already verified that config exists); UNKNOWN otherwise.
 */
export function classifyWork(analysis, args, opts = {}) {
  if (!analysis.tool) return { status: 'FAIL', why: 'empty command' };
  if (NO_OP_HEADS.has(analysis.tool)) {
    return { status: 'FAIL', why: `no-op command \`${analysis.raw}\`` };
  }
  if (args.some((a) => PROBE_FLAGS.has(a))) {
    return { status: 'FAIL', why: `version/help probe \`${analysis.raw}\` demonstrates nothing` };
  }
  if (args.length) return { status: 'PASS', why: analysis.raw };
  if (opts.configFile) {
    return { status: 'PASS', why: `\`${analysis.raw}\` is config-driven by ${opts.configFile}` };
  }
  // A command may name a TARGET or a TASK. The operation lives in the task definition, which is
  // resolved and judged where it can be (an npm script of `true` fails exactly as a bare `true`
  // would, via the resolution in `analyseCommand`) and accepted where it cannot — indirection is
  // not a defect. Only a command naming neither is unverifiable.
  if (analysis.task) {
    return { status: 'PASS', why: `\`${analysis.raw}\` names ${analysis.task}` };
  }
  return {
    status: 'UNKNOWN',
    why:
      `\`${analysis.raw}\` names neither a target nor a task, so what it operates on cannot ` +
      `be established`,
  };
}

/** Splits a command on a top-level separator, honouring quotes. */
export function splitTopLevel(command, separator) {
  const out = [];
  let current = '';
  let quote = null;
  // A separator inside a `( … )` subshell or a `{ … }` group is not top level: splitting there
  // tore `cmd || { echo failed; exit 1; }` into fragments whose `}` then read as unbalanced.
  // Depth never goes negative, so a stray `)` (as in a `case` pattern) cannot hide a separator.
  let depth = 0;
  const text = String(command ?? '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (quote === '"' && c === '\\') {
        current += c + (text[++i] ?? '');
        continue;
      }
      if (c === quote) quote = null;
      current += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      current += c;
      continue;
    }
    if (c === '(' || c === '{') depth++;
    else if (c === ')' || c === '}') depth = Math.max(0, depth - 1);
    if (depth === 0 && text.startsWith(separator, i)) {
      out.push(current);
      current = '';
      i += separator.length - 1;
      continue;
    }
    current += c;
  }
  out.push(current);
  return out.filter((part) => part.trim());
}

/**
 * W20 — can this command still turn a tier RED?
 *
 * A shell script's exit status is the status of its LAST statement, so that is what decides:
 * the last executable line, its last `;`-separated statement, and that statement's last `||`
 * alternative. The alternative is judged by the SAME classifier W17 uses (a second classifier
 * would drift from the first), so `|| true`, `|| :`, `|| echo skipped` and a trailing
 * `; exit 0` all read as a forced success. `|| exit 1` is not: it fails loudly on purpose.
 */

/**
 * ---------------------------------------------------------------------------------------
 * Shell propagation analysis (contract §3.3, W20)
 * ---------------------------------------------------------------------------------------
 *
 * The question is POSITIVE: is there a demonstrable path by which the invoked tool's non-zero
 * exit becomes the whole command's non-zero exit? It is NOT "does this command match a known
 * way of discarding a status" — that list was written twice and was one shape short both times.
 *
 * Two rules govern the answer, and both are the contract's:
 *
 *   Unresolvability is a FLOOR, never a ceiling. The strongest DEMONSTRATED verdict wins; a
 *   command that demonstrably discards its status does not become unresolved because it also
 *   contains a construct this reader cannot parse. Otherwise one `$( )` beside a swallow
 *   launders a FAIL and the safety valve becomes the bypass.
 *
 *   Getting it wrong in the strict direction is not "safe". It rejects a working harness and
 *   sends its owner looking for a suppression, so every idiom a real harness uses —
 *   `set -euo pipefail` then a guard block, `exit $?`, `cd dir && tool`, `cmd | xargs tool`,
 *   `time tool` — has to be READ rather than refused.
 */

/** Thrown internally when the reader will not guess; callers turn it into UNRESOLVED. */
export class Unresolved extends Error {}

export const BLOCK_OPENERS = new Set(['if', 'while', 'until', 'for']);
export const BLOCK_KEYWORDS = new Set([
  'if',
  'elif',
  'else',
  'then',
  'fi',
  'while',
  'until',
  'for',
  'do',
  'done',
  'case',
  'esac',
  'select',
  'function',
  'coproc',
  '{',
  '}',
]);

/**
 * Constructs whose STRUCTURE this reader will not interpret. They are collapsed into one opaque
 * STATEMENT rather than making the whole command unreadable: a construct it cannot read still
 * occupies a position, and position is most of what propagation is about. Refusing the command
 * instead is what let one `case` — or one unbalanced `function` — launder a swallow three lines
 * away from it.
 */
export const OPAQUE_BLOCKS = [
  { open: /^case\b/, close: /^esac\b/, why: 'a `case` statement' },
  { open: /^select\b/, close: /^done\b/, why: 'a `select` loop' },
  { open: /^coproc\b/, close: /^\}$/, why: 'a `coproc`' },
  { open: /^function\b/, close: /^\}$/, why: 'a function definition' },
  { open: /^[A-Za-z_][A-Za-z0-9_]*\s*\(\s*\)\s*\{?/, close: /^\}$/, why: 'a function definition' },
];

/** The first word of a statement, lowercased — its keyword when it has one. */
export function leadingKeyword(text) {
  const trimmed = String(text).trim();
  if (trimmed === '{' || trimmed === '}') return trimmed;
  const word = trimmed.split(/\s+/)[0] ?? '';
  return BLOCK_KEYWORDS.has(word) ? word : '';
}

/**
 * Joins backslash line continuations. A wrapped tool invocation is the commonest reason a
 * `run:` is multi-line at all, and splitting on the newline made the argument line "decide the
 * exit status" — a hard FAIL, at every profile, on a command the runner exits 1 on.
 */
export function joinContinuations(text) {
  return String(text ?? '').replace(/\\\n\s*/g, ' ');
}

/**
 * Masks `$( … )` and backquoted substitutions with an opaque VALUE token. A substitution is an
 * expression inside a statement, never structure, so masking it keeps the command's shape
 * readable while admitting that the value is unknown. Treating it as unreadable STRUCTURE is
 * what made one `$(date)` launder a demonstrated swallow.
 */
export function maskSubstitutions(text) {
  let out = '';
  const src = String(text ?? '');
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '`') {
      const end = src.indexOf('`', i + 1);
      out += '__SUBST__';
      i = end === -1 ? src.length : end;
      continue;
    }
    if (src[i] === '$' && src[i + 1] === '(') {
      let depth = 0;
      let j = i + 1;
      for (; j < src.length; j++) {
        if (src[j] === '(') depth++;
        else if (src[j] === ')') {
          depth--;
          if (depth === 0) break;
        }
      }
      out += '__SUBST__';
      i = j;
      continue;
    }
    out += src[i];
  }
  return out;
}

/**
 * Removes here-document BODIES, which are data rather than statements. An UNTERMINATED here-doc
 * swallows the rest of the text, so everything from it onward becomes one opaque statement
 * rather than an unreadable command.
 */
export function stripHeredocs(text) {
  const lines = String(text ?? '').split('\n');
  const out = [];
  let delimiter = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (delimiter !== null) {
      if (line.trim() === delimiter) delimiter = null;
      continue;
    }
    const open = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line);
    if (open) {
      delimiter = open[2];
      out.push(line.replace(/<<-?\s*(['"]?)[A-Za-z_][A-Za-z0-9_]*\1/, '').trimEnd());
      continue;
    }
    out.push(line);
  }
  if (delimiter !== null) {
    return { text: out.join('\n'), unterminated: 'an unterminated here-document' };
  }
  return { text: out.join('\n'), unterminated: null };
}

/**
 * Splits on a top-level `&` used as a STATEMENT SEPARATOR — never on `&&`, `|&`, `2>&1` or `&>`.
 */
export function splitBackgrounded(text) {
  const masked = stripQuotedRegions(String(text));
  const out = [];
  let start = 0;
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] !== '&') continue;
    if (masked[i + 1] === '&' || masked[i - 1] === '&') {
      i++;
      continue;
    }
    if (masked[i - 1] === '>' || masked[i - 1] === '<' || masked[i + 1] === '>') continue;
    if (masked[i - 1] === '|') continue; // `|&` is a pipeline operator, not backgrounding
    out.push({ text: text.slice(start, i).trim(), backgrounded: true });
    start = i + 1;
  }
  const rest = text.slice(start).trim();
  if (rest) out.push({ text: rest, backgrounded: false });
  return out.filter((part) => part.text);
}

/**
 * Splits a command into fragments — newline, `;` and `&` separated — and strips a leading
 * `then`/`do`/`else` off each, so `do if [ -f x ]` is recognised as the block opener it is.
 * A `{` or `}` that opens or closes a multi-line group becomes its own fragment.
 */
export function fragmentsOf(text) {
  const out = [];
  const push = (raw, backgrounded) => {
    let value = raw.trim();
    if (!value) return;
    let keyword = leadingKeyword(value);
    while (keyword === 'then' || keyword === 'do' || keyword === 'else') {
      const rest = value.slice(keyword.length).trim();
      out.push({ text: keyword, keyword, backgrounded: false });
      if (!rest) return;
      value = rest;
      keyword = leadingKeyword(value);
    }
    // A group that OPENS on this fragment but does not close on it (`{ npx biome lint .`).
    if ((value.startsWith('{') || value.startsWith('(')) && !balancedWrapper(value)) {
      const bracket = value[0];
      out.push({ text: bracket, keyword: bracket === '{' ? '{' : '(', backgrounded: false });
      const rest = value.slice(1).trim();
      if (rest) push(rest, backgrounded);
      return;
    }
    if ((value === '}' || value === ')') && true) {
      out.push({ text: value, keyword: value, backgrounded: false });
      return;
    }
    out.push({ text: value, keyword: leadingKeyword(value), backgrounded });
  };
  for (const line of text.split('\n')) {
    for (const piece of splitTopLevel(line, ';')) {
      for (const part of splitBackgrounded(piece)) push(part.text, part.backgrounded);
    }
  }
  return out;
}

/** Collapses each OPAQUE construct into a single opaque statement fragment. */
export function collapseOpaque(frags) {
  const out = [];
  for (let i = 0; i < frags.length; i++) {
    const frag = frags[i];
    const rule = OPAQUE_BLOCKS.find((r) => r.open.test(frag.text.trim()));
    if (!rule) {
      out.push(frag);
      continue;
    }
    let j = i;
    const balanced =
      (frag.text.match(/\{/g) ?? []).length === (frag.text.match(/\}/g) ?? []).length;
    // The `balanced` shortcut is for a definition written on ONE fragment (`f() { …; }`); a
    // `case` has no braces at all, so applying it there left `esac` stranded.
    if (rule.close && !(balanced && /\{/.test(frag.text))) {
      j++;
      while (j < frags.length && !rule.close.test(frags[j].text.trim())) j++;
      if (j >= frags.length) j = frags.length - 1; // never terminated: it swallows the rest
    } else if (!rule.close) {
      // No terminator this reader can recognise: the construct swallows the rest of the text.
      j = frags.length - 1;
    }
    out.push({
      text: frags
        .slice(i, j + 1)
        .map((f) => f.text)
        .join('; '),
      keyword: '',
      backgrounded: false,
      opaque: rule.why,
    });
    i = j;
  }
  return out;
}

/** Parses fragments into a tree of `simple`, `if`, `loop` and `group` nodes. */
export function parseSequence(frags, state, stop) {
  const nodes = [];
  while (state.i < frags.length) {
    const frag = frags[state.i];
    if (stop.has(frag.keyword)) break;
    if (frag.keyword === 'if') {
      nodes.push(parseIf(frags, state));
      continue;
    }
    if (BLOCK_OPENERS.has(frag.keyword)) {
      nodes.push(parseLoop(frags, state));
      continue;
    }
    if (frag.keyword === '{' || frag.keyword === '(') {
      nodes.push(parseGroup(frags, state));
      continue;
    }
    if (frag.keyword) throw new Unresolved(`unbalanced \`${frag.keyword}\``);
    nodes.push(simpleNode(frag));
    state.i++;
  }
  return nodes;
}

/** A `{ … }` or `( … )` group spanning several fragments. */
export function parseGroup(frags, state) {
  const open = frags[state.i].keyword;
  const close = open === '{' ? '}' : ')';
  state.i++;
  const body = parseSequence(frags, state, new Set([close]));
  expectKeyword(frags, state, close);
  return { type: 'group', body, text: `${open} … ${close}`, backgrounded: false };
}

/** A simple statement — unwrapped when it is wholly a subshell or brace group on one fragment. */
export function simpleNode(frag) {
  const text = frag.text.trim();
  if (frag.opaque) return { type: 'simple', text, opaque: frag.opaque, backgrounded: false };
  const wrapped = /^\((.*)\)$/s.exec(text) ?? /^\{(.*)\}$/s.exec(text);
  if (wrapped && balancedWrapper(text)) {
    const inner = wrapped[1].replace(/;\s*$/, '').trim();
    if (inner) {
      const innerFrags = collapseOpaque(fragmentsOf(inner));
      const state = { i: 0 };
      const nodes = parseSequence(innerFrags, state, new Set());
      if (state.i === innerFrags.length && nodes.length) {
        return { type: 'group', body: nodes, text, backgrounded: !!frag.backgrounded };
      }
    }
  }
  return { type: 'simple', text, backgrounded: !!frag.backgrounded };
}

/** True when the outermost bracket of `text` closes exactly at its end. */
export function balancedWrapper(text) {
  const masked = stripQuotedRegions(text);
  const open = masked[0];
  if (open !== '(' && open !== '{') return false;
  const close = open === '(' ? ')' : '}';
  let depth = 0;
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] === open) depth++;
    else if (masked[i] === close) {
      depth--;
      if (depth === 0) return i === masked.length - 1;
    }
  }
  return false;
}

export function parseIf(frags, state) {
  const head = frags[state.i].text.replace(/^if\b/, '').trim();
  state.i++;
  const cond = head ? [{ type: 'simple', text: head }] : [];
  cond.push(...parseSequence(frags, state, new Set(['then'])));
  expectKeyword(frags, state, 'then');
  const branches = [
    { kind: 'then', body: parseSequence(frags, state, new Set(['elif', 'else', 'fi'])) },
  ];
  while (frags[state.i]?.keyword === 'elif') {
    const elifHead = frags[state.i].text.replace(/^elif\b/, '').trim();
    state.i++;
    const elifCond = elifHead ? [{ type: 'simple', text: elifHead }] : [];
    elifCond.push(...parseSequence(frags, state, new Set(['then'])));
    expectKeyword(frags, state, 'then');
    branches.push({
      kind: 'elif',
      cond: elifCond,
      body: parseSequence(frags, state, new Set(['elif', 'else', 'fi'])),
    });
  }
  if (frags[state.i]?.keyword === 'else') {
    state.i++;
    branches.push({ kind: 'else', body: parseSequence(frags, state, new Set(['fi'])) });
  }
  expectKeyword(frags, state, 'fi');
  return { type: 'if', cond, branches };
}

export function parseLoop(frags, state) {
  const kind = frags[state.i].keyword;
  const head = frags[state.i].text.replace(/^(while|until|for)\b/, '').trim();
  state.i++;
  const cond = head ? [{ type: 'simple', text: head }] : [];
  cond.push(...parseSequence(frags, state, new Set(['do'])));
  expectKeyword(frags, state, 'do');
  const body = parseSequence(frags, state, new Set(['done']));
  expectKeyword(frags, state, 'done');
  // `for x in <non-empty literal list>` demonstrably executes its body; a `while`/`until`
  // condition does not, and this reader does not pretend otherwise.
  const list = /^\S+\s+in\s+(.+)$/.exec(head ?? '');
  const executes = kind === 'for' && !!list && !/\$|\*|\?/.test(list[1]) && !!list[1].trim();
  return { type: 'loop', kind, cond, body, executes };
}

export function expectKeyword(frags, state, keyword) {
  if (frags[state.i]?.keyword !== keyword) throw new Unresolved(`expected \`${keyword}\``);
  state.i++;
}

/**
 * Parses a whole command. Substitutions are masked as values, here-doc bodies dropped as data,
 * line continuations joined, and constructs whose structure this reader will not interpret
 * collapsed into single opaque statements — so `Unresolved` is now thrown only when the command
 * cannot be given a shape at all.
 */
export function parseCommand(command) {
  const heredoc = stripHeredocs(joinContinuations(executableText(command)));
  const text = maskSubstitutions(heredoc.text);
  let frags = collapseOpaque(fragmentsOf(text));
  if (heredoc.unterminated && frags.length) {
    frags = [
      ...frags.slice(0, -1),
      { ...frags[frags.length - 1], opaque: heredoc.unterminated, keyword: '' },
    ];
  }
  const state = { i: 0 };
  const nodes = parseSequence(frags, state, new Set());
  if (state.i !== frags.length) throw new Unresolved(`unbalanced \`${frags[state.i].keyword}\``);
  return nodes;
}

/**
 * The lines of a shell SCRIPT that are DEMONSTRABLY EXECUTED — an allowlist, for the same
 * reason `skip` and `exclude` are. A pin recorded anywhere else is not reconciled: enumerating
 * the constructs that do not run (`if false`, and then `while false`, `until true`, `for x in ;`,
 * a trailing `exit 0`, an uncalled function…) is a list that is always one shape short.
 *
 * Credited: a line at block depth zero, before any unconditional top-level `exit`, with
 * comments stripped, continuations joined and here-document bodies removed. Everything inside
 * any block — including a function body, which does not run where it is written — is not.
 */
export function liveScriptLines(text) {
  const heredoc = stripHeredocs(joinContinuations(executableText(text)));
  const OPENERS = ['if', 'while', 'until', 'for', 'case', 'select'];
  const CLOSERS = ['fi', 'done', 'esac'];
  const out = [];
  let depth = 0;
  let stopped = false;
  for (const raw of heredoc.text.split('\n')) {
    if (stopped) break;
    const atTopLevel = depth === 0;
    let closedHere = false;
    for (const piece of splitTopLevel(raw, ';')) {
      let statement = piece.trim();
      if (!statement) continue;
      let keyword = leadingKeyword(statement);
      while (keyword === 'then' || keyword === 'do' || keyword === 'else') {
        statement = statement.slice(keyword.length).trim();
        keyword = leadingKeyword(statement);
      }
      const word = statement.split(/\s+/)[0] ?? '';
      if (OPENERS.includes(word)) depth++;
      else if (CLOSERS.includes(word)) depth = Math.max(0, depth - 1);
      // A function body is delimited by braces, so counting the braces IS counting the
      // definition — incrementing for both left the depth stuck above zero and credited
      // nothing at all.
      const braces = (statement.match(/\{/g) ?? []).length - (statement.match(/\}/g) ?? []).length;
      if (braces > 0) depth += braces;
      else if (braces < 0) {
        depth = Math.max(0, depth + braces);
        closedHere = true;
      }
      if (depth === 0 && /^exit\b/.test(statement)) stopped = true;
    }
    if (atTopLevel && depth === 0 && !closedHere) out.push(raw);
  }
  return out.join('\n');
}

/** Is a simple statement's exit status statically NON-zero — a command that always fails? */
export function alwaysFails(ctx, text) {
  const analysis = analyseCommand(unwrapLast(text), ctx.pkg);
  if (analysis.tool === 'exit' || analysis.tool === 'return') {
    const code = analysis.args[0];
    return !!code && code !== '0' && !code.includes('$');
  }
  return analysis.tool === 'false';
}

/** Is a simple statement's exit status statically zero — a command that cannot fail? */
export function cannotFail(ctx, text) {
  const analysis = analyseCommand(unwrapLast(text), ctx.pkg);
  if (analysis.tool === 'exit') {
    const code = analysis.args[0];
    return !code || code === '0';
  }
  return (
    classifyWork(analysis, analysis.args, ctx.workOptions ? ctx.workOptions(analysis) : {})
      .status === 'FAIL'
  );
}

/** Does this statement PRESERVE a preceding status rather than replacing it? (`exit $?`) */
export function preservesStatus(text) {
  return /^exit\s+"?\$\{?\?\}?"?\s*$/.test(String(text).trim());
}

/**
 * The `||`/`&&` elements of a statement, in order. An operator nested inside a `( … )` or
 * `{ … }` belongs to that group, not to this list, so only depth-0 operators split.
 */
export function listElements(text) {
  const value = String(text);
  const masked = stripQuotedRegions(value);
  const out = [];
  let operator = null;
  let start = 0;
  let depth = 0;
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if (c === '(' || c === '{') depth++;
    else if (c === ')' || c === '}') depth = Math.max(0, depth - 1);
    if (depth !== 0) continue;
    const op = masked.startsWith('||', i) ? '||' : masked.startsWith('&&', i) ? '&&' : null;
    if (!op) continue;
    out.push({ operator, text: value.slice(start, i).trim() });
    operator = op;
    i++;
    start = i + 1;
  }
  out.push({ operator, text: value.slice(start).trim() });
  return out.filter((e) => e.text);
}

/**
 * A group's exit status is its LAST statement's, so `{ echo failed; exit 1; }` is judged by
 * `exit 1`. Without this, every predicate below read a whole group as one opaque word.
 */
export function unwrapLast(text) {
  let value = String(text).trim();
  for (let guard = 0; guard < 8; guard++) {
    if (!balancedWrapper(value)) return value;
    const inner = value.slice(1, -1).trim().replace(/;\s*$/, '').trim();
    const parts = inner.split('\n').flatMap((line) => splitTopLevel(line, ';'));
    const last = parts
      .map((part) => part.trim())
      .filter(Boolean)
      .pop();
    if (!last || last === value) return value;
    value = last;
  }
  return value;
}

/** The `|` elements of one list element, in order. */
export function pipelineElements(text) {
  // `a |& b` is `a 2>&1 | b`: a pipeline, so only the last element's status survives without
  // `pipefail`. Reporting it as backgrounding named the wrong mechanism and quoted a truncated
  // command, which an owner cannot act on.
  return splitTopLevel(String(text).replace(/\|&/g, '|'), '|')
    .map((part) => part.trim())
    .filter(Boolean);
}

/** Blanks out quoted spans so operator scanning never fires inside a string. */
export function stripQuotedRegions(text) {
  const chars = [...String(text)];
  for (const [start, end] of quotedRanges(String(text))) {
    for (let i = start; i < end && i < chars.length; i++) chars[i] = ' ';
  }
  return chars.join('');
}

export const SET_ERREXIT_ON = /^set\s+(-[a-zA-Z]*e[a-zA-Z]*(\s|$)|-o\s+errexit\b)/;
export const SET_ERREXIT_OFF = /^set\s+(\+[a-zA-Z]*e[a-zA-Z]*(\s|$)|\+o\s+errexit\b)/;
export const SET_PIPEFAIL_ON = /^set\s+[^\n]*-o\s+pipefail\b/;
export const SET_PIPEFAIL_OFF = /^set\s+[^\n]*\+o\s+pipefail\b/;

/** Does this statement install a trap that forces the exit status? */
export function trapVerdict(text) {
  const statement = String(text).trim();
  if (!/^trap\s/.test(statement) || !/\bEXIT\b/.test(statement)) return null;
  if (/exit\s+0|exit\s*['"]?\s*$/.test(statement)) {
    return { status: 'FAIL', why: `\`${statement}\` forces the exit status from an EXIT trap` };
  }
  return {
    status: 'UNRESOLVED',
    why: `\`${statement}\` installs an EXIT trap this checker cannot evaluate`,
  };
}

/**
 * Every simple statement of a tree in EXECUTION order, each with the block path that reaches
 * it. Used both to locate the tool and to compute shell state at that point — state has to be
 * global to the command, because an `if` body is a different sequence and an outer
 * `set -euo pipefail` (or an outer `set +e`) is invisible to a body-local scan. That single
 * omission produced a false FAIL on the guard-then-check idiom and a false PASS on CI at once.
 */
export function flatten(nodes, path = [], out = []) {
  for (const node of nodes) {
    if (node.type === 'simple') {
      out.push({ node, path });
      continue;
    }
    if (node.type === 'group') {
      flatten(node.body, [...path, { node, role: 'body', body: node.body }], out);
      continue;
    }
    if (node.type === 'if') {
      flatten(node.cond, [...path, { node, role: 'condition' }], out);
      for (const branch of node.branches) {
        if (branch.cond) flatten(branch.cond, [...path, { node, role: 'condition' }], out);
        flatten(branch.body, [...path, { node, role: 'body', body: branch.body }], out);
      }
      continue;
    }
    if (node.type === 'loop') {
      flatten(node.cond, [...path, { node, role: 'condition' }], out);
      flatten(node.body, [...path, { node, role: 'body', body: node.body }], out);
    }
  }
  return out;
}

/** Locates the tool inside a statement: which `||`/`&&` element and which pipeline element. */
export function locateInStatement(text, locate) {
  const elements = listElements(text);
  for (let e = 0; e < elements.length; e++) {
    const pipeline = pipelineElements(elements[e].text);
    for (let p = 0; p < pipeline.length; p++) {
      if (locate(pipeline[p])) return { elements, elementIndex: e, pipeline, pipeIndex: p };
      // `find … -exec <tool> {} +` runs the tool as its own argument list.
      const exec = /\s-(?:exec|execdir)\s+(.+?)(?:\s+[;+]|$)/.exec(pipeline[p]);
      if (exec && locate(exec[1])) return { elements, elementIndex: e, pipeline, pipeIndex: p };
    }
  }
  return null;
}

/**
 * W20's core. Returns PASS with the demonstrated path, FAIL with the discarding construct, or
 * UNRESOLVED with what could not be read.
 */
export function propagationVerdict(ctx, command, locate, opts = {}) {
  let nodes = null;
  let unreadable = null;
  try {
    nodes = parseCommand(command);
  } catch (e) {
    if (!(e instanceof Unresolved)) throw e;
    unreadable = e.message;
  }

  // FLOOR: a demonstrable swallow is reported even when the rest of the command is unreadable.
  if (!nodes) {
    const demonstrated = degradedSwallow(ctx, command, locate, opts);
    if (demonstrated) return demonstrated;
    return {
      status: 'UNRESOLVED',
      why: `the command contains ${unreadable}, which this checker will not interpret`,
    };
  }
  if (!nodes.length) return { status: 'UNRESOLVED', why: 'no command to judge' };

  const statements = flatten(nodes);
  const found = statements
    .map((entry) => ({ ...entry, hit: locateInStatement(entry.node.text, locate) }))
    .filter((entry) => entry.hit)
    .pop();

  if (!found) {
    // The tool could not be identified — `make lint`, `scripts/lint.sh`, a workspace filter,
    // an `-exec` form. Closing that shape by shape is the same mistake as listing swallows, so
    // it is closed as a CLASS: judge the statement that DOES decide the command's status. If
    // that path is intact the command can still report a failure, whatever it runs; if it
    // cannot fail, the command cannot either.
    // An indirection whose body is IN THE REPOSITORY is followed before giving up: the
    // swallow lives in the script or the make target as often as in the command that calls it.
    if ((opts.depth ?? 0) < 2) {
      for (const entry of statements) {
        const indirect = indirectPropagation(ctx, entry.node.text, locate, opts, opts.depth ?? 0);
        if (indirect) return indirect;
      }
    }
    const last = statements[statements.length - 1];
    if (!last) return { status: 'UNRESOLVED', why: 'no command to judge' };
    if (last.node.opaque) {
      return {
        status: 'UNRESOLVED',
        why: `the command ends in ${last.node.opaque}, which this checker will not interpret`,
      };
    }
    const tail = listElements(last.node.text).at(-1)?.text ?? last.node.text;
    if (cannotFail(ctx, tail)) {
      return {
        status: 'FAIL',
        why: `the command's last statement \`${last.node.text}\` cannot fail`,
      };
    }
    const tailHit = {
      node: last.node,
      hit: {
        elements: listElements(last.node.text),
        elementIndex: listElements(last.node.text).length - 1,
        pipeline: pipelineElements(tail),
        pipeIndex: pipelineElements(tail).length - 1,
      },
    };
    const tailOwn = statementPropagation(ctx, tailHit, opts);
    if (tailOwn.status !== 'PASS') return tailOwn;
    return {
      status: 'PASS',
      why:
        `the tool was not identifiable, but \`${last.node.text}\` decides the command's exit ` +
        `status and can fail`,
    };
  }
  if (found.node.opaque) {
    return {
      status: 'UNRESOLVED',
      why: `the tool runs inside ${found.node.opaque}, which this checker will not interpret`,
    };
  }

  // Shell state at the tool, from the statements that run BEFORE it — and only those. `found`
  // is a COPY of its `statements` entry (it carries the located `hit`), so an identity test
  // against the entry never held and the walk ran past the tool: a `set -e` written BELOW the
  // check was read as if it protected it, which is a false PASS (`bash -c 'false; set -e; echo
  // done'` exits 0), and a `set +e` below it cancelled CI errexit that had already aborted at
  // the failure, which is a false FAIL. The NODE is the identity the two share.
  let errexit = !!opts.errexit;
  let pipefail = !!opts.pipefail;
  for (const entry of statements) {
    if (entry.node === found.node) break;
    const text = entry.node.text.trim();
    if (SET_ERREXIT_ON.test(text)) errexit = true;
    else if (SET_ERREXIT_OFF.test(text)) errexit = false;
    if (SET_PIPEFAIL_OFF.test(text)) pipefail = false;
    else if (SET_PIPEFAIL_ON.test(text)) pipefail = true;
  }

  // An EXIT trap is the exception: it fires wherever it is installed, so the WHOLE command is
  // swept for one. (`bash -c 'false; trap "exit 0" EXIT; echo done'` exits 0.)
  for (const entry of statements) {
    const trap = trapVerdict(entry.node.text.trim());
    if (trap) return trap;
  }

  const own = statementPropagation(ctx, found, { ...opts, pipefail });
  if (own.status !== 'PASS') return own;
  const analysis0 = analyseCommand(found.hit.pipeline[found.hit.pipeIndex], ctx.pkg);

  // The resolved body of an `npm run <script>` indirection is part of the path: the swallow
  // frequently lives in package.json, which the outer text never shows.
  const indirect = indirectPropagation(
    ctx,
    found.hit.pipeline[found.hit.pipeIndex],
    (candidate) => commandMatchesTool(analyseCommand(candidate, ctx.pkg), analysis0.tool),
    opts,
    opts.depth ?? 0,
  );
  if (indirect && indirect.status !== 'PASS') return indirect;

  let current = found.node;
  for (const step of [...found.path].reverse()) {
    if (step.role === 'condition') {
      const kind = step.node.type === 'loop' ? step.node.kind : 'if';
      return {
        status: 'FAIL',
        why:
          `the tool runs as the \`${kind}\` CONDITION, so its status is consumed by the test ` +
          `and never becomes the command's`,
      };
    }
    if (step.node.type === 'loop' && !step.node.executes) {
      return {
        status: 'UNRESOLVED',
        why:
          `the tool runs inside a \`${step.node.kind}\` loop, whose body this checker cannot ` +
          `show executes`,
      };
    }
    const seq = sequencePropagation(step.body, current, errexit);
    if (seq.status !== 'PASS') return seq;
    current = step.node;
  }
  const top = sequencePropagation(nodes, current, errexit);
  if (top.status !== 'PASS') return top;
  return { status: 'PASS', why: `\`${found.node.text}\` decides the command's exit status` };
}

/**
 * A demonstrable swallow found WITHOUT a full parse, so an unreadable construct elsewhere in
 * the command cannot launder it (the contract's floor rule).
 */
export function degradedSwallow(ctx, command, locate, opts) {
  const text = maskSubstitutions(stripHeredocs(joinContinuations(executableText(command))).text);
  const statements = [];
  for (const line of text.split('\n')) {
    for (const piece of splitTopLevel(line, ';')) {
      for (const part of splitBackgrounded(piece)) statements.push(part);
    }
  }
  let errexit = !!opts.errexit;
  let index = -1;
  for (let i = 0; i < statements.length; i++) {
    const part = statements[i];
    const hit = locateInStatement(part.text, locate);
    if (hit) {
      index = i;
      const verdict = statementPropagation(
        ctx,
        { node: { text: part.text, backgrounded: part.backgrounded }, hit },
        opts,
      );
      if (verdict.status === 'FAIL') return verdict;
      break;
    }
    const trap = trapVerdict(part.text);
    if (trap && trap.status === 'FAIL') return trap;
    if (SET_ERREXIT_ON.test(part.text.trim())) errexit = true;
    else if (SET_ERREXIT_OFF.test(part.text.trim())) errexit = false;
  }
  // POSITION is demonstrable without a parse whenever the command has no block structure at
  // all: every fragment is then a top-level statement, and the last one decides the status.
  // Leaving this to the parse tree is what let one unreadable token launder the swallow class
  // the contract lists FIRST.
  const flat = statements.every((part) => !leadingKeyword(part.text));
  if (flat && index >= 0 && index < statements.length - 1 && !errexit) {
    const after = statements.slice(index + 1);
    if (!after.every((part) => preservesStatus(part.text))) {
      return {
        status: 'FAIL',
        why:
          `\`${statements[index].text}\` runs the check but ` +
          `\`${after[after.length - 1].text}\` decides the exit status, and errexit is not in ` +
          `effect — put the check last, add \`set -e\`, or end with \`exit $?\``,
      };
    }
  }
  return null;
}

/** Propagation WITHIN the statement that invokes the tool. */
export function statementPropagation(ctx, found, opts) {
  const { elements, elementIndex, pipeline, pipeIndex } = found.hit;
  const element = pipeline[pipeIndex];

  if (found.node.backgrounded) {
    return {
      status: 'FAIL',
      why:
        `\`${found.node.text}\` is backgrounded with \`&\`, so its status is never the ` +
        `command's`,
    };
  }
  if (/^!\s/.test(elements[elementIndex].text.trim())) {
    return {
      status: 'FAIL',
      why:
        `\`${elements[elementIndex].text.trim()}\` is NEGATED with \`!\`, which inverts the ` +
        `control rather than reporting it`,
    };
  }
  if (pipeline.length > 1 && pipeIndex !== pipeline.length - 1 && !opts.pipefail) {
    return {
      status: 'FAIL',
      why:
        `the tool is piped into \`${pipeline[pipeline.length - 1]}\` without \`pipefail\`, ` +
        `so only that command's status survives`,
    };
  }
  const trap = trapVerdict(element);
  if (trap) return trap;
  for (let i = elementIndex + 1; i < elements.length; i++) {
    if (elements[i].operator !== '||') continue;
    if (cannotFail(ctx, elements[i].text)) {
      return {
        status: 'FAIL',
        why: `a failure is rescued by \`|| ${elements[i].text}\`, which cannot fail`,
      };
    }
    if (alwaysFails(ctx, elements[i].text)) continue;
    return {
      status: 'UNRESOLVED',
      why:
        `a failure is rescued whenever \`${elements[i].text}\` succeeds, so the tool's ` +
        `status cannot be shown to reach the command's`,
    };
  }
  return { status: 'PASS', why: '' };
}

/** Follows an `npm run <script>` indirection into package.json and judges the script body. */
/**
 * Does the resolved body actually INVOKE what the locator is tracking? A mention is not enough:
 * `scripts/assert-tool-versions.sh` prints its own name in a success message, and judging a body
 * that only MENTIONS the tool treats the indirection's exit status as the tool's — which read a
 * script that exits 1 on mismatch as a swallow because it ends with a success message.
 */
export function bodyInvokes(body, locate) {
  let statements;
  try {
    statements = flatten(parseCommand(body)).map((entry) => entry.node.text);
  } catch (e) {
    if (!(e instanceof Unresolved)) throw e;
    statements = executableText(body)
      .split('\n')
      .flatMap((line) => splitTopLevel(line, ';'))
      .map((t) => t.trim())
      .filter(Boolean);
  }
  return statements.some((statement) => !!locateInStatement(statement, locate));
}

export function indirectPropagation(ctx, text, locate, opts, depth = 0) {
  if (depth > 2) return null;
  const analysis = analyseCommand(text, ctx.pkg);
  let source = null;
  let body = null;
  if (analysis.resolvedFrom && typeof ctx.pkg?.scripts?.[analysis.resolvedFrom] === 'string') {
    source = `the script \`${analysis.resolvedFrom}\` in package.json`;
    body = ctx.pkg.scripts[analysis.resolvedFrom];
  } else {
    const resolved = resolveIndirection(ctx, text);
    if (resolved?.commands.length) {
      source = resolved.source;
      body = resolved.commands.join('\n');
    }
  }
  if (!body?.trim()) return null;
  if (!bodyInvokes(body, locate)) return null;
  const inner = propagationVerdict(ctx, body, locate, {
    ...opts,
    errexit: false,
    pipefail: false,
    depth: depth + 1,
  });
  if (inner.status === 'PASS') return inner;
  const verb = inner.status === 'FAIL' ? 'discards it' : 'cannot be shown to propagate it';
  return {
    status: inner.status,
    why: `${source} ${verb}: ${inner.why}`,
  };
}

/** Propagation from one node to the END of the sequence that contains it. */
export function sequencePropagation(sequence, node, errexit) {
  const index = sequence.indexOf(node);
  if (index < 0)
    return { status: 'UNRESOLVED', why: 'the statement could not be placed in its command' };
  if (index === sequence.length - 1) return { status: 'PASS', why: '' };
  if (errexit) return { status: 'PASS', why: '' };
  const after = sequence.slice(index + 1);
  if (after.every((n) => n.type === 'simple' && preservesStatus(n.text))) {
    return { status: 'PASS', why: '' };
  }
  const trailing = after[after.length - 1];
  const trailingText =
    trailing.type === 'simple'
      ? trailing.opaque
        ? `${trailing.opaque} (\`${firstLine(trailing.text).trim()}\`)`
        : trailing.text
      : `a ${trailing.type} block`;
  const nodeText = node.type === 'simple' ? node.text : `the ${node.type} block`;
  return {
    status: 'FAIL',
    why:
      `\`${nodeText}\` runs the check but \`${trailingText}\` decides the exit status, and ` +
      `errexit is not in effect — put the check last, add \`set -e\`, or end with \`exit $?\``,
  };
}

/**
 * W20's entry point. `opts`: `{ tools, needle, ci, shell }` — `tools`/`needle` locate the
 * tool-bearing statement (the same matchers W17 and W12 use), `ci` selects the provider's
 * default shell semantics, `shell` is a declared shell.
 */
export function signalVerdict(ctx, command, opts = {}) {
  const { tools = [], needle = '' } = opts;
  const locate = (text) => {
    if (needle) return runContains(text, needle) === true;
    if (tools.length)
      return tools.some((t) => commandMatchesTool(analyseCommand(text, ctx.pkg), t));
    return false;
  };
  // GitHub Actions runs `run:` under `bash -e`, and `shell: bash` additionally adds `pipefail`.
  // A shell other than bash is a different interpreter with different flags, and this checker
  // does not guess at it.
  const errexit = !!opts.ci;
  let pipefail = false;
  if (opts.ci && opts.shell) {
    if (String(opts.shell).trim() === 'bash') pipefail = true;
    else {
      return {
        status: 'UNRESOLVED',
        why:
          `the step declares \`shell: ${opts.shell}\`, whose error handling this checker ` +
          `does not assume`,
      };
    }
  }
  return propagationVerdict(ctx, command, locate, { ...opts, errexit, pipefail });
}

/** Does this command invoke `tool` anywhere in an executed position? (W17's identity test.) */
export function commandInvokesTool(ctx, command, tool, depth = 0) {
  const locate = (text) => commandMatchesTool(analyseCommand(text, ctx.pkg), tool);
  let statements;
  try {
    statements = liveStatements(command).map((text) => ({ text }));
  } catch (e) {
    if (!(e instanceof Unresolved)) throw e;
    statements = executableText(command)
      .split('\n')
      .flatMap((line) => splitTopLevel(line, ';'))
      .map((text) => ({ text: text.trim() }))
      .filter((s) => s.text);
  }
  for (const statement of statements) {
    const hit = locateInStatement(statement.text, locate);
    if (hit) return hit.pipeline[hit.pipeIndex];
  }
  if (depth < 2) {
    for (const statement of statements) {
      const indirect = resolveIndirection(ctx, statement.text);
      if (!indirect) continue;
      for (const inner of indirect.commands) {
        const found = commandInvokesTool(ctx, inner, tool, depth + 1);
        if (found) return found;
      }
    }
  }
  return null;
}

/** `continue-on-error` on a step or its job: true swallows, an expression is unverifiable. */
export function continueOnErrorVerdict(value) {
  if (value === undefined || value === null || value === false) return null;
  const text = String(value);
  if (text.includes('${{')) return { status: 'UNKNOWN', text };
  if (value === true || /^(true|yes|on)$/i.test(text)) return { status: 'FAIL', text };
  return null;
}

/**
 * Is `needle` present in an EXECUTED position of `command`? Comments and statically dead
 * constructs do not count; a command that cannot be resolved statically returns null.
 */

/** Index ranges of `text` that sit inside a single- or double-quoted shell string. */
export function quotedRanges(text) {
  const ranges = [];
  let quote = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    // Inside double quotes a backslash escapes the next character; single quotes have no
    // escapes in POSIX shells. Getting this wrong would let an escaped quote end a string
    // early and report a QUOTED needle as executed.
    if (quote === '"' && c === '\\') {
      i++;
      continue;
    }
    if (quote) {
      if (c === quote) {
        ranges.push([start, i + 1]);
        quote = null;
      }
    } else if (c === '"' || c === "'") {
      quote = c;
      start = i;
    }
  }
  return ranges;
}

/**
 * Is `needle` present in an EXECUTED position of `command`? A match inside a comment or a
 * statically dead construct does not count, and a match that only ever appears inside a QUOTED
 * STRING (`echo "scripts/check.sh is disabled"`, `bash -c "…"`) is not shown to execute either:
 * that returns null (UNVERIFIED), which an enforcing run fails. Returns true / false / null.
 */

/**
 * The statements a command actually EXECUTES, decided by the parsed structure rather than by
 * counting keywords. A branch under a statically false condition is dropped; the `else` branch
 * of that same conditional is kept, because it is the one that runs. Throws `Unresolved` when
 * the structure cannot be read — the caller reports UNKNOWN rather than guessing which lines
 * execute, since in a report a guess is indistinguishable from a verified answer.
 */
export const STATICALLY_FALSE = /^(false|\[\s*0\s*-eq\s*1\s*\]|\[\[\s*0\s*-eq\s*1\s*\]\])\s*$/;

export function liveStatements(command) {
  const out = [];
  const walk = (nodes) => {
    for (const node of nodes) {
      if (node.type === 'simple') {
        out.push(node.text);
        continue;
      }
      if (node.type === 'if') {
        walk(node.cond);
        const condText = node.cond
          .map((n) => (n.type === 'simple' ? n.text : ''))
          .join(' ')
          .trim();
        const deadThen = STATICALLY_FALSE.test(condText);
        for (const branch of node.branches) {
          if (deadThen && branch.kind === 'then') continue;
          if (branch.cond) walk(branch.cond);
          walk(branch.body);
        }
        continue;
      }
      walk(node.cond ?? []);
      walk(node.body ?? []);
    }
  };
  walk(parseCommand(command));
  return out;
}

/**
 * Is `needle` present in an EXECUTED position of `command`? A match inside a comment or a
 * statically dead branch does not count, and a match that only ever appears inside a QUOTED
 * STRING (`echo "scripts/check.sh is disabled"`, `bash -c "…"`) is not shown to execute
 * either. Returns true / false / null, where null is UNVERIFIED and an enforcing run fails it.
 */
export function runContains(command, needle) {
  if (!needle) return false;
  const text = String(command ?? '');
  if (!text.trim()) return false;
  let joined;
  try {
    joined = liveStatements(text).join('\n');
  } catch (e) {
    if (e instanceof Unresolved) return null;
    throw e;
  }
  if (!joined.includes(needle)) {
    // The needle may still be present in text this reader dropped as dead; saying "absent"
    // is only honest when the whole command was readable, which it was.
    return false;
  }
  const quoted = quotedRanges(joined);
  let unquoted = false;
  for (let i = joined.indexOf(needle); i !== -1; i = joined.indexOf(needle, i + 1)) {
    const end = i + needle.length;
    if (!quoted.some(([a, b]) => i >= a && end <= b)) {
      unquoted = true;
      break;
    }
  }
  if (!unquoted) return null;
  return true;
}
