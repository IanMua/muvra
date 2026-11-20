import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

/** 将行为实现、测试和对外契约共同绑定到证据，防止用旧绿灯证明新源码。 */
export async function hashInputs(root) {
  const names = [];
  async function visit(directory) {
    for (const item of await readdir(resolve(root, directory), { withFileTypes: true })) {
      const name = `${directory}/${item.name}`;
      if (item.isDirectory()) await visit(name);
      else names.push(name);
    }
  }
  for (const directory of ["src", "tests", "scripts", "demo/transitions"]) await visit(directory);
  names.push(
    "package.json",
    "pnpm-lock.yaml",
    "tsconfig.json",
    ".prettierrc.json",
    "playwright.config.ts",
    "demo/main.ts",
    "demo/index.html",
    "demo/props.ts",
    "demo/props.html",
    "demo/effects.ts",
    "demo/effects.html",
    "demo/layers.ts",
    "demo/layers.html",
    "README.md",
    "MIGRATION.md",
    "CONTRIBUTING.md",
    "LICENSE",
    ".gitignore",
    "AGENTS.md",
  );
  const hash = createHash("sha256");
  for (const name of names.sort()) hash.update(name).update(await readFile(resolve(root, name)));
  return hash.digest("hex");
}
