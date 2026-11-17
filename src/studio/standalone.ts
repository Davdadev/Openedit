// `openedit studio`: run the studio server on its own (used by the Mac app).
// MCP sessions started later detect it on the port and forward their events here.
import { openInBrowser } from "./index.js";
import { STUDIO_APP_ID, startStudioServer, studioPort } from "./server.js";

export async function runStudioCli(argv: string[]): Promise<number> {
  const flag = (name: string) => argv.includes(name);
  const portArg = argv.indexOf("--port");
  const port = portArg >= 0 ? Number(argv[portArg + 1]) : studioPort();
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`Invalid port "${argv[portArg + 1]}"`);
    return 2;
  }
  try {
    const s = await startStudioServer({ port });
    console.log(`OpenEdit Studio listening on ${s.url}`);
    // Standalone: MCP sessions feed this page through POST /emit.
    if (flag("--open")) openInBrowser(s.url);
    const stop = () => void s.close().then(() => process.exit(0));
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    await new Promise(() => undefined);
    return 0;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EADDRINUSE") {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
        if (((await r.json()) as { app?: string }).app === STUDIO_APP_ID) {
          const url = `http://127.0.0.1:${port}/`;
          console.log(`OpenEdit Studio already running on ${url}`);
          if (flag("--open")) openInBrowser(url);
          return 0;
        }
      } catch {
        /* not a studio */
      }
      console.error(`Port ${port} is in use by another program. Set OPENEDIT_STUDIO_PORT or pass --port.`);
      return 1;
    }
    throw e;
  }
}
