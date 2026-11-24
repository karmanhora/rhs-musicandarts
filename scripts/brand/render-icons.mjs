#!/usr/bin/env node
/**
 * Renders the PNG app icons from `public/logo.svg` using a headless Chrome.
 *
 *   node scripts/brand/render-icons.mjs
 *
 * Why a real browser: `public/logo.svg` is the single source of truth for the
 * mark, so the PNGs you install to a home screen must be a render *of that
 * file* rather than a second drawing that slowly drifts out of sync. Chrome is
 * the rasterizer we always have on hand — no npm dependency, no ImageMagick.
 *
 * The variants the manifest and iOS need:
 *   badge     the rounded badge on transparency (purpose "any")
 *   full      the green square, no rounding — iOS masks apple-touch-icon itself
 *   maskable  full bleed, glyph pulled inside the 80% safe circle (Android)
 *
 * The iOS app icon is also rendered here so it never drifts from the web mark.
 * It is opaque because App Store Connect rejects app icons with alpha.
 *
 * When the real artwork arrives, replace `public/logo.svg` and re-run this. If
 * the new mark is not a full-bleed square, adjust `svgFor()` below — nothing
 * else needs to change.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const svgPath = join(root, "public", "logo.svg");
const publicDir = join(root, "public");
const iosAppIconDir = join(root, "ios", "App", "App", "Assets.xcassets", "AppIcon.appiconset");

/** Rounding of the shipped badge, and the glyph scale inside the Android safe zone. */
const BADGE_RADIUS = 112;
const MASKABLE_SCALE = 0.72;

const TARGETS = [
  { file: "apple-touch-icon.png", size: 180, mode: "full" },
  { file: "icon-192.png", size: 192, mode: "badge" },
  { file: "icon-512.png", size: 512, mode: "badge" },
  { file: "icon-maskable-192.png", size: 192, mode: "maskable" },
  { file: "icon-maskable-512.png", size: 512, mode: "maskable" },
  { file: "AppIcon-512@2x.png", size: 1024, mode: "full", dir: iosAppIconDir, opaque: true },
];

/**
 * Headless Chrome clamps tiny `--window-size` values (a 180x180 window silently
 * becomes ~500px wide and the screenshot crops the wrong region), so every
 * target is laid out in a 512x512 viewport and scaled down to its real size
 * with `--force-device-scale-factor`, which lands pixel-exact: the screenshot
 * is `viewport x scale` device pixels.
 */
const RENDER_VIEWPORT = 512;

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean);

function findChrome() {
  const found = CHROME_CANDIDATES.find((p) => existsSync(p));
  if (!found) {
    throw new Error(
      "No Chrome/Edge found. Set CHROME_PATH to a Chromium binary, or re-export the PNGs by hand.",
    );
  }
  return found;
}

/** The SVG for a target, with the two edits the variants need. Asserted, so a
 *  change to logo.svg that breaks the substitution fails loudly here. */
function svgFor(mode) {
  const svg = readFileSync(svgPath, "utf8");
  if (mode === "badge") return svg;

  const squared = svg.replace(`rx="${BADGE_RADIUS}"`, 'rx="0"');
  if (squared === svg) {
    throw new Error(`logo.svg no longer has rx="${BADGE_RADIUS}" on the badge — update BADGE_RADIUS.`);
  }
  if (mode === "full") return squared;

  const scaled = squared.replace(
    'id="mark" transform="translate(-4,-14)"',
    `id="mark" transform="translate(256 256) scale(${MASKABLE_SCALE}) translate(-256 -256) translate(-4,-14)"`,
  );
  if (scaled === squared) {
    throw new Error("logo.svg no longer has the expected #mark transform — update svgFor().");
  }
  return scaled;
}

function htmlFor(mode) {
  return `<!doctype html>
<meta charset="utf-8">
<title>icon</title>
<style>
  html, body { margin: 0; padding: 0; background: transparent; }
  svg { display: block; width: 100vw; height: 100vh; }
</style>
${svgFor(mode)}
`;
}

function render(chrome, htmlPath, outPath, size, profileDir, opaque) {
  // Chrome clamps small window sizes and device scale factors. The app icon is
  // large enough to render one-to-one at 1024px; the smaller web icons keep the
  // 512px layout and scale down to their exact size.
  const viewport = Math.max(size, RENDER_VIEWPORT);
  execFileSync(
    chrome,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-sync",
      "--hide-scrollbars",
      `--force-device-scale-factor=${size / viewport}`,
      // Transparent icons need an alpha channel; the iOS app icon must not
      // have one, so it is rendered against the brand green instead.
      `--default-background-color=${opaque ? "ff214d35" : "00000000"}`,
      `--user-data-dir=${profileDir}`,
      `--window-size=${viewport},${viewport}`,
      `--screenshot=${outPath}`,
      pathToFileURL(htmlPath).href,
    ],
    { stdio: ["ignore", "ignore", "pipe"], timeout: 60_000 },
  );
  const bytes = statSync(outPath).size;
  if (bytes === 0) throw new Error(`${outPath} is empty — the render produced nothing.`);
  return bytes;
}

/** PNG stores the dimensions and colour type in IHDR (bytes 16–25). */
function pngInfo(file) {
  const buf = readFileSync(file);
  const sig = buf.subarray(0, 8).toString("hex");
  if (sig !== "89504e470d0a1a0a") throw new Error(`${file} is not a PNG.`);
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    // 2 = truecolour (RGB), 6 = truecolour with alpha (RGBA).
    colorType: buf.readUInt8(25),
  };
}

const requested = new Set(process.argv.slice(2));
const targets = requested.size
  ? TARGETS.filter((target) => requested.has(target.file))
  : TARGETS;
if (targets.length === 0) {
  throw new Error(`No icon target matched: ${[...requested].join(", ")}`);
}

const chrome = findChrome();
const workDir = mkdtempSync(join(tmpdir(), "rhs-icons-"));
const profileDir = join(workDir, "profile");

try {
  for (const target of targets) {
    const htmlPath = join(workDir, `${target.mode}-${target.size}.html`);
    const outPath = join(target.dir ?? publicDir, target.file);
    writeFileSync(htmlPath, htmlFor(target.mode));
    const bytes = render(chrome, htmlPath, outPath, target.size, profileDir, target.opaque);
    const { width, height, colorType } = pngInfo(outPath);
    if (width !== target.size || height !== target.size) {
      throw new Error(`${target.file} came out ${width}x${height}, expected ${target.size}x${target.size}.`);
    }
    if (target.opaque && colorType !== 2) {
      throw new Error(`${target.file} has a PNG alpha channel; App Store icons must be opaque RGB.`);
    }
    console.log(`  ${target.file.padEnd(24)} ${width}x${height}  ${target.mode.padEnd(8)} ${bytes} bytes`);
  }
  console.log(`\n${targets.length} icon${targets.length === 1 ? "" : "s"} rendered from public/logo.svg with ${chrome}`);
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
