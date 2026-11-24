// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

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

/** Split file content into lines, handling CRLF/LF and trailing break per SPEC §3. */
function splitFileLines(content: string): { lines: string[]; break: string; hadFinalBreak: boolean } {
  if (content === '') return { lines: [], break: '\n', hadFinalBreak: false };
  const firstLF = content.indexOf('\n');
  const crlf = firstLF > 0 && content[firstLF - 1] === '\r';
  const br = crlf ? '\r\n' : '\n';
  const hadFinalBreak = content.endsWith(br);
  let lines = content.split(br);
  if (hadFinalBreak && lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return { lines, break: br, hadFinalBreak };
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves recorded by edits: old path -> new path, for `R old -> new` rows. */
  readonly moves = new Map<string, string>();
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

type Edit = (tree: Tree) => void;

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
      const { lines: beforeLines, break: br, hadFinalBreak } = splitFileLines(before);
      const lf = (s: string): string => (br === '\r\n' ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, br === '\r\n' ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const { lines: beforeLines, break: br, hadFinalBreak } = splitFileLines(before);
      if (line < 0 || line > beforeLines.length) throw new Fail('no-match', p);
      beforeLines.splice(line, 0, ...add);
      tree.now.set(p, beforeLines.length === 0 ? '' : beforeLines.join(br) + (hadFinalBreak ? br : ''));
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

// ============================================================================
// Section 5: Matching lines
// ============================================================================

interface MatchResult {
  tier: 0 | 1 | 2;
  pos: number;
}

function leadingWhitespace(s: string): string {
  let i = 0;
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
  return s.slice(0, i);
}

function normalizeLine(line: string, tier: 0 | 1 | 2): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.trim();
}

/**
 * Find O in fileLines at the first tier where it occurs at least once.
 * Returns { tier, pos } of the first occurrence at that tier, or null.
 */
function matchLines(fileLines: string[], O: string[], strict: boolean): MatchResult | null {
  const maxTier = strict ? 0 : 2;
  for (let tier = 0; tier <= maxTier; tier++) {
    const normO = O.map((l) => normalizeLine(l, tier as 0 | 1 | 2));
    const normFile = fileLines.map((l) => normalizeLine(l, tier as 0 | 1 | 2));
    for (let i = 0; i <= normFile.length - normO.length; i++) {
      let match = true;
      for (let j = 0; j < normO.length; j++) {
        if (normFile[i + j] !== normO[j]) {
          match = false;
          break;
        }
      }
      if (match) return { tier: tier as 0 | 1 | 2, pos: i };
    }
  }
  return null;
}

/**
 * Find all occurrences of O in fileLines at a given tier.
 */
function findAllOccurrences(fileLines: string[], O: string[], tier: 0 | 1 | 2): number[] {
  const normO = O.map((l) => normalizeLine(l, tier));
  const normFile = fileLines.map((l) => normalizeLine(l, tier));
  const positions: number[] = [];
  for (let i = 0; i <= normFile.length - normO.length; i++) {
    let match = true;
    for (let j = 0; j < normO.length; j++) {
      if (normFile[i + j] !== normO[j]) {
        match = false;
        break;
      }
    }
    if (match) positions.push(i);
  }
  return positions;
}

/**
 * Apply replacement: O (old lines) replaced by N (new lines) at position pos in fileLines.
 * Returns the new file lines.
 * At tier 2, re-indent N lines: F = file's first matched line leading whitespace,
 * P = O's first line leading whitespace. N lines that are not empty/not all whitespace
 * and start with P have that P replaced by F. Context lines (present in both O and N,
 * marked in contextOIndex) are written as the file's own matched line.
 * contextOIndex: array parallel to N; for a context line it holds that line's index
 * in O, for a new line it is null. (N and O can differ in length, so an N index must
 * never be used to address the matched O block.)
 */
function applyReplacement(fileLines: string[], O: string[], N: string[], pos: number, tier: 0 | 1 | 2, contextOIndex: (number | null)[]): string[] {
  const result = [...fileLines];
  const matchedFileLines = fileLines.slice(pos, pos + O.length);

  const newLines: string[] = [];
  if (tier === 2) {
    const F = leadingWhitespace(matchedFileLines[0] ?? '');
    const P = leadingWhitespace(O[0] ?? '');
    for (let nIdx = 0; nIdx < N.length; nIdx++) {
      const nLine = N[nIdx];
      const oIdx = contextOIndex[nIdx];
      if (oIdx !== null && oIdx !== undefined) {
        newLines.push(matchedFileLines[oIdx] ?? '');
      } else if (nLine !== '' && !/^[ \t]*$/.test(nLine) && nLine.startsWith(P)) {
        newLines.push(F + nLine.slice(P.length));
      } else {
        newLines.push(nLine);
      }
    }
  } else {
    for (let nIdx = 0; nIdx < N.length; nIdx++) {
      const oIdx = contextOIndex[nIdx];
      if (oIdx !== null && oIdx !== undefined) {
        newLines.push(matchedFileLines[oIdx] ?? '');
      } else {
        newLines.push(N[nIdx]);
      }
    }
  }

  result.splice(pos, O.length, ...newLines);
  return result;
}

// ============================================================================
// Section 6: Unified diffs
// ============================================================================

interface UnifiedHunk {
  A: number;
  B: number;
  C: number;
  D: number;
  body: string[];
}

function parseUnifiedPath(line: string): string {
  const after = line.slice(4);
  const tabIdx = after.indexOf('\t');
  const pathPart = tabIdx >= 0 ? after.slice(0, tabIdx) : after;
  let path = pathPart.trim();
  if (path.startsWith('a/') || path.startsWith('b/')) path = path.slice(2);
  if (path === '/dev/null') return '';
  return path;
}

function parseHunkHeader(line: string): { A: number; B: number; C: number; D: number } | null {
  const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
  if (!m) return null;
  return {
    A: parseInt(m[1], 10),
    B: m[2] ? parseInt(m[2], 10) : 1,
    C: parseInt(m[3], 10),
    D: m[4] ? parseInt(m[4], 10) : 1,
  };
}

function unifiedEdits(text: string, lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let i = 0;

  while (i < lines.length) {
    if (!lines[i]!.startsWith('diff --git ') && !(lines[i]!.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '))) {
      if (lines[i]!.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i++;
      continue;
    }

    let oldPath: string | null = null;
    let newPath: string | null = null;
    let isCreate = false;
    let isDelete = false;
    const hunks: UnifiedHunk[] = [];

    if (lines[i]!.startsWith('diff --git ')) {
      const m = lines[i]!.match(/^diff --git a\/(.+) b\/(.+)$/);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      oldPath = m[1];
      newPath = m[2];
      i++;
    }

    while (i < lines.length) {
      const line = lines[i]!;
      if (line.startsWith('--- ')) {
        if (i + 1 >= lines.length || !lines[i + 1]!.startsWith('+++ ')) {
          throw new Exit2(`error: parse ${i + 2}`);
        }
        oldPath = parseUnifiedPath(line);
        newPath = parseUnifiedPath(lines[i + 1]!);
        i += 2;
      } else if (line.startsWith('rename from ')) {
        oldPath = line.slice(12).trim();
        i++;
      } else if (line.startsWith('rename to ')) {
        newPath = line.slice(10).trim();
        i++;
      } else if (line.startsWith('new file mode')) {
        isCreate = true;
        i++;
      } else if (line.startsWith('deleted file mode')) {
        isDelete = true;
        i++;
      } else if (line.startsWith('index ') || line.startsWith('old mode ') || line.startsWith('new mode ') ||
                 line.startsWith('similarity index ') || line.startsWith('dissimilarity index ') || line.startsWith('Index:')) {
        i++;
      } else if (line.startsWith('@@')) {
        break;
      } else if (line.startsWith('diff --git ') || (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '))) {
        break;
      } else {
        i++;
      }
    }

    const oldIsNull = oldPath === '';
    const newIsNull = newPath === '';
    const sectionOldPath = oldIsNull ? null : (oldPath ?? '');
    const sectionNewPath = newIsNull ? null : (newPath ?? '');

    while (i < lines.length) {
      const line = lines[i]!;
      if (line.startsWith('@@')) {
        const parsed = parseHunkHeader(line);
        if (!parsed) throw new Exit2(`error: parse ${i + 1}`);
        i++;
        const body: string[] = [];
        while (i < lines.length) {
          const bline = lines[i]!;
          if (bline.startsWith('diff --git ') || (bline.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '))) {
            break;
          }
          if (/^[ \-\+\\]/.test(bline) || bline === '') {
            body.push(bline);
            i++;
          } else {
            break;
          }
        }
        while (body.length > 0 && body[body.length - 1] === '') body.pop();
        hunks.push({ ...parsed, body });
      } else if (line.startsWith('diff --git ') || (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '))) {
        break;
      } else {
        i++;
      }
    }

    if (sectionOldPath !== null && !safe(sectionOldPath)) {
      edits.push(() => { throw new Fail('unsafe', sectionOldPath); });
      continue;
    }
    if (sectionNewPath !== null && !safe(sectionNewPath)) {
      edits.push(() => { throw new Fail('unsafe', sectionNewPath); });
      continue;
    }

    if (isCreate || (oldIsNull && !newIsNull)) {
      const createPath = sectionNewPath!;
      edits.push((tree) => {
        if (!safe(createPath)) throw new Fail('unsafe', createPath);
        if (tree.get(createPath) !== null) throw new Fail('exists', createPath);
        const fileLines: string[] = [];
        let endsWithBackslash = false;
        for (const hunk of hunks) {
          for (const bline of hunk.body) {
            if (bline.startsWith('+')) {
              fileLines.push(bline.slice(1));
              endsWithBackslash = false;
            } else if (bline.startsWith('\\')) {
              endsWithBackslash = true;
            } else if (bline.startsWith(' ')) {
              fileLines.push(bline.slice(1));
              endsWithBackslash = false;
            }
          }
        }
        tree.now.set(createPath, fileLines.join('\n') + (endsWithBackslash ? '' : '\n'));
      });
    } else if (isDelete || (!oldIsNull && newIsNull)) {
      const deletePath = sectionOldPath!;
      edits.push((tree) => {
        if (!safe(deletePath)) throw new Fail('unsafe', deletePath);
        if (tree.get(deletePath) === null) throw new Fail('missing', deletePath);
        tree.now.set(deletePath, null);
      });
    } else if (sectionOldPath !== sectionNewPath) {
      const oldP = sectionOldPath!;
      const newP = sectionNewPath!;
      edits.push((tree) => {
        if (!safe(oldP)) throw new Fail('unsafe', oldP);
        if (!safe(newP)) throw new Fail('unsafe', newP);
        const content = tree.get(oldP);
        if (content === null) throw new Fail('missing', oldP);
        if (tree.get(newP) !== null) throw new Fail('exists', newP);
        const { lines: fileLines, break: origBr, hadFinalBreak: origHadBreak } = splitFileLines(content);
        let d = 0;
        let currentLines = fileLines;
        for (const hunk of hunks) {
          const O: string[] = [];
          const N: string[] = [];
          const contextOIndex: (number | null)[] = [];
          let endsWithBackslash = false;
          for (const bline of hunk.body) {
            if (bline.startsWith(' ')) {
              contextOIndex.push(O.length);
              O.push(bline.slice(1));
              N.push(bline.slice(1));
              endsWithBackslash = false;
            } else if (bline.startsWith('-')) {
              O.push(bline.slice(1));
              endsWithBackslash = false;
            } else if (bline.startsWith('+')) {
              contextOIndex.push(null);
              N.push(bline.slice(1));
              endsWithBackslash = false;
            } else if (bline === '') {
              contextOIndex.push(O.length);
              O.push('');
              N.push('');
              endsWithBackslash = false;
            } else if (bline.startsWith('\\')) {
              endsWithBackslash = true;
            }
          }

          let match: MatchResult | null = null;
          if (O.length > 0) {
            let bestTier: 0 | 1 | 2 = 0;
            let bestPositions: number[] = [];
            for (let t = 0; t <= (strict ? 0 : 2); t++) {
              const occs = findAllOccurrences(currentLines, O, t as 0 | 1 | 2);
              if (occs.length > 0) {
                bestTier = t as 0 | 1 | 2;
                bestPositions = occs;
                break;
              }
            }
            if (bestPositions.length === 0) throw new Fail('no-match', oldP);
            const target = hunk.A - 1 + d;
            let bestPos = bestPositions[0];
            let bestDist = Math.abs(bestPos - target);
            for (const p of bestPositions) {
              const dist = Math.abs(p - target);
              if (dist < bestDist || (dist === bestDist && p < bestPos)) {
                bestDist = dist;
                bestPos = p;
              }
            }
            match = { tier: bestTier, pos: bestPos };
          } else {
            const insertPos = Math.min(hunk.A + d, currentLines.length);
            match = { tier: 0, pos: insertPos };
          }

          currentLines = applyReplacement(currentLines, O, N, match.pos, match.tier, contextOIndex);
          d += N.length - O.length;
        }

        let finalBreak = origHadBreak;
        if (hunks.length > 0) {
          const lastHunk = hunks[hunks.length - 1];
          const lastBodyLine = lastHunk.body[lastHunk.body.length - 1];
          if (lastBodyLine !== undefined && lastBodyLine.startsWith('\\')) finalBreak = false;
        }
        let out = currentLines.join(origBr);
        if (finalBreak) out += origBr;
        tree.now.set(newP, out);
        tree.now.set(oldP, null);
        tree.moves.set(oldP, newP);
      });
    } else {
      const changePath = sectionOldPath!;
      edits.push((tree) => {
        if (!safe(changePath)) throw new Fail('unsafe', changePath);
        const content = tree.get(changePath);
        if (content === null) throw new Fail('missing', changePath);
        const { lines: fileLines, break: origBr, hadFinalBreak: origHadBreak } = splitFileLines(content);
        let d = 0;
        let currentLines = fileLines;
        for (const hunk of hunks) {
          const O: string[] = [];
          const N: string[] = [];
          const contextOIndex: (number | null)[] = [];
          let endsWithBackslash = false;
          for (const bline of hunk.body) {
            if (bline.startsWith(' ')) {
              contextOIndex.push(O.length);
              O.push(bline.slice(1));
              N.push(bline.slice(1));
              endsWithBackslash = false;
            } else if (bline.startsWith('-')) {
              O.push(bline.slice(1));
              endsWithBackslash = false;
            } else if (bline.startsWith('+')) {
              contextOIndex.push(null);
              N.push(bline.slice(1));
              endsWithBackslash = false;
            } else if (bline === '') {
              contextOIndex.push(O.length);
              O.push('');
              N.push('');
              endsWithBackslash = false;
            } else if (bline.startsWith('\\')) {
              endsWithBackslash = true;
            }
          }

          let match: MatchResult | null = null;
          if (O.length > 0) {
            let bestTier: 0 | 1 | 2 = 0;
            let bestPositions: number[] = [];
            for (let t = 0; t <= (strict ? 0 : 2); t++) {
              const occs = findAllOccurrences(currentLines, O, t as 0 | 1 | 2);
              if (occs.length > 0) {
                bestTier = t as 0 | 1 | 2;
                bestPositions = occs;
                break;
              }
            }
            if (bestPositions.length === 0) throw new Fail('no-match', changePath);
            const target = hunk.A - 1 + d;
            let bestPos = bestPositions[0];
            let bestDist = Math.abs(bestPos - target);
            for (const p of bestPositions) {
              const dist = Math.abs(p - target);
              if (dist < bestDist || (dist === bestDist && p < bestPos)) {
                bestDist = dist;
                bestPos = p;
              }
            }
            match = { tier: bestTier, pos: bestPos };
          } else {
            const insertPos = Math.min(hunk.A + d, currentLines.length);
            match = { tier: 0, pos: insertPos };
          }

          currentLines = applyReplacement(currentLines, O, N, match.pos, match.tier, contextOIndex);
          d += N.length - O.length;
        }

        let finalBreak = origHadBreak;
        if (hunks.length > 0) {
          const lastHunk = hunks[hunks.length - 1];
          const lastBodyLine = lastHunk.body[lastHunk.body.length - 1];
          if (lastBodyLine !== undefined && lastBodyLine.startsWith('\\')) finalBreak = false;
        }
        let out = currentLines.join(origBr);
        if (finalBreak) out += origBr;
        tree.now.set(changePath, out);
      });
    }
  }

  return edits;
}

// ============================================================================
// Section 7: SEARCH/REPLACE blocks
// ============================================================================

interface SearchReplaceBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function searchReplaceEdits(text: string, lines: string[]): Edit[] {
  const blocks: SearchReplaceBlock[] = [];
  let i = 0;
  let lastPath = '';

  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trimEnd() === '<<<<<<< SEARCH') {
      let path = '';
      for (let j = i - 1; j >= 0; j--) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
        const l = lines[j]!.trim();
        if (l !== '' && !l.startsWith('```')) {
          path = lines[j]!.trim();
          break;
        }
      }
      if (path === '') {
        if (lastPath === '') throw new Exit2(`error: parse ${i + 1}`);
        path = lastPath;
      }
      i++;
      const oldLines: string[] = [];
      while (i < lines.length && lines[i]!.trimEnd() !== '=======') {
        oldLines.push(lines[i]!);
        i++;
      }
      if (i >= lines.length) throw new Exit2(`error: parse ${i - oldLines.length}`);
      i++;
      const newLines: string[] = [];
      while (i < lines.length && lines[i]!.trimEnd() !== '>>>>>>> REPLACE') {
        newLines.push(lines[i]!);
        i++;
      }
      if (i >= lines.length) throw new Exit2(`error: parse ${i - newLines.length}`);
      i++;
      blocks.push({ path, oldLines, newLines });
      lastPath = path;
    } else {
      i++;
    }
  }

  if (blocks.length === 0) throw new Exit2('error: parse 1');

  const edits: Edit[] = [];
  for (const block of blocks) {
    const p = block.path;
    const oldLines = block.oldLines;
    const newLines = block.newLines;

    if (!safe(p)) {
      edits.push(() => { throw new Fail('unsafe', p); });
      continue;
    }

    if (oldLines.length === 0) {
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.join('\n') + '\n');
      });
    } else {
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        const content = tree.get(p);
        if (content === null) throw new Fail('missing', p);
        const { lines: fileLines, break: origBr, hadFinalBreak: origHadBreak } = splitFileLines(content);

        let match: MatchResult | null = null;
        let matchTier: 0 | 1 | 2 = 0;
        for (let t = 0; t <= (strict ? 0 : 2); t++) {
          const occs = findAllOccurrences(fileLines, oldLines, t as 0 | 1 | 2);
          if (occs.length === 1) {
            match = { tier: t as 0 | 1 | 2, pos: occs[0] };
            matchTier = t as 0 | 1 | 2;
            break;
          } else if (occs.length > 1) {
            throw new Fail('ambiguous', p);
          }
        }
        if (!match) throw new Fail('no-match', p);

        const contextOIndex: (number | null)[] = newLines.map(() => null);
        const newFileLines = applyReplacement(fileLines, oldLines, newLines, match.pos, matchTier, contextOIndex);

        let finalBreak = origHadBreak;
        let out = newFileLines.join(origBr);
        if (finalBreak) out += origBr;
        tree.now.set(p, out);
      });
    }
  }

  return edits;
}

// ============================================================================
// Section 8: V4A patches
// ============================================================================

interface V4AChunk {
  anchor: string | null;
  isEof: boolean;
  O: string[];
  N: string[];
  contextOIndex: (number | null)[];
}

interface V4ASection {
  type: 'add' | 'delete' | 'update';
  path: string;
  newPath: string | null;
  chunks: V4AChunk[];
  lines: string[];
}

function v4aEdits(text: string, lines: string[]): Edit[] {
  const firstNonBlank = lines.findIndex((l) => !blank(l));
  if (firstNonBlank < 0 || lines[firstNonBlank]!.trim() !== '*** Begin Patch') {
    throw new Exit2(`error: parse ${firstNonBlank >= 0 ? firstNonBlank + 1 : 1}`);
  }
  const lastNonBlank = [...lines].reverse().findIndex((l) => !blank(l));
  const lastNonBlankIdx = lastNonBlank >= 0 ? lines.length - 1 - lastNonBlank : -1;
  if (lastNonBlankIdx < 0 || lines[lastNonBlankIdx]!.trim() !== '*** End Patch') {
    throw new Exit2(`error: parse ${lines.length + 1}`);
  }

  const sections: V4ASection[] = [];
  let i = firstNonBlank + 1;

  while (i < lastNonBlankIdx) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice(14).trim();
      i++;
      const fileLines: string[] = [];
      while (i < lastNonBlankIdx) {
        const l = lines[i]!;
        if (l.startsWith('*** ')) break;
        if (l.startsWith('+')) {
          fileLines.push(l.slice(1));
        } else if (l === '') {
          fileLines.push('');
        } else {
          throw new Exit2(`error: parse ${i + 1}`);
        }
        i++;
      }
      sections.push({ type: 'add', path, newPath: null, chunks: [], lines: fileLines });
    } else if (line.startsWith('*** Delete File: ')) {
      const path = line.slice(17).trim();
      sections.push({ type: 'delete', path, newPath: null, chunks: [], lines: [] });
      i++;
      while (i < lastNonBlankIdx && blank(lines[i]!)) i++;
    } else if (line.startsWith('*** Update File: ')) {
      const path = line.slice(17).trim();
      i++;
      let newPath: string | null = null;
      const chunks: V4AChunk[] = [];

      if (i < lastNonBlankIdx && lines[i]!.startsWith('*** Move to: ')) {
        newPath = lines[i]!.slice(13).trim();
        i++;
      }

      let hasChunk = false;
      while (i < lastNonBlankIdx) {
        const l = lines[i]!;
        if (l.startsWith('*** ')) break;
        if (blank(l)) {
          i++;
          continue;
        }

        let anchor: string | null = null;
        let isEof = false;

        if (l.startsWith('@@')) {
          anchor = l.slice(2).trim();
          if (anchor === '') anchor = null;
          i++;
        } else if (l === '*** End of File') {
          isEof = true;
          anchor = null;
          i++;
        } else {
          anchor = null;
        }

        const O: string[] = [];
        const N: string[] = [];
        const contextOIndex: (number | null)[] = [];
        while (i < lastNonBlankIdx) {
          const bline = lines[i]!;
          if (bline === '*** End of File') {
            isEof = true;
            i++;
            break;
          }
          if (bline.startsWith('*** ') || bline.startsWith('@@')) break;
          if (bline.startsWith(' ')) {
            contextOIndex.push(O.length);
            O.push(bline.slice(1));
            N.push(bline.slice(1));
          } else if (bline.startsWith('-')) {
            O.push(bline.slice(1));
          } else if (bline.startsWith('+')) {
            contextOIndex.push(null);
            N.push(bline.slice(1));
          } else if (bline === '') {
            contextOIndex.push(O.length);
            O.push('');
            N.push('');
          } else {
            throw new Exit2(`error: parse ${i + 1}`);
          }
          i++;
        }
        chunks.push({ anchor, isEof, O, N, contextOIndex });
        hasChunk = true;
      }

      // Blank lines at the end of a section are not part of it (SPEC section 8):
      // drop trailing empty context lines from the section's last chunk.
      const lastChunk = chunks[chunks.length - 1];
      if (lastChunk) {
        while (
          lastChunk.N.length > 0 &&
          lastChunk.contextOIndex[lastChunk.contextOIndex.length - 1] !== null &&
          lastChunk.contextOIndex[lastChunk.contextOIndex.length - 1] === lastChunk.O.length - 1 &&
          lastChunk.O[lastChunk.O.length - 1] === '' &&
          lastChunk.N[lastChunk.N.length - 1] === ''
        ) {
          lastChunk.O.pop();
          lastChunk.N.pop();
          lastChunk.contextOIndex.pop();
        }
      }

      if (!hasChunk && newPath === null) {
        throw new Exit2(`error: parse ${i - chunks.length}`);
      }

      sections.push({ type: 'update', path, newPath, chunks, lines: [] });
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
  }

  if (sections.length === 0) throw new Exit2('error: parse 1');

  const edits: Edit[] = [];
  for (const section of sections) {
    const p = section.path;
    if (!safe(p)) {
      edits.push(() => { throw new Fail('unsafe', p); });
      continue;
    }
    if (section.newPath !== null && !safe(section.newPath)) {
      edits.push(() => { throw new Fail('unsafe', section.newPath); });
      continue;
    }

    if (section.type === 'add') {
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, section.lines.join('\n') + '\n');
      });
    } else if (section.type === 'delete') {
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
    } else if (section.type === 'update') {
      const newP = section.newPath;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        const content = tree.get(p);
        if (content === null) throw new Fail('missing', p);
        if (newP !== null) {
          if (!safe(newP)) throw new Fail('unsafe', newP);
          if (tree.get(newP) !== null) throw new Fail('exists', newP);
        }

        const { lines: fileLines, break: origBr, hadFinalBreak: origHadBreak } = splitFileLines(content);
        let currentLines = fileLines;
        let cursor = 0;

        for (const chunk of section.chunks) {
          if (chunk.anchor !== null) {
            const anchorLine = chunk.anchor;
            let found = false;
            for (let t = 0; t <= (strict ? 0 : 2); t++) {
              const normAnchor = normalizeLine(anchorLine, t as 0 | 1 | 2);
              for (let pos = cursor; pos < currentLines.length; pos++) {
                if (normalizeLine(currentLines[pos], t as 0 | 1 | 2) === normAnchor) {
                  cursor = pos + 1;
                  found = true;
                  break;
                }
              }
              if (found) break;
            }
            if (!found) throw new Fail('no-match', p);
          }

          const O = chunk.O;
          const N = chunk.N;
          let match: MatchResult | null = null;

          if (O.length > 0) {
            if (chunk.isEof) {
              for (let t = 0; t <= (strict ? 0 : 2); t++) {
                const occs = findAllOccurrences(currentLines, O, t as 0 | 1 | 2);
                const validOccs = occs.filter((pos) => pos + O.length === currentLines.length);
                const afterCursor = validOccs.filter((pos) => pos >= cursor);
                if (afterCursor.length > 0) {
                  match = { tier: t as 0 | 1 | 2, pos: afterCursor[0] };
                  break;
                }
              }
              if (!match) throw new Fail('no-match', p);
            } else {
              for (let t = 0; t <= (strict ? 0 : 2); t++) {
                const occs = findAllOccurrences(currentLines, O, t as 0 | 1 | 2);
                const afterCursor = occs.filter((pos) => pos >= cursor);
                if (afterCursor.length > 0) {
                  match = { tier: t as 0 | 1 | 2, pos: afterCursor[0] };
                  break;
                }
              }
              if (!match) throw new Fail('no-match', p);
            }
          } else {
            if (chunk.isEof) {
              match = { tier: 0, pos: currentLines.length };
            } else {
              match = { tier: 0, pos: Math.min(cursor, currentLines.length) };
            }
          }

          currentLines = applyReplacement(currentLines, O, N, match.pos, match.tier, chunk.contextOIndex);
          cursor = match.pos + N.length;
        }

        let finalBreak = origHadBreak;
        let out = currentLines.join(origBr);
        if (finalBreak) out += origBr;

        if (newP !== null) {
          tree.now.set(newP, out);
          tree.now.set(p, null);
          tree.moves.set(p, newP);
        } else {
          tree.now.set(p, out);
        }
      });
    }
  }

  return edits;
}

// ============================================================================
// Main run function
// ============================================================================

let strict = false;

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  strict = false;
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
    if (kind === 'json') {
      edits = jsonEdits(text, lines);
    } else if (kind === 'unified') {
      edits = unifiedEdits(text, lines);
    } else if (kind === 'search-replace') {
      edits = searchReplaceEdits(text, lines);
    } else if (kind === 'v4a') {
      edits = v4aEdits(text, lines);
    } else {
      throw new Exit2('error: parse 1');
    }
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Collapse move pairs into `R <old> -> <new>` rows (SPEC section 2): a path that
  // was deleted on disk and a path that was added, linked by a recorded move
  // (following a move chain back to the on-disk path), become one R row sorted
  // by the new path; anything else stays an A/D/M row sorted by its own path.
  const reverseMoves = new Map<string, string>();
  for (const [o, n] of tree.moves) reverseMoves.set(n, o);
  const deleted = new Set<string>();
  const added = new Set<string>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (was === null) added.add(p);
    else if (now === null) deleted.add(p);
  }
  const pairedOld = new Set<string>();
  const pairedNew = new Set<string>();
  const rows: { key: string; text: string }[] = [];
  for (const p of added) {
    let cur = p;
    const seen = new Set<string>([p]);
    while (reverseMoves.has(cur) && !seen.has(reverseMoves.get(cur)!)) {
      cur = reverseMoves.get(cur)!;
      seen.add(cur);
    }
    if (deleted.has(cur)) {
      pairedOld.add(cur);
      pairedNew.add(p);
      rows.push({ key: p, text: `R ${cur} -> ${p}` });
    }
  }
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (pairedOld.has(p) || pairedNew.has(p)) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of tree.now.keys()) {
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
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}