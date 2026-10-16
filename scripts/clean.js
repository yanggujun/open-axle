#!/usr/bin/env node
'use strict';

const fs = require('fs');

/**
 * Remove a directory tree if it exists.
 * @param {string} dir - Directory to remove (relative or absolute).
 */
function removeDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Clean the project's build artifacts.
 * @param {string[]} [targets] - Directories to clean. Defaults to ['out', 'dist'].
 * @returns {string[]} The list of directories that were cleaned.
 */
function clean(targets = ['out', 'dist']) {
  for (const target of targets) {
    removeDir(target);
  }
  return targets;
}

if (require.main === module) {
  const cleaned = clean();
  console.log(`Cleaned: ${cleaned.join(', ')}`);
}

module.exports = { clean, removeDir };
