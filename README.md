# Akkco Vibestar

Vibestar is a platform for persistent AI employees called **Vibers**.

Each Viber is an autonomous agent with a name, custom appearance, dedicated workspace, and a single continuous conversation.

## Architecture & Concepts

- **Viber**: Persistent AI employee defined by name and avatar appearance. Creation requires no complex prompt or model setup.
- **Continuous Conversation**: Each Viber owns exactly one continuous conversation thread and workspace. No session switching or multiple chats per Viber.
- **Native Provider Session Management**: Maintains separate native conversation IDs for Codex and Antigravity, resumed across turns and restarts. A provider receives saved chat context on the first switch and the messages since its last turn when resumed.
- **BYOS (Bring Your Own Subscription)**: Official Codex and Antigravity integration with per-turn dynamic model and reasoning effort selection in the composer.

There are no Task or Workflow entities in Vibestar. Vibers are the primary operational and navigation entities.

## Supported platforms and requirements

Vibestar runs on Linux desktop or on Windows with WSL2.
The desktop interface and the execution core require Node.js 22.12 or newer and npm 10 or newer.

Official provider CLIs (`codex` or `agy`) can be used directly with your existing subscriptions and auth credentials.

## Install and run

```bash
git clone https://github.com/akshajrawat/akkco-vibestar.git
cd akkco-vibestar
npm ci
npm run dev
```

To build for production:

```bash
npm run build
npm start
```

## Basic use

- **Sidebar Navigation**: The sidebar lists your Vibers. Search Vibers by name in the sidebar and create one with the **+** button. The dock opens Repositories, Providers, Usage, and Settings in overlays above the current chat.
- **Conversations & Workspaces**: Selecting a Viber opens directly into its continuous conversation interface with dedicated workspace files or connected repositories.
- **Model Selection & Composer**: Switch providers (Codex / Antigravity), models, and reasoning effort dynamically in the composer. Use `/clear` to reset provider context when the Viber has no active turn.
- **Planning**: Use the official provider CLI's plan mode when you need a planning-only session. In interactive Codex, use `/plan`. In Antigravity, use `agy --mode plan`.

## Project status and documentation

- [Architecture Guide](ARCHITECTURE.md)
- [Security Boundaries](docs/security.md)
- [Development Setup](docs/development.md)
- [Testing Guide](docs/testing.md)
- [Contributing](CONTRIBUTING.md)

Project code is licensed under [MIT](LICENSE). Bundled fonts and third-party material retain their own terms; see [third-party notices](docs/third-party-notices.md).
