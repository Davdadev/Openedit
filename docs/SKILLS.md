# OpenEdit skills and Claude plugin

OpenEdit ships as a **Claude Code plugin**: one install gives Claude the OpenEdit MCP server
(the editing tools) and a set of **skills** (the editing judgement). The tools make cuts,
captions and renders possible; the skills make Claude use them the way a skilled editor would,
and tell it when to drive DaVinci Resolve or Premiere Pro's own interface with computer use.

## Install as a plugin

Requirements: Node 22+ and npm, ffmpeg and whisper.cpp (`brew install ffmpeg whisper-cpp`).

In Claude Code:

```
/plugin marketplace add Davdadev/openedit
/plugin install openedit@openedit
```

or in one step (Claude Code 2.1.275+): `/plugin install openedit --marketplace Davdadev/openedit`.
From a shell: `claude plugin marketplace add Davdadev/openedit && claude plugin install openedit@openedit`.

Then restart Claude Code (or run `/reload-plugins`). Check with `/plugin` (Installed tab) and
`/mcp`: the server appears as `plugin:openedit:openedit`.

### First start builds the server

`dist/` is not committed. The plugin starts the server through
`scripts/openedit-mcp.mjs`, which on first start:

1. runs `npm ci --ignore-scripts` if `node_modules` or TypeScript is missing (Claude Code
   usually installs the locked dependencies itself when it copies the plugin),
2. runs the TypeScript build (`tsc -p tsconfig.json`),
3. then starts `dist/cli.js` on stdio. All build output goes to stderr, never to the MCP stream.

The first build can take a minute. If `/mcp` shows the server failed during that time, build
it once by hand and reconnect:

```bash
node ~/.claude/plugins/cache/openedit/openedit/<version>/scripts/openedit-mcp.mjs --build
```

(`<version>` is shown by `/plugin`; `MCP_TIMEOUT=120000 claude` also gives the first start more
time.) Other arguments pass through to the CLI, for example `... openedit-mcp.mjs doctor`.

Updating: the plugin pins `version` in `.claude-plugin/plugin.json`, so users get a new copy
when that version changes (`claude plugin update openedit@openedit`, then restart). Each version directory builds
its own `dist/` on first start.

### Already using `claude mcp add`?

The README's manual install (`claude mcp add -s user openedit -- node .../dist/cli.js`) keeps
working. If you install the plugin too, remove the manual server
(`claude mcp remove -s user openedit`) so Claude does not see two copies of every tool.

### Why the MCP server is declared in plugin.json

The server is declared inline in `.claude-plugin/plugin.json` rather than in a root
`.mcp.json`. A root `.mcp.json` would also be read as this repository's *project* MCP config
whenever Claude Code runs inside the repo, where `${CLAUDE_PLUGIN_ROOT}` is undefined, giving
contributors a broken "openedit" server that shadows their working one. Plugins also must not
have a top-level `bin/` (claude.ai and Cowork refuse to install those), so the launcher lives in
`scripts/`.

## The skills

| Skill | Use it for |
|---|---|
| `openedit-editing` | The core editorial process: watch/read first, decide the story, cut on meaning, pacing by platform, captions/zooms/b-roll/music rules, loudness targets, the anti-"AI slop" list, mandatory review. |
| `openedit-shorts` | 9:16 Shorts/Reels/TikTok from long-form: picking a self-contained moment, the hook, reframe, bold captions inside safe zones, ending on a beat. |
| `openedit-stock-media` | Choosing b-roll, music and SFX with `get_media`/`find_media`: literal vs metaphor, matching footage, rejecting cheesy stock, licences and credits. |
| `openedit-motion-design` | Motion graphics: the user's template packs (`import_template_pack`, `graphics_catalog`), Figma frames → `create_motion_template`, `place_graphic` per host, timing/easing/legibility craft, pack licences, anti-slop. |
| `openedit-review` | QA of a render: contact sheet, duration vs plan, LUFS/true peak, captions, framing, black/frozen frames; fix and re-render. Uses `review_edit` when available, ffmpeg otherwise. |
| `openedit-resolve-computer-use` | DaVinci Resolve UI via computer use when the bridge is unavailable or the API cannot do it: timeline import, eased zooms, transitions, subtitles styling, Fairlight, colour matching, Deliver/loudness. Menu paths cited to the Resolve 21 manual. |
| `openedit-premiere-computer-use` | Premiere Pro UI via computer use: opening the OpenEdit panel, XML import, caption track styles, Effect Controls keyframes, Essential Sound ducking, Export mode (captions, loudness). Cited to Adobe Help. |

Each skill is a folder with a short `SKILL.md` (loaded when the skill triggers) and
`references/*.md` that Claude reads only when it needs the detail.

## Use the skills without the plugin

Skills are plain folders, so they also work with a manually added MCP server:

```bash
mkdir -p ~/.claude/skills && cp -R skills/* ~/.claude/skills/
```

For one project only, copy them into that project's `.claude/skills/` instead. Restart Claude
Code. Update by copying again after `git pull`.

The computer-use skills need Claude's computer use (Claude desktop app, Settings > Computer
use). Everything else needs only the OpenEdit MCP server.

## Develop the skills

- Keep `SKILL.md` bodies under ~250 lines; move detail to `references/`.
- The `description` is what makes a skill trigger: say what it does and list the phrases and
  situations that should load it. Max 1024 characters, no angle brackets.
- Ground UI paths in documentation and cite them (manual page numbers, help URLs).
- Validate:

```bash
npx vitest run test/skills.test.ts
claude plugin validate .
```

- Try the plugin from a checkout without installing it: `claude --plugin-dir .`
