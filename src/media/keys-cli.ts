import { createInterface } from "node:readline/promises";
import { envFilePath, KEY_SPECS, keyStatus, writeEnvFile } from "./keys.js";

/** `openedit keys [--status]`: prompt once per missing key (Enter skips) and save to ~/.openedit/.env (mode 600). */
export async function keysCommand(args: string[]): Promise<number> {
  const status = keyStatus();
  if (args.includes("--status") || args.includes("-s")) {
    console.log(`Stock media API keys (${envFilePath()})\n`);
    for (const k of status) console.log(`  ${k.set ? "✓" : "-"} ${k.env.padEnd(22)} ${k.set ? `${k.masked} (${k.source})` : `not set — ${k.signupUrl}`}`);
    console.log("\nOpenverse, Wikimedia Commons and NASA need no key.");
    return 0;
  }
  const missing = status.filter((k) => !k.set);
  if (!missing.length) {
    console.log("All stock media keys are set. Use `openedit keys --status` to review.");
    return 0;
  }
  if (!process.stdin.isTTY) {
    console.error("openedit keys needs an interactive terminal. Missing: " + missing.map((k) => k.env).join(", "));
    return 1;
  }
  console.log("OpenEdit stock media keys. All are free; press Enter to skip any.\n");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const updates: Record<string, string> = {};
  try {
    for (const k of missing) {
      const spec = KEY_SPECS.find((s) => s.env === k.env)!;
      console.log(`${spec.provider} — ${spec.note}\n  get one at: ${spec.signupUrl}`);
      const v = (await rl.question(`  ${spec.env}: `)).trim();
      if (v) updates[spec.env] = v;
      console.log("");
    }
  } finally {
    rl.close();
  }
  if (!Object.keys(updates).length) {
    console.log("Nothing saved.");
    return 0;
  }
  const file = writeEnvFile(updates);
  console.log(`Saved ${Object.keys(updates).length} key(s) to ${file} (mode 600).`);
  return 0;
}
