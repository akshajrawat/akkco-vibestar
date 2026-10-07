/* global window, document */
import { _electron } from "playwright-core";
import process from "node:process";
import { log } from "node:console";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const [executable, appPath, profile, home] = process.argv.slice(2);
const env = {
  ...process.env,
  VIBESTAR_USER_DATA: profile,
  VIBESTAR_DEV_WSL_CONFIG: JSON.stringify({
    ...JSON.parse(process.env.VIBESTAR_DEV_WSL_CONFIG),
    data_home: home + "/ade",
  }),
};
delete env.ELECTRON_RUN_AS_NODE;
const app = await _electron.launch({
  executablePath: executable,
  args: [appPath],
  env,
  timeout: 30000,
});
try {
  const p = await app.firstWindow();
  p.setDefaultTimeout(15000);
  await p.getByLabel("Maximize window").waitFor();
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  const bounds = () =>
    app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].getBounds(),
    );
  const normal = await bounds();
  await p.getByLabel("Maximize window").click();
  await p.getByLabel("Restore window").waitFor();
  await p.waitForTimeout(400);
  const maximized = await bounds();
  const area = await app.evaluate(
    ({ screen, BrowserWindow }) =>
      screen.getDisplayMatching(BrowserWindow.getAllWindows()[0].getBounds())
        .workArea,
  );
  // Windows keeps invisible resize borders outside the work area when maximized.
  const content = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].getContentBounds(),
  );
  assert.equal(content.x, area.x);
  assert.equal(content.y, area.y);
  assert.equal(content.width, area.width);
  assert.ok(Math.abs(content.height - area.height) <= 2);
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].focus(),
  );
  await p.screenshot({
    path: join(dirname(fileURLToPath(import.meta.url)), "maximized.png"),
  });
  await p.getByLabel("Restore window").click();
  await p.getByLabel("Maximize window").waitFor();
  assert.deepEqual(await bounds(), normal);
  await p.locator("main").click({ position: { x: 350, y: 350 } });
  await p.keyboard.press("F11");
  await p.getByLabel("Exit fullscreen").waitFor();
  assert.equal(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].isFullScreen(),
    ),
    true,
  );
  await p.screenshot({
    path: join(dirname(fileURLToPath(import.meta.url)), "fullscreen.png"),
  });
  await p.keyboard.press("Escape");
  await p.getByLabel("Maximize window").waitFor();
  await p.waitForTimeout(400);
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setSize(1000, 650);
    w.focus();
  });
  await p.waitForTimeout(400);
  log("Native resized bounds", await bounds());
  assert.ok(
    Math.abs((await bounds()).width - 1000) <= 2,
    "Native resizing must honor the requested size within DPI rounding",
  );
  const initial = await app.evaluate(({ BrowserWindow, screen }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setTitle("Vibestar window regression");
    return {
      bounds: w.getContentBounds(),
      scale: screen.getDisplayMatching(w.getBounds()).scaleFactor,
    };
  });
  const gap = await p.evaluate(() => {
    const name = document
      .querySelector(".titlebar-name")
      .getBoundingClientRect();
    const palette = document
      .querySelector(".titlebar-palette")
      .getBoundingClientRect();
    return { x: (name.right + palette.left) / 2, y: 16 };
  });
  const pointer = async (mode, x, y) =>
    promisify(execFile)("powershell.exe", [
      "-NoProfile",
      "-Command",
      `Add-Type @'
using System;using System.Text;using System.Runtime.InteropServices;
public class VibestarPointer {
public delegate bool EnumProc(IntPtr hwnd,IntPtr p);
[DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback,IntPtr p);
[DllImport("user32.dll")] static extern int GetWindowText(IntPtr hwnd,StringBuilder text,int len);
[DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
[DllImport("user32.dll")] static extern bool SetProcessDPIAware();
[DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr hwnd);
[DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr hwnd,ref Point point);
[StructLayout(LayoutKind.Sequential)] public struct Point {public int X,Y;}
[DllImport("user32.dll")] static extern bool SetCursorPos(int x,int y);
[DllImport("user32.dll")] static extern void mouse_event(uint flags,uint x,uint y,uint data,UIntPtr extra);
public static void Run(int localX,int localY,bool drag){SetProcessDPIAware();IntPtr hwnd=IntPtr.Zero;EnumWindows((h,p)=>{var t=new StringBuilder(256);GetWindowText(h,t,256);if(t.ToString()=="Vibestar window regression")hwnd=h;return true;},IntPtr.Zero);if(hwnd==IntPtr.Zero)throw new Exception("Test window not found");SetForegroundWindow(hwnd);double scale=GetDpiForWindow(hwnd)/96.0;var point=new Point{X=(int)Math.Round(localX*scale),Y=(int)Math.Round(localY*scale)};ClientToScreen(hwnd,ref point);int x=point.X,y=point.Y;SetCursorPos(x,y);System.Threading.Thread.Sleep(150);if(drag){mouse_event(2,0,0,0,UIntPtr.Zero);for(int i=1;i<=10;i++){SetCursorPos(x+i*8,y+i*5);System.Threading.Thread.Sleep(30);}mouse_event(4,0,0,0,UIntPtr.Zero);}else{for(int i=0;i<2;i++){mouse_event(2,0,0,0,UIntPtr.Zero);mouse_event(4,0,0,0,UIntPtr.Zero);System.Threading.Thread.Sleep(90);}}}
}
'@
[VibestarPointer]::Run(${Math.round(x)},${Math.round(y)},$${mode === "drag" ? "true" : "false"})`,
    ]);
  await pointer("drag", gap.x, gap.y);
  await p.waitForTimeout(300);
  const dragged = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].getContentBounds(),
  );
  assert.ok(
    dragged.x !== initial.bounds.x || dragged.y !== initial.bounds.y,
    "Native titlebar dragging must move the window",
  );
  await pointer("double", gap.x, gap.y);
  await p.getByLabel("Restore window").waitFor();
  assert.equal(
    (await p.evaluate(() => window.electronWindow.getState())).maximized,
    true,
  );
  await p.getByLabel("Restore window").click();
  await p.getByLabel("Maximize window").waitFor();
  const displays = await app.evaluate(({ screen }) =>
    screen.getAllDisplays().map((d) => ({
      id: d.id,
      bounds: d.bounds,
      workArea: d.workArea,
      scaleFactor: d.scaleFactor,
    })),
  );
  const transitions = [];
  for (const display of displays) {
    await app.evaluate(({ BrowserWindow }, area) => {
      const w = BrowserWindow.getAllWindows()[0];
      const width = Math.min(1000, area.width - 80),
        height = Math.min(650, area.height - 80);
      w.setBounds({
        x: area.x + Math.round((area.width - width) / 2),
        y: area.y + Math.round((area.height - height) / 2),
        width,
        height,
      });
      w.focus();
    }, display.workArea);
    await p.waitForTimeout(300);
    const before = await bounds();
    const start = Date.now();
    await p.getByLabel("Maximize window").click();
    await p.getByLabel("Restore window").waitFor();
    const maximizeMs = Date.now() - start;
    await p.waitForTimeout(500);
    assert.equal(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].isMaximized(),
      ),
      true,
      "Windows must remain natively maximized",
    );
    const maximizedContent = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].getContentBounds(),
    );
    for (const key of ["x", "y", "width", "height"])
      assert.ok(
        Math.abs(maximizedContent[key] - display.workArea[key]) <= 2,
        `Maximize must fit display ${display.id}: ${key}`,
      );
    await p.locator("main").click({ position: { x: 300, y: 300 } });
    const fullscreenStart = Date.now();
    await p.keyboard.press("F11");
    await p.getByLabel("Exit fullscreen").waitFor();
    const fullscreenMs = Date.now() - fullscreenStart;
    await p.waitForTimeout(300);
    const fullscreenContent = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].getContentBounds(),
    );
    for (const key of ["x", "y", "width", "height"])
      assert.ok(
        Math.abs(fullscreenContent[key] - display.bounds[key]) <= 2,
        `Fullscreen must fit display ${display.id}: ${key}`,
      );
    const viewport = await p.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
      scale: window.devicePixelRatio,
    }));
    assert.ok(Math.abs(viewport.width - fullscreenContent.width) <= 2);
    assert.ok(Math.abs(viewport.height - fullscreenContent.height) <= 2);
    await p.screenshot({
      path: join(
        dirname(fileURLToPath(import.meta.url)),
        `fullscreen-${display.id}.png`,
      ),
    });
    await p.keyboard.press("Escape");
    await p.getByLabel("Restore window").waitFor();
    await p.getByLabel("Restore window").click();
    await p.getByLabel("Maximize window").waitFor();
    const restored = await bounds();
    for (const key of ["x", "y", "width", "height"])
      assert.ok(
        Math.abs(restored[key] - before[key]) <= 2,
        `Restore must retain display ${display.id}: ${key}`,
      );
    transitions.push({
      display: display.id,
      scaleFactor: display.scaleFactor,
      maximizeMs,
      fullscreenMs,
      viewport,
    });
  }
  const info = await p.evaluate(() => window.vibestar.desktopSettings());
  assert.equal(info.native_windows, true);
  assert.equal(info.config.data_home, home + "/ade");
  assert.deepEqual(errors, []);
  log(
    JSON.stringify(
      {
        native_windows: true,
        maximized,
        fullscreen: true,
        restore: true,
        resize: true,
        native_drag: true,
        native_double_click: true,
        wsl_data_home: info.config.data_home,
        transitions,
      },
      null,
      2,
    ),
  );
} finally {
  await app.close();
}
