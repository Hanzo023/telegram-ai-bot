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
        all_windows = [w for w in gw.getAllWindows() if w.title and w.title.strip() and not w.isMinimized]
    except Exception:
        all_windows = []

    # 1. Match specific title pattern if provided
    if title_pattern:
        pat = title_pattern.lower().strip()
        for w in all_windows:
            if pat in w.title.lower() and w.width >= 50 and w.height >= 50:
                return w

    # 2. Match common installer / modal dialogue keywords
    for w in all_windows:
        w_title_lower = w.title.lower()
        for kw in INSTALLER_KEYWORDS:
            if kw in w_title_lower and w.width >= 50 and w.height >= 50:
                return w

    # 3. Fall back to the active foreground window
    try:
        active = gw.getActiveWindow()
        if active and active.title and active.width >= 50 and active.height >= 50 and not active.isMinimized:
            return active
    except Exception:
        pass

    # 4. If any non-minimized titled window exists with reasonable size, pick the first
    for w in all_windows:
        if w.width >= 100 and w.height >= 100:
            return w

    return None

def get_clamped_bbox(win, screen_w, screen_h):
    """
    Clamp window bounding coordinates to the primary display area.
    """
    left = max(0, win.left)
    top = max(0, win.top)
    right = min(screen_w, win.left + win.width)
    bottom = min(screen_h, win.top + win.height)

    # Minimum bounding box safeguard
    if right - left < 50 or bottom - top < 50:
        return (0, 0, screen_w, screen_h)

    return (left, top, right, bottom)

def capture_snapshot(target_title=None, quality=85):
    """
    Capture a screenshot of the target installer window (or desktop fallback)
    and return base64 encoded JPEG data.
    """
    attach_default_desktop()
    try:
        screen_w, screen_h = pyautogui.size()
    except Exception:
        screen_w, screen_h = 1920, 1080

    target_win = find_target_window(target_title)
    is_fallback = False
    window_title = "Desktop"
    bounds = {"left": 0, "top": 0, "width": screen_w, "height": screen_h}

    img = None
    if target_win:
        try:
            window_title = target_win.title.strip()
            # Bring window to foreground if not already
            try:
                target_win.activate()
                time.sleep(0.1)
            except Exception:
                pass

            bbox = get_clamped_bbox(target_win, screen_w, screen_h)
            bounds = {
                "left": bbox[0],
                "top": bbox[1],
                "width": bbox[2] - bbox[0],
                "height": bbox[3] - bbox[1]
            }
            img = ImageGrab.grab(bbox=bbox)
        except Exception:
            img = None

    if img is None:
        try:
            img = ImageGrab.grab()
            is_fallback = True
            window_title = f"{window_title} (Desktop Fallback)"
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
            snap_res = capture_snapshot(target_title=args.title, quality=args.quality)
            act_res["refreshedSnapshot"] = snap_res

        print(json.dumps(act_res))
        sys.exit(0)

    # 2. Default mode: Capture snapshot
    snap_res = capture_snapshot(target_title=args.title, quality=args.quality)

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
