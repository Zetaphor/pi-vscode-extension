# Pi Agent for VS Code

A VS Code extension that provides a first-class UI for [Mario Zechner's Pi coding agent](https://github.com/badlogic/pi-mono) — an AI agent that can read, write, edit files, run commands, search your codebase, and more, all from within the editor. The UX is heavily inspired by [Cursor](https://www.cursor.com/).

![Pi Agent screenshot](screenshot.png)

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

### Settings Page
A dedicated settings panel (accessible via the gear icon in the sidebar header or the `Pi: Open Settings` command) provides configuration for API connection, default model and thinking level, tool execution behavior, and session management. API keys are stored securely via VS Code's SecretStorage and never written to disk in plaintext.

### Tool Approval
When auto-approve is disabled (the default), each tool call pauses execution and shows an inline approval card in the chat with the tool name, arguments preview, and Approve/Reject buttons. This gives you full control over what the agent executes before it happens.

### Message Queuing & Steering
While the agent is streaming, you can **queue** follow-up messages that will be sent automatically once the current generation finishes. Queued messages appear in a collapsible list above the input with inline edit and delete controls. You can also **steer** the agent mid-generation (Ctrl+Enter) to inject guidance into the current response without waiting.

### Slash Commands & Skills
Type `/` in the input to trigger a slash-command menu that surfaces available Pi skills. Select a skill to insert it into your prompt. Skills are loaded from `~/.pi/agent/skills/` and `.pi/skills/` in your workspace.

### Context Usage
Token usage and context window utilization are displayed in both the chat footer and the status bar tooltip.

## Prerequisites

This extension embeds the [Pi coding agent](https://github.com/badlogic/pi-mono) SDK as an npm dependency. You do **not** need to install Pi separately, but you do need the following on your system before building or running the extension.

### 1. Node.js 18+

Install Node.js `18` or later. Any of the following will work:

- [Official installer](https://nodejs.org/)
- A version manager such as [nvm](https://github.com/nvm-sh/nvm), [fnm](https://github.com/Schniz/fnm), or [mise](https://mise.jdx.dev/)

Verify with:

```bash
node --version   # v18.x or later
npm --version
```

### 2. VS Code 1.100.0+

Install [VS Code](https://code.visualstudio.com/) `1.100.0` or later. Compatible forks such as [Cursor](https://www.cursor.com/) also work.

### 3. AI Provider Credentials

The Pi agent needs credentials for at least one AI provider. You can authenticate in two ways:

**Option A — Settings page (recommended):**

Open the Pi Agent settings page (gear icon in the sidebar header, or `Pi: Open Settings` from the command palette) and enter your API key for your preferred provider. Keys are stored securely via VS Code's SecretStorage and never written to disk in plaintext.

**Option B — Environment variable:**

Set the appropriate environment variable before launching VS Code:

```bash
# Anthropic
export ANTHROPIC_API_KEY=sk-ant-...

# OpenAI
export OPENAI_API_KEY=sk-...

# Google Gemini
export GEMINI_API_KEY=...

# DeepSeek
export DEEPSEEK_API_KEY=...
```

Other supported API-key providers include Azure OpenAI, Google Vertex, Amazon Bedrock, Mistral, Groq, Cerebras, xAI, OpenRouter, Vercel AI Gateway, Hugging Face, Fireworks, Kimi For Coding, and MiniMax. See [Pi's provider docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/providers.md) for the full list and variable names.

**Option C — Subscription login:**

If you have an Anthropic Claude Pro/Max, OpenAI ChatGPT Plus/Pro, GitHub Copilot, Google Gemini CLI, or Google Antigravity subscription, you can authenticate via Pi's OAuth flow. Install Pi globally and run the login command once:

```bash
npm install -g @mariozechner/pi-coding-agent
pi
/login   # select your provider and complete the browser flow
```

The token is stored in `~/.pi/agent/` and the extension will pick it up automatically.

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
3. Type a prompt and press Enter (or Shift+Enter for newlines).
4. Watch the agent stream its response, invoke tools, and make file changes.
5. While streaming, press Enter to **queue** a follow-up or Ctrl+Enter to **steer** the current generation.
6. Review diffs inline or click **Review** to open VS Code's diff editor.
7. Use checkpoint buttons on your messages to roll back if needed.
8. Type `/` to search and insert skills via the slash-command menu.

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+L` (`Cmd+Shift+L`) | Focus the Pi Agent chat panel |
| `Ctrl+Shift+N` (`Cmd+Shift+N`) | Start a new chat session |
| `Enter` | Send prompt, or queue message while streaming |
| `Ctrl+Enter` (`Cmd+Enter`) | Steer the agent mid-generation |
| `Escape` | Stop the current generation (while streaming) |

## Commands

All commands are available from the command palette (`Ctrl+Shift+P`):

- **Pi: New Chat** — Start a fresh agent session in a new tab
- **Pi: Stop Generation** — Abort the current streaming response
- **Pi: Select Model** — Choose an AI model from the available providers
- **Pi: Toggle Thinking Level** — Cycle through thinking verbosity levels
- **Pi: Focus Chat** — Bring focus to the Pi Agent sidebar
- **Pi: Open Settings** — Open the Pi Agent settings page

## Settings

Settings can be configured through the dedicated settings page (gear icon in the sidebar) or via VS Code's standard settings editor.

| Setting | Type | Default | Description |
|---|---|---|---|
| `pi-agent.apiProvider` | `string` | `""` | Preferred AI provider (anthropic, openai, google, deepseek). Leave empty for auto-detect. |
| `pi-agent.apiBaseUrl` | `string` | `""` | Custom API base URL for proxies or self-hosted endpoints |
| `pi-agent.defaultModel` | `string` | `""` | Default model ID for new sessions (e.g. `claude-sonnet-4-20250514`) |
| `pi-agent.thinkingLevel` | `string` | `off` | Default thinking level (`off`, `minimal`, `low`, `medium`, `high`) |
| `pi-agent.autoApproveTools` | `boolean` | `false` | Auto-approve tool executions without confirmation |
| `pi-agent.allowedTools` | `string[]` | `[]` | Restrict which tools the agent can use. Empty = allow all. |
| `pi-agent.autoSaveSessions` | `boolean` | `true` | Automatically persist sessions |
| `pi-agent.sessionStoragePath` | `string` | `""` | Custom session storage path. Empty = workspace `.pi/` directory. |
| `pi-agent.contextUsageWarningThreshold` | `number` | `80` | Warn when context usage exceeds this percentage |

API keys are managed through the settings page and stored via VS Code's SecretStorage (never in `settings.json`).

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
- **SidebarProvider** (`src/providers/sidebar.ts`) manages tabs, each containing an independent `PiSessionManager`, `DiffManager`, and `CheckpointManager`. Also handles tool approval round-trips.
- **SettingsPanel** (`src/providers/settings-panel.ts`) opens a `WebviewPanel` in the editor area for the settings page, backed by VS Code's configuration API and `SecretStorage`.
- **Webview** (`src/webview/main.ts`) renders the chat UI, inline tool approval cards, and communicates with the extension host via typed messages defined in `src/shared/protocol.ts`.
- **PiSessionManager** (`src/pi/session.ts`) wraps `createAgentSession` from `@mariozechner/pi-coding-agent`, handling prompt/steer/follow-up/abort lifecycle. Reads configuration on session creation and installs tool approval hooks via the SDK's extension runner.
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
│   ├── sidebar.ts            # Webview provider, tab management, tool approval
│   ├── settings-panel.ts     # Settings page (WebviewPanel)
│   ├── diff.ts               # File change tracking, VS Code diff integration
│   ├── checkpoint.ts         # Per-turn snapshots, rollback/redo
│   └── status-bar.ts         # Status bar item
├── utils/
│   └── diff.ts               # Myers diff algorithm, unified diff formatting
├── webview/
│   ├── main.ts               # Chat UI application
│   ├── settings.ts           # Settings page UI
│   └── styles/
│       ├── main.css          # Chat webview styles
│       └── settings.css      # Settings page styles
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

## Credits

Icons by [Royyan Wijaya](https://www.flaticon.com/authors/royyan-wijaya) on Flaticon.

## License

MIT
