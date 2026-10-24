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

def ensure_desktop_access():
    """Ensure the calling thread is attached to the active input desktop on Windows."""
    if sys.platform == "win32":
        try:
            user32 = ctypes.windll.user32
            h_desk = user32.OpenInputDesktop(0, False, 0x01FF)
            if not h_desk:
                h_desk = user32.OpenDesktopW('Default', 0, False, 0x01FF)
            if h_desk:
                user32.SetThreadDesktop(h_desk)
        except Exception:
            pass

ensure_desktop_access()

def force_bring_to_front(hwnd):
    """
    Forcefully bring any window to the foreground on Windows.
    Bypasses LockSetForegroundWindow restrictions using the Alt-key event,
    AttachThreadInput, ShowWindow(SW_RESTORE), and SwitchToThisWindow.
    """
    if not hwnd or sys.platform != 'win32':
        return False
    try:
        user32 = ctypes.windll.user32
        kernel32 = ctypes.windll.kernel32

        ensure_desktop_access()

        # 1. Unlock SetForegroundWindow using keyboard Alt-key event
        user32.keybd_event(0x12, 0, 0, 0) # Alt down
        user32.keybd_event(0x12, 0, 2, 0) # Alt up

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

def capture_window(target_query=None):
    ensure_desktop_access()
    timestamp = datetime.datetime.now(datetime.timezone.utc).isoformat()
    screen_w, screen_h = pyautogui.size()
    output_path = os.path.abspath(OUTPUT_FILE)
    
    matched_window = None
    target_str = target_query.strip() if target_query else ""
    
    # Check if user requested entire desktop
    if target_str.lower() in ["full", "desktop", "screen", "primary"]:
        target_str = ""

    if target_str:
        all_windows = gw.getAllWindows()
        # Find windows matching case-insensitive substring
        candidates = [
            w for w in all_windows 
            if w.title and target_str.lower() in w.title.lower()
        ]
        
        # Sort candidates: prioritize non-minimized and visible windows with area > 0
        def score_window(w):
            score = 0
            if not w.isMinimized:
                score += 10
            if w.width > 50 and w.height > 50:
                score += 5
            return score
        
        candidates.sort(key=score_window, reverse=True)
        if candidates:
            matched_window = candidates[0]

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

            if hwnd and sys.platform == 'win32':
                try:
                    rect = wintypes.RECT()
                    if ctypes.windll.user32.GetWindowRect(hwnd, ctypes.byref(rect)):
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

    # Fallback / No Target Specified: Capture entire primary desktop
    screenshot = pyautogui.screenshot()
    screenshot.save(output_path)
    file_size = os.path.getsize(output_path)
    
    fallback_reason = (
        f"Window matching '{target_str}' not found" 
        if target_str else "No window target specified"
    )
    
    print("=" * 80)
    print("📸 PRIMARY MONITOR VISION CAPTURE (FALLBACK)")
    print("=" * 80)
    print(f"Timestamp:         {timestamp}")
    print(f"Target Query:      {f'\'{target_str}\'' if target_str else '(None)'}")
    print(f"Reason:            {fallback_reason} -> Captured primary monitor")
    print(f"Bounding Box:      left=0, top=0, width={screen_w}, height={screen_h}")
    print(f"Screen Resolution: {screen_w}x{screen_h}")
    print(f"Saved Image:       {output_path} ({file_size:,} bytes)")
    print("Status:            SUCCESS (Full Display Fallback)")
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
