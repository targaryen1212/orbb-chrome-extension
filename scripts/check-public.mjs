import { execFileSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const failures = [];

await access(resolve(root, "LICENSE")).catch(() => {
  failures.push("Add an explicit open-source LICENSE.");
});

const [packageJson, manifest, readme] = await Promise.all([
  readJson("package.json"),
  readJson("manifest.json"),
  readFile(resolve(root, "README.md"), "utf8"),
]);

if (!packageJson.license || packageJson.license === "UNLICENSED") {
  failures.push("Set package.json license to the selected open-source license.");
}
if (packageJson.dependencies?.["@orbb/orbit-sdk"] !== "0.3.4") {
  failures.push("Use the reviewed public @orbb/orbit-sdk@0.3.4 dependency.");
}
if (/\/Users\/|[A-Za-z]:\\\\Users\\\\/.test(readme)) {
  failures.push("README contains a machine-specific home directory.");
}

const requiredHostPermissions = new Set(["https://api.orbb.app/*"]);
if (
  manifest.host_permissions.some(
    (origin) => !requiredHostPermissions.has(origin),
  )
) {
  failures.push("Social provider origins must remain optional permissions.");
}

const tracked = execFileSync("git", ["ls-files", "."], {
  cwd: root,
  encoding: "utf8",
})
  .split(/\r?\n/)
  .filter(Boolean);
const forbiddenTracked = tracked.filter((file) =>
  /^(?:dist|releases|vendor|artifacts)\//.test(file) ||
  /(?:^|\/)\.DS_Store$/.test(file) ||
  /^Screenshot .*\.(?:jpe?g|png)$/i.test(file),
);
if (forbiddenTracked.length > 0) {
  failures.push(
    `Remove generated or private tracked files: ${forbiddenTracked.join(", ")}`,
  );
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log("Public repository checks passed.");
}

async function readJson(file) {
  return JSON.parse(await readFile(resolve(root, file), "utf8"));
}
