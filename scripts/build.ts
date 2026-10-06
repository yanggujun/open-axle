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
// Run with tsx:      npx tsx scripts/build.ts
// or with ts-node:   npx ts-node scripts/build.ts
// (wire it into package.json build:skills, e.g. "tsx scripts/build.ts").

import { build, BuildOptions, Metafile } from 'esbuild';
import { readdirSync, statSync, existsSync, Dirent, mkdirSync, cpSync } from 'fs';
import path, { join, sep } from 'path';

const SRC_SKILLS = 'src/skills';
const OUT_DIR = 'dist/skills';

// Modules that must NOT be bundled: the Electron runtime plus native/heavy
// dependencies. These stay as require(...) and are resolved at runtime.
const EXTERNALS: string[] = ['electron', 'ssh2', 'ssh2-sftp-client', 'openai'];

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
