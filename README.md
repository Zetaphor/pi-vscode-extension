# Pi Agent for VS Code

A VS Code extension that provides a first-class UI for [Mario Zechner's Pi coding agent](https://github.com/badlogic/pi-mono) — an AI agent that can read, write, edit files, run commands, search your codebase, and more, all from within the editor.

## Features

### Sidebar Chat Interface
A dedicated activity bar panel with a full chat UI for interacting with the Pi agent. Send prompts, view streaming responses with thinking blocks, and inspect tool calls — all inline.

### Multi-Tab Sessions
Run multiple independent agent sessions in parallel. Each tab maintains its own conversation history, file change tracking, and checkpoint state.

### Tool Visibility
Every tool the agent invokes (file reads, writes, edits, shell commands, glob/grep searches) is rendered as an expandable card showing arguments and results in real time.

### Inline Diffs & File Change Tracking
File modifications made by the agent are tracked automatically. Review unified diffs inline in the chat or open them in VS Code's native diff editor. Undo individual file changes or all changes at once.

### Checkpoints & Rollback
Each user message creates a checkpoint. Restore your workspace to any previous checkpoint, then redo to get changes back. The message history is preserved so you can branch the conversation from any point.

### Streaming with Thinking
Watch the agent's reasoning in real time with collapsible thinking blocks. Cycle through thinking levels (`off`, `minimal`, `low`, `medium`, `high`) to control how much internal reasoning is shown.

### Model Selection
Pick from any model available through the Pi agent's model registry via a quick-pick menu or the in-chat model picker. Recently used models are surfaced for fast switching.

### Context Usage
Token usage and context window utilization are displayed in both the chat footer and the status bar tooltip.

## Requirements

- **VS Code** `1.100.0` or later (or a compatible fork such as Cursor)
- **Node.js** `18+`
- A valid API key for at least one supported AI provider, configured through [Pi's auth system](https://www.npmjs.com/package/@mariozechner/pi-coding-agent)

## Installation

### From Source

```bash
git clone <repo-url>
cd ai-vscode-extension
npm install
npm run compile
```

Then press **F5** in VS Code to launch an Extension Development Host with the extension loaded.

### As a VSIX Package

```bash
npm run package
```

This produces a `.vsix` file you can install via **Extensions > Install from VSIX...** in VS Code.

## Usage

1. Click the **Pi Agent** icon in the activity bar to open the sidebar.
2. Select a model using the model picker at the bottom of the chat or via the command palette (`Pi: Select Model`).
3. Type a prompt and press Enter (or Ctrl+Enter for newlines).
4. Watch the agent stream its response, invoke tools, and make file changes.
5. Review diffs inline or click **Review** to open VS Code's diff editor.
6. Use checkpoint buttons on your messages to roll back if needed.

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+L` (`Cmd+Shift+L`) | Focus the Pi Agent chat panel |
| `Ctrl+Shift+N` (`Cmd+Shift+N`) | Start a new chat session |
| `Escape` | Stop the current generation (while streaming) |

## Commands

All commands are available from the command palette (`Ctrl+Shift+P`):

- **Pi: New Chat** — Start a fresh agent session in a new tab
- **Pi: Stop Generation** — Abort the current streaming response
- **Pi: Select Model** — Choose an AI model from the available providers
- **Pi: Toggle Thinking Level** — Cycle through thinking verbosity levels
- **Pi: Focus Chat** — Bring focus to the Pi Agent sidebar

## Settings

| Setting | Type | Default | Description |
|---|---|---|---|
| `pi-agent.thinkingLevel` | `string` | `off` | Default thinking level for agent responses (`off`, `minimal`, `low`, `medium`, `high`) |
| `pi-agent.autoApproveTools` | `boolean` | `false` | Automatically approve tool executions without confirmation |

## Architecture

```
┌─────────────────────────────────────────────┐
│                  VS Code                     │
│                                              │
│  ┌──────────┐   ┌────────────────────────┐  │
│  │ Extension │──▶│   SidebarProvider       │  │
│  │ activate()│   │   (WebviewViewProvider) │  │
│  └──────────┘   └───────────┬────────────┘  │
│       │                     │                │
│       ▼                     ▼                │
│  ┌──────────┐   ┌────────────────────────┐  │
│  │StatusBar  │   │     Webview (chat UI)  │  │
│  │          │   │     main.ts + CSS      │  │
│  └──────────┘   └───────────┬────────────┘  │
│                             │                │
│              ClientMessage / ServerMessage    │
│              (src/shared/protocol.ts)        │
│                             │                │
│                     ┌───────▼──────┐         │
│                     │  Tab State   │         │
│                     │  ┌─────────┐ │         │
│                     │  │ Session  │ │         │
│                     │  │ Diffs    │ │         │
│                     │  │Checkpoint│ │         │
│                     │  └─────────┘ │         │
│                     └───────┬──────┘         │
│                             │                │
│                     ┌───────▼──────┐         │
│                     │ Pi Coding    │         │
│                     │ Agent (npm)  │         │
│                     └──────────────┘         │
└─────────────────────────────────────────────┘
```

- **Extension host** (`src/extension.ts`) registers providers and commands on activation.
- **SidebarProvider** (`src/providers/sidebar.ts`) manages tabs, each containing an independent `PiSessionManager`, `DiffManager`, and `CheckpointManager`.
- **Webview** (`src/webview/main.ts`) renders the chat UI and communicates with the extension host via typed messages defined in `src/shared/protocol.ts`.
- **PiSessionManager** (`src/pi/session.ts`) wraps `createAgentSession` from `@mariozechner/pi-coding-agent`, handling prompt/steer/follow-up/abort lifecycle.
- **DiffManager** (`src/providers/diff.ts`) tracks file changes from `edit`/`write` tool calls and provides unified diffs via a `pi-diff:` virtual document scheme.
- **CheckpointManager** (`src/providers/checkpoint.ts`) snapshots file state per turn for rollback and redo.

## Project Structure

```
src/
├── extension.ts              # Entry point, activation
├── shared/
│   └── protocol.ts           # Typed message protocol (Client ↔ Server)
├── pi/
│   ├── session.ts            # Agent session lifecycle
│   ├── models.ts             # Model registry wrapper
│   ├── auth.ts               # Auth storage singleton
│   └── events.ts             # Event router for agent events
├── providers/
│   ├── sidebar.ts            # Webview provider, tab management
│   ├── diff.ts               # File change tracking, VS Code diff integration
│   ├── checkpoint.ts         # Per-turn snapshots, rollback/redo
│   └── status-bar.ts         # Status bar item
├── utils/
│   └── diff.ts               # Myers diff algorithm, unified diff formatting
├── webview/
│   ├── main.ts               # Chat UI application
│   └── styles/main.css       # Webview styles
└── test/
    ├── unit/                  # Vitest unit tests
    └── integration/           # VS Code integration tests
```

## Development

```bash
# Install dependencies
npm install

# Compile (extension + webview bundles via esbuild)
npm run compile

# Watch mode (recompiles on save)
npm run watch

# Run unit tests
npm run test:unit

# Run integration tests (requires prior compile)
npm run test:integration

# Run all tests
npm run test:all
```

Use the **Run Extension** launch configuration (F5) to open an Extension Development Host with the extension loaded and debuggable.

## License

MIT
