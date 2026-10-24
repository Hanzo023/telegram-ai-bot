#!/usr/bin/env python3
"""
tools/list_windows.py

OS-level window enumeration and categorization utility.
Enumerates open application and browser windows on Windows desktop,
categorizes them into Browsers and Applications, cleans up titles,
and outputs structured JSON for Telegram bot interactive menus.
"""

import os
import sys
import json
import ctypes
from ctypes import wintypes

# Ensure stdout handles UTF-8 characters on Windows consoles
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

def ensure_desktop_access():
    """Ensure the calling thread is attached to the active input desktop on Windows."""
    if sys.platform == 'win32':
        try:
            u32 = ctypes.windll.user32
            hdesk = u32.OpenInputDesktop(0, False, 0x01FF)
            if hdesk:
                u32.SetThreadDesktop(hdesk)
        except Exception:
            pass

ensure_desktop_access()

try:
    import pygetwindow as gw
except ImportError:
    print(json.dumps({
        "success": False,
        "error": "pygetwindow is not installed. Please run: pip install pygetwindow"
    }))
    sys.exit(1)

# Windows API for process name resolution
user32 = ctypes.windll.user32 if sys.platform == 'win32' else None
kernel32 = ctypes.windll.kernel32 if sys.platform == 'win32' else None

def get_process_name(hwnd):
    """Retrieve process executable file name for a given HWND."""
    if not (user32 and kernel32):
        return ''
    try:
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if pid.value == 0:
            return ''
        h_process = kernel32.OpenProcess(0x1000 | 0x0400, False, pid.value) # PROCESS_QUERY_LIMITED_INFORMATION
        if not h_process:
            return ''
        buf = (ctypes.c_wchar * 1024)()
        size = wintypes.DWORD(1024)
        kernel32.QueryFullProcessImageNameW(h_process, 0, buf, ctypes.byref(size))
        kernel32.CloseHandle(h_process)
        exe_path = buf.value
        return os.path.basename(exe_path).lower() if exe_path else ''
    except Exception:
        return ''

KNOWN_BROWSERS = {
    'brave.exe': 'Brave',
    'chrome.exe': 'Chrome',
    'msedge.exe': 'Edge',
    'firefox.exe': 'Firefox',
    'opera.exe': 'Opera',
    'opera_gx.exe': 'Opera GX',
    'vivaldi.exe': 'Vivaldi',
    'arc.exe': 'Arc',
    'waterfox.exe': 'Waterfox',
    'tor.exe': 'Tor'
}

KNOWN_APPS = {
    'robloxplayerbeta.exe': 'Roblox',
    'roblox.exe': 'Roblox',
    'steam.exe': 'Steam',
    'steamwebhelper.exe': 'Steam',
    'gemini.exe': 'Gemini',
    'telegram.exe': 'Telegram',
    'discord.exe': 'Discord',
    'code.exe': 'VS Code',
    'spotify.exe': 'Spotify',
    'antigravity.exe': 'Antigravity',
    'notepad.exe': 'Notepad',
    'windowsterminal.exe': 'Terminal',
    'powershell.exe': 'PowerShell',
    'cmd.exe': 'Command Prompt',
    'obsidian.exe': 'Obsidian',
    'slack.exe': 'Slack',
    'epicgameslauncher.exe': 'Epic Games',
    'blender.exe': 'Blender',
    'unity.exe': 'Unity',
    'cursor.exe': 'Cursor'
}

IGNORED_EXES = {
    'textinputhost.exe', 'searchhost.exe', 'shellexperiencehost.exe',
    'startmenuexperiencehost.exe', 'dwm.exe', 'ctfmon.exe', 'systemsettings.exe',
    'smartscreen.exe', 'applicationframehost.exe', 'lockapp.exe', 'conhost.exe'
}

IGNORED_TITLES = [
    'program manager', 'windows input experience', 'default ime', 'msctfime ui',
    'popuphost', 'setup', 'agentcursoroverlay', 'screen can\'t be screenshotted',
    'hidden window', 'gdi+ window', 'battery meter'
]

def clean_window_title(raw_title, app_name, is_browser=False):
    """Produce a concise, human-readable window label for Telegram UI buttons."""
    clean = (raw_title or '').strip().strip('\u200e\u200f\ufeff')
    if not clean:
        return app_name

    if is_browser:
        # Strip common browser suffixes: e.g. " - Brave", " - Google Chrome"
        for suff in [
            f' - {app_name}', f' — {app_name}',
            ' - Google Chrome', ' - Microsoft​ Edge', ' - Microsoft Edge',
            ' — Mozilla Firefox', ' - Opera', ' - Vivaldi', ' - Brave'
        ]:
            if clean.endswith(suff):
                clean = clean[:-len(suff)].strip()
                break
        return clean or app_name

    # If app name is already present or title is short
    if clean.lower() == app_name.lower():
        return app_name

    # Truncate overly long file paths or titles
    if len(clean) > 50:
        clean = clean[:47] + '...'

    return clean

def enumerate_windows():
    ensure_desktop_access()
    browsers = []
    apps = []
    seen_hwnds = set()
    seen_titles = set()

    all_wins = []
    try:
        all_wins = gw.getAllWindows()
    except Exception as e:
        return {"success": False, "error": f"Failed to list windows: {str(e)}"}

    for w in all_wins:
        hwnd = getattr(w, '_hWnd', None)
        if not hwnd or hwnd in seen_hwnds:
            continue
        seen_hwnds.add(hwnd)

        raw_title = (w.title or '').strip().strip('\u200e\u200f\ufeff')
        if not raw_title or len(raw_title) < 2:
            continue

        lower_title = raw_title.lower()
        if any(ign in lower_title for ign in IGNORED_TITLES):
            continue

        exe = get_process_name(hwnd)
        if exe in IGNORED_EXES:
            continue
        if exe == 'explorer.exe' and ('program manager' in lower_title or not raw_title):
            continue

        # Skip zero/tiny dimensions unless minimized
        if not w.isMinimized and (w.width < 60 or w.height < 60):
            continue

        # Prevent duplicate entries for identical window title & app
        title_dedup_key = f"{exe}::{lower_title}"
        if title_dedup_key in seen_titles:
            continue
        seen_titles.add(title_dedup_key)

        is_browser = exe in KNOWN_BROWSERS or any(
            b_suff in lower_title for b_suff in [' - brave', ' - google chrome', ' - microsoft edge', ' - edge', 'mozilla firefox']
        )

        if is_browser:
            browser_name = KNOWN_BROWSERS.get(exe, 'Browser')
            clean = clean_window_title(raw_title, browser_name, is_browser=True)
            browsers.append({
                'id': f"b_{len(browsers)}",
                'type': 'browser',
                'appName': browser_name,
                'title': raw_title,
                'cleanTitle': clean,
                'label': f"🌐 {browser_name}: {clean}" if clean != browser_name else f"🌐 {browser_name}",
                'hwnd': hwnd,
                'minimized': bool(w.isMinimized)
            })
        else:
            app_name = KNOWN_APPS.get(exe)
            if not app_name:
                if exe:
                    app_name = exe.replace('.exe', '').capitalize()
                else:
                    app_name = raw_title.split(' - ')[-1].strip() or 'App'

            # Icon choice
            icon = '🎮' if app_name in ['Roblox', 'Steam', 'Epic Games'] else (
                '💬' if app_name in ['Telegram', 'Discord', 'Slack'] else (
                    '💻' if app_name in ['VS Code', 'Cursor', 'Terminal', 'PowerShell', 'Command Prompt'] else '📱'
                )
            )

            clean = clean_window_title(raw_title, app_name, is_browser=False)
            label = f"{icon} {app_name}: {clean}" if clean != app_name and len(clean) < 30 else f"{icon} {app_name}"

            apps.append({
                'id': f"a_{len(apps)}",
                'type': 'app',
                'appName': app_name,
                'title': raw_title,
                'cleanTitle': clean,
                'label': label,
                'hwnd': hwnd,
                'minimized': bool(w.isMinimized)
            })

    return {
        "success": True,
        "desktop": {
            "id": "full",
            "type": "desktop",
            "name": "Entire Screen",
            "label": "🖥️ Entire Screen (Desktop)",
            "description": "Full primary desktop display"
        },
        "browsers": browsers,
        "apps": apps,
        "totalWindows": len(browsers) + len(apps)
    }

if __name__ == '__main__':
    result = enumerate_windows()
    print(json.dumps(result, ensure_ascii=False, indent=2))
