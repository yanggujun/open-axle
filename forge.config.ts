import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { WebpackPlugin } from '@electron-forge/plugin-webpack';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';

import { mainConfig } from './webpack.main.config';
import { rendererConfig } from './webpack.renderer.config';

// Dynamically compute the build version (MAJOR.MINOR.BUILD_NUMBER-REVISION)
// without modifying package.json. This value is baked into the packaged app
// (artifact names, installer metadata, and app.getVersion() at runtime).
import { computeVersion } from './scripts/version';

// Compute the version ONCE so that the packaged app's runtime version
// (packagerConfig.appVersion -> app.getVersion()) and the makers' artifact
// metadata (packageJSON.version, injected via the readPackageJson hook below)
// are guaranteed to be identical. computeVersion() is time-based, so calling
// it twice would otherwise yield two different REVISION values.
const dynamicVersion = computeVersion();

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    // Dynamic build version; overrides the version recorded in package.json
    // for the packaged application only (package.json is never rewritten).
    appVersion: dynamicVersion,
    // Ship the COMPILED skills folder OUTSIDE app.asar so it is readable via fs
    // at process.resourcesPath/skills in packaged builds. This MUST point at the
    // build output (dist/skills, produced by `npm run build:skills`) rather than
    // the source tree (src/skills): the runtime (discoverExecutors) loads only
    // .js modules from process.resourcesPath/skills, and build:skills also copies
    // the @sap/hana-client `prebuilt` natives into dist/skills/prebuilt. Pointing
    // extraResource at src/skills shipped only .ts/.md sources (no .js, no
    // prebuilt), so the packaged app had no loadable skills. The folder basename
    // stays `skills`, so it still lands at resources/skills. Data/resource files
    // under resources/ are unaffected by the OnlyLoadAppFromAsar /
    // EnableEmbeddedAsarIntegrityValidation fuses, which only govern loading
    // application CODE from the asar.
    extraResource: ['./dist/skills'],
  },
  hooks: {
    // Electron Forge makers (Squirrel/ZIP/Rpm/Deb) build their artifact and
    // installer names from the `packageJSON` object that make() obtains via
    // readMutatedPackageJson() -- NOT from packagerConfig.appVersion. Without
    // this hook the makers keep using the static version in package.json (e.g.
    // 0.1.0) and ignore the computed version entirely. This mutating hook
    // injects the same `dynamicVersion` used for appVersion, so the make output
    // (Setup.exe, .nupkg, .zip, .deb, .rpm) matches app.getVersion().
    readPackageJson: async (_forgeConfig, packageJson) => {
      packageJson.version = dynamicVersion;
      return packageJson;
    },
    // Guard: fail packaging loudly if the skills build output is missing.
    // `npm run build:skills` (esbuild + copyHanaClientNatives) produces
    // dist/skills/*.js and dist/skills/prebuilt. extraResource ships
    // dist/skills to resources/skills, and the runtime only loads .js from
    // there. Without this check a packaging run that skipped the build (or
    // whose hana-client copy failed) would silently ship a zip with no
    // loadable skills / no prebuilt natives.
    prePackage: async () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const fs = require('fs') as typeof import('fs');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const path = require('path') as typeof import('path');
      const skillsDir = path.resolve(__dirname, 'dist', 'skills');
      const prebuiltDir = path.join(skillsDir, 'prebuilt');
      if (!fs.existsSync(skillsDir) || !fs.statSync(skillsDir).isDirectory()) {
        throw new Error(
          `[forge] Skills build output not found at ${skillsDir}. ` +
            'Run `npm run build:skills` (or use the npm package/make scripts, which run the build) before packaging.'
        );
      }
      if (!fs.existsSync(prebuiltDir) || !fs.statSync(prebuiltDir).isDirectory()) {
        throw new Error(
          `[forge] Skills prebuilt natives not found at ${prebuiltDir}. ` +
            'The @sap/hana-client prebuilt copy in scripts/build.ts did not produce output; refusing to package a zip missing it.'
        );
      }
    },
  },
  rebuildConfig: {},
  makers: [
    new MakerZIP({}, ['darwin']),
    new MakerZIP({}, ['linux']),
    new MakerZIP({}, ['win32']),
    // package.json `name` is "open-axle" while productName/executableName is
    // "Open-Axle". The deb/rpm installers default the expected binary to the
    // package.json `name` ("open-axle"), so they fail with
    // "could not find the Electron app binary at .../open-axle".
    // Pin options.bin (and productName) to the actual packaged executable name.
    new MakerRpm({
      options: {
        bin: 'Open-Axle',
        productName: 'Open-Axle',
      },
    }),
    new MakerDeb({
      options: {
        bin: 'Open-Axle',
        productName: 'Open-Axle',
      },
    }),
  ],
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new WebpackPlugin({
      devContentSecurityPolicy:
        "default-src 'self' 'unsafe-inline' data:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; connect-src 'self' ws://127.0.0.1:9393 ws://localhost:9393",
      mainConfig,
      renderer: {
        config: rendererConfig,
        entryPoints: [
          {
            html: './src/index.html',
            js: './src/renderer.ts',
            name: 'main_window',
            preload: {
              js: './src/preload.ts',
            },
          },
        ],
      },
      port:9100,
      loggerPort:9101
    }),
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
