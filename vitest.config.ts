import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["typescript-go/**", "node_modules/**", "dist/**"],
  },
});
