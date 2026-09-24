import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readStoredKey } from "../src/credentials.js";
import { type LoginUI, login, logout } from "../src/login.js";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pignon-login-"));
  path = join(dir, "credentials.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Picks the option starting with `choice`, then types `text`. */
function ui(choice: "Read" | "Paste" | undefined, text?: string): LoginUI {
  return {
    select: vi.fn(async (_title: string, options: string[]) => options.find((o) => choice && o.startsWith(choice))),
    input: vi.fn(async () => text),
  };
}

describe("/pignon login", () => {
  it("saves a pasted key", async () => {
    const result = await login(ui("Paste", "  sk-pasted \n"), {}, path);

    expect(result).toEqual({ level: "info", message: `saved the TypeSafe key in ${path}; /reload to use it.` });
    expect(readStoredKey("typesafe", path)).toEqual({ kind: "ok", value: "sk-pasted" });
  });

  it("saves a command after checking it prints a key", async () => {
    await login(ui("Read", "!echo sk-cmd"), {}, path);
    expect(readStoredKey("typesafe", path)).toEqual({ kind: "ok", value: "!echo sk-cmd" });
  });

  it("saves nothing when the command fails", async () => {
    const result = await login(ui("Read", "exit 1"), {}, path);
    expect(result).toEqual({ level: "error", message: "key command failed (exit 1); nothing saved" });
    expect(readStoredKey("typesafe", path)).toEqual({ kind: "missing" });
  });

  it("saves nothing when cancelled", async () => {
    expect(await login(ui(undefined), {}, path)).toBeUndefined();
    expect(await login(ui("Paste", undefined), {}, path)).toBeUndefined();
    expect(readStoredKey("typesafe", path)).toEqual({ kind: "missing" });
  });

  it("warns that the environment variable wins", async () => {
    const result = await login(ui("Paste", "sk-pasted"), { TYPESAFE_API_KEY: "sk-env" }, path);
    expect(result?.level).toBe("warning");
    expect(result?.message).toContain("TYPESAFE_API_KEY is set and is used first");
  });
});

describe("/pignon logout", () => {
  it("removes the saved key", async () => {
    await login(ui("Paste", "sk-pasted"), {}, path);
    expect(logout({}, path).message).toBe("removed the saved TypeSafe key; /reload to apply.");
    expect(readStoredKey("typesafe", path)).toEqual({ kind: "missing" });
  });

  it("says when there is nothing to remove", () => {
    expect(logout({}, path)).toEqual({ level: "info", message: "no TypeSafe key saved" });
  });
});
