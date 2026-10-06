#!/usr/bin/env node
'use strict';

/**
 * Dynamic version computation.
 *
 * Format: MAJOR.MINOR.BUILD_NUMBER-REVISION
 *   - MAJOR / MINOR : copied from the existing "version" in package.json
 *   - BUILD_NUMBER  : whole days elapsed from 2026-07-17 to today
 *   - REVISION      : last 4 digits of Date.now(); regenerated until the
 *                     first digit is not '0'
 *
 * This module is PURE by default: computeVersion() only RETURNS the string and
 * does NOT touch package.json. Running this file directly prints the version;
 * pass --write to additionally update package.json's "version" field.
 */

const fs = require('fs');
const path = require('path');

const PKG_PATH = path.resolve(__dirname, '..', 'package.json');

// Anchor date for the BUILD_NUMBER counter (local midnight).
const BASE_DATE = new Date('2026-07-17T00:00:00');
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * BUILD_NUMBER = whole days elapsed from BASE_DATE to `now`.
 * @param {Date} now
 * @returns {number}
 */
function computeBuildNumber(now) {
  return Math.floor((now.getTime() - BASE_DATE.getTime()) / MS_PER_DAY);
}

/**
 * REVISION = last 4 digits of the current time in milliseconds.
 * If the first digit is '0', advance the timestamp and recalculate until the
 * first digit is not '0'.
 * @returns {string}
 */
function computeRevision() {
  let ts = Date.now();
  let revision = String(ts).slice(-4);

  let guard = 0;
  while (revision.charAt(0) === '0' && guard < 100000) {
    ts += 1;
    revision = String(ts).slice(-4);
    guard += 1;
  }

  return revision;
}

/**
 * Read MAJOR.MINOR from the current package.json "version".
 * @returns {{ major: string, minor: string }}
 */
function readMajorMinor() {
  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
  const current = String(pkg.version || '0.0.0');
  const parts = current.split('.');
  return {
    major: parts[0] && parts[0].length ? parts[0] : '0',
    minor: parts[1] && parts[1].length ? parts[1] : '0',
  };
}

/**
 * Compute the dynamic version string. Does NOT modify package.json.
 * @returns {string}
 */
function computeVersion() {
  const { major, minor } = readMajorMinor();
  const buildNumber = computeBuildNumber(new Date());
  const revision = computeRevision();
  return `${major}.${minor}.${buildNumber}-${revision}`;
}

/**
 * Compute the version and write it back into package.json (opt-in only).
 * @returns {string} the written version
 */
function writeVersion() {
  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
  pkg.version = computeVersion();
  fs.writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  return pkg.version;
}

module.exports = {
  computeVersion,
  computeBuildNumber,
  computeRevision
};
