import { defineConfig } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
const installedPath = new URL("./browsers/installed.json", import.meta.url);
const installed = existsSync(installedPath) ? JSON.parse(readFileSync(installedPath, "utf8")) : {};
const localWebkit = installed.webkit?.executable;
const localChromium = installed.chromium?.executable;
// 使用与驱动匹配的独立浏览器，避免系统 Chrome 后台服务占住退出管道。
if (!localChromium || !localWebkit)
  throw new Error(
    "Install pinned browsers: node scripts/install-chromium.mjs && node scripts/install-webkit.mjs",
  );
export default defineConfig({
  testDir: "./tests/browser",
  timeout: 15_000,
  expect: { timeout: 4_000 },
  fullyParallel: true,
  workers: 2,
  reporter: [["list"], ["json", { outputFile: "reports/browser-results.json" }]],
  outputDir: "reports/browser-artifacts",
  use: {
    baseURL: "http://127.0.0.1:4187",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
        launchOptions: { executablePath: localChromium },
        viewport: { width: 1280, height: 900 },
      },
    },
    {
      name: "chromium-mobile",
      use: {
        browserName: "chromium",
        launchOptions: { executablePath: localChromium },
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: "webkit",
      use: {
        browserName: "webkit",
        viewport: { width: 390, height: 844 },
        launchOptions: localWebkit ? { executablePath: localWebkit } : {},
      },
    },
  ],
  webServer: {
    command: "pnpm run demo:build && pnpm run demo",
    url: "http://127.0.0.1:4187",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
