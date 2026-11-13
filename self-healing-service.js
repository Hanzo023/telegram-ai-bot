import 'dotenv/config';
import fs from 'fs';
import { promises as fsp } from 'fs';
import path from 'path';
import os from 'os';
import { exec, execFile } from 'child_process';
import { GoogleGenAI } from '@google/genai';

/**
 * Self-Healing & Remote Hot-Patch Engine
 * 
 * Components:
 * 1. In-memory circular ring buffer for stdout/stderr logs and error tracebacks.
 * 2. Pre-flight syntax validation (Anti-Brick Guard) for JS, Python, and JSON.
 * 3. Gemini-powered code patch generator with automatic self-correction (up to 3 retries).
 * 4. GitHub REST API permanent sync (PUT /repos/{owner}/{repo}/contents/{path}).
 * 5. Instant hot-reload worker orchestrator.
 */

const MAX_LOG_LINES = 250;
const logRingBuffer = [];
let lastRecordedTraceback = null;
let lastTracebackTimestamp = 0;
let isBufferInitialized = false;

// Project root directory
const PROJECT_ROOT = process.cwd();

/**
 * Initialize in-memory capture of stdout and stderr
 */
export function initLogRingBuffer() {
  if (isBufferInitialized) return;
  isBufferInitialized = true;

  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);

  function pushLog(streamName, chunk, encoding) {
    try {
      const text = typeof chunk === 'string' ? chunk : chunk.toString(encoding || 'utf8');
      const lines = text.split(/\r?\n/);
      for (const line of lines) {
        if (!line.trim()) continue;
        const entry = {
          timestamp: new Date().toISOString(),
          stream: streamName,
          text: line,
        };
        logRingBuffer.push(entry);
        if (logRingBuffer.length > MAX_LOG_LINES) {
          logRingBuffer.shift();
        }

        // Detect stack traces / exceptions
        if (
          streamName === 'stderr' ||
          /\b(?:Error|TypeError|ReferenceError|SyntaxError|RangeError|UnhandledPromiseRejection|Traceback)\b/i.test(line) ||
          /^\s+at\s+/i.test(line)
        ) {
          appendTracebackLine(line);
        }
      }
    } catch {}
  }

  process.stdout.write = function (chunk, encoding, callback) {
    pushLog('stdout', chunk, encoding);
    return originalStdoutWrite(chunk, encoding, callback);
  };

  process.stderr.write = function (chunk, encoding, callback) {
    pushLog('stderr', chunk, encoding);
    return originalStderrWrite(chunk, encoding, callback);
  };
}

function appendTracebackLine(line) {
  const now = Date.now();
  if (now - lastTracebackTimestamp > 15000) {
    // Reset traceback window if previous error was more than 15s ago
    lastRecordedTraceback = line;
  } else {
    lastRecordedTraceback = (lastRecordedTraceback ? lastRecordedTraceback + '\n' : '') + line;
  }
  lastTracebackTimestamp = now;
}

/**
 * Record an explicit exception traceback
 */
export function recordExplicitTraceback(err, context = '') {
  const stack = err?.stack || err?.message || String(err);
  const formatted = context ? `[Context: ${context}]\n${stack}` : stack;
  lastRecordedTraceback = formatted;
  lastTracebackTimestamp = Date.now();
}

/**
 * Retrieve recent log lines formatted for Telegram
 * @param {number} [lineCount=50]
 * @returns {string}
 */
export function getRecentLogs(lineCount = 50) {
  const count = Math.min(lineCount, logRingBuffer.length);
  const slice = logRingBuffer.slice(-count);
  return slice
    .map((e) => {
      const time = e.timestamp.split('T')[1]?.slice(0, 8) || '';
      const prefix = e.stream === 'stderr' ? '⚠️' : 'ℹ️';
      return `${prefix} [${time}] ${e.text}`;
    })
    .join('\n');
}

/**
 * Retrieve the latest captured error traceback
 * @returns {string|null}
 */
export function getLastTraceback() {
  if (lastRecordedTraceback && (Date.now() - lastTracebackTimestamp < 300000)) {
    return lastRecordedTraceback.slice(-3000);
  }
  return null;
}

/**
 * Anti-Brick Guard: Pre-flight syntax validation before touching any production file.
 * 
 * Supports:
 * - JavaScript (.js, .mjs, .cjs) via `node --check`
 * - Python (.py) via `python -m py_compile`
 * - JSON (.json) via `JSON.parse`
 * 
 * @param {string} filePath - Target file path
 * @param {string} codeContent - Candidate code string to validate
 * @returns {Promise<{ valid: boolean, error?: string, details?: string }>}
 */
export async function validateSyntax(filePath, codeContent) {
  const ext = path.extname(filePath).toLowerCase();

  // 1. JSON Pre-flight
  if (ext === '.json') {
    try {
      JSON.parse(codeContent);
      return { valid: true };
    } catch (err) {
      return { valid: false, error: `JSON Parse Error: ${err.message}` };
    }
  }

  // 2. JavaScript Pre-flight (node --check)
  if (['.js', '.mjs', '.cjs'].includes(ext)) {
    const tempFile = path.join(os.tmpdir(), `preflight_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.js`);
    try {
      await fsp.writeFile(tempFile, codeContent, 'utf8');
      return await new Promise((resolve) => {
        execFile('node', ['--check', tempFile], { timeout: 6000 }, (error, stdout, stderr) => {
          if (error) {
            const cleanErr = (stderr || error.message || 'Syntax validation failed')
              .replace(new RegExp(tempFile.replace(/\\/g, '\\\\'), 'g'), path.basename(filePath));
            return resolve({
              valid: false,
              error: cleanErr.trim(),
            });
          }
          resolve({ valid: true });
        });
      });
    } catch (ioErr) {
      return { valid: false, error: `Pre-flight I/O Error: ${ioErr.message}` };
    } finally {
      try {
        if (fs.existsSync(tempFile)) await fsp.unlink(tempFile);
      } catch {}
    }
  }

  // 3. Python Pre-flight (python -m py_compile)
  if (ext === '.py') {
    const tempFile = path.join(os.tmpdir(), `preflight_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.py`);
    try {
      await fsp.writeFile(tempFile, codeContent, 'utf8');
      const pythonBin = process.env.PYTHON_BIN || 'python';
      return await new Promise((resolve) => {
        execFile(pythonBin, ['-m', 'py_compile', tempFile], { timeout: 6000 }, (error, stdout, stderr) => {
          if (error) {
            const cleanErr = (stderr || error.message || 'Python syntax error')
              .replace(new RegExp(tempFile.replace(/\\/g, '\\\\'), 'g'), path.basename(filePath));
            return resolve({
              valid: false,
              error: cleanErr.trim(),
            });
          }
          resolve({ valid: true });
        });
      });
    } catch (ioErr) {
      return { valid: false, error: `Python Pre-flight I/O Error: ${ioErr.message}` };
    } finally {
      try {
        if (fs.existsSync(tempFile)) await fsp.unlink(tempFile);
      } catch {}
    }
  }

  // Other file types (text, markdown, bat, etc.)
  if (codeContent && codeContent.trim().length > 0) {
    return { valid: true };
  }
  return { valid: false, error: 'File content cannot be empty.' };
}

/**
 * Intelligent file target finder based on user instruction and recent stack trace
 * @param {string} instruction - User prompt to /fix
 * @param {string} [traceback] - Recent traceback
 * @returns {string} - Relative or absolute path of target file
 */
export function findRelevantSourceFile(instruction, traceback = '') {
  // Known project files whitelist
  const KNOWN_PROJECT_FILES = [
    'browser-service.js',
    'gemini-agent-service.js',
    'gemini-live-service.js',
    'laptop-bridge.js',
    'laptop-runner.js',
    'search-service.js',
    'history-service.js',
    'live-call-server.js',
    'logger.js',
    'watchdog.js',
    'bot.js',
    'tools/request_approval.py',
    'tools/capture_app.py',
    'tools/list_windows.py',
  ];

  // 1. Check if user explicitly specified a file in their instruction
  const lowerInst = (instruction || '').toLowerCase();
  for (const f of KNOWN_PROJECT_FILES) {
    const base = path.basename(f).toLowerCase();
    if (lowerInst.includes(base) || lowerInst.includes(f.toLowerCase())) {
      return f;
    }
  }

  // 2. Check if traceback specifies a stack frame file within project
  if (traceback) {
    const stackMatches = Array.from(traceback.matchAll(/(?:at\s+.*?\()?([a-zA-Z0-9_\-\.\/\\]+\.(?:js|py|json)):(\d+)/gi));
    for (const match of stackMatches) {
      const candidate = path.basename(match[1]).toLowerCase();
      const found = KNOWN_PROJECT_FILES.find((f) => path.basename(f).toLowerCase() === candidate);
      if (found) return found;
    }
  }

  // Default to main entrypoint
  return 'bot.js';
}

/**
 * Generate patched code using Gemini API with Pre-flight Anti-Brick self-correction loop.
 * Retries up to 3 times if syntax validation fails.
 * 
 * @param {object} params
 * @param {string} params.instruction - User instructions on what to fix/change
 * @param {string} params.targetFile - Relative path to the file
 * @param {string} [params.traceback] - Recent error traceback
 * @param {function} [params.onProgress] - Real-time progress updates
 * @returns {Promise<{ success: boolean, patchedCode?: string, summary?: string, attempts: number, error?: string }>}
 */
export async function generateHotPatch({ instruction, targetFile, traceback = '', onProgress = null }) {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    return { success: false, error: 'GEMINI_API_KEY is not configured.' };
  }

  const resolvedPath = path.resolve(PROJECT_ROOT, targetFile);
  if (!fs.existsSync(resolvedPath)) {
    return { success: false, error: `Target source file not found: ${targetFile}` };
  }

  const currentContent = await fsp.readFile(resolvedPath, 'utf8');
  const ai = new GoogleGenAI({ apiKey });
  
  // Resilient model fallback pool (gemini-3.5-flash is stable and blazing fast during peak hours)
  const candidateModels = [
    'gemini-3.5-flash',
    'gemini-3.5-flash-lite',
    process.env.GEMINI_MODEL,
    'gemini-3.8-flash',
  ].filter(Boolean);
  const modelsToTry = [...new Set(candidateModels)];

  const systemPrompt = `You are a Principal Software Engineer & Autonomous Site Reliability Engineer.
Your task is to inspect the current production file, review the user's repair instructions and recent error traceback, and output a 100% syntactically valid, production-ready replacement for the file.

CRITICAL ARCHITECTURAL CONSTRAINTS:
1. PRESERVE EXISTING CAPABILITIES: Preserve all existing exports, imports, functions, comments, and logic unrelated to the fix.
2. SYNTAX PERFECTION: Ensure flawless JavaScript/Python syntax. Never emit truncated files, missing brackets, or placeholders.
3. OUTPUT FORMAT:
   - Begin with a short 2-4 bullet summary under the heading "### Summary of Changes".
   - Follow with the COMPLETE replacement file wrapped in a single markdown code block with the correct language tag (\`\`\`javascript or \`\`\`python).
   - Do NOT omit any unchanged functions or use comments like "// ...rest of file unchanged". Provide the complete file.`;

  let currentPrompt = `TARGET FILE: ${targetFile}\n\n` +
    (traceback ? `RECENT CRASH TRACEBACK / ERROR LOGS:\n\`\`\`\n${traceback.slice(-1500)}\n\`\`\`\n\n` : '') +
    `REPAIR INSTRUCTION:\n${instruction}\n\n` +
    `CURRENT FILE CONTENT:\n\`\`\`\n${currentContent}\n\`\`\``;

  let attempts = 0;
  const maxAttempts = 3;

  while (attempts < maxAttempts) {
    attempts++;
    onProgress?.(`🧠 *Gemini generating patch (attempt ${attempts}/${maxAttempts})...*`);

    try {
      let response = null;
      let lastGenError = null;

      for (const m of modelsToTry) {
        try {
          const timeoutMs = 35000;
          let timer;
          const timeoutPromise = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`Model ${m} timed out after ${timeoutMs}ms`)), timeoutMs);
          });
          const genPromise = ai.models.generateContent({
            model: m,
            contents: currentPrompt,
            config: {
              systemInstruction: systemPrompt,
              temperature: 0.2, // Low temperature for high precision code synthesis
            },
          });
          response = await Promise.race([genPromise, timeoutPromise]).finally(() => clearTimeout(timer));
          if (response && response.text) break;
        } catch (mErr) {
          lastGenError = mErr;
          console.warn(`[Hot-Patch Engine] Model ${m} failed (${mErr.message?.slice(0, 80)}). Trying fallback...`);
        }
      }

      if (!response || !response.text) {
        throw lastGenError || new Error('All candidate models failed to generate content.');
      }

      const responseText = response.text || '';
      
      // Extract summary
      const summaryMatch = responseText.match(/###\s*Summary of Changes([\s\S]*?)(?=```|$)/i);
      const summary = summaryMatch ? summaryMatch[1].trim() : 'Applied requested code updates.';

      // Extract code block
      const codeMatch = responseText.match(/```(?:[a-zA-Z0-9_\-]+)?\s*([\s\S]+?)```/);
      if (!codeMatch) {
        throw new Error('Gemini response did not contain a fenced code block with the complete patched file.');
      }

      const patchedCode = codeMatch[1].trim();

      onProgress?.(`🛡️ *Running Anti-Brick pre-flight syntax check...*`);
      const validation = await validateSyntax(targetFile, patchedCode);

      if (validation.valid) {
        return {
          success: true,
          patchedCode,
          summary,
          attempts,
          targetFile,
        };
      }

      // Pre-flight failed: prepare self-correction prompt for next iteration
      console.warn(`[Anti-Brick Guard] Syntax check failed on attempt ${attempts}: ${validation.error}`);
      onProgress?.(`⚠️ *Syntax validation failed (attempt ${attempts}):* ${validation.error.slice(0, 60)}... Self-correcting...`);

      if (attempts < maxAttempts) {
        currentPrompt = `PRE-FLIGHT SYNTAX VALIDATION ERROR ON PREVIOUS ATTEMPT:\n\`\`\`\n${validation.error}\n\`\`\`\n\n` +
          `Your previous output contained syntax errors that would break the bot. Please fix this exact syntax error and output the COMPLETE valid file in a single code block.\n\n` +
          `ORIGINAL INSTRUCTION:\n${instruction}`;
      } else {
        return {
          success: false,
          error: `Anti-Brick Guard rejected patch after ${maxAttempts} attempts due to syntax error:\n${validation.error}`,
          attempts,
        };
      }
    } catch (genErr) {
      console.error(`[Hot-Patch Engine] Generation error on attempt ${attempts}:`, genErr);
      if (attempts >= maxAttempts) {
        return { success: false, error: genErr.message, attempts };
      }
    }
  }

  return { success: false, error: 'Maximum patch attempts exhausted.', attempts };
}

/**
 * Permanent GitHub Synchronizer
 * Uses GitHub REST API to commit the updated file directly to the repository branch,
 * guaranteeing Render's next git-based redeploy keeps the changes permanently.
 * 
 * @param {object} params
 * @param {string} params.filePath - Relative path to file (e.g. "bot.js")
 * @param {string} params.fileContent - Complete UTF-8 content of patched file
 * @param {string} params.commitMessage - Commit message
 * @returns {Promise<{ success: boolean, sha?: string, htmlUrl?: string, reason?: string }>}
 */
export async function syncFileToGitHub({ filePath, fileContent, commitMessage }) {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_PAT;
  if (!token) {
    return {
      success: false,
      reason: 'GITHUB_TOKEN environment variable is not configured.',
    };
  }

  const repo = (process.env.GITHUB_REPO || 'Hanzo023/telegram-ai-bot').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '');
  const branch = (process.env.GITHUB_BRANCH || 'Testing-branch').trim();
  const normalizedPath = filePath.replace(/\\/g, '/').replace(/^\/+/, '');

  console.log(`[GitHub Sync] Pushing permanent commit to ${repo} (${branch}) for ${normalizedPath}...`);

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'telegram-ai-bot-self-healing-agent',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  try {
    // 1. Get current file SHA on branch
    let currentSha = null;
    const getUrl = `https://api.github.com/repos/${repo}/contents/${normalizedPath}?ref=${encodeURIComponent(branch)}`;
    const getRes = await fetch(getUrl, { headers });

    if (getRes.ok) {
      const getData = await getRes.json();
      currentSha = getData.sha;
    } else if (getRes.status !== 404) {
      const errText = await getRes.text();
      return {
        success: false,
        reason: `Failed to inspect ${normalizedPath} on GitHub (${getRes.status}): ${errText.slice(0, 150)}`,
      };
    }

    // 2. Put updated file content
    const putUrl = `https://api.github.com/repos/${repo}/contents/${normalizedPath}`;
    const base64Content = Buffer.from(fileContent, 'utf8').toString('base64');

    const putBody = {
      message: `[Auto-Fix via Phone] ${commitMessage.slice(0, 72)}`,
      content: base64Content,
      branch,
      ...(currentSha ? { sha: currentSha } : {}),
    };

    const putRes = await fetch(putUrl, {
      method: 'PUT',
      headers,
      body: JSON.stringify(putBody),
    });

    if (!putRes.ok) {
      const errText = await putRes.text();
      return {
        success: false,
        reason: `GitHub API Commit failed (${putRes.status}): ${errText.slice(0, 200)}`,
      };
    }

    const putData = await putRes.json();
    const commitSha = putData?.commit?.sha?.slice(0, 7) || 'HEAD';
    const htmlUrl = putData?.commit?.html_url || `https://github.com/${repo}/commit/${commitSha}`;

    console.log(`[GitHub Sync] Successfully committed to GitHub: ${commitSha} (${htmlUrl})`);
    return {
      success: true,
      sha: commitSha,
      htmlUrl,
      branch,
    };
  } catch (err) {
    return {
      success: false,
      reason: `GitHub Sync Network Error: ${err.message}`,
    };
  }
}

/**
 * Apply hot-patch to disk, sync permanently to GitHub, and signal worker restart.
 * 
 * @param {object} params
 * @param {string} params.targetFile - Target file path
 * @param {string} params.patchedCode - Validated code content
 * @param {string} params.summary - Summary of changes
 * @returns {Promise<{ success: boolean, backupFile?: string, githubSync: object, error?: string }>}
 */
export async function applyHotPatch({ targetFile, patchedCode, summary }) {
  const resolvedPath = path.resolve(PROJECT_ROOT, targetFile);

  // 1. Create a quick local backup
  const backupPath = `${resolvedPath}.bak_${Date.now()}`;
  try {
    if (fs.existsSync(resolvedPath)) {
      await fsp.copyFile(resolvedPath, backupPath);
    }
  } catch (bakErr) {
    console.warn(`[Hot-Patch] Backup note: ${bakErr.message}`);
  }

  // 2. Overwrite local file on disk immediately
  await fsp.writeFile(resolvedPath, patchedCode, 'utf8');
  console.log(`[Hot-Patch] Successfully wrote updated code to ${resolvedPath}`);

  // 3. Permanent GitHub Sync
  const githubSync = await syncFileToGitHub({
    filePath: targetFile,
    fileContent: patchedCode,
    commitMessage: summary,
  });

  // 4. Trigger Worker Hot-Reload
  triggerWorkerRestart(targetFile, summary);

  return {
    success: true,
    backupFile: backupPath,
    githubSync,
  };
}

/**
 * Signal the watchdog or host process to restart the worker cleanly
 */
export function triggerWorkerRestart(reason = 'HOT_PATCH', details = '') {
  console.log(`[Hot-Reload] Triggering graceful worker reload (${reason}: ${details})...`);

  // If running as a child process of watchdog.js with IPC enabled:
  if (process.send) {
    process.send({
      type: 'RELOAD_WORKER',
      reason,
      details,
      timestamp: Date.now(),
    });
    return;
  }

  // If standalone, exit cleanly so container manager or PM2/Docker restarts it
  setTimeout(() => {
    process.exit(0);
  }, 1000);
}

// Auto-initialize ring buffer on module load
initLogRingBuffer();
