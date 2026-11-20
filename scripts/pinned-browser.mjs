import { createRequire } from "node:module";
import { dirname, basename, resolve, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdir, writeFile, readFile, access } from "node:fs/promises";
import { spawn } from "node:child_process";

/** 从锁定的 Playwright 取得官方构建，直接解压到实验目录，避免安装器清理其他实验浏览器。 */
export async function installPinnedBrowser(name) {
  const require = createRequire(import.meta.url);
  const testRequire = createRequire(require.resolve("@playwright/test"));
  const playwrightRequire = createRequire(testRequire.resolve("playwright/package.json"));
  const core = dirname(playwrightRequire.resolve("playwright-core/package.json"));
  const { registry } = await import(
    pathToFileURL(resolve(core, "lib/server/registry/index.js")).href
  );
  const browser = registry.findExecutable(name);
  if (!browser?.directory) throw new Error(`No pinned executable for ${name}.`);
  const root = resolve(import.meta.dirname, "..", "browsers");
  const directory = resolve(root, basename(browser.directory));
  const archive = resolve(root, `${basename(browser.directory)}.zip`);
  const executable = resolve(directory, relative(browser.directory, browser.executablePath()));
  const run = (command, args) =>
    new Promise((done, reject) => {
      const child = spawn(command, args, { stdio: "inherit" });
      child.on("error", reject);
      child.on("exit", (code) =>
        code === 0 ? done() : reject(new Error(`${command} exited ${code}`)),
      );
    });
  await mkdir(directory, { recursive: true });
  let exists = false;
  try {
    await access(executable);
    exists = true;
  } catch {}
  if (!exists) {
    console.log(`Downloading pinned ${name} ${browser.browserVersion}: ${browser.downloadURLs[0]}`);
    await run("curl", [
      "--fail",
      "--location",
      "--silent",
      "--show-error",
      "--connect-timeout",
      "15",
      "--max-time",
      "300",
      "--retry",
      "2",
      "--output",
      archive,
      browser.downloadURLs[0],
    ]);
    await run("unzip", ["-tq", archive]);
    await run("unzip", ["-q", "-o", archive, "-d", directory]);
  }
  // 合并清单保留其他浏览器；两个入口顺序执行即可重复安装和恢复，不能并发覆盖清单。
  let installed = {};
  try {
    installed = JSON.parse(await readFile(resolve(root, "installed.json"), "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  installed[name] = { version: browser.browserVersion, executable, url: browser.downloadURLs[0] };
  await writeFile(resolve(root, "installed.json"), JSON.stringify(installed, null, 2) + "\n");
  console.log(`${name} ready: ${executable}`);
}
