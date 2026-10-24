#!/usr/bin/env python3
"""
tools/request_approval.py

Remote Approval & UI Snapshot Tool
Detects foreground or installer windows, captures targeted screenshots (or desktop fallback),
converts them to base64 JPEG format, and executes remote input actions (press enter/space,
coordinate click, abort/alt+f4) to enable stepping through installation dialogs.
"""

import os
import sys
import io
import time
import json
import base64
import argparse
import subprocess
import urllib.request
import urllib.error

# Ensure stdout handles UTF-8 characters on Windows consoles
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

# Ensure interactive desktop access on Windows (even from detached background processes)
def attach_default_desktop():
    if sys.platform == 'win32':
        try:
            import ctypes
            u32 = ctypes.windll.user32
            hdesk = u32.OpenInputDesktop(0, False, 0x01FF)
            if not hdesk:
                hdesk = u32.OpenDesktopW('Default', 0, False, 0x01FF) # GENERIC_ALL
            if hdesk:
                u32.SetThreadDesktop(hdesk)
        except Exception:
            pass

attach_default_desktop()

try:
    from PIL import Image, ImageGrab
except ImportError:
    print(json.dumps({
        "success": False,
        "error": "Pillow is not installed. Please run: pip install pillow"
    }), file=sys.stderr)
    sys.exit(1)

try:
    import pyautogui
    pyautogui.FAILSAFE = False
except ImportError:
    print(json.dumps({
        "success": False,
        "error": "pyautogui is not installed. Please run: pip install pyautogui"
    }), file=sys.stderr)
    sys.exit(1)

try:
    import pygetwindow as gw
except ImportError:
    gw = None

INSTALLER_KEYWORDS = [
    "setup", "installer", "installation", "wizard", "dialog", "prompt",
    "user account control", "security warning", "license agreement",
    "uninstaller", "update", "install", "confirm", "warning"
]

APP_LAUNCH_MAP = {
    'roblox': ['cmd.exe', '/c', 'start', 'roblox:'],
    'steam': ['cmd.exe', '/c', 'start', 'steam:'],
    'brave': ['cmd.exe', '/c', 'start', 'brave'],
    'chrome': ['cmd.exe', '/c', 'start', 'chrome'],
    'edge': ['cmd.exe', '/c', 'start', 'msedge'],
    'telegram': ['cmd.exe', '/c', 'start', 'telegram:'],
    'discord': ['cmd.exe', '/c', 'start', 'discord:'],
    'spotify': ['cmd.exe', '/c', 'start', 'spotify:'],
    'notepad': ['cmd.exe', '/c', 'start', 'notepad'],
    'calc': ['cmd.exe', '/c', 'start', 'calc:'],
    'calculator': ['cmd.exe', '/c', 'start', 'calc:'],
}

def try_launch_target_app(title_pattern):
    """If an application isn't running, attempt to launch it via system URI or start command."""
    if not title_pattern or sys.platform != 'win32':
        return False
    pat = title_pattern.lower().strip()
    for app_key, launch_cmd in APP_LAUNCH_MAP.items():
        if app_key in pat:
            try:
                subprocess.Popen(launch_cmd, shell=False)
                time.sleep(2.5) # Allow application window time to initialize
                return True
            except Exception:
                pass
    return False

def force_bring_to_front(hwnd):
    """
    Forcefully bring any window to the foreground on Windows.
    Bypasses LockSetForegroundWindow restrictions using the Alt-key event,
    AttachThreadInput, ShowWindow(SW_RESTORE), and SwitchToThisWindow.
    """
    if not hwnd or sys.platform != 'win32':
        return False
    try:
        import ctypes
        user32 = ctypes.windll.user32
        kernel32 = ctypes.windll.kernel32

        attach_default_desktop()

        # 1. Disable OS foreground lock timeout (prevents Alt-key side effects that close floating apps)
        user32.SystemParametersInfoA(0x2001, 0, 0, 0x0002 | 0x0001)

        # 2. Restore window if minimized
        if user32.IsIconic(hwnd):
            user32.ShowWindow(hwnd, 9) # SW_RESTORE
        else:
            user32.ShowWindow(hwnd, 5) # SW_SHOW

        # 3. AttachThreadInput to steal foreground from current active window
        fg_hwnd = user32.GetForegroundWindow()
        fg_tid = user32.GetWindowThreadProcessId(fg_hwnd, None)
        cur_tid = kernel32.GetCurrentThreadId()

        if fg_tid and fg_tid != cur_tid:
            user32.AttachThreadInput(cur_tid, fg_tid, True)

        user32.BringWindowToTop(hwnd)
        user32.SetForegroundWindow(hwnd)
        user32.SetActiveWindow(hwnd)

        if fg_tid and fg_tid != cur_tid:
            user32.AttachThreadInput(cur_tid, fg_tid, False)

        # 4. SwitchToThisWindow as guaranteed backup
        user32.SwitchToThisWindow(hwnd, True)

        # Allow Windows DWM compositor time to swap and paint window to screen buffer
        time.sleep(0.4)
        return True
    except Exception:
        return False

def find_target_window(title_pattern=None):
    """
    Search for a target window matching title_pattern, or search for
    common installer/modal windows, or fall back to the active foreground window.
    """
    attach_default_desktop()
    if not gw:
        return None

    all_windows = []
    try:
        all_windows = [w for w in gw.getAllWindows() if w.title and w.title.strip()]
    except Exception:
        all_windows = []

    # 1. Match specific title pattern if provided
    if title_pattern:
        pat = title_pattern.lower().strip()
        for w in all_windows:
            if pat in w.title.lower() and w.width >= 50 and w.height >= 50:
                return w
        # Also try matching without dimensions constraint (if minimized)
        for w in all_windows:
            if pat in w.title.lower():
                return w

    # 2. Match common installer / modal dialogue keywords
    for w in all_windows:
        w_title_lower = w.title.lower()
        for kw in INSTALLER_KEYWORDS:
            if kw in w_title_lower and w.width >= 50 and w.height >= 50 and not w.isMinimized:
                return w

    # 3. Fall back to the active foreground window
    try:
        active = gw.getActiveWindow()
        if active and active.title and active.width >= 50 and active.height >= 50 and not active.isMinimized:
            return active
    except Exception:
        pass

    return None

def capture_snapshot(target_title=None, target_hwnd=None, force_desktop=False, quality=85):
    """
    Capture a screenshot of the target window (or desktop) and return base64 encoded JPEG data.
    """
    attach_default_desktop()
    try:
        screen_w, screen_h = pyautogui.size()
    except Exception:
        screen_w, screen_h = 1920, 1080

    target_win = None
    is_fallback = False
    window_title = "Desktop (Entire Screen)"
    bounds = {"left": 0, "top": 0, "width": screen_w, "height": screen_h}

    # Determine if full desktop was requested
    is_desktop_req = force_desktop or (
        target_title and target_title.lower().strip() in ["full", "desktop", "screen", "primary"]
    )

    if not is_desktop_req:
        if target_hwnd and gw:
            try:
                for w in gw.getAllWindows():
                    if getattr(w, '_hWnd', None) == target_hwnd:
                        target_win = w
                        break
            except Exception:
                target_win = None
        elif target_title:
            target_win = find_target_window(target_title)
            # If target app is not running, attempt to launch it and search again
            if not target_win:
                if try_launch_target_app(target_title):
                    target_win = find_target_window(target_title)

    img = None
    if target_win:
        try:
            window_title = target_win.title.strip().strip('\u200e\u200f\ufeff')
            hwnd = getattr(target_win, '_hWnd', None)

            # Forcefully bring the window to the top and activate it
            if hwnd:
                force_bring_to_front(hwnd)
            else:
                if target_win.isMinimized:
                    try:
                        target_win.restore()
                        time.sleep(0.3)
                    except Exception:
                        pass
                try:
                    target_win.activate()
                    time.sleep(0.3)
                except Exception:
                    pass

            raw_left = target_win.left
            raw_top = target_win.top
            raw_width = target_win.width
            raw_height = target_win.height

            # Re-read precise coordinates using GetWindowRect
            if hwnd and sys.platform == 'win32':
                try:
                    import ctypes
                    from ctypes import wintypes
                    rect = wintypes.RECT()
                    if ctypes.windll.user32.GetWindowRect(hwnd, ctypes.byref(rect)):
                        raw_left = rect.left
                        raw_top = rect.top
                        raw_width = rect.right - rect.left
                        raw_height = rect.bottom - rect.top
                except Exception:
                    pass

            # Clamp coordinates to primary display
            left = max(0, raw_left)
            top = max(0, raw_top)
            right = min(screen_w, raw_left + raw_width)
            bottom = min(screen_h, raw_top + raw_height)
            width = max(1, right - left)
            height = max(1, bottom - top)

            bounds = {
                "left": left,
                "top": top,
                "width": width,
                "height": height
            }
            img = ImageGrab.grab(bbox=(left, top, right, bottom))
        except Exception:
            img = None

    if img is None:
        try:
            img = ImageGrab.grab()
            if not is_desktop_req and (target_title or target_hwnd):
                is_fallback = True
                window_title = f"{window_title} (Desktop Fallback)"
            else:
                window_title = "Desktop (Entire Screen)"
                is_fallback = False
        except Exception as e:
            return {
                "success": False,
                "error": f"Failed to grab screen: {str(e)}"
            }

    # Convert to RGB and compress as JPEG
    if img.mode != 'RGB':
        img = img.convert('RGB')

    buf = io.BytesIO()
    img.save(buf, format='JPEG', quality=quality, optimize=True)
    b64_str = base64.b64encode(buf.getvalue()).decode('utf-8')

    return {
        "success": True,
        "type": "APPROVAL_REQUIRED",
        "windowTitle": window_title,
        "isDesktopFallback": is_fallback,
        "bounds": bounds,
        "image": b64_str,
        "imageSizeBytes": len(buf.getvalue()),
        "timestamp": int(time.time() * 1000)
    }

def execute_remote_action(action, target_title=None, x=None, y=None, key=None):
    """
    Execute keyboard or mouse input on the active/target window.
    """
    attach_default_desktop()
    target_win = find_target_window(target_title)
    if target_win:
        hwnd = getattr(target_win, '_hWnd', None)
        if hwnd:
            force_bring_to_front(hwnd)
        else:
            try:
                target_win.activate()
                time.sleep(0.15)
            except Exception:
                pass

    act = (action or '').lower().strip()
    result = {"success": True, "action": act, "windowTitle": target_win.title if target_win else "Desktop"}

    try:
        if act in ("enter", "confirm", "return"):
            pyautogui.press('enter')
        elif act in ("space", "spacebar"):
            pyautogui.press('space')
        elif act in ("cancel", "abort", "close"):
            # Attempt gentle Esc first, then Alt+F4
            pyautogui.press('esc')
            time.sleep(0.1)
            pyautogui.hotkey('alt', 'f4')
        elif act == "esc":
            pyautogui.press('esc')
        elif act == "alt_f4":
            pyautogui.hotkey('alt', 'f4')
        elif act == "tab":
            pyautogui.press('tab')
        elif act == "click":
            if x is not None and y is not None:
                pyautogui.click(x=int(x), y=int(y))
            else:
                pyautogui.click()
        elif act == "key":
            if key:
                pyautogui.press(key)
            else:
                return {"success": False, "error": "No key specified for key action"}
        else:
            return {"success": False, "error": f"Unknown action: {action}"}

        result["executed"] = True
    except Exception as e:
        result["success"] = False
        result["error"] = str(e)

    return result

def emit_to_daemon(payload, ipc_port=52199):
    """
    POST payload to local daemon loopback HTTP server to broadcast over WebSocket.
    """
    try:
        data = json.dumps(payload).encode('utf-8')
        req = urllib.request.Request(
            f"http://127.0.0.1:{ipc_port}/approval",
            data=data,
            headers={'Content-Type': 'application/json'}
        )
        with urllib.request.urlopen(req, timeout=3) as resp:
            resp_data = resp.read().decode('utf-8')
            return json.loads(resp_data)
    except Exception as e:
        return {"success": False, "forwardError": str(e)}

def main():
    parser = argparse.ArgumentParser(description="Remote Approval Snapshot & Input Automation Tool")
    parser.add_argument("--title", type=str, default=None, help="Target window title pattern")
    parser.add_argument("--hwnd", type=int, default=None, help="Target window HWND")
    parser.add_argument("--desktop", action="store_true", help="Capture full desktop display")
    parser.add_argument("--action", type=str, default=None, help="Action to execute: enter, space, cancel, click, key")
    parser.add_argument("--x", type=int, default=None, help="X coordinate for click action")
    parser.add_argument("--y", type=int, default=None, help="Y coordinate for click action")
    parser.add_argument("--key", type=str, default=None, help="Key name to press")
    parser.add_argument("--refresh", action="store_true", help="Capture refreshed snapshot after executing action")
    parser.add_argument("--emit", action="store_true", help="Emit event to local laptop daemon loopback IPC")
    parser.add_argument("--ipc-port", type=int, default=52199, help="Local laptop daemon IPC port (default: 52199)")
    parser.add_argument("--quality", type=int, default=85, help="JPEG quality (10-100, default: 85)")
    args = parser.parse_args()

    # 1. If an input action is specified, execute it first
    if args.action:
        act_res = execute_remote_action(
            action=args.action,
            target_title=args.title,
            x=args.x,
            y=args.y,
            key=args.key
        )
        if not act_res.get("success"):
            print(json.dumps(act_res))
            sys.exit(1)

        # If refresh is requested, wait briefly for UI transition then capture new state
        if args.refresh:
            time.sleep(0.7)
            snap_res = capture_snapshot(
                target_title=args.title,
                target_hwnd=args.hwnd,
                force_desktop=args.desktop,
                quality=args.quality
            )
            act_res["refreshedSnapshot"] = snap_res

        print(json.dumps(act_res))
        sys.exit(0)

    # 2. Default mode: Capture snapshot
    snap_res = capture_snapshot(
        target_title=args.title,
        target_hwnd=args.hwnd,
        force_desktop=args.desktop,
        quality=args.quality
    )

    # Emit to daemon if requested
    if args.emit and snap_res.get("success"):
        emit_res = emit_to_daemon(snap_res, ipc_port=args.ipc_port)
        snap_res["emittedToDaemon"] = emit_res

    # Output structured JSON to stdout for callers
    print(json.dumps(snap_res))
    if not snap_res.get("success"):
        sys.exit(1)

if __name__ == "__main__":
    main()
