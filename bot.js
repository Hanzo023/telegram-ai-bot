import 'dotenv/config';
import { Bot } from 'grammy';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
import { createRequire } from 'module';
import { readFile } from 'fs/promises';
import path from 'path';
import http from 'http';
import os from 'os';

const require = createRequire(import.meta.url);
const pdf = require('pdf-parse');

const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);
const allowedUserId = parseInt(process.env.ALLOWED_USER_ID);

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  baseURL: process.env.ANTHROPIC_BASE_URL,
});

const googleAI = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
});

const conversationHistory = new Map();
const botStartTime = Date.now();

bot.use(async (ctx, next) => {
  if (ctx.from?.id !== allowedUserId) {
    console.log(`Rejected message from unauthorized user: ${ctx.from?.id}`);
    return;
  }
  await next();
});

bot.command('start', async (ctx) => {
  await ctx.reply(
    'Hello! I\'m your personal AI assistant powered by Claude Haiku.\n\n' +
    'Just send me any message and I\'ll help you with your questions.\n\n' +
    'You can also send me:\n' +
    '• Voice messages & audio notes 🎙️ (powered by Gemini Flash)\n' +
    '• PDF files (.pdf)\n' +
    '• Text files (.txt)\n' +
    '• Python files (.py)\n\n' +
    'Commands:\n' +
    '/clear - Clear conversation history\n' +
    '/start - Show this message',
    { parse_mode: 'Markdown' }
  );
});

bot.command('clear', async (ctx) => {
  conversationHistory.delete(ctx.from.id);
  await ctx.reply('✅ Conversation history cleared!');
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

async function extractDocumentContent(file, ctx) {
  const fileExtension = file.file_path.split('.').pop().toLowerCase();

  try {
    const fileUrl = await ctx.api.getFile(file.file_id);
    const downloadUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${fileUrl.file_path}`;

    const response = await fetch(downloadUrl);
    const buffer = await response.arrayBuffer();

    if (fileExtension === 'pdf') {
      const data = await pdf(Buffer.from(buffer));
      return data.text;
    } else if (fileExtension === 'txt' || fileExtension === 'py') {
      return Buffer.from(buffer).toString('utf-8');
    }

    throw new Error('Unsupported file type');
  } catch (error) {
    console.error('Error extracting document content:', error);
    throw error;
  }
}

async function sendToClaudeWithHistory(ctx, content) {
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
  }, 5000);

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      messages: history,
    });

    clearInterval(typingInterval);

    const assistantMessage = response.content[0].text;

    history.push({
      role: 'assistant',
      content: assistantMessage,
    });

    if (history.length > 20) {
      history.splice(0, 2);
    }

    try {
      await ctx.reply(assistantMessage, { parse_mode: 'Markdown' });
    } catch (markdownError) {
      console.warn('Failed to send with Markdown, sending as plain text:', markdownError.message);
      await ctx.reply(assistantMessage);
    }
  } catch (error) {
    clearInterval(typingInterval);
    console.error('Error calling Claude API:', error);
    console.error('Full error details:', JSON.stringify(error, null, 2));

    history.pop();

    await ctx.reply(
      '❌ Sorry, I encountered an error processing your request. Please try again.',
      { parse_mode: 'Markdown' }
    );
  }
}

bot.on('message:document', async (ctx) => {
  const document = ctx.message.document;
  const fileName = document.file_name;
  const fileExtension = fileName.split('.').pop().toLowerCase();

  if (!['pdf', 'txt', 'py'].includes(fileExtension)) {
    await ctx.reply(
      '❌ Sorry, I can only process PDF (.pdf), text (.txt), and Python (.py) files.',
      { parse_mode: 'Markdown' }
    );
    return;
  }

  await ctx.reply(`📄 Processing ${fileName}...`);
  await ctx.replyWithChatAction('typing');

  try {
    const content = await extractDocumentContent(document, ctx);
    const prompt = `I've received a ${fileExtension.toUpperCase()} file named "${fileName}". Here's the content:\n\n${content}\n\nPlease analyze and explain this document.`;

    await sendToClaudeWithHistory(ctx, prompt);
  } catch (error) {
    console.error('Error processing document:', error);
    await ctx.reply(
      '❌ Sorry, I encountered an error processing the document. Please try again.',
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

async function handleVoiceMessage(ctx) {
  const voice = ctx.message.voice || ctx.message.audio;
  if (!voice) return;

  const userId = ctx.from.id;
  if (!conversationHistory.has(userId)) {
    conversationHistory.set(userId, []);
  }
  const history = conversationHistory.get(userId);

  await ctx.reply('🎧 Listening to your audio message...');
  const typingInterval = setInterval(() => {
    ctx.replyWithChatAction('typing').catch(() => {});
  }, 5000);

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

    const contents = history.slice(-6).map((msg) => ({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }],
    }));

    contents.push({
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
            'You are a personal AI assistant in Telegram. The user sent this voice message.\n\n' +
            'Instructions:\n' +
            '1. Accurately transcribe what the user said in the audio.\n' +
            '2. Provide a thoughtful, helpful, and direct response to what they said.\n\n' +
            'Format your reply like this:\n' +
            '🎤 *You said:* "<exact transcription>"\n\n' +
            '<your response>',
        },
      ],
    });

    const response = await callGeminiWithRetry(() =>
      googleAI.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: contents,
      })
    );

    clearInterval(typingInterval);

    const replyText = response.text || 'Sorry, I could not process the voice message.';

    history.push({
      role: 'user',
      content: '[Voice message audio]',
    });
    history.push({
      role: 'assistant',
      content: replyText,
    });

    if (history.length > 20) {
      history.splice(0, 2);
    }

    try {
      await ctx.reply(replyText, { parse_mode: 'Markdown' });
    } catch (markdownErr) {
      console.warn('Failed to send voice response with Markdown, sending plain text:', markdownErr.message);
      await ctx.reply(replyText);
    }
  } catch (error) {
    clearInterval(typingInterval);
    console.error('Error handling voice message with Gemini:', error);
    await ctx.reply('❌ Sorry, I encountered an error processing your voice note. Please try again.', {
      parse_mode: 'Markdown',
    });
  }
}

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

const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: Math.floor(process.uptime()) }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(PORT, () => {
  console.log(`Health check server listening on port ${PORT}`);
});

const shutdown = () => {
  console.log('Shutting down bot gracefully...');
  bot.stop();
  server.close(() => {
    process.exit(0);
  });
};

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

bot.start();
console.log('Bot is running...');
