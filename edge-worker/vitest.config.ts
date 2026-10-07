import { defineConfig } from "vitest/config";

// Own config: without it vitest walks up to the repository root's
// vitest.config.ts, whose imports resolve against the API's node_modules.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
