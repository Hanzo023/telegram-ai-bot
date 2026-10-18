import { exec, execFile } from 'child_process';
import util from 'util';
import path from 'path';
import fs from 'fs';
import { promises as fsp } from 'fs';
import os from 'os';

const execPromise = util.promisify(exec);
const execFilePromise = util.promisify(execFile);

export function sanitizeError(err) {
  if (!err) return '';
  const msg = typeof err === 'string' ? err : err.message || String(err);
  let res = msg
    .replace(/(?:bot)?\d{8,11}:[A-Za-z0-9_-]{35}/g, '[REDACTED_TOKEN]')
    .replace(/sk-(?:ant-)?[a-zA-Z0-9_\-]{20,}/g, '[REDACTED_TOKEN]')
    .replace(/(?:AIza[0-9A-Za-z-_]{35}|AQ\.[A-Za-z0-9_\-]{30,})/g, '[REDACTED_TOKEN]');
  if (process.env.YOUTUBE_COOKIES && process.env.YOUTUBE_COOKIES.length >= 8) {
    res = res.split(process.env.YOUTUBE_COOKIES.trim()).join('[REDACTED_SECRET]');
  }
  return res;
}

// Standard Category Definitions
export const FILE_CATEGORIES = {
  pdf: { id: 'pdf', name: '📄 PDF Documents', folder: 'pdf', icon: '📄' },
  python: { id: 'python', name: '🐍 Python Scripts', folder: 'python', icon: '🐍' },
  code: { id: 'code', name: '💻 Code Files', folder: 'code', icon: '💻' },
  docs: { id: 'docs', name: '📝 Documents & Text', folder: 'docs', icon: '📝' },
  images: { id: 'images', name: '🖼️ Photos & Images', folder: 'images', icon: '🖼️' },
  media: { id: 'media', name: '🎥 Videos & Audio', folder: 'media', icon: '🎥' },
  other: { id: 'other', name: '❓ Other / Unknown', folder: 'other', icon: '📁' },
};

export const EXTENSION_MAP = {
  // PDF
  pdf: 'pdf',

  // Python
  py: 'python',
  pyw: 'python',
  ipynb: 'python',

  // Code
  java: 'code',
  cpp: 'code',
  cc: 'code',
  cxx: 'code',
  c: 'code',
  h: 'code',
  hpp: 'code',
  js: 'code',
  mjs: 'code',
  cjs: 'code',
  ts: 'code',
  cs: 'code',
  go: 'code',
  rs: 'code',
  html: 'code',
  htm: 'code',
  css: 'code',
  scss: 'code',
  sql: 'code',
  sh: 'code',
  bat: 'code',
  ps1: 'code',
  php: 'code',
  rb: 'code',

  // Documents
  txt: 'docs',
  md: 'docs',
  markdown: 'docs',
  rtf: 'docs',
  csv: 'docs',
  json: 'docs',
  xml: 'docs',
  yaml: 'docs',
  yml: 'docs',
  doc: 'docs',
  docx: 'docs',

  // Images
  png: 'images',
  jpg: 'images',
  jpeg: 'images',
  webp: 'images',
  gif: 'images',
  bmp: 'images',
  svg: 'images',
  ico: 'images',

  // Media
  mp4: 'media',
  webm: 'media',
  mkv: 'media',
  mov: 'media',
  avi: 'media',
  mp3: 'media',
  m4a: 'media',
  ogg: 'media',
  wav: 'media',
  flac: 'media',
};

/**
 * Returns category info for a given file extension.
 * Known extensions go to their specific category; unknown/weird formats go to 'other'.
 */
export function getFileCategory(extension) {
  const cleanExt = (extension || '').toLowerCase().replace(/^\./, '').trim();
  const catKey = EXTENSION_MAP[cleanExt];
  if (catKey && FILE_CATEGORIES[catKey]) {
    return FILE_CATEGORIES[catKey];
  }
  return FILE_CATEGORIES.other;
}

/**
 * Clean and decode HTML entities
 */
function decodeHtmlEntities(str) {
  if (!str) return '';
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Perform web search using DuckDuckGo HTML endpoint
 */
export async function searchWeb(query, maxResults = 5) {
  try {
    const url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query);
    const res = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
    });

    if (!res.ok) {
      throw new Error(`Search request failed with status: ${res.status}`);
    }

    const html = await res.text();
    const results = [];
    const blocks = html.split('<h2 class="result__title">');

    for (let i = 1; i < blocks.length && results.length < maxResults; i++) {
      const b = blocks[i];
      const titleMatch = b.match(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
      const snippetMatch = b.match(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);

      if (titleMatch) {
        let rawHref = titleMatch[1];
        let link = rawHref;
        const uddgMatch = rawHref.match(/[?&]uddg=([^&]+)/);
        if (uddgMatch) {
          link = decodeURIComponent(uddgMatch[1]);
        }
        const title = decodeHtmlEntities(titleMatch[2]);
        const snippet = snippetMatch ? decodeHtmlEntities(snippetMatch[1]) : '';
        results.push({ title, link, snippet });
      }
    }

    return results;
  } catch (err) {
    console.error('Error during web search:', sanitizeError(err));
    return [];
  }
}

let cachedYtDlpRunner = null;

export async function getYtDlpRunner() {
  if (cachedYtDlpRunner) return cachedYtDlpRunner;
  const candidates = [
    { bin: 'yt-dlp', args: [] },
    { bin: 'python3', args: ['-m', 'yt_dlp'] },
    { bin: 'python', args: ['-m', 'yt_dlp'] },
  ];
  for (const c of candidates) {
    try {
      await execFilePromise(c.bin, [...c.args, '--version'], { timeout: 4000 });
      cachedYtDlpRunner = c;
      return c;
    } catch {}
  }
  cachedYtDlpRunner = { bin: 'yt-dlp', args: [] };
  return cachedYtDlpRunner;
}

let cachedCookiePath = null;

export async function getCookiesFilePath() {
  // 1. Check if cookies.txt exists in root directory
  const rootCookiePath = path.join(process.cwd(), 'cookies.txt');
  if (fs.existsSync(rootCookiePath)) {
    return rootCookiePath;
  }

  // 2. Check cached cookie path
  if (cachedCookiePath && fs.existsSync(cachedCookiePath)) {
    return cachedCookiePath;
  }

  // 3. Check if YOUTUBE_COOKIES is defined in environment variables
  const envCookies = process.env.YOUTUBE_COOKIES;
  if (envCookies && envCookies.trim()) {
    const tmpCookiePath = path.join(os.tmpdir(), 'yt_cookies.txt');
    let content = envCookies.trim();
    // Auto-detect base64 encoded cookies
    if (!content.includes('# Netscape') && !content.includes('\t')) {
      try {
        const decoded = Buffer.from(content, 'base64').toString('utf8');
        if (decoded.includes('# Netscape') || decoded.includes('\t')) {
          content = decoded;
        }
      } catch {}
    }
    await fsp.writeFile(tmpCookiePath, content, { encoding: 'utf8', mode: 0o600 });
    cachedCookiePath = tmpCookiePath;
    return tmpCookiePath;
  }

  return null;
}

export async function cleanupTemporaryCookies() {
  if (cachedCookiePath && fs.existsSync(cachedCookiePath)) {
    await fsp.unlink(cachedCookiePath).catch(() => {});
    cachedCookiePath = null;
  }
}

/**
 * Search YouTube for videos using native direct extraction (fastest, reliable everywhere),
 * with yt-dlp and DuckDuckGo fallbacks.
 */
export async function searchYouTube(query, maxResults = 4) {
  const sanitizedQuery = (query || '').replace(/["\\`$;|&><\r\n\t]/g, ' ').trim();
  if (!sanitizedQuery) return [];

  // Method 1: Direct native YouTube web scraping (0 dependencies, works on Render/Docker/every host)
  try {
    const url = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(sanitizedQuery);
    const res = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    if (res.ok) {
      const html = await res.text();
      const match = html.match(/var ytInitialData = ({[\s\S]+?});<\/script>/);
      if (match) {
        const data = JSON.parse(match[1]);
        const contents =
          data.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents;
        const results = [];
        if (Array.isArray(contents)) {
          for (const sec of contents) {
            const items = sec.itemSectionRenderer?.contents || [];
            for (const it of items) {
              const vr = it.videoRenderer;
              if (vr && vr.videoId) {
                const title = vr.title?.runs?.[0]?.text || 'YouTube Video';
                const duration = vr.lengthText?.simpleText || 'Video';
                const uploader = vr.ownerText?.runs?.[0]?.text || 'YouTube';
                results.push({
                  id: vr.videoId,
                  title,
                  url: `https://www.youtube.com/watch?v=${vr.videoId}`,
                  duration,
                  uploader,
                });
                if (results.length >= maxResults) break;
              }
            }
            if (results.length >= maxResults) break;
          }
        }
        if (results.length > 0) {
          return results;
        }
      }
    }
  } catch (err) {
    console.warn('Native YouTube search warning:', sanitizeError(err));
  }

  // Method 2: yt-dlp fallback
  try {
    const runner = await getYtDlpRunner();
    const cookiePath = await getCookiesFilePath();
    const ytArgs = [
      ...runner.args,
      '--no-check-certificates',
      '--geo-bypass',
      '--default-search', `ytsearch${maxResults}`,
      '--dump-json',
      '--no-warnings',
      '--flat-playlist',
    ];
    if (cookiePath && fs.existsSync(cookiePath)) {
      ytArgs.push('--cookies', cookiePath);
    }
    ytArgs.push('--extractor-args', 'youtube:player_client=android,-tv,-tv_downgraded');
    ytArgs.push(sanitizedQuery);

    const { stdout } = await execFilePromise(runner.bin, ytArgs, { timeout: 20000 });
    const lines = stdout.trim().split('\n').filter(Boolean);
    const results = [];

    for (const line of lines) {
      try {
        const item = JSON.parse(line);
        let durationStr = item.duration_string;
        if (!durationStr && item.duration) {
          const mins = Math.floor(item.duration / 60);
          const secs = String(Math.floor(item.duration % 60)).padStart(2, '0');
          durationStr = `${mins}:${secs}`;
        }
        results.push({
          id: item.id,
          title: item.title,
          url: item.url || (item.id ? `https://www.youtube.com/watch?v=${item.id}` : null),
          duration: durationStr || 'Unknown',
          uploader: item.uploader || item.channel || 'YouTube Video',
        });
      } catch {}
    }

    if (results.length > 0) {
      return results;
    }
  } catch (err) {
    console.warn('yt-dlp YouTube search warning, trying web fallback:', sanitizeError(err));
  }

  // Method 3: Graceful fallback using DuckDuckGo
  try {
    const webResults = await searchWeb(`site:youtube.com/watch ${sanitizedQuery}`, maxResults);
    const results = [];
    for (const r of webResults) {
      const match = r.link.match(/(?:v=|\/embed\/|\/shorts\/)([a-zA-Z0-9_-]{11})/);
      const id = match ? match[1] : null;
      if (id || r.link.includes('youtube.com/watch')) {
        results.push({
          id: id || '',
          title: r.title.replace(/ - YouTube$/i, ''),
          url: id ? `https://www.youtube.com/watch?v=${id}` : r.link,
          duration: 'Video',
          uploader: 'YouTube',
        });
      }
    }
    return results;
  } catch (fallbackErr) {
    console.error('All YouTube search methods failed:', sanitizeError(fallbackErr));
    return [];
  }
}

/**
 * Download a video from YouTube or TikTok using yt-dlp.
 * Targets MP4 format under 45MB to comply with Telegram's 50MB file size limit.
 */
export async function downloadMediaVideo(url, targetDir) {
  if (!fs.existsSync(targetDir)) {
    await fsp.mkdir(targetDir, { recursive: true });
  }

  let parsedUrl;
  try {
    parsedUrl = new URL((url || '').trim());
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      throw new Error('Invalid URL protocol');
    }
  } catch {
    throw new Error('Invalid URL provided for video download.');
  }

  const cleanUrl = parsedUrl.href.replace(/["\\`$;|&><]/g, '');
  const isYouTube = /(?:youtube\.com|youtu\.be)/i.test(cleanUrl);
  const timestamp = Date.now();
  const filePrefix = `video_${timestamp}`;
  const outTemplate = path.join(targetDir, `${filePrefix}_%(title).40s.%(ext)s`);

  const runner = await getYtDlpRunner();
  const cookiePath = await getCookiesFilePath();

  // Base options for datacenter IPs and cloud hosting
  const baseArgs = [
    ...runner.args,
    '--no-playlist',
    '--no-check-certificates',
    '--geo-bypass',
    '--no-progress',
    '--socket-timeout', '30',
  ];

  if (isYouTube) {
    // Explicitly enforce Android mobile client and blacklist TV clients to permanently prevent "The page needs to be reloaded" error
    baseArgs.push(
      '--extractor-args', 'youtube:player_client=android,-tv,-tv_downgraded',
      '--add-header', 'User-Agent:Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
      '--add-header', 'Accept-Language:en-US,en;q=0.9'
    );
  }

  const initialArgs = [...baseArgs];
  if (cookiePath && fs.existsSync(cookiePath)) {
    initialArgs.push('--cookies', cookiePath);
  }

  console.log(`Starting media download for: ${cleanUrl} (cookies: ${Boolean(cookiePath)})`);

  const execOpts = { timeout: 180000, maxBuffer: 10 * 1024 * 1024 };
  let lastError = null;

  // Step 1: Attempt primary format (720p MP4 or best under 50MB)
  try {
    const primaryArgs = [
      ...initialArgs,
      '-f', 'best[height<=720][ext=mp4]/bestvideo[height<=720]+bestaudio/best[ext=mp4]/18/best',
      '--merge-output-format', 'mp4',
      '-o', outTemplate,
      cleanUrl,
    ];
    await execFilePromise(runner.bin, primaryArgs, execOpts);
  } catch (primaryErr) {
    lastError = primaryErr;
    console.warn('Primary download format failed, trying 360p fallback:', sanitizeError(primaryErr));

    // Step 2: Fallback to universal standalone 360p (itag 18)
    try {
      const fallbackArgs = [
        ...initialArgs,
        '-f', '18/best[height<=480][ext=mp4]/best',
        '--merge-output-format', 'mp4',
        '-o', outTemplate,
        cleanUrl,
      ];
      await execFilePromise(runner.bin, fallbackArgs, execOpts);
      lastError = null;
    } catch (fbErr) {
      lastError = fbErr;
      console.warn('Fallback download failed:', sanitizeError(fbErr));

      // Step 3: If cookies were passed and caused failure (e.g. flagged cookie session or "page reload" error),
      // retry WITHOUT cookies using pure android client
      if (cookiePath && fs.existsSync(cookiePath)) {
        try {
          console.log('Retrying download anonymously without cookies...');
          const noCookieArgs = [
            ...baseArgs,
            '-f', '18/best[height<=720][ext=mp4]/best',
            '--merge-output-format', 'mp4',
            '-o', outTemplate,
            cleanUrl,
          ];
          await execFilePromise(runner.bin, noCookieArgs, execOpts);
          lastError = null;
        } catch (noCookieErr) {
          lastError = noCookieErr;
          console.warn('Anonymous retry failed:', sanitizeError(noCookieErr));
        }
      }

      // Step 4: If YouTube and still failing, try pure android standalone extraction
      if (isYouTube && lastError) {
        try {
          const directAndroidArgs = [
            ...runner.args,
            '--no-playlist',
            '--no-check-certificates',
            '--geo-bypass',
            '--no-progress',
            '--extractor-args', 'youtube:player_client=android',
            '-f', '18/best',
            '-o', outTemplate,
            cleanUrl,
          ];
          await execFilePromise(runner.bin, directAndroidArgs, execOpts);
          lastError = null;
        } catch (androidErr) {
          lastError = androidErr;
        }
      }
    }
  }

  if (lastError) {
    // Clean up any incomplete or partial files matching this download's filePrefix
    try {
      const leftoverFiles = await fsp.readdir(targetDir);
      for (const f of leftoverFiles) {
        if (f.startsWith(filePrefix)) {
          await fsp.unlink(path.join(targetDir, f)).catch(() => {});
        }
      }
    } catch {}

    const stderr = lastError.stderr || lastError.stdout || lastError.message || '';
    if (
      /sign in to confirm you(?:'|’|&#39;)?re not a bot/i.test(stderr) ||
      /the page needs to be reloaded/i.test(stderr) ||
      /cookies/i.test(stderr)
    ) {
      throw new Error(
        "YOUTUBE_BOT_PROTECTION: YouTube requires account cookies to download on cloud servers (Render)."
      );
    }
    const matchError = stderr.match(/ERROR:\s*([^\n\r]+)/i);
    const cleanErrorMsg = matchError ? matchError[1].trim() : (stderr.split('\n').filter(Boolean).pop() || 'Video download failed.');
    throw new Error(sanitizeError(cleanErrorMsg));
  }

  // Find the downloaded file (excluding in-progress or partial files)
  const files = await fsp.readdir(targetDir);
  const downloadedFileName = files.find(
    (f) => f.startsWith(filePrefix) && !f.endsWith('.part') && !f.endsWith('.ytdl')
  );

  if (!downloadedFileName) {
    try {
      const leftoverFiles = await fsp.readdir(targetDir);
      for (const f of leftoverFiles) {
        if (f.startsWith(filePrefix)) {
          await fsp.unlink(path.join(targetDir, f)).catch(() => {});
        }
      }
    } catch {}
    throw new Error('Downloaded video file could not be located.');
  }

  const fullPath = path.join(targetDir, downloadedFileName);
  const stats = await fsp.stat(fullPath);

  return {
    filePath: fullPath,
    fileName: downloadedFileName,
    fileSize: stats.size,
    isOverTelegramLimit: stats.size > 50 * 1024 * 1024,
  };
}

export function formatDownloadErrorMessage(err) {
  const msg = typeof err === 'string' ? err : err?.message || String(err || '');
  if (
    /sign in to confirm you(?:'|’|&#39;)?re not a bot/i.test(msg) ||
    /YOUTUBE_BOT_PROTECTION/i.test(msg) ||
    /the page needs to be reloaded/i.test(msg) ||
    /--cookies/i.test(msg)
  ) {
    return (
      `⚠️ *YouTube Cloud Server Protection*\n\n` +
      `YouTube blocks automated downloads from cloud servers (Render) without account cookies, or the session was flagged ("The page needs to be reloaded").\n\n` +
      `💡 *How to enable YouTube downloads in 1 minute:*\n` +
      `1️⃣ Install the *Get cookies.txt LOCALLY* extension on your browser (Chrome/Edge/Firefox).\n` +
      `2️⃣ Open YouTube, click the extension icon, and copy the cookie text.\n` +
      `3️⃣ In Render Dashboard ➔ *Environment* ➔ Add Environment Variable:\n` +
      `   *Key:* \`YOUTUBE_COOKIES\`\n` +
      `   *Value:* *(paste cookie text)*\n\n` +
      `Once saved, Render will restart and YouTube downloads will work permanently! 🚀`
    );
  }
  return `❌ *Download failed:*\n\`${sanitizeError(msg).slice(0, 200)}\`\n\nPlease check the link and try again.`;
}
