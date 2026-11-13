#!/usr/bin/env python3
"""
tools/request_approval.py

Remote Approval & UI Snapshot Tool
Detects foreground or installer windows, captures targeted screenshots (or desktop fallback),
converts them to base64 JPEG format, and executes remote input actions (press enter/space,
coordinate click, abort/alt+f4) to enable stepping through installation dialogs.
Uses fast ctypes EnumWindows enumeration and safe_focus to prevent Windows OS foreground locks and hangs.
"""

import os
import sys
import io
import time
import json
import base64
import argparse
import subprocess
import threading
import urllib.request
import urllib.error
import ctypes
from ctypes import wintypes

# Ensure stdout handles UTF-8 characters on Windows consoles
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

user32 = ctypes.windll.user32 if sys.platform == 'win32' else None
kernel32 = ctypes.windll.kernel32 if sys.platform == 'win32' else None

def attach_default_desktop():
    """Ensure interactive desktop access on Windows (even from detached background processes)."""
    if sys.platform == 'win32' and user32:
        try:
            hdesk = user32.OpenInputDesktop(0, False, 0x01FF)
            if not hdesk:
                hdesk = user32.OpenDesktopW('Default', 0, False, 0x01FF) # GENERIC_ALL
            if hdesk:
                user32.SetThreadDesktop(hdesk)
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
    pyautogui = None

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

def get_process_name(hwnd):
    """Retrieve process executable file name for a given HWND."""
    if not (user32 and kernel32):
        return ""
    try:
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if pid.value == 0:
            return ""
        h_process = kernel32.OpenProcess(0x1000 | 0x0400, False, pid.value)
        if not h_process:
            return ""
        buf = (ctypes.c_wchar * 1024)()
        size = wintypes.DWORD(1024)
        kernel32.QueryFullProcessImageNameW(h_process, 0, buf, ctypes.byref(size))
        kernel32.CloseHandle(h_process)
        exe_path = buf.value
        return os.path.basename(exe_path).lower() if exe_path else ""
    except Exception:
        return ""

def bring_window_to_front(hwnd):
    """
    Safely bring any window to the foreground on Windows bypassing OS focus lock
    using Alt key simulation and SW_RESTORE wrapped in try...except.
    ONLY restores if the window is iconic/minimized so maximized windows do not shrink.
    """
    try:
        if not hwnd or sys.platform != 'win32' or not user32:
            return
        # ONLY restore if the window is minimized (iconic)
        if user32.IsIconic(hwnd):
            user32.ShowWindow(hwnd, 9)  # SW_RESTORE
            time.sleep(0.25)
        else:
            # Keep its current Maximized or Normal state, just ensure it's visible
            user32.ShowWindow(hwnd, 5)  # SW_SHOW

        # Bypass Windows foreground lock safely using Alt key press/release
        user32.keybd_event(0x12, 0, 0, 0)      # Alt down
        user32.SetForegroundWindow(hwnd)
        user32.BringWindowToTop(hwnd)
        user32.keybd_event(0x12, 0, 2, 0)      # Alt up
        time.sleep(0.35)                       # Let window repaint in foreground
    except Exception:
        pass

def enum_visible_windows():
    """
    Fast and safe enumeration of all top-level visible windows using ctypes EnumWindows.
    Avoids COM/pygetwindow hangs and returns list of dicts with hwnd, title, exe, rect, is_iconic.
    """
    windows = []
    if sys.platform != "win32" or not user32:
        return windows

    WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)

    def enum_callback(hwnd, lparam):
        try:
            if not user32.IsWindowVisible(hwnd):
                return True
            length = user32.GetWindowTextLengthW(hwnd)
            if length == 0:
                return True
            buf = ctypes.create_unicode_buffer(length + 1)
            user32.GetWindowTextW(hwnd, buf, length + 1)
            title = buf.value.strip().strip('\u200e\u200f\ufeff')
            if not title:
                return True

            rect = wintypes.RECT()
            user32.GetWindowRect(hwnd, ctypes.byref(rect))
            width = rect.right - rect.left
            height = rect.bottom - rect.top
            if width <= 10 or height <= 10:
                return True

            exe = get_process_name(hwnd)
            windows.append({
                'hwnd': hwnd,
                'title': title,
                'exe': exe,
                'left': rect.left,
                'top': rect.top,
                'width': width,
                'height': height,
                'right': rect.right,
                'bottom': rect.bottom,
                'is_iconic': bool(user32.IsIconic(hwnd))
            })
        except Exception:
            pass
        return True

    cb = WNDENUMPROC(enum_callback)
    user32.EnumWindows(cb, 0)
    return windows

def try_launch_target_app(title_pattern):
    """If an application isn't running, attempt to launch it via system URI or start command."""
    if not title_pattern or sys.platform != 'win32':
        return False
    pat = title_pattern.lower().strip()
    for app_key, launch_cmd in APP_LAUNCH_MAP.items():
        if app_key in pat:
            try:
                subprocess.Popen(launch_cmd, shell=False)
                time.sleep(2.0)
                return True
            except Exception:
                pass
    return False

def match_target_window(title_pattern=None, windows=None):
    """
    Search for a target window matching title_pattern across all open windows.
    Case-insensitive substring match across all visible window titles, browser tabs, or process names.
    """
    if not title_pattern:
        return None
    if windows is None:
        windows = enum_visible_windows()

    q = title_pattern.lower().strip()
    scored = []

    for w in windows:
        title = w['title']
        lower_title = title.lower()
        exe = w['exe']

        if any(ign in lower_title for ign in ['windows input experience', 'program manager', 'agentcursoroverlay', 'default ime']):
            continue

        score = 0

        # Exact title match
        if q == lower_title:
            score += 100
        elif q in lower_title:
            score += 50

        # Process name matching (e.g. 'brave' matching 'brave.exe', 'gemini' matching 'gemini.exe')
        if q in exe:
            score += 60

        # Aliases for terminals and apps
        if q in ['terminal', 'cmd', 'powershell', 'console', 'bash', 'yazi'] and (
            exe in ['windowsterminal.exe', 'cmd.exe', 'powershell.exe', 'wt.exe', 'conhost.exe'] or 'yazi' in lower_title or 'cmd' in lower_title
        ):
            score += 75
        if q == 'yazi' and ('yazi' in lower_title or 'yazi' in exe):
            score += 100
        if q in ['browser', 'web'] and exe in ['brave.exe', 'chrome.exe', 'msedge.exe', 'firefox.exe']:
            score += 60
        if q in ['roblox'] and ('roblox' in lower_title or 'roblox' in exe):
            score += 75
        if q in ['steam'] and ('steam' in lower_title or 'steam' in exe):
            score += 75
        if q in ['code', 'vscode'] and ('visual studio code' in lower_title or 'code.exe' in exe):
            score += 75
        if q in ['gemini'] and ('gemini' in lower_title or 'gemini' in exe):
            score += 85

        if score > 0:
            if not w['is_iconic']:
                score += 15
            if w['width'] > 100 and w['height'] > 100:
                score += 10
            scored.append((score, w))

    scored.sort(key=lambda item: item[0], reverse=True)
    return scored[0][1] if scored else None

def find_target_window(title_pattern=None, windows=None):
    """
    Search for a target window matching title_pattern, or search for
    common installer/modal windows, or fall back to the active foreground window.
    """
    if windows is None:
        windows = enum_visible_windows()

    if title_pattern:
        w = match_target_window(title_pattern, windows)
        if w:
            return w

    # Match installer keywords
    for w in windows:
        w_title_lower = w['title'].lower()
        for kw in INSTALLER_KEYWORDS:
            if kw in w_title_lower and w['width'] >= 50 and w['height'] >= 50 and not w['is_iconic']:
                return w

    # Fall back to active foreground window
    if user32:
        try:
            fg_hwnd = user32.GetForegroundWindow()
            for w in windows:
                if w['hwnd'] == fg_hwnd:
                    return w
        except Exception:
            pass

    return None

def capture_snapshot(target_title=None, target_hwnd=None, force_desktop=False, quality=70):
    """
    Capture a screenshot of the target window (or desktop) and return base64 encoded JPEG data.
    """
    attach_default_desktop()
    if user32:
        screen_w = user32.GetSystemMetrics(0)
        screen_h = user32.GetSystemMetrics(1)
    else:
        screen_w, screen_h = 1920, 1080

    target_win = None
    is_fallback = False
    window_title = "Desktop (Entire Screen)"
    bounds = {"left": 0, "top": 0, "width": screen_w, "height": screen_h}

    # Determine if full desktop was requested
    is_desktop_req = force_desktop or not target_title or (
        target_title and target_title.lower().strip() in ["full", "desktop", "screen", "primary"]
    )

    all_windows = enum_visible_windows()

    if not is_desktop_req:
        if target_hwnd:
            for w in all_windows:
                if w['hwnd'] == target_hwnd:
                    target_win = w
                    break
        elif target_title:
            target_win = match_target_window(target_title, all_windows)

    img = None
    if target_win:
        try:
            window_title = target_win['title']
            hwnd = target_win['hwnd']
            bring_window_to_front(hwnd)

            rect = wintypes.RECT()
            raw_left = target_win['left']
            raw_top = target_win['top']
            raw_width = target_win['width']
            raw_height = target_win['height']

            if hwnd and user32 and user32.GetWindowRect(hwnd, ctypes.byref(rect)):
                raw_left = rect.left
                raw_top = rect.top
                raw_width = rect.right - rect.left
                raw_height = rect.bottom - rect.top

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
        img = ImageGrab.grab()

        if not is_desktop_req and (target_title or target_hwnd):
            is_fallback = True
            window_title = f"{window_title} (Desktop Fallback)"
        else:
            window_title = "Desktop (Entire Screen)"
            is_fallback = False

    t_encode_start = time.perf_counter()
    if img.mode != 'RGB':
        img = img.convert('RGB')

    # Enforce 1280x720 viewport constraint for low-memory 512MB environments
    if img.width > 1280 or img.height > 720:
        img.thumbnail((1280, 720), Image.Resampling.LANCZOS)

    buf = io.BytesIO()
    img.save(buf, format='JPEG', quality=quality, optimize=True)
    encode_ms = round((time.perf_counter() - t_encode_start) * 1000, 2)
    sys.stderr.write(f"[PROFILER] Step: Screenshot JPEG encoding (1280x720, quality={quality}) took {encode_ms} ms (size: {len(buf.getvalue())} bytes)\n")
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
        hwnd = target_win.get('hwnd')
        if hwnd:
            safe_focus(hwnd)

    act = (action or '').lower().strip()
    result = {"success": True, "action": act, "windowTitle": target_win['title'] if target_win else "Desktop"}

    if not pyautogui:
        return {"success": False, "error": "pyautogui is not available for remote input."}

    try:
        if act in ("enter", "confirm", "return"):
            pyautogui.press('enter')
        elif act in ("space", "spacebar"):
            pyautogui.press('space')
        elif act in ("cancel", "abort", "close"):
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

def start_watchdog(timeout_seconds=7.5):
    """Guarantees the process exits within 8 seconds max even if an OS call blocks."""
    def watchdog_target():
        time.sleep(timeout_seconds)
        try:
            snap_res = capture_snapshot(force_desktop=True)
            print(json.dumps(snap_res))
        except Exception:
            print(json.dumps({"success": False, "error": "Process timed out after 8 seconds"}))
        os._exit(0)

    t = threading.Thread(target=watchdog_target, daemon=True)
    t.start()

def main():
    start_watchdog(7.5)
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

        if args.refresh:
            time.sleep(0.5)
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

    if args.emit and snap_res.get("success"):
        emit_res = emit_to_daemon(snap_res, ipc_port=args.ipc_port)
        snap_res["emittedToDaemon"] = emit_res

    print(json.dumps(snap_res))
    if not snap_res.get("success"):
        sys.exit(1)

if __name__ == "__main__":
    main()
