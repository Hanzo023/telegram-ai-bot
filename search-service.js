import { exec } from 'child_process';
import util from 'util';
import path from 'path';
import fs from 'fs';
import { promises as fsp } from 'fs';

const execPromise = util.promisify(exec);

export function sanitizeError(err) {
  if (!err) return '';
  const msg = typeof err === 'string' ? err : err.message || String(err);
  return msg
    .replace(/(?:bot)?\d{8,11}:[A-Za-z0-9_-]{35}/g, '[REDACTED_TOKEN]')
    .replace(/sk-(?:ant-)?[a-zA-Z0-9_\-]{20,}/g, '[REDACTED_TOKEN]')
    .replace(/(?:AIza[0-9A-Za-z-_]{35}|AQ\.[A-Za-z0-9_\-]{30,})/g, '[REDACTED_TOKEN]');
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

let cachedYtDlpCmd = null;

async function getYtDlpCommand() {
  if (cachedYtDlpCmd) return cachedYtDlpCmd;
  const candidates = ['yt-dlp', 'python -m yt_dlp', 'python3 -m yt_dlp'];
  for (const cmd of candidates) {
    try {
      await execPromise(`${cmd} --version`, { timeout: 3000 });
      cachedYtDlpCmd = cmd;
      return cmd;
    } catch {}
  }
  return 'python -m yt_dlp';
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
    const ytDlpCmd = await getYtDlpCommand();
    const cmd = `${ytDlpCmd} --default-search "ytsearch${maxResults}" --dump-json --no-warnings --flat-playlist "${sanitizedQuery}"`;
    const { stdout } = await execPromise(cmd, { timeout: 20000 });
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
  const timestamp = Date.now();
  const filePrefix = `video_${timestamp}`;
  const outTemplate = path.join(targetDir, `${filePrefix}_%(title).40s.%(ext)s`);

  const ytDlpCmd = await getYtDlpCommand();

  // yt-dlp format selection:
  // Prefer mp4 under 40MB, fallback to best under 45MB, or best height <= 720
  const cmd = `${ytDlpCmd} -f "bv*[filesize<40M]+ba[filesize<8M]/b[filesize<45M]/best[height<=720][ext=mp4]/best[ext=mp4]/best" --merge-output-format mp4 --no-playlist -o "${outTemplate}" "${cleanUrl}"`;

  console.log(`Starting media download for: ${cleanUrl} via ${ytDlpCmd}`);
  await execPromise(cmd, { timeout: 180000 }); // 3 min timeout

  // Find the downloaded file
  const files = await fsp.readdir(targetDir);
  const downloadedFileName = files.find((f) => f.startsWith(filePrefix));

  if (!downloadedFileName) {
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
