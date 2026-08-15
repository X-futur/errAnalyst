<h1 align="center">ErrAnalyst</h1>

<p align="center">
  <a href="README.md">中文</a> · <a href="README.en.md">English</a>
</p>

<p align="center">
  The last mile for terminal errors: auto-capture, AI translation, root-cause analysis, and one-click fixes
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-brightgreen.svg" alt="License: MIT"></a>
  <a href="package.json"><img src="https://img.shields.io/badge/Version-0.1.1-007acc.svg" alt="Version"></a>
  <a href="package.json"><img src="https://img.shields.io/badge/VS%20Code-%3E%3D1.96-8250df.svg" alt="VS Code >= 1.96"></a>
  <a href="package.json"><img src="https://img.shields.io/badge/Node-%3E%3D18-339933.svg" alt="Node >= 18"></a>
  <a href="docs/adr"><img src="https://img.shields.io/badge/Docs-ADR%20%26%20Glossary-8A2BE2.svg" alt="Docs"></a>
</p>

---

## Introduction

> Solves the last-mile problem of copying terminal errors into an AI chat.

A VS Code extension that analyzes Python errors, locates the failing code, translates error messages, and offers one-click fixes. When a Traceback appears in the terminal, it automatically explains the root cause and provides a Chinese translation, fix suggestions, and confirmable code patches. A built-in analysis chat plus short/long-term memory keeps follow-up analysis aligned with your habits.

## Features

- 🎯 **Automatic error capture**: captures Python Tracebacks from the terminal with no manual copying
- 📎 **Automatic context collection**: locates the failing code and captures the relevant context automatically
- 🧠 **Error analysis**: AI translates the message, explains the root cause, surfaces core error terms with Chinese/English pairs, and gives fix suggestions
- 🔧 **One-click fix**: generates fix patches with diff previews; changes are applied only after per-hunk confirmation
- 💬 **Error analysis chat**: ask follow-up questions about the current error; patches can be generated from the conversation
- 🗂️ **Local cache**: keeps error history available for review
- 🧬 **Memory system**: short-term memory (rolling session summaries) and long-term memory (fix preferences, suggestion preferences, analysis preferences, frequent-error stats)
- 🔌 **Multiple AI providers**: DeepSeek, Kimi (Moonshot), Qwen, plus any OpenAI-compatible API
- ⌨️ **Companion CLI**: the `erranalyst` command covers provider setup, model switching, cache, and memory management

## Table of Contents

- [Local Deployment](#local-deployment)
- [CLI Deployment](#cli-deployment)
- [Usage](#usage)
- [Memory System](#memory-system)
- [Configuration](#configuration)
- [Project Docs](#project-docs)
- [License](#license)

## Local Deployment

### Requirements

| Dependency | Version / Notes |
| --- | --- |
| VS Code | ≥ 1.96.0 (minimum version declared by the extension) |
| Node.js | ≥ 18, 20.x LTS recommended (compile, packaging, and CLI all use npm) |
| Python | ≥ 3.x (prerequisite for triggering and analyzing errors; the extension is not tied to a specific Python version) |
| Terminal shell integration | Enable VS Code terminal Shell Integration, otherwise errors cannot be captured automatically |
| AI service | Base URL and API Key of any OpenAI-compatible API (e.g., DeepSeek / Kimi / Qwen) |
| OS | macOS / Linux can use the install script directly; on Windows use Git Bash or WSL for the CLI scripts |

### Option 1: From Source (Development)

1. Clone the repository and install dependencies:

   ```bash
   git clone https://github.com/X-futur/errAnalyst.git
   cd errAnalyst
   npm install
   ```

2. Compile:

   ```bash
   npm run compile
   ```

   During development you can also use watch mode to recompile on changes:

   ```bash
   npm run watch
   ```

3. Open the project in VS Code and press `F5` to launch the Extension Development Host, which loads this repository's extension.

4. Configure an AI provider: on first activation, the config wizard opens automatically if no provider is available; alternatively run `erranalyst provider set` from the Command Palette or the terminal:

   ```bash
   erranalyst provider set
   ```

> Note: running the `bash` command in the terminal requires the CLI to be installed first; same applies below.

5. Verify: run a Python script that raises an error (e.g., `python3 main.py`) in the integrated terminal; the error analysis should appear in the sidebar automatically.

### Option 2: Packaged VSIX (Release Path)

1. Download the `VSIX` file from the repository's `release` page.

2. Install into VS Code:

   - Open the Extensions view (`Cmd/Ctrl + Shift + X`) → `...` at the top right → **Install from VSIX...** → select the `.vsix` file;
   - or from the command line:

     ```bash
     code --install-extension err-analyst-0.1.0.vsix
     ```

3. After reloading the window, follow the config wizard or run `erranalyst provider set` to configure an AI provider.

> Note: the VSIX contains only compiled artifacts; source deployment and VSIX deployment can coexist. Development debugging (F5) does not interfere with a regular installation.

## CLI Deployment

The `erranalyst` command provides provider configuration, cache viewing, memory management, and more. Installing the VSIX does not add the CLI to `PATH` automatically — pick one of the options below.

### Option 1: Install Script (recommended with VSIX)

Download `install-cli.sh` from the `release` page and run:

```bash
# Downloads via browser/CLI may drop the Unix executable bit; restore it first
chmod +x install-cli.sh
./install-cli.sh
source ~/.zshrc
```

> Tip: if the permissions are still `-r--r--r--`, you can run `bash install-cli.sh` instead — the result is the same.

The script installs a dynamic wrapper into `~/.local/bin` and adds that directory to your shell config (`~/.zshrc` / `~/.bashrc`); it takes effect in new terminals. The wrapper locates the **newest installed** errAnalyst extension in the VS Code extension directory on every run, so upgrading the extension requires no re-run of the script.

Verify:

```bash
erranalyst help
```

Uninstall:

```bash
./install-cli.sh uninstall
```

This removes the wrapper and cleans up the PATH marker from your shell config.

### Option 2: Global npm (recommended with source development)

During development, use a global npm link so the CLI always follows the repository code:

```bash
cd /path/to/errAnalyst
npm link
```

This is equivalent to installing into the npm global bin directory (e.g., `~/.npm-global/bin`). Link mode needs no re-run — repository changes take effect immediately. For a regular global install (without linking):

```bash
npm install -g /path/to/errAnalyst
```

### PATH Priority and Conflicts

The same machine can have both CLIs (the install-script wrapper and the npm global link). Command resolution follows `PATH` order; `~/.local/bin` usually comes before the npm global bin, so the wrapper wins.

- To use the npm global one: uninstall the wrapper first (`./install-cli.sh uninstall`), then in a new terminal `command -v erranalyst` should point at the npm global bin;
- To keep the wrapper: just use it — it always runs the newest version inside the extension directory.

Check which one is active:

```bash
which -a erranalyst
command -v erranalyst
erranalyst help
```

## Usage

After installing and configuring an AI provider, run Python scripts in the integrated terminal and errors are analyzed automatically. You can also use the Command Palette (`Cmd/Ctrl + Shift + P`) or the CLI:

> "Both" means the command is available both as a VS Code command and via the CLI.

| Command | Availability | Description |
| --- | --- | --- |
| `erranalyst focuspanel show` | VS Code | Open the sidebar |
| `erranalyst analyst lasterr` | VS Code | Analyze the last captured error |
| `erranalyst cache clear` | Both | Clear the local cache |
| `erranalyst cache show` | Both | Show the local error cache |
| `erranalyst provider set` | Both | Configure an AI provider and API key |
| `erranalyst provider switch` | Both | Switch the active AI provider |
| `erranalyst config show` | Both | Show the current configuration |
| `erranalyst model set` | Both | Change the model of an AI provider |
| `erranalyst memory config` | Both | View and manage long-term memory (preferences, frequent errors, toggle) |

## Memory System

- **Short-term memory**: message history and rolling summaries of the current error session, kept in-process only; when history is truncated, early messages are compressed into a summary so earlier context is not lost.
- **Long-term memory**: persisted to `~/.errAnalyst/memory.json` — fix preferences (how patches should be written), fix-suggestion preferences (how textual guidance should be phrased), analysis preferences (how results should be explained), and frequent-error stats; injected by output type into analysis, patches, and chat prompts.
- **Implicit learning**: accepted hunks are aggregated by their change reason; a reason accepted ≥2 times becomes an active preference automatically, while a single occurrence becomes a candidate awaiting confirmation.
- **Management**: run `erranalyst memory config` to view, add, edit, delete entries, confirm candidates, and toggle memory (`errAnalyst.memory.enabled`).

## Configuration

First-time setup requires configuring an AI provider (`errAnalyst.providers`) and an API key, either via `erranalyst provider set` or the config wizard. DeepSeek, Kimi, and Qwen presets are built in.

The only legitimate source of model names is each provider's official model list: preset providers only allow models from the official list (the fastest recommended model is pinned to the top and selected by default); names outside the list are rejected at write time with guidance to use a custom provider instead. For custom providers, the official `/models` list is fetched at save time, falling back to a connection test when the fetch fails; models that miss the list or cannot be verified are explicitly labeled (non-official model / not verified against the official list). Legacy configs with retired or out-of-list models produce a warning during analysis (without blocking it) and are flagged in `erranalyst config show`.

| Setting | Default | Description |
| --- | --- | --- |
| `errAnalyst.providers` | three presets | AI provider list (Base URL / Model / API Key / model source status) |
| `errAnalyst.activeProvider` | `DeepSeek` | Active provider |
| `errAnalyst.enableCache` | `true` | Save error history (for review only; does not participate in analysis) |
| `errAnalyst.aiTimeout` | `15000` | AI request timeout (ms) |
| `errAnalyst.enableOneClickFix` | `true` | Enable one-click fix |
| `errAnalyst.enableChat` | `true` | Enable error analysis chat |
| `errAnalyst.memory.enabled` | `true` | Enable long-term memory (when off, nothing is read, written, or injected into prompts) |

Local data files:

| File | Contents |
| --- | --- |
| `~/.errAnalyst/cache.json` | Error analysis cache (for review only; does not participate in analysis) |
| `~/.errAnalyst/memory.json` | Long-term memory (preferences and frequent-error stats, participate in analysis) |
| `~/.errAnalyst/credentials.json` | API key mirror read by the CLI |

## Project Docs

- [CONTEXT.md](CONTEXT.md) — domain glossary (unifies project terminology)
- [docs/adr](docs/adr) — Architecture Decision Records (ADRs)
- [docs/design-v1.md](docs/design-v1.md) through [docs/design-v6.md](docs/design-v6.md) — iterative design documents

## License

[MIT](LICENSE)
