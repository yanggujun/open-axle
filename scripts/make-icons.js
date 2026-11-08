/* eslint-disable */
/**
 * Generates the raster icon assets from resources/app-icon.svg.
 *
 * WHY THIS EXISTS
 * ---------------
 * Electron, electron-forge and electron-packager cannot consume an SVG as an
 * application icon: the window icon needs a PNG/ICO and the packaged
 * executable needs a Windows .ico and a macOS .icns. This machine has no
 * sharp / png2icons / ImageMagick / rsvg-convert / inkscape available, but it
 * DOES have Electron, so Chromium is used as the SVG rasterizer: the SVG is
 * drawn into a <canvas> at each exact target pixel size (crisp even at 16px)
 * and exported as PNG. The ICO and ICNS containers are then assembled in pure
 * JavaScript (both formats accept embedded PNG payloads).
 *
 * USAGE
 *   node_modules/.bin/electron.cmd scripts/make-icons.js     (Windows)
 *   node_modules/.bin/electron scripts/make-icons.js         (macOS/Linux)
 *
 * OUTPUT
 *   build/app-icon.png        512x512  (linux packager icon)
 *   build/app-icon-256.png    256x256
 *   build/app-icon.ico        Windows exe icon (16..256 multi-resolution)
 *   build/app-icon.icns       macOS bundle icon
 *   resources/app-icon.png    512x512  (runtime window / dock icon, shipped
 *                                       through packagerConfig.extraResource)
 */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SVG_PATH = path.join(ROOT, 'resources', 'app-icon.svg');
const BUILD_DIR = path.join(ROOT, 'build');
const RES_DIR = path.join(ROOT, 'resources');

// Sizes rendered once and reused for every output container.
const SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
// Windows .ico entries (256 is stored with 0 in the directory, per spec).
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
// macOS .icns entries: type tag -> pixel size.
const ICNS_ENTRIES = [
  ['icp4', 16],
  ['icp5', 32],
  ['icp6', 64],
  ['ic07', 128],
  ['ic08', 256],
  ['ic09', 512],
  ['ic10', 1024],
  ['ic11', 32],
  ['ic12', 64],
  ['ic13', 256],
  ['ic14', 512],
];

/**
 * Builds a Windows .ico file. Every entry stores PNG bytes directly, which is
 * supported by Windows Vista and later (all supported Windows versions).
 *
 * Layout: ICONDIR (6 bytes) + ICONDIRENTRY[n] (16 bytes each) + image data.
 */
function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(images.length, 4);

  const entries = Buffer.alloc(16 * images.length);
  let offset = 6 + 16 * images.length;

  images.forEach((img, i) => {
    const e = i * 16;
    // Width/height of 0 encodes 256 in the directory entry.
    entries.writeUInt8(img.size >= 256 ? 0 : img.size, e + 0);
    entries.writeUInt8(img.size >= 256 ? 0 : img.size, e + 1);
    entries.writeUInt8(0, e + 2); // palette colour count (0 = no palette)
    entries.writeUInt8(0, e + 3); // reserved
    entries.writeUInt16LE(1, e + 4); // colour planes
    entries.writeUInt16LE(32, e + 6); // bits per pixel
    entries.writeUInt32LE(img.png.length, e + 8);
    entries.writeUInt32LE(offset, e + 12);
    offset += img.png.length;
  });

  return Buffer.concat([header, entries, ...images.map((i) => i.png)]);
}

/**
 * Builds a macOS .icns file. Each entry is `type` (4 ASCII bytes) + total
 * entry length (4 bytes big-endian, including the 8-byte header) + PNG data,
 * wrapped in the `icns` container header.
 */
function buildIcns(entries) {
  const chunks = entries.map(({ type, png }) => {
    const head = Buffer.alloc(8);
    head.write(type, 0, 4, 'ascii');
    head.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([head, png]);
  });

  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 4, 'ascii');
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

/** Rasterizes the SVG into a PNG Buffer at exactly `size` x `size` pixels. */
async function renderPng(win, svgDataUrl, size) {
  const script = `(() => new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = ${size};
        c.height = ${size};
        const ctx = c.getContext('2d');
        ctx.clearRect(0, 0, ${size}, ${size});
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, ${size}, ${size});
        resolve(c.toDataURL('image/png'));
      } catch (e) {
        reject(String(e));
      }
    };
    img.onerror = () => reject('failed to load the SVG image');
    img.src = ${JSON.stringify(svgDataUrl)};
  }))()`;

  const dataUrl = await win.webContents.executeJavaScript(script, true);
  const prefix = 'data:image/png;base64,';
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith(prefix)) {
    throw new Error(`unexpected canvas output for size ${size}`);
  }
  return Buffer.from(dataUrl.slice(prefix.length), 'base64');
}

async function main() {
  if (!fs.existsSync(SVG_PATH)) {
    throw new Error(`icon source not found: ${SVG_PATH}`);
  }
  fs.mkdirSync(BUILD_DIR, { recursive: true });

  // The SVG is already well-formed and carries xmlns, so it can be fed to an
  // <img> straight from a data: URL. Base64 keeps multi-byte characters and
  // '#'/'%' sequences intact without escaping concerns.
  const svg = fs.readFileSync(SVG_PATH, 'utf8');
  const svgDataUrl =
    'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64');

  // A hidden window provides the Chromium renderer that does the rasterizing.
  const win = new BrowserWindow({
    show: false,
    width: 64,
    height: 64,
    webPreferences: { offscreen: false, contextIsolation: true },
  });
  await win.loadURL('about:blank');

  const pngs = new Map();
  for (const size of SIZES) {
    pngs.set(size, await renderPng(win, svgDataUrl, size));
    console.log(`[icons] rendered ${size}x${size}`);
  }

  win.destroy();

  // Plain PNGs used by the linux packager and by the runtime window icon.
  const png512 = pngs.get(512);
  const png256 = pngs.get(256);
  fs.writeFileSync(path.join(BUILD_DIR, 'app-icon.png'), png512);
  fs.writeFileSync(path.join(BUILD_DIR, 'app-icon-256.png'), png256);
  fs.writeFileSync(path.join(RES_DIR, 'app-icon.png'), png512);

  // Windows executable icon.
  const ico = buildIco(ICO_SIZES.map((size) => ({ size, png: pngs.get(size) })));
  fs.writeFileSync(path.join(BUILD_DIR, 'app-icon.ico'), ico);

  // macOS bundle icon.
  const icns = buildIcns(
    ICNS_ENTRIES.map(([type, size]) => ({ type, png: pngs.get(size) }))
  );
  fs.writeFileSync(path.join(BUILD_DIR, 'app-icon.icns'), icns);

  const report = [
    path.join(BUILD_DIR, 'app-icon.png'),
    path.join(BUILD_DIR, 'app-icon-256.png'),
    path.join(BUILD_DIR, 'app-icon.ico'),
    path.join(BUILD_DIR, 'app-icon.icns'),
    path.join(RES_DIR, 'app-icon.png'),
  ];
  for (const file of report) {
    console.log(`[icons] wrote ${path.relative(ROOT, file)} (${fs.statSync(file).size} bytes)`);
  }
}

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  try {
    await main();
    app.exit(0);
  } catch (err) {
    console.error('[icons] generation failed:', err);
    app.exit(1);
  }
});
