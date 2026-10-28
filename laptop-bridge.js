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
 * Track last connection notification per device to prevent notification spam on quick reconnects
 * Map<notifyKey, { time: number, deviceName: string }>
 */
const lastUserConnectNotification = new Map();

/**
 * Preferred target device per user (e.g. 'auto' | 'phone' | 'laptop' | 'tablet' | deviceId)
 * Map<userId, string>
 */
const userPreferredDevice = new Map(); // userId -> 'auto' | 'laptop' | 'phone' | 'tablet' | deviceId

export function setUserPreferredDevice(userId, target) {
  userPreferredDevice.set(Number(userId), (target || 'auto').toLowerCase().trim());
}

export function getUserPreferredDevice(userId) {
  return userPreferredDevice.get(Number(userId)) || 'auto';
}

export const setPreferredDevice = setUserPreferredDevice;
export const getPreferredDevice = getUserPreferredDevice;

/**
 * Check if a device matches a target/filter string
 * @param {object} dev
 * @param {string} filterStr
 * @returns {boolean}
 */
export function matchFilter(dev, filterStr) {
  if (!dev || !filterStr || typeof filterStr !== 'string') return false;
  const norm = filterStr.toLowerCase().trim();
  if (norm === 'auto') return false;
  return Boolean(
    (dev.deviceType && dev.deviceType.toLowerCase() === norm) ||
    (dev.deviceName && dev.deviceName.toLowerCase().includes(norm)) ||
    (dev.hostname && dev.hostname.toLowerCase().includes(norm)) ||
    (dev.deviceId && dev.deviceId.toLowerCase().includes(norm))
  );
}

/**
 * Single unified helper to select an online device for a user
 * @param {number|string} userId
 * @param {string|null} [targetDevice]
 * @param {string|null} [action]
 * @returns {object|null}
 */
export function selectOnlineDevice(userId, targetDevice = null, action = null) {
  const userDevices = connectedLaptops.get(Number(userId));
  if (!userDevices || userDevices.size === 0) return null;

  const onlineDevices = [];
  for (const dev of userDevices.values()) {
    if (dev.ws && dev.ws.readyState === WebSocket.OPEN) {
      onlineDevices.push(dev);
    }
  }

  if (onlineDevices.length === 0) return null;

  // b. If onlineDevices.length === 1, ALWAYS return onlineDevices[0]
  if (onlineDevices.length === 1) {
    return onlineDevices[0];
  }

  // d. Priority 1: If targetDevice is explicitly passed, find a match using matchFilter
  if (targetDevice && typeof targetDevice === 'string') {
    const matched = onlineDevices.find((d) => matchFilter(d, targetDevice));
    if (matched) return matched;
  }

  // e. Priority 2: Check getUserPreferredDevice(userId). If pref !== 'auto', find a match
  const pref = getUserPreferredDevice(userId);
  if (pref && pref !== 'auto') {
    const matchedPref = onlineDevices.find((d) => matchFilter(d, pref));
    if (matchedPref) return matchedPref;
  }

  // f. Priority 3 (Auto mode when 2+ devices are online): For desktop GUI actions, prefer win32 or laptop
  const isDesktopAction = action && ['list_windows', 'take_screenshot', 'request_approval', 'approve_step'].includes(action);
  if (isDesktopAction) {
    const desktopDev = onlineDevices.find((d) => d.platform === 'win32' || d.deviceType === 'laptop');
    if (desktopDev) return desktopDev;
  }

  return onlineDevices.find((d) => d.deviceType === 'laptop') || onlineDevices[0];
}



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

export function getBotApi() {
  return botApiRef;
}

let cloudVaultBridge = {
  saveCloudVaultEntry: null,
  getCloudVault: () => [],
  loadCloudDocumentContent: null,
};

/**
 * Register Cloud Vault handlers from bot.js
 */
export function setCloudVaultBridge(handlers = {}) {
  cloudVaultBridge = { ...cloudVaultBridge, ...handlers };
}

export async function saveCloudVaultEntry(entry) {
  if (typeof cloudVaultBridge.saveCloudVaultEntry === 'function') {
    return await cloudVaultBridge.saveCloudVaultEntry(entry);
  }
}

export function getCloudVault() {
  if (typeof cloudVaultBridge.getCloudVault === 'function') {
    return cloudVaultBridge.getCloudVault();
  }
  return [];
}

export async function loadCloudDocumentContent(fileId, fileExtension, fileName = '') {
  if (typeof cloudVaultBridge.loadCloudDocumentContent === 'function') {
    return await cloudVaultBridge.loadCloudDocumentContent(fileId, fileExtension, fileName);
  }
  throw new Error('Cloud vault document loader not configured');
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
 * Check if a user has any active connected laptops or devices
 */
export function isLaptopConnected(userId, targetDevice = null) {
  const userDevices = connectedLaptops.get(Number(userId));
  if (!userDevices || userDevices.size === 0) return false;

  const onlineDevices = [];
  for (const device of userDevices.values()) {
    if (device.ws && device.ws.readyState === WebSocket.OPEN) {
      onlineDevices.push(device);
    }
  }

  if (onlineDevices.length === 0) return false;
  if (!targetDevice || onlineDevices.length === 1) return true;

  const targetNorm = String(targetDevice).toLowerCase().trim();
  return onlineDevices.some((device) =>
    (device.deviceType && device.deviceType.toLowerCase() === targetNorm) ||
    (device.deviceName && device.deviceName.toLowerCase().includes(targetNorm)) ||
    (device.hostname && device.hostname.toLowerCase().includes(targetNorm)) ||
    (device.deviceId && device.deviceId.toLowerCase().includes(targetNorm))
  );
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
      deviceName: dev.deviceName || dev.hostname || 'Device',
      deviceType: dev.deviceType || (dev.platform === 'android' ? 'phone' : 'laptop'),
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
          deviceName: dev.deviceName || dev.hostname || 'Device',
          deviceType: dev.deviceType || (dev.platform === 'android' ? 'phone' : 'laptop'),
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
 * Helper to get the platform and storage directory of the user's active/connected device.
 * @param {number|string} userId
 * @param {string} [targetDevice] Optional target device filter ('laptop', 'phone', 'tablet', etc.)
 * @returns {{ platform: string, storageDir: string, deviceName: string, deviceType: string, deviceId: string } | null}
 */
export function getActiveDevicePlatform(userId, targetDevice = null) {
  const selected = selectOnlineDevice(userId, targetDevice);
  if (!selected) return null;

  const rawPlatform = selected.platform || (selected.deviceType === 'phone' ? 'android' : 'win32');
  const platform = rawPlatform.toLowerCase().trim();
  const defaultDir = platform === 'android' ? '/sdcard/Download' : '';
  const storageDir = selected.storageDir || defaultDir;

  return {
    platform,
    storageDir,
    deviceName: selected.deviceName,
    deviceType: selected.deviceType || (platform === 'android' ? 'phone' : 'laptop'),
    deviceId: selected.deviceId,
  };
}

/**
 * Send an RPC task to the user's active device and await response
 * @param {number} userId
 * @param {string} action
 * @param {object} payload
 * @param {number} timeoutMs
 * @param {function} onProgress
 * @param {string} [targetDevice] Optional target: 'laptop' | 'phone' | 'tablet' | hostname | deviceName
 */
export function sendLaptopTask(userId, action, payload = {}, timeoutMs = 60000, onProgress = null, targetDevice = null) {
  const selectedDevice = selectOnlineDevice(userId, targetDevice, action);
  if (!selectedDevice) {
    const userDevices = connectedLaptops.get(Number(userId));
    if (!userDevices || userDevices.size === 0) {
      throw new Error(
        `No active device (laptop, phone, or tablet) connected for your account. Please start the agent runner on your device.`
      );
    }
    throw new Error(
      `Your device is currently disconnected or asleep. Please ensure the agent runner is running on your machine or phone.`
    );
  }

  const requestId = crypto.randomUUID();

  return new Promise((resolve, reject) => {
    let timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error(`Device task "${action}" timed out after ${timeoutMs / 1000} seconds on ${selectedDevice.deviceName}.`));
    }, timeoutMs);

    pendingRequests.set(requestId, {
      resolve,
      reject,
      timer,
      timeoutMs,
      action,
      onProgress,
      device: selectedDevice,
    });

    selectedDevice.ws.send(
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

  // POSIX / Android paths (e.g. /sdcard/Download or /data/data/...)
  if (baseDir.startsWith('/')) {
    const cleanBase = baseDir.replace(/\/+$/, '');
    const cleanRel = relativePath.replace(/^[\\\/]+/, '').replaceAll('\\', '/');
    return `${cleanBase}/${cleanRel}`;
  }

  return path.join(baseDir, relativePath);

}



/**
 * Execute a terminal command (PowerShell / Bash / Termux) on the user's active device
 */
export async function runLaptopCommand(userId, command, cwd, onProgress = null, targetDevice = null) {
  return await sendLaptopTask(userId, 'run_command', { command, cwd }, 180000, onProgress, targetDevice);
}

/**
 * Read file contents from the user's active device
 */
export async function readLaptopFile(userId, filePath, maxLines = 200, targetDevice = null) {
  return await sendLaptopTask(userId, 'read_file', { filePath, maxLines }, 30000, null, targetDevice);
}

/**
 * Write/create file contents on the user's active device
 */
export async function writeLaptopFile(userId, filePath, content, encoding = 'utf8', targetDevice = null) {
  return await sendLaptopTask(userId, 'write_file', { filePath, content, encoding }, 45000, null, targetDevice);
}

/**
 * Delete a file on the user's active device
 */
export async function deleteLaptopFile(userId, filePath, targetDevice = null) {
  return await sendLaptopTask(userId, 'delete_file', { filePath }, 20000, null, targetDevice);
}

/**
 * Rename/move a file on the user's active device
 */
export async function renameLaptopFile(userId, oldPath, newPath, targetDevice = null) {
  return await sendLaptopTask(userId, 'rename_file', { oldPath, newPath }, 20000, null, targetDevice);
}

/**
 * List files and directories from the user's active device
 */
export async function listLaptopDirectory(userId, dirPath, targetDevice = null) {
  return await sendLaptopTask(userId, 'list_dir', { dirPath }, 30000, null, targetDevice);
}

/**
 * Stop and disable the user's active device runner
 */
export async function disableLaptopRunner(userId, targetDevice = null) {
  return await sendLaptopTask(userId, 'disable_runner', {}, 15000, null, targetDevice);
}

/**
 * Get system status (CPU, memory, uptime, battery) from the user's active device
 */
export async function getLaptopStatus(userId, targetDevice = null) {
  const activeDevice = selectOnlineDevice(userId, targetDevice, 'status');
  if (!activeDevice) {
    throw new Error('No active device connected for your account.');
  }

  // Fast live query with 3.5s timeout; fallback to cached specs immediately
  try {
    const live = await sendLaptopTask(userId, 'spec', {}, 3500, null, targetDevice || activeDevice.deviceType);
    if (live && live.success) {
      activeDevice.lastStatus = live;
      lastKnownSpecs.set(Number(userId), live);
      return live;
    }
  } catch (err) {
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
    deviceName: activeDevice.deviceName || 'Device',
    deviceType: activeDevice.deviceType || 'laptop',
    hostname: activeDevice.hostname || 'Local',
    platform: activeDevice.platform || 'linux',
    osVersion: activeDevice.osVersion || '',
    username: activeDevice.username || '',
    uptimeHours: 'Active',
    memory: {
      totalMb: 8192,
      freeMb: 4096,
      usedMb: 4096,
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

/**
 * Enumerate open applications and browser windows on user's active laptop
 */
export async function listLaptopWindows(userId, timeoutMs = 15000) {
  return await sendLaptopTask(userId, 'list_windows', {}, timeoutMs);
}

/**
 * Capture a screenshot from user's active laptop and optionally deliver directly to Telegram
 */
export async function captureLaptopScreenshot(userId, options = {}, timeoutMs = 35000) {

  const { windowTitle, hwnd, caption, quality = 70, sendDirect = true, targetDevice = null } = options;
  const bridgeT0 = performance.now();

  const res = await sendLaptopTask(userId, 'take_screenshot', { windowTitle, hwnd, quality }, timeoutMs, null, targetDevice);

  if (!res || !res.success || !res.image) {

    return {

      success: false,

      error: res?.error || 'Failed to capture screenshot from laptop.',

    };

  }

  const captureDuration = Math.round(performance.now() - bridgeT0);
  console.log(`[PROFILER] Step: Laptop bridge screenshot RPC took ${captureDuration} ms`);

  let photoSent = false;
  const buffer = Buffer.from(res.image, 'base64');

  if (sendDirect && botApiRef) {

    const uploadT0 = performance.now();
    try {

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
      const uploadDuration = Math.round(performance.now() - uploadT0);
      console.log(`[PROFILER] Step: Telegram photo upload took ${uploadDuration} ms`);

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
    buffer,
    base64: res.image,

  };

}



export function setupLaptopBridge(server, allowedUserIds) {

  // noServer mode for unified HTTP upgrade routing

  const wss = new WebSocketServer({ noServer: true });



  wss.on('connection', (ws, req) => {

    try {

      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

      const secret = url.searchParams.get('secret') || '';
      const userIdParam = url.searchParams.get('userId') || url.searchParams.get('user') || '';

      const expectedSecret = getExpectedSecret();
      if (expectedSecret && secret !== expectedSecret) {
        ws.send(JSON.stringify({ type: 'error', message: 'Authentication failed: Invalid secret.' }));
        ws.close(4001, 'Invalid secret');
        return;
      }
      const userId = parseInt(userIdParam, 10);
      if (!userId || isNaN(userId) || (allowedUserIds && allowedUserIds.size > 0 && !allowedUserIds.has(userId))) {
        ws.send(JSON.stringify({ type: 'error', message: 'Authentication failed: Unauthorized Telegram User ID.' }));
        ws.close(4003, 'Unauthorized Telegram User ID');
        return;
      }

      const deviceName = url.searchParams.get('deviceName') || 'Laptop';

      const hostname = url.searchParams.get('hostname') || 'unknown-host';

      const rawPlatform = (url.searchParams.get('platform') || '').toLowerCase().trim();
      const platform = rawPlatform || 'unknown';
      const deviceTypeParam = (url.searchParams.get('deviceType') || '').toLowerCase().trim();
      const isAndroid = platform === 'android';
      const deviceType = ['laptop', 'phone', 'tablet'].includes(deviceTypeParam)
        ? deviceTypeParam
        : (isAndroid ? 'phone' : 'laptop');

      const username = url.searchParams.get('username') || '';
      const osVersion = url.searchParams.get('osVersion') || '';
      const storageDir = url.searchParams.get('storageDir') || '';

      const customDeviceId = url.searchParams.get('deviceId');
      const deviceId = customDeviceId || `${deviceName}_${hostname}_${username || 'user'}_${platform}`;

      if (storageDir && onStorageDirCallback) {
        try {
          onStorageDirCallback(userId, storageDir, deviceType);
        } catch {}
      }

      if (!connectedLaptops.has(userId)) {
        connectedLaptops.set(userId, new Map());
      }
      const userDevices = connectedLaptops.get(userId);

      // Clean up and close ONLY a prior socket with the exact same deviceId (keep other devices alive!)
      let previousStatus = null;
      const prevDev = userDevices.get(deviceId);
      if (prevDev) {
        if (prevDev.lastStatus) {
          previousStatus = prevDev.lastStatus;
        }
        try {
          if (prevDev.ws && prevDev.ws !== ws && prevDev.ws.readyState === WebSocket.OPEN) {
            console.log(`[Laptop Bridge] Closing prior connection for device "${deviceId}" (User ${userId})`);
            prevDev.ws.close(1000, 'Replaced by new connection');
          }
        } catch {}
      }

      const deviceRecord = {
        ws,
        deviceId,
        deviceName,
        deviceType,
        hostname,
        platform,
        username,
        osVersion,
        storageDir: storageDir || (platform === 'android' ? '/sdcard/Download' : ''),
        connectedAt: new Date().toISOString(),
        lastPing: Date.now(),
        lastStatus: previousStatus,
      };

      userDevices.set(deviceId, deviceRecord);
      console.log(`[Laptop Bridge] 💻 Device registered: "${deviceName}" [${deviceType.toUpperCase()}] (${hostname} / ${platform} / ${osVersion}) for User ${userId}`);

      ws.send(
        JSON.stringify({
          type: 'connected',
          message: `Connected to Cloud Agent Bridge successfully as "${deviceName}".`,
          userId,
          deviceType,
          deviceId,
        })
      );

      // Notify user via Telegram (rate-limited per device so reconnect blips don't spam messages)
      const now = Date.now();
      const notifyKey = `${userId}_${deviceId}`;
      const lastNotified = lastUserConnectNotification.get(notifyKey);
      const isRecent = lastNotified && (now - lastNotified.time < 60000);

      if (botApiRef && !isRecent) {
        lastUserConnectNotification.set(notifyKey, { time: now, deviceName });
        const friendlyPlatform =
          platform === 'win32'
            ? 'Windows'
            : platform === 'darwin'
            ? 'macOS'
            : platform === 'linux'
            ? 'Linux'
            : platform === 'android'
            ? 'Android'
            : platform;
        const osLabel = osVersion ? `${friendlyPlatform} (${osVersion})` : friendlyPlatform;
        const userLabel = username ? `\n• **Account:** \`${username}\`` : '';
        const icon = deviceType === 'phone' ? '📱' : deviceType === 'tablet' ? '📟' : '💻';
        const typeLabel = deviceType === 'phone' ? 'Phone' : deviceType === 'tablet' ? 'Tablet' : 'Laptop';

        botApiRef
          .sendMessage(
            userId,
            `${icon} *${typeLabel} Connected: ${deviceName}*\n` +
            `• **Host:** \`${hostname}\` (${osLabel})${userLabel}\n` +
            `• **Type:** \`${deviceType}\`\n` +
            `• **Status:** Active & listening for remote commands.\n\n` +
            `You can now ask the agent to run terminal commands, inspect files, or install packages while you are away!`,
            { parse_mode: 'Markdown' }
          )
          .catch(() => {});
      } else if (isRecent) {
        console.log(`[Laptop Bridge] ℹ️ Suppressed redundant Telegram connect notification for User ${userId}, device "${deviceName}" [${deviceId}] (reconnected within cooldown).`);
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
            if (msg.storageDir) {
              deviceRecord.storageDir = msg.storageDir;
            }
            lastKnownSpecs.set(Number(userId), msg);
            console.log(`[Laptop Bridge] 📊 Cached live system specs from "${deviceName}" [${deviceType.toUpperCase()}]`);
            if (msg.storageDir && onStorageDirCallback) {
              try {
                onStorageDirCallback(userId, msg.storageDir, deviceType);
              } catch {}
            }
            return;
          }



          // Handle streaming command progress
          if (msg.type === 'COMMAND_PROGRESS' && msg.id && pendingRequests.has(msg.id)) {
            const pending = pendingRequests.get(msg.id);
            // Reset / extend timeout timer so active running commands don't time out while streaming progress
            if (pending.timer) {
              clearTimeout(pending.timer);
            }
            pending.timer = setTimeout(() => {
              pendingRequests.delete(msg.id);
              pending.reject(
                new Error(
                  `Laptop task "${pending.action || 'command'}" timed out after ${
                    (pending.timeoutMs || 180000) / 1000
                  } seconds of inactivity.`
                )
              );
            }, pending.timeoutMs || 180000);

            if (msg.output && typeof pending.onProgress === 'function') {
              try {
                pending.onProgress(msg.output);
              } catch (progErr) {
                console.warn('[Laptop Bridge] onProgress callback error:', progErr.message);
              }
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

          console.log(`[Laptop Bridge] 💻 Device disconnected: "${deviceName}" [${deviceType.toUpperCase()}] for User ${userId}`);

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

