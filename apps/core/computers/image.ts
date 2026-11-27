import { DesktopSize } from "./contracts";

export const sharedDirectory = "/home/viber/workspace";
export const desktopVersion = "3";

// The build context is stdin. Only the managed workspace and saved Linux home are writable.
export const computerImage = (uid: number, gid: number) => `
FROM node:22-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends \\
    bash ca-certificates chromium curl fonts-liberation git openbox thunar xterm python3 python3-venv \\
    scrot socat tini xauth xdotool x11-utils x11-xserver-utils xvfb \\
    && rm -rf /var/lib/apt/lists/*
RUN if ! getent group ${gid} >/dev/null; then groupadd --gid ${gid} viber; fi \\
    && if ! getent passwd ${uid} >/dev/null; then useradd --uid ${uid} --gid ${gid} --home-dir /home/viber viber; fi \\
    && install -d -m 700 -o ${uid} -g ${gid} /home/viber ${sharedDirectory}
COPY --chmod=755 <<'EOF_DESKTOP' /usr/local/bin/vibestar-desktop
#!/bin/bash
set -eu
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
vibestar-browser &
browser=$!
trap 'kill -TERM "$browser" "$wm" 2>/dev/null || true; wait "$browser" "$wm" || true; kill -TERM "$display" 2>/dev/null || true' TERM INT EXIT
for attempt in {1..80}; do
  kill -0 "$browser" "$wm"
  if xdotool search --onlyvisible --class chromium >/dev/null 2>&1; then
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
exec chromium --disable-dev-shm-usage --no-first-run --no-default-browser-check \\
  --disable-sync --user-data-dir=/home/viber/chromium --start-maximized about:blank
EOF_BROWSER
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
ENV HOME=/home/viber DISPLAY=:0
WORKDIR ${sharedDirectory}
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/usr/local/bin/vibestar-desktop"]
`;
