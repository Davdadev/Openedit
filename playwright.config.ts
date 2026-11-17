import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "test/studio",
  testMatch: /.*\.spec\.ts$/,
  outputDir: "test-results/playwright",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
});
