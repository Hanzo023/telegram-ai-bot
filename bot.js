import 'dotenv/config';
import { Bot } from 'grammy';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
import { PDFParse } from 'pdf-parse';
import path from 'path';
import http from 'http';
import os from 'os';

const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);
const allowedUserId = parseInt(process.env.ALLOWED_USER_ID);

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
  if (ctx.from?.id !== allowedUserId) {
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
    '/quiz - Generate an interactive quiz poll on the last uploaded file or topic\n' +
    '/status - View bot and system resource usage\n' +
    '/clear - Clear conversation history\n' +
    '/start - Show this message',
    { parse_mode: 'Markdown' }
  );
});

bot.command('clear', async (ctx) => {
  conversationHistory.delete(ctx.from.id);
  userLastDocument.delete(ctx.from.id);
  await ctx.reply(
    '✅ *AI conversation context & uploaded files cleared!*\n\n' +
    'Claude has completely forgotten previous messages and documents.\n\n' +
    '💡 *To wipe the message bubbles from your screen:*\n' +
    'Click the **3 dots (⋮)** in the top-right corner of Telegram → **"Clear history"**.',
    { parse_mode: 'Markdown' }
  );
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

async function extractDocumentContent(file, ctx, fileExtension) {
  try {
    const fileUrl = await ctx.api.getFile(file.file_id);
    const downloadUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${fileUrl.file_path}`;

    const response = await fetch(downloadUrl);
    if (!response.ok) {
      throw new Error(`Failed to download file from Telegram: ${response.status} ${response.statusText}`);
    }
    const buffer = await response.arrayBuffer();

    const ext = fileExtension || (fileUrl.file_path ? fileUrl.file_path.split('.').pop().toLowerCase() : '');

    if (ext === 'pdf') {
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
  } catch (error) {
    console.error('Error extracting document content:', error);
    throw error;
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
      model: anthropicModel,
      max_tokens: 2048,
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
  const fileName = document.file_name || 'document';
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

  await ctx.reply(`📄 Analyzing ${fileName}...`);
  await ctx.replyWithChatAction('typing');

  try {
    const content = await extractDocumentContent(document, ctx, fileExtension);

    // Save document to memory for the /quiz command
    userLastDocument.set(ctx.from.id, {
      fileName,
      fileExtension,
      content,
      uploadedAt: Date.now(),
    });

    let prompt;
    if (CODE_EXTENSIONS.includes(fileExtension)) {
      prompt =
        `I've uploaded a ${fileExtension.toUpperCase()} source code file named "${fileName}". Here is the content:\n\n` +
        `\`\`\`${fileExtension}\n${content}\n\`\`\`\n\n` +
        `Please provide a comprehensive technical analysis:\n` +
        `1. 🎯 **Executive Summary**: What does this code do and what problem does it solve?\n` +
        `2. 🏗️ **Architecture & Key Components**: Breakdown of main classes, functions/methods, and structures.\n` +
        `3. ⚙️ **Core Logic & Complexity**: Explain the underlying algorithms and estimated time & space complexity.\n` +
        `4. ⚠️ **Observations & Edge Cases**: Potential bugs, unhandled conditions, or optimization suggestions.`;
    } else {
      const maxTextLen = 75000;
      const textToSend =
        content.length > maxTextLen
          ? content.slice(0, maxTextLen) + '\n\n[... Note: Document excerpted to first 75,000 characters for analysis ...]'
          : content;

      prompt =
        `I've uploaded a document named "${fileName}". Here is the extracted text content:\n\n` +
        `${textToSend}\n\n` +
        `Please provide a detailed, structured summary in the primary language of the document:\n` +
        `1. 📌 **Executive Overview**: Main topic, purpose, and central conclusion.\n` +
        `2. 🔑 **Key Takeaways & Core Concepts**: Crucial definitions, historical events, principles, or data.\n` +
        `3. 📖 **Section-by-Section Breakdown**: In-depth coverage of each major topic discussed.\n` +
        `4. 💡 **Actionable Insights / Conclusion**.`;
    }
    // Launch Claude's thinking & summarizing
    const claudeSummaryPromise = sendToClaudeWithHistory(ctx, prompt);

    // Concurrently launch Gemini's interactive quiz poll generation (0 Claude tokens)
    const geminiQuizPromise = generateQuizQuestions(
      `Document: "${fileName}"\n\nContent:\n${content.slice(0, 15000)}`
    ).catch((err) => {
      console.warn('Gemini background quiz generation note:', err.message);
      return null;
    });

    // Wait for Claude to deliver the comprehensive summary
    await claudeSummaryPromise;

    // Immediately present Gemini's quiz polls right below the summary
    const quizList = await geminiQuizPromise;
    if (quizList && quizList.length > 0) {
      await ctx.reply('🎲 **Interactive Quiz**: Test what you learned from this document!', { parse_mode: 'Markdown' });
      await sendQuizPolls(ctx, quizList);
    }
  } catch (error) {
    console.error('Error processing document:', error);
    await ctx.reply(
      '❌ Sorry, I encountered an error analyzing the file. Please try again.',
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

  await ctx.reply('🎧 Transcribing your voice message...');
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
    console.error('Error handling hybrid voice message:', error);
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
  const lastDoc = userLastDocument.get(userId);

  if (!topicArg && !lastDoc) {
    await ctx.reply(
      '📚 *No document uploaded yet!*\n\n' +
      'To take a quiz, you can:\n' +
      '1. Send me a **PDF**, **Python (.py)**, **Java (.java)**, or **C++ (.cpp)** file, then type `/quiz`\n' +
      '2. Or run `/quiz <topic>` right now (e.g. `/quiz C++ pointers` or `/quiz Java inheritance`)',
      { parse_mode: 'Markdown' }
    );
    return;
  }

  await ctx.reply('🎲 Generating your interactive quiz poll...');
  await ctx.replyWithChatAction('typing');

  try {
    let contextText = '';
    if (topicArg) {
      contextText = `Topic: "${topicArg}"`;
    } else {
      contextText = `Document: "${lastDoc.fileName}"\n\nContent:\n${lastDoc.content.slice(0, 15000)}`;
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

// Register commands with Telegram so they appear in autocomplete menu when typing /
try {
  await bot.api.setMyCommands([
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
