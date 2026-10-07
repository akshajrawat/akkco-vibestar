"""Send real Xwayland pointer input for Electron drag/double-click checks."""
import ctypes
import ctypes.util
import sys
import time

x11 = ctypes.CDLL(ctypes.util.find_library("X11"))
xtst = ctypes.CDLL(ctypes.util.find_library("Xtst"))
x11.XOpenDisplay.restype = ctypes.c_void_p
x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
x11.XFlush.argtypes = [ctypes.c_void_p]
x11.XCloseDisplay.argtypes = [ctypes.c_void_p]
xtst.XTestFakeMotionEvent.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_ulong]
xtst.XTestFakeButtonEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
display = x11.XOpenDisplay(None)
if not display:
    raise RuntimeError("X display unavailable")
x, y = int(sys.argv[2]), int(sys.argv[3])
xtst.XTestFakeMotionEvent(display, -1, x, y, 0)
x11.XFlush(display)
time.sleep(0.1)
if sys.argv[1] == "drag":
    xtst.XTestFakeButtonEvent(display, 1, 1, 0)
    x11.XFlush(display)
    time.sleep(0.1)
    for step in range(1, 11):
        xtst.XTestFakeMotionEvent(display, -1, x + step * 8, y + step * 5, 0)
        x11.XFlush(display)
        time.sleep(0.03)
    xtst.XTestFakeButtonEvent(display, 1, 0, 0)
else:
    for _ in range(2):
        xtst.XTestFakeButtonEvent(display, 1, 1, 0)
        xtst.XTestFakeButtonEvent(display, 1, 0, 0)
        x11.XFlush(display)
        time.sleep(0.09)
x11.XFlush(display)
x11.XCloseDisplay(display)
