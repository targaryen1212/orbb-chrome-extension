import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("keeps the side panel semantic and password-free", async () => {
  const html = await readFile(new URL("sidepanel.html", root), "utf8");
  assert.match(html, /<button id="dropZone"[^>]*type="button"/);
  assert.doesNotMatch(html, /type="password"/i);
  assert.match(html, /id="authStatus"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(html, /id="feedbackBanner"[^>]*role="alert"[^>]*aria-live="assertive"/);
  assert.match(html, /<progress id="syncProgress"/);
  assert.match(html, /<progress id="previewProgress"/);
  assert.match(html, /<progress id="dropPreviewProgress"/);
  assert.doesNotMatch(html, /Every minute/);
  assert.match(html, /<option value="30">Every 30 min<\/option>/);
});

test("uses semantic theme variables with dark and reduced-motion support", async () => {
  const css = await readFile(new URL("sidepanel.css", root), "utf8");
  assert.match(css, /--color-background-surface:/);
  assert.match(css, /--spacing-4:/);
  assert.match(css, /--radius-container:/);
  assert.match(css, /@media \(prefers-color-scheme: dark\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /min-width: 300px/);
});

test("does not generate inline presentation styles from TypeScript", async () => {
  const source = await readFile(new URL("src/sidepanel.ts", root), "utf8");
  assert.doesNotMatch(source, /\.style\./);
  assert.doesNotMatch(source, /setAttribute\(["']style["']/);
});

test("serializes QR polling and requests social access on demand", async () => {
  const [source, background, manifestText] = await Promise.all([
    readFile(new URL("src/sidepanel.ts", root), "utf8"),
    readFile(new URL("src/background.ts", root), "utf8"),
    readFile(new URL("manifest.json", root), "utf8"),
  ]);
  const manifest = JSON.parse(manifestText);

  assert.doesNotMatch(source, /setInterval\([^)]*POLL_QR_AUTH/);
  assert.match(source, /setTimeout\(\(\) => void poll\(\), 2100\)/);
  assert.match(source, /chrome\.permissions\.request/);
  assert.match(background, /COLLECTION_BUDGET_MS/);
  assert.match(background, /recoverInterruptedSyncOnWorkerStart/);
  assert.deepEqual(manifest.host_permissions, ["https://api.orbb.app/*"]);
  assert.ok(manifest.optional_host_permissions.includes("https://www.instagram.com/*"));
});
