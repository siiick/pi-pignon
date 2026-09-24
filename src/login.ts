/**
 * `/pignon login` and `/pignon logout`: save or remove the TypeSafe (Jev) API
 * key in pignon's credentials file (see `credentials.ts`).
 *
 * Pi-free: the dialogs are reached through `LoginUI`.
 */

import {
  TYPESAFE_CREDENTIAL,
  credentialsPath,
  readStoredKey,
  resolveStoredKey,
  writeStoredKey,
} from "./credentials.js";
import { DEFAULT_API_KEY_ENV } from "./deciders/jev.js";

/** The part of Pi's UI the login dialogs use. */
export interface LoginUI {
  select(title: string, options: string[]): Promise<string | undefined>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
}

export type LoginResult = { level: "info" | "warning" | "error"; message: string };

const FROM_COMMAND = "Read it from a command (password manager, Keychain): the key is not written to disk";
const PASTE = "Paste the key: saved in pignon's credentials file (readable by you only)";

const EXAMPLE_COMMAND =
  process.platform === "darwin" ? "security find-generic-password -ws typesafe" : "op read op://Private/TypeSafe/credential";

export async function login(
  ui: LoginUI,
  env: NodeJS.ProcessEnv = process.env,
  path: string = credentialsPath(env),
): Promise<LoginResult | undefined> {
  const how = await ui.select("How should pignon get your TypeSafe API key?", [FROM_COMMAND, PASTE]);
  if (how === undefined) return undefined;

  let value: string;
  if (how === FROM_COMMAND) {
    const command = (await ui.input("Command that prints the key", EXAMPLE_COMMAND))?.trim().replace(/^!\s*/, "");
    if (!command) return undefined;
    value = `!${command}`;
    try {
      await resolveStoredKey(value);
    } catch (err) {
      return { level: "error", message: `${(err as Error).message}; nothing saved` };
    }
  } else {
    const key = (await ui.input("TypeSafe API key", "paste the key"))?.trim();
    if (!key) return undefined;
    if (/\s/.test(key)) return { level: "error", message: "an API key has no spaces; nothing saved" };
    value = key;
  }

  try {
    writeStoredKey(TYPESAFE_CREDENTIAL, value, path);
  } catch (err) {
    return { level: "error", message: `could not write ${path}: ${(err as Error).message}` };
  }
  const shadowed = env[DEFAULT_API_KEY_ENV]?.trim() ? ` ${DEFAULT_API_KEY_ENV} is set and is used first.` : "";
  return { level: shadowed ? "warning" : "info", message: `saved the TypeSafe key in ${path}; /reload to use it.${shadowed}` };
}

export function logout(env: NodeJS.ProcessEnv = process.env, path: string = credentialsPath(env)): LoginResult {
  if (readStoredKey(TYPESAFE_CREDENTIAL, path).kind === "missing") {
    return { level: "info", message: "no TypeSafe key saved" };
  }
  try {
    writeStoredKey(TYPESAFE_CREDENTIAL, undefined, path);
  } catch (err) {
    return { level: "error", message: `could not write ${path}: ${(err as Error).message}` };
  }
  const still = env[DEFAULT_API_KEY_ENV]?.trim() ? ` ${DEFAULT_API_KEY_ENV} is still set.` : "";
  return { level: "info", message: `removed the saved TypeSafe key; /reload to apply.${still}` };
}
