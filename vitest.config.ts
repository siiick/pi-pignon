import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // Keep tests independent of a real ~/.pi/agent/laya-router.json.
    env: { LAYA_ROUTER_CONFIG: "/nonexistent/laya-router.json" },
  },
});
