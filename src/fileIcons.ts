/**
 * fileIcons.ts - per-file-type inline SVG icons for the right-dock Files tab.
 *
 * The Files tab (src/filesTab.ts) used to paint ONE shared emoji glyph for
 * every file, so every extension looked the same and rendering depended on an
 * OS emoji font that the panel's font stack never names ('Segoe UI', Tahoma,
 * Geneva, Verdana, sans-serif) - on some systems that glyph painted as a blank
 * square. This module replaces it with small inline SVG documents (a 16x16
 * viewBox) resolved per file NAME first and per EXTENSION second, in the same
 * spirit as VS Code's Seti icon theme.
 *
 * Two rendering styles are used, chosen per file kind:
 *
 *  - SOURCE-CODE files render as BARE LETTERS (labelIcon): no sheet, and the
 *    letterforms are painted in the app accent blue (#4fc3f7) so code files
 *    read as one distinct group beside the sheet-based format icons. Changing
 *    that single hex value retints every code icon at once.
 *  - DATA / DOCUMENT / BINARY formats render on a coloured document sheet with
 *    a folded corner plus a small schematic mark (sheet + MARK_*), where a
 *    shape reads faster at 16px than any abbreviation would.
 *
 * Everything is a plain string: no asset files, no network requests, no new
 * dependencies, and no CSP concerns (an inline <svg> issues no request).
 */

/** Build a tinted document sheet with an optional identifying mark. */
function sheet(color: string, mark = ''): string {
  return (
    '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">' +
    '<path d="M4.5 1h5.2L13 4.3v10.2a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 14.5V2.5A1.5 1.5 0 0 1 4.5 1Z" fill="' +
    color +
    '"/>' +
    '<path d="M9.7 1 13 4.3h-2.3a1 1 0 0 1-1-1Z" fill="#ffffff" fill-opacity="0.35"/>' +
    mark +
    '</svg>'
  );
}

/**
 * Render a short language label (initials such as 'TS', 'JS', 'C++') as a
 * COMPLETE, bare SVG document - no sheet, no folded corner, no fill colour.
 * Source-code files are identified by their letters alone.
 *
 * The letters are filled with the app accent blue #4fc3f7 - the same accent
 * used by .files-card-header and the focus ring in workingDir.css - so code
 * files read as visually distinct from the sheet-based format icons. A single
 * hex edit here retints every code icon at once.
 *
 * preserveAspectRatio="none" is required: the viewBox is square (16x16) while
 * workingDir.css sizes the icon box as 20x18, so without it the glyph area
 * would letterbox down to 18x18 and leave gaps at the sides.
 *
 * textLength/lengthAdjust stretch every label across the full icon width, and
 * the per-length font-size tiers keep the capitals nearly as tall as the box.
 */
function labelIcon(text: string): string {
  const n = text.length;
  // Sizes are deliberately BELOW the 16-unit viewBox height so the capitals
  // occupy roughly two thirds of the box and read at the same visual weight as
  // the document-sheet icons, instead of overflowing it.
  const size = n <= 1 ? 12 : n === 2 ? 11 : n === 3 ? 9.6 : 8.3;
  const textLength = n <= 1 ? '7' : n === 2 ? '11.5' : '11.8';
  // Sit the letterforms on the SAME baseline as the file name so their bottoms
  // line up with the text. Measured against workingDir.css:
  //   .files-item      -> line-height 18px, font-size 15px, align-items center
  //   .files-item-icon -> height 16px (so this 16-unit viewBox = 1px per unit)
  // A 15px Segoe UI run has ~19.95px of content area, so its half-leading in an
  // 18px line box is about -0.97px and the name's baseline lands ~15.2px from
  // the row top. The 16px icon box is centred in that 18px row, i.e. inset 1px,
  // so the baseline is ~14.2px from the icon's top edge. With 1 unit = 1px that
  // is y = 14.2. One FIXED value (never derived from font size) keeps every
  // label - J, PY, TS, CSS, SCSS - ending on the same line as the name.
  const baseline = '13.2';
  return (
    '<svg viewBox="0 0 16 16" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">' +
    '<text x="8" y="' + baseline + '" text-anchor="middle" font-family="sans-serif" font-weight="700"' +
    ' font-size="' +
    size +
    '" textLength="' +
    textLength +
    '" lengthAdjust="spacingAndGlyphs" fill="#4fc3f7">' +
    text +
    '</text>' +
    '</svg>'
  );
}

/* ---- identifying marks drawn inside the sheet (white, translucent) ---- */

const MARK_LINES =
  '<rect x="4.9" y="6.5" width="6.2" height="1.15" rx="0.575" fill="#ffffff" opacity="0.9"/>' +
  '<rect x="4.9" y="8.9" width="6.2" height="1.15" rx="0.575" fill="#ffffff" opacity="0.7"/>' +
  '<rect x="4.9" y="11.3" width="3.9" height="1.15" rx="0.575" fill="#ffffff" opacity="0.5"/>';

const MARK_BRACES =
  '<path d="M7.2 6.4c-0.75 0-1.05 0.4-1.05 1.1v0.5c0 0.5-0.3 0.8-0.8 0.85v0.15c0.5 0.05 0.8 0.35 0.8 0.85v0.5c0 0.7 0.3 1.1 1.05 1.1" fill="none" stroke="#ffffff" stroke-width="1.15" stroke-linecap="round" opacity="0.95"/>' +
  '<path d="M8.8 6.4c0.75 0 1.05 0.4 1.05 1.1v0.5c0 0.5 0.3 0.8 0.8 0.85v0.15c-0.5 0.05-0.8 0.35-0.8 0.85v0.5c0 0.7-0.3 1.1-1.05 1.1" fill="none" stroke="#ffffff" stroke-width="1.15" stroke-linecap="round" opacity="0.95"/>';


const MARK_DOWN =
  '<path d="M8 6.3v5.4M8 11.7 5.9 9.6M8 11.7 10.1 9.6" fill="none" stroke="#ffffff" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" opacity="0.95"/>';

const MARK_IMAGE =
  '<circle cx="10.4" cy="7.3" r="1" fill="#ffffff" opacity="0.95"/>' +
  '<path d="M4.9 12.7 7.2 9.6l1.7 1.8 1.4-1.6 1.6 2.9Z" fill="#ffffff" opacity="0.85"/>';

const MARK_LOCK =
  '<rect x="6" y="8.3" width="4" height="3.3" rx="0.8" fill="#ffffff" opacity="0.95"/>' +
  '<path d="M6.9 8.3V7.4a1.1 1.1 0 0 1 2.2 0v0.9" fill="none" stroke="#ffffff" stroke-width="1.1" opacity="0.85"/>';

const MARK_ARCHIVE =
  '<rect x="7.1" y="5.5" width="1.8" height="7" rx="0.5" fill="#ffffff" opacity="0.9"/>' +
  '<rect x="7.35" y="6.2" width="1.3" height="0.8" fill="#000000" opacity="0.22"/>' +
  '<rect x="7.35" y="8" width="1.3" height="0.8" fill="#000000" opacity="0.22"/>' +
  '<rect x="7.35" y="9.8" width="1.3" height="0.8" fill="#000000" opacity="0.22"/>';

const MARK_DB =
  '<ellipse cx="8" cy="7.2" rx="2.7" ry="1.15" fill="#ffffff" opacity="0.95"/>' +
  '<path d="M5.3 7.2v3.7c0 0.63 1.21 1.15 2.7 1.15s2.7-0.52 2.7-1.15V7.2" fill="none" stroke="#ffffff" stroke-width="1.1" opacity="0.85"/>';

const MARK_TERMINAL =
  '<path d="M5.7 7.2 7.5 9 5.7 10.8" fill="none" stroke="#ffffff" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" opacity="0.95"/>' +
  '<path d="M8.8 11h2.3" fill="none" stroke="#ffffff" stroke-width="1.2" stroke-linecap="round" opacity="0.95"/>';

const MARK_BOOKMARK =
  '<path d="M6.3 6.2h3.4v6.6L8 11.3l-1.7 1.5Z" fill="#ffffff" opacity="0.95"/>';

/* ---- one icon per language family (fixed, VS Code-like tints) ---- */

/* ---- source-code languages: bare letterforms, no sheet, no tint ---- */

const TS_ICON = labelIcon('TS');
const JS_ICON = labelIcon('JS');
const CSS_ICON = labelIcon('#');
const SCSS_ICON = labelIcon('#');
const SASS_ICON = labelIcon('#');
const HTML_ICON = labelIcon('<>');
const VUE_ICON = labelIcon('V');
const PY_ICON = labelIcon('PY');

/* ---- compiled / system languages: bare letterforms, no sheet, no tint ---- */

const JAVA_ICON = labelIcon('J');
const C_ICON = labelIcon('C');
const CPP_ICON = labelIcon('C++');
const CS_ICON = labelIcon('C#');
const GO_ICON = labelIcon('GO');
const RS_ICON = labelIcon('RS');
const RB_ICON = labelIcon('RB');
const PHP_ICON = labelIcon('P');
const KT_ICON = labelIcon('KT');
const SWIFT_ICON = labelIcon('SW');
const SCALA_ICON = labelIcon('SCL');
const LUA_ICON = labelIcon('LUA');
const R_ICON = labelIcon('R');
const DART_ICON = labelIcon('DART');

/* ---- data / document formats: schematic marks read better than letters ---- */

const JSON_ICON = sheet('#b5b53a', MARK_BRACES);
const NPM_ICON = sheet('#cb3837', MARK_BRACES);
const MD_ICON = sheet('#5c9fd6', MARK_DOWN);
const SQL_ICON = sheet('#e08a3c', MARK_DB);
const SH_ICON = sheet('#6ab04c', MARK_TERMINAL);
const YAML_ICON = sheet('#c1453f', MARK_LINES);
const CONF_ICON = sheet('#8a9199', MARK_LINES);
const ENV_ICON = sheet('#c9a227', MARK_LOCK);
const XML_ICON = sheet('#e07a3a', MARK_LINES);
const CSV_ICON = sheet('#5aa469', MARK_LINES);
const LOG_ICON = sheet('#9e9e9e', MARK_LINES);
const TXT_ICON = sheet('#9aa5b1', MARK_LINES);
const IMG_ICON = sheet('#a074c4', MARK_IMAGE);
const PDF_ICON = sheet('#e2504a', MARK_BOOKMARK);
const ZIP_ICON = sheet('#a8a8a8', MARK_ARCHIVE);
const LOCK_ICON = sheet('#8d8d8d', MARK_LOCK);
const KEY_ICON = sheet('#d4a72c', MARK_LOCK);
const BIN_ICON = sheet('#7a828c', MARK_LINES);
const DOC_ICON = sheet('#4a7fc1', MARK_LINES);
const XLS_ICON = sheet('#4a9c5f', MARK_LINES);
const PPT_ICON = sheet('#d2693c', MARK_LINES);
const GIT_ICON = sheet('#f05033', MARK_LINES);
const DOCKER_ICON = sheet('#2496ed', MARK_LINES);
const LICENSE_ICON = sheet('#b8b32c', MARK_LINES);


/** Fallback for files whose type is unknown (or that have no extension). */
export const DEFAULT_FILE_ICON = sheet('#8a9199', MARK_LINES);

/** The folder glyph (takes no per-entry variation). */
export const FOLDER_ICON_SVG =
  '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">' +
  '<path d="M1.6 3.3A1.3 1.3 0 0 1 2.9 2h3l1.6 1.8h5.6A1.3 1.3 0 0 1 14.4 5.1v8a1.3 1.3 0 0 1-1.3 1.3H2.9a1.3 1.3 0 0 1-1.3-1.3Z" fill="#dcb67a"/>' +
  '<path d="M1.6 6.2h12.8v6.9a1.3 1.3 0 0 1-1.3 1.3H2.9a1.3 1.3 0 0 1-1.3-1.3Z" fill="#ffffff" fill-opacity="0.18"/>' +
  '</svg>';

/**
 * Exact-name overrides. Keys are LOWERCASE file names. Checked before any
 * extension logic, which is what makes dotfiles work: '.gitignore' and '.env'
 * have a leading dot but no real extension, so they must never fall through to
 * the generic document icon when a known name matches.
 */
const NAME_ICONS: Record<string, string> = {
  'package.json': NPM_ICON,
  'package-lock.json': LOCK_ICON,
  'npm-shrinkwrap.json': LOCK_ICON,
  'yarn.lock': LOCK_ICON,
  'pnpm-lock.yaml': LOCK_ICON,
  'bun.lockb': LOCK_ICON,
  'cargo.lock': LOCK_ICON,
  'gemfile.lock': LOCK_ICON,
  'poetry.lock': LOCK_ICON,
  'composer.lock': LOCK_ICON,
  'tsconfig.json': TS_ICON,
  'jsconfig.json': TS_ICON,
  '.axle': JSON_ICON,
  '.gitignore': GIT_ICON,
  '.gitattributes': GIT_ICON,
  '.gitmodules': GIT_ICON,
  '.gitkeep': GIT_ICON,
  '.dockerignore': DOCKER_ICON,
  'dockerfile': DOCKER_ICON,
  'docker-compose.yml': DOCKER_ICON,
  'docker-compose.yaml': DOCKER_ICON,
  '.env': ENV_ICON,
  '.env.local': ENV_ICON,
  '.env.development': ENV_ICON,
  '.env.production': ENV_ICON,
  '.env.example': ENV_ICON,
  '.npmrc': CONF_ICON,
  '.nvmrc': CONF_ICON,
  '.editorconfig': CONF_ICON,
  '.prettierrc': CONF_ICON,
  '.prettierignore': CONF_ICON,
  '.eslintrc': CONF_ICON,
  '.eslintignore': CONF_ICON,
  '.babelrc': CONF_ICON,
  'license': LICENSE_ICON,
  'licence': LICENSE_ICON,
  'copying': LICENSE_ICON,
  'notice': LICENSE_ICON,
  'authors': LICENSE_ICON,
  'readme.md': MD_ICON,
  'readme': MD_ICON,
  'readme.txt': MD_ICON,
  'makefile': SH_ICON,
  'cmakelists.txt': SH_ICON,
  'procfile': CONF_ICON,
};

/** Compound suffixes checked before the final extension (longest first). */
const COMPOUND_SUFFIXES = [
  'tar.gz',
  'tar.bz2',
  'tar.xz',
  'd.ts',
  'd.mts',
  'd.cts',
  'min.js',
  'min.css',
  'module.css',
];

const COMPOUND_ICONS: Record<string, string> = {
  'tar.gz': ZIP_ICON,
  'tar.bz2': ZIP_ICON,
  'tar.xz': ZIP_ICON,
  'd.ts': TS_ICON,
  'd.mts': TS_ICON,
  'd.cts': TS_ICON,
  'min.js': JS_ICON,
  'min.css': CSS_ICON,
  'module.css': CSS_ICON,
};

/** Extension -> icon. Keys are LOWERCASE and carry no leading dot. */
const EXT_ICONS: Record<string, string> = {
  ts: TS_ICON,
  tsx: TS_ICON,
  mts: TS_ICON,
  cts: TS_ICON,
  js: JS_ICON,
  jsx: JS_ICON,
  mjs: JS_ICON,
  cjs: JS_ICON,
  json: JSON_ICON,
  jsonc: JSON_ICON,
  json5: JSON_ICON,
  md: MD_ICON,
  mdx: MD_ICON,
  markdown: MD_ICON,
  rst: MD_ICON,
  css: CSS_ICON,
  less: CSS_ICON,
  scss: SCSS_ICON,
  sass: SASS_ICON,
  styl: SCSS_ICON,
  html: HTML_ICON,
  htm: HTML_ICON,
  svelte: HTML_ICON,
  vue: VUE_ICON,
  py: PY_ICON,
  pyi: PY_ICON,
  ipynb: PY_ICON,
  sql: SQL_ICON,
  sh: SH_ICON,
  bash: SH_ICON,
  zsh: SH_ICON,
  fish: SH_ICON,
  ps1: SH_ICON,
  bat: SH_ICON,
  cmd: SH_ICON,
  yml: YAML_ICON,
  yaml: YAML_ICON,
  toml: CONF_ICON,
  ini: CONF_ICON,
  conf: CONF_ICON,
  cfg: CONF_ICON,
  properties: CONF_ICON,
  env: ENV_ICON,
  xml: XML_ICON,
  xsd: XML_ICON,
  xsl: XML_ICON,
  csv: CSV_ICON,
  tsv: CSV_ICON,
  log: LOG_ICON,
  txt: TXT_ICON,
  text: TXT_ICON,
  png: IMG_ICON,
  jpg: IMG_ICON,
  jpeg: IMG_ICON,
  gif: IMG_ICON,
  webp: IMG_ICON,
  bmp: IMG_ICON,
  ico: IMG_ICON,
  svg: IMG_ICON,
  avif: IMG_ICON,
  tiff: IMG_ICON,
  pdf: PDF_ICON,
  zip: ZIP_ICON,
  tar: ZIP_ICON,
  tgz: ZIP_ICON,
  gz: ZIP_ICON,
  bz2: ZIP_ICON,
  xz: ZIP_ICON,
  rar: ZIP_ICON,
  '7z': ZIP_ICON,
  lock: LOCK_ICON,
  pem: KEY_ICON,
  key: KEY_ICON,
  crt: KEY_ICON,
  cer: KEY_ICON,
  p12: KEY_ICON,
  pfx: KEY_ICON,
  wasm: BIN_ICON,
  so: BIN_ICON,
  dll: BIN_ICON,
  exe: BIN_ICON,
  o: BIN_ICON,
  bin: BIN_ICON,
  class: BIN_ICON,
  doc: DOC_ICON,
  docx: DOC_ICON,
  rtf: DOC_ICON,
  odt: DOC_ICON,
  xls: XLS_ICON,
  xlsx: XLS_ICON,
  ods: XLS_ICON,
  ppt: PPT_ICON,
  pptx: PPT_ICON,
  odp: PPT_ICON,
  java: JAVA_ICON,
  kt: KT_ICON,
  kts: KT_ICON,
  cs: CS_ICON,
  go: GO_ICON,
  rs: RS_ICON,
  rb: RB_ICON,
  php: PHP_ICON,
  c: C_ICON,
  h: C_ICON,
  hh: C_ICON,
  cpp: CPP_ICON,
  cc: CPP_ICON,
  cxx: CPP_ICON,
  hpp: CPP_ICON,
  hxx: CPP_ICON,
  swift: SWIFT_ICON,
  scala: SCALA_ICON,
  lua: LUA_ICON,
  r: R_ICON,
  dart: DART_ICON,
};

/**
 * Resolve the inline SVG icon for one directory entry.
 *
 * Order: folder -> exact file NAME (lowercased) -> compound suffix
 * ('.tar.gz', '.d.ts', ...) -> last extension -> generic document icon. The
 * leading-dot guard (dot > 0) keeps '.gitignore'-style names from being read as
 * 'the extension is gitignore' when they miss the exact-name table.
 */
export function getFileIcon(name: string, isFolder: boolean): string {
  if (isFolder) return FOLDER_ICON_SVG;

  const lower = (name || '').toLowerCase();
  if (!lower) return DEFAULT_FILE_ICON;

  const byName = NAME_ICONS[lower];
  if (byName) return byName;

  for (const suffix of COMPOUND_SUFFIXES) {
    if (lower.endsWith('.' + suffix)) {
      const hit = COMPOUND_ICONS[suffix];
      if (hit) return hit;
    }
  }

  const dot = lower.lastIndexOf('.');
  if (dot > 0) {
    const byExt = EXT_ICONS[lower.slice(dot + 1)];
    if (byExt) return byExt;
  }

  return DEFAULT_FILE_ICON;
}
