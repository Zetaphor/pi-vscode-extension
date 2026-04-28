# AGENTS.md

## Project Overview

Pi Agent is a VS Code extension providing a sidebar chat UI for the Pi coding agent SDK (`@mariozechner/pi-coding-agent`). It supports multi-tab sessions, inline diffs, tool approval, checkpoints/rollback, and a dedicated settings page.

## Build & Test

```bash
npm install          # install dependencies
npm run compile      # build extension + webview bundles (esbuild)
npm run watch        # watch mode
npm run test:unit    # vitest unit tests
npm run test:all     # unit + integration tests
```

Press F5 in VS Code to launch an Extension Development Host for manual testing.

## Architecture

There are two separate bundle targets (configured in `esbuild.js`):

1. **Extension host** (Node.js, CJS) -- `src/extension.ts` entry point, output to `out/extension.js`. Has access to the `vscode` API and the Pi SDK (both externalized, not bundled).
2. **Webview bundles** (browser, IIFE) -- `src/webview/main.ts` and `src/webview/settings.ts`, output to `out/webview/`. These run inside VS Code webview iframes with no Node.js or vscode API access. They communicate with the extension host via `postMessage`.

The Pi SDK packages (`@mariozechner/pi-coding-agent`, `@mariozechner/pi-agent-core`, `@mariozechner/pi-ai`) are externalized in esbuild and loaded at runtime by the extension host.

## Key Conventions

- **Typed message protocol**: All communication between extension host and webviews goes through typed message unions defined in `src/shared/protocol.ts`. Add new message types there before implementing handlers.
- **Tab isolation**: Each chat tab has its own `PiSessionManager`, `DiffManager`, and `CheckpointManager`. State is never shared between tabs.
- **No direct DOM libraries**: The webview UI is built with vanilla TypeScript and DOM APIs. No React, no framework. Rendering uses an `el()` helper for element creation and manual DOM updates.
- **CSS variables**: Webview styles use VS Code's CSS custom properties (e.g. `--vscode-editor-background`) for theme compatibility. Never hardcode colors.
- **SecretStorage for secrets**: API keys are stored via `vscode.SecretStorage`, never in `settings.json` or plaintext.
- **Tool approval hook**: Tool call interception works by wrapping `extensionRunner.emitToolCall` on the Pi SDK's `AgentSession` after creation. This is the only point where tool execution can be blocked before it starts.

## File Layout

| Path | Purpose |
|---|---|
| `src/extension.ts` | Activation, command/provider registration |
| `src/shared/protocol.ts` | Typed message interfaces (ClientMessage, ServerMessage, etc.) |
| `src/pi/session.ts` | Wraps Pi SDK AgentSession lifecycle |
| `src/pi/models.ts` | Model registry helpers |
| `src/pi/auth.ts` | Auth storage singleton |
| `src/pi/events.ts` | EventRouter for agent session events |
| `src/providers/sidebar.ts` | WebviewViewProvider, tab state, tool approval round-trip |
| `src/providers/settings-panel.ts` | WebviewPanel for the settings page |
| `src/providers/diff.ts` | File change tracking, unified diff generation |
| `src/providers/checkpoint.ts` | Per-turn file snapshots, rollback/redo |
| `src/providers/status-bar.ts` | Status bar item |
| `src/utils/diff.ts` | Myers diff algorithm |
| `src/webview/main.ts` | Chat UI (runs in webview) |
| `src/webview/settings.ts` | Settings UI (runs in webview) |
| `src/webview/styles/main.css` | Chat styles |
| `src/webview/styles/settings.css` | Settings page styles |

## Common Pitfalls

- The webview bundles (`src/webview/`) cannot import `vscode` or Node.js modules. They are browser-only IIFE bundles.
- `tsconfig.json` excludes `src/webview/**/*` from the main TypeScript compilation. The webview files are compiled by esbuild only.
- The Pi SDK is dynamically imported (`await import(...)`) in `session.ts` because it is externalized and must be resolved at runtime by VS Code's module loader.
- When adding new settings, update both `package.json` (`contributes.configuration`) and `src/shared/protocol.ts` (`SettingsData` interface), then wire them in `settings-panel.ts` and `settings.ts`.
