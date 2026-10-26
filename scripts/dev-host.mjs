import electronPath from "electron";
import { downloadArtifact } from "@electron/get";

import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const exec = promisify(execFile);
const wslpath = async (direction, path) => (await exec("wslpath", [direction, path])).stdout.trim();

export const resolveDevHost = async () => {
  const env = { ...process.env, VIBESTAR_DEV_URL: "http://127.0.0.1:1420" };
  if (
    process.platform !== "linux" ||
    !process.env.WSL_DISTRO_NAME ||
    process.env.VIBESTAR_DEV_HOST === "linux"
  )
    return { executable: electronPath, args: [resolve(".")], env };
  await access("/proc/sys/fs/binfmt_misc/WSLInterop");

  const windowsLocal = (
    await exec("powershell.exe", [
      "-NoProfile",
      "-Command",
      "[System.Environment]::GetFolderPath('LocalApplicationData')",
    ])
  ).stdout.trim();

  const version = JSON.parse(
    await readFile(new URL("../node_modules/electron/package.json", import.meta.url), "utf8"),
  ).version;

  const arch = process.arch;

  const directory = join(
    await wslpath("-u", windowsLocal),
    "akkco-vibestar",
    "dev-electron",
    `${version}-${arch}`,
  );

  const executable = join(directory, "electron.exe");
  try {
    await Promise.all([access(executable), access(join(directory, "resources/default_app.asar"))]);
  } catch {
    process.stdout.write(
      `Preparing native Windows Electron ${version} (execution stays in ${process.env.WSL_DISTRO_NAME})…\n`,
    );

    const archive = await downloadArtifact({
      version,
      platform: "win32",
      arch,
      artifactName: "electron",
    });

    await mkdir(directory, { recursive: true });
    await exec("unzip", ["-q", "-o", archive, "-d", directory]);
  }

  env.VIBESTAR_DEV_WSL_CONFIG = JSON.stringify({
    distro: process.env.WSL_DISTRO_NAME,
    data_home: process.env.VIBESTAR_HOME || "",
    helper_path: resolve("dist-core/core.cjs"),
  });

  const metadata = join(await mkdtemp(join(tmpdir(), "vibestar-dev-")), "window.json");
  env.VIBESTAR_DEV_WINDOW_META = await wslpath("-w", metadata);
  if (env.VIBESTAR_USER_DATA) env.VIBESTAR_USER_DATA = await wslpath("-w", env.VIBESTAR_USER_DATA);

  env.WSLENV = [
    env.WSLENV,
    "VIBESTAR_DEV_URL",
    "VIBESTAR_DEV_WSL_CONFIG",
    "VIBESTAR_USER_DATA",
    "VIBESTAR_DEV_WINDOW_META",
  ]
    .filter(Boolean)
    .join(":");

  process.stdout.write(`Desktop: native Windows · execution: WSL ${process.env.WSL_DISTRO_NAME}\n`);
  return {
    executable,
    args: [await wslpath("-w", resolve("."))],
    env,
    clear: () => rm(metadata, { force: true }),
    close: async () => {
      const { handle, pid } = JSON.parse(await readFile(metadata, "utf8"));
      if (
        typeof handle !== "string" ||
        !/^\d+$/.test(handle) ||
        !Number.isSafeInteger(pid) ||
        pid <= 0
      )
        throw new Error("Invalid development window handle");

      await exec("powershell.exe", [
        "-NoProfile",
        "-Command",
        `Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class VibestarDevClose{[DllImport("user32.dll")]public static extern bool PostMessage(IntPtr hwnd,uint message,IntPtr w,IntPtr l);[DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);public static void Close(long handle,uint expected){var hwnd=new IntPtr(handle);uint pid;GetWindowThreadProcessId(hwnd,out pid);if(pid==expected)PostMessage(hwnd,16,IntPtr.Zero,IntPtr.Zero);}}'; [VibestarDevClose]::Close(${handle},${pid})`,
      ]);
    },
  };
};
