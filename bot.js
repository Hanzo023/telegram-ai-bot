import 'dotenv/config';
import { Bot, InlineKeyboard } from 'grammy';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
import { PDFParse } from 'pdf-parse';
import fs from 'fs';
import { promises as fsp } from 'fs';
import path from 'path';
import http from 'http';
import os from 'os';

const STORAGE_DIR = process.env.STORAGE_DIR || 'D:\\drive-download-20260715T073323Z-1-001';
const VAULT_FILE = process.env.VAULT_FILE || path.resolve('./cloud_vault.json');

try {
  if (!fs.existsSync(STORAGE_DIR)) {
    fs.mkdirSync(STORAGE_DIR, { recursive: true });
  }
} catch (dirErr) {
  console.warn('Storage directory initialization note:', dirErr.message);
}

const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);
const rawAllowedId = (process.env.ALLOWED_USER_ID || '').trim();
const allowedUserId = rawAllowedId ? parseInt(rawAllowedId, 10) : null;

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  ...(process.env.ANTHROPIC_BASE_URL ? { baseURL: process.env.ANTHROPIC_BASE_URL } : {}),
});

const anthropicModel =
  process.env.ANTHROPIC_MODEL ||
  (process.env.ANTHROPIC_BASE_URL && !process.env.ANTHROPIC_BASE_URL.includes('anthropic.com')
    ? 'claude-haiku-4-5-20251001'
    : 'claude-3-5-haiku-20241022');

const googleAI = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
});

const conversationHistory = new Map();
const userLastDocument = new Map();
const botStartTime = Date.now();

const CODE_EXTENSIONS = ['py', 'java', 'cpp', 'cc', 'cxx', 'c', 'h', 'hpp', 'js', 'ts', 'cs', 'go', 'rs', 'html', 'css', 'sql'];
const DOC_EXTENSIONS = ['pdf', 'txt', 'md'];
const SUPPORTED_EXTENSIONS = [...CODE_EXTENSIONS, ...DOC_EXTENSIONS];

bot.use(async (ctx, next) => {
  if (!allowedUserId || ctx.from?.id !== allowedUserId) {
    console.log(`Rejected message from unauthorized user: ${ctx.from?.id}`);
    return;
  }
  await next();
});

bot.command('start', async (ctx) => {
  await ctx.reply(
    'Hello! I\'m your personal AI assistant powered by Claude & Gemini.\n\n' +
    'Just send me any message and I\'ll help you with your questions.\n\n' +
    'You can also send me:\n' +
    '• Code files: Python (.py), Java (.java), C++ (.cpp, .h)\n' +
    '• Documents: PDF (.pdf), Text (.txt), Markdown (.md)\n' +
    '• Voice messages & audio notes 🎙️\n\n' +
    'Commands:\n' +
    '/library - Browse files from Telegram Cloud Vault or Drive D\n' +
    '/quiz - Generate an interactive quiz poll on the last uploaded file or topic\n' +
    '/status - View bot and system resource usage\n' +
    '/clear - Clear conversation history\n' +
    '/start - Show this message',
    { parse_mode: 'Markdown' }
  );
});

bot.command('clear', async (ctx) => {
  const userId = ctx.from.id;
  const arg = ctx.message.text.replace(/^\/clear\s*/i, '').trim().toLowerCase();

  conversationHistory.delete(userId);

  if (arg === 'all' || arg === 'doc' || arg === 'file') {
    userLastDocument.delete(userId);
    await ctx.reply(
      '✅ *All conversation history & loaded document cleared!*\n\n' +
      'Claude has forgotten previous messages and unloaded any active file.\n\n' +
      '💡 *To clear visible message bubbles in Telegram:*\n' +
      'Tap the 3 dots (⋮) in the top-right corner → "Clear history".',
      { parse_mode: 'Markdown' }
    );
    return;
  }

  const activeDoc = userLastDocument.get(userId);
  if (activeDoc) {
    await ctx.reply(
      '✅ *Conversation messages cleared!*\n\n' +
      `📄 *Active Document Kept:* \`${activeDoc.fileName}\`\n` +
      `You can continue asking questions or quiz on this file without re-uploading!\n\n` +
      `💡 _To unload this document too, type \`/clear all\`._`,
      { parse_mode: 'Markdown' }
    );
  } else {
    await ctx.reply(
      '✅ *Conversation history cleared!*\n\n' +
      'Claude has forgotten previous messages.\n\n' +
      '💡 *To clear visible message bubbles in Telegram:*\n' +
      'Tap the 3 dots (⋮) in the top-right corner → "Clear history".',
      { parse_mode: 'Markdown' }
    );
  }
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
    `💬 *Active Conversations:* ${conversationHistory.size}`;

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
      console.warn('PDFParse extraction failed, trying Gemini OCR fallback:', pdfErr.message);
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
        console.error('Gemini PDF OCR fallback error:', ocrErr);
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

async function extractDocumentContent(file, ctx, fileExtension) {
  try {
    const fileUrl = await ctx.api.getFile(file.file_id);
    const downloadUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${fileUrl.file_path}`;

    const response = await fetch(downloadUrl);
    if (!response.ok) {
      throw new Error(`Failed to download file from Telegram: ${response.status} ${response.statusText}`);
    }
    const buffer = await response.arrayBuffer();

    const rawFileName = file.file_name || 'document';
    const safeFileName = path.basename(rawFileName).replace(/[\/\\]/g, '');
    const ext = fileExtension || (fileUrl.file_path ? fileUrl.file_path.split('.').pop().toLowerCase() : '');

    // Auto-save a copy directly to Drive D storage device (with path traversal protection)
    try {
      const storageRoot = path.resolve(STORAGE_DIR);
      const localFilePath = path.resolve(storageRoot, safeFileName);
      if (localFilePath.startsWith(storageRoot)) {
        await fsp.writeFile(localFilePath, Buffer.from(buffer));
        console.log(`Auto-saved document to Drive D: ${localFilePath}`);
      }
    } catch (saveErr) {
      console.warn('Could not auto-save file to Drive D storage:', saveErr.message);
    }

    // Auto-save entry to Telegram Cloud Vault
    try {
      await saveCloudVaultEntry({
        name: safeFileName,
        file_id: file.file_id,
        ext: ext,
        size: file.file_size || buffer.byteLength,
        date: Date.now(),
      });
      console.log(`Saved document to Telegram Cloud Vault: ${safeFileName}`);
    } catch (vaultErr) {
      console.warn('Could not save file to Telegram Cloud Vault:', vaultErr.message);
    }

    return await parseDocumentBuffer(buffer, ext, safeFileName);
  } catch (error) {
    const sanitizedMsg = (error.message || '').replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot[REDACTED]');
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

let cloudVault = [];
let vaultPinnedMessageId = null;

async function persistCloudVault() {
  try {
    await fsp.writeFile(VAULT_FILE, JSON.stringify(cloudVault, null, 2), 'utf-8');
  } catch (err) {
    console.warn('Failed to write cloud_vault.json to disk:', err.message);
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
      console.warn('Note: Telegram Cloud Vault sync note:', syncErr.message);
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
        }));
        vaultPinnedMessageId = pinned.message_id;
        await fsp.writeFile(VAULT_FILE, JSON.stringify(cloudVault, null, 2), 'utf-8');
        console.log(`Restored ${cloudVault.length} files from Telegram pinned message into Cloud Vault.`);
        return true;
      }
    }
  } catch (err) {
    console.warn('Note: Cloud Vault sync from Telegram pinned message skipped:', err.message);
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
        return;
      }
    }
  } catch (err) {
    console.warn('Could not read cloud_vault.json:', err.message);
  }

  // If local file is empty or missing, attempt to restore from Telegram pinned sync
  if (allowedUserId) {
    await restoreVaultFromTelegram();
  }
}

async function saveCloudVaultEntry({ name, file_id, ext, size, date }) {
  const newEntry = {
    id: Date.now().toString(),
    name,
    file_id,
    ext,
    size: size || 0,
    date: date || Date.now(),
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
    const sanitizedMsg = (error.message || '').replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot[REDACTED]');
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
        if (SUPPORTED_EXTENSIONS.includes(ext)) {
          const stats = await fsp.stat(fullPath);
          const relPath = path.relative(baseDir, fullPath).replace(/\\/g, '/');
          files.push({
            name: relPath,
            ext,
            size: stats.size,
            mtime: stats.mtimeMs,
          });
        }
      }
    }

    if (depth === 0) {
      files.sort((a, b) => b.mtime - a.mtime);
    }
    return files;
  } catch (err) {
    console.error('Error reading storage directory:', err);
    return [];
  }
}

async function sendLongMessage(ctx, text, parseMode = 'Markdown') {
  const MAX_LEN = 4000;
  if (text.length <= MAX_LEN) {
    try {
      await ctx.reply(text, { parse_mode: parseMode });
    } catch {
      await ctx.reply(text);
    }
    return;
  }

  for (let i = 0; i < text.length; i += MAX_LEN) {
    const chunk = text.slice(i, i + MAX_LEN);
    try {
      await ctx.reply(chunk, { parse_mode: parseMode });
    } catch {
      await ctx.reply(chunk);
    }
  }
}

async function getOrAutoLoadDocument(userId) {
  // 1. If document is already cached in memory for user, return it
  if (userLastDocument.has(userId)) {
    return userLastDocument.get(userId);
  }

  // 2. Check local storage directory (D:\drive-download-20260715T073323Z-1-001)
  try {
    const localFiles = await getStoredFiles();
    if (localFiles && localFiles.length > 0) {
      const latest = localFiles[0];
      const content = await loadLocalDocumentContent(latest.name);
      const docEntry = {
        fileName: latest.name,
        fileExtension: latest.ext,
        content: content,
        uploadedAt: latest.mtime || Date.now(),
        source: 'local',
      };
      userLastDocument.set(userId, docEntry);
      console.log(`Auto-loaded active document from local Drive D: ${latest.name}`);
      return docEntry;
    }
  } catch (err) {
    console.warn('Auto-load from local storage notice:', err.message);
  }

  // 3. Fall back to Telegram Cloud Vault
  try {
    if (cloudVault && cloudVault.length > 0) {
      const latestCloud = cloudVault[0];
      const content = await loadCloudDocumentContent(latestCloud.file_id, latestCloud.ext, latestCloud.name);
      const docEntry = {
        fileName: latestCloud.name,
        fileExtension: latestCloud.ext,
        content: content,
        uploadedAt: latestCloud.date || Date.now(),
        source: 'cloud',
      };
      userLastDocument.set(userId, docEntry);
      console.log(`Auto-loaded active document from Cloud Vault: ${latestCloud.name}`);
      return docEntry;
    }
  } catch (err) {
    console.warn('Auto-load from Cloud Vault notice:', err.message);
  }

  return null;
}

async function sendToClaudeWithHistory(ctx, content, systemOverride = null) {
  const userId = ctx.from.id;

  if (!conversationHistory.has(userId)) {
    conversationHistory.set(userId, []);
  }

  const history = conversationHistory.get(userId);
  history.push({
    role: 'user',
    content: content,
  });

  const typingInterval = setInterval(() => {
    ctx.replyWithChatAction('typing').catch(() => {});
  }, 4000);

  try {
    let systemInstruction = 'You are a helpful, expert AI assistant. Keep responses direct, clear, and thoughtful.';
    const activeDoc = await getOrAutoLoadDocument(userId);
    if (activeDoc) {
      const docExcerpt =
        activeDoc.content.length > 25000
          ? activeDoc.content.slice(0, 25000) + '\n\n[... Document excerpted to first 25,000 characters ...]'
          : activeDoc.content;
      systemInstruction +=
        `\n\nThe user currently has this file loaded in their workspace:\n` +
        `File Name: "${activeDoc.fileName}" (${activeDoc.fileExtension})\n` +
        `Content:\n\`\`\`\n${docExcerpt}\n\`\`\`\n` +
        `When the user asks questions, references code, or asks for refactoring/fixes, refer directly to this loaded file.`;
    }
    if (systemOverride) {
      systemInstruction = systemOverride;
    }

    const response = await anthropic.messages.create({
      model: anthropicModel,
      max_tokens: 2048,
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

    await sendLongMessage(ctx, assistantMessage);
  } catch (error) {
    clearInterval(typingInterval);
    console.error('Error calling Claude API:', error.status, error.message);

    history.pop();

    await ctx.reply(
      '❌ Sorry, I encountered an error processing your request. Please try again.',
      { parse_mode: 'Markdown' }
    );
  }
}

bot.on('message:document', async (ctx) => {
  const document = ctx.message.document;
  const rawFileName = document.file_name || 'document';
  const fileName = path.basename(rawFileName).replace(/[\/\\]/g, '');
  const fileExtension = fileName.split('.').pop().toLowerCase();

  if (!SUPPORTED_EXTENSIONS.includes(fileExtension)) {
    await ctx.reply(
      `❌ Unsupported file type (\`.${fileExtension}\`).\n\n` +
      `Supported formats:\n` +
      `• **Code**: Python (.py), Java (.java), C++ (.cpp, .c, .h)\n` +
      `• **Documents**: PDF (.pdf), Text (.txt), Markdown (.md)`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  // Silent typing indicator - no chatter messages
  await ctx.replyWithChatAction('typing');

  try {
    const content = await extractDocumentContent(document, ctx, fileExtension);

    // Save document to memory so all subsequent chat questions have this context
    userLastDocument.set(ctx.from.id, {
      fileName,
      fileExtension,
      content,
      uploadedAt: Date.now(),
    });

    const userCaption = (ctx.message.caption || '').trim();

    if (userCaption) {
      // User sent a specific prompt or question with the file: answer it directly!
      await sendToClaudeWithHistory(ctx, userCaption);
    } else {
      // User simply uploaded the file: confirm save without burning tokens or spamming quiz polls
      const icon = fileExtension === 'pdf' ? '📄' : CODE_EXTENSIONS.includes(fileExtension) ? '💻' : '📝';
      await ctx.reply(
        `${icon} *Saved \`${fileName}\` to your library.*\n\n` +
        `• ☁️ **Telegram Cloud Vault**: Ready on your phone & any device 24/7.\n` +
        `• 💻 **Drive D**: Saved to laptop storage.\n\n` +
        `• Ask me anything about it in chat.\n` +
        `• Type /quiz if you want to test your understanding.\n` +
        `• Or browse all files anytime with /library.`,
        { parse_mode: 'Markdown' }
      );
    }
  } catch (error) {
    console.error('Error processing document:', error);
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

    // Forward the transcription directly to Claude with full conversation history
    await sendToClaudeWithHistory(ctx, transcription);
  } catch (error) {
    clearInterval(typingInterval);
    const sanitizedMsg = (error.message || '').replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot[REDACTED]');
    console.error('Error handling hybrid voice message:', sanitizedMsg);
    await ctx.reply('❌ Sorry, I encountered an error processing your voice note. Please try again.', {
      parse_mode: 'Markdown',
    });
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
      '📚 *No document found in library or storage!*\n\n' +
      `I checked \`${STORAGE_DIR}\` and your Telegram Cloud Vault, but found no files.\n\n` +
      'To take a quiz, you can:\n' +
      '1. Put files in your Drive D folder or upload a file here in Telegram\n' +
      '2. Or run `/quiz <topic>` right now (e.g. `/quiz Python basics` or `/quiz C++ pointers`)',
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
    console.error('Error generating quiz polls:', err);
    await ctx.reply(
      '❌ Sorry, I had trouble creating the quiz questions. Please try again or specify a topic like `/quiz python basics`.',
      { parse_mode: 'Markdown' }
    );
  }
});

let cachedFilesList = [];

function buildSourcePickerKeyboard() {
  return new InlineKeyboard()
    .text(`☁️ Telegram Cloud Vault (${cloudVault.length})`, 'lib_src:cloud')
    .row()
    .text('💻 Local Storage (Drive D)', 'lib_src:local');
}

function buildLibraryKeyboard(files, source, page = 0) {
  const keyboard = new InlineKeyboard();
  const pageSize = 5;
  const totalPages = Math.ceil(files.length / pageSize) || 1;
  const start = page * pageSize;
  const pageFiles = files.slice(start, start + pageSize);

  for (let i = 0; i < pageFiles.length; i++) {
    const f = pageFiles[i];
    const globalIdx = start + i;
    const icon = f.ext === 'pdf' ? '📄' : CODE_EXTENSIONS.includes(f.ext) ? '💻' : '📝';
    const displayName = f.name.length > 28 ? '...' + f.name.slice(-25) : f.name;
    keyboard.text(`${icon} ${displayName}`, `lib_sel:${source}:${globalIdx}`).row();
  }

  // Pagination navigation
  const navButtons = [];
  if (page > 0) {
    navButtons.push(InlineKeyboard.text('◀️ Prev', `lib_page:${source}:${page - 1}`));
  }
  if (page < totalPages - 1) {
    navButtons.push(InlineKeyboard.text('Next ▶️', `lib_page:${source}:${page + 1}`));
  }
  if (navButtons.length > 0) {
    keyboard.row(...navButtons);
  }

  keyboard.row(
    InlineKeyboard.text('🔄 Refresh', `lib_refresh:${source}`),
    InlineKeyboard.text('📁 Change Storage', 'lib_sources')
  );
  return { keyboard, totalPages };
}

bot.command(['library', 'files'], async (ctx) => {
  const keyboard = buildSourcePickerKeyboard();
  await ctx.reply(
    `📚 *Document Library*\n\n` +
    `Choose a storage location to browse:\n\n` +
    `• ☁️ *Telegram Cloud Vault* (${cloudVault.length} file${cloudVault.length === 1 ? '' : 's'})\n` +
    `  Files uploaded via Telegram chat. Accessible 24/7 on your phone and any device.\n\n` +
    `• 💻 *Local Storage (Drive D)*\n` +
    `  Physical files located in \`${STORAGE_DIR}\` on your laptop.`,
    {
      parse_mode: 'Markdown',
      reply_markup: keyboard,
    }
  );
});

bot.on('callback_query:data', async (ctx) => {
  const data = ctx.callbackQuery.data;

  // Switch / return to source picker
  if (data === 'lib_sources') {
    await ctx.answerCallbackQuery();
    const keyboard = buildSourcePickerKeyboard();
    await ctx.editMessageText(
      `📚 *Document Library*\n\n` +
      `Choose a storage location to browse:\n\n` +
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

  // Open Telegram Cloud Vault
  if (data === 'lib_src:cloud' || data === 'lib_refresh:cloud') {
    await ctx.answerCallbackQuery(data === 'lib_refresh:cloud' ? { text: 'Cloud Vault refreshed!' } : undefined);

    if (cloudVault.length === 0) {
      await ctx.editMessageText(
        `☁️ *Telegram Cloud Vault is Empty*\n\n` +
        `You haven't uploaded any files to Telegram yet.\n\n` +
        `📤 *How to add files:*\n` +
        `Simply send any **PDF**, **Python (.py)**, **Java (.java)**, or **C++ (.cpp)** file directly to this chat from your phone or desktop. It will be stored in your Cloud Vault automatically!`,
        {
          parse_mode: 'Markdown',
          reply_markup: new InlineKeyboard()
            .text('🔄 Refresh Vault', 'lib_refresh:cloud')
            .row()
            .text('💻 Switch to Local Storage', 'lib_src:local'),
        }
      );
      return;
    }

    const { keyboard, totalPages } = buildLibraryKeyboard(cloudVault, 'cloud', 0);
    await ctx.editMessageText(
      `☁️ *Telegram Cloud Vault* (${cloudVault.length} file${cloudVault.length === 1 ? '' : 's'})\n` +
      `Accessible 24/7 on your phone & any device.\n\n` +
      `Page 1 of ${totalPages}. Select a file to quiz or summarize without re-uploading:`,
      {
        parse_mode: 'Markdown',
        reply_markup: keyboard,
      }
    );
    return;
  }

  // Open Local Storage (Drive D)
  if (data === 'lib_src:local' || data === 'lib_refresh:local') {
    const files = await getStoredFiles();
    cachedFilesList = files;
    await ctx.answerCallbackQuery(data === 'lib_refresh:local' ? { text: 'Local storage refreshed!' } : undefined);

    if (files.length === 0) {
      await ctx.editMessageText(
        `💻 *Local Storage (Drive D) is Empty*\n\n` +
        `Folder: \`${STORAGE_DIR}\`\n\n` +
        `⚠️ *Note:* If the bot is running in the cloud (on Render), it cannot access your physical laptop drive. Use **☁️ Telegram Cloud Vault** to access your files anywhere on your phone!\n\n` +
        `If running locally on your laptop, copy your files into that folder.`,
        {
          parse_mode: 'Markdown',
          reply_markup: new InlineKeyboard()
            .text('🔄 Refresh Local', 'lib_refresh:local')
            .row()
            .text('☁️ Switch to Cloud Vault', 'lib_src:cloud'),
        }
      );
      return;
    }

    const { keyboard, totalPages } = buildLibraryKeyboard(files, 'local', 0);
    await ctx.editMessageText(
      `💻 *Local Storage (Drive D)* (${files.length} file${files.length === 1 ? '' : 's'})\n` +
      `Folder: \`${STORAGE_DIR}\`\n\n` +
      `Page 1 of ${totalPages}. Select a file to quiz or summarize without re-uploading:`,
      {
        parse_mode: 'Markdown',
        reply_markup: keyboard,
      }
    );
    return;
  }

  // Pagination for either source: lib_page:<source>:<page>
  if (data.startsWith('lib_page:')) {
    const parts = data.split(':');
    const source = parts[1];
    const page = parseInt(parts[2], 10) || 0;

    let files = [];
    let title = '';
    let subtitle = '';

    if (source === 'cloud') {
      files = cloudVault;
      title = '☁️ *Telegram Cloud Vault*';
      subtitle = 'Accessible 24/7 on your phone & any device.';
    } else {
      files = await getStoredFiles();
      cachedFilesList = files;
      title = '💻 *Local Storage (Drive D)*';
      subtitle = `Folder: \`${STORAGE_DIR}\``;
    }

    const { keyboard, totalPages } = buildLibraryKeyboard(files, source, page);
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      `${title} (${files.length} file${files.length === 1 ? '' : 's'})\n` +
      `${subtitle}\n\n` +
      `Page ${page + 1} of ${totalPages}. Select a file to quiz or summarize without re-uploading:`,
      {
        parse_mode: 'Markdown',
        reply_markup: keyboard,
      }
    );
    return;
  }

  // Back to list: lib_back:<source>:<page>
  if (data.startsWith('lib_back:')) {
    const parts = data.split(':');
    const source = parts[1] || 'cloud';
    const page = parseInt(parts[2], 10) || 0;

    let files = [];
    let title = '';
    let subtitle = '';

    if (source === 'cloud') {
      files = cloudVault;
      title = '☁️ *Telegram Cloud Vault*';
      subtitle = 'Accessible 24/7 on your phone & any device.';
    } else {
      files = await getStoredFiles();
      cachedFilesList = files;
      title = '💻 *Local Storage (Drive D)*';
      subtitle = `Folder: \`${STORAGE_DIR}\``;
    }

    const { keyboard, totalPages } = buildLibraryKeyboard(files, source, page);
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      `${title} (${files.length} file${files.length === 1 ? '' : 's'})\n` +
      `${subtitle}\n\n` +
      `Page ${page + 1} of ${totalPages}. Select a file to quiz or summarize without re-uploading:`,
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
      if (!cachedFilesList || !cachedFilesList[idx]) {
        cachedFilesList = await getStoredFiles();
      }
      file = cachedFilesList[idx];
    }

    if (!file) {
      await ctx.answerCallbackQuery({ text: 'File not found!' });
      return;
    }

    await ctx.answerCallbackQuery();
    const page = Math.floor(idx / 5);
    const actionKeyboard = new InlineKeyboard()
      .text('🎲 3-Question Quiz', `lib_quiz:${source}:${idx}`)
      .text('📝 Detailed Summary', `lib_sum:${source}:${idx}`)
      .row()
      .text('🔙 Back to List', `lib_back:${source}:${page}`);

    if (source === 'cloud') {
      actionKeyboard.text('🗑️ Delete', `lib_del:${idx}`);
    }

    actionKeyboard.row().text('📁 Change Storage Source', 'lib_sources');

    const icon = file.ext === 'pdf' ? '📄' : CODE_EXTENSIONS.includes(file.ext) ? '💻' : '📝';
    const dateStr = new Date(file.date || file.mtime).toLocaleString();
    const sourceName = source === 'cloud' ? '☁️ Telegram Cloud Vault' : '💻 Local Storage (Drive D)';

    await ctx.editMessageText(
      `${icon} *Selected Document:*\n\`${file.name}\`\n\n` +
      `📦 *Size:* ${formatBytes(file.size)}\n` +
      `📅 *${source === 'cloud' ? 'Uploaded' : 'Modified'}:* ${dateStr}\n` +
      `📂 *Source:* ${sourceName}\n\n` +
      `What would you like to do with this file?`,
      {
        parse_mode: 'Markdown',
        reply_markup: actionKeyboard,
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
            .text('🔄 Refresh Vault', 'lib_refresh:cloud')
            .row()
            .text('💻 Switch to Local Storage', 'lib_src:local'),
        }
      );
      return;
    }

    const { keyboard, totalPages } = buildLibraryKeyboard(cloudVault, 'cloud', 0);
    await ctx.editMessageText(
      `☁️ *Telegram Cloud Vault* (${cloudVault.length} file${cloudVault.length === 1 ? '' : 's'})\n` +
      `Accessible 24/7 on your phone & any device.\n\n` +
      `Page 1 of ${totalPages}. Select a file to quiz or summarize without re-uploading:`,
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
      if (!cachedFilesList || !cachedFilesList[idx]) {
        cachedFilesList = await getStoredFiles();
      }
      file = cachedFilesList[idx];
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
        content = await loadLocalDocumentContent(file.name);
      }

      userLastDocument.set(ctx.from.id, {
        fileName: file.name,
        fileExtension: file.ext,
        content: content,
        uploadedAt: Date.now(),
      });

      const contextText = `Document: "${file.name}"\n\nContent:\n${content.slice(0, 15000)}`;
      const quizList = await generateQuizQuestions(contextText);
      await sendQuizPolls(ctx, quizList);
    } catch (err) {
      console.error('Error generating quiz from library file:', err);
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
      if (!cachedFilesList || !cachedFilesList[idx]) {
        cachedFilesList = await getStoredFiles();
      }
      file = cachedFilesList[idx];
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
        content = await loadLocalDocumentContent(file.name);
      }

      userLastDocument.set(ctx.from.id, {
        fileName: file.name,
        fileExtension: file.ext,
        content: content,
        uploadedAt: Date.now(),
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
      console.error('Error summarizing library file:', err);
      await ctx.reply('❌ Sorry, I encountered an error reading or summarizing the file.');
    }
    return;
  }
});

bot.on(['message:voice', 'message:audio'], handleVoiceMessage);

bot.on('message:text', async (ctx) => {
  const userMessage = ctx.message.text;

  if (userMessage.startsWith('/')) {
    return;
  }

  await ctx.replyWithChatAction('typing');
  await sendToClaudeWithHistory(ctx, userMessage);
});

bot.catch((err) => {
  console.error('Bot error:', err);
});

const PORT = process.env.PORT || 10000;
const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: Math.floor(process.uptime()) }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Health check server listening on 0.0.0.0:${PORT}`);
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
    console.error('Error stopping bot:', err);
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
  console.warn('Vault initialization note:', vaultErr.message);
}

// Register commands with Telegram so they appear in autocomplete menu when typing /
try {
  await bot.api.setMyCommands([
    { command: 'library', description: 'Browse Cloud Vault & Drive D files' },
    { command: 'quiz', description: 'Take an interactive quiz on topic or document' },
    { command: 'status', description: 'View bot and system resource usage' },
    { command: 'clear', description: 'Clear conversation history' },
    { command: 'start', description: 'Show welcome message and help' },
  ]);
  console.log('Commands registered with Telegram');
} catch (err) {
  console.warn('Failed to register Telegram commands:', err.message);
}

bot.start();
console.log('Bot is running...');
