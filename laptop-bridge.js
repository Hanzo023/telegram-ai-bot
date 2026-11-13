import { WebSocketServer, WebSocket } from 'ws';
import crypto from 'crypto';
import os from 'os';
import path from 'path';
import { InputFile } from 'grammy';

/**
 * Multi-device Session Registry:
 * Map<userId, {
 *   phone?: object,
 *   laptop?: object,
 * }>
 */
const deviceSessions = new Map();

/**
 * Command Queues per device type:
 * Map<userId, {
 *   phone: Array<object>,
 *   laptop: Array<object>,
 * }>
 */
const deviceCommandQueues = new Map();

/**
 * Default active device per user ('phone' | 'laptop'):
 * Defaults to the most recently connected device.
 */
const defaultDevice = new Map();

/**
 * Registry of connected laptops (kept for backward-compatibility)
 * Map<userId, Map<deviceId, { ws, deviceName, hostname, os, connectedAt, lastPing, lastSeen }>>
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

export function setDefaultDevice(userId, target) {
  const norm = (target || '').toLowerCase().trim();
  if (norm === 'phone' || norm === 'laptop') {
    defaultDevice.set(Number(userId), norm);
    userPreferredDevice.set(Number(userId), norm);
  } else if (norm === 'auto') {
    userPreferredDevice.set(Number(userId), 'auto');
  }
}

export function getDefaultDevice(userId) {
  const uid = Number(userId);
  const explicitPref = userPreferredDevice.get(uid);
  if (explicitPref && explicitPref !== 'auto' && (explicitPref === 'phone' || explicitPref === 'laptop')) {
    return explicitPref;
  }
  return defaultDevice.get(uid) || 'laptop';
}

export function getDeviceSessions(userId) {
  const uid = Number(userId);
  let userSess = deviceSessions.get(uid);
  if (!userSess) {
    userSess = { phone: null, laptop: null };
    deviceSessions.set(uid, userSess);
  }
  return userSess;
}

export function getDeviceCommandQueue(userId, deviceType) {
  const uid = Number(userId);
  let userQueues = deviceCommandQueues.get(uid);
  if (!userQueues) {
    userQueues = { phone: [], laptop: [] };
    deviceCommandQueues.set(uid, userQueues);
  }
  const typeKey = (deviceType || '').toLowerCase().trim() === 'phone' ? 'phone' : 'laptop';
  if (!userQueues[typeKey]) {
    userQueues[typeKey] = [];
  }
  return userQueues[typeKey];
}

/**
 * A device is marked ONLINE if its WebSocket is OPEN or its heartbeat (lastSeen) is within 45s.
 * @param {object} deviceRecord
 * @returns {boolean}
 */
export function isDeviceOnline(deviceRecord) {
  if (!deviceRecord) return false;
  if (deviceRecord.ws && deviceRecord.ws.readyState === WebSocket.OPEN) {
    return true;
  }
  if (deviceRecord.lastSeen && (Date.now() - deviceRecord.lastSeen < 45000)) {
    return true;
  }
  return false;
}

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
 * Single unified helper to select an online device for a user.
 * Routing logic:
 * a) If the user specifies a device (e.g., "phone", "laptop"), pass that target_device.
 * b) If only ONE device is currently ONLINE, automatically route to that online device regardless of what was guessed.
 * c) If BOTH phone and laptop are ONLINE and no device was specified, route to defaultDevice[userId].
 *
 * @param {number|string} userId
 * @param {string|null} [targetDevice]
 * @param {string|null} [action]
 * @returns {object|null}
 */
export function selectOnlineDevice(userId, targetDevice = null, action = null) {
  const uid = Number(userId);
  const userSess = getDeviceSessions(uid);

  const phoneDev = userSess.phone && isDeviceOnline(userSess.phone) ? userSess.phone : null;
  const laptopDev = userSess.laptop && isDeviceOnline(userSess.laptop) ? userSess.laptop : null;

  const onlineDevices = [];
  if (phoneDev) onlineDevices.push(phoneDev);
  if (laptopDev) onlineDevices.push(laptopDev);

  // Also include any other device from connectedLaptops Map if online
  const userDevices = connectedLaptops.get(uid);
  if (userDevices) {
    for (const dev of userDevices.values()) {
      if (isDeviceOnline(dev) && !onlineDevices.some((d) => d.deviceId === dev.deviceId)) {
        onlineDevices.push(dev);
      }
    }
  }

  if (onlineDevices.length === 0) return null;

  // Rule b: If only ONE device is currently ONLINE, automatically route to that online device
  if (onlineDevices.length === 1) {
    return onlineDevices[0];
  }

  // Rule a: If target_device was explicitly specified ("phone" or "laptop"), match that device
  if (targetDevice && typeof targetDevice === 'string') {
    const norm = targetDevice.toLowerCase().trim();
    if (norm === 'phone' && phoneDev) return phoneDev;
    if (norm === 'laptop' && laptopDev) return laptopDev;
    const matched = onlineDevices.find((d) => matchFilter(d, norm));
    if (matched) return matched;
  }

  // Check user preferred device if explicitly configured
  const pref = getUserPreferredDevice(uid);
  if (pref && pref !== 'auto') {
    const matchedPref = onlineDevices.find((d) => matchFilter(d, pref));
    if (matchedPref) return matchedPref;
  }

  // For desktop-specific GUI tasks, prefer laptop if online
  const isDesktopAction = action && ['list_windows', 'take_screenshot', 'request_approval', 'approve_step'].includes(action);
  if (isDesktopAction && laptopDev) {
    return laptopDev;
  }

  // Rule c: If BOTH phone and laptop are ONLINE and no target was specified, route to defaultDevice[userId]
  const def = getDefaultDevice(uid);
  if (def === 'phone' && phoneDev) return phoneDev;
  if (def === 'laptop' && laptopDev) return laptopDev;

  return onlineDevices[0];
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
  const selected = selectOnlineDevice(userId, targetDevice);
  return Boolean(selected);
}

/**
 * Get active device info list for a user
 */
export function getConnectedLaptopsList(userId) {
  const uid = Number(userId);
  const userSess = getDeviceSessions(uid);
  const list = [];
  for (const type of ['phone', 'laptop']) {
    const dev = userSess[type];
    if (dev) {
      list.push({
        deviceId: dev.deviceId || `${type}_${uid}`,
        deviceName: dev.deviceName || (type === 'phone' ? 'Android Phone' : 'Laptop'),
        deviceType: type,
        hostname: dev.hostname || (type === 'phone' ? 'Android-Device' : 'Laptop-Host'),
        platform: dev.platform || (type === 'phone' ? 'android' : 'win32'),
        username: dev.username || '',
        osVersion: dev.osVersion || '',
        isOnline: isDeviceOnline(dev),
        lastSeen: dev.lastSeen,
        connectedAt: dev.connectedAt,
        storageDir: dev.storageDir || (type === 'phone' ? '/sdcard/Download' : ''),
      });
    }
  }

  // Also include any connectedLaptops Map records if not already represented
  const userDevices = connectedLaptops.get(uid);
  if (userDevices) {
    for (const [deviceId, dev] of userDevices.entries()) {
      if (!list.some((d) => d.deviceId === deviceId || d.deviceType === dev.deviceType)) {
        list.push({
          deviceId,
          deviceName: dev.deviceName || dev.hostname || 'Device',
          deviceType: dev.deviceType || (dev.platform === 'android' ? 'phone' : 'laptop'),
          hostname: dev.hostname || 'unknown',
          platform: dev.platform || 'unknown',
          username: dev.username || '',
          osVersion: dev.osVersion || '',
          isOnline: isDeviceOnline(dev),
          lastSeen: dev.lastSeen || dev.lastPing,
          connectedAt: dev.connectedAt,
          storageDir: dev.storageDir || '',
        });
      }
    }
  }

  return list;
}

/**
 * Get all connected laptops across all authorized users
 * @param {Set<number>} allowedUserIds
 */
export function getAllConnectedLaptops(allowedUserIds) {
  const result = [];
  const uids = allowedUserIds && allowedUserIds.size > 0 ? Array.from(allowedUserIds) : Array.from(deviceSessions.keys());

  for (const uid of uids) {
    const devicesList = getConnectedLaptopsList(uid);
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
    const userSess = getDeviceSessions(Number(userId));
    if (!userSess.phone && !userSess.laptop) {
      throw new Error(
        `No active device (laptop or phone) connected for your account. Please run setup on your device.`
      );
    }
    throw new Error(
      `Your device is currently OFFLINE. Please ensure the agent runner is active on your device.`
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

    if (selectedDevice.ws && selectedDevice.ws.readyState === WebSocket.OPEN) {
      selectedDevice.ws.send(
        JSON.stringify({
          id: requestId,
          command_id: requestId,
          action,
          ...payload,
        })
      );
    } else {
      // Enqueue to dedicated per-device-type queue
      const q = getDeviceCommandQueue(userId, selectedDevice.deviceType);
      q.push({
        id: requestId,
        command_id: requestId,
        action,
        ...payload,
      });
      console.log(`[Laptop Bridge] Enqueued task "${action}" (ID: ${requestId}) to queue[${userId}][${selectedDevice.deviceType}]`);
    }
  });
}

/**
 * Handle command result POSTed back from runner or bash client
 * @param {string} commandId
 * @param {object} result
 * @returns {boolean}
 */
export function handleDeviceResult(commandId, result = {}) {
  if (!commandId) return false;
  const pending = pendingRequests.get(commandId);
  if (!pending) return false;

  clearTimeout(pending.timer);
  pendingRequests.delete(commandId);

  if (result.error && !result.success) {
    pending.resolve({ success: false, error: result.error, stderr: result.stderr || '' });
  } else {
    pending.resolve({
      success: result.success !== false,
      stdout: result.stdout || result.output || '',
      stderr: result.stderr || '',
      exitCode: result.exitCode ?? (result.success === false ? 1 : 0),
      ...result,
    });
  }
  return true;
}

/**
 * Send notification to Telegram when device connects (transitions from OFFLINE to ONLINE)
 */
export function sendDeviceConnectedNotification(userId, deviceRecord) {
  if (!botApiRef) return;
  const { deviceName, deviceType, hostname, platform, osVersion, username } = deviceRecord;
  const friendlyPlatform =
    platform === 'win32'
      ? 'Windows'
      : platform === 'darwin'
      ? 'macOS'
      : platform === 'linux'
      ? 'Linux'
      : platform === 'android'
      ? 'Android'
      : (platform || 'unknown');
  const osLabel = osVersion ? `${friendlyPlatform} (${osVersion})` : friendlyPlatform;
  const userLabel = username ? `\n• **Account:** \`${username}\`` : '';
  const icon = deviceType === 'phone' ? '📱' : '💻';
  const typeLabel = deviceType === 'phone' ? 'Phone' : 'Laptop';

  botApiRef
    .sendMessage(
      userId,
      `${icon} *${typeLabel} Connected: ${deviceName || hostname}*\n` +
      `• **Host:** \`${hostname}\` (${osLabel})${userLabel}\n` +
      `• **Type:** \`${deviceType}\`\n` +
      `• **Status:** Active & listening for remote commands.\n\n` +
      `You can now ask the agent to run terminal commands, open apps/websites, inspect files, or upload files while away!`,
      { parse_mode: 'Markdown' }
    )
    .catch((err) => {
      console.warn('[Laptop Bridge] Could not send connect notification:', err.message);
    });
}

/**
 * Register or update device session (for both WebSocket and HTTP polling)
 * Heartbeat (lastSeen) is updated on every call.
 * Connection notification is sent ONLY when transitioning from OFFLINE to ONLINE.
 */
export function registerOrUpdateDeviceSession(userId, data = {}) {
  const uid = Number(userId);
  const userSess = getDeviceSessions(uid);
  const rawType = (data.device_type || data.deviceType || '').toLowerCase().trim();
  const isAndroid = (data.platform || '').toLowerCase().includes('android') || rawType === 'phone';
  const deviceType = ['phone', 'laptop'].includes(rawType) ? rawType : (isAndroid ? 'phone' : 'laptop');

  const existing = userSess[deviceType];
  const now = Date.now();
  const wasOnline = existing ? isDeviceOnline(existing) : false;

  const deviceName = data.deviceName || existing?.deviceName || (deviceType === 'phone' ? 'Android-Phone' : 'My-Laptop');
  const hostname = data.hostname || existing?.hostname || (deviceType === 'phone' ? 'Android-Device' : 'Laptop-Host');
  const platform = data.platform || existing?.platform || (deviceType === 'phone' ? 'android' : 'win32');
  const username = data.username !== undefined ? data.username : (existing?.username || '');
  const osVersion = data.osVersion !== undefined ? data.osVersion : (existing?.osVersion || '');
  const storageDir = data.storageDir || existing?.storageDir || (deviceType === 'phone' ? '/sdcard/Download' : '');
  const customDeviceId = data.deviceId || existing?.deviceId;
  const deviceId = customDeviceId || `${deviceName}_${hostname}_${username || 'user'}_${platform}`;

  const deviceRecord = {
    ...(existing || {}),
    ...data,
    deviceId,
    deviceName,
    deviceType,
    hostname,
    platform,
    username,
    osVersion,
    storageDir,
    lastSeen: now,
    connectedAt: existing?.connectedAt || new Date().toISOString(),
  };

  userSess[deviceType] = deviceRecord;
  defaultDevice.set(uid, deviceType);

  // Maintain connectedLaptops Map for backward compatibility
  if (!connectedLaptops.has(uid)) {
    connectedLaptops.set(uid, new Map());
  }
  connectedLaptops.get(uid).set(deviceId, deviceRecord);

  // Send notification ONLY when transitioning from OFFLINE to ONLINE
  if (!wasOnline) {
    console.log(`[Laptop Bridge] 🟢 Device transitioned OFFLINE -> ONLINE: [${deviceType.toUpperCase()}] "${deviceName}" (${hostname}) for User ${uid}`);
    sendDeviceConnectedNotification(uid, deviceRecord);
  }

  return deviceRecord;
}

/**
 * Resolve target string (app alias or URL) to a full URL
 */
export function resolveAppOrWebUrl(target) {
  if (!target || typeof target !== 'string') return 'https://gemini.google.com';
  const clean = target.trim();
  const lower = clean.toLowerCase();

  const APP_URL_MAP = {
    gemini: 'https://gemini.google.com',
    youtube: 'https://youtube.com',
    google: 'https://google.com',
    github: 'https://github.com',
    x: 'https://x.com',
    twitter: 'https://x.com',
    chatgpt: 'https://chatgpt.com',
    claude: 'https://claude.ai',
    reddit: 'https://reddit.com',
    telegram: 'https://web.telegram.org',
    gmail: 'https://mail.google.com',
    maps: 'https://maps.google.com',
    spotify: 'https://open.spotify.com',
    netflix: 'https://netflix.com',
    instagram: 'https://instagram.com',
    facebook: 'https://facebook.com',
    tiktok: 'https://tiktok.com',
    discord: 'https://discord.com',
  };

  if (APP_URL_MAP[lower]) return APP_URL_MAP[lower];
  if (/^https?:\/\//i.test(clean)) return clean;
  if (/^[a-zA-Z0-9-]+\.[a-zA-Z]{2,}(?:\/.*)?$/i.test(clean)) return `https://${clean}`;
  return `https://${clean}.com`;
}

/**
 * Open URL or app directly on the user's physical device
 */
export async function openOnDevice(userId, target, targetDevice = null) {
  const url = resolveAppOrWebUrl(target);
  const selected = selectOnlineDevice(userId, targetDevice, 'open_on_device');
  if (!selected) {
    throw new Error('No active device (phone or laptop) is connected to open the target.');
  }

  const platform = (selected.platform || (selected.deviceType === 'phone' ? 'android' : 'win32')).toLowerCase();
  let cmd;
  if (platform === 'android' || selected.deviceType === 'phone') {
    cmd = `am start -a android.intent.action.VIEW -d "${url}" >/dev/null 2>&1 || termux-open-url "${url}"`;
  } else if (platform === 'win32') {
    cmd = `start "" "${url}"`;
  } else if (platform === 'darwin') {
    cmd = `open "${url}"`;
  } else {
    cmd = `xdg-open "${url}" >/dev/null 2>&1 || sensible-browser "${url}" >/dev/null 2>&1 || python3 -m webbrowser "${url}"`;
  }

  return await sendLaptopTask(
    userId,
    'open_on_device',
    { target, url, command: cmd },
    20000,
    null,
    targetDevice || selected.deviceType
  );
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
 * Upload a file from the user's active device to the cloud server and Telegram Cloud Vault
 */
export async function uploadLaptopFileToServer(userId, filePath, saveToCloudVault = true, targetDevice = null) {
  return await sendLaptopTask(userId, 'upload_to_server', { filePath, saveToCloudVault }, 360000, null, targetDevice);
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

      const secret = (url.searchParams.get('secret') || '').trim();
      const userIdParam = (url.searchParams.get('userId') || url.searchParams.get('user') || '').trim();

      const expectedSecret = (getExpectedSecret() || '').trim();
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
            try {
              prevDev.ws.send(JSON.stringify({
                type: 'replaced',
                message: `Connection replaced by newer session for device "${deviceId}".`
              }));
            } catch {}
            prevDev.ws.close(1000, 'Replaced by new connection');
          }
        } catch {}
      }

      const deviceRecord = registerOrUpdateDeviceSession(userId, {
        ws,
        deviceId,
        deviceName,
        deviceType,
        hostname,
        platform,
        username,
        osVersion,
        storageDir: storageDir || (platform === 'android' ? '/sdcard/Download' : ''),
        lastStatus: previousStatus,
      });

      console.log(`[Laptop Bridge] 💻 Device registered via WebSocket: "${deviceName}" [${deviceType.toUpperCase()}] (${hostname} / ${platform} / ${osVersion}) for User ${userId}`);

      ws.send(
        JSON.stringify({
          type: 'connected',
          message: `Connected to Cloud Agent Bridge successfully as "${deviceName}".`,
          userId,
          deviceType,
          deviceId,
        })
      );

      // Heartbeat tracking to detect dropped/silent connections
      let isAlive = true;
      ws.on('pong', () => {
        isAlive = true;
        deviceRecord.lastPing = Date.now();
        deviceRecord.lastSeen = Date.now();
      });

      // Keepalive ping timer (every 15s to keep reverse proxy tunnel alive)
      const pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          if (!isAlive) {
            console.log(`[Laptop Bridge] Device "${deviceName}" [${deviceId}] heartbeat timeout (no pong). Terminating dead socket.`);
            clearInterval(pingInterval);
            try {
              ws.terminate();
            } catch {}
            return;
          }
          isAlive = false;
          try {
            ws.ping();
          } catch {}
        } else {
          clearInterval(pingInterval);
        }
      }, 15000);

      ws.on('message', (data) => {
        isAlive = true;
        deviceRecord.lastSeen = Date.now();

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
          currentDev.ws = null;
          console.log(`[Laptop Bridge] 💻 Device WebSocket closed: "${deviceName}" [${deviceType.toUpperCase()}] for User ${userId}`);
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

