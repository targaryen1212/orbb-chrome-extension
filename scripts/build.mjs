import { build, context } from "esbuild";
import { access, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const watch = process.argv.includes("--watch");
const outdir = resolve(root, "dist");

await rm(outdir, { recursive: true, force: true });
await mkdir(resolve(outdir, "icons"), { recursive: true });
const distributionFiles = [
  "PRIVACY.md",
  "SECURITY.md",
  "THIRD_PARTY_NOTICES.md",
];
await access(resolve(root, "LICENSE"))
  .then(() => distributionFiles.push("LICENSE"))
  .catch(() => undefined);

await Promise.all([
  cp(resolve(root, "sidepanel.html"), resolve(outdir, "sidepanel.html")),
  cp(resolve(root, "sidepanel.css"), resolve(outdir, "sidepanel.css")),
  cp(resolve(root, "icons"), resolve(outdir, "icons"), { recursive: true }),
  ...distributionFiles.map((file) =>
    cp(resolve(root, file), resolve(outdir, file)),
  ),
]);

const manifest = JSON.parse(await readFile(resolve(root, "manifest.json"), "utf8"));
manifest.background.service_worker = "background.js";
manifest.side_panel.default_path = "sidepanel.html";
await writeFile(resolve(outdir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

const options = {
  entryPoints: {
    background: resolve(root, "src/background.ts"),
    sidepanel: resolve(root, "src/sidepanel.ts"),
  },
  outdir,
  bundle: true,
  format: "esm",
  target: "chrome116",
  sourcemap: watch,
  logLevel: "info",
};

if (watch) {
  const buildContext = await context(options);
  await buildContext.watch();
  console.log(`Watching the Chrome extension build in ${root}`);
} else {
  await build(options);
}
