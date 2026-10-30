import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Every test file boots its own private Postgres cluster.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false
  }
})
