import { GoogleGenAI } from '@google/genai';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { searchWeb, searchYouTube, sanitizeError } from './search-service.js';
import {
  runLaptopCommand,
  readLaptopFile,
  writeLaptopFile,
  listLaptopDirectory,
  getLaptopStatus,
  requestLaptopApproval,
  captureLaptopScreenshot,
  listLaptopWindows,
  isLaptopConnected,
  joinLaptopPath,
  isPathAbsolute,
} from './laptop-bridge.js';

const STORAGE_DIR = process.env.STORAGE_DIR || process.cwd();
const PRIMARY_MODEL = process.env.GEMINI_AGENT_MODEL || 'gemini-3.5-flash-lite';
const FALLBACK_MODEL = 'gemini-3.8-flash';

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
    description: 'Capture a live screenshot of the user\'s laptop screen or a specific application window and send the photo directly to the user in Telegram. Use this whenever the user asks for a screenshot, wants to see their screen or desktop, or asks what is currently displayed on their PC.',
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
      },
    },
  },
  {
    type: 'function',
    name: 'run_laptop_terminal',
    description: 'Execute a terminal command (PowerShell / Command Prompt / Bash) on the user\'s physical laptop to install packages, run tests, fix code, inspect processes, or open interactive apps. CRITICAL: For interactive TUIs (like yazi, nano, vim) or applications meant to open on desktop, always launch in a visible GUI terminal: "start wt cmd /k \\"<command>\\"" or "start cmd /k \\"<command>\\""',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The terminal command line to execute (e.g. "npm install express", "python test.py", "git status"). For interactive TUIs (yazi, etc.), use "start cmd /k <cmd>" or "start wt cmd /k <cmd>".' },
        cwd: { type: 'string', description: 'Optional working directory path on the laptop (e.g. "D:\\projects\\my-app")' },
      },
      required: ['command'],
    },
  },
  {
    type: 'function',
    name: 'read_laptop_file',
    description: 'Read the contents of a file directly from the user\'s physical laptop filesystem.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Full or relative path to the file on the laptop (e.g. "D:\\projects\\app\\index.js")' },
        max_lines: { type: 'integer', description: 'Max lines to read (default 200)' },
      },
      required: ['file_path'],
    },
  },
  {
    type: 'function',
    name: 'write_laptop_file',
    description: 'Create, write, or patch a file directly on the user\'s physical laptop filesystem to fix bugs or update code.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Full path to the file on the laptop' },
        content: { type: 'string', description: 'The complete text/code content to write to the file' },
      },
      required: ['file_path', 'content'],
    },
  },
  {
    type: 'function',
    name: 'list_laptop_files',
    description: 'List files and directories directly on the user\'s physical laptop filesystem.',
    parameters: {
      type: 'object',
      properties: {
        dir_path: { type: 'string', description: 'Directory path to list on the laptop (e.g. "D:\\projects")' },
      },
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
    description: 'Get live hardware and system status of the user\'s physical laptop (CPU, memory, battery, hostname, platform).',
    parameters: {
      type: 'object',
      properties: {},
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
    const windowTitle = args.window_title || args.windowTitle || args.title || undefined;
    const caption = args.caption || undefined;
    try {
      // Allow newly launched GUI/TUI windows 1.5 seconds to paint on screen before snapping
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const res = await captureLaptopScreenshot(context.userId, { windowTitle, caption });
      if (res && res.success) {
        return JSON.stringify({
          success: true,
          message: `Screenshot of "${res.windowTitle}" successfully captured and sent directly to the user on Telegram.`,
          windowTitle: res.windowTitle,
          isDesktopFallback: res.isDesktopFallback,
        });
      }
      return JSON.stringify({ error: res?.error || 'Failed to capture screenshot.' });
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
    const effectiveCwd =
      args.cwd ||
      args.working_dir ||
      args.workingDirectory ||
      context.detectedWorkingDir ||
      undefined;
    try {
      const res = await runLaptopCommand(context.userId, command, effectiveCwd);
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
    const baseDir = context.detectedWorkingDir || context.userDirectory;
    const effectivePath = joinLaptopPath(baseDir, rawPath);
    const maxLines = args.max_lines || args.maxLines || args.lines || 300;
    try {
      const res = await readLaptopFile(context.userId, effectivePath, maxLines);
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
    const baseDir = context.detectedWorkingDir || context.userDirectory;
    const effectivePath = joinLaptopPath(baseDir, rawPath);
    try {
      const res = await writeLaptopFile(context.userId, effectivePath, content);
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
    const dirPath =
      args.dir_path ||
      args.dirPath ||
      args.directory ||
      args.path ||
      args.dir ||
      context.detectedWorkingDir ||
      context.userDirectory;
    if (!context.userId) {
      return JSON.stringify({ error: 'No Telegram User ID associated with this request.' });
    }
    try {
      const res = await listLaptopDirectory(context.userId, dirPath);
      return JSON.stringify(res);
    } catch (err) {
      return JSON.stringify({ error: err.message });
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
    try {
      const res = await getLaptopStatus(context.userId);
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

        // 2. Check Telegram Cloud Vault (always works on Render 24/7)
        const vaultFile = process.env.VAULT_FILE || path.resolve('./cloud_vault.json');
        if (fs.existsSync(vaultFile)) {
          try {
            const vaultData = JSON.parse(await fs.promises.readFile(vaultFile, 'utf8'));
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
        }

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

        // 2. Check Telegram Cloud Vault (for Render cloud deployments)
        const vaultFile = process.env.VAULT_FILE || path.resolve('./cloud_vault.json');
        if (fs.existsSync(vaultFile)) {
          try {
            const vaultData = JSON.parse(await fs.promises.readFile(vaultFile, 'utf8'));
            const entry = Array.isArray(vaultData)
              ? vaultData.find((v) => v.name.toLowerCase() === filename.toLowerCase())
              : null;

            if (entry && entry.file_id) {
              const token = process.env.TELEGRAM_BOT_TOKEN;
              if (token) {
                const infoRes = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${entry.file_id}`);
                const fileInfo = await infoRes.json();
                if (fileInfo?.ok && fileInfo.result?.file_path) {
                  const downRes = await fetch(`https://api.telegram.org/file/bot${token}/${fileInfo.result.file_path}`);
                  const arrayBuf = await downRes.arrayBuffer();
                  let textContent = '';

                  if (filename.toLowerCase().endsWith('.pdf')) {
                    try {
                      const { PDFParse } = await import('pdf-parse');
                      const parsed = await PDFParse(Buffer.from(arrayBuf));
                      textContent = parsed.text || '';
                    } catch (pdfErr) {
                      textContent = `[PDF extraction note: ${pdfErr.message}]`;
                    }
                  } else {
                    textContent = Buffer.from(arrayBuf).toString('utf8');
                  }

                  const lines = textContent.split('\n').slice(0, maxLines).join('\n');
                  return JSON.stringify({
                    filename,
                    source: 'telegram_cloud_vault',
                    content: lines,
                  });
                }
              }
            }
          } catch (cloudErr) {
            console.warn('[Gemini Agent] Cloud vault file fetch error:', cloudErr.message);
          }
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

    case 'run_laptop_terminal': {
      const { command, cwd } = args;
      if (!context.userId) {
        return JSON.stringify({ error: 'No Telegram User ID associated with this request.' });
      }
      const effectiveCwd = cwd || undefined;
      try {
        const res = await runLaptopCommand(context.userId, command, effectiveCwd);
        return JSON.stringify(res);
      } catch (err) {
        return JSON.stringify({ error: err.message });
      }
    }

    case 'read_laptop_file': {
      const rawPath = args.file_path || args.filename;
      if (!context.userId) {
        return JSON.stringify({ error: 'No Telegram User ID associated with this request.' });
      }
      const effectivePath = joinLaptopPath(context.userDirectory, rawPath);
      try {
        const res = await readLaptopFile(context.userId, effectivePath, args.max_lines);
        return JSON.stringify(res);
      } catch (err) {
        return JSON.stringify({ error: err.message });
      }
    }

    case 'write_laptop_file': {
      const rawPath = args.file_path || args.filename;
      const content = args.content;
      if (!context.userId) {
        return JSON.stringify({ error: 'No Telegram User ID associated with this request.' });
      }
      const effectivePath = joinLaptopPath(context.userDirectory, rawPath);
      try {
        const res = await writeLaptopFile(context.userId, effectivePath, content);
        return JSON.stringify(res);
      } catch (err) {
        return JSON.stringify({ error: err.message });
      }
    }

    case 'list_laptop_files': {
      const dirPath = args.dir_path || args.path || context.userDirectory;
      if (!context.userId) {
        return JSON.stringify({ error: 'No Telegram User ID associated with this request.' });
      }
      try {
        const res = await listLaptopDirectory(context.userId, dirPath);
        return JSON.stringify(res);
      } catch (err) {
        return JSON.stringify({ error: err.message });
      }
    }

    case 'get_laptop_status': {
      if (!context.userId) {
        return JSON.stringify({ error: 'No Telegram User ID associated with this request.' });
      }
      try {
        const res = await getLaptopStatus(context.userId);
        return JSON.stringify(res);
      } catch (err) {
        return JSON.stringify({ error: err.message });
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
}) {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured in environment variables.');
  }

  const ai = new GoogleGenAI({ apiKey });
  const stepsExecuted = [];

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

  const effectiveTargetDir = detectedWorkingDir || userDirectory || 'default working directory';

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
        onStatusUpdate(`🤖 *Agent reasoning with ${model}...*`);
      }

      let currentResponse = await ai.interactions.create({
        model,
        input: inputPrompt,
        tools: AGENT_TOOLS,
        system_instruction:
          'You are an autonomous AI Agent in Telegram with direct tool access to the user\'s physical laptop.\n' +
          `User\'s target folder on their laptop: "${effectiveTargetDir}".\n\n` +
          'CRITICAL EXECUTION AND GROUNDING RULES:\n' +
          '1. PHYSICAL FILESYSTEM REALITY: Text output in chat CANNOT create or save files on the user\'s laptop. The ONLY way to save or create a file is by executing the `write_laptop_file(file_path, content)` tool. If the user asks to save, create, or write a file, you MUST call `write_laptop_file`.\n' +
          '2. OFFICIAL TOOL NAMES:\n' +
          '   • list_open_windows: Enumerate open application and browser windows on user\'s laptop\n' +
          '   • take_screenshot: Capture laptop screen or app window and deliver photo directly to user on Telegram (window_title, caption). ALWAYS use this when the user asks for a screenshot, screen capture, or to see their desktop/screen.\n' +
          '   • run_laptop_terminal: Execute shell commands on laptop (e.g. git status, git add, git commit, git push, npm test, python script.py)\n' +
          '   • read_laptop_file: Read files on laptop (file_path, max_lines)\n' +
          '   • write_laptop_file: Write or overwrite files on laptop (file_path, content)\n' +
          '   • list_laptop_files: List files in a directory (dir_path)\n' +
          '   • get_laptop_status: Inspect laptop hardware specs\n' +
          '   • search_web: Search Google for documentation or solutions\n' +
          '   • request_laptop_approval: Request user approval when installer or confirmation dialog is displayed\n' +
          '3. SCREENSHOT RULE: To take a screenshot, NEVER attempt to run custom PowerShell or Python screenshot scripts in run_laptop_terminal. Always call `take_screenshot`.\n' +
          '4. FULL MULTI-STEP WORKFLOWS: When requested to edit a file and push to Git:\n' +
          '   a. Read or verify target file via `read_laptop_file`\n' +
          '   b. Write the complete updated content via `write_laptop_file`\n' +
          '   c. Execute git operations via `run_laptop_terminal(command="git add . && git commit -m ... && git push", cwd="' + effectiveTargetDir + '")`\n' +
          '   d. Report the outcome with commit details in your final answer.\n' +
          '5. TARGET PATH RESOLUTION: If the user provides a path (e.g. "' + effectiveTargetDir + '"), ALWAYS use that directory path for commands and file operations.\n' +
          '6. ZERO FAKE TOOLS: NEVER simulate tool execution in markdown text. Always call actual tools.\n' +
          '7. DISCONNECTED STATE: If a tool reports the laptop is disconnected, explain clearly and provide the complete code so the user can save it manually.\n' +
          '8. TELEGRAM FORMATTING & DIRECTNESS: Do NOT use raw markdown headers (###) or horizontal divider lines (---). If you need headings, use *Bold text* on its own line. Use clean bullet points (•). Be direct, concise, and avoid repetitive padding.\n' +
          '9. TEMPORAL REALITY (2026): The current year is 2026. Models Gemini 3.8 Flash, 3.5 Flash, 3.5 Flash-Lite are official Google models released in 2025–2026.\n\n' +
          '10. APP INSTALLATION & SCREENSHOT WORKFLOWS:\n' +
          '    When the user asks to install, launch, or screenshot an application (e.g. "install yazi, open it and take a screenshot", or "open roblox and screenshot it"):\n' +
          '    a. Install: Use `run_laptop_terminal` with winget or package manager (e.g. `winget install --id sxyazi.yazi -e --accept-package-agreements --accept-source-agreements --silent`).\n' +
          '    b. Launch: Interactive TUIs (like Yazi) or terminal programs CANNOT run in headless background subprocesses. You MUST launch them in a visible GUI terminal window via `run_laptop_terminal(command="start cmd /k yazi")` or `start wt cmd /k yazi`. For GUI desktop apps, use `run_laptop_terminal(command="start <app_name>")` (e.g. `start roblox:`, `start brave`).\n' +
          '    c. Verify & Capture: Call `take_screenshot(window_title="yazi")` or `take_screenshot(window_title="Roblox")`. The system will automatically allow 1.5 seconds for the window to paint, bring it to the foreground, and deliver the screenshot directly to Telegram.',
      });

      let stepCount = 0;

      while (stepCount < maxSteps) {
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
        stepsExecuted.push({ name: toolName, args: toolArgs });

        if (onStatusUpdate) {
          const argsSummary = Object.values(toolArgs).map(v => typeof v === 'string' ? `"${v.slice(0, 30)}"` : v).join(', ');
          onStatusUpdate(`⚙️ *Executing tool:* \`${toolName}(${argsSummary})\`...`);
        }

        const toolResult = await executeTool(toolName, toolArgs, {
          userId,
          userDirectory,
          detectedWorkingDir,
          prompt,
        });

        if (onStatusUpdate) {
          onStatusUpdate(`🧠 *Analyzing results from ${toolName}...*`);
        }

        // Send tool result back to the model
        currentResponse = await ai.interactions.create({
          model,
          previous_interaction_id: currentResponse.id,
          input: [
            {
              type: 'function_result',
              name: toolName,
              call_id: functionCallStep.id,
              result: toolResult,
            },
          ],
        });
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
