import path from "node:path";
import process from "node:process";
import { chromium } from "playwright";
import { discoverExamples } from "../example-gallery/discovery.mjs";
import { startExampleGallery } from "../example-gallery/server.mjs";

// Keep the gallery's 960 × 540 framing; DPR 2 produces a 1920 × 1080 image.
const THUMBNAIL_WIDTH = 960;
const THUMBNAIL_HEIGHT = 540;
const THUMBNAIL_DPR = 2;
const THUMBNAIL_TIMEOUT_MS = 30000;

const root = process.cwd();
const examples = await discoverExamples(root);
const { server, url } = await startExampleGallery({
  host: "127.0.0.1",
  port: 0,
});

let browser;
try {
  browser = await chromium.launch({ headless: true, channel: "chromium" });
  const context = await browser.newContext({
    viewport: { width: THUMBNAIL_WIDTH, height: THUMBNAIL_HEIGHT },
    deviceScaleFactor: THUMBNAIL_DPR,
  });

  for (const example of examples) {
    const page = await context.newPage();
    const runtimeErrors = [];
    page.on("pageerror", (error) => runtimeErrors.push(error.message));

    try {
      const target = new URL(example.entry, url);
      target.searchParams.set("galleryPaused", "1");
      target.searchParams.set("galleryDpr", String(THUMBNAIL_DPR));
      target.searchParams.set("galleryTimeScale", "1");
      target.searchParams.set("galleryDebugMode", "final");
      target.searchParams.set("galleryThumbnail", "1");
      if (/^webgpu/i.test(example.backend ?? "")) {
        target.searchParams.set("galleryBackend", "webgpu");
      }

      await page.goto(target.href, {
        waitUntil: "domcontentloaded",
        timeout: THUMBNAIL_TIMEOUT_MS,
      });
      await page.locator("html[data-example-ready='true']").waitFor({
        timeout: THUMBNAIL_TIMEOUT_MS,
      });
      if (runtimeErrors.length > 0) {
        throw new Error(runtimeErrors.join("; "));
      }

      const output = path.join(
        root, "skills", example.skill, "examples", example.slug,
        "example-render.jpeg",
      );
      await page.locator("canvas").screenshot({ type: "jpeg", path: output });
      console.log(`Rendered ${path.relative(root, output)}`);
    } catch (error) {
      throw new Error(`${example.id}: ${error.message}`, { cause: error });
    } finally {
      await page.close().catch(() => {});
    }
  }
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
