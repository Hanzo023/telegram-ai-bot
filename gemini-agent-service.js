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
  isLaptopConnected,
} from './laptop-bridge.js';

const STORAGE_DIR = process.env.STORAGE_DIR || 'D:\\drive-download-20260715T073323Z-1-001';
const PRIMARY_MODEL = process.env.GEMINI_AGENT_MODEL || 'gemini-3.5-flash-lite';
const FALLBACK_MODEL = 'gemini-3.8-flash';

/**
 * Tool Declarations for Gemini Interactions API
 */
export const AGENT_TOOLS = [
  {
    type: 'function',
    name: 'run_laptop_terminal',
    description: 'Execute a terminal command (PowerShell / Bash) on the user\'s physical laptop to install packages, run tests, fix code, or inspect processes while they are away.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The terminal command line to execute (e.g. "npm install express", "python test.py", "git status")' },
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
      const effectiveCwd = cwd || context.userDirectory || undefined;
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
      let effectivePath = rawPath;
      if (effectivePath && !path.isAbsolute(effectivePath) && context.userDirectory) {
        effectivePath = path.join(context.userDirectory, effectivePath);
      }
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
      let effectivePath = rawPath;
      if (effectivePath && !path.isAbsolute(effectivePath) && context.userDirectory) {
        effectivePath = path.join(context.userDirectory, effectivePath);
      }
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
export async function runGeminiAgent({ prompt, onStatusUpdate, maxSteps = 8, userId, userDirectory }) {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured in environment variables.');
  }

  const ai = new GoogleGenAI({ apiKey });
  const stepsExecuted = [];

  // Models to attempt: primary (gemini-3.5-flash-lite) -> fallback (gemini-3.8-flash)
  const candidateModels = [PRIMARY_MODEL, FALLBACK_MODEL];
  let lastError = null;

  for (const model of candidateModels) {
    try {
      if (onStatusUpdate) {
        onStatusUpdate(`🤖 *Agent reasoning with ${model}...*`);
      }

      let currentResponse = await ai.interactions.create({
        model,
        input: prompt,
        tools: AGENT_TOOLS,
        system_instruction:
          'You are an autonomous AI Agent in Telegram with access to tools (web search, YouTube, drive files, calculations, system status, AND live laptop control). ' +
          `User laptop target directory: "${userDirectory || 'default working directory'}". ` +
          '\n\nAUTONOMOUS SCRIPT CREATION, INSTALLATION & EXECUTION RULES:\n' +
          '• When the user asks you to run commands, install software, download or create a file, or write and run a Python/Node script on their laptop:\n' +
          '  1. INSTALL DEPENDENCIES: If any external packages or libraries are required (e.g. pip install requests, pip install beautifulsoup4, npm install axios), execute them first using run_laptop_terminal.\n' +
          '  2. WRITE FILE: Write the complete, production-ready script with zero omissions or placeholders using write_laptop_file into their target folder.\n' +
          '  3. RUN SCRIPT: Execute the script on their laptop using run_laptop_terminal (e.g. "python myscript.py") to verify it works and observe the output.\n' +
          '  4. GUIDE USER: In your final answer, clearly tell them:\n' +
          '     • What packages you installed.\n' +
          '     • Exactly what file was created and its path on their machine.\n' +
          '     • The output produced by the script.\n' +
          '     • What to do next or how they can run it again.\n' +
          '• If the laptop is disconnected, explain that their runner is offline (instruct them to use /setup_laptop to receive their personalized runner files or 1-line PowerShell installer directly in Telegram), and provide the complete script and exact manual terminal commands as a fallback.',
      });

      let stepCount = 0;

      while (stepCount < maxSteps) {
        stepCount++;
        const steps = currentResponse.steps || [];
        const functionCallStep = steps.find((s) => s.type === 'function_call');

        if (!functionCallStep) {
          // No more tool calls; final answer reached
          const finalAnswer =
            currentResponse.output_text ||
            steps
              .filter((s) => s.type === 'text')
              .map((s) => s.text)
              .join('\n')
              .trim() ||
            'Task completed.';

          return {
            finalAnswer,
            stepsExecuted,
            success: true,
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

        const toolResult = await executeTool(toolName, toolArgs, { userId, userDirectory });

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
      return {
        finalAnswer: currentResponse.output_text || 'Completed maximum agent tool iterations.',
        stepsExecuted,
        success: true,
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
