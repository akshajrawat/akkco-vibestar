# Akkco Vibestar

Vibestar is a desktop app for building a team of AI assistants you can return to. Each assistant, called a **Viber**, has its own workspace and an ongoing conversation. Give it a job, come back with a follow-up, or switch AI providers without starting the conversation over.

The goal is to make everyday work easier to delegate, from one-off tasks to recurring work.

## What you can do today

- **Create Vibers for different jobs.** Give each one a name and a workspace. Connect a repository when the job needs one.
- **Use your existing AI subscriptions.** Connect Codex or Google Antigravity, choose a model in chat, and carry conversation context over when you switch providers.
- **Let a Viber remember useful details.** Memory is optional and stored locally. You decide which providers can receive recalled details.

## Run locally

Vibestar runs on Linux or Windows with WSL2. You’ll need Node.js 22.12 or later, npm 10 or later, and a signed-in Codex or Antigravity CLI to chat. See the [local setup guide](docs/development.md) for system dependencies and Windows setup.

```bash
git clone https://github.com/akshajrawat/akkco-vibestar.git
cd akkco-vibestar
npm ci
npm run dev
```

Once the app opens, create a Viber with **+**, choose a provider and model in chat, and give it a job.

[Architecture](ARCHITECTURE.md) · [Memory setup](docs/viber-memory.md) · [Security](docs/security.md) · [Testing](docs/testing.md)

[MIT License](LICENSE) · [Third-party notices](docs/third-party-notices.md)
