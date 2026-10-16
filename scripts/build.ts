// scripts/build.ts
// Reliable skill bundler written in TypeScript.
//
// Recursively scans src/skills for *.ts entry files and bundles each into
// dist/skills preserving folder structure. Using an explicit entryPoints
// array (from a Node directory scan) avoids the unreliable CLI '**' glob
// expansion on Windows, which can match zero files and emit nothing.
//
// Shared modules imported by a skill (e.g. ../../core/executor) are followed
// by esbuild and INLINED into each skill's output, so the runtime file:// //
// dynamic import loads a self-contained module (no broken relative requires).
//
// Additionally, src/common/common.ts is bundled with esbuild into
// dist/common/common.js so the common folder sits on the same level as
// dist/skills in the output (output/skills + output/common side by side),
// letting skill executors resolve the shared common module from the released
// package. For this bundle the dependencies of common.ts (e.g. ssh2) are
// INLINED into the output as well; only the Electron runtime stays external.
//
// Markdown documentation (*.md) placed next to the skill sources under
// src/skills is copied into dist/skills at the same relative path so the
// released package keeps skill code and docs together.
//
// Run with tsx:      npx tsx scripts/build.ts
// or with ts-node:   npx ts-node scripts/build.ts
// (wire it into package.json build:skills, e.g. "tsx scripts/build.ts").

import { build, BuildOptions, Metafile } from 'esbuild';
import { readdirSync, statSync, existsSync, Dirent, mkdirSync, cpSync, copyFileSync } from 'fs';
import path, { join, sep } from 'path';

const OUT_ROOT = 'dist';
const SRC_SKILLS = 'src/skills';
const OUT_DIR = `${OUT_ROOT}/skills`;

// Shared common entry: bundled separately with esbuild into dist/common,
// which sits on the same level as dist/skills so skill executors can find
// the released common module (dist/skills + dist/common side by side).
const SRC_COMMON_DIR = 'src/common';
const COMMON_ENTRY = join(SRC_COMMON_DIR, 'common.ts');
const OUT_COMMON_DIR = `${OUT_ROOT}/common`;
const EXTERNALS: string[] = ['electron', 'openai', '*.node'];


// For the shared common bundle only the Electron runtime stays external.
// Dependencies of common.ts (e.g. ssh2) are bundled with it so the released
// package contains a self-contained common module.
const COMMON_EXTERNALS: string[] = ['electron'];

// Directories that should never be scanned for entry points.
const SKIP_DIRS = new Set<string>(['node_modules', '.git', 'dist', 'build', '__pycache__']);

/** Recursively collect all .ts entry files under a directory (excluding .d.ts). */
function collectTsFiles(dir: string, out: string[] = []): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      collectTsFiles(full, out);
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Recursively collect all *.md files under a directory. */
function collectMdFiles(dir: string, out: string[] = []): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      collectMdFiles(full, out);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

/** Copy every *.md file under src/skills into dist/skills at the same relative path. */
function copyMdFiles(): void {
  const mdFiles = collectMdFiles(SRC_SKILLS);
  console.log(`[build] Found ${mdFiles.length} markdown file(s) under ${SRC_SKILLS}`);
  for (const src of mdFiles) {
    const rel = path.relative(SRC_SKILLS, src);
    const dest = join(OUT_DIR, rel);
    mkdirSync(path.dirname(dest), { recursive: true });
    copyFileSync(src, dest);
    console.log(`[build]   copied md: ${rel.split(sep).join('/')}`);
  }
}

/** Bundle src/common/common.ts into dist/common (esbuild, CJS, bundled deps). */
async function bundleCommon(): Promise<void> {
  if (!existsSync(COMMON_ENTRY)) {
    console.error(`[build] Common entry not found: ${COMMON_ENTRY}`);
    process.exit(1);
  }

  const options: BuildOptions = {
    entryPoints: [COMMON_ENTRY],
    outbase: SRC_COMMON_DIR,
    outdir: OUT_COMMON_DIR,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    sourcemap: true,
    logLevel: 'info',
    // Dependencies like ssh2 are intentionally NOT external here so esbuild
    // bundles them together with common.ts into a self-contained output.
    external: COMMON_EXTERNALS,
    metafile: true,
  };

  const result = await build(options);

  const metafile: Metafile | undefined = result.metafile;
  const outputs = metafile ? Object.keys(metafile.outputs) : [];
  console.log(`[build] Wrote ${outputs.length} common output file(s) under ${OUT_COMMON_DIR}:`);
  for (const o of outputs) {
    console.log(`[build]   output: ${o.split('/').join(sep)}`);
  }
}

async function main(): Promise<void> {
  if (!existsSync(SRC_SKILLS) || !statSync(SRC_SKILLS).isDirectory()) {
    console.error(`[build] Source directory not found: ${SRC_SKILLS}`);
    process.exit(1);
  }

  const entryPoints = collectTsFiles(SRC_SKILLS);
  console.log(`[build] Found ${entryPoints.length} skill entry point(s) under ${SRC_SKILLS}`);
  for (const ep of entryPoints) {
    console.log(`[build]   entry: ${ep}`);
  }

  if (entryPoints.length === 0) {
    console.error('[build] No entry points matched. Verify src/skills contains *.ts files (e.g. src/skills/cmd-runner/cmd-runner.ts).');
    process.exit(1);
  }

  const options: BuildOptions = {
    entryPoints,
    outbase: SRC_SKILLS,
    outdir: OUT_DIR,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    sourcemap: true,
    logLevel: 'info',
    external: EXTERNALS,
    metafile: true,
  };

  const result = await build(options);

  const metafile: Metafile | undefined = result.metafile;
  const outputs = metafile ? Object.keys(metafile.outputs) : [];
  console.log(`[build] Wrote ${outputs.length} output file(s):`);
  for (const o of outputs) {
    console.log(`[build]   output: ${o.split('/').join(sep)}`);
  }

  // Build the shared common module into dist/common (same level as dist/skills).
  // await bundleCommon();

  // Ship the skill *.md docs next to the compiled skills in dist/skills.
  copyMdFiles();

  copyHanaClientNatives();
  console.log('[build] Skill bundling complete.');
}
  function copyHanaClientNatives(): void {
    const srcDir = path.resolve(
      __dirname,
      '../node_modules/@sap/hana-client/prebuilt'
    );
    const destDir = path.resolve(
      __dirname,
      '../dist/skills/prebuilt'
    );

    if (!existsSync(srcDir)) {
      throw new Error(`Source folder not found: ${srcDir}`);
    }

    mkdirSync(destDir, { recursive: true });

    // Node 16.7+: recursive copy of the whole prebuilt tree (keeps ntamd64/, etc.)
    cpSync(srcDir, destDir, { recursive: true });

    console.log(`Copied native binaries:\n  ${srcDir}\n  -> ${destDir}`);
}


main().catch((err) => {
  console.error('[build] Build failed:', err);
  process.exit(1);
});
