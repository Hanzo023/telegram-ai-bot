import puppeteer from 'puppeteer-core';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * High-performance Singleton Browser Service for Render Free Tier (0.1 vCPU, 512 MB RAM).
 * 
 * Features:
 * 1. Warm singleton instance reused across all requests (zero cold-start overhead).
 * 2. Extreme low-resource flags (--single-process, --disable-dev-shm-usage, --disable-gpu, etc.).
 * 3. 1280x720 viewport.
 * 4. Fast domcontentloaded navigation with 12s hard timeout (captures immediately if timed out).
 * 5. In-memory JPEG compression at quality=70 (zero disk I/O).
 * 6. High-precision millisecond step profiler logs.
 */

let browserInstance = null;
let isLaunching = null;

const LOW_RESOURCE_FLAGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--disable-extensions',
  '--single-process',
  '--no-zygote',
  '--disable-accelerated-2d-canvas',
  '--disable-audio-output',
  '--disable-background-networking',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-breakpad',
  '--disable-client-side-phishing-detection',
  '--disable-component-update',
  '--disable-default-apps',
  '--disable-domain-reliability',
  '--disable-features=AudioServiceOutOfProcess,IsolateOrigins,site-per-process,TranslateUI,BlinkGenPropertyTrees',
  '--disable-hang-monitor',
  '--disable-ipc-flooding-protection',
  '--disable-notifications',
  '--disable-offer-store-unmasked-wallet-cards',
  '--disable-popup-blocking',
  '--disable-print-preview',
  '--disable-prompt-on-repost',
  '--disable-renderer-backgrounding',
  '--disable-speech-api',
  '--disable-sync',
  '--hide-scrollbars',
  '--ignore-gpu-blacklist',
  '--metrics-recording-only',
  '--mute-audio',
  '--no-default-browser-check',
  '--no-first-run',
  '--no-pings',
  '--password-store=basic',
  '--use-gl=swiftshader',
  '--use-mock-keychain',
];

/**
 * Locate Chrome / Chromium binary across Linux (Render) and Windows environments.
 */
export function findBrowserExecutable() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  const candidates = [
    // Linux / Render Container paths
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    // Windows paths
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    path.join(os.homedir(), 'AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'),
  ];

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {}
  }

  return null;
}

/**
 * Get or initialize persistent singleton browser instance
 */
export async function getSingletonBrowser() {
  if (browserInstance && browserInstance.isConnected()) {
    return browserInstance;
  }

  if (isLaunching) {
    return await isLaunching;
  }

  isLaunching = (async () => {
    const t0 = performance.now();
    const executablePath = findBrowserExecutable();
    if (!executablePath) {
      console.warn('[PROFILER] No local Chrome/Chromium executable found for server-side browser automation.');
      return null;
    }

    console.log(`[PROFILER] Initializing persistent singleton browser with lightweight 512MB RAM flags...`);
    try {
      browserInstance = await puppeteer.launch({
        executablePath,
        headless: true,
        args: LOW_RESOURCE_FLAGS,
        ignoreHTTPSErrors: true,
      });

      browserInstance.on('disconnected', () => {
        console.warn('[PROFILER] Persistent browser disconnected. Will recreate on next request.');
        browserInstance = null;
      });

      const launchTime = Math.round(performance.now() - t0);
      console.log(`[PROFILER] Step: Singleton browser warm-up took ${launchTime} ms`);
      return browserInstance;
    } catch (err) {
      console.error(`[PROFILER] Browser launch failed: ${err.message}`);
      browserInstance = null;
      return null;
    } finally {
      isLaunching = null;
    }
  })();

  return await isLaunching;
}

/**
 * Open URL in a lightweight tab, navigate with domcontentloaded (12s timeout),
 * and capture an in-memory JPEG screenshot (1280x720, quality=70).
 * 
 * @param {string} url - Target URL to open and capture
 * @param {object} [options]
 * @param {function} [options.onStageUpdate] - Callback for real-time stage updates
 * @returns {Promise<{ success: boolean, buffer?: Buffer, base64?: string, error?: string, durationMs: number }>}
 */
export async function captureWebPageSnapshot(url, options = {}) {
  const overallT0 = performance.now();
  const { onStageUpdate } = options;

  let targetUrl = url;
  if (!/^https?:\/\//i.test(targetUrl)) {
    targetUrl = 'https://' + targetUrl;
  }

  // Stage 1: Opening target
  if (onStageUpdate) {
    await onStageUpdate('🚀 Opening target...');
  }

  const browser = await getSingletonBrowser();
  if (!browser) {
    return {
      success: false,
      error: 'Browser binary not available on host environment.',
      durationMs: Math.round(performance.now() - overallT0),
    };
  }

  const pageT0 = performance.now();
  let page = null;

  try {
    page = await browser.newPage();
    // Enforce 1280x720 viewport
    await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });

    // Block heavy media/fonts on Render free tier to conserve RAM and bandwidth
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const resourceType = req.resourceType();
      if (['media', 'font'].includes(resourceType)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    console.log(`[PROFILER] Navigating to: ${targetUrl} (domcontentloaded, 12s timeout)...`);
    const navT0 = performance.now();

    try {
      await page.goto(targetUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 12000,
      });
      const navDuration = Math.round(performance.now() - navT0);
      console.log(`[PROFILER] Step: Target navigation took ${navDuration} ms`);
    } catch (navErr) {
      const navDuration = Math.round(performance.now() - navT0);
      console.warn(`[PROFILER] Step: Navigation timed out/warned after ${navDuration} ms (${navErr.message}). Capturing immediate snapshot...`);
    }

    // Stage 2: Capturing screenshot
    if (onStageUpdate) {
      await onStageUpdate('📸 Capturing screenshot...');
    }

    const snapT0 = performance.now();
    // Capture directly into memory buffer as JPEG with quality=70 (zero disk writes)
    const imageBuffer = await page.screenshot({
      type: 'jpeg',
      quality: 70,
      optimizeForSpeed: true,
    });

    const snapDuration = Math.round(performance.now() - snapT0);
    console.log(`[PROFILER] Step: In-memory JPEG capture (1280x720, quality=70) took ${snapDuration} ms (size: ${Math.round(imageBuffer.length / 1024)} KB)`);

    const totalDuration = Math.round(performance.now() - overallT0);
    console.log(`[PROFILER] Step: Total web snapshot workflow took ${totalDuration} ms`);

    return {
      success: true,
      buffer: imageBuffer,
      base64: imageBuffer.toString('base64'),
      durationMs: totalDuration,
      url: targetUrl,
    };
  } catch (err) {
    const errDuration = Math.round(performance.now() - overallT0);
    console.error(`[PROFILER] Web snapshot error after ${errDuration} ms: ${err.message}`);
    return {
      success: false,
      error: err.message,
      durationMs: errDuration,
    };
  } finally {
    if (page) {
      await page.close().catch(() => {});
    }
  }
}
