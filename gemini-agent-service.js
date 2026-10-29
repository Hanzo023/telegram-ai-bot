import { GoogleGenAI } from '@google/genai';
import fs, { promises as fsp } from 'fs';
import path from 'path';
import os from 'os';
import { InputFile } from 'grammy';
import { searchWeb, searchYouTube, sanitizeError } from './search-service.js';
import { captureWebPageSnapshot } from './browser-service.js';
import {
  runLaptopCommand,
  readLaptopFile,
  writeLaptopFile,
  deleteLaptopFile,
  uploadLaptopFileToServer,
  listLaptopDirectory,
  getLaptopStatus,
  requestLaptopApproval,
  captureLaptopScreenshot,
  listLaptopWindows,
  isLaptopConnected,
  getConnectedLaptopsList,
  getActiveDevicePlatform,
  joinLaptopPath,
  isPathAbsolute,
  getBotApi,
  getExpectedSecret,
  saveCloudVaultEntry,
  getCloudVault,
  loadCloudDocumentContent,
  getUserPreferredDevice,
  getPreferredDevice,
} from './laptop-bridge.js';

const STORAGE_DIR = process.env.STORAGE_DIR || process.cwd();
const PRIMARY_MODEL = process.env.GEMINI_AGENT_MODEL || 'gemini-3.5-flash-lite';
const FALLBACK_MODEL = 'gemini-3.8-flash';

/**
 * Normalize device paths, handling Android Termux download/document directories,
 * expanding tildes (~), preserving paths with spaces,
 * and stripping Windows drive letters when operating on Android.
 *
 * @param {string} rawPath
 * @param {object|string} devInfo Device info object or platform string
 * @param {string} [fallbackDir=''] Base directory for non-Android laptops
 * @returns {string}
 */
export function normalizeDevicePath(rawPath, devInfo, fallbackDir = '') {
  const isAndroid = typeof devInfo === 'string'
    ? devInfo.toLowerCase().trim() === 'android'
    : devInfo?.platform === 'android';

  if (isAndroid) {
    const androidBase = (typeof devInfo === 'object' && devInfo?.storageDir) || '/sdcard/Download';
    let trimmed = typeof rawPath === 'string' ? rawPath.trim() : '';

    if (!trimmed) {
      return androidBase;
    }

    // Expand ~ and Termux storage symlinks
    if (trimmed === '~' || trimmed === '~/') {
      return androidBase;
    }
    if (/^~\/storage\/downloads(?:\/|$)/i.test(trimmed)) {
      trimmed = trimmed.replace(/^~\/storage\/downloads\/?/i, '');
      return trimmed ? `${androidBase}/${trimmed}` : androidBase;
    }
    if (/^~\/storage\/shared\/download(?:\/|$)/i.test(trimmed)) {
      trimmed = trimmed.replace(/^~\/storage\/shared\/download\/?/i, '');
      return trimmed ? `${androidBase}/${trimmed}` : androidBase;
    }
    if (/^~\/storage\/shared(?:\/|$)/i.test(trimmed)) {
      trimmed = trimmed.replace(/^~\/storage\/shared\/?/i, '');
      return trimmed ? `/sdcard/${trimmed}` : '/sdcard';
    }

    // Exact download directory references (must match entire path so we don't truncate /sdcard/Download/file.apk)
    if (/^(?:\.?[\/\\])?downloads?[\/\\]?$/i.test(trimmed) || /^[\/\\]?sdcard[\/\\]download[\/\\]?$/i.test(trimmed)) {
      return androidBase;
    }
    if (/^(?:\.?[\/\\])?documents?[\/\\]?$/i.test(trimmed) || /^[\/\\]?sdcard[\/\\]documents?[\/\\]?$/i.test(trimmed)) {
      return '/sdcard/Documents';
    }

    // Already an absolute Android path
    if (/^[\/\\]?(?:sdcard|storage\/emulated\/0)[\/\\]/i.test(trimmed)) {
      return '/' + trimmed.replace(/^[\/\\]+/, '').replace(/\\/g, '/');
    }

    // Windows drive letter on Android -> strip drive and put in androidBase
    if (/^[a-zA-Z]:[\/\\]/i.test(trimmed)) {
      return `${androidBase}/${path.win32.basename(trimmed)}`;
    }

    // Strip leading downloads/ if prepended relatively
    trimmed = trimmed.replace(/^(?:\.?[\/\\])?downloads?[\/\\]/i, '');
    return joinLaptopPath(androidBase, trimmed);
  }

  return joinLaptopPath(fallbackDir, rawPath);
}

/**
 * Tool Declarations for Gemini Interactions API
 */
export const AGENT_TOOLS = [
  {
    type: 'function',
    name: 'list_open_windows',
    description: 'List all currently open applications and browser windows (such as Roblox, Steam, Brave, Chrome, VS Code, Discord, Telegram) on the user\'s laptop. Use this whenever the user asks what is open or running, or to inspect active windows before taking a targeted screenshot.',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    type: 'function',
    name: 'take_screenshot',
    description: 'Capture a live screenshot of the user\'s laptop screen, phone screen, or a specific application window and send the photo directly to the user in Telegram. Use this whenever the user asks for a screenshot, wants to see their screen or desktop, or asks what is currently displayed on their device.',
    parameters: {
      type: 'object',
      properties: {
        window_title: {
          type: 'string',
          description: 'Optional title or search keyword of the application window to capture (e.g. "Chrome", "Code", "Discord"). Leave empty or omit to capture the entire primary monitor/desktop.',
        },
        caption: {
          type: 'string',
          description: 'Optional brief caption to display with the screenshot in Telegram.',
        },
        target_device: {
          type: 'string',
          enum: ['laptop', 'phone', 'tablet'],
          description: 'Target device to capture screenshot from. Default is laptop, or phone/tablet if the user mentions their phone or Android device.',
        },
      },
    },
  },
  {
    type: 'function',
    name: 'open_and_capture_webpage',
    description: 'Open a target website URL in the lightweight persistent browser, wait for domcontentloaded (strict 12s timeout), and capture an in-memory 1280x720 JPEG screenshot directly. Use this when the user asks to open a URL/website or take a screenshot of a web page.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The website URL to open and capture (e.g. "https://google.com", "https://github.com")',
        },
      },
      required: ['url'],
    },
  },
  {
    type: 'function',
    name: 'run_laptop_terminal',
    description: 'Execute a terminal command (PowerShell / Command Prompt / Bash / Termux) on the user\'s physical device(s). You have direct tool access to the user\'s connected physical device(s), including their Windows Laptop AND their Android Smartphone/Tablet (running Termux at `/sdcard/Download`). When the user asks to run commands on their phone, ALWAYS use `run_laptop_terminal` targeting `/sdcard/Download` or `target_device: "phone"`. For interactive TUIs on Windows, launch in a visible GUI terminal: "start wt cmd /k \\"<command>\\"" or "start cmd /k \\"<command>\\""; on Android/Termux, commands run directly in bash/sh or termux-open.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The terminal command line to execute (e.g. "npm install express", "python test.py", "git status", "pkg install git"). For interactive TUIs (yazi, etc.), use "start cmd /k <cmd>" or "start wt cmd /k <cmd>".' },
        cwd: { type: 'string', description: 'Optional working directory path on the laptop or device (e.g. "D:\\projects\\my-app" on laptop, or "/sdcard/Download" on phone)' },
        target_device: {
          type: 'string',
          enum: ['laptop', 'phone', 'tablet'],
          description: 'Target device to execute on. Default is laptop, or phone/tablet if the user mentions their phone, mobile, Android, or tablet.',
        },
      },
      required: ['command'],
    },
  },
  {
    type: 'function',
    name: 'read_laptop_file',
    description: 'Read the contents of a file directly from the user\'s physical laptop, phone, or tablet filesystem. You have direct tool access to the user\'s connected physical device(s), including their Windows Laptop AND their Android Smartphone/Tablet (running Termux at `/sdcard/Download`). When the user asks to check or read files on their phone, ALWAYS use `read_laptop_file` targeting `/sdcard/Download` or `target_device: "phone"`.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Full or relative path to the file on the laptop or phone (e.g. "D:\\projects\\app\\index.js" or "/sdcard/Download/file.txt")' },
        max_lines: { type: 'integer', description: 'Max lines to read (default 200)' },
        target_device: {
          type: 'string',
          enum: ['laptop', 'phone', 'tablet'],
          description: 'Target device to execute on. Default is laptop, or phone/tablet if the user mentions their phone, mobile, Android, or tablet.',
        },
      },
      required: ['file_path'],
    },
  },
  {
    type: 'function',
    name: 'write_laptop_file',
    description: 'Create, write, or patch a file directly on the user\'s physical laptop, phone, or tablet filesystem. You have direct tool access to the user\'s connected physical device(s), including their Windows Laptop AND their Android Smartphone/Tablet (running Termux at `/sdcard/Download`). When the user asks to save, create, or write files on their phone, ALWAYS use `write_laptop_file` targeting `/sdcard/Download` or `target_device: "phone"`.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Full path to the file on the target device' },
        content: { type: 'string', description: 'The complete text/code content to write to the file' },
        target_device: {
          type: 'string',
          enum: ['laptop', 'phone', 'tablet'],
          description: 'Target device to execute on. Default is laptop, or phone/tablet if the user mentions their phone, mobile, Android, or tablet.',
        },
      },
      required: ['file_path', 'content'],
    },
  },
  {
    type: 'function',
    name: 'list_laptop_files',
    description: 'List files and directories directly on the user\'s physical laptop, phone, or tablet filesystem. You have direct tool access to the user\'s connected physical device(s), including their Windows Laptop AND their Android Smartphone/Tablet (running Termux at `/sdcard/Download`). When the user asks to check files on their phone, ALWAYS use `list_laptop_files` targeting `/sdcard/Download` or `target_device: "phone"`.',
    parameters: {
      type: 'object',
      properties: {
        dir_path: { type: 'string', description: 'Directory path to list on the device (e.g. "D:\\projects" on laptop or "/sdcard/Download" on phone)' },
        target_device: {
          type: 'string',
          enum: ['laptop', 'phone', 'tablet'],
          description: 'Target device to execute on. Default is laptop, or phone/tablet if the user mentions their phone, mobile, Android, or tablet.',
        },
      },
    },
  },
  {
    type: 'function',
    name: 'delete_laptop_file',
    description: 'Delete a file or directory directly on the user\'s physical laptop, phone, or tablet filesystem. You have direct tool access to delete files on the connected physical device(s), including Android smartphones/tablets (/sdcard/Download) and laptops. Use this when the user asks to delete, remove, clean up, or purge a file or APK on their device.',
    parameters: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Full or relative path to the file or directory to delete (e.g. "/sdcard/Download/Telegram9.7.1-Old-Version Fix Login.apk" or "D:\\temp\\old_file.zip").',
        },
        target_device: {
          type: 'string',
          enum: ['laptop', 'phone', 'tablet'],
          description: 'Target device to execute on. Default is laptop, or phone/tablet if the user mentions their phone or Android device.',
        },
      },
      required: ['file_path'],
    },
  },
  {
    type: 'function',
    name: 'upload_device_file_to_telegram',
    description: 'Upload a file from the user\'s connected physical device (phone or laptop) directly to their Telegram chat and register it inside their Telegram Cloud Vault (/storage). You ARE the user\'s Telegram bot and have direct tool access to upload files to their chat. Always use this tool when the user asks to send, transfer, or upload a file from their phone/laptop to Telegram. Parameters: file_path (e.g. "/sdcard/Download/app.apk" or "D:\\data\\file.zip") and optional save_to_cloud_vault (boolean, default true).',
    parameters: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Full or relative path to the file on the connected device to upload (e.g. "/sdcard/Download/app.apk" or "file.pdf")',
        },
        save_to_cloud_vault: {
          type: 'boolean',
          description: 'Whether to register and index the file in the user\'s Telegram Cloud Vault (/storage). Defaults to true.',
        },
        target_device: {
          type: 'string',
          enum: ['laptop', 'phone', 'tablet'],
          description: 'Target device to upload from. Default is laptop, or phone/tablet if the user mentions their phone or Android device.',
        },
      },
      required: ['file_path'],
    },
  },
  {
    type: 'function',
    name: 'request_laptop_approval',
    description: 'Request user approval on Telegram with a live screenshot when an installer dialog, confirmation modal, or unknown prompt appears on the laptop. Halts and waits for the user to review and step through via Telegram inline buttons.',
    parameters: {
      type: 'object',
      properties: {
        window_title: { type: 'string', description: 'Optional title or search keyword of the target installer or modal window (e.g. "Setup", "Installer", "Confirm")' },
        reason: { type: 'string', description: 'Brief description of why approval is needed (e.g. "Setup wizard requires user confirmation before installing")' },
      },
    },
  },
  {
    type: 'function',
    name: 'get_laptop_status',
    description: 'Get live hardware and system status of the user\'s physical laptop, phone, or tablet (CPU, memory, battery, hostname, platform).',
    parameters: {
      type: 'object',
      properties: {
        target_device: {
          type: 'string',
          enum: ['laptop', 'phone', 'tablet'],
          description: 'Target device to execute on. Default is laptop, or phone/tablet if the user mentions their phone, mobile, Android, or tablet.',
        },
      },
    },
  },
  {
    type: 'function',
    name: 'search_web',
    description: 'Search the live web for real-time information, news, documentation, or facts.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
      },
      required: ['query'],
    },
  },
  {
    type: 'function',
    name: 'search_youtube',
    description: 'Search for YouTube videos, channels, and video links.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'YouTube search query' },
      },
      required: ['query'],
    },
  },
  {
    type: 'function',
    name: 'list_drive_files',
    description: 'List files stored on the local drive / storage directory.',
    parameters: {
      type: 'object',
      properties: {
        extension: { type: 'string', description: 'Optional extension filter (e.g. pdf, py, txt)' },
      },
    },
  },
  {
    type: 'function',
    name: 'read_drive_file',
    description: 'Read the text content of a file stored in the local drive / storage directory.',
    parameters: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'The filename to read' },
        max_lines: { type: 'integer', description: 'Max lines to read (default 100)' },
      },
      required: ['filename'],
    },
  },
  {
    type: 'function',
    name: 'get_system_status',
    description: 'Get current system status including CPU, memory usage, uptime, and platform.',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    type: 'function',
    name: 'calculate',
    description: 'Safely evaluate a mathematical calculation or formula.',
    parameters: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: 'The math expression to evaluate, e.g. "Math.sqrt(144) * 2"' },
      },
      required: ['expression'],
    },
  },
  {
    type: 'function',
    name: 'fetch_webpage_summary',
    description: 'Fetch text content from a web URL to inspect articles or documentation.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The HTTP/HTTPS URL to fetch' },
      },
      required: ['url'],
    },
  },
];

/**
 * Execute an individual tool call
 */
export async function executeTool(name, args = {}, context = {}) {
  const norm = String(name || '').toLowerCase().trim();

  // 0. Live Laptop Screenshot
  if (
    [
      'take_screenshot',
      'capture_screenshot',
      'capture_screen',
      'screenshot',
      'get_screenshot',
      'screen_capture',
    ].includes(norm)
  ) {
    if (!context.userId) {
      return JSON.stringify({ error: 'No Telegram User ID associated with this request.' });
    }

    const targetDevice = args.target_device || args.targetDevice || args.device || context.inferredTargetDevice;
    const devInfo = getActiveDevicePlatform(context.userId, targetDevice);

    // Cloud Fallback when device is offline
    if (!isLaptopConnected(context.userId, targetDevice)) {
      const urlMatch = (context.prompt || '').match(/https?:\/\/[^\s"'`]+/) ||
        (args.window_title || '').match(/https?:\/\/[^\s"'`]+/);
      if (urlMatch) {
        const targetUrl = urlMatch[0];
        return await executeTool('open_and_capture_webpage', { url: targetUrl }, context);
      }
      return JSON.stringify({
        success: false,
        error: 'Target device is offline. Cannot capture desktop screen. You can capture any web page or web app using `open_and_capture_webpage(url="https://...")`.',
      });
    }

    context.onStatusUpdate?.('📸 Capturing screenshot...');
    const windowTitle = args.window_title || args.windowTitle || args.title || undefined;
    const caption = args.caption || undefined;
    try {
      // If a window launch command was just executed, give it 500ms to paint; otherwise capture instantly without delay
      if (context.recentWindowLaunch) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      const res = await captureLaptopScreenshot(context.userId, { windowTitle, caption, sendDirect: true, targetDevice });
      if (res && res.success) {
        return JSON.stringify({
          success: true,
          message: `Screenshot of "${res.windowTitle}" successfully captured and sent directly to the user on Telegram.`,
          windowTitle: res.windowTitle,
          isDesktopFallback: res.isDesktopFallback,
        });
      }

      // Check fallback to open_and_capture_webpage if Android or web target
      const promptLower = (context.prompt || '').toLowerCase();
      const urlMatch = (context.prompt || '').match(/https?:\/\/[^\s"'`]+/) ||
        (windowTitle || '').match(/https?:\/\/[^\s"'`]+/);
      if (devInfo?.platform === 'android' || urlMatch || /\b(gemini|google|github|website|web page|url)\b/i.test(promptLower)) {
        let webUrl = urlMatch ? urlMatch[0] : null;
        if (!webUrl) {
          if (/\bgemini\b/i.test(promptLower)) webUrl = 'https://gemini.google.com';
          else if (/\bgithub\b/i.test(promptLower)) webUrl = 'https://github.com';
          else if (/\bgoogle\b/i.test(promptLower)) webUrl = 'https://google.com';
        }
        if (webUrl) {
          context.onStatusUpdate?.('🌐 Falling back to web snapshot...');
          return await executeTool('open_and_capture_webpage', { url: webUrl }, context);
        }
      }

      return JSON.stringify({ error: res?.error || 'Failed to capture screenshot.' });
    } catch (err) {
      const promptLower = (context.prompt || '').toLowerCase();
      const urlMatch = (context.prompt || '').match(/https?:\/\/[^\s"'`]+/);
      if (devInfo?.platform === 'android' || urlMatch || /\b(gemini|google|github|website|web page|url)\b/i.test(promptLower)) {
        let webUrl = urlMatch ? urlMatch[0] : null;
        if (!webUrl) {
          if (/\bgemini\b/i.test(promptLower)) webUrl = 'https://gemini.google.com';
          else if (/\bgithub\b/i.test(promptLower)) webUrl = 'https://github.com';
          else if (/\bgoogle\b/i.test(promptLower)) webUrl = 'https://google.com';
        }
        if (webUrl) {
          context.onStatusUpdate?.('🌐 Falling back to web snapshot...');
          return await executeTool('open_and_capture_webpage', { url: webUrl }, context);
        }
      }
      return JSON.stringify({ error: err.message });
    }
  }

  // 0b. Open and capture web page with lightweight singleton browser
  if (
    [
      'open_and_capture_webpage',
      'open_browser_screenshot',
      'capture_webpage',
      'webpage_screenshot',
      'screenshot_url',
    ].includes(norm)
  ) {
    const targetUrl = args.url || args.target_url || args.link;
    if (!targetUrl) {
      return JSON.stringify({ error: 'No URL provided to open and capture.' });
    }
    try {
      context.onStatusUpdate?.('🚀 Opening target...');
      const res = await captureWebPageSnapshot(targetUrl, {
        onStageUpdate: context.onStatusUpdate,
      });
      if (res && res.success && res.buffer) {
        if (context.ctx && context.userId) {
          const uploadT0 = performance.now();
          await context.ctx.replyWithPhoto(new InputFile(res.buffer, 'snapshot.jpg'), {
            caption: `📸 *Web Screenshot*\n• *URL:* \`${res.url}\`\n• *Viewport:* 1280x720 (JPEG 70%)`,
            parse_mode: 'Markdown',
          }).catch(async () => {
            await context.ctx.replyWithPhoto(new InputFile(res.buffer, 'snapshot.jpg'), {
              caption: `📸 Web Screenshot: ${res.url}`,
            }).catch(() => {});
          });
          const uploadDuration = Math.round(performance.now() - uploadT0);
          console.log(`[PROFILER] Step: Telegram photo upload took ${uploadDuration} ms`);
        }
        return JSON.stringify({
          success: true,
          url: res.url,
          durationMs: res.durationMs,
          message: `Screenshot of "${res.url}" successfully captured and sent directly to the user on Telegram.`,
        });
      }
      return JSON.stringify({ error: res?.error || 'Failed to capture web page screenshot.' });
    } catch (err) {
      return JSON.stringify({ error: err.message });
    }
  }

  // Live Laptop Open Windows Enumeration
  if (
    [
      'list_open_windows',
      'list_windows',
      'get_windows',
      'open_windows',
      'enumerate_windows',
    ].includes(norm)
  ) {
    if (!context.userId) {
      return JSON.stringify({ error: 'No Telegram User ID associated with this request.' });
    }
    try {
      const res = await listLaptopWindows(context.userId, 12000);
      return JSON.stringify(res);
    } catch (err) {
      return JSON.stringify({ error: err.message });
    }
  }

  // Remote Laptop Approval Request
  if (
    [
      'request_laptop_approval',
      'request_approval',
      'ask_approval',
      'laptop_approval',
    ].includes(norm)
  ) {
    if (!context.userId) {
      return JSON.stringify({ error: 'No Telegram User ID associated with this request.' });
    }
    const windowTitle = args.window_title || args.windowTitle || args.title || undefined;
    try {
      const res = await requestLaptopApproval(context.userId, windowTitle);
      if (res && res.success) {
        return JSON.stringify({
          success: true,
          message: `Approval snapshot presented to user on Telegram for window: "${res.windowTitle}". Waiting for user confirmation via inline buttons.`,
          windowTitle: res.windowTitle,
          isDesktopFallback: res.isDesktopFallback,
        });
      }
      return JSON.stringify({ error: res?.error || 'Failed to capture approval snapshot.' });
    } catch (err) {
      return JSON.stringify({ error: err.message });
    }
  }

  // 1. Terminal / Shell command execution (with common LLM aliases)
  if (
    [
      'run_laptop_terminal',
      'run_terminal_cmd',
      'run_terminal',
      'run_command',
      'execute_command',
      'exec_command',
      'terminal',
      'shell_cmd',
      'run_shell',
    ].includes(norm)
  ) {
    const command = args.command || args.cmd || args.command_line || args.commandLine;
    if (!command) {
      return JSON.stringify({ error: 'No command specified to execute.' });
    }
    if (!context.userId) {
      return JSON.stringify({ error: 'No Telegram User ID associated with this request.' });
    }

    const targetDevice = args.target_device || args.targetDevice || args.device || context.inferredTargetDevice;
    const devInfo = getActiveDevicePlatform(context.userId, targetDevice);

    // Cloud Fallback when device is offline: execute inside ./temp_downloads in cloud container
    if (!isLaptopConnected(context.userId, targetDevice)) {
      const cloudDir = path.resolve(process.cwd(), 'temp_downloads');
      if (!fs.existsSync(cloudDir)) fs.mkdirSync(cloudDir, { recursive: true });

      console.log(`[Cloud Terminal] Target device offline. Executing "${command}" in cloud workspace (${cloudDir})...`);
      context.onStatusUpdate?.(`☁️ *Executing in Cloud Workspace:* \`${command.slice(0, 50)}\`...`);

      const { exec } = await import('child_process');
      const terminalRes = await new Promise((resolve) => {
        exec(command, { cwd: cloudDir, timeout: 30000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
          resolve({
            success: !err,
            mode: 'cloud_container',
            cwd: cloudDir,
            stdout: (stdout || '').slice(-4000),
            stderr: (stderr || (err ? err.message : '')).slice(-2000),
            exitCode: err ? (err.code || 1) : 0,
          });
        });
      });
      return JSON.stringify(terminalRes);
    }

    let effectiveCwd =
      args.cwd ||
      args.working_dir ||
      args.workingDirectory ||
      context.detectedWorkingDir ||
      undefined;

    if (devInfo?.platform === 'android' && (!effectiveCwd || /^[a-zA-Z]:/i.test(effectiveCwd))) {
      effectiveCwd = devInfo.storageDir || '/sdcard/Download';
    } else if (devInfo?.platform === 'android' && effectiveCwd) {
      effectiveCwd = normalizeDevicePath(effectiveCwd, devInfo, devInfo.storageDir || '/sdcard/Download');
    }

    const onProgress = context.onStatusUpdate
      ? (progressText) => {
          context.onStatusUpdate?.(`⚙️ *Executing terminal command...*\n\`\`\`\n${progressText}\n\`\`\``);
        }
      : undefined;
    try {
      const res = await runLaptopCommand(context.userId, command, effectiveCwd, onProgress, targetDevice);
      return JSON.stringify(res);
    } catch (err) {
      return JSON.stringify({ error: err.message });
    }
  }

  // 2. Read file (with common LLM aliases)
  if (
    [
      'read_laptop_file',
      'get_file_contents',
      'read_file',
      'cat_file',
      'get_file',
      'read_file_contents',
      'readlaptopfile',
    ].includes(norm)
  ) {
    const rawPath = args.file_path || args.filePath || args.filename || args.path || args.file;
    if (!rawPath) {
      return JSON.stringify({ error: 'No file_path provided to read.' });
    }
    if (!context.userId) {
      return JSON.stringify({ error: 'No Telegram User ID associated with this request.' });
    }
    const maxLines = args.max_lines || args.maxLines || args.lines || 300;
    const targetDevice = args.target_device || args.targetDevice || args.device || context.inferredTargetDevice;
    const devInfo = getActiveDevicePlatform(context.userId, targetDevice);
    const fallbackDir = context.detectedWorkingDir || context.userDirectory || '';
    const normalizedPath = normalizeDevicePath(rawPath, devInfo, fallbackDir);

    // Cloud Fallback when device is offline: read from ./temp_downloads or Cloud Vault
    if (!isLaptopConnected(context.userId, targetDevice)) {
      const fileName = path.basename(normalizedPath);
      const cloudDir = path.resolve(process.cwd(), 'temp_downloads');
      const localDest = path.join(cloudDir, fileName);
      if (fs.existsSync(localDest)) {
        try {
          const content = await fsp.readFile(localDest, 'utf8');
          const lines = content.split(/\r?\n/).slice(0, maxLines).join('\n');
          return JSON.stringify({
            success: true,
            mode: 'cloud_container',
            filePath: localDest,
            content: lines,
          });
        } catch (readLocalErr) {
          return JSON.stringify({ error: readLocalErr.message });
        }
      }

      // Check in-memory Cloud Vault via bot.js
      try {
        const vault = getCloudVault() || [];
        const entry = vault.find((f) => f.name.toLowerCase() === fileName.toLowerCase());
        if (entry && entry.file_id) {
          const fileContent = await loadCloudDocumentContent(entry.file_id, entry.ext || path.extname(entry.name).slice(1), entry.name);
          const lines = (typeof fileContent === 'string' ? fileContent : JSON.stringify(fileContent)).split(/\r?\n/).slice(0, maxLines).join('\n');
          return JSON.stringify({
            success: true,
            mode: 'cloud_vault',
            name: entry.name,
            content: lines,
          });
        }
      } catch (vaultReadErr) {
        console.warn('[Cloud Mode] Read vault error:', vaultReadErr.message);
      }

      return JSON.stringify({
        success: false,
        error: `Target device is offline and file "${fileName}" was not found in Telegram Cloud Vault or cloud workspace.`,
      });
    }

    try {
      const res = await readLaptopFile(context.userId, normalizedPath, maxLines, targetDevice);
      return JSON.stringify(res);
    } catch (err) {
      return JSON.stringify({ error: err.message });
    }
  }

  // 3. Write file (with common LLM aliases)
  if (
    [
      'write_laptop_file',
      'write_file',
      'save_file',
      'save_laptop_file',
      'create_file',
      'edit_file',
      'update_file',
      'writelaptopfile',
    ].includes(norm)
  ) {
    const rawPath = args.file_path || args.filePath || args.filename || args.path || args.file;
    const content =
      args.content !== undefined
        ? args.content
        : args.text !== undefined
        ? args.text
        : args.code !== undefined
        ? args.code
        : args.data;
    if (!rawPath) {
      return JSON.stringify({ error: 'No file_path provided to write.' });
    }
    if (content === undefined || content === null) {
      return JSON.stringify({ error: 'No content provided to write.' });
    }
    if (!context.userId) {
      return JSON.stringify({ error: 'No Telegram User ID associated with this request.' });
    }
    const targetDevice = args.target_device || args.targetDevice || args.device || context.inferredTargetDevice;
    const devInfo = getActiveDevicePlatform(context.userId, targetDevice);
    const fallbackDir = context.detectedWorkingDir || context.userDirectory || '';
    const normalizedPath = normalizeDevicePath(rawPath, devInfo, fallbackDir);

    // Cloud Fallback when device is offline: write to ./temp_downloads, upload to chat, and register in Cloud Vault via bot.js
    if (!isLaptopConnected(context.userId, targetDevice)) {
      try {
        const fileName = path.basename(normalizedPath);
        const cloudDir = path.resolve(process.cwd(), 'temp_downloads');
        if (!fs.existsSync(cloudDir)) fs.mkdirSync(cloudDir, { recursive: true });
        const localDest = path.join(cloudDir, fileName);
        await fsp.writeFile(localDest, content, 'utf8');

        let telegramFileId = null;
        const botApi = getBotApi() || context.ctx?.api;
        if (botApi && context.userId) {
          try {
            const buffer = Buffer.from(content, 'utf8');
            const sent = await botApi.sendDocument(context.userId, new InputFile(buffer, fileName), {
              caption: `☁️ *Saved to Telegram Cloud Vault (Standalone Phone Mode)*`,
              parse_mode: 'Markdown',
            });
            telegramFileId = sent?.document?.file_id;
          } catch (sendErr) {
            console.warn('[Cloud Mode] Telegram document upload note:', sendErr.message);
          }
        }

        // Register in Cloud Vault via bot.js in-memory vault and persist
        try {
          const ext = fileName.split('.').pop()?.toLowerCase() || 'txt';
          await saveCloudVaultEntry({
            name: fileName,
            file_id: telegramFileId || '',
            ext,
            category: 'code',
            size: Buffer.byteLength(content, 'utf8'),
            date: Date.now(),
          });
        } catch (vaultErr) {
          console.warn('[Cloud Mode] Vault update note:', vaultErr.message);
        }

        return JSON.stringify({
          success: true,
          mode: 'cloud_vault',
          filePath: localDest,
          message: `Target device is offline. Saved "${fileName}" directly to Telegram Cloud Vault and sent to chat.`,
        });
      } catch (cloudWriteErr) {
        return JSON.stringify({ error: `Cloud write failed: ${cloudWriteErr.message}` });
      }
    }

    try {
      const res = await writeLaptopFile(context.userId, normalizedPath, content, 'utf8', targetDevice);
      return JSON.stringify(res);
    } catch (err) {
      return JSON.stringify({ error: err.message });
    }
  }

  // 4. List directory contents (with common LLM aliases)
  if (
    [
      'list_laptop_files',
      'list_directory_contents',
      'list_files',
      'list_dir',
      'dir_list',
      'ls',
      'listlaptopfiles',
    ].includes(norm)
  ) {
    if (!context.userId) {
      return JSON.stringify({ error: 'No Telegram User ID associated with this request.' });
    }
    const targetDevice = args.target_device || args.targetDevice || args.device || context.inferredTargetDevice;
    const devInfo = getActiveDevicePlatform(context.userId, targetDevice);

    // Cloud Fallback when device is offline: list files from ./temp_downloads and in-memory Cloud Vault
    if (!isLaptopConnected(context.userId, targetDevice)) {
      const cloudDir = path.resolve(process.cwd(), 'temp_downloads');
      const localFiles = fs.existsSync(cloudDir) ? await fsp.readdir(cloudDir) : [];
      let vaultFiles = [];
      try {
        const vault = getCloudVault() || [];
        vaultFiles = vault.map((f) => f.name);
      } catch {}
      const allFiles = [...new Set([...localFiles, ...vaultFiles])];
      return JSON.stringify({
        success: true,
        mode: 'cloud_vault',
        directory: 'Telegram Cloud Vault & Cloud Workspace',
        files: allFiles.map((name) => ({ name, type: 'file' })),
        count: allFiles.length,
      });
    }

    const rawDirPath =
      args.dir_path ||
      args.dirPath ||
      args.directory ||
      args.path ||
      args.dir ||
      '';
    const fallbackDir = context.detectedWorkingDir || context.userDirectory || '';
    const effectiveDir = normalizeDevicePath(rawDirPath, devInfo, fallbackDir);

    try {
      const res = await listLaptopDirectory(context.userId, effectiveDir, targetDevice);
      return JSON.stringify(res);
    } catch (err) {
      return JSON.stringify({ error: err.message });
    }
  }

  // 4b. Delete file / directory on device (with common LLM aliases)
  if (
    [
      'delete_laptop_file',
      'delete_file',
      'remove_file',
      'rm_file',
      'deletelaptopfile',
      'delete',
      'unlink',
    ].includes(norm)
  ) {
    const rawPath = args.file_path || args.filePath || args.path || args.filename || args.file;
    if (!rawPath) {
      return JSON.stringify({ error: 'No file_path provided to delete.' });
    }
    if (!context.userId) {
      return JSON.stringify({ error: 'No Telegram User ID associated with this request.' });
    }
    const targetDevice = args.target_device || args.targetDevice || args.device || context.inferredTargetDevice;
    const devInfo = getActiveDevicePlatform(context.userId, targetDevice);
    const fallbackDir = context.detectedWorkingDir || context.userDirectory || '';
    const normalizedPath = normalizeDevicePath(rawPath, devInfo, fallbackDir);

    if (!isLaptopConnected(context.userId, targetDevice)) {
      return JSON.stringify({
        success: false,
        error: `Target device is offline. Cannot delete file "${rawPath}". Please ensure your device runner is connected.`,
      });
    }

    try {
      const res = await deleteLaptopFile(context.userId, normalizedPath, targetDevice);
      if (res && res.success) {
        return JSON.stringify({
          success: true,
          deleted: true,
          filePath: res.filePath || normalizedPath,
          message: `Deleted: ${res.filePath || normalizedPath}`,
        });
      }
      return JSON.stringify(res || { success: false, error: 'Unknown file deletion error.' });
    } catch (err) {
      return JSON.stringify({ success: false, error: err.message });
    }
  }

  // 4c. Upload device file directly to Telegram & Cloud Vault
  if (
    [
      'upload_device_file_to_telegram',
      'upload_file_to_telegram',
      'send_file_to_telegram',
      'upload_laptop_file_to_telegram',
      'upload_to_telegram',
      'upload_to_storage',
      'upload_to_cloud_vault',
      'uploaddevicefiletotelegram',
    ].includes(norm)
  ) {
    const rawPath = args.file_path || args.filePath || args.path || args.filename || args.file;
    if (!rawPath) {
      return JSON.stringify({ error: 'No file_path provided to upload.' });
    }
    if (!context.userId) {
      return JSON.stringify({ error: 'No Telegram User ID associated with this request.' });
    }
    const saveToCloudVault = args.save_to_cloud_vault !== false && args.saveToCloudVault !== false;
    const targetDevice = args.target_device || args.targetDevice || args.device || context.inferredTargetDevice;
    const devInfo = getActiveDevicePlatform(context.userId, targetDevice);
    const fallbackDir = context.detectedWorkingDir || context.userDirectory || '';
    const normalizedPath = normalizeDevicePath(rawPath, devInfo, fallbackDir);

    if (!isLaptopConnected(context.userId, targetDevice)) {
      return JSON.stringify({
        success: false,
        error: `Target device is offline. Cannot upload "${rawPath}". Please ensure your device agent is connected.`,
      });
    }

    context.onStatusUpdate?.(`📤 *Uploading file to Telegram:* \`${path.basename(normalizedPath)}\`...`);

    try {
      const res = await uploadLaptopFileToServer(context.userId, normalizedPath, saveToCloudVault, targetDevice);
      return JSON.stringify(res);
    } catch (err) {
      // Fallback: If upload_to_server RPC failed, attempt running curl command directly on device
      try {
        const secret = getExpectedSecret();
        const serverUrl = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000';
        const httpBase = serverUrl.replace(/^ws:\/\//i, 'http://').replace(/^wss:\/\//i, 'https://');
        const uploadUrl = `${httpBase}/api/agent/upload/${context.userId}?secret=${encodeURIComponent(secret)}&vault=${saveToCloudVault}`;
        const curlCmd = `curl -sS -X POST -F "file=@\\"${normalizedPath}\\"" "${uploadUrl}"`;
        const cmdRes = await runLaptopCommand(context.userId, curlCmd, undefined, undefined, targetDevice);
        return JSON.stringify(cmdRes);
      } catch (fallbackErr) {
        return JSON.stringify({ success: false, error: err.message });
      }
    }
  }

  // 5. Laptop hardware status / specs (with common LLM aliases)
  if (
    [
      'get_laptop_status',
      'get_laptop_specs',
      'laptop_status',
      'specs',
      'system_specs',
      'hardware_status',
    ].includes(norm)
  ) {
    if (!context.userId) {
      return JSON.stringify({ error: 'No Telegram User ID associated with this request.' });
    }
    const targetDevice = args.target_device || args.targetDevice || args.device || context.inferredTargetDevice;
    try {
      const res = await getLaptopStatus(context.userId, targetDevice);
      return JSON.stringify(res);
    } catch (err) {
      return JSON.stringify({ error: err.message });
    }
  }

  switch (name) {
    case 'search_web': {
      const query = args.query || '';
      const results = await searchWeb(query, 5);
      if (!results || results.length === 0) {
        return JSON.stringify({ message: 'No web search results found for query: ' + query });
      }
      return JSON.stringify(
        results.map((r) => ({
          title: r.title,
          link: r.link,
          snippet: r.snippet,
        }))
      );
    }

    case 'search_youtube': {
      const query = args.query || '';
      const results = await searchYouTube(query, 5);
      if (!results || results.length === 0) {
        return JSON.stringify({ message: 'No YouTube videos found for: ' + query });
      }
      return JSON.stringify(
        results.map((v) => ({
          title: v.title,
          url: v.url,
          uploader: v.uploader,
          duration: v.duration,
        }))
      );
    }

    case 'list_drive_files': {
      try {
        const foundFiles = new Map(); // filename -> { name, source, size }

        // 1. Check local STORAGE_DIR if it exists
        if (fs.existsSync(STORAGE_DIR)) {
          try {
            const localList = await fs.promises.readdir(STORAGE_DIR);
            for (const f of localList) {
              foundFiles.set(f.toLowerCase(), { name: f, source: 'local_storage' });
            }
          } catch {}
        }

        // 2. Check in-memory Telegram Cloud Vault (always works on Render 24/7)
        try {
          const vaultData = getCloudVault() || [];
          if (Array.isArray(vaultData)) {
            for (const v of vaultData) {
              if (v.name && !foundFiles.has(v.name.toLowerCase())) {
                foundFiles.set(v.name.toLowerCase(), {
                  name: v.name,
                  source: 'telegram_cloud_vault',
                  size: v.size,
                  category: v.category,
                });
              }
            }
          }
        } catch {}

        let fileList = Array.from(foundFiles.values());
        if (args.extension) {
          const ext = args.extension.replace(/^\./, '').toLowerCase();
          fileList = fileList.filter((f) => f.name.toLowerCase().endsWith('.' + ext));
        }

        return JSON.stringify({
          total_files: fileList.length,
          files: fileList.slice(0, 50),
          note: fs.existsSync(STORAGE_DIR)
            ? 'Serving from local storage & Telegram Cloud Vault.'
            : 'Running in cloud (Render) — serving files directly from Telegram Cloud Vault.',
        });
      } catch (err) {
        return JSON.stringify({ error: err.message });
      }
    }

    case 'read_drive_file': {
      try {
        const filename = path.basename(args.filename || '');
        const maxLines = args.max_lines || 100;

        // 1. Check local storage if available
        if (fs.existsSync(STORAGE_DIR)) {
          const filePath = path.join(STORAGE_DIR, filename);
          if (fs.existsSync(filePath)) {
            const stats = await fs.promises.stat(filePath);
            if (stats.size > 5 * 1024 * 1024) {
              return JSON.stringify({ error: 'File exceeds 5MB limit for direct reading.' });
            }
            const content = await fs.promises.readFile(filePath, 'utf8');
            const lines = content.split('\n').slice(0, maxLines).join('\n');
            return JSON.stringify({
              filename,
              source: 'local_storage',
              size_bytes: stats.size,
              content: lines,
            });
          }
        }

        // 2. Check in-memory Telegram Cloud Vault (for Render cloud deployments)
        try {
          const vaultData = getCloudVault() || [];
          const entry = Array.isArray(vaultData)
            ? vaultData.find((v) => v.name.toLowerCase() === filename.toLowerCase())
            : null;

          if (entry && entry.file_id) {
            const ext = entry.ext || path.extname(entry.name).slice(1);
            const content = await loadCloudDocumentContent(entry.file_id, ext, entry.name);
            const lines = (typeof content === 'string' ? content : JSON.stringify(content)).split('\n').slice(0, maxLines).join('\n');
            return JSON.stringify({
              filename,
              source: 'telegram_cloud_vault',
              content: lines,
            });
          }
        } catch (cloudErr) {
          console.warn('[Gemini Agent] Cloud vault file fetch error:', cloudErr.message);
        }

        return JSON.stringify({
          error: `File "${filename}" not found in local drive or Telegram Cloud Vault. (Tip: Use /library or send the file to Telegram to sync it to Cloud Vault).`,
        });
      } catch (err) {
        return JSON.stringify({ error: err.message });
      }
    }

    case 'get_system_status': {
      const totalMem = Math.round(os.totalmem() / 1024 / 1024);
      const freeMem = Math.round(os.freemem() / 1024 / 1024);
      return JSON.stringify({
        platform: os.platform(),
        uptime_seconds: Math.round(os.uptime()),
        bot_uptime_seconds: Math.round(process.uptime()),
        memory: {
          total_mb: totalMem,
          free_mb: freeMem,
          used_mb: totalMem - freeMem,
        },
        cpus: os.cpus().length,
      });
    }

    case 'calculate': {
      try {
        const expr = (args.expression || '').trim();
        // Disallow dangerous identifiers
        if (/[;{}()[\]]|require|import|eval|Function|process|global|window|fs|child_process/i.test(expr)) {
          // If pure math expression with allowed operators
          if (!/^[0-9+\-*/%^().,\sMath.PIEsqrtcossintanlogabsround]+$/.test(expr)) {
            return JSON.stringify({ error: 'Expression contains disallowed characters.' });
          }
        }
        const fn = new Function(`return (${expr})`);
        const val = fn();
        return JSON.stringify({ expression: expr, result: String(val) });
      } catch (err) {
        return JSON.stringify({ error: 'Calculation failed: ' + err.message });
      }
    }

    case 'fetch_webpage_summary': {
      try {
        const targetUrl = args.url;
        const res = await fetch(targetUrl, {
          signal: AbortSignal.timeout(10000),
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
          },
        });
        if (!res.ok) return JSON.stringify({ error: `HTTP ${res.status}: ${res.statusText}` });
        const text = await res.text();
        const clean = text
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        return JSON.stringify({
          url: targetUrl,
          content_preview: clean.slice(0, 3000),
        });
      } catch (err) {
        return JSON.stringify({ error: 'Fetch failed: ' + err.message });
      }
    }

    default:
      return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
}

/**
 * Run the Gemini Autonomous Agent Loop
 *
 * @param {Object} options
 * @param {string} options.prompt - User goal or prompt
 * @param {Function} [options.onStatusUpdate] - Live status callback (e.g. "🔍 Searching web...")
 * @param {number} [options.maxSteps=6] - Max tool calling iterations
 * @param {number} [options.userId] - Telegram User ID to route laptop tools to
 * @returns {Promise<{ finalAnswer: string, stepsExecuted: Array, success: boolean }>}
 */
export async function runGeminiAgent({
  prompt,
  onStatusUpdate,
  maxSteps = 25,
  userId,
  userDirectory,
  recentHistory = [],
  model = null,
  pollUserQueue = null,
  abortSignal = null,
  ctx = null,
}) {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured in environment variables.');
  }

  const ai = new GoogleGenAI({ apiKey });
  const stepsExecuted = [];

  // Infer inferredTargetDevice from user's prompt or preferred device
  let inferredTargetDevice = undefined;
  if (/\b(phone|mobile|termux|sdcard|apk)\b/i.test(prompt)) {
    inferredTargetDevice = 'phone';
  } else if (/\b(tablet|pad)\b/i.test(prompt)) {
    inferredTargetDevice = 'tablet';
  } else if (/\b(laptop|pc|desktop|windows|powershell)\b/i.test(prompt)) {
    inferredTargetDevice = 'laptop';
  } else {
    const pref = getUserPreferredDevice(userId);
    if (pref && pref !== 'auto') {
      inferredTargetDevice = pref;
    }
  }

  // Inspect live device connection status for Multi-Device & Standalone Phone / Cloud Mode
  const userDevicesList = getConnectedLaptopsList(userId);
  const onlineDevices = userDevicesList.filter((d) => d.isOnline);
  const anyDeviceOnline = onlineDevices.length > 0;

  let primaryOnlineDevice = null;
  if (onlineDevices.length === 1) {
    primaryOnlineDevice = onlineDevices[0];
  } else if (onlineDevices.length > 1) {
    if (inferredTargetDevice) {
      primaryOnlineDevice = onlineDevices.find((d) =>
        (d.deviceType && d.deviceType.toLowerCase() === inferredTargetDevice) ||
        (d.deviceName && d.deviceName.toLowerCase().includes(inferredTargetDevice)) ||
        (d.deviceId && d.deviceId.toLowerCase().includes(inferredTargetDevice))
      );
    }
    if (!primaryOnlineDevice) {
      const preferred = getUserPreferredDevice(userId);
      if (preferred && preferred !== 'auto') {
        primaryOnlineDevice = onlineDevices.find((d) =>
          (d.deviceType && d.deviceType.toLowerCase() === preferred) ||
          (d.deviceName && d.deviceName.toLowerCase().includes(preferred)) ||
          (d.deviceId && d.deviceId.toLowerCase().includes(preferred))
        );
      }
    }
    if (!primaryOnlineDevice) {
      primaryOnlineDevice = onlineDevices.find((d) => d.deviceType === 'laptop') || onlineDevices[0];
    }
  }

  const defaultDeviceDirective = primaryOnlineDevice
    ? `ACTIVE DEFAULT DEVICE: [${(primaryOnlineDevice?.deviceType || 'laptop').toUpperCase()}] "${primaryOnlineDevice?.deviceName || 'Device'}" (${primaryOnlineDevice?.platform || 'unknown'}).\n` +
      `When the user asks to check files, download files, or run commands without specifying a device, ALWAYS target this active default device.\n` +
      `If the active default device is an Android phone/tablet, "downloads folder" or "download folder" refers to "/sdcard/Download". NEVER claim you are running in a mobile/sandbox environment or tell the user to press Win+E on their computer when their phone is connected.\n\n`
    : '';

  const devicesStatusSection = anyDeviceOnline
    ? `ONLINE CONNECTED DEVICES (${onlineDevices.length}):\n` +
      onlineDevices.map((d) => `• [${(d.deviceType || 'laptop').toUpperCase()}] "${d.deviceName}" (${d.platform}, host: ${d.hostname})`).join('\n') +
      `\n\n`
    : `⚠️ ALL PHYSICAL DEVICES CURRENTLY OFFLINE.\nOperating in Standalone Cloud Mode.\n\n`;

  const offlineDirective = !anyDeviceOnline
    ? '⚠️ SYSTEM NOTICE: The user\'s physical devices (laptop, phone, tablet) are currently OFFLINE (disconnected).\n' +
      'You are operating in STANDALONE CLOUD MODE.\n' +
      '- Do NOT say "I don\'t have access to your personal device" or give up.\n' +
      '- If the user asks about installed apps, files, or system info, use available tools like search_web, list_drive_files, read_drive_file, or run shell commands in the cloud container.\n' +
      '- If they ask for a screenshot of a website, use open_and_capture_webpage.\n' +
      '- Be resourceful and proactive.\n\n'
    : '';

  const connectionModeInstruction = anyDeviceOnline
    ? 'DEVICE CONNECTIONS: ONLINE & ACTIVE. Tools route directly to the user\'s physical devices (laptop, Android phone, tablet).\n\n'
    : 'All tools automatically and seamlessly execute in Standalone Cloud Mode:\n' +
      '• write_laptop_file: Writes the file to the cloud workspace (./temp_downloads), uploads the file directly to the user\'s Telegram chat, and stores it in Telegram Cloud Vault.\n' +
      '• read_laptop_file & list_laptop_files: Read and list files from Telegram Cloud Vault and the cloud workspace (./temp_downloads).\n' +
      '• run_laptop_terminal: Runs commands directly inside the cloud workspace container (./temp_downloads), with Node.js, Python, and Git available.\n' +
      '• take_screenshot / open_and_capture_webpage: Captures websites or web apps via the cloud headless browser.\n' +
      '• search_web & search_youtube: Full live web and YouTube search.\n' +
      'NEVER fail, refuse, or say you cannot proceed because devices are offline. Always execute the requested task in Cloud Mode!\n\n';

  // Extract explicit directory path from prompt if user mentioned one (e.g. "D:\projects\telegram-ai-bot")
  let detectedWorkingDir = null;
  const pathMatch = prompt.match(/([a-zA-Z]:\\[^\s"'`]+)/);
  if (pathMatch) {
    const raw = pathMatch[1].replace(/[\\\/]+$/, '');
    if (fs.existsSync(raw) && fs.statSync(raw).isDirectory()) {
      detectedWorkingDir = raw;
    } else {
      const p = path.dirname(raw);
      if (fs.existsSync(p)) {
        detectedWorkingDir = p;
      }
    }
  }

  // Include recent conversation turns if available so the agent understands multi-turn requests
  let inputPrompt = prompt;
  if (recentHistory && recentHistory.length > 0) {
    const historyText = recentHistory
      .map((h) => `${h.role === 'user' ? 'User' : 'Assistant'}: ${h.content.slice(0, 800)}`)
      .join('\n');
    inputPrompt = `CONVERSATION CONTEXT (Previous turns in this chat):\n${historyText}\n\nCURRENT USER REQUEST:\n${prompt}`;
  }

  // If active connected device is Android, override any Windows C:\ or D:\ userDirectory with '/sdcard/Download'
  const activeDevice = getActiveDevicePlatform(userId);
  let resolvedUserDir = userDirectory;
  const isAndroidActive = primaryOnlineDevice?.platform === 'android' || activeDevice?.platform === 'android';
  if (isAndroidActive) {
    if (!resolvedUserDir || /^[a-zA-Z]:/i.test(resolvedUserDir)) {
      resolvedUserDir = primaryOnlineDevice?.storageDir || activeDevice?.storageDir || '/sdcard/Download';
    }
    if (detectedWorkingDir && /^[a-zA-Z]:/i.test(detectedWorkingDir)) {
      detectedWorkingDir = resolvedUserDir;
    }
  }

  const effectiveTargetDir = detectedWorkingDir || resolvedUserDir || 'default working directory';

  // Models to attempt: user requested (if any) -> primary (gemini-3.5-flash-lite) -> gemini-3.5-flash -> fallback (gemini-3.8-flash)
  const candidateModels = [
    model,
    PRIMARY_MODEL,
    'gemini-3.5-flash',
    FALLBACK_MODEL,
  ].filter(Boolean);
  const uniqueCandidateModels = [...new Set(candidateModels)];
  let lastError = null;

  for (const model of uniqueCandidateModels) {
    try {
      if (onStatusUpdate) {
        onStatusUpdate('🧠 Processing with Gemini...');
      }

      const initialLlmT0 = performance.now();
      let currentResponse = await ai.interactions.create({
        model,
        input: inputPrompt,
        tools: AGENT_TOOLS,
        system_instruction:
          offlineDirective +
          'You are an autonomous AI Agent in Telegram with direct tool access to the user\'s physical devices (laptop, Android phone via Termux, tablet).\n' +
          'You have direct tool access to the user\'s connected physical device(s), including their Windows Laptop AND their Android Smartphone/Tablet (running Termux at `/sdcard/Download`). When the user asks to check files, download files, delete files, upload files, or run commands on their phone, ALWAYS use the official device tools (`list_laptop_files`, `delete_laptop_file`, `upload_device_file_to_telegram`, `read_laptop_file`, `write_laptop_file`, `run_laptop_terminal`).\n\n' +
          devicesStatusSection +
          defaultDeviceDirective +
          connectionModeInstruction +
          `User\'s target folder on their laptop: "${effectiveTargetDir}".\n` +
          `User\'s storage directory on Android phone/tablet (Termux): "/sdcard/Download".\n\n` +
          'CRITICAL EXECUTION AND MULTI-DEVICE RULES:\n' +
          '1. TELEGRAM BOT IDENTITY & DIRECT CLOUD ACCESS:\n' +
          '   • You ARE the user\'s Telegram bot and have direct access to the user\'s Telegram chat and `/storage` Telegram Cloud Vault Index via the `upload_device_file_to_telegram` tool.\n' +
          '   • You must NEVER attempt to find a local Telegram CLI, python script, or bot token inside the remote device\'s terminal to upload files; you must always call `upload_device_file_to_telegram(file_path, save_to_cloud_vault, target_device)`.\n' +
          '   • Tools prefixed with `laptop_` or `device_` (`list_laptop_files`, `delete_laptop_file`, `upload_device_file_to_telegram`, `run_laptop_terminal`, `read_laptop_file`, `write_laptop_file`) execute on whichever remote device is currently connected (including `Type: phone` / Android Termux) and have full permission to delete, move, inspect, and upload files when requested by the user.\n' +
          '   • When the user asks to delete, clean up, or purge a file or APK, ALWAYS call `delete_laptop_file(file_path, target_device)`. Do NOT claim you lack the tool to delete files.\n' +
          '2. MULTI-DEVICE CONTROL & ROUTING:\n' +
          '   • You can control the user\'s Windows laptop, Android phone (via Termux), and tablet simultaneously!\n' +
          '   • When the user mentions their "phone", "mobile", "Android", or "tablet", specify `target_device: "phone"` or `target_device: "tablet"` in your tool calls (`run_laptop_terminal`, `delete_laptop_file`, `upload_device_file_to_telegram`, `read_laptop_file`, `write_laptop_file`, `list_laptop_files`, `get_laptop_status`).\n' +
          `   • Default \`target_device\` is "${primaryOnlineDevice?.deviceType || 'laptop'}" if not specified by the user.\n` +
          '   • On Android / Termux:\n' +
          '     - User storage and downloads are located in `/sdcard/Download`.\n' +
          '     - You can install CLI packages via `pkg install -y <package>`, `pip install <package>`, or `npm install <package>`.\n' +
          '     - You can trigger native Android APK installs or open files via `run_laptop_terminal(command="termux-open <file.apk>", target_device="phone")`. Android will immediately pop up the native package installer prompt on the phone screen.\n' +
          '3. PHYSICAL FILESYSTEM REALITY: Text output in chat CANNOT create or save files on the user\'s devices. The ONLY way to save or create a file is by executing the `write_laptop_file(file_path, content, target_device)` tool. If the user asks to save, create, or write a file, you MUST call `write_laptop_file`.\n' +
          '4. OFFICIAL TOOL NAMES:\n' +
          '   • upload_device_file_to_telegram: Upload a file from the user\'s connected device (phone or laptop) directly to their Telegram chat and register it inside their Telegram Cloud Vault (/storage). Parameters: file_path, save_to_cloud_vault, target_device.\n' +
          '   • delete_laptop_file: Delete a file or directory on device (file_path, target_device). Returns confirmation of deletion.\n' +
          '   • list_laptop_files: List files in a directory on device (dir_path, target_device)\n' +
          '   • read_laptop_file: Read files on device (file_path, max_lines, target_device)\n' +
          '   • write_laptop_file: Write or overwrite files on device (file_path, content, target_device)\n' +
          '   • run_laptop_terminal: Execute shell commands on device (command, cwd, target_device)\n' +
          '   • get_laptop_status: Inspect device hardware specs (target_device)\n' +
          '   • list_open_windows: Enumerate open application and browser windows on user\'s laptop\n' +
          '   • take_screenshot: Capture laptop screen or app window and deliver photo directly to user on Telegram (window_title, caption). ALWAYS use this when the user asks for a screenshot, screen capture, or to see their desktop/screen.\n' +
          '   • search_web: Search Google for documentation or solutions\n' +
          '   • request_laptop_approval: Request user approval when installer or confirmation dialog is displayed\n' +
          '5. SCREENSHOT RULE: To take a screenshot, NEVER attempt to run custom PowerShell or Python screenshot scripts in run_laptop_terminal. Always call `take_screenshot`.\n' +
          '6. FULL MULTI-STEP WORKFLOWS: When requested to edit a file and push to Git:\n' +
          '   a. Read or verify target file via `read_laptop_file`\n' +
          '   b. Write the complete updated content via `write_laptop_file`\n' +
          '   c. Execute git operations via `run_laptop_terminal(command="git add . && git commit -m ... && git push", cwd="' + effectiveTargetDir + '")`\n' +
          '   d. Report the outcome with commit details in your final answer.\n' +
          '7. TARGET PATH RESOLUTION: If the user provides a path (e.g. "' + effectiveTargetDir + '"), ALWAYS use that directory path for commands and file operations.\n' +
          '8. ZERO FAKE TOOLS: NEVER simulate tool execution in markdown text. Always call actual tools.\n' +
          '9. DISCONNECTED STATE: If a tool reports a device is disconnected, explain clearly and inform the user how to connect it.\n' +
          '10. TELEGRAM FORMATTING & DIRECTNESS: Do NOT use raw markdown headers (###) or horizontal divider lines (---). If you need headings, use *Bold text* on its own line. Use clean bullet points (•). Be direct, concise, and avoid repetitive padding.\n' +
          '11. TEMPORAL REALITY (2026): The current year is 2026. Models Gemini 3.8 Flash, 3.5 Flash, 3.5 Flash-Lite are official Google models released in 2025–2026.\n\n' +
          '12. APP INSTALLATION & SCREENSHOT WORKFLOWS:\n' +
          '    When the user asks to install, launch, or screenshot an application (e.g. "install yazi, open it and take a screenshot", or "open roblox and screenshot it"):\n' +
          '    a. Install: Always use silent non-interactive flags so terminal commands never hang waiting on user stdin:\n' +
          '       • winget (Windows): `winget install <id> -e --silent --accept-package-agreements --accept-source-agreements`\n' +
          '       • pkg (Android Termux): `pkg install -y <package>`\n' +
          '       • pip: `pip install <package> --no-input -q`\n' +
          '       • npm: `npm install <package> --yes --no-audit --no-fund`\n' +
          '       CRITICAL: Never run commands that prompt for user confirmation without non-interactive flags.\n' +
          '    b. Launch: Interactive TUIs (like Yazi) or terminal programs on Windows CANNOT run in headless background subprocesses. You MUST launch them in a visible GUI terminal window via `run_laptop_terminal(command="start cmd /k yazi")` or `start wt cmd /k yazi`. For GUI desktop apps, use `run_laptop_terminal(command="start <app_name>")` (e.g. `start roblox:`, `start brave`). On Android, use `termux-open <file>`.\n' +
          '    c. Verify & Capture: Call `take_screenshot(window_title="yazi")` or `take_screenshot(window_title="Roblox")`. The system will automatically bring it to the foreground and deliver the screenshot directly to Telegram.',
      });

      const initialLlmDuration = Math.round(performance.now() - initialLlmT0);
      console.log(`[PROFILER] Step: Gemini initial reasoning took ${initialLlmDuration} ms (model: ${model})`);

      let stepCount = 0;
      let recentWindowLaunch = false;

      while (stepCount < maxSteps) {
        if (abortSignal?.aborted) {
          return {
            finalAnswer: '🛑 Agent task was stopped by user request.',
            stepsExecuted,
            success: false,
            stopped: true,
          };
        }

        stepCount++;
        const steps = currentResponse.steps || [];
        const functionCallStep = steps.find((s) => s.type === 'function_call');

        if (!functionCallStep) {
          // No more tool calls; final answer reached
          let finalAnswer =
            currentResponse.output_text ||
            steps
              .filter((s) => s.type === 'text')
              .map((s) => s.text)
              .join('\n')
              .trim() ||
            'Task completed.';

          // Strip hallucinated tool execution sections that LLMs sometimes generate
          finalAnswer = finalAnswer.replace(/(?:⚙️|🛠️)?\s*Executed Tools:[\s\S]*?(?=\n\n[#A-Z📁🎮]|$)/i, '').trim();

          // Hold generated code in pending state so user is prompted before writing to disk
          let pendingFile = null;
          const codeBlockMatch = finalAnswer.match(/```(?:[a-zA-Z0-9_-]+)?\s*([\s\S]+?)```/);
          if (codeBlockMatch) {
            const codeContent = codeBlockMatch[1].trim();
            let detectedFilename = null;
            const fileMatch = finalAnswer.match(/(?:saved it directly to|saved to|named|path:?|file:?)\s*[`"']?([A-Za-z0-9_\\\/\.:-]+\.[a-zA-Z0-9]+)[`"']?/i);
            if (fileMatch && !fileMatch[1].includes(' ')) {
              detectedFilename = path.basename(fileMatch[1]);
            }

            if (!detectedFilename) {
              if (/import turtle|import pygame|def main/i.test(codeContent)) {
                detectedFilename = 'game.py';
              } else if (/console\.log|import|const /i.test(codeContent)) {
                detectedFilename = 'script.js';
              } else {
                detectedFilename = 'script.py';
              }
            }

            let baseDir = effectiveTargetDir || userDirectory || STORAGE_DIR;
            if (/(?:to|on)\s+(?:my\s+)?desktop/i.test(prompt)) {
              baseDir = path.join(os.homedir(), 'Desktop');
            }
            const destPath = joinLaptopPath(baseDir, detectedFilename);

            pendingFile = {
              code: codeContent,
              filename: detectedFilename,
              suggestedPath: destPath,
            };
          }

          return {
            finalAnswer,
            stepsExecuted,
            success: true,
            pendingFile,
          };
        }

        // Execute tool call
        const toolName = functionCallStep.name;
        const toolArgs = functionCallStep.arguments || {};
        const stepRecord = { name: toolName, args: toolArgs, success: false };
        stepsExecuted.push(stepRecord);

        const isOpeningTarget =
          toolName === 'open_and_capture_webpage' ||
          (toolName === 'run_laptop_terminal' && /(?:start\s+|wt\b|cmd\s+\/k)/i.test(toolArgs?.command || ''));

        if (isOpeningTarget) {
          recentWindowLaunch = true;
          if (onStatusUpdate) onStatusUpdate('🚀 Opening target...');
        } else if (toolName === 'take_screenshot') {
          if (onStatusUpdate) onStatusUpdate('📸 Capturing screenshot...');
        } else if (onStatusUpdate) {
          const argsSummary = Object.values(toolArgs).map(v => typeof v === 'string' ? `"${v.slice(0, 30)}"` : v).join(', ');
          onStatusUpdate(`⚙️ *Executing tool:* \`${toolName}(${argsSummary})\`...`);
        }

        const toolT0 = performance.now();
        const toolResult = await executeTool(toolName, toolArgs, {
          userId,
          userDirectory: resolvedUserDir,
          detectedWorkingDir,
          inferredTargetDevice,
          prompt,
          onStatusUpdate,
          recentWindowLaunch,
          ctx,
        });
        const toolDuration = Math.round(performance.now() - toolT0);
        console.log(`[PROFILER] Step: Tool "${toolName}" execution took ${toolDuration} ms`);

        // Parse tool result success for reliable downstream checks (Requirement 3)
        let parsedSuccess = true;
        try {
          if (typeof toolResult === 'string') {
            const parsed = JSON.parse(toolResult);
            if (parsed.success !== undefined) {
              parsedSuccess = Boolean(parsed.success);
            } else if (parsed.error) {
              parsedSuccess = false;
            }
          } else if (toolResult && typeof toolResult === 'object') {
            if (toolResult.success !== undefined) {
              parsedSuccess = Boolean(toolResult.success);
            } else if (toolResult.error) {
              parsedSuccess = false;
            }
          }
        } catch {
          if (typeof toolResult === 'string' && /^(?:error|failed|exception)\b/i.test(toolResult.trim())) {
            parsedSuccess = false;
          }
        }
        stepRecord.success = parsedSuccess;
        stepRecord.result = toolResult;

        if (toolName === 'take_screenshot') {
          recentWindowLaunch = false;
        }

        if (abortSignal?.aborted) {
          return {
            finalAnswer: '🛑 Agent task was stopped by user request.',
            stepsExecuted,
            success: false,
            stopped: true,
          };
        }

        let midTaskInstruction = null;
        if (typeof pollUserQueue === 'function') {
          try {
            midTaskInstruction = pollUserQueue();
          } catch (err) {
            console.error('[Gemini Agent pollUserQueue Error]:', err);
          }
        }

        // Short-Circuit the Agent Loop (Optimization 4):
        // If the screenshot tool (or web capture) succeeded, immediately check if follow-up
        // analysis was explicitly requested in the prompt. If not, resolve immediately to avoid redundant LLM round-trips!
        if ((toolName === 'take_screenshot' || toolName === 'open_and_capture_webpage') && !midTaskInstruction) {
          let parsed;
          try { parsed = JSON.parse(toolResult); } catch {}
          if (parsed && parsed.success) {
            const explicitlyNeedsAnalysis =
              /\b(?:analyze|inspect|read|transcribe|explain|tell me what|check if there is an error|debug)\b/i.test(prompt);
            if (!explicitlyNeedsAnalysis) {
              const targetTitle = parsed.windowTitle || parsed.url || 'Target';
              console.log(`[PROFILER] Step: Short-circuiting agent loop after screenshot delivery (no further analysis requested).`);
              return {
                finalAnswer: `📸 *Screenshot of "${targetTitle}" captured and sent directly to Telegram.*`,
                stepsExecuted,
                success: true,
              };
            }
          }
        }

        if (midTaskInstruction && onStatusUpdate) {
          onStatusUpdate(`📥 *Received follow-up:* "${midTaskInstruction.slice(0, 45)}..."`);
        }

        if (onStatusUpdate) {
          onStatusUpdate('🧠 Processing with Gemini...');
        }

        const nextInput = [
          {
            type: 'function_result',
            name: toolName,
            call_id: functionCallStep.id,
            result: toolResult,
          },
        ];

        if (midTaskInstruction) {
          nextInput.push({
            type: 'text',
            text:
              `[USER MID-TASK FOLLOW-UP / PRIORITY INSTRUCTION]: "${midTaskInstruction}"\n` +
              `(The user provided this instruction while the previous tool was executing. Please address this instruction immediately, such as taking a screenshot, reporting progress, or adapting your plan.)`,
          });
        }

        // Send tool result back to the model
        const followUpLlmT0 = performance.now();
        currentResponse = await ai.interactions.create({
          model,
          previous_interaction_id: currentResponse.id,
          input: nextInput,
        });
        const followUpLlmDuration = Math.round(performance.now() - followUpLlmT0);
        console.log(`[PROFILER] Step: Gemini tool follow-up reasoning took ${followUpLlmDuration} ms`);
      }

      // If max steps reached, extract whatever output exists
      let finalAnswer = currentResponse.output_text || 'Completed maximum agent tool iterations.';
      finalAnswer = finalAnswer.replace(/(?:⚙️|🛠️)?\s*Executed Tools:[\s\S]*?(?=\n\n[#A-Z📁🎮]|$)/i, '').trim();

      let pendingFile = null;
      const codeBlockMatch = finalAnswer.match(/```(?:[a-zA-Z0-9_-]+)?\s*([\s\S]+?)```/);
      if (codeBlockMatch) {
        const codeContent = codeBlockMatch[1].trim();
        let detectedFilename = 'script.py';
        if (/import turtle|import pygame|def main/i.test(codeContent)) {
          detectedFilename = 'game.py';
        }
        const baseDir = userDirectory || STORAGE_DIR;
        pendingFile = {
          code: codeContent,
          filename: detectedFilename,
          suggestedPath: joinLaptopPath(baseDir, detectedFilename),
        };
      }

      return {
        finalAnswer,
        stepsExecuted,
        success: true,
        pendingFile,
      };
    } catch (err) {
      console.warn(`[Gemini Agent] Model ${model} failed:`, sanitizeError(err));
      lastError = err;
      // Loop to try next model in candidateModels
    }
  }

  throw lastError || new Error('All agent models failed.');
}

/**
 * Run Gemini Deep Research Agent (deep-research-preview-04-2026)
 *
 * @param {Object} options
 * @param {string} options.topic - Research topic
 * @param {Function} [options.onStatusUpdate] - Live status callback
 * @param {number} [options.timeoutMs=180000] - Timeout (default 3 mins)
 * @returns {Promise<{ report: string, interactionId: string }>}
 */
export async function runDeepResearchAgent({ topic, onStatusUpdate, timeoutMs = 180000 }) {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured in environment variables.');
  }

  const ai = new GoogleGenAI({ apiKey });

  if (onStatusUpdate) {
    onStatusUpdate('🔬 *Initiating Gemini Deep Research Agent...*');
  }

  const initial = await ai.interactions.create({
    agent: 'deep-research-preview-04-2026',
    input: topic,
    background: true,
  });

  const startTime = Date.now();
  let pollCount = 0;

  while (Date.now() - startTime < timeoutMs) {
    pollCount++;
    await new Promise((r) => setTimeout(r, 6000));

    const statusObj = await ai.interactions.get(initial.id);
    const status = statusObj.status;

    if (onStatusUpdate) {
      onStatusUpdate(`🔬 *Deep Research in progress (${pollCount * 6}s elapsed)... Status: ${status}*`);
    }

    if (status === 'completed') {
      return {
        report: statusObj.output_text || 'Research completed with no output text.',
        interactionId: initial.id,
      };
    }

    if (status === 'failed' || status === 'cancelled') {
      throw new Error(`Deep Research ended with status: ${status} - ${statusObj.error || 'Unknown error'}`);
    }
  }

  throw new Error('Deep Research timed out after ' + Math.round(timeoutMs / 1000) + ' seconds.');
}
