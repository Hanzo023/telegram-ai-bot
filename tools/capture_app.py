"""tools/capture_app.py

OS-level targeted window and desktop capture utility.
Eliminates manual screenshot taking by programmatically capturing application windows or full desktop.
Uses fast ctypes EnumWindows enumeration and safe_focus to prevent Windows OS foreground locks and hangs.
"""

import sys
import os
import time
import datetime
import threading
import ctypes
from ctypes import wintypes
from PIL import Image, ImageGrab

# Ensure standard UTF-8 output on Windows consoles
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

user32 = ctypes.windll.user32 if sys.platform == "win32" else None
kernel32 = ctypes.windll.kernel32 if sys.platform == "win32" else None

OUTPUT_FILE = "agent_vision.jpg"

def ensure_desktop_access():
    """Ensure the calling thread is attached to the active input desktop on Windows."""
    if sys.platform == "win32" and user32:
        try:
            h_desk = user32.OpenInputDesktop(0, False, 0x01FF)
            if not h_desk:
                h_desk = user32.OpenDesktopW('Default', 0, False, 0x01FF)
            if h_desk:
                user32.SetThreadDesktop(h_desk)
        except Exception:
            pass

ensure_desktop_access()

def get_process_name(hwnd):
    """Retrieve process executable file name for a given HWND."""
    if not (user32 and kernel32):
        return ""
    try:
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if pid.value == 0:
            return ""
        h_process = kernel32.OpenProcess(0x1000 | 0x0400, False, pid.value) # PROCESS_QUERY_LIMITED_INFORMATION
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

def match_target_window(target_str, windows=None):
    """
    Intelligently find the target window across all open windows.
    Case-insensitive substring match across all visible window titles, browser tabs, and processes.
    """
    if not target_str:
        return None
    if windows is None:
        windows = enum_visible_windows()

    q = target_str.lower().strip()
    scored = []

    for w in windows:
        title = w['title']
        lower_title = title.lower()
        exe = w['exe']

        # Ignore overlays and system background hosts
        if any(ign in lower_title for ign in ['windows input experience', 'program manager', 'agentcursoroverlay', 'default ime']):
            continue

        score = 0

        # Exact title match
        if q == lower_title:
            score += 100
        elif q in lower_title:
            score += 60

        # Process name matching (e.g. 'brave' matching 'brave.exe', 'gemini' matching 'gemini.exe')
        if q in exe:
            score += 50

        # Aliases for terminals and common apps
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

def capture_window(target_query=None):
    ensure_desktop_access()
    timestamp = datetime.datetime.now(datetime.timezone.utc).isoformat()
    
    if user32:
        screen_w = user32.GetSystemMetrics(0)
        screen_h = user32.GetSystemMetrics(1)
    else:
        screen_w, screen_h = 1920, 1080

    output_path = os.path.abspath(OUTPUT_FILE)
    target_str = target_query.strip() if target_query else ""
    is_desktop_req = not target_str or target_str.lower() in ["full", "desktop", "screen", "primary"]

    all_windows = enum_visible_windows()
    matched_window = None

    if not is_desktop_req:
        matched_window = match_target_window(target_str, all_windows)

    if matched_window:
        try:
            hwnd = matched_window['hwnd']
            bring_window_to_front(hwnd)

            # Re-read rect after focus/restore
            rect = wintypes.RECT()
            raw_left = matched_window['left']
            raw_top = matched_window['top']
            raw_width = matched_window['width']
            raw_height = matched_window['height']

            if hwnd and user32 and user32.GetWindowRect(hwnd, ctypes.byref(rect)):
                raw_left = rect.left
                raw_top = rect.top
                raw_width = rect.right - rect.left
                raw_height = rect.bottom - rect.top

            # Clamp coordinates to primary display to eliminate OS negative margin borders
            left = max(0, raw_left)
            top = max(0, raw_top)
            right = min(screen_w, raw_left + raw_width)
            bottom = min(screen_h, raw_top + raw_height)

            width = max(1, right - left)
            height = max(1, bottom - top)

            screenshot = ImageGrab.grab(bbox=(left, top, right, bottom))
            t_encode_start = time.perf_counter()
            if screenshot.mode != 'RGB':
                screenshot = screenshot.convert('RGB')
            if screenshot.width > 1280 or screenshot.height > 720:
                screenshot.thumbnail((1280, 720), Image.Resampling.BILINEAR)
            screenshot.save(output_path, "JPEG", quality=70, optimize=False)
            encode_ms = round((time.perf_counter() - t_encode_start) * 1000, 2)
            sys.stderr.write(f"[PROFILER] Step: Screenshot JPEG encoding (1280x720, quality=70) took {encode_ms} ms\n")
            file_size = os.path.getsize(output_path)

            print("=" * 80)
            print("📸 TARGETED DESKTOP VISION CAPTURE")
            print("=" * 80)
            print(f"Timestamp:         {timestamp}")
            print(f"Target Query:      '{target_str}'")
            print(f"Matched Window:    '{matched_window['title']}'")
            print(f"Bounding Box:      left={left}, top={top}, width={width}, height={height}")
            print(f"Screen Resolution: {screen_w}x{screen_h}")
            print(f"Saved Image:       {output_path} ({file_size:,} bytes)")
            print("Status:            SUCCESS (Window Focused & Cropped)")
            print("=" * 80)
            return True
        except Exception as win_err:
            print(f"⚠️ [Vision Warning] Window crop failed ({win_err}), falling back to full screen...")

    # Fallback / Entire Desktop Mode (do NOT minimize or close any window):
    screenshot = ImageGrab.grab()
    t_encode_start = time.perf_counter()
    if screenshot.mode != 'RGB':
        screenshot = screenshot.convert('RGB')
    if screenshot.width > 1280 or screenshot.height > 720:
        screenshot.thumbnail((1280, 720), Image.Resampling.BILINEAR)
    screenshot.save(output_path, "JPEG", quality=70, optimize=False)
    encode_ms = round((time.perf_counter() - t_encode_start) * 1000, 2)
    sys.stderr.write(f"[PROFILER] Step: Screenshot JPEG encoding (1280x720, quality=70) took {encode_ms} ms\n")

    file_size = os.path.getsize(output_path)
    fallback_reason = (
        f"Window matching '{target_str}' not found" 
        if target_str and not is_desktop_req else "Entire Desktop Screen Requested"
    )

    print("=" * 80)
    print("📸 PRIMARY MONITOR VISION CAPTURE")
    print("=" * 80)
    print(f"Timestamp:         {timestamp}")
    print(f"Target Query:      {f'\'{target_str}\'' if target_str else '(Entire Screen)'}")
    print(f"Reason:            {fallback_reason} -> Captured primary monitor")
    print(f"Bounding Box:      left=0, top=0, width={screen_w}, height={screen_h}")
    print(f"Screen Resolution: {screen_w}x{screen_h}")
    print(f"Saved Image:       {output_path} ({file_size:,} bytes)")
    print("Status:            SUCCESS (Clean Full Display)")
    print("=" * 80)
    return True

def start_watchdog(timeout_seconds=7.5):
    """Guarantees the process exits within 8 seconds max even if an OS call blocks."""
    def watchdog_target():
        time.sleep(timeout_seconds)
        try:
            out_p = os.path.abspath(OUTPUT_FILE)
            if not os.path.exists(out_p):
                img = ImageGrab.grab()
                img.save(out_p)
        except Exception:
            pass
        os._exit(0)

    t = threading.Thread(target=watchdog_target, daemon=True)
    t.start()

if __name__ == "__main__":
    start_watchdog(7.5)
    query = " ".join(sys.argv[1:]) if len(sys.argv) > 1 else None
    try:
        success = capture_window(query)
        sys.exit(0 if success else 1)
    except Exception as exc:
        print(f"❌ [Vision Fatal Error]: {exc}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        sys.exit(1)
