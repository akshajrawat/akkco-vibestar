# Akkco Vibestar

Vibestar is a platform for persistent AI employees called **Vibers**.

Each Viber is an autonomous agent with a name, appearance, identity, dedicated execution environment ("Computer"), and independent conversational sessions.

## Architecture & Concepts

- **Viber**: Persistent AI employee with name, appearance, identity, and multiple independent sessions.
- **Sessions**: Independent conversation threads belonging to a Viber, each with its own workspace and native provider thread continuity.
- **Computer**: A dedicated, isolated persistent execution environment belonging to a Viber.
- **BYOS (Bring Your Own Subscription)**: Codex and Antigravity provider integration with per-turn dynamic model and reasoning effort selection.
- **Teams & Memory**: Future capabilities for grouping Vibers and acquiring cross-session persistent knowledge.

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

- **Sidebar Navigation**: The sidebar lists your Vibers. Search Vibers by name or role with the search bar (`Ctrl+F` or click), create a new Viber with the **+** button, or adjust settings and usage via the bottom dock.
- **Conversations & Workspaces**: Selecting a Viber opens directly into its conversational interface. Each Viber can maintain multiple independent sessions with dedicated workspace files or connected repositories.
- **Viber Computers**: Manage the Viber's dedicated execution environment, persistent home volume, and isolated sandboxing.
- **Model Selection**: Switch providers (Codex / Antigravity), models, and reasoning effort dynamically per conversation turn.

## Project status and documentation

- [Architecture Guide](ARCHITECTURE.md)
- [Security Boundaries](docs/security.md)
- [Development Setup](docs/development.md)
- [Testing Guide](docs/testing.md)
- [Contributing](CONTRIBUTING.md)

Project code is licensed under [MIT](LICENSE). Bundled fonts and third-party material retain their own terms; see [third-party notices](docs/third-party-notices.md).
