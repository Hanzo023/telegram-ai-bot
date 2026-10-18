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
    .replace(/(?:AIza[0-9A-Za-z-_]{35}|AQ\.[A-Za-z0-9_\-]{30,})/g, '[REDACTED_TOKEN]')
    .replace(/(?:(?:session_logininfo|LOGIN_INFO|VISITOR_INFO1_LIVE|__Secure-[13]PSID(?:TS|CC)?)\s*[:=\t]\s*)[^\s;&"']{15,}/gi, '[REDACTED_COOKIE_TOKEN]');
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

export function normalizeNetscapeCookies(rawText) {
  if (!rawText || typeof rawText !== 'string') return '';
  let text = rawText.trim();

  // If base64 encoded
  if (!text.includes('# Netscape') && !text.includes('\t') && !text.includes('youtube.com')) {
    try {
      const decoded = Buffer.from(text, 'base64').toString('utf8');
      if (decoded.includes('# Netscape') || decoded.includes('\t') || decoded.includes('youtube.com')) {
        text = decoded;
      }
    } catch {}
  }

  // Handle literal escaped \n, \r, and \t strings that occur in web dashboard input boxes
  if (text.includes('\\n')) {
    text = text.replaceAll('\\r', '').replaceAll('\\n', '\n');
  }
  if (text.includes('\\t')) {
    text = text.replaceAll('\\t', '\t');
  }

  const lines = text.split(/\r?\n/);
  const normalizedLines = ['# Netscape HTTP Cookie File'];

  for (let line of lines) {
    line = line.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    // If it already has tabs
    if (line.includes('\t')) {
      normalizedLines.push(line);
      continue;
    }
    // If it was space-separated due to browser copy-paste into HTML inputs
    const parts = line.split(/\s+/);
    if (parts.length >= 7) {
      const domain = parts[0];
      const flag = parts[1];
      const pth = parts[2];
      const secure = parts[3];
      const expiry = parts[4];
      const name = parts[5];
      const value = parts.slice(6).join(' ');
      normalizedLines.push([domain, flag, pth, secure, expiry, name, value].join('\t'));
    }
  }

  return normalizedLines.join('\n') + '\n';
}

let cachedCookiePath = null;

export function hasYouTubeCookiesSync() {
  const envCookies = process.env.YOUTUBE_COOKIES || process.env.COOKIES || process.env.COOKIE;
  if (envCookies && envCookies.trim().length > 20) return true;
  if (cachedCookiePath && fs.existsSync(cachedCookiePath)) {
    try {
      if (fs.statSync(cachedCookiePath).size > 20) return true;
    } catch {}
  }
  const candidatePaths = [
    path.join(process.cwd(), 'cookies.txt'),
    '/etc/secrets/cookies.txt',
    path.join(os.homedir(), 'cookies.txt'),
    path.join(os.tmpdir(), 'cookies.txt'),
    path.join(os.tmpdir(), 'yt_cookies.txt'),
  ];
  for (const p of candidatePaths) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).size > 20) return true;
    } catch {}
  }
  if (fs.existsSync('/etc/secrets')) {
    try {
      const files = fs.readdirSync('/etc/secrets');
      for (const file of files) {
        if (/cookie/i.test(file)) {
          const stats = fs.statSync(path.join('/etc/secrets', file));
          if (stats.isFile() && stats.size > 20) return true;
        }
      }
    } catch {}
  }
  return false;
}

export async function getCookiesFilePath() {
  // 1. Check if YOUTUBE_COOKIES or COOKIES is defined in environment variables (write fresh to ensure updates apply)
  const envCookies = process.env.YOUTUBE_COOKIES || process.env.COOKIES || process.env.COOKIE;
  if (envCookies && envCookies.trim().length > 20) {
    const tmpCookiePath = path.join(os.tmpdir(), 'yt_cookies.txt');
    const normalized = normalizeNetscapeCookies(envCookies);
    if (normalized && normalized.length > 30) {
      await fsp.writeFile(tmpCookiePath, normalized, { encoding: 'utf8', mode: 0o600 });
      cachedCookiePath = tmpCookiePath;
      return tmpCookiePath;
    }
  }

  // 2. Check candidate file paths
  const candidatePaths = [
    path.join(process.cwd(), 'cookies.txt'),
    '/etc/secrets/cookies.txt',
    path.join(os.homedir(), 'cookies.txt'),
    path.join(os.tmpdir(), 'cookies.txt'),
    path.join(os.tmpdir(), 'yt_cookies.txt'),
  ];
  for (const p of candidatePaths) {
    if (fs.existsSync(p)) {
      try {
        const stats = await fsp.stat(p);
        if (stats.size > 20) {
          return p;
        }
      } catch {}
    }
  }

  // 3. Dynamically scan Render Secret Files directory (/etc/secrets) for any cookie file
  if (fs.existsSync('/etc/secrets')) {
    try {
      const files = await fsp.readdir('/etc/secrets');
      for (const file of files) {
        const fullPath = path.join('/etc/secrets', file);
        try {
          const stats = await fsp.stat(fullPath);
          if (stats.isFile() && stats.size > 20) {
            const head = await fsp.readFile(fullPath, 'utf8');
            if (head.includes('.youtube.com') || head.includes('# Netscape') || /cookie/i.test(file)) {
              return fullPath;
            }
          }
        } catch {}
      }
    } catch {}
  }

  // 4. Check cached cookie path
  if (cachedCookiePath && fs.existsSync(cachedCookiePath)) {
    try {
      const stats = await fsp.stat(cachedCookiePath);
      if (stats.size > 20) {
        return cachedCookiePath;
      }
    } catch {}
  }

  return null;
}

export async function hasYouTubeCookies() {
  return hasYouTubeCookiesSync();
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
  const hasCookies = Boolean(cookiePath && fs.existsSync(cookiePath));

  const desktopUA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
  const androidUA =
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';
  const iosUA =
    'com.google.ios.youtube/19.29.1 (iPhone16,2; U; CPU iOS 17_5_1 like Mac OS X; en_US)';

  const commonArgs = [
    ...runner.args,
    '--no-playlist',
    '--no-check-certificates',
    '--geo-bypass',
    '--no-progress',
    '--socket-timeout', '30',
  ];

  console.log(`Starting media download for: ${cleanUrl} (cookies: ${hasCookies ? path.basename(cookiePath) : 'none'})`);

  const execOpts = { timeout: 180000, maxBuffer: 10 * 1024 * 1024 };
  let lastError = null;

  if (isYouTube) {
    if (hasCookies) {
      // -------------------------------------------------------------
      // WITH COOKIES: Desktop web cookies must be used with web clients
      // -------------------------------------------------------------
      // Attempt 1: default, web_embedded, mweb (with -tv_downgraded blacklisted)
      try {
        console.log('Attempt 1: Authenticated download with default,web_embedded client...');
        const args1 = [
          ...commonArgs,
          '--cookies', cookiePath,
          '--extractor-args', 'youtube:player_client=default,web_embedded,mweb,-tv_downgraded',
          '--add-header', `User-Agent:${desktopUA}`,
          '--add-header', 'Accept-Language:en-US,en;q=0.9',
          '-f', 'best[height<=720][ext=mp4]/bestvideo[height<=720]+bestaudio/best[ext=mp4]/18/best',
          '--merge-output-format', 'mp4',
          '-o', outTemplate,
          cleanUrl,
        ];
        await execFilePromise(runner.bin, args1, execOpts);
        lastError = null;
      } catch (err1) {
        lastError = err1;
        console.warn('Attempt 1 (default,web_embedded) failed:', sanitizeError(err1));

        // Attempt 2: Fallback with cookies using web_creator (Studio) at 360p (itag 18)
        try {
          console.log('Attempt 2: Authenticated download with web_creator client...');
          const args2 = [
            ...commonArgs,
            '--cookies', cookiePath,
            '--extractor-args', 'youtube:player_client=web_creator,web_embedded,web,-tv,-tv_downgraded',
            '--add-header', `User-Agent:${desktopUA}`,
            '--add-header', 'Accept-Language:en-US,en;q=0.9',
            '-f', '18/best[height<=480][ext=mp4]/best',
            '--merge-output-format', 'mp4',
            '-o', outTemplate,
            cleanUrl,
          ];
          await execFilePromise(runner.bin, args2, execOpts);
          lastError = null;
        } catch (err2) {
          lastError = err2;
          console.warn('Attempt 2 (web_creator) failed:', sanitizeError(err2));

          // Attempt 3: If cookies were rejected/flagged, retry anonymously via Android/iOS client
          try {
            console.log('Attempt 3: Retrying anonymously without cookies via Android client...');
            const args3 = [
              ...commonArgs,
              '--extractor-args', 'youtube:player_client=android,ios,-tv,-tv_downgraded',
              '--add-header', `User-Agent:${androidUA}`,
              '--add-header', 'Accept-Language:en-US,en;q=0.9',
              '-f', '18/best[height<=720][ext=mp4]/best',
              '--merge-output-format', 'mp4',
              '-o', outTemplate,
              cleanUrl,
            ];
            await execFilePromise(runner.bin, args3, execOpts);
            lastError = null;
          } catch (err3) {
            lastError = err3;
            console.warn('Attempt 3 (anonymous android) failed:', sanitizeError(err3));

            // Attempt 4: Anonymous iOS client fallback
            try {
              console.log('Attempt 4: Retrying anonymously via iOS client...');
              const args4 = [
                ...commonArgs,
                '--extractor-args', 'youtube:player_client=ios',
                '--add-header', `User-Agent:${iosUA}`,
                '-f', '18/best',
                '-o', outTemplate,
                cleanUrl,
              ];
              await execFilePromise(runner.bin, args4, execOpts);
              lastError = null;
            } catch (err4) {
              lastError = err4;
              console.warn('Attempt 4 (anonymous ios) failed:', sanitizeError(err4));
            }
          }
        }
      }
    } else {
      // -------------------------------------------------------------
      // WITHOUT COOKIES: Mobile Android/iOS clients optimized for unauthenticated requests
      // -------------------------------------------------------------
      // Attempt 1: Android client 720p
      try {
        console.log('Attempt 1 (no cookies): Downloading via Android mobile client...');
        const args1 = [
          ...commonArgs,
          '--extractor-args', 'youtube:player_client=android,-tv,-tv_downgraded',
          '--add-header', `User-Agent:${androidUA}`,
          '--add-header', 'Accept-Language:en-US,en;q=0.9',
          '-f', 'best[height<=720][ext=mp4]/bestvideo[height<=720]+bestaudio/best[ext=mp4]/18/best',
          '--merge-output-format', 'mp4',
          '-o', outTemplate,
          cleanUrl,
        ];
        await execFilePromise(runner.bin, args1, execOpts);
        lastError = null;
      } catch (err1) {
        lastError = err1;
        console.warn('Attempt 1 (no cookies, android) failed:', sanitizeError(err1));

        // Attempt 2: Android 360p (itag 18)
        try {
          console.log('Attempt 2 (no cookies): Android 360p standalone...');
          const args2 = [
            ...commonArgs,
            '--extractor-args', 'youtube:player_client=android,-tv,-tv_downgraded',
            '--add-header', `User-Agent:${androidUA}`,
            '-f', '18/best[height<=480][ext=mp4]/best',
            '--merge-output-format', 'mp4',
            '-o', outTemplate,
            cleanUrl,
          ];
          await execFilePromise(runner.bin, args2, execOpts);
          lastError = null;
        } catch (err2) {
          lastError = err2;
          console.warn('Attempt 2 (no cookies, android 360p) failed:', sanitizeError(err2));

          // Attempt 3: iOS client
          try {
            console.log('Attempt 3 (no cookies): iOS client fallback...');
            const args3 = [
              ...commonArgs,
              '--extractor-args', 'youtube:player_client=ios',
              '--add-header', `User-Agent:${iosUA}`,
              '-f', '18/best',
              '-o', outTemplate,
              cleanUrl,
            ];
            await execFilePromise(runner.bin, args3, execOpts);
            lastError = null;
          } catch (err3) {
            lastError = err3;
            console.warn('Attempt 3 (no cookies, ios) failed:', sanitizeError(err3));
          }
        }
      }
    }
  } else {
    // Non-YouTube platforms (TikTok, Twitter, etc.)
    try {
      const nonYtArgs = [
        ...commonArgs,
        ...(hasCookies ? ['--cookies', cookiePath] : []),
        '-f', 'best[height<=720][ext=mp4]/bestvideo[height<=720]+bestaudio/best[ext=mp4]/best',
        '--merge-output-format', 'mp4',
        '-o', outTemplate,
        cleanUrl,
      ];
      await execFilePromise(runner.bin, nonYtArgs, execOpts);
      lastError = null;
    } catch (nonYtErr) {
      lastError = nonYtErr;
      try {
        const fallbackArgs = [
          ...commonArgs,
          '-f', 'best',
          '-o', outTemplate,
          cleanUrl,
        ];
        await execFilePromise(runner.bin, fallbackArgs, execOpts);
        lastError = null;
      } catch (fbErr) {
        lastError = fbErr;
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
    const isBotChallenge =
      /sign in to confirm/i.test(stderr) ||
      /confirm you(?:'|’|&#39;|\s+a)?re not a bot/i.test(stderr) ||
      /the page needs to be reloaded/i.test(stderr) ||
      /please sign in/i.test(stderr) ||
      /use --cookies/i.test(stderr) ||
      /bot\s+detection/i.test(stderr);

    if (isYouTube && isBotChallenge) {
      if (hasCookies) {
        throw new Error(
          "YOUTUBE_SESSION_FLAGGED: YouTube rejected the current session cookies or the session expired ('The page needs to be reloaded')."
        );
      } else {
        throw new Error(
          "YOUTUBE_BOT_PROTECTION: YouTube requires account cookies to download on cloud servers (Render)."
        );
      }
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
  const hasCookies = hasYouTubeCookiesSync();

  const isBotOrReload =
    /YOUTUBE_SESSION_FLAGGED/i.test(msg) ||
    /YOUTUBE_BOT_PROTECTION/i.test(msg) ||
    /sign in to confirm/i.test(msg) ||
    /confirm you(?:'|’|&#39;|\s+a)?re not a bot/i.test(msg) ||
    /the page needs to be reloaded/i.test(msg) ||
    /please sign in/i.test(msg) ||
    /use --cookies/i.test(msg) ||
    /bot\s+detection/i.test(msg);

  // 1. If cookies are ACTIVE on the server, but YouTube flagged or rejected the session
  if (hasCookies && isBotOrReload) {
    return (
      `⚠️ *YouTube Session Flagged / Cookies Expired*\n\n` +
      `Your \`YOUTUBE_COOKIES\` are active on the server, but YouTube's anti-bot system flagged the session or the cookies have expired ("The page needs to be reloaded").\n\n` +
      `💡 *Why this happens:*\n` +
      `YouTube rotates session security keys (\`__Secure-1PSIDTS\` and \`SIDCC\`) when you browse, change IP, or log in on different devices.\n\n` +
      `🔧 *How to refresh in 30 seconds:*\n` +
      `1️⃣ Open YouTube in an **Incognito / Private tab** and log in to a Google account.\n` +
      `2️⃣ Click **Get cookies.txt LOCALLY** and copy the fresh cookie text.\n` +
      `3️⃣ In Render Dashboard ➔ **Environment** ➔ Update \`YOUTUBE_COOKIES\` with the new text and save.\n\n` +
      `Once saved, Render redeploys and downloads will work! 🚀`
    );
  }

  // 2. If NO cookies are detected on the server
  if (isBotOrReload) {
    return (
      `⚠️ *YouTube Cloud Server Protection*\n\n` +
      `YouTube blocks automated downloads from cloud servers (Render) without account cookies.\n\n` +
      `💡 *How to enable YouTube downloads in 1 minute:*\n` +
      `1️⃣ Install the *Get cookies.txt LOCALLY* extension on your browser (Chrome/Edge/Firefox).\n` +
      `2️⃣ Open YouTube, click the extension icon, and copy the cookie text.\n` +
      `3️⃣ In Render Dashboard ➔ *Environment* ➔ Add Environment Variable:\n` +
      `   *Key:* \`YOUTUBE_COOKIES\`\n` +
      `   *Value:* *(paste cookie text)*\n\n` +
      `Once saved, Render will restart and YouTube downloads will work! 🚀`
    );
  }

  // 3. Any other specific error
  const matchError = msg.match(/ERROR:\s*([^\n\r]+)/i);
  const cleanErrorMsg = matchError ? matchError[1].trim() : msg;
  return `❌ *Download failed:*\n\`${sanitizeError(cleanErrorMsg).slice(0, 200)}\`\n\nPlease check the link and try again.`;
}
