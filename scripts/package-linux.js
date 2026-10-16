const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { computeVersion } = require('./version.js');

function packageLinux() {
  const version = computeVersion();
  const outDir = 'out';
  const entries = fs.readdirSync(outDir);
  const dir = entries.find((name) => name.startsWith('Open-Axle-linux'));
  if (!dir) {
    throw new Error(`Could not find a directory in "${outDir}" whose name starts with "Open-Axle-linux"`);
  }
  const archive = path.join(outDir, `Open-Axle-linux-${version}.tar.gz`);
  execSync(`tar -czf ${archive} -C ${outDir} ${dir}`, { stdio: 'inherit' });
  console.log(`Created ${archive}`);
}

if (require.main === module) {
  packageLinux();
}

module.exports = { packageLinux };
