import { WebSocketServer, WebSocket } from 'ws';
import crypto from 'crypto';
import os from 'os';
import { InputFile } from 'grammy';

/**
 * Registry of connected laptops
 * Map<userId, Map<deviceId, { ws, deviceName, hostname, os, connectedAt, lastPing }>>
 */
const connectedLaptops = new Map();

/**
 * Pending requests waiting for laptop execution
 * Map<requestId, { resolve, reject, timer }>
 */
const pendingRequests = new Map();

/**
 * Cached specs per user for instant /spec responses even when briefly offline
 * Map<userId, specsObject>
 */
const lastKnownSpecs = new Map();

export function getLastKnownSpecs(userId) {
  return lastKnownSpecs.get(Number(userId)) || null;
}

let botApiRef = null;
let onStorageDirCallback = null;
let onApprovalRequiredCallback = null;

/**
 * Set callback for handling remote approval required events from runner
 */
export function setApprovalRequiredCallback(cb) {
  onApprovalRequiredCallback = cb;
}

/**
 * Set callback for registering storage directory received from runner
 */
export function setStorageDirCallback(cb) {
  onStorageDirCallback = cb;
}

/**
 * Set Telegram Bot API reference for device notifications
 */
export function setBotApi(botApi) {
  botApiRef = botApi;
}

/**
 * Get configured runner secret
 */
export function getExpectedSecret() {
  return (
    process.env.LAPTOP_RUNNER_SECRET ||
    (process.env.TELEGRAM_BOT_TOKEN ? process.env.TELEGRAM_BOT_TOKEN.slice(0, 20) : 'default_runner_secret')
  );
}

/**
 * Check if a user has any active connected laptops
 */
export function isLaptopConnected(userId) {
  const userDevices = connectedLaptops.get(Number(userId));
  if (!userDevices || userDevices.size === 0) return false;
  for (const device of userDevices.values()) {
    if (device.ws && device.ws.readyState === WebSocket.OPEN) {
      return true;
    }
  }
  return false;
}

/**
 * Get active device info for a user
 */
export function getConnectedLaptopsList(userId) {
  const userDevices = connectedLaptops.get(Number(userId));
  if (!userDevices) return [];
  const list = [];
  for (const [deviceId, dev] of userDevices.entries()) {
    list.push({
      deviceId,
      deviceName: dev.deviceName || dev.hostname || 'Laptop',
      hostname: dev.hostname,
      platform: dev.platform,
      username: dev.username || '',
      osVersion: dev.osVersion || '',
      isOnline: dev.ws && dev.ws.readyState === WebSocket.OPEN,
      connectedAt: dev.connectedAt,
    });
  }
  return list;
}

/**
 * Get all connected laptops across all authorized users
 * @param {Set<number>} allowedUserIds
 */
export function getAllConnectedLaptops(allowedUserIds) {
  const result = [];
  const uids = allowedUserIds && allowedUserIds.size > 0 ? Array.from(allowedUserIds) : Array.from(connectedLaptops.keys());
  for (const uid of uids) {
    const userDevices = connectedLaptops.get(Number(uid));
    const devicesList = [];
    if (userDevices) {
      for (const [deviceId, dev] of userDevices.entries()) {
        const isOnline = dev.ws && dev.ws.readyState === WebSocket.OPEN;
        devicesList.push({
          deviceId,
          deviceName: dev.deviceName || dev.hostname || 'Laptop',
          hostname: dev.hostname || 'unknown',
          platform: dev.platform || 'unknown',
          username: dev.username || '',
          osVersion: dev.osVersion || '',
          isOnline,
          connectedAt: dev.connectedAt,
        });
      }
    }
    result.push({
      userId: Number(uid),
      devices: devicesList,
      hasOnlineDevice: devicesList.some((d) => d.isOnline),
    });
  }
  return result;
}

/**
 * Send an RPC task to the user's active laptop and await response
 */
export function sendLaptopTask(userId, action, payload = {}, timeoutMs = 60000) {
  const userDevices = connectedLaptops.get(Number(userId));
  if (!userDevices || userDevices.size === 0) {
    throw new Error(
      `No active laptop connected for your account. Please start "npm run laptop" or double-click "start-agent.bat" on your laptop.`
    );
  }

  // Pick first online device (or default)
  let targetDevice = null;
  for (const dev of userDevices.values()) {
    if (dev.ws && dev.ws.readyState === WebSocket.OPEN) {
      targetDevice = dev;
      break;
    }
  }

  if (!targetDevice) {
    throw new Error(
      `Your laptop is currently disconnected or asleep. Please ensure "npm run laptop" is running on your machine.`
    );
  }

  const requestId = crypto.randomUUID();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error(`Laptop task "${action}" timed out after ${timeoutMs / 1000} seconds.`));
    }, timeoutMs);

    pendingRequests.set(requestId, { resolve, reject, timer });

    targetDevice.ws.send(
      JSON.stringify({
        id: requestId,
        action,
        ...payload,
      })
    );
  });
}

/**
 * Cross-platform check if a path is absolute (handles both Windows C:\ and POSIX /)
 */
export function isPathAbsolute(p) {
  if (!p || typeof p !== 'string') return false;
  if (/^[a-zA-Z]:[\\\/]/.test(p) || /^[\\\/]{2}/.test(p)) return true;
  if (p.startsWith('/')) return true;
  return false;
}

/**
 * Cross-platform join for remote laptop paths (handles Windows backslashes even when running on Linux host)
 */
export function joinLaptopPath(baseDir, relativePath) {
  if (!baseDir) return relativePath || '';
  if (!relativePath) return baseDir;
  if (isPathAbsolute(relativePath)) return relativePath;

  if (/^[a-zA-Z]:/.test(baseDir) || baseDir.includes('\\')) {
    const cleanBase = baseDir.replace(/[\\\/]+$/, '');
    const cleanRel = relativePath.replace(/^[\\\/]+/, '').replaceAll('/', '\\');
    return `${cleanBase}\\${cleanRel}`;
  }
  return path.join(baseDir, relativePath);
}

/**
 * Execute a terminal command (PowerShell / Bash) on the user's active laptop
 */
export async function runLaptopCommand(userId, command, cwd) {
  return await sendLaptopTask(userId, 'run_command', { command, cwd }, 90000);
}

/**
 * Read file contents from the user's active laptop
 */
export async function readLaptopFile(userId, filePath, maxLines = 200) {
  return await sendLaptopTask(userId, 'read_file', { filePath, maxLines }, 30000);
}

/**
 * Write/create file contents on the user's active laptop
 */
export async function writeLaptopFile(userId, filePath, content, encoding = 'utf8') {
  return await sendLaptopTask(userId, 'write_file', { filePath, content, encoding }, 45000);
}

/**
 * Delete a file on the user's active laptop
 */
export async function deleteLaptopFile(userId, filePath) {
  return await sendLaptopTask(userId, 'delete_file', { filePath }, 20000);
}

/**
 * Rename/move a file on the user's active laptop
 */
export async function renameLaptopFile(userId, oldPath, newPath) {
  return await sendLaptopTask(userId, 'rename_file', { oldPath, newPath }, 20000);
}

/**
 * List files and directories from the user's active laptop
 */
export async function listLaptopDirectory(userId, dirPath) {
  return await sendLaptopTask(userId, 'list_dir', { dirPath }, 30000);
}

/**
 * Stop and disable the user's active laptop runner
 */
export async function disableLaptopRunner(userId) {
  return await sendLaptopTask(userId, 'disable_runner', {}, 15000);
}

/**
 * Get system status (CPU, memory, uptime, battery) from the user's active laptop
 */
export async function getLaptopStatus(userId) {
  const userDevices = connectedLaptops.get(Number(userId));
  let activeDevice = null;
  if (userDevices) {
    for (const dev of userDevices.values()) {
      if (dev.ws && dev.ws.readyState === WebSocket.OPEN) {
        activeDevice = dev;
        break;
      }
    }
  }

  if (!activeDevice) {
    throw new Error('No active laptop connected for your account.');
  }

  // Fast live query with 3s timeout; fallback to cached specs immediately
  try {
    const live = await sendLaptopTask(userId, 'spec', {}, 3500);
    if (live && live.success) {
      activeDevice.lastStatus = live;
      lastKnownSpecs.set(Number(userId), live);
      return live;
    }
  } catch (err) {
    // Timeout or network blip: fall back gracefully to cached connection specs
    if (activeDevice.lastStatus) {
      lastKnownSpecs.set(Number(userId), activeDevice.lastStatus);
      return activeDevice.lastStatus;
    }
  }

  if (activeDevice.lastStatus) {
    lastKnownSpecs.set(Number(userId), activeDevice.lastStatus);
    return activeDevice.lastStatus;
  }

  // Fallback to active connection record
  return {
    success: true,
    deviceName: activeDevice.deviceName || 'Laptop',
    hostname: activeDevice.hostname || 'Local',
    platform: activeDevice.platform || 'win32',
    osVersion: activeDevice.osVersion || '',
    username: activeDevice.username || '',
    uptimeHours: 'Active',
    memory: {
      totalMb: 16384,
      freeMb: 8192,
      usedMb: 8192,
      usedPercent: '50.0'
    }
  };
}

/**
 * Attach the Laptop Agent WebSocket Server to the HTTP Server
 * @param {import('http').Server} server
 * @param {Set<number>} allowedUserIds
 */
/**
 * Remotely send an approve step (enter, space, cancel, click, refresh) to user's laptop
 */
export async function sendLaptopApproveStep(userId, payload = {}, timeoutMs = 30000) {
  return await sendLaptopTask(userId, 'approve_step', payload, timeoutMs);
}

/**
 * Request user approval snapshot from user's active laptop
 */
export async function requestLaptopApproval(userId, windowTitle, timeoutMs = 30000) {
  return await sendLaptopTask(userId, 'request_approval', { windowTitle }, timeoutMs);
}

/**
 * Capture a screenshot from user's active laptop and optionally deliver directly to Telegram
 */
export async function captureLaptopScreenshot(userId, options = {}, timeoutMs = 35000) {
  const { windowTitle, caption, quality = 80, sendDirect = true } = options;
  const res = await sendLaptopTask(userId, 'take_screenshot', { windowTitle, quality }, timeoutMs);
  if (!res || !res.success || !res.image) {
    return {
      success: false,
      error: res?.error || 'Failed to capture screenshot from laptop.',
    };
  }

  let photoSent = false;
  if (sendDirect && botApiRef) {
    try {
      const buffer = Buffer.from(res.image, 'base64');
      const safeTitle = (res.windowTitle || 'Desktop').replace(/[`*_\[\]()]/g, ' ');
      const photoCaption =
        caption ||
        `📸 *Laptop Screenshot*\n` +
        `• *Target:* \`${safeTitle}\`` +
        (res.isDesktopFallback ? ' _(Full Desktop Display)_' : '');

      await botApiRef.sendPhoto(userId, new InputFile(buffer, 'screenshot.jpg'), {
        caption: photoCaption.slice(0, 1024),
        parse_mode: 'Markdown',
      }).catch(async () => {
        // Fallback without parse_mode if title contains special characters
        await botApiRef.sendPhoto(userId, new InputFile(buffer, 'screenshot.jpg'), {
          caption: `📸 Laptop Screenshot: ${safeTitle}`.slice(0, 1024),
        }).catch((fallbackErr) => {
          console.error('[Laptop Bridge] Fallback sendPhoto failed:', fallbackErr);
        });
      });
      photoSent = true;
    } catch (sendErr) {
      console.error('[Laptop Bridge] Error sending screenshot photo to Telegram:', sendErr);
    }
  }

  return {
    success: true,
    photoSent,
    windowTitle: res.windowTitle || 'Desktop',
    isDesktopFallback: Boolean(res.isDesktopFallback),
    image: res.image,
  };
}

export function setupLaptopBridge(server, allowedUserIds) {
  // noServer mode for unified HTTP upgrade routing
  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (ws, req) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const secret = url.searchParams.get('secret') || '';
      const userIdParam = url.searchParams.get('userId') || '';
      const deviceName = url.searchParams.get('deviceName') || 'Laptop';
      const hostname = url.searchParams.get('hostname') || 'unknown-host';
      const platform = url.searchParams.get('platform') || 'unknown';

      const userId = parseInt(userIdParam, 10);
      const expectedSecret = getExpectedSecret();

      // 1. Verify Secret
      if (secret !== expectedSecret) {
        console.warn(`[Laptop Bridge] Unauthorized connection attempt: Invalid secret from ${req.socket.remoteAddress}`);
        ws.send(JSON.stringify({ type: 'error', message: 'Authentication failed: Invalid secret.' }));
        ws.close(4001, 'Invalid secret');
        return;
      }

      // 2. Verify Authorized Telegram User ID
      if (isNaN(userId) || !allowedUserIds.has(userId)) {
        console.warn(`[Laptop Bridge] Rejected unallowed User ID ${userIdParam} from ${req.socket.remoteAddress}`);
        ws.send(JSON.stringify({ type: 'error', message: 'Authentication failed: Unauthorized Telegram User ID.' }));
        ws.close(4003, 'Unauthorized User ID');
        return;
      }

      const username = url.searchParams.get('username') || '';
      const osVersion = url.searchParams.get('osVersion') || '';
      const storageDir = url.searchParams.get('storageDir') || '';

      if (storageDir && onStorageDirCallback) {
        try {
          onStorageDirCallback(userId, storageDir);
        } catch {}
      }

      const deviceId = `${hostname}_${platform}`;

      if (!connectedLaptops.has(userId)) {
        connectedLaptops.set(userId, new Map());
      }
      const userDevices = connectedLaptops.get(userId);

      // Clean up and close any stale or previous sockets for this user
      let previousStatus = null;
      for (const [prevId, prevDev] of userDevices.entries()) {
        if (prevDev.lastStatus) {
          previousStatus = prevDev.lastStatus;
        }
        try {
          if (prevDev.ws && prevDev.ws !== ws && prevDev.ws.readyState === WebSocket.OPEN) {
            console.log(`[Laptop Bridge] Closing prior connection for User ${userId}`);
            prevDev.ws.close(1000, 'Replaced by new connection');
          }
        } catch {}
      }
      userDevices.clear();

      const deviceRecord = {
        ws,
        deviceName,
        hostname,
        platform,
        username,
        osVersion,
        connectedAt: new Date().toISOString(),
        lastPing: Date.now(),
        lastStatus: previousStatus,
      };

      userDevices.set(deviceId, deviceRecord);
      console.log(`[Laptop Bridge] 💻 Device registered: "${deviceName}" (${hostname} / ${platform} / ${osVersion}) for User ${userId}`);

      ws.send(
        JSON.stringify({
          type: 'connected',
          message: `Connected to Cloud Agent Bridge successfully as "${deviceName}".`,
          userId,
        })
      );

      // Notify user via Telegram
      if (botApiRef) {
        const friendlyPlatform =
          platform === 'win32'
            ? 'Windows'
            : platform === 'darwin'
            ? 'macOS'
            : platform === 'linux'
            ? 'Linux'
            : platform;
        const osLabel = osVersion ? `${friendlyPlatform} (${osVersion})` : friendlyPlatform;
        const userLabel = username ? `\n• **Account:** \`${username}\`` : '';

        botApiRef
          .sendMessage(
            userId,
            `💻 *Laptop Connected: ${deviceName}*\n` +
            `• **Host:** \`${hostname}\` (${osLabel})${userLabel}\n` +
            `• **Status:** Active & listening for remote commands.\n\n` +
            `You can now ask the agent to run terminal commands, inspect files, or install packages while you are away!`,
            { parse_mode: 'Markdown' }
          )
          .catch(() => {});
      }

      // Keepalive ping timer (every 10s to keep reverse proxy tunnel alive)
      const pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.ping();
        } else {
          clearInterval(pingInterval);
        }
      }, 10000);

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());

          // Handle initial hardware specs broadcast from runner
          if (msg.type === 'APPROVAL_REQUIRED') {
            console.log(`[Laptop Bridge] 🚨 Remote approval required for User ${userId}: "${msg.windowTitle || 'Unknown'}"`);
            if (onApprovalRequiredCallback) {
              try {
                onApprovalRequiredCallback(userId, msg);
              } catch (cbErr) {
                console.error('[Laptop Bridge] Error in onApprovalRequiredCallback:', cbErr);
              }
            }
            return;
          }

          if (msg.type === 'initial_status') {
            deviceRecord.lastStatus = msg;
            lastKnownSpecs.set(Number(userId), msg);
            console.log(`[Laptop Bridge] 📊 Cached live system specs from "${deviceName}"`);
            if (msg.storageDir && onStorageDirCallback) {
              try {
                onStorageDirCallback(userId, msg.storageDir);
              } catch {}
            }
            return;
          }

          // Handle response to pending task
          if (msg.id && pendingRequests.has(msg.id)) {
            const { resolve, reject, timer } = pendingRequests.get(msg.id);
            clearTimeout(timer);
            pendingRequests.delete(msg.id);

            if (msg.error) {
              resolve({ success: false, error: msg.error });
            } else {
              resolve(msg);
            }
          }
        } catch (parseErr) {
          console.warn('[Laptop Bridge] Error parsing message from laptop:', parseErr.message);
        }
      });

      ws.on('close', () => {
        clearInterval(pingInterval);
        const currentDev = userDevices.get(deviceId);
        if (currentDev && currentDev.ws === ws) {
          userDevices.delete(deviceId);
          console.log(`[Laptop Bridge] 💻 Device disconnected: "${deviceName}" for User ${userId}`);
        } else {
          console.log(`[Laptop Bridge] 🔄 Stale socket closed for "${deviceName}" (newer socket active).`);
        }
      });

      ws.on('error', (err) => {
        console.warn(`[Laptop Bridge] Socket error for "${deviceName}":`, err.message);
      });
    } catch (err) {
      console.error('[Laptop Bridge] Connection setup error:', err);
      try {
        ws.close();
      } catch {}
    }
  });

  console.log('[Laptop Bridge] WebSocket tunnel endpoint mounted at /ws/laptop-agent');
  return wss;
}
