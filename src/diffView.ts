/**
 * Side-by-side diff view for the left-column chat log.
 *
 * The `change_file` skill (src/skills/file-changer/file-changer.ts) reports a
 * successful edit with `format = 'diff'` and `misc = { origin, new, path }` -
 * the full text of the file BEFORE and AFTER the change, plus the PATH that was
 * written. agent.ts forwards them to the UI as a Protocol, and renderer.ts
 * (handleResponse -> renderMessageInto) hands them to renderDiffInto(), which
 * prints the path as a single line above the grid and paints the two texts side
 * by side inside the message bubble:
 *
 *   /home/me/project/src/app.ts        <- the edited file's path
 *   +--------------------------+--------------------------+
 *   | Original                 | New                      |
 *   +--------------------------+--------------------------+
 *   | 1  # Title               | 1  # Title               |
 *   | 2  the old line          | 2  the new line          |
 *   +--------------------------+--------------------------+
 *
 * Differences are highlighted twice over: a changed LINE gets a red tint on
 * the left / a green tint on the right, and the differing WORDS inside those
 * lines are highlighted more strongly. All cells are appended to ONE CSS grid,
 * so the two sides stay row-aligned however either side wraps.
 *
 * Dependency-free and DOM-only: every piece of file content is written through
 * textContent (never innerHTML), so untrusted file text can never inject
 * markup.
 */

// Presentation lives in its own stylesheet, next to this module (see the import
// block at the top of src/renderer.ts for the same pattern).
import './diffView.css';

/**
 * How many UNCHANGED lines are kept above the first change and below the last
 * one.
 *
 * A diff of a whole file would spend most of the view on text that did not
 * change, so only this much context is rendered around the change itself and
 * the omitted regions collapse into a .diff-elision marker. The counting for
 * the summary still covers EVERY row, so the reported totals stay exact.
 */
const CONTEXT_LINES = 10;

/** Beyond this many lines on either side, word-level diffing is skipped. */
const WORD_DIFF_MAX_LINES = 2000;

/**
 * Cell budget for the LCS table, applied to the head/tail-TRIMMED middle only.
 *
 * Trimming first is what keeps ordinary whole-file diffs exact: a one-line edit
 * in a 3,000-line file leaves a handful of middle lines, so the table stays
 * tiny. Only a genuinely huge middle (thousands of changed lines on BOTH sides)
 * can exceed this budget, and then lcsOps() reports that middle as a wholesale
 * replacement rather than inventing 'eq' pairs between lines that differ.
 */
const LCS_MAX_CELLS = 4000000;

interface DiffRow {
  leftNo: number | null;
  rightNo: number | null;
  leftText: string | null;
  rightText: string | null;
  changed: boolean;
}

interface TokenPart {
  text: string;
  changed: boolean;
}

type DiffOp = { op: 'eq' | 'del' | 'ins'; ai: number; bi: number };

function splitLines(text: string): string[] {
  if (!text) return [];
  return text.replace(/\r\n?/g, '\n').split('\n');
}

function tokenize(line: string): string[] {
  const tokens = line.match(/\s+|[^\s]+/g);
  return tokens ? tokens : [];
}

/**
 * Diff two comparable arrays into a list of edit operations:
 * 'eq' keeps a pair, 'del' exists only on the left, 'ins' only on the right.
 *
 * The identical HEAD and TAIL are trimmed away before the LCS table is built,
 * and that trim is what makes this usable for whole-file diffs: a small edit in
 * a several-thousand-line file leaves only a tiny middle behind, so the table
 * stays small and the real change is found exactly.
 *
 * The trim is not an optimisation, it is a correctness fix. The table budget
 * used to be applied to the WHOLE file, so a ~2,600-line file overflowed it and
 * degraded to a positional pairing that emitted { op: 'eq', ai: i, bi: i } for
 * lines whose TEXT DIFFERED. Those rows were then drawn untinted, side by side,
 * with unrelated texts paired up and the surplus lines dumped at the end as
 * insertions - i.e. a diff that hid the very change it was supposed to show.
 *
 * Only when the TRIMMED middle is still enormous does it give up on pairing and
 * report that middle as a wholesale replacement. That fallback never claims two
 * different lines are equal, so the view can never mislead about the content.
 */
function lcsOps<T>(a: T[], b: T[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  const ops: DiffOp[] = [];

  if (n === 0) {
    for (let j = 0; j < m; j++) ops.push({ op: 'ins', ai: 0, bi: j });
    return ops;
  }
  if (m === 0) {
    for (let i = 0; i < n; i++) ops.push({ op: 'del', ai: i, bi: 0 });
    return ops;
  }

  // ---- 1. Identical head (lines that match from the top of both lists). ----
  let head = 0;
  while (head < n && head < m && a[head] === b[head]) head++;
  for (let i = 0; i < head; i++) ops.push({ op: 'eq', ai: i, bi: i });

  // ---- 2. Identical tail (never allowed to overlap the head). ----
  let tail = 0;
  while (
    tail < n - head &&
    tail < m - head &&
    a[n - 1 - tail] === b[m - 1 - tail]
  ) {
    tail++;
  }

  // ---- 3. The middle: the only region that needs the LCS table. ----
  const midA = n - tail; // exclusive end of the a-side middle
  const midB = m - tail; // exclusive end of the b-side middle
  const lenA = midA - head;
  const lenB = midB - head;

  if (lenA > 0 && lenB > 0) {
    if (lenA * lenB <= LCS_MAX_CELLS) {
      const width = lenB + 1;
      const dp = new Uint32Array((lenA + 1) * width);
      const at = (i: number, j: number): number => i * width + j;

      for (let i = lenA - 1; i >= 0; i--) {
        for (let j = lenB - 1; j >= 0; j--) {
          if (a[head + i] === b[head + j]) {
            dp[at(i, j)] = dp[at(i + 1, j + 1)] + 1;
          } else {
            const down = dp[at(i + 1, j)];
            const right = dp[at(i, j + 1)];
            dp[at(i, j)] = down >= right ? down : right;
          }
        }
      }

      let i = 0;
      let j = 0;
      while (i < lenA && j < lenB) {
        if (a[head + i] === b[head + j]) {
          ops.push({ op: 'eq', ai: head + i, bi: head + j });
          i++;
          j++;
        } else if (dp[at(i + 1, j)] >= dp[at(i, j + 1)]) {
          ops.push({ op: 'del', ai: head + i, bi: head + j });
          i++;
        } else {
          ops.push({ op: 'ins', ai: head + i, bi: head + j });
          j++;
        }
      }
      while (i < lenA) {
        ops.push({ op: 'del', ai: head + i, bi: midB });
        i++;
      }
      while (j < lenB) {
        ops.push({ op: 'ins', ai: midA, bi: head + j });
        j++;
      }
    } else {
      // Too large even after trimming: report the middle as replaced wholesale.
      // Never emit an 'eq' pair here, or different lines would look identical.
      for (let i = 0; i < lenA; i++) ops.push({ op: 'del', ai: head + i, bi: head });
      for (let j = 0; j < lenB; j++) ops.push({ op: 'ins', ai: midA, bi: head + j });
    }
  } else if (lenA > 0) {
    for (let i = 0; i < lenA; i++) ops.push({ op: 'del', ai: head + i, bi: head });
  } else if (lenB > 0) {
    for (let j = 0; j < lenB; j++) ops.push({ op: 'ins', ai: head, bi: head + j });
  }

  // ---- 4. The identical tail, restored at its true absolute indices. ----
  for (let t = 0; t < tail; t++) {
    ops.push({ op: 'eq', ai: midA + t, bi: midB + t });
  }

  return ops;
}

/** Pair the two line lists into side-by-side rows (change blocks aligned). */
function buildRows(a: string[], b: string[]): DiffRow[] {
  const ops = lcsOps(a, b);
  const rows: DiffRow[] = [];
  let k = 0;

  while (k < ops.length) {
    const op = ops[k];
    if (op.op === 'eq') {
      rows.push({
        leftNo: op.ai + 1,
        rightNo: op.bi + 1,
        leftText: a[op.ai],
        rightText: b[op.bi],
        changed: false,
      });
      k++;
      continue;
    }

    // Gather one change block (a run of deletions and/or insertions) ...
    const dels: number[] = [];
    const inss: number[] = [];
    while (k < ops.length && ops[k].op !== 'eq') {
      if (ops[k].op === 'del') dels.push(ops[k].ai);
      else inss.push(ops[k].bi);
      k++;
    }

    // ... and pair up its lines so the change reads row by row.
    const count = Math.max(dels.length, inss.length);
    for (let x = 0; x < count; x++) {
      const d = x < dels.length ? dels[x] : null;
      const s = x < inss.length ? inss[x] : null;
      rows.push({
        leftNo: d === null ? null : d + 1,
        rightNo: s === null ? null : s + 1,
        leftText: d === null ? null : a[d],
        rightText: s === null ? null : b[s],
        changed: true,
      });
    }
  }

  return rows;
}

/** Word-level diff of one changed line pair, as two highlighted token lists. */
function wordDiffParts(left: string, right: string): { left: TokenPart[]; right: TokenPart[] } {
  const a = tokenize(left);
  const b = tokenize(right);
  const ops = lcsOps(a, b);
  const leftParts: TokenPart[] = [];
  const rightParts: TokenPart[] = [];

  for (const op of ops) {
    if (op.op === 'eq') {
      leftParts.push({ text: a[op.ai], changed: false });
      rightParts.push({ text: b[op.bi], changed: false });
    } else if (op.op === 'del') {
      leftParts.push({ text: a[op.ai], changed: true });
    } else {
      rightParts.push({ text: b[op.bi], changed: true });
    }
  }

  return { left: leftParts, right: rightParts };
}

function makeHeader(label: string, sideClass: string): HTMLElement {
  const header = document.createElement('div');
  header.className = 'diff-header ' + sideClass;
  header.textContent = label;
  return header;
}

function appendTokens(host: HTMLElement, parts: TokenPart[], tokenClass: string): void {
  for (const part of parts) {
    if (!part.changed) {
      host.appendChild(document.createTextNode(part.text));
      continue;
    }
    const span = document.createElement('span');
    span.className = tokenClass;
    span.textContent = part.text;
    host.appendChild(span);
  }
}

function makeCell(side: 'origin' | 'new', row: DiffRow, wordDiff: boolean): HTMLElement {
  const isLeft = side === 'origin';
  const cell = document.createElement('div');
  cell.className = 'diff-line ' + (isLeft ? 'diff-origin' : 'diff-new');

  const text = isLeft ? row.leftText : row.rightText;
  const lineNo = isLeft ? row.leftNo : row.rightNo;

  if (text === null) {
    cell.classList.add('diff-empty');
  } else if (row.changed) {
    cell.classList.add(isLeft ? 'diff-line-removed' : 'diff-line-added');
  }

  const gutter = document.createElement('span');
  gutter.className = 'diff-gutter';
  gutter.textContent = lineNo === null ? '' : String(lineNo);
  cell.appendChild(gutter);

  const body = document.createElement('span');
  body.className = 'diff-text';

  if (text === null) {
    body.textContent = '';
  } else if (row.changed && wordDiff && row.leftText !== null && row.rightText !== null) {
    const parts = wordDiffParts(row.leftText, row.rightText);
    appendTokens(
      body,
      isLeft ? parts.left : parts.right,
      isLeft ? 'diff-token-removed' : 'diff-token-added'
    );
  } else {
    body.textContent = text;
  }

  cell.appendChild(body);
  return cell;
}

/**
 * One collapsed-context marker, spanning BOTH grid columns.
 *
 * It stands where the view skipped unchanged lines, so a reader can tell a
 * change near the top or bottom of a file apart from a change that simply
 * starts there. Built with textContent like every other node in this module.
 */
function makeElision(label: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'diff-elision';
  el.textContent = label;
  return el;
}

/**
 * Render `origin` (text before the change) on the LEFT and `updated` (text
 * after the change) on the RIGHT of `container`, highlighting every differing
 * line and every differing word. The container is emptied first, so it can be
 * the freshly created .message-body of a chat message.
 *
 * Only CONTEXT_LINES unchanged rows are rendered on either side of the change:
 * everything further away collapses into a .diff-elision marker, so a one-line
 * edit in a 3000-line file stays readable. The summary underneath still counts
 * the WHOLE edit, because the statistics are gathered before the window is cut.
 */
export function renderDiffInto(
  container: HTMLElement,
  origin: string,
  updated: string,
  filePath?: string
): void {
  container.textContent = '';

  // The file this diff belongs to, shown ABOVE the grid so the reader knows
  // which path was edited without parsing the message text. `path` is optional
  // (a main process from before that attribute simply does not send it), so the
  // label is skipped rather than rendered empty. Written through textContent
  // only: a path is file-system data and must never be parsed as markup. The
  // full value doubles as the tooltip, because long paths are ellipsised.
  if (typeof filePath === 'string' && filePath.trim() !== '') {
    const pathEl = document.createElement('div');
    pathEl.className = 'diff-path';
    pathEl.textContent = filePath;
    pathEl.title = filePath;
    container.appendChild(pathEl);
  }

  const before = splitLines(origin || '');
  const after = splitLines(updated || '');
  const rows = buildRows(before, after);
  const wordDiff = before.length <= WORD_DIFF_MAX_LINES && after.length <= WORD_DIFF_MAX_LINES;

  const grid = document.createElement('div');
  grid.className = 'diff-grid';
  grid.appendChild(makeHeader('Original', 'diff-origin'));
  grid.appendChild(makeHeader('New', 'diff-new'));

  // Pass 1: count the WHOLE edit, so the summary stays exact however little of
  // the file is rendered below. firstChanged/lastChanged bracket the change so
  // pass 2 knows which window of rows is worth showing.
  let removed = 0;
  let added = 0;
  let firstChanged = -1;
  let lastChanged = -1;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row.changed) continue;
    if (row.leftText !== null) removed++;
    if (row.rightText !== null) added++;
    if (firstChanged === -1) firstChanged = i;
    lastChanged = i;
  }

  // The rendered window: 10 unchanged rows above the first change and 10 below
  // the last one. With no change at all there is nothing to surround, so the
  // head of the file is shown instead of the entire (identical) text.
  const windowStart =
    firstChanged === -1 ? 0 : Math.max(0, firstChanged - CONTEXT_LINES);
  const windowEnd =
    firstChanged === -1
      ? Math.min(rows.length - 1, CONTEXT_LINES)
      : Math.min(rows.length - 1, lastChanged + CONTEXT_LINES);

  const rowsAbove = windowStart;
  if (rowsAbove > 0) {
    grid.appendChild(
      makeElision(
        '\u22ee ' + rowsAbove + (rowsAbove === 1 ? ' line' : ' lines') + ' above'
      )
    );
  }

  // Pass 2: only the window is rendered.
  for (let i = windowStart; i <= windowEnd; i++) {
    const row = rows[i];
    grid.appendChild(makeCell('origin', row, wordDiff));
    grid.appendChild(makeCell('new', row, wordDiff));
  }

  const rowsBelow = rows.length - 1 - windowEnd;
  if (rowsBelow > 0) {
    grid.appendChild(
      makeElision(
        '\u22ee ' + rowsBelow + (rowsBelow === 1 ? ' line' : ' lines') + ' below'
      )
    );
  }

  container.appendChild(grid);

  const summary = document.createElement('div');
  summary.className = 'diff-summary';
  if (removed === 0 && added === 0) {
    summary.textContent = 'No textual differences.';
  } else {
    const delStat = document.createElement('span');
    delStat.className = 'diff-stat-removed';
    delStat.textContent = '-' + removed + (removed === 1 ? ' line' : ' lines');
    const addStat = document.createElement('span');
    addStat.className = 'diff-stat-added';
    addStat.textContent = '+' + added + (added === 1 ? ' line' : ' lines');
    summary.appendChild(delStat);
    summary.appendChild(document.createTextNode('   '));
    summary.appendChild(addStat);
  }
  container.appendChild(summary);
}
