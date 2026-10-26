# Development

## Environment

Use Node.js 22.12+ and npm 10+. The execution core runs on Linux, including WSL2;
Windows hosts the Electron GUI while Git, SQLite and providers remain in WSL.
Install Git, official `gh`, Bubblewrap, Python 3 and a C/C++ build toolchain.
Electron also needs the graphical/system libraries appropriate to your distribution.

On Ubuntu, the core build prerequisites can be installed with:

```bash
sudo apt install git gh bubblewrap build-essential python3 unzip
```

Electron library package names differ between Ubuntu releases; use your distribution's
GTK/NSS/GBM/audio runtime packages. Confirm that `bwrap` can create an unprivileged
namespace. Do not disable the application sandbox to work around missing host support.

Install official provider CLIs separately and authenticate through their supported
login flows. Discoverable models/efforts come from those CLIs, not hardcoded tier claims.
Unit/integration/security fixtures do not require logged-in providers.

## Run the checkout

```bash
npm ci
npm run dev
```

The launcher builds the Node core and Electron entries, starts Vite on loopback port
1420 and opens Electron. Renderer changes use HMR. Backend/Electron changes rebuild
and restart the host after graceful core shutdown. Closing the desktop stops Vite.
`npm run dev:ui` starts only Vite; the app still needs its preload API for real operations.

For manual experiments, choose a separate absolute Linux data directory:

```bash
VIBESTAR_HOME=/tmp/vibestar-development npm run dev
```

Do not delete or repurpose your normal data root. The default is
`~/.akkco-vibestar`, with SQLite under `state`, owned repositories/worktrees,
redacted logs, artifacts, cache and runtime/helper state. Legacy root migration
is an explicit application choice and preserves backups and ownership checkpoints.

## Windows and WSL

When launched from WSL, development downloads/caches the matching official native
Windows Electron runtime using checksum-verified `@electron/get`. The current distro,
checkout core and Linux data root are passed through development-only configuration.
Windows Node is not required for that WSL launcher. Windows interoperability and
`unzip` are required. `VIBESTAR_DEV_HOST=linux npm run dev` selects the WSLg host for
diagnostics; it retains the documented compositor/frameless-window limitations.

For an installed native Windows host:

1. Make Node, Git, `gh`, Bubblewrap and providers available in the selected WSL distro.
2. Verify noninteractive Node startup from Windows, for example
   `wsl.exe --distribution Ubuntu --exec node --version`.
3. In Settings select the distro and an optional absolute Linux data directory.
4. Save and explicitly install/update the WSL helper.
5. Keep execution repositories/data on the Linux filesystem.

The helper contains the built core and its locked Linux native dependencies. Build
hash/capability checks prevent unsupported mutations against a stale helper. Windows
keeps its small desktop configuration/profile locally; execution state remains in WSL.

## Build and packaging

```bash
npm run build
npm start
npm run desktop:build
```

`build` typechecks, bundles `backend/main.ts` to `dist-core/core.cjs`, bundles Electron
main/preload to `dist-electron`, installs locked Node-native core dependencies and
builds the renderer to `dist`. Fonts and the Geist OFL notice are bundled locally.
The core's SQLite/PTY addons target Node, not Electron; do not rebuild them for Electron.
An explicit resource mapping preserves `dist-core/node_modules` in Linux-built packages.
Native Windows builds install the helper's Linux dependencies through its locked manifest in WSL.

`desktop:build` creates a local Linux deb/unpacked app under ignored `release`.
From a Windows checkout, `npm run desktop:build:windows` builds NSIS. Linux cross-builds
may require Wine. Both commands use `--publish never`. Packaging does not prove a
native installer/update flow works; signing and official release distribution are
outside this milestone.

Never commit generated `dist*`, `release`, coverage, local databases or test evidence.

## Contributor tooling

`npm ci` runs the guarded hook installer. It skips CI, production installs, `HUSKY=0`,
linked worktrees and source archives without a Git directory. It preserves an existing
`core.hooksPath` or ordinary custom hook set. Husky's generated `.husky/_` is ignored.

Pre-commit formats/lints staged files via lint-staged; its default backup and partial
staging protection remain enabled. Pre-push runs formatting, lint, types, regular
regressions and security checks. `npm run verify` adds integration, PTY and build.

See [Husky's documentation](https://typicode.github.io/husky/how-to.html) and
[lint-staged's documentation](https://github.com/lint-staged/lint-staged#readme)
for their local environment behavior. Contributor hooks do not replace application
publishing guards or CI. Do not alter a private hook policy just to install them.
