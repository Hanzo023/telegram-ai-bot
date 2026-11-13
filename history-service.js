import fs from 'fs';
import { promises as fsp } from 'fs';
import path from 'path';

const SEARCH_HISTORY_FILE = process.env.SEARCH_HISTORY_FILE || path.resolve('./search_history.json');
let searchHistory = [];

export async function initSearchHistory() {
  try {
    if (fs.existsSync(SEARCH_HISTORY_FILE)) {
      const data = await fsp.readFile(SEARCH_HISTORY_FILE, 'utf-8');
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed)) {
        searchHistory = parsed;
        console.log(`Loaded ${searchHistory.length} search history entries from disk.`);
      }
    }
  } catch (err) {
    console.warn('Could not load search_history.json:', err.message);
  }
}

export async function persistSearchHistory() {
  try {
    await fsp.writeFile(SEARCH_HISTORY_FILE, JSON.stringify(searchHistory, null, 2), 'utf-8');
  } catch (err) {
    console.warn('Failed to write search_history.json:', err.message);
  }
}

export async function addSearchHistoryEntry({ query, type = 'web', title = '', url = '', resultsCount = 0, topResults = [] }) {
  const entry = {
    id: Date.now().toString(),
    query,
    type, // 'youtube' | 'web' | 'shop' | 'tiktok' | 'download'
    title: title || query,
    url: url || '',
    resultsCount: resultsCount || (topResults ? topResults.length : 0),
    topResults: (topResults || []).slice(0, 5),
    date: Date.now(),
  };

  searchHistory.unshift(entry);
  if (searchHistory.length > 100) {
    searchHistory = searchHistory.slice(0, 100);
  }

  await persistSearchHistory();
  return entry;
}

export function getAllSearchHistory() {
  return searchHistory;
}

export function getSearchHistoryPage(page = 0, pageSize = 5) {
  const total = searchHistory.length;
  const totalPages = Math.ceil(total / pageSize) || 1;
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  const start = safePage * pageSize;
  const items = searchHistory.slice(start, start + pageSize);
  return { items, page: safePage, totalPages, total };
}

export function getSearchHistoryEntry(id) {
  return searchHistory.find((entry) => entry.id === id);
}

export async function deleteSearchHistoryEntry(id) {
  const idx = searchHistory.findIndex((entry) => entry.id === id);
  if (idx !== -1) {
    const removed = searchHistory.splice(idx, 1)[0];
    await persistSearchHistory();
    return removed;
  }
  return null;
}

export async function clearAllSearchHistory() {
  searchHistory = [];
  await persistSearchHistory();
}
