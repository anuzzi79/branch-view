# Branch View

Electron canvas of forkable terminal sessions. Each card on the canvas hosts a real PTY (PowerShell, cmd, WSL, or any Windows Terminal profile). When the card is running `codex` or `claude`, the **branch** button forks the conversation into a new card linked by an edge.

## Features

- **Real terminals, not embedded chats.** Each card is a `node-pty` PTY wired to an xterm.js view — run any shell or REPL inside.
- **Conversation forking for Codex and Claude Code.** The **branch** button auto-detects which CLI is active in the parent card and issues the right fork command in the child:
  - Codex → `codex fork <session-id>`
  - Claude Code → `claude --resume <session-id> --fork-session`
- **Windows Terminal profile integration.** Reads `settings.json` and exposes every visible profile (PowerShell, cmd, WSL distros, custom profiles).
- **WSL handled natively.** Distros with no explicit `commandline` (e.g. `CanonicalGroupLimited.Ubuntu_*`) are launched as `wsl.exe -d <name> --cd <home>`, so you land in `$HOME` like Windows Terminal does.
- **Infinite canvas.** Pan, zoom, mini-map. `Ctrl + wheel` zooms anchored to the cursor even when over a card.
- **Save/load canvases.** Snapshots persist to JSON via the File menu.
- **Themes.** Midnight, Nord, Rosé Pine, Solarized Dark, Light.
- **Collapsing side toolbar.** Hover to expand, click-and-drag the canvas to dismiss.

## How branching works

Each card tracks the working directory of its PTY. When you click **branch**, the main process:

1. Looks for the most recent `.jsonl` for that cwd in both `~/.codex/sessions/` and `~/.claude/projects/<encoded-cwd>/`, filtered to a window around the parent's start time.
2. Picks whichever was modified most recently — that identifies which CLI is active.
3. Spawns a new PTY with the same profile and cwd, then a moment later writes the matching fork command into it.

If neither directory yields a match, the child prints a hint instead of guessing.

## Development

Requirements: Node.js 20+. Windows 10/11 for full feature parity (WSL profile resolution is Windows-only).

```bash
npm install
npm run dev
```

Build and package:

```bash
npm run build           # bundle main, preload, renderer
npm run dist            # default target for the current OS
npm run dist:win        # Windows installer
npm run dist:mac        # macOS dmg
npm run dist:linux      # AppImage + .deb
```

## Tech stack

- **Electron** — main process owns the PTYs via [`node-pty`](https://github.com/microsoft/node-pty).
- **React** + [`@xyflow/react`](https://reactflow.dev/) — node-based canvas.
- **xterm.js** — terminal rendering.
- **electron-vite** / **electron-builder** — dev server and packaging.

## Origins

Branch View started as a fork of [chatvas](https://github.com/Kaleab-Ayenew/chatvas) by Kaleab Ayenew — an infinite canvas for branching ChatGPT conversations. The Electron + React Flow scaffolding and the node-canvas UX come from that project. Branch View pivots the concept from embedded chat webviews to real PTY sessions and from ChatGPT branches to Codex / Claude Code session forks.

## License

MIT

