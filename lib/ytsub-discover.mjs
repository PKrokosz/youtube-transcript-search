// lib/ytsub-discover.mjs — zamrażanie zbioru kandydatów (D8, D13, D15).
//
// Cztery źródła, dokładnie jedno na joba:
//   --search <fraza>   z filtrami --filter key=value (videoCaption, order, ...)
//   --channel <id|@handle|nazwa>   uploads (wymaga --max-videos)
//   --playlist <id>               kolejność playlisty (wymaga --max-videos)
//   --ids-file/--id               jawna lista (bez klucza API)
//
// Koszt jednostek: search.list = 100/strona, channels.list = 1,
// playlistItems.list = 1/strona, videos.list (pre-filtr) = 1/50 ID.
// Paginacja zatrzymuje się po 20 stronach albo przy wyczerpaniu budgetu.
// Sekret (klucz API) przychodzi z env YOUTUBE_API_KEY albo config (D14).
const SEARCH_UNITS = 100;   // search.list kosztuje 100 jednostek za stronie do 50 wynikow
const CHANNEL_UNITS = 1;    // channels.list
const PLAYLIST_UNITS = 1;   // playlistItems.list za stronie do 50
const VIDEO_UNITS = 1;      // videos.list za 50 ID (pre-filtr napisow)
const PAGE = 50;
const MAX_PAGES = 20;

import { validVideoId } from "./ytsub-job.mjs";

export const FILTER_KEYS = [
  "videoCaption", "videoDuration", "videoDefinition", "order",
  "publishedAfter", "publishedBefore", "regionCode", "relevanceLanguage", "safeSearch",
];
export const SEARCH_MAX_DEFAULT = 100;  // D8: domyslnie 100, maksimum 100 (batch target)

export function apiBase() {
  return process.env.YTS_API_BASE || "https://www.googleapis.com/youtube/v3";
}

// --- parsowanie --filter key=value -----------------------------------------
export function parseFilters(pairs = []) {
  const filters = {};
  const errors = [];
  for (const raw of pairs) {
    const s = String(raw || "");
    const i = s.indexOf("=");
    const k = i === -1 ? s : s.slice(0, i);
    const v = i === -1 ? "" : s.slice(i + 1);
    if (!FILTER_KEYS.includes(k)) { errors.push(`nieznany filtr: "${k}" (dozwolone: ${FILTER_KEYS.join(", ")})`); continue; }
    if (!v) { errors.push(`filtr ${k} bez wartosci (postac: ${k}=<wartosc>)`); continue; }
    if (filters[k] !== undefined) { errors.push(`filtr ${k} podany dwa razy`); continue; }
    filters[k] = v;
  }
  if (filters.videoCaption !== undefined && !["any", "closedCaption", "none"].includes(filters.videoCaption)) {
    errors.push(`videoCaption przyjmuje any|closedCaption|none (jest: ${filters.videoCaption})`);
  }
  return { filters, errors };
}

function qs(params) {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") u.set(k, String(v));
  return u.toString();
}

async function getJson(url, opts = {}) {
  const impl = opts.fetchJson || defaultFetchJson;
  return impl(url, opts.timeoutMs || 30000);
}

async function defaultFetchJson(url, timeoutMs) {
  // AbortController + jawny timer (bez AbortSignal.timeout): na Node 24
  // AbortSignal.timeout zostawia uchwyt, który psuje asercję libuv przy wyjściu.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: "application/json" } });
    const body = await res.text();
    let json = null;
    try { json = JSON.parse(body); } catch { json = { error: { message: `odpowiedz nie jest JSON: ${body.slice(0, 120)}` } }; }
    if (!res.ok) {
      const msg = (json && json.error && json.error.message) || `HTTP ${res.status}`;
      const e = new Error(msg);
      e.http = true; e.status = res.status; e.quotaExhausted = res.status === 403 && /quota|limitExceeded/i.test(msg);
      throw e;
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

function pushUnique(list, seen, id, title) {
  if (!id || seen.has(id)) return false;
  seen.add(id); list.push(id); return true;
}

// --- źródło: --search ------------------------------------------------------
export async function discoverSearch(phrase, filters, maxVideos, opts = {}) {
  const seen = new Set(), ids = [], titles = {};
  let pages = 0, pageToken = null, stopped = null, rawCount = 0;
  while (ids.length < maxVideos && pages < MAX_PAGES) {
    if (opts.budgetUnits !== undefined && opts.spentUnits + SEARCH_UNITS > opts.budgetUnits) { stopped = "quota"; break; }
    const url = `${opts.apiBase || apiBase()}/search?${qs({
      part: "snippet", type: "video", maxResults: PAGE, q: phrase, key: opts.apiKey,
      pageToken: pageToken || undefined, ...filters,
    })}`;
    const json = await getJson(url, opts);
    opts.spentUnits = (opts.spentUnits || 0) + SEARCH_UNITS; pages++;
    const items = json.items || [];
    for (const it of items) {
      const id = it.id && it.id.videoId;
      if (id && pushUnique(ids, seen, id, it.title)) titles[id] = (it.snippet || {}).title || null;
    }
    rawCount += items.length;
    pageToken = json.nextPageToken || null;
    if (!pageToken) break;
  }
  return { ids: ids.slice(0, maxVideos), titles, apiUnits: pages * SEARCH_UNITS, pages, rawCount, stopped, type: "search", resolvedQuery: phrase, filters: { ...filters } };
}

// --- źródło: --channel (upload playlist) -----------------------------------
async function resolveUploadsPlaylist(channel, opts) {
  let url;
  if (/^UC[\w-]{22}$/.test(channel)) url = `${opts.apiBase || apiBase()}/channels?${qs({ part: "contentDetails,snippet", id: channel, key: opts.apiKey })}`;
  else if (channel.startsWith("@")) url = `${opts.apiBase || apiBase()}/channels?${qs({ part: "contentDetails,snippet", forHandle: channel.slice(1), key: opts.apiKey })}`;
  else url = `${opts.apiBase || apiBase()}/channels?${qs({ part: "contentDetails,snippet", forUsername: channel, key: opts.apiKey })}`;
  const json = await getJson(url, opts);
  opts.spentUnits = (opts.spentUnits || 0) + CHANNEL_UNITS;
  const item = (json.items || [])[0];
  if (!item) { const e = new Error(`nie znalazlem kanalu: ${channel}`); e.http = true; throw e; }
  const uploads = ((item.contentDetails || {}).relatedPlaylists || {}).uploads;
  if (!uploads) { const e = new Error(`kanal ${channel} nie ma listy uploadow`); e.http = true; throw e; }
  return { uploads, title: (item.snippet || {}).title || null };
}

export async function discoverChannel(channel, maxVideos, opts = {}) {
  const ch = await resolveUploadsPlaylist(channel, opts);
  const r = await discoverPlaylist(ch.uploads, maxVideos, opts);
  r.type = "channel"; r.channel = channel; r.channelTitle = ch.title;
  return r;
}

// --- źródło: --playlist ----------------------------------------------------
export async function discoverPlaylist(playlistId, maxVideos, opts = {}) {
  const seen = new Set(), ids = [], titles = {};
  let pages = 0, pageToken = null, stopped = null, rawCount = 0;
  while (ids.length < maxVideos && pages < MAX_PAGES) {
    if (opts.budgetUnits !== undefined && opts.spentUnits + PLAYLIST_UNITS > opts.budgetUnits) { stopped = "quota"; break; }
    const url = `${opts.apiBase || apiBase()}/playlistItems?${qs({
      part: "snippet", maxResults: PAGE, playlistId, key: opts.apiKey, pageToken: pageToken || undefined,
    })}`;
    const json = await getJson(url, opts);
    opts.spentUnits = (opts.spentUnits || 0) + PLAYLIST_UNITS; pages++;
    const items = json.items || [];
    for (const it of items) {
      const id = ((it.snippet || {}).resourceId || {}).videoId;
      if (id && pushUnique(ids, seen, id, it.title)) titles[id] = (it.snippet || {}).title || null;
    }
    rawCount += items.length;
    pageToken = json.nextPageToken || null;
    if (!pageToken) break;
  }
  return { ids: ids.slice(0, maxVideos), titles, apiUnits: pages * PLAYLIST_UNITS, pages, rawCount, stopped, type: "playlist", playlistId };
}

// --- opcjonalny pre-filtr videos.list (contentDetails.caption) -------------
// --dry-run tego NIE robi: jego liczniki po filtrze sa szacunkiem (D8).
export async function captionPreFilter(ids, opts = {}) {
  const kept = [];
  let units = 0;
  for (let i = 0; i < ids.length; i += PAGE) {
    const chunk = ids.slice(i, i + PAGE);
    if (opts.budgetUnits !== undefined && opts.spentUnits + VIDEO_UNITS > opts.budgetUnits) return { ids: kept, apiUnits: units, stopped: "quota" };
    const url = `${opts.apiBase || apiBase()}/videos?${qs({ part: "contentDetails", id: chunk.join(","), key: opts.apiKey })}`;
    const json = await getJson(url, opts);
    opts.spentUnits = (opts.spentUnits || 0) + VIDEO_UNITS; units += VIDEO_UNITS;
    const withCaptions = new Set((json.items || []).filter((v) => ((v.contentDetails || {}).caption || "false") === "true").map((v) => v.id));
    for (const id of chunk) if (withCaptions.has(id)) kept.push(id);
  }
  return { ids: kept, apiUnits: units, stopped: null };
}

// --- wejście CLI -> jedno źródło ------------------------------------------
export function pickSource({ search, channel, playlist, ids }) {
  const used = [];
  if (search) used.push("--search");
  if (channel) used.push("--channel");
  if (playlist) used.push("--playlist");
  if (ids && ids.length) used.push("--ids-file/--id");
  if (used.length === 0) return { error: "brak zrodla: podaj jedno z --search / --channel / --playlist / --ids-file / --id" };
  if (used.length > 1) return { error: `dokladnie jedno zrodlo na joba (Goal 4) — podano: ${used.join(", ")}` };
  return { source: used[0] };
}

// Zamrażanie: uruchamia właściwe źródło, zwraca kandydatów + wpis `sources`.
export async function resolveCandidates(spec, opts = {}) {
  const { source } = pickSource(spec);
  const maxVideos = Number(opts.maxVideos || 0);
  if (source === "--search" && !opts.apiKey) {
    const e = new Error("źródło --search wymaga klucza YouTube Data API (D13). Ustaw YOUTUBE_API_KEY albo youtube.config.json/youtubeApiKey. Kanał, playlista i lista ID działają bez klucza.");
    e.exitCode = 5; throw e;
  }
  if ((source === "--channel" || source === "--playlist") && !maxVideos) {
    const e = new Error(`źródło ${source} jest nieograniczone — --max-videos jest wymagane (D8)`);
    e.exitCode = 1; throw e;
  }
  if (source === "--ids-file/--id") {
    // Deduplikacja po kanonicznym 11-znakowym ID (D8); złe ID nie wchodzą.
    const ids = [...new Set((spec.ids || []).filter(validVideoId))];
    return { candidates: ids, sources: [{ type: "ids", resolvedQuery: null, filters: {}, apiUnits: 0, ids, titleByVideo: {} }], apiUnits: 0 };
  }
  const o = { apiKey: opts.apiKey, apiBase: opts.apiBase, budgetUnits: opts.budgetUnits, spentUnits: 0, fetchJson: opts.fetchJson, timeoutMs: opts.timeoutMs };
  let r;
  if (source === "--search") r = await discoverSearch(spec.search, spec.filters || {}, Math.min(maxVideos || SEARCH_MAX_DEFAULT, SEARCH_MAX_DEFAULT), o);
  else if (source === "--channel") r = await discoverChannel(spec.channel, maxVideos, o);
  else r = await discoverPlaylist(spec.playlist, maxVideos, o);
  if (r.stopped === "quota") {
    const e = new Error(`budget jednostek API wyczerpany (${opts.budgetUnits}) — zatrzymuje sie, bez cichego przejścia na yt-dlp (D15)`);
    e.exitCode = 4; throw e;
  }
  const candidates = r.ids.slice();
  let apiUnits = r.apiUnits, extra = null;
  if (opts.captionPreFilter) {
    extra = await captionPreFilter(candidates, { ...o, spentUnits: apiUnits });
    apiUnits += extra.apiUnits;
    return { candidates: extra.ids, apiUnits, preFilter: { before: candidates.length, after: extra.ids.length, units: extra.apiUnits }, extra, sources: [sourceEntry(r, extra.ids, titlesFor(r))] };
  }
  return { candidates, apiUnits, preFilter: null, sources: [sourceEntry(r, candidates, r.titles || {})] };
}

function titlesFor(r) { return r.titles || {}; }

function sourceEntry(r, ids, titles) {
  const titleByVideo = {};
  for (const id of ids) if (titles[id]) titleByVideo[id] = titles[id];
  const entry = { type: r.type, apiUnits: r.apiUnits, ids: ids.slice(), titleByVideo };
  if (r.type === "search") { entry.resolvedQuery = r.resolvedQuery; entry.filters = r.filters; }
  if (r.type === "channel") entry.channel = r.channel;
  if (r.type === "playlist") entry.playlistId = r.playlistId;
  return entry;
}

export const UNITS = { SEARCH_UNITS, CHANNEL_UNITS, PLAYLIST_UNITS, VIDEO_UNITS };
