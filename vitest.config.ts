import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // Keep tests independent of a real ~/.pi/agent/pignon.json (or laya-router.json).
    env: { PIGNON_CONFIG: "/nonexistent/pignon.json", LAYA_ROUTER_CONFIG: "/nonexistent/laya-router.json" },
  },
});
