import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist");
const artifacts = resolve(root, "artifacts");
const packageJson = JSON.parse(
  await readFile(resolve(root, "package.json"), "utf8"),
);
const archive = resolve(
  artifacts,
  `orbb-chrome-extension-${packageJson.version}.zip`,
);

await mkdir(artifacts, { recursive: true });
await rm(archive, { force: true });
await execFileAsync("zip", ["-q", "-r", archive, "."], { cwd: dist });

const bytes = await readFile(archive);
const checksum = createHash("sha256").update(bytes).digest("hex");
await writeFile(`${archive}.sha256`, `${checksum}  ${archive.split("/").at(-1)}\n`);
console.log(archive);
