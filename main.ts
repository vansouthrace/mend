// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library alone;
// run it as `node main.ts [options] [PATCH]`.
//
// Sections 1 to 4, 9 and 10 of SPEC.md (command line, output and exit codes, safe paths,
// format detection, JSON edits, all-or-nothing write) plus sections 5 to 8 (three-tier
// line matching, unified diffs, SEARCH/REPLACE blocks, V4A patches) and the move rows
// of section 2.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this
// file hands over to runner.ts (the last lines below): keep that hand-over and runner.ts
// as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => { move?: [string, string] } | void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/* ------------------------------------------------------------------ */
/* Section 3: a file as lines, its line break, and its final break.   */
/* ------------------------------------------------------------------ */

interface FileLines {
  lines: string[];
  br: string;
  final: boolean;
}

function parseFile(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function renderFile(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/* ------------------------------------------------------------------ */
/* Section 5: matching lines at three tiers.                           */
/* ------------------------------------------------------------------ */

const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBothWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimBothWs(a) === trimBothWs(b);
}

/** Every position at or after `from` where O occurs in `file` at `tier`. */
function occurrences(file: string[], o: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = from; i + o.length <= file.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEq(file[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, 1, 2; only 0 when strict) at which O occurs at or after `from`. */
function firstTierOcc(file: string[], o: string[], strict: boolean, from = 0): { tier: number; occ: number[] } | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    const occ = occurrences(file, o, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One line of N: a context line (written as the file's own matched line) or a new line. */
interface NLine {
  text: string;
  ctx: boolean;
  oIdx: number;
}

/** Replace `oLen` lines at `at` with N. Context lines come from the file; at tier 2 the
 *  other lines are re-indented from O's first line's leading whitespace to the file's. */
function applyReplace(file: FileLines, at: number, oLen: number, n: NLine[], o: string[], tier: number): FileLines {
  const rep: string[] = [];
  for (const e of n) {
    if (e.ctx) {
      rep.push(file.lines[at + e.oIdx]!);
    } else {
      let t = e.text;
      if (tier === 2 && o.length > 0) {
        const f = leadWs(file.lines[at]!);
        const p = leadWs(o[0]!);
        if (t !== '' && t.trim() !== '' && t.startsWith(p)) t = f + t.slice(p.length);
      }
      rep.push(t);
    }
  }
  return { lines: [...file.lines.slice(0, at), ...rep, ...file.lines.slice(at + oLen)], br: file.br, final: file.final };
}

/* ------------------------------------------------------------------ */
/* Section 9: JSON edits (unchanged from the starter).                 */
/* ------------------------------------------------------------------ */

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Section 6: unified diffs.                                           */
/* ------------------------------------------------------------------ */

interface HunkBodyLine {
  kind: 'ctx' | 'old' | 'new' | 'bs';
  text: string;
  /** true when the patch line itself was empty (zero characters). */
  empty: boolean;
}

interface Hunk {
  a: number;
  body: HunkBodyLine[];
  /** a `\` line follows the hunk's last context or `+` line. */
  noNewline: boolean;
}

interface Section {
  /** null when the path is /dev/null; undefined until the section's paths resolve. */
  oldP: string | null | undefined;
  newP: string | null | undefined;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

const stripAB = (p: string): string => (p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p);

/** The path a `--- ` or `+++ ` line names, or null for /dev/null. */
function headerPath(line: string): string | null {
  const p = line.slice(4).split('\t')[0].trim();
  if (p === '/dev/null') return null;
  return stripAB(p);
}

function hunkON(hunk: Hunk): { o: string[]; n: NLine[] } {
  const o: string[] = [];
  const n: NLine[] = [];
  for (const e of hunk.body) {
    if (e.kind === 'ctx') {
      o.push(e.text);
      n.push({ text: e.text, ctx: true, oIdx: o.length - 1 });
    } else if (e.kind === 'old') {
      o.push(e.text);
    } else if (e.kind === 'new') {
      n.push({ text: e.text, ctx: false, oIdx: -1 });
    }
  }
  return { o, n };
}

/** Parse one section's header and hunks, starting at `start`; return the index after it. */
function parseSection(lines: string[], start: number, sec: Section): number {
  const n = lines.length;
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  let i = start;
  let inHeader = true;
  let hasPair = false;
  let renameFrom: string | undefined;
  let renameTo: string | undefined;
  const diffOld = sec.oldP;
  const diffNew = sec.newP;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) break;
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (inHeader && !hasPair) {
        sec.oldP = headerPath(line);
        sec.newP = headerPath(lines[i + 1]!);
        hasPair = true;
        i += 2;
        continue;
      }
      break;
    }
    if (line.startsWith('--- ') && inHeader) throw new Exit2(`error: parse ${i + 2}`);
    if (line.startsWith('@@')) {
      const m = hunkRe.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      inHeader = false;
      const hunk: Hunk = { a: parseInt(m[1]!, 10), body: [], noNewline: false };
      i += 1;
      while (i < n) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '') {
          hunk.body.push({ kind: 'ctx', text: '', empty: true });
          i += 1;
        } else if (b.startsWith(' ')) {
          hunk.body.push({ kind: 'ctx', text: b.slice(1), empty: false });
          i += 1;
        } else if (b.startsWith('-')) {
          hunk.body.push({ kind: 'old', text: b.slice(1), empty: false });
          i += 1;
        } else if (b.startsWith('+')) {
          hunk.body.push({ kind: 'new', text: b.slice(1), empty: false });
          i += 1;
        } else if (b.startsWith('\\')) {
          hunk.body.push({ kind: 'bs', text: b.slice(1), empty: false });
          i += 1;
        } else break;
      }
      while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1]!.empty) hunk.body.pop();
      for (let j = hunk.body.length - 1; j >= 0; j--) {
        const e = hunk.body[j]!;
        if (e.kind === 'ctx' || e.kind === 'new') {
          if (j + 1 < hunk.body.length && hunk.body[j + 1]!.kind === 'bs') hunk.noNewline = true;
          break;
        }
      }
      sec.hunks.push(hunk);
      continue;
    }
    if (inHeader) {
      if (line.startsWith('rename from ')) renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) renameTo = line.slice('rename to '.length).trim();
      else if (line === 'new file mode' || line.startsWith('new file mode ')) sec.isCreate = true;
      else if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) sec.isDelete = true;
      i += 1;
    } else {
      i += 1;
    }
  }
  // Resolve the section's paths: the ---/+++ pair wins, then rename from/to, then diff --git.
  if (!hasPair) {
    if (renameFrom !== undefined) sec.oldP = renameFrom;
    else sec.oldP = diffOld;
    if (renameTo !== undefined) sec.newP = renameTo;
    else sec.newP = diffNew;
  }
  return i;
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const sections: Section[] = [];
  let i = 0;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const sec: Section = { oldP: stripAB(m[1]!), newP: stripAB(m[2]!), isCreate: false, isDelete: false, hunks: [] };
      sections.push(sec);
      i = parseSection(lines, i + 1, sec);
    } else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const sec: Section = { oldP: undefined, newP: undefined, isCreate: false, isDelete: false, hunks: [] };
      sections.push(sec);
      i = parseSection(lines, i, sec);
    } else if (line.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`);
    } else {
      i += 1;
    }
  }
  return sections.map((sec) => unifiedEdit(sec, strict));
}

function unifiedEdit(sec: Section, strict: boolean): Edit {
  const oldP = sec.oldP;
  const newP = sec.newP;
  const isCreate = oldP === null || sec.isCreate;
  const isDelete = !isCreate && (newP === null || sec.isDelete);
  const isMove = !isCreate && !isDelete && oldP !== newP;
  return (tree) => {
    if (isCreate) {
      if (newP === null || newP === undefined) return;
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const added: string[] = [];
      for (const h of sec.hunks) for (const e of h.body) if (e.kind === 'new') added.push(e.text);
      let noNl = false;
      for (let hi = sec.hunks.length - 1; hi >= 0; hi--) {
        const h = sec.hunks[hi]!;
        let decided = false;
        for (let j = h.body.length - 1; j >= 0; j--) {
          if (h.body[j]!.kind === 'new') {
            if (j + 1 < h.body.length && h.body[j + 1]!.kind === 'bs') noNl = true;
            decided = true;
            break;
          }
        }
        if (decided) break;
      }
      tree.now.set(newP, added.length === 0 ? '' : added.join('\n') + (noNl ? '' : '\n'));
      return;
    }
    if (isDelete) {
      const p = oldP!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const p = oldP!;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (isMove) {
      const np = newP!;
      if (!safe(np)) throw new Fail('unsafe', np);
      if (tree.get(p) === null) throw new Fail('missing', p);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const out = applyUnifiedHunks(parseFile(tree.get(p)!), sec.hunks, strict, p);
      tree.now.set(p, null);
      tree.now.set(np, renderFile(out));
      return { move: [p, np] };
    }
    if (tree.get(p) === null) throw new Fail('missing', p);
    const out = applyUnifiedHunks(parseFile(tree.get(p)!), sec.hunks, strict, p);
    tree.now.set(p, renderFile(out));
  };
}

/** Apply a section's hunks in order to a file's lines. */
function applyUnifiedHunks(file0: FileLines, hunks: Hunk[], strict: boolean, path: string): FileLines {
  let file = file0;
  let d = 0;
  for (const hunk of hunks) {
    const { o, n } = hunkON(hunk);
    if (o.length > 0) {
      const found = firstTierOcc(file.lines, o, strict);
      if (!found) throw new Fail('no-match', path);
      const target = hunk.a - 1 + d;
      let best = found.occ[0]!;
      let bestDist = Math.abs(best - target);
      for (const pos of found.occ) {
        const dist = Math.abs(pos - target);
        if (dist < bestDist) {
          best = pos;
          bestDist = dist;
        }
      }
      const atEnd = best + o.length === file.lines.length;
      file = applyReplace(file, best, o.length, n, o, found.tier);
      if (atEnd) file.final = !hunk.noNewline;
      d += n.length - o.length;
    } else {
      const idx = Math.max(0, Math.min(hunk.a + d, file.lines.length));
      const atEnd = idx === file.lines.length;
      const rep = n.map((e) => e.text);
      file = { lines: [...file.lines.slice(0, idx), ...rep, ...file.lines.slice(idx)], br: file.br, final: file.final };
      if (atEnd) file.final = !hunk.noNewline;
      d += n.length;
    }
  }
  return file;
}

/* ------------------------------------------------------------------ */
/* Section 7: SEARCH/REPLACE blocks.                                   */
/* ------------------------------------------------------------------ */

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const blocks: SRBlock[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < n) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      const searchIdx = i;
      let path: string | null = null;
      for (let j = searchIdx - 1; j >= prevEnd; j--) {
        const l = lines[j]!;
        if (blank(l)) continue;
        if (l.trim().startsWith('```')) continue;
        path = l.trim();
        break;
      }
      if (path === null) {
        if (prevPath !== null) path = prevPath;
        else throw new Exit2(`error: parse ${searchIdx + 1}`);
      }
      let eq = -1;
      for (let j = searchIdx + 1; j < n; j++) {
        if (lines[j]!.trimEnd() === '=======') {
          eq = j;
          break;
        }
      }
      if (eq < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
      let rep = -1;
      for (let j = eq + 1; j < n; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
      if (rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
      blocks.push({ path, oldLines: lines.slice(searchIdx + 1, eq), newLines: lines.slice(eq + 1, rep) });
      prevPath = path;
      prevEnd = rep + 1;
      i = rep + 1;
    } else {
      i += 1;
    }
  }
  return blocks.map((b) => srEdit(b, strict));
}

function srEdit(b: SRBlock, strict: boolean): Edit {
  return (tree) => {
    const p = b.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (b.oldLines.length === 0) {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(p);
    if (cur === null) throw new Fail('missing', p);
    const file = parseFile(cur);
    const found = firstTierOcc(file.lines, b.oldLines, strict);
    if (!found) throw new Fail('no-match', p);
    if (found.occ.length > 1) throw new Fail('ambiguous', p);
    const at = found.occ[0]!;
    const n: NLine[] = b.newLines.map((t) => ({ text: t, ctx: false, oIdx: -1 }));
    tree.now.set(p, renderFile(applyReplace(file, at, b.oldLines.length, n, b.oldLines, found.tier)));
  };
}

/* ------------------------------------------------------------------ */
/* Section 8: V4A patches.                                             */
/* ------------------------------------------------------------------ */

interface V4AChunk {
  anchor: string;
  body: string[];
  eof: boolean;
}

function chunkON(ch: V4AChunk): { o: string[]; n: NLine[] } {
  const o: string[] = [];
  const n: NLine[] = [];
  for (const l of ch.body) {
    if (l === '') {
      o.push('');
      n.push({ text: '', ctx: true, oIdx: o.length - 1 });
    } else if (l.startsWith(' ')) {
      const t = l.slice(1);
      o.push(t);
      n.push({ text: t, ctx: true, oIdx: o.length - 1 });
    } else if (l.startsWith('-')) {
      o.push(l.slice(1));
    } else if (l.startsWith('+')) {
      n.push({ text: l.slice(1), ctx: false, oIdx: -1 });
    }
  }
  return { o, n };
}

function parseV4A(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  let first = -1;
  let last = -1;
  for (let i = 0; i < n; i++) {
    if (!blank(lines[i]!)) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const p = line.slice('*** Add File: '.length).trim();
      i += 1;
      const raw: { l: string; idx: number }[] = [];
      while (i < last && !isSectionStart(lines[i]!)) {
        raw.push({ l: lines[i]!, idx: i });
        i += 1;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!.l)) raw.pop();
      const fileLines: string[] = [];
      for (const r of raw) {
        if (r.l.startsWith('+')) fileLines.push(r.l.slice(1));
        else if (r.l === '') fileLines.push('');
        else throw new Exit2(`error: parse ${r.idx + 1}`);
      }
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
    } else if (line.startsWith('*** Delete File: ')) {
      const p = line.slice('*** Delete File: '.length).trim();
      i += 1;
      while (i < last && blank(lines[i]!)) i += 1;
      if (i < last && !isSectionStart(lines[i]!)) throw new Exit2(`error: parse ${i + 1}`);
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
    } else if (line.startsWith('*** Update File: ')) {
      const updateIdx = i;
      const p = line.slice('*** Update File: '.length).trim();
      i += 1;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i += 1;
      }
      const chunks: V4AChunk[] = [];
      let cur: V4AChunk | null = null;
      const endChunk = (): void => {
        if (cur !== null) {
          chunks.push(cur);
          cur = null;
        }
      };
      while (i < last) {
        const l = lines[i]!;
        if (isSectionStart(l)) break;
        if (l === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
          cur.eof = true;
          endChunk();
          i += 1;
          continue;
        }
        if (l.startsWith('@@')) {
          endChunk();
          cur = { anchor: l.slice(2).trim(), body: [], eof: false };
          i += 1;
          continue;
        }
        if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (cur === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${i + 1}`);
            cur = { anchor: '', body: [], eof: false };
          }
          cur.body.push(l);
          i += 1;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      endChunk();
      if (chunks.length > 0) {
        const lc = chunks[chunks.length - 1]!;
        if (!lc.eof) while (lc.body.length > 0 && blank(lc.body[lc.body.length - 1]!)) lc.body.pop();
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateIdx + 1}`);
      edits.push(v4aUpdateEdit(p, moveTo, chunks, strict));
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
  }
  return edits;
}

function v4aUpdateEdit(p: string, moveTo: string | null, chunks: V4AChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const cur = tree.get(p);
    if (cur === null) throw new Fail('missing', p);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let file = parseFile(cur);
    let cursor = 0;
    for (const ch of chunks) {
      const { o, n } = chunkON(ch);
      if (ch.anchor !== '') {
        let found = -1;
        const max = strict ? 0 : 2;
        for (let t = 0; t <= max && found < 0; t++) {
          for (let k = cursor; k < file.lines.length; k++) {
            if (lineEq(file.lines[k]!, ch.anchor, t)) {
              found = k;
              break;
            }
          }
        }
        if (found < 0) throw new Fail('no-match', p);
        cursor = found + 1;
      }
      if (o.length > 0) {
        const found = firstTierOcc(file.lines, o, strict, cursor);
        if (!found) throw new Fail('no-match', p);
        let pos = -1;
        for (const occ of found.occ) {
          if (ch.eof && occ + o.length !== file.lines.length) continue;
          pos = occ;
          break;
        }
        if (pos < 0) throw new Fail('no-match', p);
        file = applyReplace(file, pos, o.length, n, o, found.tier);
        cursor = pos + n.length;
      } else {
        const idx = ch.eof ? file.lines.length : cursor;
        const rep = n.map((e) => e.text);
        file = { lines: [...file.lines.slice(0, idx), ...rep, ...file.lines.slice(idx)], br: file.br, final: file.final };
        cursor = idx + rep.length;
      }
    }
    const out = renderFile(file);
    if (moveTo !== null) {
      tree.now.set(p, null);
      tree.now.set(moveTo, out);
      return { move: [p, moveTo] };
    }
    tree.now.set(p, out);
  };
}

/* ------------------------------------------------------------------ */
/* Section 1 and 2: the command line, the run, the output.             */
/* ------------------------------------------------------------------ */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4A(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  const moves: [string, string][] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      const r = edit(tree);
      if (r && r.move) moves.push(r.move);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; line: string }[] = [];
  const covered = new Set<string>();
  for (const [oldP, newP] of moves) {
    if (tree.original(oldP) !== null && tree.now.get(oldP) === null && tree.original(newP) === null && tree.now.get(newP) !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      covered.add(oldP);
      covered.add(newP);
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
