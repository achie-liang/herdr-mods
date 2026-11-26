import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveRefPath,
  formatRef,
  offsetToLineCol,
  formatSelectionRef,
  formatSelectionBadge,
  rangeToLineColSelection,
} from '../mods/ide-files/selection.js';

test('formatRef preserves line-only format and supports line+offset ranges', () => {
  assert.equal(formatRef('README.md', false), '@README.md');
  assert.equal(formatRef('docs/my file.md', false), '@"docs/my file.md"');
  assert.equal(formatRef('mods/ide-files/main.js', false, 12, 12), '@mods/ide-files/main.js#L12');
  assert.equal(formatRef('mods/ide-files/main.js', false, 12, 18), '@mods/ide-files/main.js#L12-L18');
  assert.equal(
    formatRef('mods/ide-files/main.js', false, 12, 12, 4, 15),
    '@mods/ide-files/main.js#L12:4-L12:15',
  );
  assert.equal(
    formatRef('mods/ide-files/main.js', false, 18, 12, 9, 3),
    '@mods/ide-files/main.js#L12:3-L18:9',
  );
  assert.equal(
    formatRef('mods/ide-files/main.js', false, 12, 12, 20, 5),
    '@mods/ide-files/main.js#L12:5-L12:20',
  );
});

test('formatSelectionRef uses line+offset for partial lines and line-only for whole lines', () => {
  const lines = [
    '# Title',
    'Hello world from markdown',
    'Second line here',
  ];

  // Partial single-line selection
  assert.equal(
    formatSelectionRef(
      'doc.md',
      { start: { lineNo: 2, col: 6 }, end: { lineNo: 2, col: 11 } },
      lines,
    ),
    '@doc.md#L2:6-L2:11',
  );

  // Partial multi-line selection
  assert.equal(
    formatSelectionRef(
      'doc.md',
      { start: { lineNo: 2, col: 6 }, end: { lineNo: 3, col: 6 } },
      lines,
    ),
    '@doc.md#L2:6-L3:6',
  );

  // Whole single-line selection (e.g. gutter click)
  assert.equal(
    formatSelectionRef(
      'doc.md',
      { start: { lineNo: 2, col: 0 }, end: { lineNo: 2, col: lines[1].length } },
      lines,
    ),
    '@doc.md#L2',
  );

  // Whole multi-line selection
  assert.equal(
    formatSelectionRef(
      'doc.md',
      { start: { lineNo: 1, col: 0 }, end: { lineNo: 3, col: lines[2].length } },
      lines,
    ),
    '@doc.md#L1-L3',
  );

  // Multi-line selection ending at col 0 of next line trims to end of previous line
  assert.equal(
    formatSelectionRef(
      'doc.md',
      { start: { lineNo: 1, col: 0 }, end: { lineNo: 3, col: 0 } },
      lines,
    ),
    '@doc.md#L1-L2',
  );
});

test('offsetToLineCol and rangeToLineColSelection map Markdown UTF-16 offsets accurately', () => {
  const md = '# Heading\n\nSome **bold** text\nand 中文 line\n';
  const lines = md.split(/\r?\n/);

  const boldStart = md.indexOf('**bold**');
  const boldEnd = boldStart + '**bold**'.length;
  assert.deepEqual(offsetToLineCol(md, boldStart), { lineNo: 3, col: 5 });
  assert.deepEqual(offsetToLineCol(md, boldEnd), { lineNo: 3, col: 13 });

  const mapped = rangeToLineColSelection(md, { start: boldStart, end: boldEnd }, 'bold', lines);
  assert.deepEqual(mapped.start, { lineNo: 3, col: 5 });
  assert.deepEqual(mapped.end, { lineNo: 3, col: 13 });
  assert.equal(formatSelectionRef('README.md', mapped, lines), '@README.md#L3:5-L3:13');
  assert.equal(formatSelectionBadge(mapped, lines), 'L3:5-L3:13');

  // Fallback text search when TextViewSelection.range is absent
  const fallbackMapped = rangeToLineColSelection(md, null, '中文 line', lines);
  assert.deepEqual(fallbackMapped.start, { lineNo: 4, col: 4 });
  assert.deepEqual(fallbackMapped.end, { lineNo: 4, col: 11 });
  assert.equal(formatSelectionRef('README.md', fallbackMapped, lines), '@README.md#L4:4-L4:11');

  // CRLF handling
  const crlf = 'line1\r\nline2\r\nline3';
  const crlfLines = crlf.split(/\r?\n/);
  const l2Start = crlf.indexOf('ne2');
  const l2End = crlf.indexOf('\r\n', l2Start);
  const crlfMapped = rangeToLineColSelection(crlf, { start: l2Start, end: l2End }, 'ne2', crlfLines);
  assert.deepEqual(crlfMapped.start, { lineNo: 2, col: 2 });
  assert.deepEqual(crlfMapped.end, { lineNo: 2, col: 5 });
});

test('resolveRefPath computes paths relative to agent cwd when Files root is lifted to git root', () => {
  assert.equal(
    resolveRefPath('mods/ide-files/main.js', '/repo', '/repo'),
    'mods/ide-files/main.js',
  );
  assert.equal(
    resolveRefPath('mods/ide-files/main.js', '/repo', '/repo/mods'),
    'ide-files/main.js',
  );
  assert.equal(
    resolveRefPath('README.md', '/repo', '/repo/mods'),
    '../README.md',
  );
  assert.equal(
    resolveRefPath('mods', '/repo', '/repo/mods'),
    '.',
  );
  assert.equal(
    resolveRefPath('mods/ide-files/main.js', '/ws/.worktree/feat/repo', '/ws/repo/mods'),
    '../../.worktree/feat/repo/mods/ide-files/main.js',
  );
});
