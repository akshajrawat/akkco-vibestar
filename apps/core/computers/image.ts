import { DesktopSize } from "./contracts";

export const sharedDirectory = "/home/viber/workspace";
export const desktopVersion = "5";
export const guestCommandTimeoutMs = 120_000;
export const desktopImageLabel = "dev.vibestar.desktop-image";

export const desktopImageTag = (uid: number, gid: number) =>
  `vibestar-shared:desktop-${uid}-${gid}`;

// The build context is stdin. Only the managed workspace and saved Linux home are writable.
export const computerImage = (uid: number, gid: number) => `
FROM node:22-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends \\
    bash ca-certificates chromium curl fonts-liberation gh git openbox thunar xterm python3 python3-venv \\
    scrot socat tini xauth xdotool x11-utils x11-xserver-utils xvfb \\
    && rm -rf /var/lib/apt/lists/*
RUN if ! getent group ${gid} >/dev/null; then groupadd --gid ${gid} viber; fi \\
    && if ! getent passwd ${uid} >/dev/null; then useradd --uid ${uid} --gid ${gid} --home-dir /home/viber viber; fi \\
    && install -d -m 700 -o ${uid} -g ${gid} /home/viber ${sharedDirectory}
COPY --chmod=755 <<'EOF_DESKTOP' /usr/local/bin/vibestar-desktop
#!/bin/bash
set -eu
# A replaced container can leave a Chromium lock for its old hostname.
# Clear it before this desktop starts any browser using the saved profile.
lock="$HOME/chromium/SingletonLock"
if [ -L "$lock" ]; then
  rm -- "$lock"
fi
Xvfb :0 -screen 0 ${DesktopSize.width}x${DesktopSize.height}x24 -s 0 -noreset -nolisten tcp &
display=$!
for attempt in {1..80}; do
  xdpyinfo >/dev/null 2>&1 && break
  kill -0 "$display"
  sleep .1
done
xdpyinfo >/dev/null
xsetroot -solid '#26364b'
openbox &
wm=$!
vibestar-browser --foreground &
browser=$!
trap 'kill -TERM "$browser" "$wm" 2>/dev/null || true; wait "$browser" "$wm" || true; kill -TERM "$display" 2>/dev/null || true' TERM INT EXIT
for attempt in {1..80}; do
  kill -0 "$browser" "$wm"
  if xdotool search --onlyvisible --class chromium >/dev/null 2>&1 &&
     curl -fsS --max-time 1 http://127.0.0.1:9222/json/version >/dev/null 2>&1; then
    touch /tmp/vibestar-desktop-ready
    break
  fi
  sleep .1
done
test -f /tmp/vibestar-desktop-ready
wait "$display"
EOF_DESKTOP
COPY --chmod=755 <<'EOF_BROWSER' /usr/local/bin/vibestar-browser
#!/bin/sh
set -eu
foreground=0
if [ "\${1:-}" = "--foreground" ]; then
  foreground=1
  shift
fi
if [ "$#" -eq 0 ]; then
  set -- about:blank
fi
set -- chromium --disable-dev-shm-usage --no-first-run --no-default-browser-check \\
  --disable-sync --user-data-dir=/home/viber/chromium --start-maximized \\
  --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 "$@"

browser_ready() {
  curl -fsS --max-time 1 http://127.0.0.1:9222/json/version >/dev/null 2>&1
}

if [ "$foreground" -eq 1 ] || browser_ready; then
  exec "$@"
fi

# A browser reopened from a turn must outlive that turn's command process group.
setsid -f "$@" </dev/null >/tmp/vibestar-browser.log 2>&1
for attempt in $(seq 80); do
  if browser_ready; then
    exit 0
  fi
  sleep .1
done
cat /tmp/vibestar-browser.log >&2
exit 1
EOF_BROWSER
COPY --chmod=755 <<'EOF_EXEC' /usr/local/bin/vibestar-exec
#!/usr/bin/env node
const { spawn } = require("node:child_process");
const child = spawn("/bin/bash", ["-c", process.argv[2]], {
  detached: true,
  stdio: ["ignore", "inherit", "inherit"],
});

let finished = false;
const finish = (code) => {
  if (finished) {
    return;
  }

  finished = true;
  clearTimeout(timer);
  if (child.pid) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") {
        throw error;
      }
    }
  }

  process.stdin.destroy();
  process.exitCode = code;
};

const timer = setTimeout(() => finish(124), ${guestCommandTimeoutMs});
// The host keeps stdin open for the lifetime of the HTTP request.
process.stdin.on("end", () => finish(130));
process.stdin.resume();
child.on("exit", (code) => finish(code ?? 1));
child.on("error", (error) => {
  console.error(error.message);
  finish(126);
});
EOF_EXEC
COPY <<'EOF_MENU' /etc/xdg/openbox/menu.xml
<?xml version="1.0" encoding="UTF-8"?>
<openbox_menu xmlns="http://openbox.org/3.4/menu">
  <menu id="root-menu" label="Shared Computer">
    <item label="Chromium"><action name="Execute"><command>vibestar-browser</command></action></item>
    <item label="Terminal"><action name="Execute"><command>sh -c 'cd ${sharedDirectory} &amp;&amp; exec xterm'</command></action></item>
    <item label="Files"><action name="Execute"><command>thunar ${sharedDirectory}</command></action></item>
  </menu>
</openbox_menu>
EOF_MENU
USER ${uid}:${gid}
ENV HOME=/home/viber DISPLAY=:0 BROWSER=/usr/local/bin/vibestar-browser
WORKDIR ${sharedDirectory}
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/usr/local/bin/vibestar-desktop"]
LABEL ${desktopImageLabel}="${uid}-${gid}" dev.vibestar.desktop="${desktopVersion}"
`;
