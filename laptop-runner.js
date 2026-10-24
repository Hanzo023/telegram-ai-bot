import 'dotenv/config';
import { WebSocket } from 'ws';
import { exec, execFile } from 'child_process';
import http from 'http';
import fs from 'fs';
import { promises as fsp } from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
  'https://your-bot-name.onrender.com';

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
const RUNNER_STORAGE_DIR =
  getCliArg('--dir') ||
  process.env.STORAGE_DIR ||
  process.cwd();

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
  url.searchParams.set('storageDir', RUNNER_STORAGE_DIR);
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

const LOG_FILE = path.resolve(__dirname, 'runner.log');

/**
 * Check if path targets sensitive system directories (prevent directory traversal)
 */
function isRestrictedSystemPath(targetPath) {
  if (!targetPath) return false;
  try {
    const resolved = path.resolve(targetPath).toLowerCase();
    const winDir = (process.env.SystemRoot || 'C:\\Windows').toLowerCase();
    const sysDrive = (process.env.SystemDrive || 'C:').toLowerCase();
    if (resolved.startsWith(winDir) || resolved.startsWith(`${sysDrive}\\windows`)) {
      return true;
    }
  } catch {}
  return false;
}

function log(msg) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
  } catch {}
}

process.on('uncaughtException', (err) => {
  log(`[CRITICAL] Uncaught exception: ${err.message}`);
  scheduleReconnect();
});

process.on('unhandledRejection', (reason) => {
  log(`[WARNING] Unhandled rejection: ${reason}`);
});

let ws = null;
let pingInterval = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let isExiting = false;

let cachedHardwareExtra = {
  gpu: '',
  battery: '',
  disks: [],
  lastRefreshed: 0,
};

async function refreshHardwareInfo(force = false) {
  if (os.platform() !== 'win32') return cachedHardwareExtra;
  if (!force && Date.now() - cachedHardwareExtra.lastRefreshed < 10000) {
    return cachedHardwareExtra;
  }
  return new Promise((resolve) => {
    const cmd = `powershell -NoProfile -Command "(Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name) -join ';;'; (Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue | Select-Object -ExpandProperty EstimatedChargeRemaining); (Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object { $_.DeviceID + ' ' + [math]::Round($_.FreeSpace/1GB,1) + ' GB free of ' + [math]::Round($_.Size/1GB,1) + ' GB' }) -join ';;'"`;
    exec(cmd, { timeout: 8000 }, (err, stdout) => {
      if (!err && stdout) {
        const lines = stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
        if (lines[0]) {
          cachedHardwareExtra.gpu = lines[0].split(';;').map((g) => g.trim()).filter(Boolean).join(' + ');
        }
        if (lines[1]) {
          cachedHardwareExtra.battery = `${lines[1]}%`;
        }
        if (lines[2]) {
          cachedHardwareExtra.disks = lines[2].split(';;').map((d) => d.trim()).filter(Boolean);
        }
        cachedHardwareExtra.lastRefreshed = Date.now();
      }
      resolve(cachedHardwareExtra);
    });
  });
}


/**
 * Local IPC Loopback Server for receiving approval snapshot events from local scripts/tools
 */
const IPC_PORT = parseInt(process.env.LAPTOP_RUNNER_IPC_PORT || '52199', 10);
let ipcServer = null;

function startIpcServer() {
  return new Promise((resolve) => {
    try {
      ipcServer = http.createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/approval') {
          let body = '';
          req.on('data', chunk => {
            body += chunk;
          });
          req.on('end', () => {
            try {
              const data = JSON.parse(body);
              log(`[Runner IPC] 📸 Received local approval request: "${data.windowTitle || 'Unknown'}"`);

              if (ws && ws.readyState === WebSocket.OPEN) {
                const approvalPayload = {
                  type: 'APPROVAL_REQUIRED',
                  approvalId: data.approvalId || data.id || `appr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
                  windowTitle: data.windowTitle || 'Prompt Window',
                  isDesktopFallback: Boolean(data.isDesktopFallback),
                  bounds: data.bounds || null,
                  image: data.image || '',
                  timestamp: data.timestamp || Date.now(),
                };
                ws.send(JSON.stringify(approvalPayload));
                log(`[Runner IPC] 🚀 Forwarded APPROVAL_REQUIRED event to Cloud Agent Bridge.`);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, forwarded: true }));
              } else {
                res.writeHead(503, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Laptop runner is not connected to cloud bridge.' }));
              }
            } catch (parseErr) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: false, error: parseErr.message }));
            }
          });
          return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      });

      ipcServer.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          log(`[Runner IPC] ⚠️ Port ${IPC_PORT} is already in use by another active runner instance.`);
          log(`[Runner] Exiting this process to prevent duplicate connection conflicts and notification loops.`);
          resolve(false);
          return;
        }
        log(`[Runner IPC] Server error: ${err.message}`);
        resolve(true);
      });

      ipcServer.listen(IPC_PORT, '127.0.0.1', () => {
        log(`[Runner IPC] 📡 Local approval IPC listener active on http://127.0.0.1:${IPC_PORT}/approval`);
        resolve(true);
      });
    } catch (err) {
      log(`[Runner IPC] Failed to start local IPC server: ${err.message}`);
      resolve(true);
    }
  });
}

/**
 * Run tools/request_approval.py to capture snapshots or execute input actions
 */
function runApprovalTool(args = [], timeoutMs = 25000) {
  return new Promise((resolve) => {
    const scriptPath = path.resolve(process.cwd(), 'tools', 'request_approval.py');
    if (!fs.existsSync(scriptPath)) {
      return resolve({ success: false, error: `Approval script not found at: ${scriptPath}` });
    }

    const pythonCmd = process.env.PYTHON_BIN || 'python';
    execFile(
      pythonCmd,
      [scriptPath, ...args],
      {
        maxBuffer: 20 * 1024 * 1024,
        timeout: timeoutMs,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error && !stdout) {
          return resolve({
            success: false,
            error: stderr || error.message,
            exitCode: error.code || 1,
          });
        }

        try {
          const parsed = JSON.parse(stdout.trim());
          resolve(parsed);
        } catch (parseErr) {
          resolve({
            success: false,
            error: `Failed to parse approval script JSON output: ${parseErr.message}`,
            rawStdout: stdout?.slice(0, 500),
            rawStderr: stderr,
          });
        }
      }
    );
  });
}

function connect() {
  if (isExiting) return;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (pingInterval) {
    clearInterval(pingInterval);
    pingInterval = null;
  }
  if (ws) {
    try {
      ws.removeAllListeners();
      ws.terminate();
    } catch {}
    ws = null;
  }

  const wsUrl = buildWsUrl();
  log(`[Runner] Connecting to Cloud Agent Bridge at ${SERVER_URL}...`);

  try {
    ws = new WebSocket(wsUrl);

    // Keepalive ping timer (every 5 seconds) to prevent cloud reverse proxy (Render) from timing out
    pingInterval = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.ping();
        } catch {}
      }
    }, 5000);

    ws.on('open', async () => {
      reconnectAttempts = 0;
      log('✅ Connected to Cloud Agent Bridge! Waiting for commands from Telegram...');
      // Broadcast live hardware specs immediately upon connection for instant /status and /spec caching
      try {
        await refreshHardwareInfo(true);
        const specs = await handleTask('status', {});
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'initial_status', storageDir: RUNNER_STORAGE_DIR, ...specs }));
          log('[Runner] 📊 Live system specs transmitted to server.');
        }
      } catch (specErr) {
        log(`[Runner] Could not send initial specs: ${specErr.message}`);
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
          log(`[Runner] Server handshake confirmed: ${msg.message}`);
          return;
        }

        if (msg.type === 'error') {
          log(`[Runner] ❌ Bridge Error: ${msg.message}`);
          return;
        }

        if (msg.id && msg.action) {
          log(`[Runner] 📥 Received task [${msg.id}]: action="${msg.action}"`);
          const response = await handleTask(msg.action, msg);
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ id: msg.id, ...response }));
            log(`[Runner] 📤 Completed task [${msg.id}]: success=${response.success}`);
          }
        }
      } catch (err) {
        log(`[Runner] Error handling incoming message: ${err.message}`);
      }
    });

    ws.on('close', (code, reason) => {
      if (pingInterval) {
        clearInterval(pingInterval);
        pingInterval = null;
      }
      const reasonStr = reason ? reason.toString() : '';
      let diag = '';
      if (code === 4001) {
        diag = ' (Secret mismatch: Check LAPTOP_RUNNER_SECRET or TELEGRAM_BOT_TOKEN)';
      } else if (code === 4003) {
        diag = ` (Unauthorized Telegram User ID: ${TELEGRAM_USER_ID} is not in ALLOWED_USER_ID on bot)`;
      } else if (code === 1006) {
        diag = ' (Connection dropped or target server unreachable)';
      }
      log(`[Runner] Disconnected (code: ${code}${reasonStr ? `, reason: "${reasonStr}"` : ''})${diag}.`);

      // If connection was replaced by a newer instance or rejected by auth, exit immediately
      if (reasonStr.includes('Replaced by new connection') || code === 4001 || code === 4003) {
        log(`[Runner] 🛑 Exiting process because server rejected or replaced connection (${reasonStr || code}).`);
        if (ipcServer) {
          try { ipcServer.close(); } catch {}
        }
        process.exit(0);
      }

      scheduleReconnect();
    });

    ws.on('error', (err) => {
      log(`[Runner] WebSocket connection error: ${err.message}`);
    });
  } catch (err) {
    log(`[Runner] Failed to initialize WebSocket: ${err.message}`);
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (isExiting) return;
  if (reconnectTimer) return;
  reconnectAttempts++;
  const delay = Math.min(10000, 1500 + Math.min(reconnectAttempts * 1500, 8500));
  log(`[Runner] Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${reconnectAttempts})...`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

/**
 * Handle incoming RPC tasks from Cloud Agent
 */
async function handleTask(action, payload) {
  switch (action) {
    case 'run_command': {
      const { command, cwd } = payload;
      if (!command) return { success: false, error: 'No command provided.' };

      // Ensure common temp directory exists on Windows in case scripts write to C:\temp
      if (os.platform() === 'win32') {
        try {
          const sysDrive = process.env.SystemDrive || 'C:';
          const tempPath = path.join(sysDrive, 'temp');
          if (!fs.existsSync(tempPath)) {
            fs.mkdirSync(tempPath, { recursive: true });
          }
        } catch {}
      }

      // Destructive command safety guard (prevent accidental wipes or prompt injection attacks)
      const DANGEROUS_PATTERNS = [
        /\b(?:format)\s+[a-zA-Z]:/i,
        /\b(?:diskpart|mkfs|dd\s+if=)/i,
        /\b(?:rmdir|rd)\s+.*[\/\\](?:s|q).*[a-zA-Z]:[\\\/]?$/i,
        /\bdel\s+.*[\/\\](?:f|s|q).*[a-zA-Z]:[\\\/]?$/i,
        /\b(?:shutdown|init\s+0)\b/i,
      ];
      for (const pattern of DANGEROUS_PATTERNS) {
        if (pattern.test(command.trim())) {
          return {
            success: false,
            error: 'Execution blocked: Command matches restricted destructive pattern for system safety.',
          };
        }
      }

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
            timeout: parseInt(process.env.COMMAND_TIMEOUT_MS, 10) || 30000, // 30s timeout
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
        if (isRestrictedSystemPath(resolvedPath)) {
          return { success: false, error: 'Access denied: Target path resides inside a protected operating system directory.' };
        }

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
        if (isRestrictedSystemPath(resolvedPath)) {
          return { success: false, error: 'Access denied: Writing to protected operating system directories is blocked.' };
        }

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
        if (isRestrictedSystemPath(resolvedPath)) {
          return {
            success: false,
            error: 'Access denied: Deleting in protected operating system directories is blocked.',
          };
        }
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

    case 'spec':
    case 'specs':
    case 'status': {
      await refreshHardwareInfo(action === 'spec' || action === 'specs');
      const totalMemMb = Math.round(os.totalmem() / 1024 / 1024);
      const freeMemMb = Math.round(os.freemem() / 1024 / 1024);
      const cpus = os.cpus();
      const cpuModel = cpus && cpus.length > 0 ? cpus[0].model.trim() : 'Processor';
      const cpuSpeedGhz = cpus && cpus.length > 0 && cpus[0].speed ? (cpus[0].speed / 1000).toFixed(2) : '';
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
        cpuSpeedGhz: cpuSpeedGhz ? `${cpuSpeedGhz} GHz` : '',
        uptimeHours: (os.uptime() / 3600).toFixed(2),
        gpu: cachedHardwareExtra.gpu || '',
        battery: cachedHardwareExtra.battery || '',
        disks: cachedHardwareExtra.disks || [],
        memory: {
          totalMb: totalMemMb,
          freeMb: freeMemMb,
          usedMb: totalMemMb - freeMemMb,
          usedPercent: (((totalMemMb - freeMemMb) / totalMemMb) * 100).toFixed(1),
        },
      };
    }

    case 'disable_runner':
    case 'stop_runner': {
      console.log('[Runner] Remote disable/stop signal received from Telegram.');
      try {
        const appData = process.env.APPDATA;
        if (appData) {
          const startupVbs = path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'TelegramAILaptopRunner.vbs');
          if (fs.existsSync(startupVbs)) fs.unlinkSync(startupVbs);
        }
      } catch (err) {
        console.warn('[Runner] Could not remove startup vbs:', err.message);
      }

      try {
        exec('reg delete "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v TelegramAILaptopRunner /f', () => {});
      } catch {}

      setTimeout(() => {
        console.log('[Runner] Shutting down runner process gracefully.');
        process.exit(0);
      }, 500);

      return {
        success: true,
        message: 'Laptop runner disabled and stopped. Auto-start removed.',
      };
    }

    
    case 'take_screenshot':
    case 'screenshot':
    case 'capture_screenshot':
    case 'capture_screen': {
      const { windowTitle, quality } = payload;
      log(`[Runner] 📸 Capturing live screenshot (target: "${windowTitle || 'primary display'}")`);
      const args = [];
      if (windowTitle) args.push('--title', windowTitle);
      if (quality) args.push('--quality', String(quality || 80));

      const res = await runApprovalTool(args);
      if (res && res.success && res.image) {
        return {
          success: true,
          windowTitle: res.windowTitle || 'Primary Display',
          isDesktopFallback: Boolean(res.isDesktopFallback),
          bounds: res.bounds,
          image: res.image,
          timestamp: res.timestamp || Date.now(),
        };
      }

      // Fallback: try capture_app.py if request_approval.py fails
      try {
        const pythonCmd = process.env.PYTHON_BIN || 'python';
        const captureScript = path.resolve(process.cwd(), 'tools', 'capture_app.py');
        if (fs.existsSync(captureScript)) {
          await new Promise((resolve) => {
            execFile(pythonCmd, [captureScript, ...(windowTitle ? [windowTitle] : [])], { timeout: 15000 }, () => resolve());
          });
          const visionImg = path.resolve(process.cwd(), 'agent_vision.png');
          if (fs.existsSync(visionImg)) {
            const imgData = await fsp.readFile(visionImg);
            return {
              success: true,
              windowTitle: windowTitle || 'Primary Display',
              isDesktopFallback: true,
              image: imgData.toString('base64'),
              timestamp: Date.now(),
            };
          }
        }
      } catch (fallbackErr) {
        log(`[Runner] Capture fallback error: ${fallbackErr.message}`);
      }

      return { success: false, error: res?.error || 'Screenshot capture failed on laptop.' };
    }

    case 'request_approval':
    case 'capture_snapshot': {
      const { windowTitle, quality } = payload;
      log(`[Runner] 📸 Capturing snapshot for remote approval (target: "${windowTitle || 'auto'}")`);
      const args = [];
      if (windowTitle) args.push('--title', windowTitle);
      if (quality) args.push('--quality', String(quality));

      const res = await runApprovalTool(args);
      if (res && res.success && res.image) {
        const approvalId = payload.approvalId || `appr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'APPROVAL_REQUIRED',
            approvalId,
            windowTitle: res.windowTitle || 'Prompt Window',
            isDesktopFallback: Boolean(res.isDesktopFallback),
            bounds: res.bounds,
            image: res.image,
            timestamp: Date.now(),
          }));
        }
        return {
          success: true,
          approvalId,
          windowTitle: res.windowTitle,
          isDesktopFallback: res.isDesktopFallback,
          bounds: res.bounds,
          image: res.image,
          timestamp: res.timestamp,
        };
      }
      return { success: false, error: res?.error || 'Snapshot capture failed.' };
    }

    case 'approve_step': {
      const { approvalId, step, key, click, windowTitle, quality } = payload;
      const normStep = (step || '').toLowerCase().trim();
      log(`[Runner] 🕹️ Executing remote approve step: "${normStep}" (target: "${windowTitle || 'auto'}")`);

      const args = [];
      if (windowTitle) {
        args.push('--title', windowTitle);
      }
      if (quality) {
        args.push('--quality', String(quality));
      }

      if (normStep === 'refresh') {
        // Just capture a fresh snapshot without simulating input
      } else if (normStep === 'enter' || normStep === 'confirm') {
        args.push('--action', 'enter', '--refresh');
      } else if (normStep === 'space') {
        args.push('--action', 'space', '--refresh');
      } else if (normStep === 'cancel' || normStep === 'abort') {
        args.push('--action', 'cancel');
      } else if (normStep === 'click') {
        args.push('--action', 'click', '--x', String(click?.x || 0), '--y', String(click?.y || 0), '--refresh');
      } else if (normStep === 'key') {
        args.push('--action', 'key', '--key', key || 'enter', '--refresh');
      } else {
        return { success: false, error: `Unsupported approve step: "${step}"` };
      }

      const res = await runApprovalTool(args);
      if (!res || !res.success) {
        return { success: false, error: res?.error || 'Approve step execution failed.' };
      }

      const refreshed = res.refreshedSnapshot || (normStep === 'refresh' ? res : null);

      return {
        success: true,
        approvalId,
        step: normStep,
        executed: res.executed !== false,
        windowTitle: refreshed?.windowTitle || res.windowTitle || windowTitle || 'Prompt Window',
        isDesktopFallback: refreshed ? Boolean(refreshed.isDesktopFallback) : Boolean(res.isDesktopFallback),
        bounds: refreshed ? refreshed.bounds : res.bounds,
        image: refreshed ? refreshed.image : res.image,
        timestamp: Date.now(),
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
  if (ipcServer) {
    try {
      ipcServer.close();
    } catch {}
  }
  if (ws) {
    try {
      ws.close();
    } catch {}
  }
  process.exit(0);
});

// Start initial connection with single-instance check
async function startRunner() {
  const ipcOk = await startIpcServer();
  if (!ipcOk) {
    process.exit(0);
  }
  connect();
}

startRunner().catch((err) => {
  log(`[Runner] Fatal initialization error: ${err.message}`);
  process.exit(1);
});
