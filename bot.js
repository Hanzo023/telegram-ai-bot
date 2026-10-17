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
  downloadMediaVideo,
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

const STORAGE_DIR = process.env.STORAGE_DIR || 'D:\\drive-download-20260715T073323Z-1-001';
const VAULT_FILE = process.env.VAULT_FILE || path.resolve('./cloud_vault.json');
const TEMP_DOWNLOADS_DIR = path.resolve('./temp_downloads');

const PORT = parseInt(process.env.PORT, 10) || 10000;
const server = http.createServer((req, res) => {
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

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  ...(process.env.ANTHROPIC_BASE_URL ? { baseURL: process.env.ANTHROPIC_BASE_URL } : {}),
});

const anthropicModel =
  process.env.ANTHROPIC_MODEL ||
  (process.env.ANTHROPIC_BASE_URL && !process.env.ANTHROPIC_BASE_URL.includes('anthropic.com')
    ? 'claude-sonnet-5-5'
    : 'claude-3-7-sonnet-20250219');

const ANTHROPIC_MAX_TOKENS = parseInt(process.env.ANTHROPIC_MAX_TOKENS, 10) || 8192;

const googleAI = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
});

const conversationHistory = new Map();
const userLastDocument = new Map();
const userLastInteraction = new Map(); // userId -> timestamp of last message/activity
const DOC_SESSION_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes active document session TTL
const CONVERSATION_SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes chat session TTL
const userStorageMode = new Map(); // 'local' (default: dual save), 'cloud' (cloud only), 'nosave' (local only)
const userPendingAction = new Map(); // userId -> { action: 'youtube'|'search'|'download'|'image', timestamp: number }
const userCachedFilesList = new Map(); // userId -> array of cached library files
const botStartTime = Date.now();

// Periodic background memory sweeper to prune stale sessions (unref'd so process exits cleanly)
const SESSION_SWEEPER_INTERVAL_MS = 15 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [userId, lastTime] of userLastInteraction.entries()) {
    if (now - lastTime > CONVERSATION_SESSION_TIMEOUT_MS) {
      conversationHistory.delete(userId);
      userLastDocument.delete(userId);
      userCachedFilesList.delete(userId);
      userPendingAction.delete(userId);
      userLastInteraction.delete(userId);
    }
  }
  for (const [userId, pending] of userPendingAction.entries()) {
    if (pending.timestamp && now - pending.timestamp > 5 * 60 * 1000) {
      userPendingAction.delete(userId);
    }
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
      await sendToClaudeWithHistory(ctx, combinedText);
    }
  }
}

function getUserStorageMode(userId) {
  return userStorageMode.get(userId) || 'local';
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
    'Hello! I\'m your personal AI assistant powered by Claude.\n\n' +
    'Just send me any message, photo, document, or link and I\'ll help you right away!\n\n' +
    '✨ *What I can do for you:*\n' +
    '• 🎨 **AI Image Generation**: Create pictures with Gemini Nano Banana using `/image`.\n' +
    '• 📸 **Photos & Screenshots**: Send any image or screenshot to analyze, transcribe, or translate.\n' +
    '• 📁 **Categorized Library**: Files organized by type (.pdf, .py, code, media, etc.) sorted A-Z!\n' +
    '• 🎥 **YouTube Research**: Search videos and download MP4s directly into chat.\n' +
    '• 🌐 **AI Research & Web Search**: Research any topic, find websites, and look up products powered by Claude.\n' +
    '• 📥 **Video Downloader**: Download YouTube or TikTok videos and save them to your Cloud Vault.\n' +
    '• ☁️ **Telegram Cloud Vault**: Access your files and search history 24/7 on any device.\n\n' +
    '📌 *Commands:*\n' +
    '/image <prompt> - 🎨 Generate pictures with Gemini Nano Banana\n' +
    '/search <query> - AI research & web search powered by Claude\n' +
    '/youtube <query> - Search YouTube videos & download MP4 directly\n' +
    '/download <url> - Download YouTube or TikTok video\n' +
    '/storage - Open Cloud Vault (Saved Files & Search History)\n' +
    '/library - Browse saved files by category (A-Z)\n' +
    '/quiz - Generate an interactive quiz poll on loaded file or topic\n' +
    '/status - View system resources, loaded file & storage mode\n' +
    '/clear - Clear chat messages (keeps loaded file active)\n' +
    '/clearall - Clear everything & unload file\n' +
    '/nosave - Save new files only to Drive D\n' +
    '/cloud - Save new files only to Cloud Vault\n' +
    '/local - Save new files to both Drive D and Cloud Vault',
    { parse_mode: 'Markdown' }
  );
});

async function handleClearAll(ctx) {
  const userId = ctx.from.id;
  clearUserQueue(userId);
  conversationHistory.delete(userId);
  userLastDocument.delete(userId);
  userLastInteraction.delete(userId);
  userPendingAction.delete(userId);
  userCachedFilesList.delete(userId);

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

bot.command('clear', async (ctx) => {
  const userId = ctx.from.id;
  clearUserQueue(userId);
  userPendingAction.delete(userId);
  const arg = ctx.message.text.replace(/^\/clear\s*/i, '').trim().toLowerCase();

  if (arg === 'all' || arg === 'doc' || arg === 'file') {
    await handleClearAll(ctx);
    return;
  }

  conversationHistory.delete(userId);
  userLastInteraction.delete(userId);

  const activeDoc = await getOrAutoLoadDocument(userId);
  if (activeDoc) {
    await ctx.reply(
      '✅ *Conversation messages cleared!*\n\n' +
      `📄 *Active Document Kept:* \`${activeDoc.fileName}\`\n` +
      `You can continue asking questions or quiz on this file without re-uploading!\n\n` +
      `💡 _To unload this document from chat memory too, type \`/clearall\`._`,
      { parse_mode: 'Markdown' }
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
});

bot.command(['clearall', 'clear_all'], handleClearAll);

bot.command(['nosave', 'no_save'], async (ctx) => {
  const userId = ctx.from.id;
  userStorageMode.set(userId, 'nosave');
  await ctx.reply(
    '💻 *Upload Mode set to: Local Only (/nosave)*\n\n' +
    '• New files you upload will be saved **only to your laptop (Drive D)**.\n' +
    '• They will **NOT** be uploaded to Telegram Cloud Vault.\n\n' +
    '💡 _To switch back:_\n' +
    '• Type /local to save to both Drive D and Cloud Vault\n' +
    '• Type /cloud to save to Cloud Vault only (saving laptop space)',
    { parse_mode: 'Markdown' }
  );
});

bot.command(['cloud', 'cloudonly'], async (ctx) => {
  const userId = ctx.from.id;
  userStorageMode.set(userId, 'cloud');
  await ctx.reply(
    '☁️ *Upload Mode set to: Cloud Only*\n\n' +
    '• New files you upload will be saved **only to Telegram Cloud Vault**.\n' +
    '• They will **NOT** take up space on your laptop drive (Drive D).\n\n' +
    '💡 _To switch back:_\n' +
    '• Type /local to save to both Drive D and Cloud Vault\n' +
    '• Type /nosave to save to local Drive D only',
    { parse_mode: 'Markdown' }
  );
});

bot.command(['local', 'dual'], async (ctx) => {
  const userId = ctx.from.id;
  userStorageMode.set(userId, 'local');
  await ctx.reply(
    '💻+☁️ *Upload Mode set to: Local & Cloud (Default)*\n\n' +
    '• New files you upload will be saved to **both Drive D and Telegram Cloud Vault**.\n\n' +
    '💡 _Other modes:_\n' +
    '• Type /cloud to save to Cloud Vault only\n' +
    '• Type /nosave to save to Drive D only',
    { parse_mode: 'Markdown' }
  );
});

bot.command(['storage', 'mode'], async (ctx) => {
  const userId = ctx.from.id;
  const currentMode = getUserStorageMode(userId);
  const modeLabels = {
    local: '💻+☁️ Local & Cloud (Dual Save)',
    cloud: '☁️ Cloud Only (No laptop space)',
    nosave: '💻 Local Only (/nosave - No cloud save)',
  };

  const keyboard = new InlineKeyboard()
    .text(`☁️ Telegram Cloud Vault (${cloudVault.length} files)`, 'storage_cloud')
    .row()
    .text('💻 Local Storage (Drive D)', 'lib_src:local')
    .row()
    .text(`⚙️ Upload Destination: ${modeLabels[currentMode]}`, 'open_storage_settings');

  await ctx.reply(
    `⚙️ *Storage & Cloud Hub*\n\n` +
    `Current Upload Mode: *${modeLabels[currentMode]}*\n\n` +
    `Choose what you'd like to do:\n\n` +
    `• ☁️ **Telegram Cloud Vault**: Access your saved files & search history\n` +
    `• 💻 **Local Storage (Drive D)**: Files stored in \`${STORAGE_DIR}\` on your laptop\n` +
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
    if (r.id) {
      keyboard.text(`📥 Download #${idx + 1} (MP4)`, `dl_yt:${r.id}`).row();
    }
  });

  msgText += `💡 _Tap any download button to download the video directly to chat and Cloud Vault!_`;
  keyboard.text('💾 View in Search History', 'cloud_hist_page:0');

  await ctx.reply(msgText, {
    parse_mode: 'Markdown',
    reply_markup: keyboard,
    disable_web_page_preview: true,
  });
}

async function handleWebSearch(ctx, query) {
  const cleanQuery = (query || '').trim();
  if (!cleanQuery) return;

  await ctx.replyWithChatAction('typing');
  const webResults = await searchWeb(cleanQuery, 5);

  // Use Claude directly to perform deep research and format a high-quality answer
  let claudeResearch = '';
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

    const response = await anthropic.messages.create({
      model: anthropicModel,
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    });
    claudeResearch = response.content?.[0]?.text || '';
  } catch (err) {
    console.error('Claude web research error:', sanitizeError(err));
  }

  let msgText = `🌐 *Research Results for: "${cleanQuery}"*\n\n`;
  if (claudeResearch) {
    msgText += `${claudeResearch}\n\n`;
  }

  if (webResults.length > 0) {
    msgText += `🔗 *Source Links:*\n`;
    webResults.slice(0, 3).forEach((r, idx) => {
      msgText += `• [${r.title}](${r.link})\n`;
    });
    msgText += `\n`;
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

  await ctx.reply(msgText, {
    parse_mode: 'Markdown',
    reply_markup: keyboard,
  });
}

async function handleDownload(ctx, rawUrl) {
  const url = (rawUrl || '').trim();
  if (!url || !url.startsWith('http')) {
    await ctx.reply('⚠️ Please provide a valid link starting with http:// or https://');
    return;
  }

  const statusMsg = await ctx.reply('⏳ *Downloading video...* Please wait a moment while it processes.', {
    parse_mode: 'Markdown',
  });

  let dlResult = null;
  try {
    const targetDir = TEMP_DOWNLOADS_DIR;
    dlResult = await downloadMediaVideo(url, targetDir);

    if (dlResult.isOverTelegramLimit) {
      await ctx.api.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        `⚠️ *Video is too large for Telegram upload (> 50 MB)*\n\n` +
        `Size: ${(dlResult.fileSize / 1024 / 1024).toFixed(1)} MB.\n` +
        (getUserStorageMode(ctx.from.id) !== 'cloud' ? `Saved locally on laptop at: \`${dlResult.filePath}\`` : ''),
        { parse_mode: 'Markdown' }
      );
      return;
    }

    await ctx.replyWithChatAction('upload_video');
    const sentVideo = await ctx.replyWithVideo(new InputFile(dlResult.filePath), {
      caption: `🎥 *${dlResult.fileName}*\n📦 Size: ${(dlResult.fileSize / 1024 / 1024).toFixed(1)} MB\n💾 Saved to Telegram Cloud Vault!`,
      parse_mode: 'Markdown',
    });

    const fileId = sentVideo.video?.file_id || sentVideo.document?.file_id;
    if (fileId) {
      await saveCloudVaultEntry({
        name: dlResult.fileName,
        file_id: fileId,
        ext: 'mp4',
        category: 'media',
        size: dlResult.fileSize,
        date: Date.now(),
      });
    }

    // Save to local Drive D if mode allows
    const userMode = getUserStorageMode(ctx.from.id);
    if (userMode === 'local' || userMode === 'nosave') {
      try {
        const mediaDir = path.join(STORAGE_DIR, 'media');
        if (!fs.existsSync(mediaDir)) {
          await fsp.mkdir(mediaDir, { recursive: true });
        }
        const destPath = path.join(mediaDir, dlResult.fileName);
        await fsp.copyFile(dlResult.filePath, destPath);
      } catch (copyErr) {
        console.warn('Could not copy downloaded video to local Drive D:', sanitizeError(copyErr));
      }
    }

    // Record in search history
    await addSearchHistoryEntry({
      query: url,
      type: 'download',
      title: dlResult.fileName,
      url: url,
      resultsCount: 1,
    });

    await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
  } catch (err) {
    console.error('Download error:', sanitizeError(err));
    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      `❌ *Download failed:*\n\`${sanitizeError(err).slice(0, 200)}\`\n\nPlease check the link and try again.`,
      { parse_mode: 'Markdown' }
    );
  } finally {
    if (dlResult?.filePath) {
      await fsp.unlink(dlResult.filePath).catch(() => {});
    }
  }
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
    userPendingAction.set(ctx.from.id, { action: 'image', timestamp: Date.now() });
    await ctx.reply(
      '🎨 *Gemini Nano Banana Image Generator*\n\n' +
      'What picture would you like to generate?\n' +
      'Type your prompt below (e.g. `a cute fluffy orange cat in cyberpunk neon city, 4k digital art`):',
      { parse_mode: 'Markdown' }
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

    const caption =
      `🎨 *Image Generated*\n\n` +
      `📝 *Prompt:* ${prompt.slice(0, 300)}\n` +
      `⚡ *Engine:* \`${result.source}\`` +
      (result.note ? `\n\n💡 _${result.note}_` : '');

    await ctx.replyWithPhoto(new InputFile(result.buffer, 'gemini_image.jpg'), {
      caption: caption.slice(0, 1024),
      parse_mode: 'Markdown',
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
  await handleImageGeneration(ctx);
});

// YouTube Search Command
bot.command('youtube', async (ctx) => {
  const query = ctx.message.text.replace(/^\/youtube\s*/i, '').trim();
  if (!query) {
    userPendingAction.set(ctx.from.id, { action: 'youtube', timestamp: Date.now() });
    await ctx.reply(
      '🎥 *YouTube Search*\n\n' +
      'What YouTube video or music are you searching for?\n' +
      'Type your search below (e.g. `lofi hip hop` or `python full course`):',
      { parse_mode: 'Markdown' }
    );
    return;
  }
  await handleYoutubeSearch(ctx, query);
});

// Web & Research Search Command
bot.command(['search', 'find'], async (ctx) => {
  const query = ctx.message.text.replace(/^\/(search|find)\s*/i, '').trim();
  if (!query) {
    userPendingAction.set(ctx.from.id, { action: 'search', timestamp: Date.now() });
    await ctx.reply(
      '🌐 *AI Web & Research Search*\n\n' +
      'What would you like to search on the web?\n' +
      'Type your search topic below:',
      { parse_mode: 'Markdown' }
    );
    return;
  }
  await handleWebSearch(ctx, query);
});

// Video Downloader Command (YouTube & TikTok)
bot.command(['download', 'dl'], async (ctx) => {
  const url = ctx.message.text.replace(/^\/(download|dl)\s*/i, '').trim();
  if (!url || !url.startsWith('http')) {
    userPendingAction.set(ctx.from.id, { action: 'download', timestamp: Date.now() });
    await ctx.reply(
      '📥 *Video Downloader (YouTube & TikTok)*\n\n' +
      'Send or paste the video link you want to download below:',
      { parse_mode: 'Markdown' }
    );
    return;
  }
  await handleDownload(ctx, url);
});

bot.command('status', async (ctx) => {
  const uptime = Date.now() - botStartTime;
  const uptimeSeconds = Math.floor(uptime / 1000);
  const uptimeDays = Math.floor(uptimeSeconds / 86400);
  const uptimeHours = Math.floor((uptimeSeconds % 86400) / 3600);
  const uptimeMinutes = Math.floor((uptimeSeconds % 3600) / 60);
  const uptimeSecs = uptimeSeconds % 60;

  const totalMemory = os.totalmem();
  const freeMemory = os.freemem();
  const usedMemory = totalMemory - freeMemory;
  const memoryUsagePercent = ((usedMemory / totalMemory) * 100).toFixed(2);

  const cpuInfo = os.cpus();
  const cpuModel = cpuInfo[0].model;
  const cpuCount = cpuInfo.length;

  const loadAverage = os.loadavg();
  const load1min = loadAverage[0].toFixed(2);
  const load5min = loadAverage[1].toFixed(2);
  const load15min = loadAverage[2].toFixed(2);

  const processMemory = process.memoryUsage();
  const botMemoryUsage = (processMemory.heapUsed / 1024 / 1024).toFixed(2);
  const botMemoryTotal = (processMemory.heapTotal / 1024 / 1024).toFixed(2);

  const uptimeString = uptimeDays > 0
    ? `${uptimeDays}d ${uptimeHours}h ${uptimeMinutes}m ${uptimeSecs}s`
    : uptimeHours > 0
    ? `${uptimeHours}h ${uptimeMinutes}m ${uptimeSecs}s`
    : `${uptimeMinutes}m ${uptimeSecs}s`;

  const activeDoc = await getOrAutoLoadDocument(ctx.from.id);
  const statusMessage =
    `📊 *Bot Status*\n\n` +
    `⏱️ *Uptime:* ${uptimeString}\n\n` +
    `💾 *System Memory:*\n` +
    `├─ Total: ${(totalMemory / 1024 / 1024 / 1024).toFixed(2)} GB\n` +
    `├─ Used: ${(usedMemory / 1024 / 1024 / 1024).toFixed(2)} GB\n` +
    `├─ Free: ${(freeMemory / 1024 / 1024 / 1024).toFixed(2)} GB\n` +
    `└─ Usage: ${memoryUsagePercent}%\n\n` +
    `🤖 *Bot Memory:*\n` +
    `└─ ${botMemoryUsage} MB / ${botMemoryTotal} MB\n\n` +
    `🖥️ *CPU:*\n` +
    `├─ Model: ${cpuModel}\n` +
    `├─ Cores: ${cpuCount}\n` +
    `└─ Load Average: ${load1min} (1m), ${load5min} (5m), ${load15min} (15m)\n\n` +
    `💬 *Active Conversations:* ${conversationHistory.size}\n` +
    `📄 *Loaded Document:* ${activeDoc?.fileName ? `\`${activeDoc.fileName}\`` : '_None (unloaded)_'}\n` +
    `⚙️ *Upload Storage Mode:* ${getUserStorageMode(ctx.from.id) === 'cloud' ? '☁️ Cloud Only' : getUserStorageMode(ctx.from.id) === 'nosave' ? '💻 Local Only (/nosave)' : '💻+☁️ Local & Cloud (Dual)'}`;

  await ctx.reply(statusMessage, { parse_mode: 'Markdown' });
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

async function sendLongMessage(ctx, text, parseMode = 'Markdown') {
  const { safeText } = sanitizeAndCheckSecrets(text, 'outgoing_message');
  const MAX_LEN = 4000;
  if (safeText.length <= MAX_LEN) {
    try {
      await ctx.reply(safeText, { parse_mode: parseMode });
    } catch {
      await ctx.reply(safeText);
    }
    return;
  }

  for (let i = 0; i < safeText.length; i += MAX_LEN) {
    const chunk = safeText.slice(i, i + MAX_LEN);
    try {
      await ctx.reply(chunk, { parse_mode: parseMode });
    } catch {
      await ctx.reply(chunk);
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
    // 30-minute idle expiration: reset conversation history and loaded document
    conversationHistory.delete(userId);
    userLastDocument.delete(userId);
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
      '  - If the user asks about generating videos, let them know AI video generation is not supported and they can generate pictures using `/image <prompt>`.';

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

    const response = await anthropic.messages.create({
      model: anthropicModel,
      max_tokens: ANTHROPIC_MAX_TOKENS,
      system: systemInstruction,
      messages: history,
    });

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

    if (history.length > 20) {
      history.splice(0, 2);
    }

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

    history.pop();

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
    const base64Audio = Buffer.from(arrayBuffer).toString('base64');

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
  return new InlineKeyboard()
    .text(`☁️ Telegram Cloud Vault (${cloudVault.length})`, 'storage_cloud')
    .row()
    .text('💻 Local Storage (Drive D)', 'lib_src:local')
    .row()
    .text(`⚙️ Upload Destination: ${modeShort}`, 'open_storage_settings');
}

bot.command(['library', 'files'], async (ctx) => {
  const userId = ctx.from.id;
  const keyboard = buildSourcePickerKeyboard(userId);
  await ctx.reply(
    `📚 *Document & File Library*\n\n` +
    `Choose a storage location to browse (Files organized by category, sorted A-Z):\n\n` +
    `• ☁️ **Telegram Cloud Vault** (${cloudVault.length} file${cloudVault.length === 1 ? '' : 's'})\n` +
    `  Accessible 24/7 on your phone & any device.\n\n` +
    `• 💻 **Local Storage (Drive D)**\n` +
    `  Physical files located in \`${STORAGE_DIR}\` on your laptop.`,
    {
      parse_mode: 'Markdown',
      reply_markup: keyboard,
    }
  );
});

bot.on('callback_query:data', async (ctx) => {
  const data = ctx.callbackQuery.data;

  // Return to Storage Hub
  if (data === 'storage_main') {
    await ctx.answerCallbackQuery();
    const currentMode = getUserStorageMode(ctx.from.id);
    const modeLabels = {
      local: '💻+☁️ Local & Cloud (Dual Save)',
      cloud: '☁️ Cloud Only (No laptop space)',
      nosave: '💻 Local Only (/nosave - No cloud save)',
    };

    const keyboard = new InlineKeyboard()
      .text(`☁️ Telegram Cloud Vault (${cloudVault.length} files)`, 'storage_cloud')
      .row()
      .text('💻 Local Storage (Drive D)', 'lib_src:local')
      .row()
      .text(`⚙️ Upload Destination: ${modeLabels[currentMode]}`, 'open_storage_settings');

    await ctx.editMessageText(
      `⚙️ *Storage & Cloud Hub*\n\n` +
      `Current Upload Mode: *${modeLabels[currentMode]}*\n\n` +
      `Choose what you'd like to do:\n\n` +
      `• ☁️ **Telegram Cloud Vault**: Access your saved files & search history\n` +
      `• 💻 **Local Storage (Drive D)**: Files stored in \`${STORAGE_DIR}\` on your laptop\n` +
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
        `• Send any PDF, Python (.py), Code, or Document file to this chat.\n` +
        `• Or download videos using /youtube or /download.`,
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

  // Local Storage (Drive D) Categories View
  if (data === 'lib_src:local' || data === 'lib_refresh:local') {
    const files = await getStoredFiles();
    setUserCachedFiles(ctx.from.id, files);
    await ctx.answerCallbackQuery();

    if (files.length === 0) {
      if (cloudVault.length > 0) {
        // The bot is hosted on a cloud server (Render/Linux) where Drive D is remote,
        // but the user's laptop files are synced to Telegram Cloud Vault!
        const keyboard = buildCategoriesKeyboard(cloudVault, 'cloud');
        await ctx.editMessageText(
          `💻 *Drive D Files (Synced to Telegram Cloud Vault)*\n\n` +
          `Your bot is running 24/7 on a cloud server (Render). Because cloud servers cannot directly open your physical laptop hard drive, **your files from Drive D are synced safely in your Cloud Vault!**\n\n` +
          `Total Synced Files: *${cloudVault.length}*\n\n` +
          `Select a category below to browse (files are sorted **A-Z**):`,
          {
            parse_mode: 'Markdown',
            reply_markup: keyboard,
          }
        );
        return;
      }

      await ctx.editMessageText(
        `💻 *Local Storage (Drive D) is Empty*\n\n` +
        `Folder: \`${STORAGE_DIR}\`\n\n` +
        `• If running locally on your laptop, copy your files into that folder.\n` +
        `• If running on a cloud host (Render), run \`npm run sync\` on your laptop to sync files to your Cloud Vault!`,
        {
          parse_mode: 'Markdown',
          reply_markup: new InlineKeyboard()
            .text('🔄 Refresh Local', 'lib_src:local')
            .row()
            .text('☁️ Switch to Cloud Vault', 'storage_cloud'),
        }
      );
      return;
    }

    const keyboard = buildCategoriesKeyboard(files, 'local');
    await ctx.editMessageText(
      `💻 *Local Storage (Drive D) — File Categories*\n\n` +
      `Folder: \`${STORAGE_DIR}\`\n` +
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
        `• \`/youtube <query>\` - Search YouTube videos & download\n` +
        `• \`/search <query>\` - AI research & web search\n` +
        `• \`/download <url>\` - Download YouTube/TikTok video\n\n` +
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
      `Tap any search below to view details, re-run, or download:`,
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

    if (entry.type === 'youtube' && entry.url) {
      keyboard.text('📥 Download Video', `dl_hist:${entry.id}`).row();
    }

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
        keyboard.text(`📥 Download #${idx + 1}`, `dl_yt:${r.id}`).row();
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

  // Download video from history: dl_hist:<id>
  if (data.startsWith('dl_hist:')) {
    const id = data.replace('dl_hist:', '');
    const entry = getSearchHistoryEntry(id);
    if (!entry || !entry.url) {
      await ctx.answerCallbackQuery({ text: 'Video link not found!' });
      return;
    }

    await ctx.answerCallbackQuery({ text: 'Starting download...' });
    const statusMsg = await ctx.reply('⏳ *Downloading video...* Please wait.', { parse_mode: 'Markdown' });

    let dlResult = null;
    try {
      dlResult = await downloadMediaVideo(entry.url, TEMP_DOWNLOADS_DIR);
      if (dlResult.isOverTelegramLimit) {
        await ctx.api.editMessageText(
          ctx.chat.id,
          statusMsg.message_id,
          `⚠️ *Video is too large for Telegram upload (> 50 MB)*\nSize: ${(dlResult.fileSize / 1024 / 1024).toFixed(1)} MB.`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      await ctx.replyWithChatAction('upload_video');
      const sentVideo = await ctx.replyWithVideo(new InputFile(dlResult.filePath), {
        caption: `🎥 *${dlResult.fileName}*\n📦 Size: ${(dlResult.fileSize / 1024 / 1024).toFixed(1)} MB\n💾 Saved to Telegram Cloud Vault!`,
        parse_mode: 'Markdown',
      });

      const fileId = sentVideo.video?.file_id || sentVideo.document?.file_id;
      if (fileId) {
        await saveCloudVaultEntry({
          name: dlResult.fileName,
          file_id: fileId,
          ext: 'mp4',
          category: 'media',
          size: dlResult.fileSize,
          date: Date.now(),
        });
      }

      await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
    } catch (err) {
      console.error('History download error:', sanitizeError(err));
      await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `❌ *Download failed:* \`${sanitizeError(err).slice(0, 150)}\``, {
        parse_mode: 'Markdown',
      });
    } finally {
      if (dlResult?.filePath) {
        await fsp.unlink(dlResult.filePath).catch(() => {});
      }
    }
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

  // Download YouTube video from search result button: dl_yt:<id>
  if (data.startsWith('dl_yt:')) {
    const videoId = data.replace('dl_yt:', '');
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
    await ctx.answerCallbackQuery({ text: 'Starting video download...' });
    const statusMsg = await ctx.reply('⏳ *Downloading YouTube video...* Please wait a moment.', {
      parse_mode: 'Markdown',
    });

    let dlResult = null;
    try {
      dlResult = await downloadMediaVideo(videoUrl, TEMP_DOWNLOADS_DIR);

      // Save to local Drive D if mode allows
      const userMode = getUserStorageMode(ctx.from.id);
      let localSavedPath = null;
      if (userMode === 'local' || userMode === 'nosave') {
        try {
          const mediaDir = path.join(STORAGE_DIR, 'media');
          if (!fs.existsSync(mediaDir)) {
            await fsp.mkdir(mediaDir, { recursive: true });
          }
          const destPath = path.join(mediaDir, dlResult.fileName);
          await fsp.copyFile(dlResult.filePath, destPath);
          localSavedPath = destPath;
        } catch (copyErr) {
          console.warn('Could not copy downloaded video to local Drive D:', sanitizeError(copyErr));
        }
      }

      if (dlResult.isOverTelegramLimit) {
        await ctx.api.editMessageText(
          ctx.chat.id,
          statusMsg.message_id,
          `⚠️ *Video is too large for Telegram upload (> 50 MB)*\n\n` +
          `Size: ${(dlResult.fileSize / 1024 / 1024).toFixed(1)} MB.\n` +
          (localSavedPath ? `Saved locally on laptop at: \`${localSavedPath}\`\n` : '') +
          `Link: ${videoUrl}`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      await ctx.replyWithChatAction('upload_video');
      const sentVideo = await ctx.replyWithVideo(new InputFile(dlResult.filePath), {
        caption: `🎥 *${dlResult.fileName}*\n📦 Size: ${(dlResult.fileSize / 1024 / 1024).toFixed(1)} MB\n💾 Saved to Telegram Cloud Vault!`,
        parse_mode: 'Markdown',
      });

      const fileId = sentVideo.video?.file_id || sentVideo.document?.file_id;
      if (fileId) {
        await saveCloudVaultEntry({
          name: dlResult.fileName,
          file_id: fileId,
          ext: 'mp4',
          category: 'media',
          size: dlResult.fileSize,
          date: Date.now(),
        });
      }

      await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
    } catch (err) {
      console.error('Download error:', sanitizeError(err));
      await ctx.api.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        `❌ *Download failed:*\n\`${sanitizeError(err).slice(0, 200)}\``,
        { parse_mode: 'Markdown' }
      );
    } finally {
      if (dlResult?.filePath) {
        await fsp.unlink(dlResult.filePath).catch(() => {});
      }
    }
    return;
  }

  // Open storage settings from inline button
  if (data === 'open_storage_settings') {
    await ctx.answerCallbackQuery();
    const currentMode = getUserStorageMode(ctx.from.id);
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
      .text('◀️ Back to Storage Hub', 'storage_main');

    await ctx.editMessageText(
      `⚙️ *Storage Destination Settings*\n\n` +
      `Current Mode: *${modeLabels[currentMode]}*\n\n` +
      `Choose where newly uploaded files should be saved:\n\n` +
      `• ☁️ **Cloud Only**: Saved only to Telegram Cloud Vault. Takes 0 MB on laptop.\n` +
      `• 💻+☁️ **Local & Cloud**: Saved to both Drive D and Telegram Cloud Vault.\n` +
      `• 💻 **Local Only (/nosave)**: Saved only to Drive D. No cloud upload.`,
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
    userStorageMode.set(ctx.from.id, newMode);
    await ctx.answerCallbackQuery({ text: `Mode updated to ${newMode}!` });

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
      .text('⚙️ Back to Storage Hub', 'storage_main');

    await ctx.editMessageText(
      `✅ *Storage Mode Updated!*\n\n` +
      `Active Mode: *${modeLabels[newMode]}*\n\n` +
      `• ☁️ **Cloud Only**: Saves to Cloud Vault only (0 laptop space).\n` +
      `• 💻+☁️ **Local & Cloud**: Saves to both Drive D & Cloud Vault.\n` +
      `• 💻 **Local Only (/nosave)**: Saves to Drive D only.`,
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
    const keyboard = buildSourcePickerKeyboard(ctx.from.id);
    await ctx.editMessageText(
      `📚 *Document & File Library*\n\n` +
      `Choose a storage location to browse (Files organized by category, sorted A-Z):\n\n` +
      `• ☁️ *Telegram Cloud Vault* (${cloudVault.length} file${cloudVault.length === 1 ? '' : 's'})\n` +
      `  Files uploaded via Telegram chat. Accessible 24/7 on your phone and any device.\n\n` +
      `• 💻 *Local Storage (Drive D)*\n` +
      `  Physical files located in \`${STORAGE_DIR}\` on your laptop.`,
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

      await sendToClaudeWithHistory(ctx, prompt);
    } catch (err) {
      console.error('Error summarizing library file:', sanitizeError(err));
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
    userPendingAction.delete(ctx.from.id);
    return;
  }

  // Check if user is responding to an interactive prompt (/youtube, /search, /download, /image, /video)
  if (userPendingAction.has(ctx.from.id)) {
    const pending = userPendingAction.get(ctx.from.id);
    userPendingAction.delete(ctx.from.id);

    const isStale = pending.timestamp && (Date.now() - pending.timestamp > 5 * 60 * 1000);
    if (!isStale) {
      if (pending.action === 'youtube') {
        await handleYoutubeSearch(ctx, userMessage);
        return;
      }
      if (pending.action === 'search') {
        await handleWebSearch(ctx, userMessage);
        return;
      }
      if (pending.action === 'download') {
        await handleDownload(ctx, userMessage);
        return;
      }
      if (pending.action === 'image') {
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

// Register commands with Telegram so they appear in autocomplete menu when typing /
const botCommands = [
  { command: 'image', description: '🎨 Generate pictures with Gemini Nano Banana' },
  { command: 'search', description: 'AI research & web search powered by Claude' },
  { command: 'youtube', description: 'Search YouTube videos & download MP4' },
  { command: 'download', description: 'Download YouTube or TikTok video' },
  { command: 'library', description: 'Browse Cloud Vault & Drive D files (A-Z)' },
  { command: 'storage', description: 'Cloud Hub (Saved Files & Search History)' },
  { command: 'quiz', description: 'Take an interactive quiz on topic or document' },
  { command: 'status', description: 'View system resources, loaded file & mode' },
  { command: 'clear', description: 'Clear chat messages (keeps loaded file)' },
  { command: 'clearall', description: 'Clear all chat & unload file safely' },
  { command: 'nosave', description: 'Save new files to Drive D only' },
  { command: 'cloud', description: 'Save new files to Cloud Vault only' },
  { command: 'local', description: 'Save to both Drive D and Cloud Vault' },
  { command: 'start', description: 'Show welcome message and help' },
  { command: 'help', description: 'Show list of commands and guide' },
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
