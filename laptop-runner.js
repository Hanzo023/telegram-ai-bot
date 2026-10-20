import 'dotenv/config';
import { WebSocket } from 'ws';
import { exec } from 'child_process';
import fs from 'fs';
import { promises as fsp } from 'fs';
import path from 'path';
import os from 'os';

function getCliArg(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && idx + 1 < process.argv.length) {
    return process.argv[idx + 1].trim();
  }
  return null;
}

/**
 * Configuration
 */
const RAW_SERVER_URL =
  getCliArg('--server') ||
  process.env.SERVER_URL ||
  process.env.RENDER_EXTERNAL_URL ||
  process.env.PUBLIC_URL ||
  'https://telegram-ai-bot-znei.onrender.com';

let normalizedUrl = RAW_SERVER_URL.trim();
if (!/^wss?:\/\//i.test(normalizedUrl) && !/^https?:\/\//i.test(normalizedUrl)) {
  normalizedUrl = `wss://${normalizedUrl}`;
} else {
  normalizedUrl = normalizedUrl.replace(/^http:\/\//i, 'ws://').replace(/^https:\/\//i, 'wss://');
}
const SERVER_URL = normalizedUrl;

const RUNNER_SECRET =
  getCliArg('--secret') ||
  process.env.LAPTOP_RUNNER_SECRET ||
  (process.env.TELEGRAM_BOT_TOKEN ? process.env.TELEGRAM_BOT_TOKEN.slice(0, 20) : 'default_runner_secret');

const rawUserId =
  getCliArg('--user') ||
  process.env.TELEGRAM_USER_ID ||
  process.env.ALLOWED_USER_ID ||
  process.env.ALLOWED_USER_IDS ||
  '';

// Extract first valid integer ID
const idMatch = String(rawUserId).match(/-?\d+/);
const TELEGRAM_USER_ID = idMatch ? idMatch[0] : '';

const rawHostname = (os.hostname() || 'My-Laptop').replace(/\.local$/i, '');
const cleanUsername = os.userInfo ? (os.userInfo().username || '') : '';
const cleanOsVersion = os.version ? os.version() : os.release();
const DEVICE_NAME = getCliArg('--name') || process.env.DEVICE_NAME || rawHostname;

if (!TELEGRAM_USER_ID) {
  console.error('❌ ERROR: TELEGRAM_USER_ID could not be determined!');
  console.error('Please pass --user <id> or set TELEGRAM_USER_ID in .env or environment variables.');
  process.exit(1);
}

// Build WebSocket URL
function buildWsUrl() {
  const base = SERVER_URL.replace(/\/+$/, '');
  const targetPath = base.includes('/ws/laptop-agent') ? base : `${base}/ws/laptop-agent`;
  const url = new URL(targetPath);
  url.searchParams.set('secret', RUNNER_SECRET);
  url.searchParams.set('userId', TELEGRAM_USER_ID);
  url.searchParams.set('deviceName', DEVICE_NAME);
  url.searchParams.set('hostname', rawHostname);
  url.searchParams.set('platform', os.platform());
  url.searchParams.set('username', cleanUsername);
  url.searchParams.set('osVersion', cleanOsVersion);
  return url.toString();
}

console.log('========================================================');
console.log('💻 Telegram AI Remote Laptop Agent Runner');
console.log('========================================================');
console.log(`• Device Name:     ${DEVICE_NAME}`);
console.log(`• Hostname:        ${rawHostname}`);
console.log(`• User Account:    ${cleanUsername || 'User'}`);
console.log(`• OS & Version:    ${cleanOsVersion} (${os.platform()} ${os.arch()})`);
console.log(`• Target Server:   ${SERVER_URL}`);
console.log(`• Bound User ID:   ${TELEGRAM_USER_ID}`);
console.log(`• Outbound Only:   ✅ No open ports, fully secure on Public Wi-Fi`);
console.log('========================================================\n');

let ws = null;
let reconnectTimer = null;
let isExiting = false;

function connect() {
  if (isExiting) return;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  const wsUrl = buildWsUrl();
  console.log(`[Runner] Connecting to Cloud Agent Bridge at ${SERVER_URL}...`);

  try {
    ws = new WebSocket(wsUrl);

    // Keepalive ping timer to prevent cloud reverse proxy (Render) from timing out after 100s idle
    const pingInterval = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.ping();
        } catch {}
      }
    }, 20000);

    ws.on('open', async () => {
      console.log('✅ Connected to Cloud Agent Bridge! Waiting for commands from Telegram...');
      // Broadcast live hardware specs immediately upon connection for instant /status caching
      try {
        const specs = await handleTask('status', {});
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'initial_status', ...specs }));
          console.log('[Runner] 📊 Live system specs transmitted to server.');
        }
      } catch (specErr) {
        console.warn('[Runner] Could not send initial specs:', specErr.message);
      }
    });

    ws.on('ping', () => {
      try {
        ws.pong();
      } catch {}
    });

    ws.on('pong', () => {
      // Server pong received, connection is healthy
    });

    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'connected') {
          console.log(`[Runner] Server handshake confirmed: ${msg.message}`);
          return;
        }

        if (msg.id && msg.action) {
          console.log(`[Runner] 📥 Received task [${msg.id}]: action="${msg.action}"`);
          const response = await handleTask(msg.action, msg);
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ id: msg.id, ...response }));
            console.log(`[Runner] 📤 Completed task [${msg.id}]: success=${response.success}`);
          }
        }
      } catch (err) {
        console.error('[Runner] Error handling incoming message:', err.message);
      }
    });

    ws.on('close', (code, reason) => {
      clearInterval(pingInterval);
      const reasonStr = reason ? reason.toString() : '';
      let diag = '';
      if (code === 4001) {
        diag = ' (Secret mismatch: Check LAPTOP_RUNNER_SECRET or TELEGRAM_BOT_TOKEN)';
      } else if (code === 4003) {
        diag = ` (Unauthorized Telegram User ID: ${TELEGRAM_USER_ID} is not in ALLOWED_USER_ID on bot)`;
      } else if (code === 1006) {
        diag = ' (Connection dropped or target server unreachable)';
      }
      console.warn(`[Runner] Disconnected (code: ${code}${reasonStr ? `, reason: "${reasonStr}"` : ''})${diag}.`);
      scheduleReconnect();
    });

    ws.on('error', (err) => {
      console.error('[Runner] WebSocket connection error:', err.message);
    });
  } catch (err) {
    console.error('[Runner] Failed to initialize WebSocket:', err.message);
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (isExiting) return;
  if (reconnectTimer) return;
  console.log('[Runner] Reconnecting in 3 seconds...');
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 3000);
}

/**
 * Handle incoming RPC tasks from Cloud Agent
 */
async function handleTask(action, payload) {
  switch (action) {
    case 'run_command': {
      const { command, cwd } = payload;
      if (!command) return { success: false, error: 'No command provided.' };

      console.log(`[Runner] ⚙️ Executing: "${command}" (cwd: ${cwd || process.cwd()})`);

      return new Promise((resolve) => {
        // Use PowerShell on Windows for modern command execution, or bash/sh on Unix
        const shell = os.platform() === 'win32' ? 'powershell.exe' : '/bin/bash';
        const workingDir = cwd && fs.existsSync(cwd) ? cwd : process.cwd();

        exec(
          command,
          {
            cwd: workingDir,
            shell: shell,
            maxBuffer: 10 * 1024 * 1024, // 10 MB buffer
            timeout: 80000,
          },
          (error, stdout, stderr) => {
            resolve({
              success: !error,
              exitCode: error ? error.code || 1 : 0,
              stdout: stdout || '',
              stderr: stderr || (error ? error.message : ''),
            });
          }
        );
      });
    }

    case 'read_file': {
      const { filePath, maxLines = 200 } = payload;
      if (!filePath) return { success: false, error: 'No filePath provided.' };

      try {
        const resolvedPath = path.resolve(filePath);
        if (!fs.existsSync(resolvedPath)) {
          return { success: false, error: `File not found: ${resolvedPath}` };
        }

        const stat = await fsp.stat(resolvedPath);
        if (stat.isDirectory()) {
          return { success: false, error: `Path is a directory, not a file: ${resolvedPath}` };
        }

        const raw = await fsp.readFile(resolvedPath, 'utf8');
        const lines = raw.split(/\r?\n/);
        const truncated = lines.slice(0, maxLines).join('\n');
        const wasTruncated = lines.length > maxLines;

        return {
          success: true,
          filePath: resolvedPath,
          sizeBytes: stat.size,
          totalLines: lines.length,
          wasTruncated,
          content: truncated,
        };
      } catch (err) {
        return { success: false, error: `Read file error: ${err.message}` };
      }
    }

    case 'write_file': {
      const { filePath, content, encoding } = payload;
      if (!filePath) return { success: false, error: 'No filePath provided.' };

      try {
        const resolvedPath = path.resolve(filePath);
        const dir = path.dirname(resolvedPath);
        if (!fs.existsSync(dir)) {
          await fsp.mkdir(dir, { recursive: true });
        }

        if (encoding === 'base64') {
          const buf = Buffer.from(content || '', 'base64');
          await fsp.writeFile(resolvedPath, buf);
        } else {
          await fsp.writeFile(resolvedPath, content || '', 'utf8');
        }
        const stat = await fsp.stat(resolvedPath);

        return {
          success: true,
          filePath: resolvedPath,
          sizeBytes: stat.size,
          message: `Successfully wrote ${stat.size} bytes to ${resolvedPath}`,
        };
      } catch (err) {
        return { success: false, error: `Write file error: ${err.message}` };
      }
    }

    case 'delete_file': {
      const { filePath } = payload;
      if (!filePath) return { success: false, error: 'No filePath provided.' };
      try {
        const resolvedPath = path.resolve(filePath);
        if (!fs.existsSync(resolvedPath)) {
          return { success: false, error: `File not found: ${resolvedPath}` };
        }
        await fsp.unlink(resolvedPath);
        return {
          success: true,
          filePath: resolvedPath,
          message: `Successfully deleted ${path.basename(resolvedPath)}`,
        };
      } catch (err) {
        return { success: false, error: `Delete file error: ${err.message}` };
      }
    }

    case 'rename_file': {
      const { oldPath, newPath } = payload;
      if (!oldPath || !newPath) return { success: false, error: 'Missing oldPath or newPath.' };
      try {
        const resolvedOld = path.resolve(oldPath);
        const resolvedNew = path.resolve(newPath);
        if (!fs.existsSync(resolvedOld)) {
          return { success: false, error: `Original file not found: ${resolvedOld}` };
        }
        await fsp.rename(resolvedOld, resolvedNew);
        return {
          success: true,
          oldPath: resolvedOld,
          newPath: resolvedNew,
          message: `Successfully renamed to ${path.basename(resolvedNew)}`,
        };
      } catch (err) {
        return { success: false, error: `Rename file error: ${err.message}` };
      }
    }

    case 'list_dir': {
      const { dirPath } = payload;
      try {
        const targetDir = dirPath ? path.resolve(dirPath) : process.cwd();
        if (!fs.existsSync(targetDir)) {
          return { success: false, error: `Directory not found: ${targetDir}` };
        }

        const items = [];
        async function scanDir(currentDir, relativePrefix = '', depth = 0) {
          const entries = await fsp.readdir(currentDir, { withFileTypes: true });
          for (const e of entries) {
            const rel = relativePrefix ? path.join(relativePrefix, e.name) : e.name;
            const full = path.join(currentDir, e.name);
            if (e.isDirectory() && depth < 2) {
              await scanDir(full, rel, depth + 1);
            } else if (e.isFile()) {
              try {
                const stat = await fsp.stat(full);
                items.push({
                  name: e.name,
                  relPath: rel.replace(/\\/g, '/'),
                  fullPath: full,
                  size: stat.size,
                  mtime: stat.mtimeMs,
                  isFile: true,
                  isDirectory: false,
                });
              } catch {}
            }
          }
        }

        await scanDir(targetDir);

        return {
          success: true,
          dirPath: targetDir,
          totalItems: items.length,
          items: items.slice(0, 200),
        };
      } catch (err) {
        return { success: false, error: `List dir error: ${err.message}` };
      }
    }

    case 'status': {
      const totalMemMb = Math.round(os.totalmem() / 1024 / 1024);
      const freeMemMb = Math.round(os.freemem() / 1024 / 1024);
      const cpus = os.cpus();
      const cpuModel = cpus && cpus.length > 0 ? cpus[0].model.trim() : 'Processor';
      return {
        success: true,
        deviceName: DEVICE_NAME,
        hostname: rawHostname,
        platform: os.platform(),
        osVersion: cleanOsVersion,
        username: cleanUsername,
        arch: os.arch(),
        cpuCores: cpus.length,
        cpuModel,
        uptimeHours: (os.uptime() / 3600).toFixed(2),
        memory: {
          totalMb: totalMemMb,
          freeMb: freeMemMb,
          usedMb: totalMemMb - freeMemMb,
          usedPercent: (((totalMemMb - freeMemMb) / totalMemMb) * 100).toFixed(1),
        },
      };
    }

    default:
      return { success: false, error: `Unknown action: ${action}` };
  }
}

// Graceful shutdown
process.on('SIGINT', () => {
  isExiting = true;
  console.log('\n[Runner] Shutting down laptop agent runner...');
  if (ws) {
    try {
      ws.close();
    } catch {}
  }
  process.exit(0);
});

// Start initial connection
connect();
