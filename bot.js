import 'dotenv/config';
import { Bot, InlineKeyboard, InputFile } from 'grammy';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
import { PDFParse } from 'pdf-parse';
import fs from 'fs';
import { promises as fsp } from 'fs';
import path from 'path';
import http from 'http';
import os from 'os';
import crypto from 'crypto';

import {
  getFileCategory,
  FILE_CATEGORIES,
  searchWeb,
  searchYouTube,
  cleanupTemporaryCookies,
} from './search-service.js';

import {
  initSearchHistory,
  addSearchHistoryEntry,
  getAllSearchHistory,
  getSearchHistoryPage,
  getSearchHistoryEntry,
  deleteSearchHistoryEntry,
  clearAllSearchHistory,
} from './history-service.js';

import {
  executeGeminiLiveExchange,
  AVAILABLE_VOICES,
  getUserVoice,
  setUserVoice,
  isUserLiveModeEnabled,
  setUserLiveMode,
} from './gemini-live-service.js';
import { setupLiveCallServer } from './live-call-server.js';
import {
  runGeminiAgent,
  runDeepResearchAgent,
} from './gemini-agent-service.js';
import {
  setupLaptopBridge,
  setBotApi,
  isLaptopConnected,
  getConnectedLaptopsList,
  getAllConnectedLaptops,
} from './laptop-bridge.js';

const userAgentMode = new Map(); // userId -> boolean

const STORAGE_DIR = process.env.STORAGE_DIR || 'D:\\drive-download-20260715T073323Z-1-001';
const VAULT_FILE = process.env.VAULT_FILE || path.resolve('./cloud_vault.json');
const CONVERSATION_HISTORY_FILE = process.env.CONVERSATION_HISTORY_FILE || path.resolve('./conversation_history.json');
const TEMP_DOWNLOADS_DIR = path.resolve('./temp_downloads');

const PORT = parseInt(process.env.PORT, 10) || 10000;

// Robust extraction of all allowed Telegram IDs from ALLOWED_USER_IDS and/or ALLOWED_USER_ID
// Handles comma-separated, space-separated, quotes, brackets, and multiple variables
const combinedAllowedRaw = [process.env.ALLOWED_USER_IDS, process.env.ALLOWED_USER_ID]
  .filter(Boolean)
  .join(',');
const allowedIdMatches = combinedAllowedRaw.match(/-?\d+/g) || [];
const allowedUserIds = new Set(allowedIdMatches.map((id) => parseInt(id, 10)));

// Primary user ID for admin/vault backup operations (defaults to the first ID in the list)
const allowedUserId = allowedUserIds.values().next().value || null;

console.log(`[Config] Authorized Telegram User IDs configured (${allowedUserIds.size} user(s) authorized)`);
if (allowedUserIds.size === 0) {
  console.warn('⚠️ WARNING: No valid ALLOWED_USER_ID configured! All incoming messages will be rejected.');
}

function getPublicBotUrl(req) {
  if (process.env.SERVER_URL && process.env.SERVER_URL.trim()) {
    return process.env.SERVER_URL.trim().replace(/\/+$/, '');
  }
  if (process.env.RENDER_EXTERNAL_URL && process.env.RENDER_EXTERNAL_URL.trim()) {
    return process.env.RENDER_EXTERNAL_URL.trim().replace(/\/+$/, '');
  }
  if (req && req.headers && req.headers.host) {
    const proto = req.headers['x-forwarded-proto'] || 'https';
    return `${proto}://${req.headers.host}`;
  }
  return 'https://telegram-ai-bot-znei.onrender.com';
}

function generateStartAgentBat({ userId, serverUrl }) {
  return `@echo off
title Telegram AI Laptop Agent Runner
cd /d "%~dp0"
cls
echo ========================================================
echo   Starting Telegram AI Remote Laptop Agent Runner...
echo ========================================================
echo.

where node >nul 2>nul
if %errorlevel% neq 0 (
  echo [ERROR] Node.js is not installed or not in PATH!
  echo Opening https://nodejs.org to download Node.js LTS...
  start https://nodejs.org/
  pause
  exit /b 1
)

set "SERVER_URL=${serverUrl}"
set "USER_ID=${userId}"

if not exist laptop-runner.js (
  echo [INFO] Downloading laptop-runner.js from cloud server...
  powershell -Command "Invoke-WebRequest -Uri '%SERVER_URL%/download/laptop-runner.js' -OutFile 'laptop-runner.js'"
)

if not exist node_modules\\ws (
  echo [INFO] Installing required dependencies (ws, dotenv)...
  call npm install ws dotenv
)

node laptop-runner.js --user %USER_ID% --server %SERVER_URL% %*
if %errorlevel% neq 0 (
  echo.
  echo [ERROR] Runner stopped with error code %errorlevel%.
  pause
)
`;
}

const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    // 1. Download latest laptop-runner.js
    if (pathname === '/download/laptop-runner.js') {
      const runnerPath = path.resolve('./laptop-runner.js');
      if (fs.existsSync(runnerPath)) {
        res.writeHead(200, {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Content-Disposition': 'attachment; filename="laptop-runner.js"',
          'Cache-Control': 'no-cache',
        });
        return fs.createReadStream(runnerPath).pipe(res);
      }
    }

    // 2. Download personalized start-agent.bat
    if (pathname === '/download/start-agent.bat' || pathname.startsWith('/download/start-agent')) {
      const uid = url.searchParams.get('userId') || allowedUserId || '';
      const serverUrl = getPublicBotUrl(req);
      const batContent = generateStartAgentBat({ userId: uid, serverUrl });

      res.writeHead(200, {
        'Content-Type': 'application/x-bat',
        'Content-Disposition': 'attachment; filename="start-agent.bat"',
        'Cache-Control': 'no-cache',
      });
      return res.end(batContent);
    }

    // 3. PowerShell One-Line Setup Script: /setup/:userId.ps1 or /setup.ps1?userId=...
    const setupPs1Match = pathname.match(/^\/setup(?:\/(-?\d+))?\.ps1$/i);
    if (setupPs1Match || pathname === '/setup.ps1') {
      const uid = (setupPs1Match && setupPs1Match[1]) || url.searchParams.get('userId') || allowedUserId || '';
      const serverUrl = getPublicBotUrl(req);
      const ps1Content =
`# Telegram AI Laptop Agent Setup
$ErrorActionPreference = 'Stop'
$targetUserId = "${uid}"
$serverUrl = "${serverUrl}"
$agentDir = Join-Path $HOME "telegram-ai-agent"

Write-Host "========================================================" -ForegroundColor Cyan
Write-Host " 💻 Setting Up Telegram AI Laptop Agent (User: $targetUserId)" -ForegroundColor Cyan
Write-Host "========================================================" -ForegroundColor Cyan

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "[ERROR] Node.js is not installed on this laptop!" -ForegroundColor Red
    Write-Host "Please install Node.js from https://nodejs.org" -ForegroundColor Yellow
    Start-Process "https://nodejs.org"
    return
}

if (-not (Test-Path $agentDir)) {
    New-Item -ItemType Directory -Path $agentDir -Force | Out-Null
}
Set-Location $agentDir

Write-Host "[1/3] Downloading latest laptop-runner.js..." -ForegroundColor Gray
Invoke-WebRequest -Uri "$serverUrl/download/laptop-runner.js" -OutFile (Join-Path $agentDir "laptop-runner.js")

Write-Host "[2/3] Downloading start-agent.bat..." -ForegroundColor Gray
Invoke-WebRequest -Uri "$serverUrl/download/start-agent.bat?userId=$targetUserId" -OutFile (Join-Path $agentDir "start-agent.bat")

if (-not (Test-Path (Join-Path $agentDir "node_modules/ws"))) {
    Write-Host "[3/3] Installing dependencies (ws, dotenv)..." -ForegroundColor Gray
    npm install ws dotenv --no-audit --no-fund
}

Write-Host "\`n✅ Setup complete! Launching laptop agent..." -ForegroundColor Green
node (Join-Path $agentDir "laptop-runner.js") --user $targetUserId --server $serverUrl
`;

      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      return res.end(ps1Content);
    }
  } catch (err) {
    console.warn('[HTTP Server] Route handler error:', err.message);
  }

  // Always return 200 OK for any path (/, /health, /health/, /healthz, etc.) so Render health checks always pass
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-cache',
    'Connection': 'close',
  });
  res.end(JSON.stringify({
    status: 'ok',
    bot: 'running',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[HTTP Server] Health check server immediately listening on 0.0.0.0:${PORT}`);
  let liveCallWss = null;
  let laptopWss = null;
  try {
    liveCallWss = setupLiveCallServer(server);
  } catch (liveServerErr) {
    console.warn('[Live Call Server] Warning attaching live call server:', liveServerErr.message);
  }
  try {
    laptopWss = setupLaptopBridge(server, allowedUserIds);
  } catch (bridgeErr) {
    console.warn('[Laptop Bridge] Warning attaching laptop bridge server:', bridgeErr.message);
  }

  // Unified HTTP upgrade router: prevents 400 Bad Request conflicts between multiple WebSocket endpoints
  server.on('upgrade', (request, socket, head) => {
    try {
      const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
      const pathname = url.pathname;

      if (pathname === '/ws/live-call' && liveCallWss) {
        liveCallWss.handleUpgrade(request, socket, head, (ws) => {
          liveCallWss.emit('connection', ws, request);
        });
      } else if (pathname === '/ws/laptop-agent' && laptopWss) {
        laptopWss.handleUpgrade(request, socket, head, (ws) => {
          laptopWss.emit('connection', ws, request);
        });
      } else {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
      }
    } catch (err) {
      console.warn('[HTTP Server] Upgrade error:', err.message);
      try {
        socket.destroy();
      } catch {}
    }
  });
});

try {
  if (!fs.existsSync(STORAGE_DIR)) {
    fs.mkdirSync(STORAGE_DIR, { recursive: true });
  }
  if (!fs.existsSync(TEMP_DOWNLOADS_DIR)) {
    fs.mkdirSync(TEMP_DOWNLOADS_DIR, { recursive: true });
  } else {
    // Purge orphaned temporary files from previous runs
    fsp.readdir(TEMP_DOWNLOADS_DIR).then((files) => {
      for (const f of files) {
        fsp.unlink(path.join(TEMP_DOWNLOADS_DIR, f)).catch(() => {});
      }
    }).catch(() => {});
  }
} catch (dirErr) {
  console.warn('Storage directory initialization note:', sanitizeError(dirErr));
}

const telegramToken = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
if (!telegramToken) {
  console.error('❌ FATAL: TELEGRAM_BOT_TOKEN is missing or empty in environment variables!');
  console.error('Please configure TELEGRAM_BOT_TOKEN in your hosting provider settings (e.g. Render dashboard).');
  process.exit(1);
}

const bot = new Bot(telegramToken);
setBotApi(bot.api);

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  ...(process.env.ANTHROPIC_BASE_URL ? { baseURL: process.env.ANTHROPIC_BASE_URL } : {}),
});

const anthropicModel =
  process.env.ANTHROPIC_MODEL ||
  (process.env.ANTHROPIC_BASE_URL && !process.env.ANTHROPIC_BASE_URL.includes('anthropic.com')
    ? 'claude-sonnet-5-5'
    : 'claude-3-7-sonnet-20250219');

const ANTHROPIC_MAX_TOKENS = parseInt(process.env.ANTHROPIC_MAX_TOKENS, 10) || 20000;

const googleAI = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
});

const conversationHistory = new Map();
const userLastDocument = new Map();
const userLastInteraction = new Map(); // userId -> timestamp of last message/activity
const DOC_SESSION_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes active document session TTL
const CONVERSATION_SESSION_TIMEOUT_HOURS = parseFloat(process.env.CONVERSATION_SESSION_TIMEOUT_HOURS) || 24;
const CONVERSATION_SESSION_TIMEOUT_MS = CONVERSATION_SESSION_TIMEOUT_HOURS * 60 * 60 * 1000; // 24 hours chat session TTL
const MAX_HISTORY_MESSAGES = parseInt(process.env.MAX_HISTORY_MESSAGES, 10) || 50; // up to 25 full conversation turns

const USER_SETTINGS_FILE = process.env.USER_SETTINGS_FILE || path.resolve('./user_settings.json');
const userStorageMode = new Map(); // userId -> 'local' (default: dual save), 'cloud' (cloud only), 'nosave' (local only)
const userLocalStorageDir = new Map(); // userId -> string folder path on laptop
const userAwaitingDirectoryInput = new Set(); // Set of userIds awaiting text path input

let persistUserSettingsTimer = null;
function scheduleUserSettingsPersistence() {
  if (persistUserSettingsTimer) return;
  persistUserSettingsTimer = setTimeout(async () => {
    persistUserSettingsTimer = null;
    await persistUserSettings();
  }, 1000).unref();
}

async function persistUserSettings() {
  try {
    const storageDirs = {};
    for (const [uid, dir] of userLocalStorageDir.entries()) {
      storageDirs[uid] = dir;
    }
    const storageModes = {};
    for (const [uid, mode] of userStorageMode.entries()) {
      storageModes[uid] = mode;
    }
    const tempFile = `${USER_SETTINGS_FILE}.tmp`;
    await fsp.writeFile(tempFile, JSON.stringify({ version: 1, storageDirs, storageModes }, null, 2), 'utf-8');
    await fsp.rename(tempFile, USER_SETTINGS_FILE);
  } catch (err) {
    console.warn('[User Settings] Failed to persist user_settings.json:', sanitizeError(err));
  }
}

async function initUserSettings() {
  try {
    if (fs.existsSync(USER_SETTINGS_FILE)) {
      const raw = await fsp.readFile(USER_SETTINGS_FILE, 'utf-8');
      const data = JSON.parse(raw);
      if (data.storageDirs && typeof data.storageDirs === 'object') {
        for (const [uid, dir] of Object.entries(data.storageDirs)) {
          userLocalStorageDir.set(Number(uid), dir);
        }
      }
      if (data.storageModes && typeof data.storageModes === 'object') {
        for (const [uid, mode] of Object.entries(data.storageModes)) {
          userStorageMode.set(Number(uid), mode);
        }
      }
      console.log(`[User Settings] Initialized settings for ${userLocalStorageDir.size} user directories, ${userStorageMode.size} storage modes.`);
    }
  } catch (err) {
    console.warn('[User Settings] Failed to load user_settings.json:', sanitizeError(err));
  }
}

function getUserStorageDir(userId) {
  const uid = Number(userId);
  if (userLocalStorageDir.has(uid)) {
    return userLocalStorageDir.get(uid);
  }
  // Default fallback for primary user (first configured ID in ALLOWED_USER_IDS)
  if (uid === Number(allowedUserId) && process.env.STORAGE_DIR) {
    return process.env.STORAGE_DIR;
  }
  return null;
}

function setUserStorageDir(userId, dirPath) {
  const uid = Number(userId);
  const clean = dirPath.trim().replace(/^["']|["']$/g, '');
  userLocalStorageDir.set(uid, clean);
  scheduleUserSettingsPersistence();
}

function getUserStorageMode(userId) {
  return userStorageMode.get(Number(userId)) || 'local';
}

function setUserStorageMode(userId, mode) {
  userStorageMode.set(Number(userId), mode);
  scheduleUserSettingsPersistence();
}

const userActiveMode = new Map(); // userId -> { mode: 'search'|'youtube'|'download'|'image', timestamp: number }
const MODE_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes active command mode TTL
const userCachedFilesList = new Map(); // userId -> array of cached library files
const botStartTime = Date.now();

let persistConversationHistoryTimer = null;

function scheduleConversationHistoryPersistence() {
  if (persistConversationHistoryTimer) return;
  persistConversationHistoryTimer = setTimeout(async () => {
    persistConversationHistoryTimer = null;
    await persistConversationHistory();
  }, 1000).unref();
}

function serializeHistoryForDisk(history) {
  if (!Array.isArray(history)) return [];
  return history.slice(-MAX_HISTORY_MESSAGES).map((msg) => {
    if (typeof msg.content === 'string') {
      return { role: msg.role, content: msg.content };
    }
    if (Array.isArray(msg.content)) {
      const textChunks = [];
      for (const part of msg.content) {
        if (part && part.type === 'text' && part.text) {
          textChunks.push(part.text);
        } else if (part && part.type === 'image') {
          textChunks.push('[Attached image previously analyzed in chat]');
        }
      }
      return { role: msg.role, content: textChunks.join('\n\n') || '[Attached content]' };
    }
    return { role: msg.role, content: String(msg.content || '') };
  });
}

async function persistConversationHistory() {
  try {
    const sessionsObj = {};
    const now = Date.now();
    for (const [userId, history] of conversationHistory.entries()) {
      const lastActive = userLastInteraction.get(userId) || now;
      if (now - lastActive > CONVERSATION_SESSION_TIMEOUT_MS) {
        continue;
      }
      if (Array.isArray(history) && history.length > 0) {
        sessionsObj[userId] = {
          lastInteraction: lastActive,
          history: serializeHistoryForDisk(history),
        };
      }
    }
    const tempFile = `${CONVERSATION_HISTORY_FILE}.tmp`;
    await fsp.writeFile(tempFile, JSON.stringify({ version: 1, sessions: sessionsObj }, null, 2), 'utf-8');
    await fsp.rename(tempFile, CONVERSATION_HISTORY_FILE);
  } catch (err) {
    console.warn('Failed to persist conversation_history.json:', sanitizeError(err));
  }
}

function persistConversationHistorySync() {
  try {
    const sessionsObj = {};
    const now = Date.now();
    for (const [userId, history] of conversationHistory.entries()) {
      const lastActive = userLastInteraction.get(userId) || now;
      if (now - lastActive > CONVERSATION_SESSION_TIMEOUT_MS) {
        continue;
      }
      if (Array.isArray(history) && history.length > 0) {
        sessionsObj[userId] = {
          lastInteraction: lastActive,
          history: serializeHistoryForDisk(history),
        };
      }
    }
    fs.writeFileSync(CONVERSATION_HISTORY_FILE, JSON.stringify({ version: 1, sessions: sessionsObj }, null, 2), 'utf-8');
  } catch (err) {
    console.warn('Failed to write conversation_history.json on shutdown:', sanitizeError(err));
  }
}

async function initConversationHistory() {
  try {
    if (fs.existsSync(CONVERSATION_HISTORY_FILE)) {
      const raw = await fsp.readFile(CONVERSATION_HISTORY_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      const sessions = parsed?.sessions || parsed;
      if (sessions && typeof sessions === 'object') {
        const now = Date.now();
        let loadedCount = 0;
        for (const [userIdStr, sessionData] of Object.entries(sessions)) {
          const uId = Number(userIdStr);
          if (!uId) continue;
          const lastActive = sessionData?.lastInteraction || 0;
          if (now - lastActive > CONVERSATION_SESSION_TIMEOUT_MS) {
            continue;
          }
          const hist = Array.isArray(sessionData.history) ? sessionData.history : [];
          if (hist.length > 0) {
            while (hist.length > 0 && hist[0].role !== 'user') {
              hist.shift();
            }
            if (hist.length > 0) {
              conversationHistory.set(uId, hist);
              userLastInteraction.set(uId, lastActive);
              loadedCount++;
            }
          }
        }
        console.log(`Loaded conversation history for ${loadedCount} active user(s) from disk.`);
      }
    }
  } catch (err) {
    console.warn('Could not read conversation_history.json:', sanitizeError(err));
  }
}

// Periodic background memory sweeper to prune stale sessions (unref'd so process exits cleanly)
const SESSION_SWEEPER_INTERVAL_MS = 15 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  let historyChanged = false;
  for (const [userId, lastTime] of userLastInteraction.entries()) {
    if (now - lastTime > CONVERSATION_SESSION_TIMEOUT_MS) {
      conversationHistory.delete(userId);
      userLastDocument.delete(userId);
      userCachedFilesList.delete(userId);
      userActiveMode.delete(userId);
      userLastInteraction.delete(userId);
      historyChanged = true;
    }
  }
  for (const [userId, active] of userActiveMode.entries()) {
    if (active.timestamp && now - active.timestamp > MODE_TIMEOUT_MS) {
      userActiveMode.delete(userId);
    }
  }
  if (historyChanged) {
    scheduleConversationHistoryPersistence();
  }
}, SESSION_SWEEPER_INTERVAL_MS).unref();

// Robust per-user message debouncer and concurrency queue
// Eliminates duplicate replies, handles multi-part message bursts (text + photo + comment),
// and guarantees atomic single-turn execution per user.
const userQueues = new Map();
const DEBOUNCE_DELAY_MS = 2000;

function getUserQueue(userId) {
  let q = userQueues.get(userId);
  if (!q) {
    q = {
      items: [],
      activeDownloads: 0,
      timer: null,
      isProcessing: false,
      latestCtx: null,
    };
    userQueues.set(userId, q);
  }
  return q;
}

function registerPendingDownload(userId, ctx) {
  const q = getUserQueue(userId);
  q.activeDownloads++;
  q.latestCtx = ctx;

  // Clear existing timer so it doesn't fire while media is downloading
  if (q.timer) {
    clearTimeout(q.timer);
    q.timer = null;
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    q.activeDownloads = Math.max(0, q.activeDownloads - 1);
    // Media finished downloading, reset debounce window for any follow-up text
    scheduleDebounce(userId);
  };
}

function enqueueUserMessage(userId, item, ctx) {
  const q = getUserQueue(userId);
  q.items.push(item);
  q.latestCtx = ctx;

  scheduleDebounce(userId);
}

function scheduleDebounce(userId) {
  const q = getUserQueue(userId);

  if (q.timer) {
    clearTimeout(q.timer);
    q.timer = null;
  }

  q.timer = setTimeout(async () => {
    q.timer = null;
    await triggerUserQueueExecution(userId);
  }, DEBOUNCE_DELAY_MS);
}

async function triggerUserQueueExecution(userId) {
  const q = getUserQueue(userId);

  // If there are media downloads still in progress, wait for them
  if (q.activeDownloads > 0) {
    scheduleDebounce(userId);
    return;
  }

  // If Claude is currently generating a response for this user, do NOT fire a parallel turn.
  // The items remain buffered in q.items and will be executed when the current turn finishes.
  if (q.isProcessing) {
    return;
  }

  // If there are no items to process, nothing to do
  if (q.items.length === 0) {
    return;
  }

  // Atomically grab all pending items and mark processing
  const itemsToProcess = q.items.splice(0);
  const ctx = q.latestCtx;
  q.isProcessing = true;

  try {
    await processUserBatch(userId, itemsToProcess, ctx);
  } catch (err) {
    console.error(`Error processing user message batch for ${userId}:`, sanitizeError(err));
  } finally {
    q.isProcessing = false;
    if (q.items.length === 0) {
      q.latestCtx = null;
    }

    // After completing the turn, check if subsequent messages arrived while Claude was responding
    if (q.activeDownloads > 0) {
      scheduleDebounce(userId);
    } else if (q.items.length > 0) {
      if (q.timer) {
        // Debounce timer is still ticking down from a recent incoming message
      } else {
        // Debounce period already completed while Claude was generating; trigger next turn immediately
        triggerUserQueueExecution(userId).catch((err) => {
          console.error(`Error in chained user queue execution for ${userId}:`, sanitizeError(err));
        });
      }
    } else {
      if (!q.timer && q.activeDownloads === 0) {
        userQueues.delete(userId);
      }
    }
  }
}

function clearUserQueue(userId) {
  const q = userQueues.get(userId);
  if (q) {
    if (q.timer) {
      clearTimeout(q.timer);
      q.timer = null;
    }
    q.items = [];
    q.latestCtx = null;
    if (!q.isProcessing && q.activeDownloads === 0) {
      userQueues.delete(userId);
    }
  }
}

async function processUserBatch(userId, items, ctx) {
  if (!items || items.length === 0) return;

  const photoItems = items.filter((it) => it.type === 'photo');
  const textItems = items.filter((it) => it.type === 'text');

  if (photoItems.length > 0) {
    // Media query: immediately clear any active document so it never contaminates visual queries
    userLastDocument.delete(userId);

    const textParts = [];
    let photoIndex = 0;
    const totalPhotos = photoItems.length;

    // Traverse all items in the exact chronological order received
    for (const item of items) {
      if (item.type === 'text') {
        const trimmed = (item.text || '').trim();
        if (trimmed) {
          textParts.push(trimmed);
        }
      } else if (item.type === 'photo') {
        photoIndex++;
        const caption = (item.caption || '').trim();
        if (caption) {
          if (totalPhotos > 1) {
            textParts.push(`[Image ${photoIndex} note: ${caption}]`);
          } else {
            textParts.push(caption);
          }
        }
      }
    }

    let promptText = textParts.join('\n\n').trim();
    if (!promptText) {
      promptText =
        totalPhotos > 1
          ? 'Please inspect and analyze these images or screenshots in detail. Describe what you see, transcribe any visible text or code, and answer any apparent questions.'
          : 'Please inspect and analyze this image or screenshot in detail. Describe what you see, transcribe any visible text or code, and answer any apparent questions.';
    }

    // Build multimodal content array: image blocks followed by the prompt text block
    const multimodalContent = [];
    for (const photo of photoItems) {
      multimodalContent.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: photo.mimeType || 'image/jpeg',
          data: photo.base64Data,
        },
      });
    }

    multimodalContent.push({
      type: 'text',
      text: promptText,
    });

    await sendToClaudeWithHistory(ctx, multimodalContent);
  } else {
    // Text-only batch: join all texts chronologically
    const combinedText = textItems
      .map((t) => (t.text || '').trim())
      .filter(Boolean)
      .join('\n\n');

    if (combinedText) {
      if (isUserLiveModeEnabled(userId)) {
        await handleLiveVoiceReply(ctx, combinedText);
      } else if (userAgentMode.get(userId)) {
        await handleAgentCommand(ctx, combinedText);
      } else {
        await sendToClaudeWithHistory(ctx, combinedText);
      }
    }
  }
}

async function handleLiveVoiceReply(ctx, textPrompt) {
  const userId = ctx.from.id;
  const userVoice = getUserVoice(userId);

  const statusMsg = await ctx.reply(`🎙️ *Gemini 3.8 Live speaking (${userVoice})...*`, {
    parse_mode: 'Markdown',
  });

  const typingInterval = setInterval(() => {
    ctx.replyWithChatAction('record_voice').catch(() => {});
  }, 4000);

  try {
    const result = await executeGeminiLiveExchange({
      text: textPrompt,
      voice: userVoice,
    });

    clearInterval(typingInterval);
    await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});

    if (result.voiceBuffer) {
      await ctx.replyWithVoice(new InputFile(result.voiceBuffer, 'gemini_live.ogg'), {
        caption: result.replyText ? `🎙️ *Gemini 3.8 Live (${userVoice}):*\n${result.replyText}` : undefined,
        parse_mode: 'Markdown',
      });
    } else {
      await ctx.reply(
        `🎙️ *Gemini 3.8 Live (${userVoice}):*\n${result.replyText || 'Response received.'}`,
        { parse_mode: 'Markdown' }
      );
    }

    // Persist to conversation history
    const history = conversationHistory.get(userId) || [];
    history.push({ role: 'user', content: textPrompt });
    history.push({ role: 'assistant', content: result.replyText || '[Voice Note Reply]' });
    conversationHistory.set(userId, history);
    scheduleConversationHistoryPersistence();
  } catch (err) {
    clearInterval(typingInterval);
    console.error('[Gemini Live Voice Error]:', sanitizeError(err));
    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      `⚠️ *Gemini Live Notice:*\n${err.message || 'Connection error'}\n\n` +
      `💡 Note: Check your Gemini API key or quota at Google AI Studio.\n\n` +
      `Send /cancel anytime to return to standard Claude chat.`,
      { parse_mode: 'Markdown' }
    ).catch(() => {});
  }
}

async function handleAgentCommand(ctx, prompt) {
  const userId = ctx.from.id;
  const statusMsg = await ctx.reply('🤖 *Gemini Agent initialized...*', { parse_mode: 'Markdown' });
  let lastEditTime = Date.now();

  const updateStatus = async (statusText) => {
    if (Date.now() - lastEditTime > 900) {
      lastEditTime = Date.now();
      try {
        await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, statusText, {
          parse_mode: 'Markdown',
        });
      } catch {}
    }
  };

  const userDirectory = getUserStorageDir(userId);

  try {
    const result = await runGeminiAgent({
      prompt,
      userId,
      userDirectory,
      onStatusUpdate: (text) => updateStatus(text),
    });

    await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});

    let reply = result.finalAnswer;
    if (result.stepsExecuted && result.stepsExecuted.length > 0) {
      const toolsSummary = result.stepsExecuted.map((s) => `• \`${s.name}\``).join('\n');
      reply = `${reply}\n\n🛠️ *Autonomous tools executed:*\n${toolsSummary}`;
    }

    const { safeText } = sanitizeAndCheckSecrets(reply, 'chat_reply');
    await sendLongMessage(ctx, safeText);

    // Persist to conversation history
    const history = conversationHistory.get(userId) || [];
    history.push({ role: 'user', content: prompt });
    history.push({ role: 'assistant', content: result.finalAnswer });
    conversationHistory.set(userId, history);
    scheduleConversationHistoryPersistence();
  } catch (err) {
    console.error('[Gemini Agent Error]:', sanitizeError(err));
    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      `❌ *Gemini Agent Error:*\n${err.message || 'Failed to complete agent task.'}`,
      { parse_mode: 'Markdown' }
    ).catch(() => {});
  }
}

const CODE_EXTENSIONS = ['py', 'java', 'cpp', 'cc', 'cxx', 'c', 'h', 'hpp', 'js', 'ts', 'cs', 'go', 'rs', 'html', 'css', 'sql'];
const DOC_EXTENSIONS = ['pdf', 'txt', 'md'];
const TEXT_EXTENSIONS = [...CODE_EXTENSIONS, ...DOC_EXTENSIONS];
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif'];
const MEDIA_EXTENSIONS = ['mp4', 'webm', 'mkv', 'mov', 'avi', 'mp3', 'm4a', 'ogg', 'wav'];
const SUPPORTED_EXTENSIONS = [...TEXT_EXTENSIONS, ...IMAGE_EXTENSIONS, ...MEDIA_EXTENSIONS];

bot.use(async (ctx, next) => {
  const fromId = ctx.from?.id;
  const chatId = ctx.chat?.id;

  const isAuthorized =
    (fromId != null && allowedUserIds.has(Number(fromId))) ||
    (chatId != null && allowedUserIds.has(Number(chatId)));

  if (allowedUserIds.size === 0 || !isAuthorized) {
    console.log(`[AUTH] Rejected message from unauthorized user: ${fromId ?? 'unknown'} (chat: ${chatId ?? 'unknown'})`);
    return;
  }
  await next();
});

bot.command(['start', 'help'], async (ctx) => {
  await ctx.reply(
    '✨ *Welcome to Your Personal AI Assistant*\n' +
    'Powered by *Claude 3.7 / 3.5 Sonnet* & *Gemini 3.8 Live / Flash*.\n\n' +
    'Send me any message, voice note, photo, or document and I\'ll assist you right away!\n\n' +
    '🤖 *Autonomous AI Agent*\n' +
    '• `/agent <prompt>` — 🤖 *One-Time Task*: Run a single goal with live tools (web, files, math) without switching mode\n' +
    '• `/agent_mode` — 🎚️ *Toggle All Chats*: Set Agent as default for all messages (send again or `/cancel` to exit)\n' +
    '• `/devices` — 💻 *Laptop Agent*: View connected laptops for remote terminal & file tasks\n' +
    '• `/deep_research <topic>` — 🔬 *Deep Research*: Exhaustive multi-source background report\n\n' +
    '🎙️ *Real-Time Live Voice*\n' +
    '• `/live [query]` — 🎙️ Toggle Live Voice mode (spoken voice replies until /cancel)\n' +
    '• `/call` — 📞 Open live duplex voice call WebApp (real-time bidirectional audio)\n' +
    '• `/voice` — 🗣️ Select Gemini Live voice (Puck, Aoede, Charon, Fenrir, Kore)\n\n' +
    '🎨 *Search & Creation*\n' +
    '• `/image <prompt>` — 🎨 Generate pictures with Gemini Nano Banana\n' +
    '• `/search <query>` — 🌐 Live web search & deep factual research\n' +
    '• `/youtube <query>` — 🎥 Search YouTube videos & channels\n' +
    '• `/quiz` — 📝 Interactive quiz on a loaded document or topic\n\n' +
    '☁️ *Files & Cloud Vault*\n' +
    '• `/storage` — ☁️ Cloud Vault hub (Saved files & search history)\n' +
    '• `/library` — 📁 Browse saved files by category (A-Z)\n' +
    '• `/directory [path]` — 📁 View or set your personal laptop folder path\n' +
    '• `/status` — 📊 View your connected laptop specs, bot resources & mode\n\n' +
    '🧹 *Workspace & Settings*\n' +
    '• `/cancel` — ❌ Exit Live Voice, Agent, search, or quiz mode\n' +
    '• `/clear` — 🧹 Clear conversation history (keeps loaded file)\n' +
    '• `/clearall` — 🗑️ Clear all conversation history & unload file\n' +
    '• `/local` — 💾 Save files to your laptop folder & Cloud Vault\n' +
    '• `/cloud` — ☁️ Save files to Cloud Vault only\n' +
    '• `/nosave` — 💻 Save files to your laptop folder only',
    { parse_mode: 'Markdown' }
  );
});

function getPublicBaseUrl() {
  if (process.env.PUBLIC_URL && process.env.PUBLIC_URL.trim()) {
    return process.env.PUBLIC_URL.trim().replace(/\/+$/, '');
  }
  if (process.env.RENDER_EXTERNAL_URL && process.env.RENDER_EXTERNAL_URL.trim()) {
    return process.env.RENDER_EXTERNAL_URL.trim().replace(/\/+$/, '');
  }
  if (process.env.RENDER_EXTERNAL_HOSTNAME && process.env.RENDER_EXTERNAL_HOSTNAME.trim()) {
    return `https://${process.env.RENDER_EXTERNAL_HOSTNAME.trim().replace(/\/+$/, '')}`;
  }
  return null;
}

bot.command(['live', 'live_mode', 'livemode'], async (ctx) => {
  const userId = ctx.from.id;
  const rawArg = (ctx.message.text || '').replace(/^\/(?:live|live_mode|livemode)\s*/i, '').trim();
  const userVoice = getUserVoice(userId);

  // 1. Explicit OFF
  if (rawArg.toLowerCase() === 'off' || rawArg.toLowerCase() === 'disable' || rawArg.toLowerCase() === '0') {
    setUserLiveMode(userId, false);
    await ctx.reply(
      `📝 *Gemini Live Voice Mode: DISABLED*\n\n` +
      `• Returned to standard Claude text chat.\n` +
      `• Send \`/live\` anytime to turn Live Voice back on.`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  // 2. Toggle or Explicit ON
  if (!rawArg || rawArg.toLowerCase() === 'on' || rawArg.toLowerCase() === 'enable' || rawArg.toLowerCase() === '1') {
    const isEnabled = !rawArg ? !isUserLiveModeEnabled(userId) : true;
    setUserLiveMode(userId, isEnabled);

    if (isEnabled) {
      await ctx.reply(
        `🎙️ *Gemini 3.8 Live Voice Mode: ACTIVE!*\n\n` +
        `• **Spoken Voice Replies:** Every message you send (text or voice note) will now receive a real-time spoken voice reply from Gemini 3.8 Live.\n` +
        `• **Voice Persona:** *${userVoice}* (Change with /voice)\n` +
        `• **Status:** Stays active until you manually cancel it!\n\n` +
        `🗣️ *Go ahead, send any message or voice note to begin.*\n\n` +
        `❌ Send \`/cancel\` or \`/live\` anytime to return to standard Claude chat.`,
        { parse_mode: 'Markdown' }
      );
    } else {
      await ctx.reply(
        `📝 *Gemini Live Voice Mode: DISABLED*\n\n` +
        `• Returned to standard Claude text chat.\n` +
        `• Send \`/live\` anytime to turn Live Voice back on.`,
        { parse_mode: 'Markdown' }
      );
    }
    return;
  }

  // 3. User supplied an immediate query: e.g. "/live What are three facts about Saturn?"
  // Turn Live Voice Mode ON so it stays active, then answer this first query immediately with voice!
  setUserLiveMode(userId, true);
  await handleLiveVoiceReply(ctx, rawArg);
});

bot.command(['call', 'live_call'], async (ctx) => {
  const userId = ctx.from.id;
  const userVoice = getUserVoice(userId);
  const publicBase = getPublicBaseUrl();
  const callUrl = publicBase
    ? `${publicBase}/live-call?voice=${encodeURIComponent(userVoice)}`
    : `http://localhost:${PORT}/live-call?voice=${encodeURIComponent(userVoice)}`;

  const kb = new InlineKeyboard();
  if (callUrl.startsWith('https://')) {
    kb.webApp('📞 Start Live Voice Call (In-App)', callUrl)
      .row()
      .url('🌐 Open in Browser', callUrl);
  } else {
    kb.url('📞 Open Voice Call WebApp', callUrl);
  }

  const notice = !publicBase
    ? `\n\n⚠️ *Public URL Note:* To open the WebApp outside localhost, make sure \`RENDER_EXTERNAL_URL\` or \`PUBLIC_URL\` is set in your Render environment variables.`
    : '';

  await ctx.reply(
    `🎙️ *Gemini 3.8 Live Voice Call*\n\n` +
    `Experience real-time, bidirectional voice conversations with Gemini 3.8 Live over WebSockets.\n\n` +
    `• **Active Voice:** \`${userVoice}\`\n` +
    `• **Latency:** Ultra-low, sub-second speech streaming\n` +
    `• **Audio Engine:** 16kHz duplex mic ↔ 24kHz Gemini Live${notice}\n\n` +
    `Tap below to open the WebApp and start talking:`,
    {
      parse_mode: 'Markdown',
      reply_markup: kb,
    }
  );
});

bot.command('voice', async (ctx) => {
  const arg = ctx.message.text.replace(/^\/voice\s*/i, '').trim();
  const userId = ctx.from.id;

  if (!arg) {
    const currentVoice = getUserVoice(userId);
    const kb = new InlineKeyboard();
    AVAILABLE_VOICES.forEach((v, idx) => {
      kb.text(`${v === currentVoice ? '✅ ' : ''}${v}`, `set_voice:${v}`);
      if (idx % 2 === 1) kb.row();
    });

    await ctx.reply(
      `🗣️ *Gemini 3.8 Live Voice Settings*\n\n` +
      `Current active voice: *${currentVoice}*\n\n` +
      `Choose a voice below or type \`/voice <name>\`:\n` +
      `• **Puck**: Warm, natural neutral/male\n` +
      `• **Aoede**: Breezy, expressive female\n` +
      `• **Charon**: Deep, calm, steady male\n` +
      `• **Fenrir**: Authoritative, energetic male\n` +
      `• **Kore**: Crisp, professional female`,
      { parse_mode: 'Markdown', reply_markup: kb }
    );
    return;
  }

  const capitalized = arg.charAt(0).toUpperCase() + arg.slice(1).toLowerCase();
  if (setUserVoice(userId, capitalized)) {
    await ctx.reply(`✅ *Voice updated!* Your Gemini Live voice is now set to *${capitalized}*.`, {
      parse_mode: 'Markdown',
    });
  } else {
    await ctx.reply(
      `❌ Unknown voice: *${arg}*.\nAvailable voices: ${AVAILABLE_VOICES.join(', ')}`,
      { parse_mode: 'Markdown' }
    );
  }
});

bot.callbackQuery(/^set_voice:(.+)$/, async (ctx) => {
  const selectedVoice = ctx.match[1];
  const userId = ctx.from.id;
  setUserVoice(userId, selectedVoice);
  await ctx.answerCallbackQuery({ text: `Voice set to ${selectedVoice}!` });

  const kb = new InlineKeyboard();
  AVAILABLE_VOICES.forEach((v, idx) => {
    kb.text(`${v === selectedVoice ? '✅ ' : ''}${v}`, `set_voice:${v}`);
    if (idx % 2 === 1) kb.row();
  });

  await ctx.editMessageText(
    `🗣️ *Gemini 3.8 Live Voice Settings*\n\n` +
    `Current active voice: *${selectedVoice}*\n\n` +
    `• **Puck**: Warm, natural neutral/male\n` +
    `• **Aoede**: Breezy, expressive female\n` +
    `• **Charon**: Deep, calm, steady male\n` +
    `• **Fenrir**: Authoritative, energetic male\n` +
    `• **Kore**: Crisp, professional female`,
    { parse_mode: 'Markdown', reply_markup: kb }
  );
});

bot.command('agent', async (ctx) => {
  const prompt = ctx.message.text.replace(/^\/agent\s*/i, '').trim();
  if (!prompt) {
    await ctx.reply(
      '🤖 *Gemini Autonomous Agent (One-Time Task)*\n\n' +
      'Run a single objective using autonomous tools without changing your default chat with Claude.\n\n' +
      '• **How it works:** Executes web search, YouTube, file inspection, and math calculations in a ReAct loop to solve your specific task.\n' +
      '• **When to use `/agent`:** When you want a quick tool or research task done for this message only. Your regular chat stays with Claude.\n' +
      '• **When to use `/agent_mode`:** When you want the agent to answer *all* future messages automatically without typing `/agent` each time.\n\n' +
      '*Usage Example:*\n' +
      '`/agent Search the web for latest releases in Node.js, and check my cloud vault for any notes`',
      { parse_mode: 'Markdown' }
    );
    return;
  }
  await handleAgentCommand(ctx, prompt);
});

bot.command(['agent_mode', 'agentmode'], async (ctx) => {
  const userId = ctx.from.id;
  const rawArg = (ctx.message.text || '').replace(/^\/(?:agent_mode|agentmode)\s*/i, '').trim().toLowerCase();

  let isEnabled;
  if (rawArg === 'on' || rawArg === 'enable' || rawArg === '1') {
    isEnabled = true;
  } else if (rawArg === 'off' || rawArg === 'disable' || rawArg === '0') {
    isEnabled = false;
  } else {
    isEnabled = !userAgentMode.get(userId);
  }

  userAgentMode.set(userId, isEnabled);

  await ctx.reply(
    isEnabled
      ? `🤖 *Gemini Agent Mode: ENABLED*\n\n` +
        `• **Default Assistant:** Switched to Gemini Autonomous Agent for all your messages.\n` +
        `• **Automatic Tools:** Every message you send can now automatically trigger web searches, file checks, YouTube searches, and calculations.\n\n` +
        `❌ *How to Turn Off / Cancel:*\n` +
        `• Send \`/agent_mode\` again (or \`/agent_mode off\`).\n` +
        `• Or simply send \`/cancel\` anytime to restore Claude standard chat.`
      : `🧠 *Claude Standard Mode: RESTORED*\n\n` +
        `• **Default Assistant:** Switched back to Claude (best for coding, reasoning, and document discussion).\n` +
        `• **Single Tasks:** You can still run on-demand agent tasks anytime with \`/agent <prompt>\`.`,
    { parse_mode: 'Markdown' }
  );
});

bot.command(['devices', 'laptops', 'device'], async (ctx) => {
  const userId = ctx.from.id;
  const list = getConnectedLaptopsList(userId);
  const allLaptops = getAllConnectedLaptops(allowedUserIds);

  let text = `💻 *Laptop Fleet & Device Status*\n\n`;

  // 1. Caller's own device
  text += `👤 *Your Laptop (${userId}):*\n`;
  if (!list || list.length === 0) {
    text += `└─ 🔴 Not Connected (Run \`start-agent.bat\` on your machine)\n\n`;
  } else {
    for (const d of list) {
      const statusIcon = d.isOnline ? '🟢' : '🔴';
      const statusText = d.isOnline ? 'Online & Ready' : 'Disconnected';
      const osText = d.osVersion ? `${d.platform} (${d.osVersion})` : d.platform;
      const userText = d.username ? ` | User: \`${d.username}\`` : '';
      text += `${statusIcon} *${d.deviceName}* (\`${d.hostname}\`)\n` +
        `   • OS: \`${osText}\`${userText}\n` +
        `   • Status: ${statusText}\n` +
        `   • Connected: ${new Date(d.connectedAt).toLocaleTimeString()}\n\n`;
    }
  }

  // 2. All authorized users' laptop names & statuses
  if (allowedUserIds.size > 1) {
    text += `👥 *All Authorized Users Fleet:*\n`;
    for (const item of allLaptops) {
      const isYou = item.userId === userId ? ' (You)' : '';
      if (item.hasOnlineDevice) {
        for (const d of item.devices.filter((x) => x.isOnline)) {
          const osInfo = d.osVersion ? `${d.platform} - ${d.osVersion}` : d.platform;
          text += `• User \`${item.userId}\`${isYou}: 🟢 *${d.deviceName}* (\`${d.hostname}\` | \`${osInfo}\`)\n`;
        }
      } else {
        text += `• User \`${item.userId}\`${isYou}: 🔴 Disconnected\n`;
      }
    }
    text += `\n`;
  }

  text += `• **Safe on Public Wi-Fi:** Uses an outbound encrypted TLS tunnel (\`wss://\`) with 0 open incoming ports.\n` +
    `• **Multi-User Isolation:** Each user's agent commands only execute on their own machine.\n\n` +
    `_Try: \`/status\` to view live CPU/RAM specs, or \`/agent run tests on my laptop\`._`;

  const keyboard = new InlineKeyboard();
  if (!list || list.length === 0) {
    keyboard.text('💻 Setup My Laptop', `setup_laptop_${userId}`).row();
  } else {
    keyboard.text('📥 Re-download start-agent.bat', `dl_bat_${userId}`).row();
  }
  keyboard.text('🔄 Refresh Status', `refresh_devices_${userId}`);

  await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: keyboard });
});

/**
 * Send pre-configured laptop agent runner files and 1-line setup command to a user
 */
async function sendLaptopRunnerSetup(ctx, targetUserId) {
  const uid = Number(targetUserId || ctx.from.id);
  const serverUrl = getPublicBotUrl();
  const isOnline = isLaptopConnected(uid);

  const ps1Command = `irm ${serverUrl}/setup/${uid}.ps1 | iex`;

  const keyboard = new InlineKeyboard()
    .text('📥 Download start-agent.bat', `dl_bat_${uid}`)
    .text('🔄 Check Connection', `refresh_devices_${uid}`);

  const msg =
    `💻 *Telegram AI Laptop Runner Setup*\n\n` +
    `• **Target User:** \`${uid}\` ${uid === ctx.from.id ? '(You)' : ''}\n` +
    `• **Current Status:** ${isOnline ? '🟢 Connected & Online' : '🔴 Disconnected'}\n\n` +
    `To let the agent install dependencies, create files, and execute scripts on your laptop:\n\n` +
    `⚡ *Option 1: 1-Line PowerShell Command (Windows)*\n` +
    `Open PowerShell on your laptop, paste this command, and press Enter:\n` +
    `\`${ps1Command}\`\n\n` +
    `📁 *Option 2: Download & Run Batch File*\n` +
    `Download the pre-configured \`start-agent.bat\` attached below and double-click it on your laptop!\n\n` +
    `🔒 *100% Safe on Public Wi-Fi:*\n` +
    `The runner connects outward via encrypted TLS WebSocket (\`wss://\`). It opens **0** listening ports on your laptop, so nobody on public Wi-Fi can scan or connect to your machine.`;

  await ctx.reply(msg, {
    parse_mode: 'Markdown',
    reply_markup: keyboard,
  });

  // Attach the personalized start-agent.bat file directly to the chat
  try {
    const batContent = generateStartAgentBat({ userId: uid, serverUrl });
    await ctx.replyWithDocument(new InputFile(Buffer.from(batContent, 'utf-8'), 'start-agent.bat'), {
      caption: `💻 *start-agent.bat (Pre-configured for User ${uid})*\nSave to any folder on your laptop and double-click to start!`,
      parse_mode: 'Markdown',
    });
  } catch (err) {
    console.warn('[Setup] Error sending start-agent.bat file:', err.message);
  }
}

bot.command(['setup_laptop', 'connect_laptop', 'runner', 'install_agent', 'setup_agent'], async (ctx) => {
  await sendLaptopRunnerSetup(ctx, ctx.from.id);
});

bot.callbackQuery(/^setup_laptop_(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  const targetUid = Number(ctx.match[1]);
  await sendLaptopRunnerSetup(ctx, targetUid);
});

bot.callbackQuery(/^dl_bat_(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery({ text: 'Sending pre-configured start-agent.bat...' }).catch(() => {});
  const targetUid = Number(ctx.match[1]);
  const serverUrl = getPublicBotUrl();
  const batContent = generateStartAgentBat({ userId: targetUid, serverUrl });
  await ctx.replyWithDocument(new InputFile(Buffer.from(batContent, 'utf-8'), 'start-agent.bat'), {
    caption: `💻 *start-agent.bat (User ${targetUid})*\nSave to your laptop and double-click to run!`,
    parse_mode: 'Markdown',
  });
});

bot.callbackQuery(/^refresh_devices_(\d+)$/, async (ctx) => {
  const targetUid = Number(ctx.match[1]);
  const isOnline = isLaptopConnected(targetUid);
  await ctx.answerCallbackQuery({
    text: isOnline ? '🟢 Laptop is Online & Ready!' : '🔴 Laptop is currently offline.',
    show_alert: true,
  }).catch(() => {});
});

bot.callbackQuery(/^refresh_status_(\d+)$/, async (ctx) => {
  const targetUid = Number(ctx.match[1]);
  const isOnline = isLaptopConnected(targetUid);
  await ctx.answerCallbackQuery({
    text: isOnline ? '🟢 Laptop connected! Use /status to view specs.' : '🔴 Laptop is still offline.',
    show_alert: true,
  }).catch(() => {});
});

bot.command(['deep_research', 'research'], async (ctx) => {
  const topic = ctx.message.text.replace(/^\/(?:deep_research|research)\s*/i, '').trim();
  if (!topic) {
    await ctx.reply(
      '🔬 *Gemini Deep Research Agent*\n\n' +
      'Conduct exhaustive, multi-step web research on any complex topic powered by `deep-research-preview-04-2026`!\n\n' +
      '*Usage:*\n' +
      '`/deep_research The current state and future architecture of quantum computing chips`',
      { parse_mode: 'Markdown' }
    );
    return;
  }

  const statusMsg = await ctx.reply('🔬 *Initiating Gemini Deep Research Agent...*', { parse_mode: 'Markdown' });
  let lastEditTime = Date.now();

  const updateStatus = async (statusText) => {
    if (Date.now() - lastEditTime > 1500) {
      lastEditTime = Date.now();
      try {
        await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, statusText, {
          parse_mode: 'Markdown',
        });
      } catch {}
    }
  };

  try {
    const { report } = await runDeepResearchAgent({
      topic,
      onStatusUpdate: updateStatus,
      timeoutMs: 180000,
    });

    await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
    const { safeText } = sanitizeAndCheckSecrets(report, 'chat_reply');
    await sendLongMessage(ctx, `📑 *Deep Research Report:*\n\n${safeText}`);
  } catch (err) {
    console.error('[Deep Research Error]:', sanitizeError(err));
    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      `⚠️ *Deep Research Notice:*\n${err.message || 'Failed to complete research.'}\n\n` +
      `💡 Note: Deep Research Agent requires available quota on your Google GenAI account.`,
      { parse_mode: 'Markdown' }
    ).catch(() => {});
  }
});

async function handleClearAll(ctx) {
  const userId = ctx.from.id;
  clearUserQueue(userId);
  conversationHistory.delete(userId);
  userLastDocument.delete(userId);
  userLastInteraction.delete(userId);
  userActiveMode.delete(userId);
  userCachedFilesList.delete(userId);
  scheduleConversationHistoryPersistence();

  await ctx.reply(
    '✅ *All chat history & loaded documents cleared!*\n\n' +
    '• 🧠 Claude has forgotten previous messages.\n' +
    '• 📄 The active document has been unloaded from chat.\n' +
    '• 📁 *Files in your folder & Cloud Vault are safe:* Nothing was deleted from your drive or cloud. You can browse or re-open them anytime with /library.\n\n' +
    '💡 *To clear visible message bubbles in Telegram:*\n' +
    'Tap the 3 dots (⋮) in the top-right corner → "Clear history".',
    { parse_mode: 'Markdown' }
  );
}

async function handleClear(ctx) {
  const userId = ctx.from.id;
  clearUserQueue(userId);
  userActiveMode.delete(userId);
  const text = ctx.message?.text || '';
  const arg = text.replace(/^\/?clear\s*/i, '').trim().toLowerCase();

  if (arg === 'all' || arg === 'doc' || arg === 'file') {
    await handleClearAll(ctx);
    return;
  }

  conversationHistory.delete(userId);
  userLastInteraction.delete(userId);
  scheduleConversationHistoryPersistence();

  const activeDoc = await getOrAutoLoadDocument(userId);
  if (activeDoc) {
    const keyboard = new InlineKeyboard().text('🗑️ Clear All (Unload File Too)', 'confirm_clear_all');
    await ctx.reply(
      '✅ *Conversation messages cleared!*\n\n' +
      `📄 *Active Document Kept:* \`${activeDoc.fileName}\`\n` +
      `You can continue asking questions or chatting about this file without re-uploading!\n\n` +
      `💡 _To unload this document from chat memory too, type \`/clear all\` or tap below:_`,
      { parse_mode: 'Markdown', reply_markup: keyboard }
    );
  } else {
    userLastDocument.delete(userId);
    await ctx.reply(
      '✅ *Conversation history cleared!*\n\n' +
      'Claude has forgotten previous messages.\n\n' +
      '💡 *To clear visible message bubbles in Telegram:*\n' +
      'Tap the 3 dots (⋮) in the top-right corner → "Clear history".',
      { parse_mode: 'Markdown' }
    );
  }
}

bot.command('clear', handleClear);
bot.command(['clearall', 'clear_all'], handleClearAll);
bot.hears(/^clear\s+all$/i, handleClearAll);
bot.hears(/^clear$/i, handleClear);

bot.callbackQuery('confirm_clear_all', async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  await handleClearAll(ctx);
});

bot.command(['directory', 'setdirectory', 'dir'], async (ctx) => {
  const userId = ctx.from.id;
  const rawArg = ctx.message.text.replace(/^\/(?:directory|setdirectory|dir)\s*/i, '').trim();

  if (!rawArg) {
    const currentDir = getUserStorageDir(userId);
    userAwaitingDirectoryInput.add(userId);
    await ctx.reply(
      `📁 *Your Local Laptop Folder*\n\n` +
      `Current folder: ${currentDir ? `\`${currentDir}\`` : '_Not set yet_'}\n\n` +
      `To set or change your folder, **reply with your laptop's folder path** now:\n` +
      `Example: \`C:\\Users\\yourname\\Documents\\BotStorage\` or \`D:\\Projects\`\n\n` +
      `_(Or type /cancel to keep current settings)_`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  setUserStorageDir(userId, rawArg);
  await ctx.reply(
    `✅ *Local Folder Configured!*\n\n` +
    `📁 *Folder:* \`${rawArg}\`\n\n` +
    `• Whenever you choose Local or Dual storage, files will be saved in this folder on your laptop.\n` +
    `• Remote Agent commands will use this as your default project folder.`,
    { parse_mode: 'Markdown' }
  );
});

bot.command(['nosave', 'no_save'], async (ctx) => {
  const userId = ctx.from.id;
  setUserStorageMode(userId, 'nosave');
  const currentDir = getUserStorageDir(userId);
  let promptFolder = '';
  if (!currentDir) {
    userAwaitingDirectoryInput.add(userId);
    promptFolder = '\n\n⚠️ *Action Required:* Please reply now with the folder path on your laptop where you want files saved (e.g. `C:\\Users\\yourname\\Documents` or `D:\\Projects`).';
  } else {
    promptFolder = `\n• Target Laptop Folder: \`${currentDir}\``;
  }
  await ctx.reply(
    '💻 *Upload Mode set to: Local Only (/nosave)*\n\n' +
    '• New files you upload will be saved **only to your laptop**.\n' +
    '• They will **NOT** be uploaded to Telegram Cloud Vault.' + promptFolder + '\n\n' +
    '💡 _To switch back:_\n' +
    '• Type /local to save to both your laptop and Cloud Vault\n' +
    '• Type /cloud to save to Cloud Vault only (saving laptop space)',
    { parse_mode: 'Markdown' }
  );
});

bot.command(['cloud', 'cloudonly'], async (ctx) => {
  const userId = ctx.from.id;
  setUserStorageMode(userId, 'cloud');
  await ctx.reply(
    '☁️ *Upload Mode set to: Cloud Only*\n\n' +
    '• New files you upload will be saved **only to Telegram Cloud Vault**.\n' +
    '• They will **NOT** take up space on your laptop drive.\n\n' +
    '💡 _To switch back:_\n' +
    '• Type /local to save to both your laptop and Cloud Vault\n' +
    '• Type /nosave to save to your laptop only',
    { parse_mode: 'Markdown' }
  );
});

bot.command(['local', 'dual'], async (ctx) => {
  const userId = ctx.from.id;
  setUserStorageMode(userId, 'local');
  const currentDir = getUserStorageDir(userId);
  let promptFolder = '';
  if (!currentDir) {
    userAwaitingDirectoryInput.add(userId);
    promptFolder = '\n\n⚠️ *Action Required:* Please reply now with the folder path on your laptop where you want files saved (e.g. `C:\\Users\\yourname\\Documents` or `D:\\Projects`).';
  } else {
    promptFolder = `\n• Target Laptop Folder: \`${currentDir}\``;
  }
  await ctx.reply(
    '💻+☁️ *Upload Mode set to: Local & Cloud (Default)*\n\n' +
    '• New files you upload will be saved to **both your laptop folder and Telegram Cloud Vault**.' + promptFolder + '\n\n' +
    '💡 _Other modes:_\n' +
    '• Type /cloud to save to Cloud Vault only\n' +
    '• Type /nosave to save to your laptop only',
    { parse_mode: 'Markdown' }
  );
});

bot.command(['storage', 'mode'], async (ctx) => {
  const userId = ctx.from.id;
  userActiveMode.delete(userId);
  const currentMode = getUserStorageMode(userId);
  const userDir = getUserStorageDir(userId);
  const dirDisplay = userDir ? `\`${userDir}\`` : '_Not set yet (tap button below)_';
  const modeLabels = {
    local: '💻+☁️ Local & Cloud (Dual Save)',
    cloud: '☁️ Cloud Only (No laptop space)',
    nosave: '💻 Local Only (/nosave - No cloud save)',
  };

  const keyboard = new InlineKeyboard()
    .text(`☁️ Telegram Cloud Vault (${cloudVault.length} files)`, 'storage_cloud')
    .row()
    .text(userDir ? `💻 Local Storage (${path.basename(userDir) || 'Folder'})` : '💻 Local Storage (Set Folder)', 'lib_src:local')
    .row()
    .text('📁 Set / Change Local Folder', 'change_local_dir')
    .row()
    .text(`⚙️ Upload Destination: ${modeLabels[currentMode]}`, 'open_storage_settings');

  await ctx.reply(
    `⚙️ *Storage & Cloud Hub*\n\n` +
    `Current Upload Mode: *${modeLabels[currentMode]}*\n\n` +
    `Choose what you'd like to do:\n\n` +
    `• ☁️ **Telegram Cloud Vault**: Access your saved files & search history\n` +
    `• 💻 **Local Storage**: Files stored in ${dirDisplay} on your laptop\n` +
    `• 📁 **Configure Folder**: Tap "Set / Change Local Folder" or send /directory\n` +
    `• ⚙️ **Upload Destination**: Configure where new uploads are saved`,
    {
      parse_mode: 'Markdown',
      reply_markup: keyboard,
    }
  );
});

// --- Research & Search Action Handlers ---

async function handleYoutubeSearch(ctx, query) {
  const cleanQuery = (query || '').trim();
  if (!cleanQuery) return;

  await ctx.replyWithChatAction('typing');
  const results = await searchYouTube(cleanQuery, 4);
  if (results.length === 0) {
    await ctx.reply(`❌ No YouTube videos found for: \`${cleanQuery}\``, { parse_mode: 'Markdown' });
    return;
  }

  // Save to search history
  await addSearchHistoryEntry({
    query: cleanQuery,
    type: 'youtube',
    title: results[0].title,
    url: results[0].url,
    resultsCount: results.length,
    topResults: results.map((r) => ({ title: r.title, link: r.url })),
  });

  let msgText = `🎥 *YouTube Search Results for:* "${cleanQuery}"\n\n`;
  const keyboard = new InlineKeyboard();

  results.forEach((r, idx) => {
    msgText += `*${idx + 1}.* [${r.title}](${r.url})\n`;
    msgText += `   ⏱️ Duration: \`${r.duration}\` | 👤 Channel: \`${r.uploader}\`\n\n`;
  });

  const isYtMode = userActiveMode.get(ctx.from.id)?.mode === 'youtube';
  if (isYtMode) {
    userActiveMode.set(ctx.from.id, { mode: 'youtube', timestamp: Date.now() });
    msgText += `💡 _YouTube search mode active. Send another title to search, or type /cancel to exit._\n`;
    keyboard.text('❌ Exit YouTube Mode', 'exit_active_mode');
  }

  await ctx.reply(msgText, {
    parse_mode: 'Markdown',
    reply_markup: isYtMode ? keyboard : undefined,
    disable_web_page_preview: true,
  });
}

async function handleWebSearch(ctx, query) {
  const cleanQuery = (query || '').trim();
  if (!cleanQuery) return;

  const typingInterval = setInterval(() => {
    ctx.replyWithChatAction('typing').catch(() => {});
  }, 4000);

  const webResults = await searchWeb(cleanQuery, 5);

  // Use Gemini 3.8 Flash to perform deep research and format a high-quality answer (preserving Claude balance)
  let geminiResearch = '';
  try {
    const webContext =
      webResults.length > 0
        ? `Web Sources Found:\n` +
          webResults.map((r, i) => `${i + 1}. ${r.title}\nLink: ${r.link}\nSnippet: ${r.snippet}`).join('\n\n')
        : `No external search engine results were retrieved directly.`;

    const prompt =
      `The user is searching for: "${cleanQuery}".\n\n` +
      `${webContext}\n\n` +
      `Provide a comprehensive, accurate, and helpful research answer:\n` +
      `1. Directly explain what "${cleanQuery}" is, its meaning, background, or solution.\n` +
      `2. If products, shops, deals, or websites are relevant, recommend the best options.\n` +
      `3. Format neatly with markdown bullet points and clear sections.\n` +
      `4. Keep the explanation concise, high-value, and directly useful.`;

    const response = await callGeminiWithRetry(() =>
      googleAI.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: prompt,
      })
    );
    geminiResearch = (response.text || '').trim();
  } catch (err) {
    console.error('Gemini web research error:', sanitizeError(err));
  } finally {
    clearInterval(typingInterval);
  }

  let msgText = `🌐 *Research Results for: "${cleanQuery}"*\n\n`;
  if (geminiResearch) {
    msgText += `${geminiResearch}\n\n`;
  }

  if (webResults.length > 0) {
    msgText += `🔗 *Source Links:*\n`;
    webResults.slice(0, 3).forEach((r) => {
      msgText += `• [${r.title}](${r.link})\n`;
    });
    msgText += `\n`;
  }

  if (userActiveMode.get(ctx.from.id)?.mode === 'search') {
    userActiveMode.set(ctx.from.id, { mode: 'search', timestamp: Date.now() });
    msgText += `💡 _Search mode active. Send another topic to search, or type /cancel to exit._\n`;
  }

  // Save to search history
  await addSearchHistoryEntry({
    query: cleanQuery,
    type: 'web',
    title: webResults[0]?.title || cleanQuery,
    url: webResults[0]?.link || '',
    resultsCount: webResults.length,
    topResults: webResults.map((r) => ({ title: r.title, link: r.link })),
  });

  const keyboard = new InlineKeyboard()
    .text('💾 View in Search History', 'cloud_hist_page:0');

  if (userActiveMode.get(ctx.from.id)?.mode === 'search') {
    keyboard.row().text('❌ Exit Search Mode', 'exit_active_mode');
  }

  await sendLongMessage(ctx, msgText, {
    parse_mode: 'Markdown',
    reply_markup: keyboard,
  });
}



// --- Gemini Image Generation (Nano Banana) ---
async function generateGeminiImage(prompt) {
  const modelsToTry = [
    'gemini-nano-banana-2.1',
    'nano-banana-pro-preview',
    'gemini-3.1-flash-image',
    'gemini-2.5-flash-image',
  ];

  let lastGeminiErr = null;

  for (const model of modelsToTry) {
    try {
      const response = await googleAI.models.generateContent({
        model,
        contents: prompt,
      });

      const candidate = response.candidates?.[0];
      const inlinePart = candidate?.content?.parts?.find((p) => p.inlineData?.data);
      if (inlinePart && inlinePart.inlineData.data) {
        return {
          source: `Gemini (${model})`,
          mimeType: inlinePart.inlineData.mimeType || 'image/jpeg',
          buffer: Buffer.from(inlinePart.inlineData.data, 'base64'),
        };
      }
    } catch (err) {
      lastGeminiErr = err;
    }
  }

  // Automatic high-quality fallback if Gemini AI Studio Free Tier has quota: 0
  try {
    const encoded = encodeURIComponent(prompt.slice(0, 500));
    const url = `https://image.pollinations.ai/prompt/${encoded}?width=1024&height=1024&nologo=true&seed=${Math.floor(Math.random() * 100000)}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(20000),
      headers: { 'User-Agent': 'TelegramAIBot/1.0' },
    });
    if (res.ok) {
      const arrayBuffer = await res.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      if (buffer.length > 2000) {
        return {
          source: 'Gemini Quota Fallback (Flux/SDXL)',
          mimeType: 'image/jpeg',
          buffer,
          note: 'Google AI Studio Free Tier limits image model quota to 0. Enable billing in Google AI Studio to use native Gemini Nano Banana directly.',
        };
      }
    }
  } catch (fbErr) {
    console.error('Fallback image generator error:', sanitizeError(fbErr));
  }

  throw lastGeminiErr || new Error('Image generation failed. Please verify your prompt or API quota.');
}

async function handleImageGeneration(ctx, rawPrompt) {
  let prompt = rawPrompt;
  if (!prompt && ctx.match) {
    prompt = typeof ctx.match === 'string' ? ctx.match.trim() : '';
  }
  if (!prompt && typeof ctx.message?.text === 'string') {
    const parts = ctx.message.text.trim().split(/\s+/);
    if (parts[0].startsWith('/')) {
      prompt = parts.slice(1).join(' ').trim();
    }
  }

  if (!prompt) {
    userActiveMode.set(ctx.from.id, { mode: 'image', timestamp: Date.now() });
    const keyboard = new InlineKeyboard().text('❌ Exit Image Mode', 'exit_active_mode');
    await ctx.reply(
      '🎨 *Gemini Nano Banana Image Mode Active*\n\n' +
      'What picture would you like to generate?\n' +
      'Type your prompt below (e.g. `a cute fluffy orange cat in cyberpunk neon city, 4k digital art`):\n\n' +
      '💡 _Image mode will stay active for your next prompts until you type /cancel._',
      { parse_mode: 'Markdown', reply_markup: keyboard }
    );
    return;
  }

  const statusMsg = await ctx.reply(
    `🎨 *Generating picture with Gemini Nano Banana...*\n` +
    `Prompt: _"${prompt.slice(0, 100)}"_\n\n` +
    `⏳ Please wait a moment...`,
    { parse_mode: 'Markdown' }
  );

  const typingInterval = setInterval(() => {
    ctx.replyWithChatAction('upload_photo').catch(() => {});
  }, 4000);

  try {
    const result = await generateGeminiImage(prompt);

    await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});

    const isImgMode = userActiveMode.get(ctx.from.id)?.mode === 'image';
    if (isImgMode) {
      userActiveMode.set(ctx.from.id, { mode: 'image', timestamp: Date.now() });
    }

    let caption =
      `🎨 *Image Generated*\n\n` +
      `📝 *Prompt:* ${prompt.slice(0, 300)}\n` +
      `⚡ *Engine:* \`${result.source}\`` +
      (result.note ? `\n\n💡 _${result.note}_` : '');

    const photoKeyboard = isImgMode
      ? new InlineKeyboard().text('❌ Exit Image Mode', 'exit_active_mode')
      : undefined;

    if (isImgMode) {
      caption += `\n\n💡 _Image mode active. Send another prompt, or type /cancel to exit._`;
    }

    await ctx.replyWithPhoto(new InputFile(result.buffer, 'gemini_image.jpg'), {
      caption: caption.slice(0, 1024),
      parse_mode: 'Markdown',
      ...(photoKeyboard ? { reply_markup: photoKeyboard } : {}),
    });
  } catch (err) {
    console.error('Image generation error:', sanitizeError(err));
    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      `❌ *Image generation failed:*\n\`${sanitizeError(err).slice(0, 300)}\`\n\n` +
      `Please check your prompt or API key permissions.`,
      { parse_mode: 'Markdown' }
    );
  } finally {
    clearInterval(typingInterval);
  }
}

// Image Generation Command (Gemini Nano Banana)
bot.command(['image', 'picture', 'draw', 'imagine'], async (ctx) => {
  userActiveMode.set(ctx.from.id, { mode: 'image', timestamp: Date.now() });
  await handleImageGeneration(ctx);
});

// YouTube Search Command
bot.command('youtube', async (ctx) => {
  const query = ctx.message.text.replace(/^\/youtube\s*/i, '').trim();
  userActiveMode.set(ctx.from.id, { mode: 'youtube', timestamp: Date.now() });
  if (!query) {
    const keyboard = new InlineKeyboard().text('❌ Exit YouTube Mode', 'exit_active_mode');
    await ctx.reply(
      '🎥 *YouTube Search Mode Active*\n\n' +
      'What YouTube video or topic are you searching for?\n' +
      'Type your search below (e.g. `lofi hip hop` or `python full course`):\n\n' +
      '💡 _YouTube mode will stay active for your next messages until you type /cancel._',
      { parse_mode: 'Markdown', reply_markup: keyboard }
    );
    return;
  }
  await handleYoutubeSearch(ctx, query);
});

// Web & Research Search Command
bot.command(['search', 'find'], async (ctx) => {
  const query = ctx.message.text.replace(/^\/(search|find)\s*/i, '').trim();
  userActiveMode.set(ctx.from.id, { mode: 'search', timestamp: Date.now() });
  if (!query) {
    const keyboard = new InlineKeyboard().text('❌ Exit Search Mode', 'exit_active_mode');
    await ctx.reply(
      '🌐 *AI Web & Research Search Mode Active*\n\n' +
      'What would you like to search on the web?\n' +
      'Type your search topic below:\n\n' +
      '💡 _Search mode will stay active for your next messages until you type /cancel._',
      { parse_mode: 'Markdown', reply_markup: keyboard }
    );
    return;
  }
  await handleWebSearch(ctx, query);
});

// Video Downloader Commands (Disabled notice)
bot.command(['download', 'dl', 'tiktok'], async (ctx) => {
  await ctx.reply(
    'ℹ️ *Video Downloading Disabled*\n\n' +
    'Video downloading has been disabled to keep the bot fast and lightweight.\n\n' +
    '🎥 *YouTube Search:* Use `/youtube <query>` to search videos with direct watch links!\n' +
    '🌐 *Web Research:* Use `/search <query>` for AI web research.',
    { parse_mode: 'Markdown' }
  );
});

// Cancel Active Command Mode Command
bot.command('cancel', async (ctx) => {
  const userId = ctx.from.id;
  const active = userActiveMode.get(userId);
  userActiveMode.delete(userId);

  const wasAgentMode = !!userAgentMode.get(userId);
  if (wasAgentMode) {
    userAgentMode.set(userId, false);
  }

  const wasLiveMode = isUserLiveModeEnabled(userId);
  if (wasLiveMode) {
    setUserLiveMode(userId, false);
  }

  const cancelled = [];
  if (active) {
    const modeNames = {
      search: '🌐 AI Web Search',
      youtube: '🎥 YouTube Search',
      image: '🎨 Image Generation',
    };
    cancelled.push(modeNames[active.mode] || active.mode);
  }
  if (wasAgentMode) {
    cancelled.push('🤖 Gemini Agent Mode');
  }
  if (wasLiveMode) {
    cancelled.push('🎙️ Gemini Live Voice Mode');
  }

  if (cancelled.length > 0) {
    await ctx.reply(
      `✅ *${cancelled.join(' & ')} cancelled.*\n\n` +
      `You are now back in standard AI chat mode with Claude. Send any message, photo, or question to chat!`,
      { parse_mode: 'Markdown' }
    );
  } else {
    await ctx.reply(
      `ℹ️ *No active command, agent, or live voice mode to cancel.*\n\n` +
      `You are already in normal AI chat mode with Claude. Send any message, photo, or question to chat!`,
      { parse_mode: 'Markdown' }
    );
  }
});

bot.command('status', async (ctx) => {
  const userId = ctx.from.id;
  const uptime = Date.now() - botStartTime;
  const uptimeSeconds = Math.floor(uptime / 1000);
  const uptimeDays = Math.floor(uptimeSeconds / 86400);
  const uptimeHours = Math.floor((uptimeSeconds % 86400) / 3600);
  const uptimeMinutes = Math.floor((uptimeSeconds % 3600) / 60);
  const uptimeSecs = uptimeSeconds % 60;

  const uptimeString = uptimeDays > 0
    ? `${uptimeDays}d ${uptimeHours}h ${uptimeMinutes}m ${uptimeSecs}s`
    : uptimeHours > 0
    ? `${uptimeHours}h ${uptimeMinutes}m ${uptimeSecs}s`
    : `${uptimeMinutes}m ${uptimeSecs}s`;

  const activeDoc = await getOrAutoLoadDocument(userId);
  const activeModeObj = userActiveMode.get(userId);
  const activeModeNames = {
    search: '🌐 AI Web Search (/cancel to exit)',
    youtube: '🎥 YouTube Search (/cancel to exit)',
    image: '🎨 Image Generator (/cancel to exit)',
  };
  const isAgentActive = userAgentMode.get(userId);
  const activeModeDisplay = isAgentActive
    ? '🤖 Gemini Autonomous Agent (All chats)'
    : activeModeObj
    ? (activeModeNames[activeModeObj.mode] || `\`${activeModeObj.mode}\` (/cancel to exit)`)
    : '💬 Normal Chat Mode (Claude)';

  const userDir = getUserStorageDir(userId);
  const userMode = getUserStorageMode(userId);
  const modeLabels = {
    local: '💻+☁️ Local & Cloud (Dual)',
    cloud: '☁️ Cloud Only',
    nosave: '💻 Local Only (/nosave)',
  };

  // 1. Check if THIS specific user's laptop is connected
  const hasLaptop = isLaptopConnected(userId);
  let laptopSpecsText = '';

  if (hasLaptop) {
    try {
      const laptop = await getLaptopStatus(userId);
      if (laptop && laptop.success) {
        const memTotalGb = (laptop.memory.totalMb / 1024).toFixed(1);
        const memUsedGb = (laptop.memory.usedMb / 1024).toFixed(1);
        const memFreeGb = (laptop.memory.freeMb / 1024).toFixed(1);

        const osLabel = laptop.osVersion ? `${laptop.platform} - ${laptop.osVersion}` : `${laptop.platform} (${laptop.arch})`;
        const userLabel = laptop.username ? ` | User: \`${laptop.username}\`` : '';

        laptopSpecsText =
          `💻 *Your Connected Laptop Specs (Live)*\n` +
          `├─ Device: *${laptop.deviceName}* (\`${laptop.hostname}\`)${userLabel}\n` +
          `├─ OS: \`${osLabel}\`\n` +
          `├─ CPU: ${laptop.cpuModel || 'CPU'} (${laptop.cpuCores} cores)\n` +
          `├─ RAM: ${memUsedGb} GB / ${memTotalGb} GB used (${laptop.memory.usedPercent}%)\n` +
          `├─ Free RAM: ${memFreeGb} GB\n` +
          `├─ Laptop Uptime: ${laptop.uptimeHours} hrs\n` +
          `└─ Status: 🟢 Online & Ready for remote scripts\n\n`;
      }
    } catch (laptopErr) {
      console.warn(`[Status] Error querying laptop for user ${userId}:`, laptopErr.message);
      laptopSpecsText =
        `💻 *Your Connected Laptop*\n` +
        `└─ Status: 🟡 Connected (Runner responding slowly)\n\n`;
    }
  } else {
    laptopSpecsText =
      `💻 *Your Laptop Specs*\n` +
      `└─ Status: 🔴 Offline / Not Connected\n` +
      `   _Run \`start-agent.bat\` on your laptop to view your live specs and enable remote scripts._\n\n`;
  }

  // 1.5 Check and display all authorized users' laptop names & online states
  let fleetText = '';
  if (allowedUserIds.size > 1) {
    const allLaptops = getAllConnectedLaptops(allowedUserIds);
    fleetText = `👥 *Authorized User Laptops Status*\n`;
    for (const item of allLaptops) {
      const isYou = item.userId === userId ? ' (You)' : '';
      if (item.hasOnlineDevice) {
        const devNames = item.devices
          .filter((d) => d.isOnline)
          .map((d) => {
            const osPart = d.osVersion ? ` - ${d.osVersion}` : '';
            return `*${d.deviceName}* (\`${d.hostname}\`${osPart})`;
          })
          .join(', ');
        fleetText += `├─ User \`${item.userId}\`${isYou}: 🟢 ${devNames}\n`;
      } else {
        fleetText += `├─ User \`${item.userId}\`${isYou}: 🔴 Offline\n`;
      }
    }
    fleetText += `\n`;
  }

  // 2. Cloud server hosting specs
  const totalMemory = os.totalmem();
  const freeMemory = os.freemem();
  const usedMemory = totalMemory - freeMemory;
  const memoryUsagePercent = ((usedMemory / totalMemory) * 100).toFixed(2);
  const processMemory = process.memoryUsage();
  const botMemoryUsage = (processMemory.heapUsed / 1024 / 1024).toFixed(2);

  const statusMessage =
    `📊 *System & Hardware Status*\n\n` +
    laptopSpecsText +
    fleetText +
    `👤 *Your Personal Settings*\n` +
    `├─ Laptop Folder: ${userDir ? `\`${userDir}\`` : '_Not set yet (use /directory)_'}\n` +
    `├─ Upload Storage: ${modeLabels[userMode] || userMode}\n` +
    `├─ Loaded Document: ${activeDoc?.fileName ? `\`${activeDoc.fileName}\`` : '_None (unloaded)_'}\n` +
    `└─ Active Mode: ${activeModeDisplay}\n\n` +
    `☁️ *Cloud Bot Engine (Render Host)*\n` +
    `├─ Bot Uptime: ${uptimeString}\n` +
    `├─ Host Memory: ${(usedMemory / 1024 / 1024 / 1024).toFixed(2)} GB / ${(totalMemory / 1024 / 1024 / 1024).toFixed(2)} GB (${memoryUsagePercent}%)\n` +
    `├─ Process Heap: ${botMemoryUsage} MB\n` +
    `└─ Conversations: ${conversationHistory.size} active`;

  const statusOptions = { parse_mode: 'Markdown' };
  if (!hasLaptop) {
    statusOptions.reply_markup = new InlineKeyboard()
      .text('💻 Setup My Laptop', `setup_laptop_${userId}`)
      .text('🔄 Refresh Status', `refresh_status_${userId}`);
  }

  await ctx.reply(statusMessage, statusOptions);
});

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

async function parseDocumentBuffer(buffer, fileExtension, fileName = '') {
  if (fileExtension === 'pdf') {
    let text = '';
    try {
      const parser = new PDFParse({ data: Buffer.from(buffer) });
      const result = await parser.getText();
      text = result.text ? result.text.trim() : '';
    } catch (pdfErr) {
      console.warn('PDFParse extraction failed, trying Gemini OCR fallback:', sanitizeError(pdfErr));
    }

    // If text extraction yielded nothing (e.g. scanned document, images of pages, or custom font encoding),
    // fall back to Gemini 3.8 Flash multimodal vision to extract and transcribe the document:
    if (!text && googleAI) {
      try {
        const base64Data = Buffer.from(buffer).toString('base64');
        const geminiRes = await callGeminiWithRetry(() =>
          googleAI.models.generateContent({
            model: 'gemini-3.8-flash',
            contents: [
              {
                role: 'user',
                parts: [
                  {
                    inlineData: {
                      mimeType: 'application/pdf',
                      data: base64Data,
                    },
                  },
                  {
                    text: 'Please thoroughly extract and transcribe all readable text, content, and key information from this PDF document in its original language. Include all sections, headers, and historical details.',
                  },
                ],
              },
            ],
          })
        );
        text = geminiRes.text ? geminiRes.text.trim() : '';
      } catch (ocrErr) {
        console.error('Gemini PDF OCR fallback error:', sanitizeError(ocrErr));
      }
    }

    if (!text) {
      throw new Error('Unable to extract any readable text from this PDF file.');
    }
    return text;
  } else {
    // Decode code and text files (.py, .java, .cpp, .txt, .md, etc.)
    return Buffer.from(buffer).toString('utf-8');
  }
}

let cloudVault = [];
let vaultPinnedMessageId = null;
const localFileHashes = new Map();

async function getLocalFileHashInfo(relPath) {
  try {
    const storageRoot = path.resolve(STORAGE_DIR);
    const fullPath = path.resolve(storageRoot, relPath);
    if (!fullPath.startsWith(storageRoot) || !fs.existsSync(fullPath)) {
      return null;
    }
    const stats = await fsp.stat(fullPath);
    const cached = localFileHashes.get(relPath);
    if (cached && cached.mtime === stats.mtimeMs) {
      return cached;
    }
    const buf = await fsp.readFile(fullPath);
    const rawHash = crypto.createHash('sha256').update(buf).digest('hex');
    const ext = relPath.split('.').pop().toLowerCase();
    let textHash = null;
    if (TEXT_EXTENSIONS.includes(ext) && ext !== 'pdf') {
      textHash = crypto.createHash('sha256').update(buf.toString('utf-8').replace(/\r\n/g, '\n').trim()).digest('hex');
    }
    const info = { mtime: stats.mtimeMs, size: stats.size, rawHash, textHash };
    localFileHashes.set(relPath, info);
    return info;
  } catch {
    return null;
  }
}

async function findDuplicateDocument(rawHash, textHash, currentFileName) {
  // 1. Check Telegram Cloud Vault entries
  for (const entry of cloudVault) {
    if (entry.hash) {
      if (entry.hash === rawHash || entry.hash === rawHash.slice(0, 16)) {
        return { duplicateOf: entry.name, source: 'cloud' };
      }
    }
    if (entry.textHash && textHash && entry.textHash === textHash) {
      return { duplicateOf: entry.name, source: 'cloud' };
    }
    // For legacy entries without hash, check if file exists in local storage
    if (!entry.hash) {
      const localInfo = await getLocalFileHashInfo(entry.name);
      if (localInfo) {
        entry.hash = localInfo.rawHash;
        entry.textHash = localInfo.textHash;
        if (localInfo.rawHash === rawHash || (textHash && localInfo.textHash === textHash)) {
          return { duplicateOf: entry.name, source: 'cloud' };
        }
      }
    }
  }

  // 2. Check local files in Drive D (STORAGE_DIR)
  try {
    const localFiles = await getStoredFiles();
    for (const lf of localFiles) {
      const info = await getLocalFileHashInfo(lf.name);
      if (info) {
        if (info.rawHash === rawHash) {
          return { duplicateOf: lf.name, source: 'local' };
        }
        if (textHash && info.textHash && info.textHash === textHash) {
          return { duplicateOf: lf.name, source: 'local' };
        }
      }
    }
  } catch (err) {
    console.warn('Duplicate check in local storage notice:', sanitizeError(err));
  }

  return null;
}

async function extractDocumentContent(file, ctx, fileExtension) {
  try {
    const fileUrl = await ctx.api.getFile(file.file_id);
    const downloadUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${fileUrl.file_path}`;

    const response = await fetch(downloadUrl);
    if (!response.ok) {
      throw new Error(`Failed to download file from Telegram: ${response.status} ${response.statusText}`);
    }
    const buffer = await response.arrayBuffer();
    const nodeBuffer = Buffer.from(buffer);

    const rawFileName = file.file_name || 'document';
    const safeFileName = path.basename(rawFileName).replace(/[\/\\]/g, '');
    const ext = fileExtension || (fileUrl.file_path ? fileUrl.file_path.split('.').pop().toLowerCase() : '');

    // Compute hashes for content-based deduplication
    const rawHash = crypto.createHash('sha256').update(nodeBuffer).digest('hex');
    let textHash = null;
    if (TEXT_EXTENSIONS.includes(ext) && ext !== 'pdf') {
      textHash = crypto.createHash('sha256').update(nodeBuffer.toString('utf-8').replace(/\r\n/g, '\n').trim()).digest('hex');
    }

    // Determine target storage mode: 'local' (dual save), 'cloud' (cloud only), 'nosave' (local only)
    let targetMode = getUserStorageMode(ctx.from.id);
    const rawCaption = (ctx.message.caption || '').trim();
    if (/\b\/nosave\b/i.test(rawCaption)) {
      targetMode = 'nosave';
    } else if (/\b\/cloud\b/i.test(rawCaption)) {
      targetMode = 'cloud';
    } else if (/\b\/local\b/i.test(rawCaption)) {
      targetMode = 'local';
    }

    const saveToDriveD = targetMode === 'local' || targetMode === 'nosave';
    const saveToCloudVault = targetMode === 'local' || targetMode === 'cloud';

    // Check if an existing file has identical content (even with a different name)
    const duplicateMatch = await findDuplicateDocument(rawHash, textHash, safeFileName);
    const isDuplicate = !!duplicateMatch;
    const duplicateOf = duplicateMatch ? duplicateMatch.duplicateOf : null;

    if (isDuplicate) {
      console.log(`Duplicate content detected: "${safeFileName}" has identical content to "${duplicateOf}". Skipped saving duplicate.`);
    } else {
      // Save to Drive D if mode allows (local or nosave)
      if (saveToDriveD) {
        try {
          const storageRoot = path.resolve(STORAGE_DIR);
          const cat = getFileCategory(ext);
          const targetDir = path.resolve(storageRoot, cat.folder);
          if (!fs.existsSync(targetDir)) {
            await fsp.mkdir(targetDir, { recursive: true });
          }
          const localFilePath = path.resolve(targetDir, safeFileName);
          if (localFilePath.startsWith(storageRoot)) {
            await fsp.writeFile(localFilePath, nodeBuffer);
            console.log(`Auto-saved document to Drive D [${cat.name}]: ${localFilePath}`);
            // Cache the new file's hash info
            const stats = await fsp.stat(localFilePath);
            const relKey = `${cat.folder}/${safeFileName}`;
            localFileHashes.set(relKey, { mtime: stats.mtimeMs, size: stats.size, rawHash, textHash });
            localFileHashes.set(safeFileName, { mtime: stats.mtimeMs, size: stats.size, rawHash, textHash });
          }
        } catch (saveErr) {
          console.warn('Could not auto-save file to Drive D storage:', sanitizeError(saveErr));
        }
      }

      // Save to Telegram Cloud Vault if mode allows (local or cloud)
      if (saveToCloudVault) {
        try {
          const cat = getFileCategory(ext);
          await saveCloudVaultEntry({
            name: safeFileName,
            file_id: file.file_id,
            ext: ext,
            category: cat.id,
            size: file.file_size || buffer.byteLength,
            date: Date.now(),
            hash: rawHash,
            textHash: textHash,
          });
          console.log(`Saved document to Telegram Cloud Vault [${cat.name}]: ${safeFileName}`);
        } catch (vaultErr) {
          console.warn('Could not save file to Telegram Cloud Vault:', sanitizeError(vaultErr));
        }
      }
    }

    const textContent = await parseDocumentBuffer(buffer, ext, safeFileName);
    return {
      content: textContent,
      isDuplicate,
      duplicateOf,
      fileName: safeFileName,
      fileExtension: ext,
      targetMode,
    };
  } catch (error) {
    const sanitizedMsg = sanitizeError(error);
    console.error('Error extracting document content:', sanitizedMsg);
    throw new Error(sanitizedMsg);
  }
}

async function loadLocalDocumentContent(relFilePath) {
  const cleanPath = path.normalize(relFilePath).replace(/^(\.\.[\/\\])+/, '');
  const storageRoot = path.resolve(STORAGE_DIR);
  const filePath = path.resolve(storageRoot, cleanPath);
  if (!filePath.startsWith(storageRoot)) {
    throw new Error('Access denied: invalid file path');
  }
  const ext = cleanPath.split('.').pop().toLowerCase();
  const buffer = await fsp.readFile(filePath);
  return await parseDocumentBuffer(buffer, ext, path.basename(cleanPath));
}

async function persistCloudVault() {
  try {
    await fsp.writeFile(VAULT_FILE, JSON.stringify(cloudVault, null, 2), 'utf-8');
  } catch (err) {
    console.warn('Failed to write cloud_vault.json to disk:', sanitizeError(err));
  }

  // Backup sync to Telegram pinned message so it survives Render ephemeral container resets
  if (allowedUserId) {
    try {
      const summaryList = cloudVault
        .slice(0, 15)
        .map((f) => `• ${f.name} (${formatBytes(f.size)})`)
        .join('\n');
      const moreCount = cloudVault.length > 15 ? `\n...and ${cloudVault.length - 15} more` : '';

      const compactData = JSON.stringify(
        cloudVault.map((f) => ({
          n: f.name,
          f: f.file_id,
          e: f.ext,
          s: f.size,
          d: f.date,
          h: f.hash ? f.hash.slice(0, 16) : undefined,
        }))
      );

      const msgText =
        `☁️ Telegram Cloud Vault Index\n` +
        `📂 Total Files: ${cloudVault.length}\n` +
        `🕒 Updated: ${new Date().toLocaleString()}\n\n` +
        (summaryList ? `${summaryList}${moreCount}\n\n` : `Vault is currently empty.\n\n`) +
        `📌 Keep this message pinned to sync your files across cloud restarts!\n` +
        `VAULT_DATA:\n${compactData}`;

      if (msgText.length < 3900) {
        if (vaultPinnedMessageId) {
          try {
            await bot.api.editMessageText(allowedUserId, vaultPinnedMessageId, msgText);
            return;
          } catch (editErr) {
            vaultPinnedMessageId = null;
          }
        }

        try {
          const chat = await bot.api.getChat(allowedUserId);
          if (chat && chat.pinned_message && chat.pinned_message.text && chat.pinned_message.text.includes('Telegram Cloud Vault Index')) {
            vaultPinnedMessageId = chat.pinned_message.message_id;
            await bot.api.editMessageText(allowedUserId, vaultPinnedMessageId, msgText);
            return;
          }
        } catch {}

        const sent = await bot.api.sendMessage(allowedUserId, msgText, {
          disable_notification: true,
        });
        vaultPinnedMessageId = sent.message_id;
        try {
          await bot.api.pinChatMessage(allowedUserId, sent.message_id, { disable_notification: true });
        } catch {}
      }
    } catch (syncErr) {
      console.warn('Note: Telegram Cloud Vault sync note:', sanitizeError(syncErr));
    }
  }
}

async function restoreVaultFromTelegram() {
  if (!allowedUserId) return false;
  try {
    const chat = await bot.api.getChat(allowedUserId);
    if (!chat || !chat.pinned_message) return false;

    const pinned = chat.pinned_message;
    if (pinned.text && pinned.text.includes('VAULT_DATA:')) {
      const idx = pinned.text.indexOf('VAULT_DATA:');
      const jsonStr = pinned.text.slice(idx + 'VAULT_DATA:'.length).trim();
      const compactList = JSON.parse(jsonStr);
      if (Array.isArray(compactList)) {
        cloudVault = compactList.map((item, i) => ({
          id: String(item.d || Date.now() - i),
          name: item.n || item.name,
          file_id: item.f || item.file_id,
          ext: item.e || item.ext,
          size: item.s || item.size || 0,
          date: item.d || item.date || Date.now(),
          hash: item.h || item.hash || undefined,
        }));
        vaultPinnedMessageId = pinned.message_id;
        await fsp.writeFile(VAULT_FILE, JSON.stringify(cloudVault, null, 2), 'utf-8');
        console.log(`Restored ${cloudVault.length} files from Telegram pinned message into Cloud Vault.`);
        return true;
      }
    }
  } catch (err) {
    console.warn('Note: Cloud Vault sync from Telegram pinned message skipped:', sanitizeError(err));
  }
  return false;
}

async function initCloudVault() {
  try {
    if (fs.existsSync(VAULT_FILE)) {
      const data = await fsp.readFile(VAULT_FILE, 'utf-8');
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed) && parsed.length > 0) {
        cloudVault = parsed;
        console.log(`Loaded ${cloudVault.length} files from local cloud_vault.json`);
      }
    }
  } catch (err) {
    console.warn('Could not read cloud_vault.json:', sanitizeError(err));
  }

  // If local file is empty or missing, attempt to restore from Telegram pinned sync
  if (allowedUserId && cloudVault.length === 0) {
    await restoreVaultFromTelegram();
  }

  // Backfill hashes and categories for existing files from local storage if available
  for (const entry of cloudVault) {
    if (!entry.category) {
      entry.category = getFileCategory(entry.ext).id;
    }
    if (!entry.hash) {
      try {
        const info = await getLocalFileHashInfo(entry.name);
        if (info) {
          entry.hash = info.rawHash;
          entry.textHash = info.textHash;
        }
      } catch {}
    }
  }
}

async function saveCloudVaultEntry({ name, file_id, ext, category, size, date, hash, textHash }) {
  const cat = category || getFileCategory(ext).id;
  const newEntry = {
    id: Date.now().toString(),
    name,
    file_id,
    ext,
    category: cat,
    size: size || 0,
    date: date || Date.now(),
    ...(hash ? { hash } : {}),
    ...(textHash ? { textHash } : {}),
  };

  const existingIdx = cloudVault.findIndex((f) => f.name.toLowerCase() === name.toLowerCase());
  if (existingIdx !== -1) {
    cloudVault[existingIdx] = newEntry;
  } else {
    cloudVault.unshift(newEntry);
  }

  await persistCloudVault();
}

async function loadCloudDocumentContent(fileId, fileExtension, fileName = '') {
  try {
    const fileUrl = await bot.api.getFile(fileId);
    const downloadUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${fileUrl.file_path}`;

    const response = await fetch(downloadUrl);
    if (!response.ok) {
      throw new Error(`Failed to download file from Telegram: ${response.status} ${response.statusText}`);
    }
    const buffer = await response.arrayBuffer();
    return await parseDocumentBuffer(buffer, fileExtension, fileName);
  } catch (error) {
    const sanitizedMsg = sanitizeError(error);
    console.error('Error loading cloud document:', sanitizedMsg);
    throw new Error(sanitizedMsg);
  }
}

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '__pycache__',
  '.venv',
  'venv',
  'dist',
  'build',
  '.claude',
]);

async function getStoredFiles(dir = STORAGE_DIR, baseDir = STORAGE_DIR, depth = 0) {
  try {
    if (depth > 4 || !fs.existsSync(dir)) return [];
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    let files = [];

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) {
          const subFiles = await getStoredFiles(fullPath, baseDir, depth + 1);
          files.push(...subFiles);
        }
      } else if (entry.isFile()) {
        const ext = entry.name.split('.').pop().toLowerCase();
        const stats = await fsp.stat(fullPath);
        const relPath = path.relative(baseDir, fullPath).replace(/\\/g, '/');
        const cat = getFileCategory(ext);
        files.push({
          name: entry.name,
          relPath: relPath,
          ext,
          category: cat.id,
          categoryName: cat.name,
          size: stats.size,
          mtime: stats.mtimeMs,
        });
      }
    }

    if (depth === 0) {
      files.sort((a, b) => b.mtime - a.mtime);
    }
    return files;
  } catch (err) {
    console.error('Error reading storage directory:', sanitizeError(err));
    return [];
  }
}

async function sendLongMessage(ctx, text, options = 'Markdown') {
  const { safeText } = sanitizeAndCheckSecrets(text, 'outgoing_message');
  const parseMode = typeof options === 'string' ? options : (options?.parse_mode || 'Markdown');
  const replyMarkup = typeof options === 'object' ? options?.reply_markup : undefined;
  const disablePreview = typeof options === 'object' ? options?.disable_web_page_preview : undefined;
  const MAX_LEN = 4000;

  if (safeText.length <= MAX_LEN) {
    const replyOpts = {
      ...(parseMode ? { parse_mode: parseMode } : {}),
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      ...(disablePreview !== undefined ? { disable_web_page_preview: disablePreview } : {}),
    };
    try {
      await ctx.reply(safeText, replyOpts);
    } catch {
      await ctx.reply(safeText, replyMarkup ? { reply_markup: replyMarkup } : undefined);
    }
    return;
  }

  const chunks = [];
  for (let i = 0; i < safeText.length; i += MAX_LEN) {
    chunks.push(safeText.slice(i, i + MAX_LEN));
  }

  for (let idx = 0; idx < chunks.length; idx++) {
    const chunk = chunks[idx];
    const isLast = idx === chunks.length - 1;
    const replyOpts = {
      ...(parseMode ? { parse_mode: parseMode } : {}),
      ...(isLast && replyMarkup ? { reply_markup: replyMarkup } : {}),
      ...(disablePreview !== undefined ? { disable_web_page_preview: disablePreview } : {}),
    };
    try {
      await ctx.reply(chunk, replyOpts);
    } catch {
      await ctx.reply(chunk, isLast && replyMarkup ? { reply_markup: replyMarkup } : undefined);
    }
  }
}

async function getOrAutoLoadDocument(userId) {
  if (!userLastDocument.has(userId)) return null;
  const doc = userLastDocument.get(userId);
  if (!doc) return null;

  // Only return documents that were explicitly uploaded in this active session
  if (!doc.explicitUpload) {
    userLastDocument.delete(userId);
    return null;
  }

  const now = Date.now();
  if (doc.lastAccessedAt && now - doc.lastAccessedAt > DOC_SESSION_TIMEOUT_MS) {
    userLastDocument.delete(userId);
    return null;
  }

  doc.lastAccessedAt = now;
  return doc;
}

function sanitizeConversationHistory(history, hasActiveDoc = false) {
  if (!Array.isArray(history) || history.length === 0) return;

  for (const msg of history) {
    if (typeof msg.content === 'string') {
      if (!hasActiveDoc) {
        msg.content = msg.content
          .replace(/If you're asking about something in your Python file,?\s*let me know which line or concept,?\s*and I'll break it down for you\.?/gi, "Please let me know what you'd like me to look at or explain.")
          .replace(/\b(in|about|from|regarding)\s+your\s+Python\s+file\b/gi, '$1 the content')
          .replace(/\byour\s+Python\s+file\b/gi, 'the content')
          .replace(/\bthe\s+Python\s+file\b/gi, 'the content')
          .replace(/\bUntitled-1\.py\b/gi, 'the file');
      }
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === 'text' && typeof part.text === 'string' && !hasActiveDoc) {
          part.text = part.text
            .replace(/If you're asking about something in your Python file,?\s*let me know which line or concept,?\s*and I'll break it down for you\.?/gi, "Please let me know what you'd like me to look at or explain.")
            .replace(/\b(in|about|from|regarding)\s+your\s+Python\s+file\b/gi, '$1 the content')
            .replace(/\byour\s+Python\s+file\b/gi, 'the content')
            .replace(/\bthe\s+Python\s+file\b/gi, 'the content')
            .replace(/\bUntitled-1\.py\b/gi, 'the file');
        }
      }
    }
  }
}

function extractCodeBlocks(text) {
  if (!text || typeof text !== 'string') return [];
  const codeBlockRegex = /```([a-zA-Z0-9_+-]*)\r?\n([\s\S]*?)```/g;
  const blocks = [];
  let match;
  while ((match = codeBlockRegex.exec(text)) !== null) {
    blocks.push({
      lang: (match[1] || '').trim().toLowerCase(),
      code: match[2],
      fullMatch: match[0],
      startIndex: match.index,
      endIndex: match.index + match[0].length,
    });
  }
  return blocks;
}

function sanitizeAndCheckSecrets(text, context = 'content') {
  if (!text || typeof text !== 'string') return { safeText: text, wasClean: true };
  let safeText = text;
  let wasClean = true;

  const secretEnvKeys = [
    'TELEGRAM_BOT_TOKEN',
    'ANTHROPIC_API_KEY',
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
    'STORAGE_DIR',
    'ALLOWED_USER_ID',
    'ALLOWED_USER_IDS',
    'YOUTUBE_COOKIES',
    'LAPTOP_RUNNER_SECRET',
  ];

  for (const envKey of secretEnvKeys) {
    const rawVal = (process.env[envKey] || '').replace(/^["']|["']$/g, '').trim();
    if (!rawVal) continue;
    // Handle comma-separated lists (e.g. ALLOWED_USER_ID="id1,id2")
    const parts = rawVal.split(/[,;\s]+/).map((p) => p.trim()).filter(Boolean);
    const valsToCheck = parts.length > 1 ? [rawVal, ...parts] : [rawVal];
    for (const val of valsToCheck) {
      if (val.length >= 8 && safeText.includes(val)) {
        wasClean = false;
        console.warn(`[SECURITY ALERT] Prevented leak of ${envKey} in ${context}`);
        safeText = safeText.split(val).join('[REDACTED_SECRET]');
      }
    }
  }

  const secretPatterns = [
    // Telegram Bot Tokens: with or without "bot" prefix
    /(?:bot)?\d{8,11}:[A-Za-z0-9_-]{35}/g,
    // Anthropic API Keys (standard and custom proxy)
    /sk-(?:ant-)?[a-zA-Z0-9_\-]{20,}/g,
    // Google / Gemini API Keys (AIza... and AQ....)
    /(?:AIza[0-9A-Za-z-_]{35}|AQ\.[A-Za-z0-9_\-]{30,})/g,
    // YouTube / Google Session Cookies and Sensitive Tokens
    /(?:(?:session_logininfo|LOGIN_INFO|VISITOR_INFO1_LIVE|__Secure-[13]PSID(?:TS|CC)?)\s*[:=\t]\s*)[^\s;&"']{15,}/gi,
  ];

  for (const pat of secretPatterns) {
    if (pat.test(safeText)) {
      wasClean = false;
      console.warn(`[SECURITY ALERT] Prevented secret pattern match in ${context}`);
      safeText = safeText.replace(pat, '[REDACTED_TOKEN]');
    }
  }

  return { safeText, wasClean };
}

function sanitizeError(err) {
  if (!err) return '';
  const msg = typeof err === 'string' ? err : err.message || String(err);
  return sanitizeAndCheckSecrets(msg, 'error_message').safeText;
}

async function bundleCodeWithGemini(claudeResponseText, userPrompt) {
  if (!googleAI) return null;
  const prompt =
    `The user asked: "${userPrompt}"\n\n` +
    `Another AI provided the following game/application code and explanation, but it is split into separate snippets or requires manual assembly:\n\n` +
    `"""\n${claudeResponseText}\n"""\n\n` +
    `Task: Group, combine, and bundle all the code into ONE single, complete, fully-functional, self-contained, directly runnable file (for browser games, merge into one <!DOCTYPE html> with inline <style> and <script>; for Python, merge into one runnable .py script).\n` +
    `Rules:\n` +
    `1. Do NOT omit any logic, functions, styles, or features.\n` +
    `2. Return ONLY the code inside a single markdown code block with the language identifier (e.g. \`\`\`html or \`\`\`python).\n` +
    `3. On the very first line inside the code block, include a filename comment (e.g. <!-- filename: game.html --> or # filename: game.py).\n` +
    `4. Do not include conversational intro or outro.`;

  try {
    const res = await callGeminiWithRetry(() =>
      googleAI.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: prompt,
      })
    );
    const text = (res.text || '').trim();
    return text || null;
  } catch (err) {
    console.error('Gemini code bundling fallback error:', sanitizeError(err));
    return null;
  }
}

async function handleGameAndCodeDelivery(ctx, assistantMessage, userContent) {
  const userPromptText =
    typeof userContent === 'string'
      ? userContent
      : Array.isArray(userContent)
      ? userContent.map((p) => p.text || '').join(' ')
      : '';

  const blocks = extractCodeBlocks(assistantMessage);
  if (blocks.length === 0) return false;

  const isGameQuery = /\b(game|play|playable|arcade|rpg|puzzle|pong|snake|tetris|flappy|tictactoe|pacman|minesweeper|runner|chess|checkers)\b/i.test(
    userPromptText
  );
  const isAppQuery =
    /\b(build|make|create|write|code|generate)\b/i.test(userPromptText) &&
    /\b(app|application|script|tool|program|webpage|page|calculator|clock)\b/i.test(userPromptText);
  const asksSaveToFile = /(save\s+(this\s+)?(as|in|into|to)\s+(a\s+)?(file|index\.html|game\.html|\.html|\.py|\.js))/i.test(
    assistantMessage
  );
  const hasFullHtmlDoc =
    /<!DOCTYPE\s+html/i.test(assistantMessage) ||
    (/<html[\s>]/i.test(assistantMessage) && /<\/html>/i.test(assistantMessage));

  if (!isGameQuery && !isAppQuery && !asksSaveToFile && !hasFullHtmlDoc) {
    return false;
  }

  // 1. Check if Claude already provided a complete self-contained file:
  let finalCode = null;
  let codeLang = 'html';

  const completeHtmlBlock = blocks.find(
    (b) =>
      (b.lang === 'html' || b.code.includes('<!DOCTYPE') || (b.code.includes('<html') && b.code.includes('</html>'))) &&
      b.code.includes('<script') &&
      b.code.length >= 250
  );

  const completePyBlock = blocks.find(
    (b) =>
      (b.lang === 'python' || b.lang === 'py') &&
      (b.code.includes('def ') || b.code.includes('if __name__') || b.code.includes('import ') || b.code.includes('while ')) &&
      b.code.length >= 200
  );

  if (completeHtmlBlock) {
    finalCode = completeHtmlBlock.code;
    codeLang = 'html';
  } else if (completePyBlock) {
    finalCode = completePyBlock.code;
    codeLang = 'python';
  } else if (blocks.length === 1 && blocks[0].code.length >= 250) {
    finalCode = blocks[0].code;
    codeLang = blocks[0].lang || 'html';
  }

  // 2. If Claude was NOT able to provide a single complete file (fragmented snippets or multi-part code):
  // Fall back to Gemini 3.8 Flash to bundle and group into a single file
  if (!finalCode && googleAI) {
    console.log('Claude output requires code bundling; invoking Gemini 3.8 Flash to group into a single file...');
    const geminiBundled = await bundleCodeWithGemini(assistantMessage, userPromptText);
    if (geminiBundled) {
      const geminiBlocks = extractCodeBlocks(geminiBundled);
      if (geminiBlocks.length > 0) {
        finalCode = geminiBlocks[0].code;
        codeLang = geminiBlocks[0].lang || 'html';
      } else if (geminiBundled.includes('<!DOCTYPE') || geminiBundled.includes('<html')) {
        finalCode = geminiBundled;
        codeLang = 'html';
      }
    }
  }

  // Fallback to largest block if Gemini is unavailable
  if (!finalCode) {
    const largestBlock = blocks.reduce((prev, curr) => (curr.code.length > prev.code.length ? curr : prev), blocks[0]);
    finalCode = largestBlock.code;
    codeLang = largestBlock.lang || 'html';
  }

  // 3. Security Check: ensure NO secrets or tokens leak into the file or message
  const { safeText: safeCode, wasClean: codeClean } = sanitizeAndCheckSecrets(finalCode, 'generated_file');
  if (!codeClean) {
    console.warn('[SECURITY] Scrubbed secret pattern from generated file.');
  }

  // 4. Derive an appropriate filename
  let fileName = '';
  const commentNameMatch = safeCode.match(/(?:<!--|[\/\*#])\s*filename:\s*([\w.-]+)/i);
  if (commentNameMatch && commentNameMatch[1]) {
    fileName = commentNameMatch[1].trim();
  } else if (codeLang === 'html' || safeCode.includes('<!DOCTYPE') || safeCode.includes('<html')) {
    const titleMatch = safeCode.match(/<title>(.*?)<\/title>/i);
    if (titleMatch && titleMatch[1]) {
      const slug = titleMatch[1]
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
      fileName = slug ? `${slug}.html` : 'game.html';
    } else {
      fileName = 'game.html';
    }
  } else if (codeLang === 'python' || codeLang === 'py') {
    fileName = 'game.py';
  } else if (codeLang === 'javascript' || codeLang === 'js') {
    fileName = 'game.js';
  } else {
    fileName = `game.${codeLang || 'html'}`;
  }

  const safeFileName = path.basename(fileName).replace(/[\/\\]/g, '') || 'game.html';

  // 5. Package as in-memory Buffer and send via Telegram document (no disk collision, no race conditions)
  try {
    const fileBuffer = Buffer.from(safeCode, 'utf8');

    await ctx.replyWithChatAction('upload_document');
    try {
      await ctx.replyWithDocument(new InputFile(fileBuffer, safeFileName), {
        caption: `🎮 *${safeFileName.replace(/_/g, ' ')}*\nReady to play! Open or run this file on your device.`,
        parse_mode: 'Markdown',
      });
    } catch {
      await ctx.replyWithDocument(new InputFile(fileBuffer, safeFileName), {
        caption: `🎮 ${safeFileName}\nReady to play! Open or run this file on your device.`,
      });
    }

    // 6. Clean companion message for chat: replace the giant raw code blocks with a clean callout
    let companionText = assistantMessage;
    for (const b of blocks) {
      companionText = companionText.replace(
        b.fullMatch,
        `\n\n📦 *Game code packaged into the attached file above! Open or run \`${safeFileName}\` to play.*`
      );
    }
    companionText = companionText.trim();
    if (!companionText || companionText.length < 5) {
      companionText = `🎮 *Your game has been created and sent as a file above!* Simply open or run \`${safeFileName}\` to play.`;
    }

    const { safeText: safeCompanionText } = sanitizeAndCheckSecrets(companionText, 'companion_message');
    await sendLongMessage(ctx, safeCompanionText);

    return true;
  } catch (err) {
    console.error('Error delivering game/code file to Telegram:', sanitizeError(err));
    return false;
  }
}

async function sendToClaudeWithHistory(ctx, content, systemOverride = null) {
  const userId = ctx.from.id;
  const q = getUserQueue(userId);
  const wasAlreadyProcessing = q.isProcessing;
  q.isProcessing = true;

  const now = Date.now();
  const lastActive = userLastInteraction.get(userId) || 0;
  if (lastActive > 0 && now - lastActive > CONVERSATION_SESSION_TIMEOUT_MS) {
    // Session expiration: reset conversation history and loaded document
    conversationHistory.delete(userId);
    userLastDocument.delete(userId);
    scheduleConversationHistoryPersistence();
  }
  userLastInteraction.set(userId, now);

  const isMultimodal = Array.isArray(content) && content.some((part) => part.type === 'image');
  if (isMultimodal) {
    // Visual media query: immediately unload active document so it never pollutes visual queries
    userLastDocument.delete(userId);
  }

  if (!conversationHistory.has(userId)) {
    conversationHistory.set(userId, []);
  }

  const activeDoc = await getOrAutoLoadDocument(userId);
  const history = conversationHistory.get(userId);

  // Guarantee history starts with a user message for Anthropic API requirements
  while (history.length > 0 && history[0].role !== 'user') {
    history.shift();
  }

  // Sanitize prior turns in history so stale/hallucinated Python references don't poison new queries
  sanitizeConversationHistory(history, !!activeDoc);

  history.push({
    role: 'user',
    content: content,
  });

  const typingInterval = setInterval(() => {
    ctx.replyWithChatAction('typing').catch(() => {});
  }, 4000);

  try {
    let systemInstruction =
      'You are a helpful, expert AI assistant. Keep responses direct, clear, and thoughtful.\n\n' +
      'CONVERSATION CONTINUITY & MEMORY:\n' +
      '• You maintain an ongoing, full-context conversation with this user.\n' +
      '• Read and consider the ENTIRE previous dialogue in `messages` to understand the full context.\n' +
      '• When the user asks follow-up questions, refers to "earlier", "what you said", pronouns ("it", "they", "that"), or builds upon previous topics, seamlessly draw upon the context of the entire conversation without asking them to re-explain.\n\n' +
      'LANGUAGE & TRANSLATION GUIDANCE:\n' +
      '• When the user asks to translate or shares phonetic phrases, romaji, lyrics, slang, or foreign words (e.g. Japanese, Khmer, Spanish, French, etc.):\n' +
      '  - Never give flat refusals or say you cannot translate simply because spelling or romanization is informal, phonetic, or approximate.\n' +
      '  - Be perceptive: identify the most probable intended phrase, song lyric (e.g. anime, J-pop, trending TikTok/Reels sounds), or idiom.\n' +
      '  - Provide the most likely translation, the correct spelling in native script (kanji/hiragana/katakana, etc.), the standard romanization, and helpful context (e.g. song title or origin).\n\n' +
      'IMAGE & SCREENSHOT ANALYSIS GUIDANCE:\n' +
      '• When the user sends a photo, screenshot, image, or asks a question about an image (e.g. "what does this mean?", "explain this", "transcribe this"):\n' +
      '  - Focus directly on analyzing, reading, transcribing, translating, or explaining the visual contents of the image or screenshot.\n' +
      '  - NEVER assume, suggest, or ask if the user is referring to a "Python file", code file, or workspace document unless the user explicitly asks about code in their prompt.\n' +
      '  - If something in an image is unclear or cannot be determined, directly state what is unclear about the image itself. NEVER speculate about unrelated files or previous coding tasks.\n\n' +
      'STRICT CONTEXT ACCURACY:\n' +
      '• NEVER assume or hallucinate the existence of external files, documents, or "Python file" unless one is explicitly loaded and provided in this prompt.\n' +
      '• Do not invent references to code files, programming scripts, or past files when responding to photos, screenshots, or general chat questions.\n\n' +
      'GAME & APPLICATION CREATION GUIDANCE:\n' +
      '• When the user asks to build, create, or code a game, tool, or interactive application (e.g. "create a game", "build snake in html", "make a python game"):\n' +
      '  - Provide complete, self-contained, directly playable/runnable code with zero missing logic or placeholders.\n' +
      '  - For browser/web games: Prefer pure HTML5 Canvas, SVG, or DOM and Vanilla JavaScript with zero external CDN dependencies. Avoid heavy external game engines (like Phaser or Three.js) unless specifically requested, because external CDN scripts fail offline and nested container systems cause invisible click-blocking bugs. Always implement responsive scaling with touch/tap controls for mobile and mouse/keyboard for desktop.\n' +
      '  - Always package the complete HTML, CSS (<style>), and JavaScript (<script>) into ONE single self-contained <!DOCTYPE html> document inside a single ```html code block so it runs instantly.\n' +
      '  - For Python games: Provide a single self-contained runnable script inside a ```python code block.\n' +
      '  - At the very top inside the code block, specify a filename comment (e.g. <!-- filename: snake-game.html --> or # filename: space_game.py).\n' +
      '  - In your text message, give a brief overview and player controls (e.g. Arrow keys, Spacebar to jump).\n\n' +
      'AI IMAGE GENERATION GUIDANCE:\n' +
      '• You do NOT generate pictures or images directly in chat.\n' +
      '• Image generation is handled exclusively by the dedicated bot command:\n' +
      '  - If the user asks you to generate, create, make, or draw pictures or images, instruct them to use `/image <prompt>` (powered by Gemini Nano Banana).\n' +
      '  - If the user asks about generating videos, let them know AI video generation is not supported and they can generate pictures using `/image <prompt>`.\n\n' +
      'REMOTE LAPTOP CONTROL & AUTOMATIC SCRIPT INSTALLATION:\n' +
      '• Each user can link their own laptop to this bot using `start-agent.bat`.\n' +
      '• If the user asks to create a file or python script, install packages (via pip or npm), or run a script on their laptop:\n' +
      '  - Always provide the clean, complete code.\n' +
      '  - Mention that they can send `/agent <request>` (or enable `/agent_mode`), and the bot will autonomously create the file on their laptop, install packages with pip/npm, and execute the script for them!';

    if (activeDoc && !isMultimodal) {
      const docExcerpt =
        activeDoc.content.length > 25000
          ? activeDoc.content.slice(0, 25000) + '\n\n[... Document excerpted to first 25,000 characters ...]'
          : activeDoc.content;
      systemInstruction +=
        `\n\nThe user explicitly uploaded this file for reference in the active session:\n` +
        `File Name: "${activeDoc.fileName}" (${activeDoc.fileExtension})\n` +
        `Content:\n\`\`\`\n${docExcerpt}\n\`\`\`\n` +
        `If the user's question specifically relates to this uploaded file, refer to it. Otherwise, answer their query normally without forcing references to this file.`;
    }
    if (systemOverride) {
      systemInstruction = systemOverride;
    }

    let response;
    try {
      response = await anthropic.messages.create({
        model: anthropicModel,
        max_tokens: ANTHROPIC_MAX_TOKENS,
        system: systemInstruction,
        messages: history,
      });
    } catch (tokenErr) {
      if (ANTHROPIC_MAX_TOKENS > 8192 && /max_tokens/i.test(tokenErr?.message || '')) {
        console.warn(`Model ${anthropicModel} rejected ${ANTHROPIC_MAX_TOKENS} tokens; retrying with 8192...`);
        response = await anthropic.messages.create({
          model: anthropicModel,
          max_tokens: 8192,
          system: systemInstruction,
          messages: history,
        });
      } else {
        throw tokenErr;
      }
    }

    clearInterval(typingInterval);

    // Safely extract text blocks, ignoring thinking/reasoning blocks
    const textBlocks = response.content?.filter((block) => block.type === 'text') || [];
    const assistantMessage =
      textBlocks.map((block) => block.text).join('\n').trim() ||
      'Sorry, I could not generate a response.';

    history.push({
      role: 'assistant',
      content: assistantMessage,
    });

    while (history.length > MAX_HISTORY_MESSAGES) {
      history.splice(0, 2);
    }
    while (history.length > 0 && history[0].role !== 'user') {
      history.shift();
    }

    // Persist conversation history to disk
    scheduleConversationHistoryPersistence();

    // Prune older base64 image payloads to save tokens, but ALWAYS preserve the most recent image
    // so follow-up questions ("what does this mean?", "explain this error") retain visual context.
    const imageMsgIndices = [];
    for (let i = 0; i < history.length; i++) {
      const msg = history[i];
      if (Array.isArray(msg.content) && msg.content.some((part) => part.type === 'image')) {
        imageMsgIndices.push(i);
      }
    }

    if (imageMsgIndices.length > 1) {
      const latestImageIdx = imageMsgIndices[imageMsgIndices.length - 1];
      for (const idx of imageMsgIndices) {
        if (idx !== latestImageIdx && idx < history.length - 6) {
          const msg = history[idx];
          msg.content = msg.content
            .filter((part) => part.type !== 'image')
            .concat([{ type: 'text', text: '[Earlier image already analyzed above]' }]);
        }
      }
    }

    const deliveredAsFile = await handleGameAndCodeDelivery(ctx, assistantMessage, content);
    if (!deliveredAsFile) {
      const { safeText: safeAssistantMsg } = sanitizeAndCheckSecrets(assistantMessage, 'chat_reply');
      await sendLongMessage(ctx, safeAssistantMsg);
    }
  } catch (error) {
    console.error('Error calling Claude API:', error.status, sanitizeError(error));

    // If Claude API fails (e.g. 400 "The requested model is not available", rate limit, or proxy outage),
    // automatically and gracefully fall back to Gemini 3.8 Flash so the user receives a seamless response
    if (googleAI) {
      console.log('Claude API unavailable; falling back to Gemini 3.8 Flash for user response...');
      try {
        const userPromptStr = typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? content.map(p => p.text || '').join('\n')
            : String(content || '');

        const geminiFallbackPrompt =
          `${systemInstruction}\n\n` +
          `User prompt: ${userPromptStr}\n\n` +
          `Respond helpfully and thoroughly as the AI assistant.`;

        const geminiRes = await callGeminiWithRetry(() =>
          googleAI.models.generateContent({
            model: 'gemini-3.8-flash',
            contents: geminiFallbackPrompt,
            config: {
              maxOutputTokens: 20000,
            },
          })
        );

        const geminiReply = geminiRes?.text?.trim() || 'Sorry, I could not generate a response.';
        history.push({
          role: 'assistant',
          content: geminiReply,
        });
        scheduleConversationHistoryPersistence();

        const deliveredAsFile = await handleGameAndCodeDelivery(ctx, geminiReply, content);
        if (!deliveredAsFile) {
          const { safeText: safeAssistantMsg } = sanitizeAndCheckSecrets(geminiReply, 'chat_reply');
          await sendLongMessage(ctx, safeAssistantMsg);
        }
        return;
      } catch (geminiFallbackErr) {
        console.error('Gemini fallback failed as well:', sanitizeError(geminiFallbackErr));
      }
    }

    history.pop();
    scheduleConversationHistoryPersistence();

    await ctx.reply(
      '❌ Sorry, I encountered an error processing your request. Please try again.',
      { parse_mode: 'Markdown' }
    );
  } finally {
    clearInterval(typingInterval);
    if (!wasAlreadyProcessing) {
      q.isProcessing = false;
      if (q.items.length > 0 && !q.timer && q.activeDownloads === 0) {
        triggerUserQueueExecution(userId).catch((err) => {
          console.error(`Error in chained user queue execution for ${userId}:`, sanitizeError(err));
        });
      }
    }
  }
}

bot.on('message:document', async (ctx) => {
  const document = ctx.message.document;
  const rawFileName = document.file_name || 'document';
  const fileName = path.basename(rawFileName).replace(/[\/\\]/g, '');
  const fileExtension = fileName.split('.').pop().toLowerCase();
  const cat = getFileCategory(fileExtension);

  if (IMAGE_EXTENSIONS.includes(fileExtension)) {
    await handleImageDocument(ctx, document, fileName, fileExtension);
    return;
  }

  // Silent typing indicator - no chatter messages
  await ctx.replyWithChatAction('typing');

  try {
    const docResult = await extractDocumentContent(document, ctx, fileExtension);

    // Save document to memory so all subsequent chat questions in active session have this context
    userLastDocument.set(ctx.from.id, {
      fileName: docResult.isDuplicate ? docResult.duplicateOf : fileName,
      fileExtension,
      content: docResult.content,
      uploadedAt: Date.now(),
      lastAccessedAt: Date.now(),
      explicitUpload: true,
    });

    const rawCaption = (ctx.message.caption || '').trim();
    const promptCaption = rawCaption.replace(/^\/(nosave|cloud|local)\s*/i, '').trim();

    if (promptCaption) {
      // User sent a specific prompt or question with the file: answer it directly!
      await sendToClaudeWithHistory(ctx, promptCaption);
    } else if (docResult.isDuplicate) {
      // Duplicate file detected: inform user that duplicate wasn't saved, but it's ready for chat
      const icon = cat.icon || '📁';
      await ctx.reply(
        `${icon} *Identical content detected!*\n\n` +
        `\`${fileName}\` has the exact same content as \`${docResult.duplicateOf}\` already in your library.\n\n` +
        `• 🛡️ *No duplicate saved* (storage preserved).\n` +
        `• 🧠 Activated in chat — you can ask questions about it or type /quiz right now!\n` +
        `• Browse your library anytime with /library.`,
        { parse_mode: 'Markdown' }
      );
    } else {
      // User simply uploaded the file: confirm save with exact storage destination
      const icon = cat.icon || '📁';
      let destText = '';
      if (docResult.targetMode === 'cloud') {
        destText = '• ☁️ **Telegram Cloud Vault only**: Saved to cloud (laptop storage untouched).\n';
      } else if (docResult.targetMode === 'nosave') {
        destText = '• 💻 **Drive D only**: Saved to laptop storage (cloud save skipped via `/nosave`).\n';
      } else {
        destText =
          '• ☁️ **Telegram Cloud Vault**: Ready on your phone & any device 24/7.\n' +
          '• 💻 **Drive D**: Saved to laptop storage.\n';
      }

      await ctx.reply(
        `${icon} *Saved \`${fileName}\` to category: ${cat.name}*\n\n` +
        destText +
        `\n• Ask me anything about it in chat.\n` +
        `• Type /quiz if you want to test your understanding.\n` +
        `• Or browse all files anytime with /library.`,
        { parse_mode: 'Markdown' }
      );
    }
  } catch (error) {
    console.error('Error processing document:', sanitizeError(error));
    await ctx.reply(
      '❌ Sorry, I encountered an error saving or reading the file. Please try again.',
      { parse_mode: 'Markdown' }
    );
  }
});

async function callGeminiWithRetry(fn, maxRetries = 3, initialDelay = 1500) {
  let delay = initialDelay;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isRetryable =
        err.status === 503 ||
        err.status === 429 ||
        err.message?.includes('503') ||
        err.message?.includes('high demand');
      if (isRetryable && attempt < maxRetries) {
        console.warn(`[Gemini] Temporary error (attempt ${attempt}/${maxRetries}), retrying in ${delay}ms...`);
        await new Promise((r) => setTimeout(r, delay));
        delay *= 2;
        continue;
      }
      throw err;
    }
  }
}

async function transcribeAudioWithGemini(base64Audio, mimeType) {
  const contents = [
    {
      role: 'user',
      parts: [
        {
          inlineData: {
            mimeType: mimeType,
            data: base64Audio,
          },
        },
        {
          text:
            'Please transcribe this spoken audio message accurately and verbatim.\n' +
            'Return ONLY the plain transcription text. Do not add conversational remarks, introductory text, markdown quotes, or timestamps.\n' +
            'If the audio is completely silent or contains only inaudible noise with no discernible speech, return: [NO_SPEECH]',
        },
      ],
    },
  ];

  const response = await callGeminiWithRetry(() =>
    googleAI.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: contents,
    })
  );

  return (response.text || '').trim();
}

async function handleVoiceMessage(ctx) {
  const voice = ctx.message.voice || ctx.message.audio;
  if (!voice) return;

  const releaseDownload = registerPendingDownload(ctx.from.id, ctx);

  const typingInterval = setInterval(() => {
    ctx.replyWithChatAction('typing').catch(() => {});
  }, 4000);

  try {
    const fileInfo = await ctx.api.getFile(voice.file_id);
    const downloadUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${fileInfo.file_path}`;

    const fileRes = await fetch(downloadUrl);
    if (!fileRes.ok) {
      throw new Error(`Failed to download audio file: ${fileRes.statusText}`);
    }
    const arrayBuffer = await fileRes.arrayBuffer();
    const audioBuffer = Buffer.from(arrayBuffer);

    // If user has Gemini Live mode enabled, attempt Gemini 3.8 Live direct spoken reply
    const userId = ctx.from.id;
    if (isUserLiveModeEnabled(userId)) {
      ctx.replyWithChatAction('record_voice').catch(() => {});
      try {
        const userVoice = getUserVoice(userId);
        const liveResult = await executeGeminiLiveExchange({
          audioBuffer,
          voice: userVoice,
        });

        if (liveResult.voiceBuffer) {
          clearInterval(typingInterval);
          await ctx.replyWithVoice(new InputFile(liveResult.voiceBuffer, 'gemini_live.ogg'), {
            caption: liveResult.replyText ? `🎙️ *Gemini 3.8 Live (${userVoice}):*\n${liveResult.replyText}` : undefined,
            parse_mode: 'Markdown',
          });

          const history = conversationHistory.get(userId) || [];
          history.push({ role: 'user', content: '[Spoken Voice Note]' });
          history.push({ role: 'assistant', content: liveResult.replyText || '[Voice Note Reply]' });
          conversationHistory.set(userId, history);
          scheduleConversationHistoryPersistence();
          return;
        }
      } catch (liveErr) {
        console.warn('[Gemini Live] Live exchange error, falling back to standard pipeline:', sanitizeError(liveErr));
      }
    }

    const base64Audio = audioBuffer.toString('base64');

    let mimeType = voice.mime_type || 'audio/ogg';
    if (fileInfo.file_path.endsWith('.oga') || fileInfo.file_path.endsWith('.ogg')) {
      mimeType = 'audio/ogg';
    } else if (fileInfo.file_path.endsWith('.mp3')) {
      mimeType = 'audio/mp3';
    } else if (fileInfo.file_path.endsWith('.wav')) {
      mimeType = 'audio/wav';
    }

    const transcription = await transcribeAudioWithGemini(base64Audio, mimeType);
    clearInterval(typingInterval);

    if (!transcription || transcription.includes('[NO_SPEECH]')) {
      await ctx.reply('🎤 *Could not detect any clear speech in that voice note.* Please try again.', {
        parse_mode: 'Markdown',
      });
      return;
    }

    // Display transcription to the user so they know what was heard
    try {
      await ctx.reply(`🎤 *You said:* "${transcription}"`, { parse_mode: 'Markdown' });
    } catch {
      await ctx.reply(`🎤 You said: "${transcription}"`);
    }

    // Forward the transcription directly through the debounce queue with full conversation history
    enqueueUserMessage(ctx.from.id, {
      type: 'text',
      text: transcription,
    }, ctx);
  } catch (error) {
    console.error('Error handling hybrid voice message:', sanitizeError(error));
    await ctx.reply('❌ Sorry, I encountered an error processing your voice note. Please try again.', {
      parse_mode: 'Markdown',
    });
  } finally {
    clearInterval(typingInterval);
    releaseDownload();
  }
}

async function handlePhotoMessage(ctx) {
  const photos = ctx.message.photo;
  if (!photos || photos.length === 0) return;

  userLastDocument.delete(ctx.from.id);
  const releaseDownload = registerPendingDownload(ctx.from.id, ctx);

  const typingInterval = setInterval(() => {
    ctx.replyWithChatAction('typing').catch(() => {});
  }, 4000);

  try {
    // Select highest resolution photo
    const photo = photos[photos.length - 1];
    const fileInfo = await ctx.api.getFile(photo.file_id);
    const downloadUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${fileInfo.file_path}`;

    const fileRes = await fetch(downloadUrl);
    if (!fileRes.ok) {
      throw new Error(`Failed to download photo: ${fileRes.statusText}`);
    }
    const arrayBuffer = await fileRes.arrayBuffer();
    const base64Data = Buffer.from(arrayBuffer).toString('base64');

    let mimeType = 'image/jpeg';
    const filePathLower = (fileInfo.file_path || '').toLowerCase();
    if (filePathLower.endsWith('.png')) {
      mimeType = 'image/png';
    } else if (filePathLower.endsWith('.webp')) {
      mimeType = 'image/webp';
    } else if (filePathLower.endsWith('.gif')) {
      mimeType = 'image/gif';
    }

    const caption = (ctx.message.caption || '').trim();
    clearInterval(typingInterval);
    enqueueUserMessage(ctx.from.id, {
      type: 'photo',
      base64Data,
      mimeType,
      caption,
    }, ctx);
  } catch (error) {
    console.error('Error handling photo message:', sanitizeError(error));
    await ctx.reply('❌ Sorry, I encountered an error processing your photo. Please try again.', {
      parse_mode: 'Markdown',
    });
  } finally {
    clearInterval(typingInterval);
    releaseDownload();
  }
}

async function handleImageDocument(ctx, document, fileName, fileExtension) {
  userLastDocument.delete(ctx.from.id);
  const releaseDownload = registerPendingDownload(ctx.from.id, ctx);

  const typingInterval = setInterval(() => {
    ctx.replyWithChatAction('typing').catch(() => {});
  }, 4000);

  try {
    const fileInfo = await ctx.api.getFile(document.file_id);
    const downloadUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${fileInfo.file_path}`;

    const fileRes = await fetch(downloadUrl);
    if (!fileRes.ok) {
      throw new Error(`Failed to download image file: ${fileRes.statusText}`);
    }
    const arrayBuffer = await fileRes.arrayBuffer();
    const base64Data = Buffer.from(arrayBuffer).toString('base64');

    let mimeType = 'image/jpeg';
    if (fileExtension === 'png') {
      mimeType = 'image/png';
    } else if (fileExtension === 'webp') {
      mimeType = 'image/webp';
    } else if (fileExtension === 'gif') {
      mimeType = 'image/gif';
    }

    const caption = (ctx.message.caption || '').trim();
    const promptText = caption || `Image file: ${fileName}`;

    clearInterval(typingInterval);
    enqueueUserMessage(ctx.from.id, {
      type: 'photo',
      base64Data,
      mimeType,
      caption: promptText,
    }, ctx);
  } catch (error) {
    console.error('Error handling image document:', sanitizeError(error));
    await ctx.reply('❌ Sorry, I encountered an error reading your image. Please try again.', {
      parse_mode: 'Markdown',
    });
  } finally {
    clearInterval(typingInterval);
    releaseDownload();
  }
}

async function generateQuizQuestions(contextText) {
  const quizPrompt =
    `You are an expert technical instructor. Based on the following code or document content, create exactly 3 multiple-choice quiz questions to test understanding.\n\n` +
    `${contextText}\n\n` +
    `CRITICAL REQUIREMENTS:\n` +
    `1. Return ONLY a valid JSON array of objects. No markdown backticks, no comments, no intro or outro text.\n` +
    `2. Follow this exact JSON structure:\n` +
    `[\n` +
    `  {\n` +
    `    "question": "Question text here (max 280 characters)",\n` +
    `    "options": ["Option 1", "Option 2", "Option 3", "Option 4"],\n` +
    `    "correct_option_id": 0,\n` +
    `    "explanation": "Brief explanation of why this answer is correct (max 180 characters)"\n` +
    `  }\n` +
    `]\n` +
    `3. Provide 2 to 4 clear options per question.\n` +
    `4. "correct_option_id" must be an integer (0, 1, 2, or 3) indicating the correct choice index.\n` +
    `5. "explanation" must be informative and under 180 characters.`;

  // Gemini 3.8 Flash exclusively generates the quiz (preserving 100% of Claude balance)
  const res = await callGeminiWithRetry(() =>
    googleAI.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: quizPrompt,
    })
  );

  const rawText = (res.text || '')
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  const match = rawText.match(/\[\s*\{[\s\S]*\}\s*\]/);
  if (match) {
    const parsed = JSON.parse(match[0]);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed;
    }
  }

  throw new Error('Gemini failed to format quiz questions array');
}

async function sendQuizPolls(ctx, quizList) {
  for (let i = 0; i < quizList.length; i++) {
    const q = quizList[i];
    const questionText = `${i + 1}. ${q.question}`.slice(0, 300);
    const options = (q.options || []).slice(0, 10).map((opt) => String(opt).slice(0, 100));
    const correctId = Math.min(Math.max(0, parseInt(q.correct_option_id) || 0), options.length - 1);
    const explanation = (q.explanation || 'Correct answer!').slice(0, 200);

    await ctx.api.sendPoll(ctx.chat.id, questionText, options, {
      type: 'quiz',
      correct_option_id: correctId,
      explanation: explanation,
      is_anonymous: false,
    });

    // Brief delay so polls arrive in clean sequential order
    await new Promise((resolve) => setTimeout(resolve, 600));
  }
}

bot.command('quiz', async (ctx) => {
  const userId = ctx.from.id;
  userActiveMode.delete(userId);
  const topicArg = ctx.message.text.replace(/^\/quiz\s*/i, '').trim();
  let lastDoc = await getOrAutoLoadDocument(userId);

  if (!topicArg && !lastDoc) {
    await ctx.reply(
      '📚 *No document is currently active in chat.*\n\n' +
      'To take a quiz, you can:\n' +
      '• Type /library to select a file from Telegram Cloud Vault or Drive D\n' +
      '• Upload a new PDF or code file directly to chat\n' +
      '• Or run `/quiz <topic>` right now (e.g. `/quiz Python basics` or `/quiz C++ pointers`)',
      { parse_mode: 'Markdown' }
    );
    return;
  }

  await ctx.replyWithChatAction('typing');

  try {
    let contextText = '';
    if (topicArg) {
      contextText = `Topic: "${topicArg}"`;
    } else {
      contextText = `Document: "${lastDoc.fileName}"\n\nContent:\n${lastDoc.content.slice(0, 15000)}`;
      await ctx.reply(`🎯 *Generating quiz on:* \`${lastDoc.fileName}\``, { parse_mode: 'Markdown' });
    }

    const quizList = await generateQuizQuestions(contextText);
    await sendQuizPolls(ctx, quizList);
  } catch (err) {
    console.error('Error generating quiz polls:', sanitizeError(err));
    await ctx.reply(
      '❌ Sorry, I had trouble creating the quiz questions. Please try again or specify a topic like `/quiz python basics`.',
      { parse_mode: 'Markdown' }
    );
  }
});

// Helper functions for isolated per-user cached files
function getUserCachedFiles(userId) {
  return userCachedFilesList.get(userId) || null;
}
function setUserCachedFiles(userId, files) {
  userCachedFilesList.set(userId, files);
}

function buildCategoriesKeyboard(files, source) {
  const counts = {
    pdf: 0,
    python: 0,
    code: 0,
    docs: 0,
    images: 0,
    media: 0,
    other: 0,
  };

  for (const f of files) {
    const catId = f.category || getFileCategory(f.ext).id;
    if (counts[catId] !== undefined) {
      counts[catId]++;
    } else {
      counts.other++;
    }
  }

  const keyboard = new InlineKeyboard();

  if (counts.pdf > 0) {
    keyboard.text(`📄 PDF Documents (${counts.pdf})`, `lib_cat:${source}:pdf`).row();
  }
  if (counts.python > 0) {
    keyboard.text(`🐍 Python Scripts (${counts.python})`, `lib_cat:${source}:python`).row();
  }
  if (counts.code > 0) {
    keyboard.text(`💻 Code Files (${counts.code})`, `lib_cat:${source}:code`).row();
  }
  if (counts.docs > 0) {
    keyboard.text(`📝 Documents & Text (${counts.docs})`, `lib_cat:${source}:docs`).row();
  }
  if (counts.media > 0) {
    keyboard.text(`🎥 Videos & Audio (${counts.media})`, `lib_cat:${source}:media`).row();
  }
  if (counts.images > 0) {
    keyboard.text(`🖼️ Photos & Images (${counts.images})`, `lib_cat:${source}:images`).row();
  }
  if (counts.other > 0) {
    keyboard.text(`❓ Other / Unknown (${counts.other})`, `lib_cat:${source}:other`).row();
  }

  keyboard.text(`🌐 All Files A-Z (${files.length})`, `lib_cat:${source}:all`).row();

  if (source === 'cloud') {
    keyboard.text('◀️ Back to Cloud Hub', 'storage_cloud');
  } else {
    keyboard.text('📁 Change Storage Source', 'lib_sources');
  }

  return keyboard;
}

function buildCategoryFilesKeyboard(files, source, categoryId, page = 0) {
  const keyboard = new InlineKeyboard();
  const pageSize = 5;

  let filtered = [];
  let catName = 'All Files';
  if (categoryId === 'all') {
    filtered = [...files];
    catName = '🌐 All Files';
  } else {
    filtered = files.filter((f) => (f.category || getFileCategory(f.ext).id) === categoryId);
    catName = FILE_CATEGORIES[categoryId]?.name || categoryId;
  }

  // Requirement 2: Sort files from A to Z alphabetically!
  filtered.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })
  );

  const totalPages = Math.ceil(filtered.length / pageSize) || 1;
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  const start = safePage * pageSize;
  const pageFiles = filtered.slice(start, start + pageSize);

  for (let i = 0; i < pageFiles.length; i++) {
    const f = pageFiles[i];
    const masterIdx = files.indexOf(f);
    const cat = FILE_CATEGORIES[f.category || getFileCategory(f.ext).id] || FILE_CATEGORIES.other;
    const displayName = f.name.length > 28 ? '...' + f.name.slice(-25) : f.name;
    keyboard.text(`${cat.icon} ${displayName}`, `lib_sel:${source}:${masterIdx}`).row();
  }

  // Pagination navigation
  const navButtons = [];
  if (safePage > 0) {
    navButtons.push(InlineKeyboard.text('◀️ Prev', `lib_cat_page:${source}:${categoryId}:${safePage - 1}`));
  }
  if (safePage < totalPages - 1) {
    navButtons.push(InlineKeyboard.text('Next ▶️', `lib_cat_page:${source}:${categoryId}:${safePage + 1}`));
  }
  if (navButtons.length > 0) {
    keyboard.row(...navButtons);
  }

  keyboard.row(
    InlineKeyboard.text('📂 Categories', source === 'cloud' ? 'cloud_files_cats' : 'lib_src:local'),
    InlineKeyboard.text('🔄 Refresh', `lib_cat_page:${source}:${categoryId}:${safePage}`)
  );

  return { keyboard, totalPages, totalCount: filtered.length, catName, page: safePage };
}

function buildSearchHistoryKeyboard(page = 0) {
  const { items, totalPages, total, page: safePage } = getSearchHistoryPage(page, 5);
  const keyboard = new InlineKeyboard();

  for (const item of items) {
    const icon =
      item.type === 'youtube'
        ? '🎥'
        : item.type === 'download'
        ? '📥'
        : '🌐';
    const displayTitle = item.query.length > 26 ? item.query.slice(0, 24) + '...' : item.query;
    keyboard.text(`${icon} ${displayTitle}`, `view_hist:${item.id}`).row();
  }

  const navButtons = [];
  if (safePage > 0) {
    navButtons.push(InlineKeyboard.text('◀️ Prev', `cloud_hist_page:${safePage - 1}`));
  }
  if (safePage < totalPages - 1) {
    navButtons.push(InlineKeyboard.text('Next ▶️', `cloud_hist_page:${safePage + 1}`));
  }
  if (navButtons.length > 0) {
    keyboard.row(...navButtons);
  }

  keyboard.row(
    InlineKeyboard.text('🗑️ Clear History', 'confirm_clear_hist'),
    InlineKeyboard.text('◀️ Cloud Hub', 'storage_cloud')
  );

  return { keyboard, totalPages, total, page: safePage };
}

function buildSourcePickerKeyboard(userId = null) {
  const currentMode = userId ? getUserStorageMode(userId) : 'local';
  const modeShort = currentMode === 'cloud' ? '☁️ Cloud' : currentMode === 'nosave' ? '💻 Local Only' : '💻+☁️ Dual';
  const userDir = userId ? getUserStorageDir(userId) : null;
  const localLabel = userDir ? `💻 Local Storage (${path.basename(userDir) || 'Folder'})` : '💻 Local Storage (Set Folder)';
  return new InlineKeyboard()
    .text(`☁️ Telegram Cloud Vault (${cloudVault.length})`, 'storage_cloud')
    .row()
    .text(localLabel, 'lib_src:local')
    .row()
    .text('📁 Set / Change Local Folder', 'change_local_dir')
    .row()
    .text(`⚙️ Upload Destination: ${modeShort}`, 'open_storage_settings');
}

bot.command(['library', 'files'], async (ctx) => {
  const userId = ctx.from.id;
  userActiveMode.delete(userId);
  const keyboard = buildSourcePickerKeyboard(userId);
  const userDir = getUserStorageDir(userId);
  const dirDisplay = userDir ? `\`${userDir}\`` : '_Not set yet (tap button below)_';
  await ctx.reply(
    `📚 *Document & File Library*\n\n` +
    `Choose a storage location to browse (Files organized by category, sorted A-Z):\n\n` +
    `• ☁️ **Telegram Cloud Vault** (${cloudVault.length} file${cloudVault.length === 1 ? '' : 's'})\n` +
    `  Accessible 24/7 on your phone & any device.\n\n` +
    `• 💻 **Local Storage**\n` +
    `  Physical files located in ${dirDisplay} on your laptop.`,
    {
      parse_mode: 'Markdown',
      reply_markup: keyboard,
    }
  );
});

bot.on('callback_query:data', async (ctx) => {
  const data = ctx.callbackQuery.data;

  // Exit Active Command Mode
  if (data === 'exit_active_mode') {
    const active = userActiveMode.get(ctx.from.id);
    userActiveMode.delete(ctx.from.id);
    const modeNames = {
      search: 'AI Web Search',
      youtube: 'YouTube Search',
      image: 'Image Generation',
    };
    const name = active?.mode ? (modeNames[active.mode] || active.mode) : 'Command';
    await ctx.answerCallbackQuery({ text: `${name} mode cancelled!` });
    await ctx.reply(
      `✅ *${name} mode cancelled.*\n\nYou are now back in normal AI chat mode! Send any message or question to chat with Claude.`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  // Return to Storage Hub
  if (data === 'storage_main') {
    await ctx.answerCallbackQuery();
    const userId = ctx.from.id;
    const currentMode = getUserStorageMode(userId);
    const userDir = getUserStorageDir(userId);
    const dirDisplay = userDir ? `\`${userDir}\`` : '_Not set yet (tap button below)_';
    const modeLabels = {
      local: '💻+☁️ Local & Cloud (Dual Save)',
      cloud: '☁️ Cloud Only (No laptop space)',
      nosave: '💻 Local Only (/nosave - No cloud save)',
    };

    const keyboard = new InlineKeyboard()
      .text(`☁️ Telegram Cloud Vault (${cloudVault.length} files)`, 'storage_cloud')
      .row()
      .text(userDir ? `💻 Local Storage (${path.basename(userDir) || 'Folder'})` : '💻 Local Storage (Set Folder)', 'lib_src:local')
      .row()
      .text('📁 Set / Change Local Folder', 'change_local_dir')
      .row()
      .text(`⚙️ Upload Destination: ${modeLabels[currentMode]}`, 'open_storage_settings');

    await ctx.editMessageText(
      `⚙️ *Storage & Cloud Hub*\n\n` +
      `Current Upload Mode: *${modeLabels[currentMode]}*\n\n` +
      `Choose what you'd like to do:\n\n` +
      `• ☁️ **Telegram Cloud Vault**: Access your saved files & search history\n` +
      `• 💻 **Local Storage**: Files stored in ${dirDisplay} on your laptop\n` +
      `• 📁 **Configure Folder**: Tap "Set / Change Local Folder" or send /directory\n` +
      `• ⚙️ **Upload Destination**: Configure where new uploads are saved`,
      {
        parse_mode: 'Markdown',
        reply_markup: keyboard,
      }
    );
    return;
  }

  // Requirement 5: When user clicks on Cloud in storage, pop up TWO options:
  // 1. Saved Files
  // 2. Search History
  if (data === 'storage_cloud') {
    await ctx.answerCallbackQuery();
    const history = getAllSearchHistory();
    const keyboard = new InlineKeyboard()
      .text(`📁 Saved Files (${cloudVault.length})`, 'cloud_files_cats')
      .row()
      .text(`🔍 Search History (${history.length})`, 'cloud_hist_page:0')
      .row()
      .text('◀️ Back to Storage', 'storage_main');

    await ctx.editMessageText(
      `☁️ *Telegram Cloud Hub*\n\n` +
      `Everything in your cloud is saved 24/7 on Telegram.\n\n` +
      `Please choose what you would like to view:\n\n` +
      `1. 📁 **Saved Files**: Browse documents, Python scripts, code, and videos (organized by category, sorted A-Z).\n` +
      `2. 🔍 **Search History**: View your saved research lookups, YouTube searches, and store finds.`,
      {
        parse_mode: 'Markdown',
        reply_markup: keyboard,
      }
    );
    return;
  }

  // Cloud Files Categories View
  if (data === 'cloud_files_cats' || data === 'lib_src:cloud') {
    await ctx.answerCallbackQuery();
    if (cloudVault.length === 0) {
      await ctx.editMessageText(
        `☁️ *Telegram Cloud Vault is Empty*\n\n` +
        `You haven't uploaded or saved any files to Telegram yet.\n\n` +
        `📤 *How to add files:*\n` +
        `• Send any PDF, Python (.py), Code, or Document file to this chat.`,
        {
          parse_mode: 'Markdown',
          reply_markup: new InlineKeyboard()
            .text('🔍 View Search History', 'cloud_hist_page:0')
            .row()
            .text('💻 Switch to Local Storage', 'lib_src:local')
            .row()
            .text('◀️ Back to Cloud Hub', 'storage_cloud'),
        }
      );
      return;
    }

    const keyboard = buildCategoriesKeyboard(cloudVault, 'cloud');
    await ctx.editMessageText(
      `☁️ *Telegram Cloud Vault — File Categories*\n\n` +
      `Total Files: *${cloudVault.length}*\n\n` +
      `Select a category below to browse (files are sorted alphabetically **A-Z**):`,
      {
        parse_mode: 'Markdown',
        reply_markup: keyboard,
      }
    );
    return;
  }

  // Local Storage Categories View
  if (data === 'lib_src:local' || data === 'lib_refresh:local') {
    const userId = ctx.from.id;
    const userDir = getUserStorageDir(userId);
    const hasLaptop = isLaptopConnected(userId);

    await ctx.answerCallbackQuery();

    if (!userDir) {
      userAwaitingDirectoryInput.add(userId);
      await ctx.editMessageText(
        `📁 *Local Folder Not Configured*\n\n` +
        `You have not set your personal laptop folder yet.\n\n` +
        `Please **reply with your laptop's folder path** now:\n` +
        `_Example: \`C:\\Users\\yourname\\Documents\\TelegramStorage\` or \`D:\\Projects\`_\n\n` +
        `Or use \`/directory <path>\` anytime!`,
        {
          parse_mode: 'Markdown',
          reply_markup: new InlineKeyboard()
            .text('☁️ Switch to Cloud Vault', 'storage_cloud')
            .row()
            .text('⚙️ Back to Storage', 'storage_main'),
        }
      );
      return;
    }

    let files = [];
    if (fs.existsSync(userDir)) {
      files = await getStoredFiles(userDir, userDir);
    } else if (hasLaptop) {
      try {
        const res = await listLaptopDirectory(userId, userDir);
        if (res && res.success && res.items) {
          files = res.items
            .filter((i) => i.isFile)
            .map((i) => ({
              name: i.name,
              relPath: i.name,
              size: 0,
              mtime: Date.now(),
            }));
        }
      } catch (err) {
        console.warn(`[Local Files] Could not list laptop dir for user ${userId}:`, err.message);
      }
    }

    setUserCachedFiles(userId, files);

    if (files.length === 0) {
      if (cloudVault.length > 0) {
        const keyboard = buildCategoriesKeyboard(cloudVault, 'cloud');
        await ctx.editMessageText(
          `💻 *Laptop Storage (${path.basename(userDir) || 'Local'})*\n\n` +
          `Your configured folder is: \`${userDir}\`\n\n` +
          `No local files found in this folder. Your saved files are backed up safely in **☁️ Telegram Cloud Vault** (${cloudVault.length} files available)!\n\n` +
          `Select a category below to browse (sorted **A-Z**):`,
          {
            parse_mode: 'Markdown',
            reply_markup: keyboard,
          }
        );
        return;
      }

      await ctx.editMessageText(
        `💻 *Local Storage is Empty*\n\n` +
        `Folder: \`${userDir}\`\n\n` +
        `• Make sure \`start-agent.bat\` is running on your laptop.\n` +
        `• Send files to this chat or ask the agent to create files in this folder!\n` +
        `• Tap "Change Folder" below if you want to use a different directory.`,
        {
          parse_mode: 'Markdown',
          reply_markup: new InlineKeyboard()
            .text('🔄 Refresh Local', 'lib_src:local')
            .row()
            .text('📁 Change Local Folder', 'change_local_dir')
            .row()
            .text('☁️ Switch to Cloud Vault', 'storage_cloud'),
        }
      );
      return;
    }

    const keyboard = buildCategoriesKeyboard(files, 'local');
    await ctx.editMessageText(
      `💻 *Local Storage — File Categories*\n\n` +
      `Folder: \`${userDir}\`\n` +
      `Total Files: *${files.length}*\n\n` +
      `Select a category below to browse (files are sorted alphabetically **A-Z**):`,
      {
        parse_mode: 'Markdown',
        reply_markup: keyboard,
      }
    );
    return;
  }

  // View category files list: lib_cat:<source>:<categoryId> or lib_cat_page:<source>:<categoryId>:<page>
  if (data.startsWith('lib_cat:') || data.startsWith('lib_cat_page:')) {
    const parts = data.split(':');
    const source = parts[1];
    const categoryId = parts[2];
    const page = parts.length > 3 ? parseInt(parts[3], 10) || 0 : 0;

    let files = [];
    if (source === 'cloud') {
      files = cloudVault;
    } else {
      files = await getStoredFiles();
      setUserCachedFiles(ctx.from.id, files);
    }

    const { keyboard, totalPages, totalCount, catName, page: safePage } = buildCategoryFilesKeyboard(
      files,
      source,
      categoryId,
      page
    );

    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      `📁 *${catName}* (${totalCount} file${totalCount === 1 ? '' : 's'})\n` +
      `Storage: *${source === 'cloud' ? '☁️ Telegram Cloud Vault' : '💻 Local Storage (Drive D)'}*\n` +
      `Files sorted alphabetically **A to Z**.\n\n` +
      `Page ${safePage + 1} of ${totalPages}. Select a file to view, quiz, or download:`,
      {
        parse_mode: 'Markdown',
        reply_markup: keyboard,
      }
    );
    return;
  }

  // Select a file: lib_sel:<source>:<idx>
  if (data.startsWith('lib_sel:')) {
    const parts = data.split(':');
    const source = parts[1];
    const idx = parseInt(parts[2], 10);

    let file = null;
    if (source === 'cloud') {
      file = cloudVault[idx];
    } else {
      let cachedFiles = getUserCachedFiles(ctx.from.id);
      if (!cachedFiles || !cachedFiles[idx]) {
        cachedFiles = await getStoredFiles();
        setUserCachedFiles(ctx.from.id, cachedFiles);
      }
      file = cachedFiles[idx];
    }

    if (!file) {
      await ctx.answerCallbackQuery({ text: 'File not found!' });
      return;
    }

    await ctx.answerCallbackQuery();
    const cat = FILE_CATEGORIES[file.category || getFileCategory(file.ext).id] || FILE_CATEGORIES.other;
    const actionKeyboard = new InlineKeyboard()
      .text('🎲 3-Question Quiz', `lib_quiz:${source}:${idx}`)
      .text('📝 Detailed Summary', `lib_sum:${source}:${idx}`)
      .row()
      .text('📥 Send File to Chat', `lib_send:${source}:${idx}`)
      .row();

    if (source === 'cloud') {
      actionKeyboard.text('🗑️ Delete', `lib_del:${idx}`);
    }

    actionKeyboard.text('🔙 Back to Categories', source === 'cloud' ? 'cloud_files_cats' : 'lib_src:local');

    const dateStr = new Date(file.date || file.mtime).toLocaleString();
    const sourceName = source === 'cloud' ? '☁️ Telegram Cloud Vault' : '💻 Local Storage (Drive D)';

    await ctx.editMessageText(
      `${cat.icon} *Selected Document:*\n\`${file.name}\`\n\n` +
      `📂 *Category:* ${cat.name}\n` +
      `📦 *Size:* ${formatBytes(file.size)}\n` +
      `📅 *${source === 'cloud' ? 'Uploaded' : 'Modified'}:* ${dateStr}\n` +
      `📍 *Source:* ${sourceName}\n\n` +
      `What would you like to do with this file?`,
      {
        parse_mode: 'Markdown',
        reply_markup: actionKeyboard,
      }
    );
    return;
  }

  // Send file directly into chat: lib_send:<source>:<idx>
  if (data.startsWith('lib_send:')) {
    const parts = data.split(':');
    const source = parts[1];
    const idx = parseInt(parts[2], 10);

    let file = null;
    if (source === 'cloud') {
      file = cloudVault[idx];
    } else {
      let cachedFiles = getUserCachedFiles(ctx.from.id);
      if (!cachedFiles || !cachedFiles[idx]) {
        cachedFiles = await getStoredFiles();
        setUserCachedFiles(ctx.from.id, cachedFiles);
      }
      file = cachedFiles[idx];
    }

    if (!file) {
      await ctx.answerCallbackQuery({ text: 'File not found!' });
      return;
    }

    await ctx.answerCallbackQuery({ text: `Sending ${file.name}...` });
    await ctx.replyWithChatAction('upload_document');

    try {
      if (source === 'cloud') {
        if (file.ext === 'mp4') {
          await ctx.replyWithVideo(file.file_id, {
            caption: `🎥 *${file.name}*\n📦 Size: ${formatBytes(file.size)}`,
            parse_mode: 'Markdown',
          });
        } else {
          await ctx.replyWithDocument(file.file_id, {
            caption: `📄 *${file.name}*\n📦 Size: ${formatBytes(file.size)}`,
            parse_mode: 'Markdown',
          });
        }
      } else {
        const filePath = path.resolve(STORAGE_DIR, file.relPath || file.name);
        await ctx.replyWithDocument(new InputFile(filePath), {
          caption: `📄 *${file.name}*\n📦 Size: ${formatBytes(file.size)}`,
          parse_mode: 'Markdown',
        });
      }
    } catch (sendErr) {
      console.error('Error sending file to chat:', sanitizeError(sendErr));
      await ctx.reply(`❌ Could not send file: ${sanitizeError(sendErr).slice(0, 200)}`);
    }
    return;
  }

  // Browse Search History: cloud_hist_page:<page>
  if (data.startsWith('cloud_hist_page:')) {
    const page = parseInt(data.replace('cloud_hist_page:', ''), 10) || 0;
    const history = getAllSearchHistory();
    await ctx.answerCallbackQuery();

    if (history.length === 0) {
      await ctx.editMessageText(
        `🔍 *Search & Research History is Empty*\n\n` +
        `You haven't looked up anything yet.\n\n` +
        `💡 *Try these commands:*\n` +
        `• \`/youtube <query>\` - Search YouTube videos & channels\n` +
        `• \`/search <query>\` - AI research & web search\n\n` +
        `All your searches and lookups will be saved here automatically!`,
        {
          parse_mode: 'Markdown',
          reply_markup: new InlineKeyboard()
            .text('📁 Browse Files', 'cloud_files_cats')
            .row()
            .text('◀️ Back to Cloud Hub', 'storage_cloud'),
        }
      );
      return;
    }

    const { keyboard, totalPages, total, page: safePage } = buildSearchHistoryKeyboard(page);
    await ctx.editMessageText(
      `🔍 *Search & Research History (Cloud)*\n\n` +
      `Total Saved Lookups: *${total}*\n` +
      `Page ${safePage + 1} of ${totalPages}.\n\n` +
      `Tap any search below to view details or re-run:`,
      {
        parse_mode: 'Markdown',
        reply_markup: keyboard,
      }
    );
    return;
  }

  // View Search Entry Details: view_hist:<id>
  if (data.startsWith('view_hist:')) {
    const id = data.replace('view_hist:', '');
    const entry = getSearchHistoryEntry(id);
    if (!entry) {
      await ctx.answerCallbackQuery({ text: 'Search entry not found!' });
      return;
    }

    await ctx.answerCallbackQuery();
    const icon =
      entry.type === 'youtube'
        ? '🎥 YouTube Search'
        : entry.type === 'download'
        ? '📥 Video Download'
        : '🌐 Web Research';

    const dateStr = new Date(entry.date).toLocaleString();
    let detailsText =
      `🔍 *Search Entry Details*\n\n` +
      `• *Query:* \`${entry.query}\`\n` +
      `• *Type:* ${icon}\n` +
      `• *Date:* ${dateStr}\n` +
      (entry.url ? `• *Link:* ${entry.url}\n` : '') +
      `\n`;

    if (entry.topResults && entry.topResults.length > 0) {
      detailsText += `📋 *Top Results Saved:*\n`;
      entry.topResults.forEach((r, i) => {
        detailsText += `${i + 1}. [${r.title || 'Link'}](${r.link})\n`;
      });
      detailsText += '\n';
    }

    const keyboard = new InlineKeyboard()
      .text('🔄 Re-run Search', `rerun_search:${entry.id}`)
      .row();

    keyboard
      .text('🗑️ Delete Entry', `del_hist:${entry.id}`)
      .row()
      .text('🔙 Back to Search History', 'cloud_hist_page:0');

    await ctx.editMessageText(detailsText, {
      parse_mode: 'Markdown',
      reply_markup: keyboard,
      disable_web_page_preview: true,
    });
    return;
  }

  // Re-run search: rerun_search:<id>
  if (data.startsWith('rerun_search:')) {
    const id = data.replace('rerun_search:', '');
    const entry = getSearchHistoryEntry(id);
    if (!entry) {
      await ctx.answerCallbackQuery({ text: 'Entry not found!' });
      return;
    }

    await ctx.answerCallbackQuery({ text: `Re-running search for: ${entry.query}` });
    await ctx.replyWithChatAction('typing');

    if (entry.type === 'youtube') {
      const results = await searchYouTube(entry.query, 3);
      if (results.length === 0) {
        await ctx.reply(`❌ No YouTube videos found for: \`${entry.query}\``, { parse_mode: 'Markdown' });
        return;
      }
      let msgText = `🎥 *YouTube Search Results for: "${entry.query}"*\n\n`;
      const keyboard = new InlineKeyboard();
      results.forEach((r, idx) => {
        msgText += `${idx + 1}. [${r.title}](${r.url})\n   ⏱️ Duration: \`${r.duration}\` | 👤 \`${r.uploader}\`\n\n`;
      });
      keyboard.text('💾 View in Search History', 'cloud_hist_page:0');
      await ctx.reply(msgText, { parse_mode: 'Markdown', reply_markup: keyboard });
    } else {
      const results = await searchWeb(entry.query, 5);
      if (results.length === 0) {
        await ctx.reply(`❌ No results found for: \`${entry.query}\``, { parse_mode: 'Markdown' });
        return;
      }
      let msgText = `🌐 *Results for: "${entry.query}"*\n\n`;
      results.slice(0, 4).forEach((r, idx) => {
        msgText += `${idx + 1}. [${r.title}](${r.link})\n`;
        if (r.snippet) msgText += `   _${r.snippet.slice(0, 150)}..._\n\n`;
      });
      const keyboard = new InlineKeyboard().text('💾 View in Search History', 'cloud_hist_page:0');
      await ctx.reply(msgText, { parse_mode: 'Markdown', reply_markup: keyboard });
    }
    return;
  }

  // Legacy video download callback guard
  if (data.startsWith('dl_hist:') || data.startsWith('dl_yt:')) {
    await ctx.answerCallbackQuery({
      text: 'Video downloading has been disabled.',
      show_alert: true,
    });
    return;
  }

  // Delete search entry: del_hist:<id>
  if (data.startsWith('del_hist:')) {
    const id = data.replace('del_hist:', '');
    await deleteSearchHistoryEntry(id);
    await ctx.answerCallbackQuery({ text: 'Entry removed from history.' });

    const history = getAllSearchHistory();
    if (history.length === 0) {
      await ctx.editMessageText(
        `🔍 *Search History is now empty.*\n\n` +
        `Search again anytime with /youtube or /search!`,
        {
          parse_mode: 'Markdown',
          reply_markup: new InlineKeyboard().text('◀️ Back to Cloud Hub', 'storage_cloud'),
        }
      );
      return;
    }

    const { keyboard, totalPages, total } = buildSearchHistoryKeyboard(0);
    await ctx.editMessageText(
      `🔍 *Search & Research History (Cloud)*\n\n` +
      `Total Saved Lookups: *${total}*\nPage 1 of ${totalPages}.\n\n` +
      `Tap any search below to view details, re-run, or download:`,
      {
        parse_mode: 'Markdown',
        reply_markup: keyboard,
      }
    );
    return;
  }

  // Confirm clear all history
  if (data === 'confirm_clear_hist') {
    await ctx.answerCallbackQuery();
    const keyboard = new InlineKeyboard()
      .text('⚠️ Yes, Clear All', 'do_clear_hist')
      .row()
      .text('◀️ Cancel', 'cloud_hist_page:0');

    await ctx.editMessageText(
      `⚠️ *Are you sure you want to clear your entire search history?*\n\n` +
      `This will remove all saved lookups. (Your saved files will NOT be affected.)`,
      {
        parse_mode: 'Markdown',
        reply_markup: keyboard,
      }
    );
    return;
  }

  // Do clear all history
  if (data === 'do_clear_hist') {
    await clearAllSearchHistory();
    await ctx.answerCallbackQuery({ text: 'Search history cleared!' });
    await ctx.editMessageText(
      `✅ *Search history cleared successfully!*\n\n` +
      `Your files in Cloud Vault and Drive D are safe.`,
      {
        parse_mode: 'Markdown',
        reply_markup: new InlineKeyboard()
          .text('📁 Browse Saved Files', 'cloud_files_cats')
          .row()
          .text('◀️ Back to Cloud Hub', 'storage_cloud'),
      }
    );
    return;
  }



  // Change local directory
  if (data === 'change_local_dir') {
    const userId = ctx.from.id;
    userAwaitingDirectoryInput.add(userId);
    await ctx.answerCallbackQuery();
    const currentDir = getUserStorageDir(userId);
    await ctx.reply(
      `📁 *Set Your Laptop Storage Folder*\n\n` +
      `Current folder: ${currentDir ? `\`${currentDir}\`` : '_Not set yet_'}\n\n` +
      `Please **reply with your laptop's folder path** now:\n` +
      `_Example: \`C:\\Users\\yourname\\Documents\\TelegramStorage\` or \`D:\\Projects\`_\n\n` +
      `_(Or type /cancel to keep current settings)_`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  // Open storage settings from inline button
  if (data === 'open_storage_settings') {
    await ctx.answerCallbackQuery();
    const userId = ctx.from.id;
    const currentMode = getUserStorageMode(userId);
    const userDir = getUserStorageDir(userId);
    const modeLabels = {
      local: '💻+☁️ Local & Cloud (Dual Save)',
      cloud: '☁️ Cloud Only (No laptop space)',
      nosave: '💻 Local Only (/nosave - No cloud save)',
    };

    const keyboard = new InlineKeyboard()
      .text('☁️ Cloud Only', 'set_storage:cloud')
      .row()
      .text('💻+☁️ Local & Cloud', 'set_storage:local')
      .row()
      .text('💻 Local Only (/nosave)', 'set_storage:nosave')
      .row()
      .text('📁 Set / Change Local Folder', 'change_local_dir')
      .row()
      .text('◀️ Back to Storage Hub', 'storage_main');

    await ctx.editMessageText(
      `⚙️ *Storage Destination Settings*\n\n` +
      `Current Mode: *${modeLabels[currentMode]}*\n` +
      `Current Folder: ${userDir ? `\`${userDir}\`` : '_Not set yet_'}\n\n` +
      `Choose where newly uploaded files should be saved:\n\n` +
      `• ☁️ **Cloud Only**: Saved only to Telegram Cloud Vault. Takes 0 MB on laptop.\n` +
      `• 💻+☁️ **Local & Cloud**: Saved to both your laptop folder and Telegram Cloud Vault.\n` +
      `• 💻 **Local Only (/nosave)**: Saved only to your laptop folder. No cloud upload.`,
      {
        parse_mode: 'Markdown',
        reply_markup: keyboard,
      }
    );
    return;
  }

  // Set storage mode
  if (data.startsWith('set_storage:')) {
    const newMode = data.split(':')[1];
    const userId = ctx.from.id;
    setUserStorageMode(userId, newMode);
    await ctx.answerCallbackQuery({ text: `Mode updated to ${newMode}!` });

    const currentDir = getUserStorageDir(userId);
    const modeLabels = {
      local: '💻+☁️ Local & Cloud (Dual Save)',
      cloud: '☁️ Cloud Only (No laptop space)',
      nosave: '💻 Local Only (/nosave - No cloud save)',
    };

    const keyboard = new InlineKeyboard()
      .text('☁️ Cloud Only', 'set_storage:cloud')
      .row()
      .text('💻+☁️ Local & Cloud', 'set_storage:local')
      .row()
      .text('💻 Local Only (/nosave)', 'set_storage:nosave')
      .row()
      .text('📁 Set / Change Local Folder', 'change_local_dir')
      .row()
      .text('⚙️ Back to Storage Hub', 'storage_main');

    let extraDirNote = '';
    if ((newMode === 'local' || newMode === 'nosave') && !currentDir) {
      userAwaitingDirectoryInput.add(userId);
      extraDirNote = `\n\n⚠️ *Action Required: Local Folder Not Set*\n` +
        `Please reply now with the folder path on your laptop where you want files saved:\n` +
        `_Example: \`C:\\Users\\username\\Documents\\BotStorage\` or \`D:\\Projects\`_`;
    } else if (currentDir) {
      extraDirNote = `\n\n📁 *Target Laptop Folder:* \`${currentDir}\``;
    }

    await ctx.editMessageText(
      `✅ *Storage Mode Updated!*\n\n` +
      `Active Mode: *${modeLabels[newMode]}*\n\n` +
      `• ☁️ **Cloud Only**: Saves to Cloud Vault only (0 laptop space).\n` +
      `• 💻+☁️ **Local & Cloud**: Saves to your laptop folder & Cloud Vault.\n` +
      `• 💻 **Local Only (/nosave)**: Saves to your laptop folder only.${extraDirNote}`,
      {
        parse_mode: 'Markdown',
        reply_markup: keyboard,
      }
    );
    return;
  }

  // Switch / return to source picker
  if (data === 'lib_sources') {
    await ctx.answerCallbackQuery();
    const userId = ctx.from.id;
    const keyboard = buildSourcePickerKeyboard(userId);
    const userDir = getUserStorageDir(userId);
    const dirDisplay = userDir ? `\`${userDir}\`` : '_Not set yet_';
    await ctx.editMessageText(
      `📚 *Document & File Library*\n\n` +
      `Choose a storage location to browse (Files organized by category, sorted A-Z):\n\n` +
      `• ☁️ *Telegram Cloud Vault* (${cloudVault.length} file${cloudVault.length === 1 ? '' : 's'})\n` +
      `  Files uploaded via Telegram chat. Accessible 24/7 on your phone and any device.\n\n` +
      `• 💻 *Local Storage*\n` +
      `  Physical files located in ${dirDisplay} on your laptop.`,
      {
        parse_mode: 'Markdown',
        reply_markup: keyboard,
      }
    );
    return;
  }

  // Delete a file from Cloud Vault: lib_del:<idx>
  if (data.startsWith('lib_del:')) {
    const idx = parseInt(data.replace('lib_del:', ''), 10);
    if (!cloudVault[idx]) {
      await ctx.answerCallbackQuery({ text: 'File not found!' });
      return;
    }

    const removed = cloudVault.splice(idx, 1)[0];
    await persistCloudVault();
    await ctx.answerCallbackQuery({ text: `Removed "${removed.name}" from Cloud Vault` });

    if (cloudVault.length === 0) {
      await ctx.editMessageText(
        `☁️ *Telegram Cloud Vault is Empty*\n\n` +
        `You removed all files from the Cloud Vault.\n\n` +
        `Send any document to this chat to save it anytime!`,
        {
          parse_mode: 'Markdown',
          reply_markup: new InlineKeyboard()
            .text('🔍 Search History', 'cloud_hist_page:0')
            .row()
            .text('💻 Switch to Local Storage', 'lib_src:local')
            .row()
            .text('◀️ Back to Cloud Hub', 'storage_cloud'),
        }
      );
      return;
    }

    const keyboard = buildCategoriesKeyboard(cloudVault, 'cloud');
    await ctx.editMessageText(
      `☁️ *Telegram Cloud Vault — File Categories*\n\n` +
      `Total Files: *${cloudVault.length}*\n\n` +
      `Select a category below to browse (files are sorted alphabetically **A-Z**):`,
      {
        parse_mode: 'Markdown',
        reply_markup: keyboard,
      }
    );
    return;
  }

  // Quiz a selected file: lib_quiz:<source>:<idx>
  if (data.startsWith('lib_quiz:')) {
    const parts = data.split(':');
    const source = parts[1];
    const idx = parseInt(parts[2], 10);

    let file = null;
    if (source === 'cloud') {
      file = cloudVault[idx];
    } else {
      let cachedFiles = getUserCachedFiles(ctx.from.id);
      if (!cachedFiles || !cachedFiles[idx]) {
        cachedFiles = await getStoredFiles();
        setUserCachedFiles(ctx.from.id, cachedFiles);
      }
      file = cachedFiles[idx];
    }

    if (!file) {
      await ctx.answerCallbackQuery({ text: 'File not found!' });
      return;
    }

    await ctx.answerCallbackQuery({ text: `Generating quiz on ${file.name}...` });
    await ctx.replyWithChatAction('typing');

    try {
      let content = '';
      if (source === 'cloud') {
        content = await loadCloudDocumentContent(file.file_id, file.ext, file.name);
      } else {
        content = await loadLocalDocumentContent(file.relPath || file.name);
      }

      userLastDocument.set(ctx.from.id, {
        fileName: file.name,
        fileExtension: file.ext,
        content: content,
        uploadedAt: Date.now(),
        lastAccessedAt: Date.now(),
        explicitUpload: false,
      });

      const contextText = `Document: "${file.name}"\n\nContent:\n${content.slice(0, 15000)}`;
      const quizList = await generateQuizQuestions(contextText);
      await sendQuizPolls(ctx, quizList);
    } catch (err) {
      console.error('Error generating quiz from library file:', sanitizeError(err));
      await ctx.reply('❌ Sorry, I encountered an error reading the file or generating quiz questions.');
    }
    return;
  }

  // Summarize a selected file: lib_sum:<source>:<idx>
  if (data.startsWith('lib_sum:')) {
    const parts = data.split(':');
    const source = parts[1];
    const idx = parseInt(parts[2], 10);

    let file = null;
    if (source === 'cloud') {
      file = cloudVault[idx];
    } else {
      let cachedFiles = getUserCachedFiles(ctx.from.id);
      if (!cachedFiles || !cachedFiles[idx]) {
        cachedFiles = await getStoredFiles();
        setUserCachedFiles(ctx.from.id, cachedFiles);
      }
      file = cachedFiles[idx];
    }

    if (!file) {
      await ctx.answerCallbackQuery({ text: 'File not found!' });
      return;
    }

    await ctx.answerCallbackQuery({ text: `Analyzing ${file.name}...` });
    await ctx.replyWithChatAction('typing');

    try {
      let content = '';
      if (source === 'cloud') {
        content = await loadCloudDocumentContent(file.file_id, file.ext, file.name);
      } else {
        content = await loadLocalDocumentContent(file.relPath || file.name);
      }

      userLastDocument.set(ctx.from.id, {
        fileName: file.name,
        fileExtension: file.ext,
        content: content,
        uploadedAt: Date.now(),
        lastAccessedAt: Date.now(),
        explicitUpload: false,
      });

      let prompt;
      if (CODE_EXTENSIONS.includes(file.ext)) {
        prompt =
          `Please provide a comprehensive technical analysis of "${file.name}":\n` +
          `1. 🎯 **Executive Summary**: What does this code do and what problem does it solve?\n` +
          `2. 🏗️ **Architecture & Key Components**: Breakdown of main classes, functions/methods, and structures.\n` +
          `3. ⚙️ **Core Logic & Complexity**: Explain the underlying algorithms and estimated time & space complexity.\n` +
          `4. ⚠️ **Observations & Edge Cases**: Potential bugs, unhandled conditions, or optimization suggestions.`;
      } else {
        prompt =
          `Please provide a detailed, structured summary of "${file.name}":\n` +
          `1. 📌 **Executive Overview**: Main topic, purpose, and central conclusion.\n` +
          `2. 🔑 **Key Takeaways & Core Concepts**: Crucial definitions, historical events, principles, or data.\n` +
          `3. 📖 **Section-by-Section Breakdown**: In-depth coverage of each major topic discussed.\n` +
          `4. 💡 **Actionable Insights / Conclusion**.`;
      }

      const typingInterval = setInterval(() => {
        ctx.replyWithChatAction('typing').catch(() => {});
      }, 4000);

      try {
        const docExcerpt =
          content.length > 50000
            ? content.slice(0, 50000) + '\n\n[... File excerpted to first 50,000 characters ...]'
            : content;
        const fullPrompt = `${prompt}\n\nFile: "${file.name}" (${file.ext})\nContent:\n\`\`\`\n${docExcerpt}\n\`\`\``;

        const res = await callGeminiWithRetry(() =>
          googleAI.models.generateContent({
            model: 'gemini-3.8-flash',
            contents: fullPrompt,
          })
        );
        clearInterval(typingInterval);
        const summaryText = (res.text || '').trim() || 'Unable to generate summary.';
        await sendLongMessage(ctx, summaryText);
      } finally {
        clearInterval(typingInterval);
      }
    } catch (err) {
      console.error('Error summarizing library file with Gemini:', sanitizeError(err));
      await ctx.reply('❌ Sorry, I encountered an error reading or summarizing the file.');
    }
    return;
  }
});

bot.on(['message:voice', 'message:audio'], handleVoiceMessage);
bot.on('message:photo', handlePhotoMessage);

bot.on('message:text', async (ctx) => {
  const userMessage = ctx.message.text.trim();

  if (userMessage.startsWith('/')) {
    return;
  }

  const userId = ctx.from.id;

  // Check if user is awaiting input for setting their local laptop storage directory
  if (userAwaitingDirectoryInput.has(userId)) {
    userAwaitingDirectoryInput.delete(userId);
    const rawPath = userMessage.trim();
    if (rawPath.toLowerCase() === 'cancel' || rawPath === '/cancel') {
      await ctx.reply('❌ Local directory configuration cancelled.', { parse_mode: 'Markdown' });
      return;
    }
    if (rawPath.length < 2) {
      await ctx.reply('❌ Invalid directory path. You can set it anytime with `/directory <path>`', { parse_mode: 'Markdown' });
      return;
    }
    setUserStorageDir(userId, rawPath);
    await ctx.reply(
      `✅ *Local Storage Directory Configured!*\n\n` +
      `📁 *Folder:* \`${rawPath}\`\n\n` +
      `• Local file uploads and agent scripts will use this directory on your laptop.\n` +
      `• You can change this anytime with \`/directory <path>\` or in \`/storage\`.\n` +
      `• With \`start-agent.bat\` active on your laptop, the bot can directly create files and run scripts in this folder!`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  // Check if user is in an active persistent command mode (/search, /youtube, /tiktok, /image)
  if (userActiveMode.has(ctx.from.id)) {
    const active = userActiveMode.get(ctx.from.id);
    const isStale = active.timestamp && (Date.now() - active.timestamp > MODE_TIMEOUT_MS);
    if (isStale) {
      userActiveMode.delete(ctx.from.id);
    } else {
      active.timestamp = Date.now(); // Refresh activity timer so active searches/prompts keep mode alive

      if (active.mode === 'search') {
        await handleWebSearch(ctx, userMessage);
        return;
      }
      if (active.mode === 'youtube') {
        await handleYoutubeSearch(ctx, userMessage);
        return;
      }
      if (active.mode === 'image') {
        await handleImageGeneration(ctx, userMessage);
        return;
      }
    }
  }

  // Intercept natural language requests to generate pictures, videos, or "generate something" without the command,
  // and instruct the user to use /image instead.
  const imageRequestMatch =
    userMessage.match(/^(?:(?:can\s+you\s+|please\s+)?(?:generate|create|draw|make|paint|render|imagine)\s+(?:an?\s+)?(?:picture|image|photo|illustration|drawing|artwork|pic)s?(?:\s+(?:of|for|about)\s+(.+))?)$/i) ||
    userMessage.match(/^(?:(?:can\s+you\s+|please\s+)?(?:draw|paint)\s+(?:me\s+)?(?:an?\s+)?(.+))$/i) ||
    userMessage.match(/^(?:(?:can\s+you\s+|please\s+)?(?:generate|make|create)\s+(?:me\s+)?(?:a\s+)?pic(?:ture)?(?:s)?(?:\s+(?:of|for|about)\s+(.+))?)$/i);

  if (imageRequestMatch) {
    const promptArg = (imageRequestMatch[1] || '').trim();
    const example = promptArg ? `/image ${promptArg}` : '/image a cute fluffy cat in neon city, 4k digital art';
    await ctx.reply(
      '🎨 *To generate pictures, please use the `/image` command!*\n\n' +
      `👉 Type:\n\`${example}\`\n\n` +
      `💡 _You can also type \`/image\` and I will ask you for a prompt._`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  const videoRequestMatch =
    userMessage.match(/^(?:(?:can\s+you\s+|please\s+)?(?:generate|create|make|render)\s+(?:an?\s+)?(?:video|clip|animation|movie)s?(?:\s+(?:of|for|about)\s+(.+))?)$/i);

  if (videoRequestMatch) {
    await ctx.reply(
      '🎬 *AI Video Generation is currently disabled.*\n\n' +
      '💡 You can generate pictures with Gemini Nano Banana using `/image <prompt>`!\n\n' +
      'Example:\n`/image a cozy cabin in snowy mountains, 4k digital art`',
      { parse_mode: 'Markdown' }
    );
    return;
  }

  const generalGenMatch =
    userMessage.match(/^(?:(?:can\s+you\s+|please\s+)?(?:generate|create|make)\s+(?:something|smth|stuff))$/i);

  if (generalGenMatch) {
    await ctx.reply(
      '🎨 *Looking to generate pictures?*\n\n' +
      'Use the `/image <prompt>` command (powered by Gemini Nano Banana)!\n\n' +
      'Example:\n`/image a cozy cabin in snowy mountains, 4k digital art`',
      { parse_mode: 'Markdown' }
    );
    return;
  }

  await ctx.replyWithChatAction('typing');
  enqueueUserMessage(ctx.from.id, {
    type: 'text',
    text: userMessage,
  }, ctx);
});

bot.catch((err) => {
  console.error('[Bot Error]:', sanitizeError(err.error || err));
});

// Process-wide unhandled rejection / exception listeners to prevent container crashes on transient errors
process.on('unhandledRejection', (reason) => {
  console.error('[Unhandled Rejection]:', sanitizeError(reason));
});

process.on('uncaughtException', (err) => {
  console.error('[Uncaught Exception]:', sanitizeError(err));
});

let isShuttingDown = false;
const shutdown = (signal) => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`Received ${signal}. Shutting down bot gracefully...`);

  const forceExitTimeout = setTimeout(() => {
    console.warn('Shutdown timed out, exiting process now.');
    process.exit(0);
  }, 4000);
  forceExitTimeout.unref();

  try {
    bot.stop();
  } catch (err) {
    console.error('Error stopping bot:', sanitizeError(err));
  }

  try {
    persistConversationHistorySync();
  } catch (err) {
    console.error('Error flushing conversation history on shutdown:', sanitizeError(err));
  }

  cleanupTemporaryCookies().catch(() => {});

  server.close(() => {
    console.log('Health check server closed');
    process.exit(0);
  });

  if (typeof server.closeIdleConnections === 'function') {
    server.closeIdleConnections();
  }
};

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

// Initialize Telegram Cloud Vault
try {
  await initCloudVault();
} catch (vaultErr) {
  console.warn('Vault initialization note:', sanitizeError(vaultErr));
}

// Initialize Search & Research History
try {
  await initSearchHistory();
} catch (histErr) {
  console.warn('History initialization note:', sanitizeError(histErr));
}

// Initialize Persistent Conversation History
try {
  await initConversationHistory();
} catch (convErr) {
  console.warn('Conversation history initialization note:', sanitizeError(convErr));
}

// Initialize User Settings (per-user storage directories & modes)
try {
  await initUserSettings();
} catch (userErr) {
  console.warn('User settings initialization note:', sanitizeError(userErr));
}

// Register commands with Telegram so they appear in autocomplete menu when typing /
const botCommands = [
  // 🤖 AI Agent & Research
  { command: 'agent', description: '🤖 One-time task with live tools (web, files, math)' },
  { command: 'agent_mode', description: '🎚️ Toggle Agent as default for all chats (or /cancel)' },
  { command: 'devices', description: '💻 View connected laptop status for Agent' },
  { command: 'deep_research', description: '🔬 Deep Research report (deep-research-2026)' },

  // 🎙️ Real-Time Voice & Live Calls
  { command: 'live', description: '🎙️ Toggle Live Voice mode (spoken replies until /cancel)' },
  { command: 'call', description: '📞 Live duplex real-time voice call WebApp' },
  { command: 'voice', description: '🗣️ Switch Gemini Live voice persona' },

  // 🎨 Creation & Search
  { command: 'image', description: '🎨 Generate pictures with Gemini Nano Banana' },
  { command: 'search', description: '🌐 Live web search & deep factual research' },
  { command: 'youtube', description: '🎥 Search YouTube videos & channels' },
  { command: 'quiz', description: '📝 Interactive quiz on loaded file or topic' },

  // ☁️ Cloud Vault & Files
  { command: 'storage', description: '☁️ Cloud Vault hub (Saved files & history)' },
  { command: 'library', description: '📁 Browse saved files by category (A-Z)' },
  { command: 'directory', description: '📁 View or set your personal laptop folder path' },
  { command: 'status', description: '📊 Laptop hardware specs, bot resources & mode' },

  // 🧹 Workspace & Session Controls
  { command: 'cancel', description: '❌ Exit Live Voice, Agent, search, or quiz mode' },
  { command: 'clear', description: '🧹 Clear conversation history (keeps file)' },
  { command: 'clearall', description: '🗑️ Clear all conversation history & unload file' },
  { command: 'local', description: '💾 Save files to your laptop folder & Cloud Vault' },
  { command: 'cloud', description: '☁️ Save files to Cloud Vault only' },
  { command: 'nosave', description: '💻 Save files to your laptop folder only' },
  { command: 'help', description: '📖 Command reference and cheat sheet' },
  { command: 'start', description: '✨ Welcome guide and features overview' },
];

async function registerTelegramCommands() {
  try {
    await bot.api.setMyCommands(botCommands);
    await bot.api.setMyCommands(botCommands, { scope: { type: 'all_private_chats' } });
    console.log('Commands successfully registered with Telegram (default + all_private_chats scopes)');
  } catch (err) {
    console.warn('Failed to register Telegram commands:', sanitizeError(err));
  }
}

await registerTelegramCommands();

async function startBotWithRetry() {
  let attempt = 0;
  while (!isShuttingDown) {
    try {
      console.log('Starting Telegram bot polling...');
      await bot.start({
        drop_pending_updates: false,
        onStart: async (botInfo) => {
          console.log(`✅ Telegram bot @${botInfo.username} is running and polling for updates!`);
          await registerTelegramCommands().catch(() => {});
        },
      });
      break;
    } catch (err) {
      if (isShuttingDown) break;
      attempt++;
      const errMsg = err?.message || String(err);
      const isConflict =
        err?.error_code === 409 ||
        errMsg.includes('409') ||
        errMsg.includes('Conflict') ||
        errMsg.includes('terminated by other getUpdates request');

      if (isConflict) {
        console.warn(
          `⚠️ [Polling Conflict] Telegram 409 Conflict (attempt ${attempt}): Another bot instance is currently active (e.g. previous Render container shutting down). Waiting 5s before retrying...`
        );
      } else {
        console.error(`❌ [Polling Error] (attempt ${attempt}):`, sanitizeError(err));
        console.warn('Retrying polling in 5s...');
      }
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

// Start polling asynchronously with automatic retry so health check stays alive and rolling deploys succeed
startBotWithRetry().catch((err) => {
  console.error('Fatal polling loop error:', sanitizeError(err));
});
