import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, posix } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
assert.notEqual(manifest.private, true, "package must be publishable");
assert.equal(manifest.license, "MIT");
assert.ok(manifest.keywords?.includes("pi-package"), "Pi catalog discovery keyword is required");
assert.ok(manifest.files?.length, "an explicit publication allowlist is required");
assert.equal(manifest.publishConfig?.access, "public");
const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
assert.equal(lock.name, manifest.name, "lockfile name must match the package");
assert.equal(lock.version, manifest.version, "lockfile version must match the package");
assert.ok(readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8").includes(`## [${manifest.version}]`), "release needs a matching changelog entry");
for (const dependency of Object.keys(manifest.dependencies ?? {})) {
  assert.ok(!dependency.startsWith("@earendil-works/pi-") && dependency !== "typebox", `host-provided dependency must be a peer: ${dependency}`);
}
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const [pack] = JSON.parse(execFileSync(npm, ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root, encoding: "utf8" }));
const paths = new Set(pack.files.map((file) => file.path));
for (const path of ["package.json", "README.md", "LICENSE", "CHANGELOG.md", ...manifest.pi.extensions.map((entry) => entry.replace(/^\.\//, ""))]) {
  assert.ok(paths.has(path), `missing published resource: ${path}`);
}
for (const path of paths) {
  assert.ok(/^(src\/|docs\/|examples\/|package\.json$|README\.md$|LICENSE$|CHANGELOG\.md$)/.test(path), `unexpected published file: ${path}`);
  assert.ok(!/(^|\/)(\.env(?:\.|$)|\.credentials\.json|auth\.json|node_modules|runtime)(\/|$)/.test(path), `private resource: ${path}`);
  if (!path.startsWith("src/") || !path.endsWith(".ts")) continue;
  const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  for (const match of source.matchAll(/(?:from\s+|import\s*)["'](\.[^"']+)["']/g)) {
    const target = posix.normalize(posix.join(dirname(path), match[1])).replace(/\.js$/, ".ts");
    assert.ok(paths.has(target), `missing relative import ${target} from ${path}`);
  }
}
console.log(`${manifest.name}@${manifest.version}: ${paths.size} approved files; ${pack.size} packed bytes; entry points and relative imports verified.`);
