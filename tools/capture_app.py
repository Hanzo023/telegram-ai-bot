"""tools/capture_app.py

OS-level targeted window and desktop capture utility.
Eliminates manual screenshot taking by programmatically capturing application windows or full desktop.
"""

import sys
import os
import time
import datetime
import ctypes
from ctypes import wintypes
from PIL import Image

# Ensure standard UTF-8 output on Windows consoles
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

user32 = ctypes.windll.user32 if sys.platform == "win32" else None
kernel32 = ctypes.windll.kernel32 if sys.platform == "win32" else None

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

def force_bring_to_front(hwnd):
    """
    Forcefully bring any window to the foreground on Windows without sending Alt keys.
    Disables OS foreground lock timeout, restores minimized state, attaches thread input,
    and calls SwitchToThisWindow.
    """
    if not hwnd or sys.platform != 'win32' or not user32:
        return False
    try:
        ensure_desktop_access()

        # 1. Disable OS foreground lock timeout (prevents focus stealing block without sending Alt)
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

import pygetwindow as gw
import pyautogui

# Set PyAutoGUI failsafe to False to allow capturing full-screen corners safely
pyautogui.FAILSAFE = False

OUTPUT_FILE = "agent_vision.png"

def find_and_minimize_telegram():
    """
    Finds the active Telegram Desktop window, temporarily minimizes it so it doesn't block
    desktop screenshots, and returns its HWND (or None) so it can be restored afterward.
    """
    if not (user32 and gw):
        return None
    try:
        for w in gw.getAllWindows():
            hwnd = getattr(w, '_hWnd', None)
            if not hwnd:
                continue
            exe = get_process_name(hwnd)
            is_tg = (exe == 'telegram.exe') or ('telegram' in (w.title or '').lower())
            if is_tg and not user32.IsIconic(hwnd) and w.width > 150 and w.height > 150:
                user32.ShowWindow(hwnd, 6) # SW_MINIMIZE
                time.sleep(0.35)
                return hwnd
    except Exception:
        pass
    return None

def restore_telegram(hwnd):
    """Restore Telegram Desktop window after screenshot has been captured."""
    if hwnd and user32:
        try:
            user32.ShowWindow(hwnd, 9) # SW_RESTORE
            time.sleep(0.1)
        except Exception:
            pass

def match_target_window(target_str):
    """
    Intelligently find the target window across ALL open windows.
    Matches window titles, browser tabs (e.g. 'Google Gemini - Brave'), and process names.
    """
    if not target_str or not gw:
        return None

    q = target_str.lower().strip()
    all_windows = gw.getAllWindows()
    scored = []

    for w in all_windows:
        hwnd = getattr(w, '_hWnd', None)
        title = (w.title or '').strip()
        if not title:
            continue
        lower_title = title.lower()
        exe = get_process_name(hwnd) if hwnd else ""

        # Ignore overlays and system background hosts
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
            if not w.isMinimized:
                score += 15
            if w.width > 100 and w.height > 100:
                score += 10
            scored.append((score, w))

    scored.sort(key=lambda item: item[0], reverse=True)
    return scored[0][1] if scored else None

def capture_window(target_query=None):
    ensure_desktop_access()
    timestamp = datetime.datetime.now(datetime.timezone.utc).isoformat()
    screen_w, screen_h = pyautogui.size()
    output_path = os.path.abspath(OUTPUT_FILE)
    
    target_str = target_query.strip() if target_query else ""
    is_desktop_req = not target_str or target_str.lower() in ["full", "desktop", "screen", "primary"]
    matched_window = None

    if not is_desktop_req:
        matched_window = match_target_window(target_str)

    if matched_window:
        try:
            hwnd = getattr(matched_window, '_hWnd', None)
            if hwnd:
                force_bring_to_front(hwnd)
            else:
                if matched_window.isMinimized:
                    matched_window.restore()
                    time.sleep(0.3)
                try:
                    matched_window.activate()
                    time.sleep(0.3)
                except Exception:
                    pass
            
            # Re-read dimensions from Windows API
            raw_left = matched_window.left
            raw_top = matched_window.top
            raw_width = matched_window.width
            raw_height = matched_window.height

            if hwnd and sys.platform == 'win32' and user32:
                try:
                    rect = wintypes.RECT()
                    if user32.GetWindowRect(hwnd, ctypes.byref(rect)):
                        raw_left = rect.left
                        raw_top = rect.top
                        raw_width = rect.right - rect.left
                        raw_height = rect.bottom - rect.top
                except Exception:
                    pass
            
            # Clamp coordinates to primary display to eliminate OS negative margin borders
            left = max(0, raw_left)
            top = max(0, raw_top)
            right = min(screen_w, raw_left + raw_width)
            bottom = min(screen_h, raw_top + raw_height)
            
            width = max(1, right - left)
            height = max(1, bottom - top)
            
            # Capture the target region
            screenshot = pyautogui.screenshot(region=(left, top, width, height))
            screenshot.save(output_path)
            
            file_size = os.path.getsize(output_path)
            
            print("=" * 80)
            print("📸 TARGETED DESKTOP VISION CAPTURE")
            print("=" * 80)
            print(f"Timestamp:         {timestamp}")
            print(f"Target Query:      '{target_str}'")
            print(f"Matched Window:    '{matched_window.title}'")
            print(f"Bounding Box:      left={left}, top={top}, width={width}, height={height}")
            print(f"Screen Resolution: {screen_w}x{screen_h}")
            print(f"Saved Image:       {output_path} ({file_size:,} bytes)")
            print("Status:            SUCCESS (Window Focused & Cropped)")
            print("=" * 80)
            return True
            
        except Exception as win_err:
            print(f"⚠️ [Vision Warning] Window crop failed ({win_err}), falling back to full screen...")

    # Fallback / Entire Desktop Mode:
    # Temporarily minimize Telegram Desktop so it doesn't block the screen!
    minimized_tg = find_and_minimize_telegram()
    try:
        screenshot = pyautogui.screenshot()
        screenshot.save(output_path)
    finally:
        restore_telegram(minimized_tg)

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
    print(f"Reason:            {fallback_reason} -> Captured primary monitor (Telegram minimized)")
    print(f"Bounding Box:      left=0, top=0, width={screen_w}, height={screen_h}")
    print(f"Screen Resolution: {screen_w}x{screen_h}")
    print(f"Saved Image:       {output_path} ({file_size:,} bytes)")
    print("Status:            SUCCESS (Clean Full Display)")
    print("=" * 80)
    return True

if __name__ == "__main__":
    query = " ".join(sys.argv[1:]) if len(sys.argv) > 1 else None
    try:
        success = capture_window(query)
        sys.exit(0 if success else 1)
    except Exception as exc:
        print(f"❌ [Vision Fatal Error]: {exc}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        sys.exit(1)
