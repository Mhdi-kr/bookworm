#!/usr/bin/env node
/**
 * Record a feature walkthrough of the running Bookworm app.
 *
 *   pnpm dev          # in another terminal
 *   pnpm demo:record
 *
 *   pnpm exec playwright install ffmpeg
 *   pnpm dev          # in another terminal
 *   pnpm demo:record
 *
 * Writes demo/bookworm-demo.webm. Uses the system Chrome (not Playwright's
 * bundled Chromium). The demo Chrome profile in demo/.chrome-profile keeps the
 * on-device voice cache so later recordings can show pause/resume.
 */
import { mkdir, copyFile, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, "demo");
const outFile = path.join(outDir, "bookworm-demo.webm");
const baseUrl = process.env.BOOKWORM_URL ?? "http://127.0.0.1:1420";
const viewport = { width: 1440, height: 900 };

const demoEpub = path.join(root, "scripts", "fixtures", "demo-book.epub");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function caption(page, text) {
  await page.evaluate((next) => {
    const id = "bookworm-demo-caption";
    let el = document.getElementById(id);
    if (!next) {
      el?.remove();
      return;
    }
    if (!el) {
      el = document.createElement("div");
      el.id = id;
      Object.assign(el.style, {
        position: "fixed",
        left: "50%",
        bottom: "96px",
        transform: "translateX(-50%)",
        zIndex: "2147483647",
        pointerEvents: "none",
        maxWidth: "min(40rem, calc(100vw - 2rem))",
        padding: "11px 20px",
        borderRadius: "999px",
        background: "rgba(20, 32, 27, 0.94)",
        color: "#e8f0ed",
        fontFamily: 'Georgia, "Literata", serif',
        fontSize: "16px",
        lineHeight: "1.35",
        letterSpacing: "0.01em",
        boxShadow: "0 18px 40px rgba(20, 32, 27, 0.35)",
        border: "1px solid rgba(232, 240, 237, 0.14)",
        textAlign: "center",
      });
      document.body.appendChild(el);
    }
    el.textContent = next;
  }, text);
}

function epub(page) {
  return page.frameLocator("[data-epub-host] iframe").first();
}

async function waitForBook(page) {
  await page.getByRole("button", { name: /The Open Page/ }).waitFor({ timeout: 20_000 });
}

async function importDemoBook(page) {
  await page.getByRole("button", { name: "Import EPUB" }).waitFor({ timeout: 15_000 });
  const book = page.getByRole("button", { name: /The Open Page/ });
  const empty = page.getByText("An empty shelf");
  await Promise.race([
    book.waitFor({ timeout: 10_000 }),
    empty.waitFor({ timeout: 10_000 }),
  ]).catch(() => {});
  if (await book.isVisible()) return;
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.getByRole("button", { name: "Import EPUB" }).click(),
  ]);
  await chooser.setFiles(demoEpub);
  await waitForBook(page);
}

async function openSettings(page) {
  const settings = page.getByRole("button", { name: "Settings" });
  if ((await settings.getAttribute("aria-expanded")) !== "true") {
    await settings.click();
  }
  await page.getByRole("dialog", { name: "Reader settings" }).waitFor();
}

async function closeSettings(page) {
  const settings = page.getByRole("button", { name: "Settings" });
  if ((await settings.getAttribute("aria-expanded")) === "true") {
    await settings.click();
  }
}

async function goToChapter(page, name) {
  await page.getByRole("button", { name: "Table of contents" }).click();
  await page.getByRole("button", { name, exact: true }).click();
  await epub(page).locator("h1").filter({ hasText: name }).waitFor({ timeout: 10_000 });
  await sleep(700);
}

async function main() {
  await mkdir(outDir, { recursive: true });
  for (const name of await readdir(outDir)) {
    if (name.endsWith(".webm") || name.endsWith(".mp4")) {
      await unlink(path.join(outDir, name)).catch(() => {});
    }
  }

  const profileDir = path.join(outDir, ".chrome-profile");
  const context = await chromium.launchPersistentContext(profileDir, {
    channel: process.env.BOOKWORM_DEMO_BROWSER ?? "chrome",
    headless: true,
    slowMo: 180,
    viewport,
    deviceScaleFactor: 2,
    recordVideo: { dir: outDir, size: viewport },
    colorScheme: "light",
  });
  await context.addInitScript(() => {
    localStorage.setItem(
      "bookworm.reader-settings",
      JSON.stringify({
        theme: "paper",
        font: "literata",
        fontSize: 112,
        orientation: "horizontal",
        voice: "af_heart",
        speed: 1,
        chromeVisible: true,
        autoPlay: false,
      }),
    );
  });

  const page = context.pages()[0] ?? (await context.newPage());

  try {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 15_000 });
  } catch (error) {
    await context.close();
    throw new Error(
      `Could not open ${baseUrl}. Start the app with \`pnpm dev\` first.\n${error instanceof Error ? error.message : error}`,
    );
  }

  await page.addStyleTag({
    content: "[data-reader-tap-hint]{display:none !important}",
  });

  await importDemoBook(page);
  await caption(page, "A private library — title, author, and cover come from the EPUB");
  await sleep(2200);

  await page.getByRole("button", { name: /The Open Page/ }).click();
  await page.getByRole("button", { name: "Settings" }).waitFor({ timeout: 15_000 });
  await epub(page).locator("h1").waitFor({ timeout: 15_000 });
  await page.addStyleTag({
    content: "[data-reader-tap-hint]{display:none !important}",
  });
  await caption(page, "The Open Page — a short tour of Bookworm");
  await sleep(2000);

  await goToChapter(page, "Reading");
  await caption(page, "Reading settings: type, size, theme, and layout");
  await sleep(900);

  await openSettings(page);
  await caption(page, "Fonts — Literata, Georgia, Baskerville, OpenDyslexic");
  for (const font of ["Georgia", "Baskerville", "OpenDyslexic", "Literata"]) {
    await page.getByRole("button", { name: font, exact: true }).click();
    await sleep(900);
  }

  await caption(page, "Font size");
  await page.getByRole("button", { name: "Increase font size" }).click();
  await sleep(500);
  await page.getByRole("button", { name: "Increase font size" }).click();
  await sleep(800);
  await page.getByRole("button", { name: "Decrease font size" }).click();
  await page.getByRole("button", { name: "Decrease font size" }).click();
  await sleep(600);

  await caption(page, "Themes — Paper, Fog, Dark");
  for (const theme of ["fog", "dark", "paper"]) {
    await page.getByRole("button", { name: theme, exact: true }).click();
    await sleep(1000);
  }

  await caption(page, "Orientation — paginated pages or a continuous scroll");
  await page.getByRole("button", { name: "Vertical", exact: true }).click();
  await sleep(1400);
  await page.getByRole("button", { name: "Horizontal", exact: true }).click();
  await sleep(1000);
  await closeSettings(page);

  await goToChapter(page, "Speech");
  await caption(page, "Speech settings: voice, speed, auto-play, and device");
  await sleep(800);
  await openSettings(page);
  await sleep(700);
  await caption(page, "Speed keeps pitch while the voice runs faster or slower");
  const speed = page.getByRole("slider", { name: /Speed/ });
  await speed.fill("1.2");
  await sleep(900);
  await speed.fill("1");
  await caption(page, "Auto-play continues to the next passage");
  await page.getByRole("checkbox", { name: "Auto-play" }).click();
  await sleep(800);
  await page.getByRole("checkbox", { name: "Auto-play" }).click();
  await sleep(600);
  await closeSettings(page);

  await caption(page, "Tap a paragraph to hear it on this device");
  const spoken = epub(page).locator("p.bookworm-speakable").nth(1);
  await spoken.waitFor({ timeout: 10_000 });
  await spoken.click();
  const pauseBtn = page.getByRole("button", { name: "Pause" });
  try {
    await pauseBtn.waitFor({ state: "visible", timeout: 45_000 });
    await sleep(1600);
    await caption(page, "Pause and resume as often as you like");
    await pauseBtn.click();
    await sleep(900);
    await page.getByRole("button", { name: "Resume" }).click();
    await sleep(1200);
    await page.getByRole("button", { name: "Stop" }).click();
    await sleep(700);
  } catch {
    await caption(page, "Speech uses an on-device voice model");
    await sleep(1600);
  }

  await caption(page, "Your place, type, and voice stay on this device");
  await page.getByRole("button", { name: "Library" }).click();
  await waitForBook(page);
  await sleep(1800);
  await caption(page, null);

  const video = page.video();
  await page.close();
  await context.close();

  if (!video) {
    throw new Error("Playwright did not record a video");
  }
  const recorded = await video.path();
  await copyFile(recorded, outFile);
  if (recorded !== outFile) {
    await unlink(recorded).catch(() => {});
  }
  console.log(`Wrote ${path.relative(root, outFile)}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
