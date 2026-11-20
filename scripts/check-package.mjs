import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";

// 打包前检查白名单和文本，防止本机资料或个人路径随公开产物泄漏。
const packed = spawnSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], {
  encoding: "utf8",
});
assert.equal(packed.status, 0, packed.stderr);
const [manifest] = JSON.parse(packed.stdout);
assert.equal(manifest.name, "muvra");
assert.equal(manifest.version, "0.1.0-alpha.0");
for (const { path } of manifest.files) {
  assert.match(path, /^(dist\/|src\/|package\.json$|README\.md$|MIGRATION\.md$|LICENSE$)/);
  const text = await readFile(path, "utf8");
  assert.doesNotMatch(text, /\/Users\/|\/home\/|@dusheng\/page-stack-lab/);
}
for (const path of ["dist/index.js", "dist/index.d.ts", "dist/extensions/backdrop.js", "LICENSE"])
  assert.ok(
    manifest.files.some((file) => file.path === path),
    `Missing ${path}`,
  );
console.log(`Package boundary passed: ${manifest.files.length} files.`);
