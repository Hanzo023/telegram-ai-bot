import 'dotenv/config';
import http from 'http';
import { fork } from 'child_process';
import path from 'path';
import {
  initLogRingBuffer,
  getRecentLogs,
  getLastTraceback,
  recordExplicitTraceback,
  findRelevantSourceFile,
  generateHotPatch,
  applyHotPatch,
} from './self-healing-service.js';

/**
 * Unkillable Watchdog Entrypoint for Render Free Tier
 * 
 * Features:
 * 1. Spawns and monitors main bot worker (`bot.js`).
 * 2. If child crashes, watchdog stays alive along with UptimeRobot HTTP health server.
 * 3. Immediately alerts ADMIN_USER_ID on Telegram with exact traceback.
 * 4. Attempts intelligent auto-recovery hot-patch using Gemini + Anti-Brick Guard.
 * 5. Handles emergency /fix and /logs Telegram polling when main bot is down.
 */

const PORT = parseInt(process.env.PORT, 10) || 10000;
const TELEGRAM_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const ADMIN_ID = process.env.ADMIN_USER_ID
  ? parseInt(process.env.ADMIN_USER_ID, 10)
  : (process.env.ALLOWED_USER_ID ? parseInt(process.env.ALLOWED_USER_ID, 10) : null);

let childProcess = null;
let emergencyServer = null;
let isEmergencyPolling = false;
let emergencyPollOffset = 0;
let emergencyPollTimeout = null;
let restartAttempts = 0;
let lastRestartTime = Date.now();
let isRestarting = false;

// Initialize log buffer
initLogRingBuffer();

/**
 * Send direct Telegram message via Bot API
 */
async function sendTelegramAlert(text, parseMode = 'Markdown') {
  if (!TELEGRAM_TOKEN || !ADMIN_ID) return;
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: ADMIN_ID,
        text: text.slice(0, 4000),
        parse_mode: parseMode,
      }),
    });
    if (!res.ok) {
      // Fallback without parse_mode if markdown has formatting issues
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: ADMIN_ID,
          text: text.replace(/[*_`\[\]()]/g, '').slice(0, 4000),
        }),
      });
    }
  } catch (err) {
    console.error('[Watchdog] Failed to send Telegram alert:', err.message);
  }
}

/**
 * Start Emergency HTTP Health Check Server
 * Keeps UptimeRobot and Render health probes alive (200 OK) while worker recovers.
 */
function startEmergencyServer() {
  if (emergencyServer) return;
  try {
    emergencyServer = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'recovery_mode',
        watchdog: true,
        uptimeSeconds: Math.floor(process.uptime()),
        message: 'Watchdog active in Emergency Recovery Mode. Main bot is recovering.',
        timestamp: new Date().toISOString(),
      }));
    });

    emergencyServer.on('error', (err) => {
      console.warn('[Watchdog] Emergency HTTP Server note:', err.message);
    });

    emergencyServer.listen(PORT, '0.0.0.0', () => {
      console.log(`[Watchdog] 🛡️ Emergency HTTP Health Server listening on 0.0.0.0:${PORT}`);
    });
  } catch (err) {
    console.warn('[Watchdog] Could not start emergency HTTP server:', err.message);
  }
}

/**
 * Stop Emergency HTTP Server to free port for child worker
 */
function stopEmergencyServer() {
  if (emergencyServer) {
    try {
      emergencyServer.close(() => {
        console.log('[Watchdog] Emergency HTTP Server closed; port freed for child worker.');
      });
    } catch {}
    emergencyServer = null;
  }
}

/**
 * Emergency Telegram Poller
 * Active ONLY when main bot worker is dead, allowing admin to send /fix and /logs from phone!
 */
async function startEmergencyTelegramPoller() {
  if (isEmergencyPolling || !TELEGRAM_TOKEN || !ADMIN_ID) return;
  isEmergencyPolling = true;
  console.log('[Watchdog] 📡 Emergency Telegram command listener activated for Admin.');

  async function pollLoop() {
    if (!isEmergencyPolling) return;
    try {
      const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?offset=${emergencyPollOffset}&timeout=10&allowed_updates=["message"]`;
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (res.ok) {
        const data = await res.json();
        const updates = data.result || [];
        for (const update of updates) {
          emergencyPollOffset = update.update_id + 1;
          const msg = update.message;
          if (!msg || !msg.text) continue;
          if (Number(msg.from?.id) !== Number(ADMIN_ID)) continue;

          const text = msg.text.trim();
          if (text.startsWith('/logs')) {
            const logs = getRecentLogs(50);
            const tb = getLastTraceback();
            let reply = `📋 *Recent Logs (Emergency Watchdog Mode):*\n\`\`\`\n${logs.slice(-3000)}\n\`\`\``;
            if (tb) reply += `\n\n💥 *Latest Traceback:*\n\`\`\`\n${tb.slice(-800)}\n\`\`\``;
            await sendTelegramAlert(reply);
          } else if (text.startsWith('/fix')) {
            const instruction = text.replace(/^\/fix\s*/i, '').trim();
            if (!instruction) {
              await sendTelegramAlert('🛠️ Usage: `/fix <instruction>`\nExample: `/fix fix the port error in bot.js`');
              continue;
            }
            await sendTelegramAlert(`🔍 *Watchdog Emergency Hot-Patch initiated:*\n"${instruction}"`);
            await handleAdminEmergencyFix(instruction);
          }
        }
      }
    } catch (pollErr) {
      // Ignore network timeouts during long poll
    }

    if (isEmergencyPolling) {
      emergencyPollTimeout = setTimeout(pollLoop, 1000);
    }
  }

  pollLoop();
}

function stopEmergencyTelegramPoller() {
  isEmergencyPolling = false;
  if (emergencyPollTimeout) {
    clearTimeout(emergencyPollTimeout);
    emergencyPollTimeout = null;
  }
}

/**
 * Handle /fix directly from watchdog while bot is crashed
 */
async function handleAdminEmergencyFix(instruction) {
  const tb = getLastTraceback() || '';
  const targetFile = findRelevantSourceFile(instruction, tb);

  try {
    const patchResult = await generateHotPatch({
      instruction,
      targetFile,
      traceback: tb,
      onProgress: (status) => sendTelegramAlert(status),
    });

    if (!patchResult.success) {
      await sendTelegramAlert(`❌ *Hot-Patch Failed:* ${patchResult.error}`);
      return;
    }

    await applyHotPatch({
      targetFile: patchResult.targetFile,
      patchedCode: patchResult.patchedCode,
      summary: patchResult.summary,
    });

    await sendTelegramAlert(
      `✅ *Hot-Patch Applied in Emergency Mode!*\n\n` +
      `• *Target File:* \`${patchResult.targetFile}\`\n` +
      `• *Summary:* ${patchResult.summary}\n\n` +
      `🚀 *Restarting bot worker now...*`
    );

    restartChild('EMERGENCY_ADMIN_FIX');
  } catch (err) {
    await sendTelegramAlert(`❌ *Emergency Fix Exception:* ${err.message}`);
  }
}

/**
 * Automatic Recovery Engine: Attempts self-healing when child crashes
 */
async function attemptSelfHealing(exitCode, traceback) {
  if (!process.env.GEMINI_API_KEY) {
    console.warn('[Watchdog] Cannot attempt auto-patch: GEMINI_API_KEY is not configured.');
    return false;
  }

  const targetFile = findRelevantSourceFile('fix fatal crash', traceback);
  console.log(`[Watchdog] 🤖 Autonomous Agent attempting self-healing for: ${targetFile}...`);
  await sendTelegramAlert(`🧠 *Watchdog Auto-Recovery:* Analyzing \`${targetFile}\` with Gemini...`);

  try {
    const instruction = 'Fix the fatal crash shown in the traceback. Ensure the code compiles, imports correctly, and starts cleanly.';
    const patchResult = await generateHotPatch({
      instruction,
      targetFile,
      traceback,
      onProgress: (msg) => console.log(`[Watchdog] ${msg}`),
    });

    if (patchResult.success) {
      await applyHotPatch({
        targetFile: patchResult.targetFile,
        patchedCode: patchResult.patchedCode,
        summary: `Auto-Recovery fix for crash (Exit code ${exitCode})`,
      });

      await sendTelegramAlert(
        `✅ *Auto-Recovery Patch Applied!* (Pre-flight passed)\n\n` +
        `• *Repaired:* \`${targetFile}\`\n` +
        `• *Summary:* ${patchResult.summary}\n\n` +
        `🔄 *Spawning clean bot worker...*`
      );
      return true;
    }
  } catch (healErr) {
    console.error('[Watchdog] Self-healing error:', healErr);
  }

  return false;
}

/**
 * Spawn the main bot worker child process
 */
function spawnBotWorker() {
  if (isRestarting) return;
  stopEmergencyServer();
  stopEmergencyTelegramPoller();

  console.log('[Watchdog] 🚀 Spawning bot worker (bot.js)...');
  const botPath = path.resolve(process.cwd(), 'bot.js');

  // Spawn with IPC enabled for instant reload signals
  childProcess = fork(botPath, [], {
    stdio: ['inherit', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, WATCHDOG_SUPERVISED: 'true' },
  });

  // Stream stdout & stderr into watchdog ring buffer & host stdout
  childProcess.stdout?.on('data', (chunk) => {
    process.stdout.write(chunk);
  });

  childProcess.stderr?.on('data', (chunk) => {
    process.stderr.write(chunk);
  });

  // Handle IPC messages from child (e.g. reload requests)
  childProcess.on('message', (msg) => {
    if (msg && msg.type === 'RELOAD_WORKER') {
      console.log(`[Watchdog] Received hot-reload request from worker (${msg.reason || 'manual'}).`);
      restartChild('WORKER_REQUEST');
    }
  });

  // Track worker crash or exit
  childProcess.on('exit', async (code, signal) => {
    childProcess = null;
    const now = Date.now();
    const cleanExit = code === 0 || signal === 'SIGTERM';

    console.log(`[Watchdog] Worker process exited (code: ${code}, signal: ${signal}).`);

    if (cleanExit) {
      console.log('[Watchdog] Worker exited cleanly. Restarting in 1s...');
      setTimeout(() => spawnBotWorker(), 1000);
      return;
    }

    // 💥 CRASH DETECTED
    console.error(`[Watchdog] 💥 FATAL CRASH: Bot worker exited with code ${code}!`);
    const tb = getLastTraceback() || 'No recent traceback captured.';
    recordExplicitTraceback(new Error(`Worker crash code ${code}`), tb);

    // 1. Immediately activate emergency HTTP server to maintain UptimeRobot & Render health
    startEmergencyServer();

    // 2. Alert Admin on Telegram with the exact traceback
    const alertMsg =
      `🚨 *BOT CRASH DETECTED!* (Exit Code: ${code})\n\n` +
      `*Error Traceback:*\n\`\`\`\n${tb.slice(-1200)}\n\`\`\`\n\n` +
      `🛡️ *Watchdog is active in Emergency Recovery Mode.*\n` +
      `• Send \`/logs\` to inspect full logs\n` +
      `• Send \`/fix <instruction>\` to hot-patch directly from your phone`;
    await sendTelegramAlert(alertMsg);

    // 3. Activate emergency Telegram poller so admin can issue /fix or /logs
    startEmergencyTelegramPoller();

    // 4. Rate-limit rapid crash loops
    if (now - lastRestartTime < 15000) {
      restartAttempts++;
    } else {
      restartAttempts = 1;
    }
    lastRestartTime = now;

    // 5. Attempt Autonomous Self-Healing with Gemini
    if (restartAttempts <= 3) {
      const healed = await attemptSelfHealing(code, tb);
      if (healed) {
        setTimeout(() => spawnBotWorker(), 2000);
        return;
      }
    }

    // If auto-healing was not triggered or exhausted, back off and wait for Admin /fix
    const backoffSec = Math.min(60, 5 * restartAttempts);
    console.log(`[Watchdog] Waiting ${backoffSec}s before automatic retry or awaiting admin /fix...`);
    setTimeout(() => {
      if (!childProcess && isEmergencyPolling) {
        spawnBotWorker();
      }
    }, backoffSec * 1000);
  });
}

function restartChild(reason = 'MANUAL') {
  isRestarting = true;
  console.log(`[Watchdog] Restarting child worker (${reason})...`);
  if (childProcess) {
    try {
      childProcess.kill('SIGTERM');
    } catch {}
  }
  setTimeout(() => {
    isRestarting = false;
    spawnBotWorker();
  }, 1200);
}

// Global process signal handlers
process.on('SIGTERM', () => {
  console.log('[Watchdog] SIGTERM received. Shutting down gracefully...');
  stopEmergencyServer();
  stopEmergencyTelegramPoller();
  if (childProcess) childProcess.kill('SIGTERM');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('[Watchdog] SIGINT received. Shutting down gracefully...');
  stopEmergencyServer();
  stopEmergencyTelegramPoller();
  if (childProcess) childProcess.kill('SIGINT');
  process.exit(0);
});

// Start initial bot worker
spawnBotWorker();
