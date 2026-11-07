#!/usr/bin/env node
// Narzędzie: wyszukiwanie filmów YouTube i przeszukiwanie ich transkrypcji.
//
// Używa yt-dlp (https://github.com/yt-dlp/yt-dlp) do:
//   1) znalezienia filmów po frazie (ytsearchN:)
//   2) pobrania napisów (auto-generated + manual) jako VTT
//   3) czyszczenia VTT do tekstu i wyszukania słów kluczowych z kontekstem
//
// Użycie CLI:
//   node youtube-transcripts.mjs --search "rust headless browser" --limit 5 --keywords rust,obscura
//   node youtube-transcripts.mjs --video dQw4w9WgXcQ --keywords never
//   node youtube-transcripts.mjs --url "https://www.youtube.com/watch?v=..." --keywords rust
//   node youtube-transcripts.mjs --video dQw4w9WgXcQ --raw          // pełny tekst transkrypcji

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { lookupCacheForRequest } from "./lib/ytsub-cache.mjs";
import { expectedFilenames } from "./lib/ytsub-ytdlp.mjs";

// Fasada re-eksportuje configFingerprint (D4): cztery nazwy wołane przez MCP
// plus ta piąta — load test sprawdza wszystkie pięć.
export { configFingerprint } from "./lib/ytsub-cache.mjs";

// --- konfiguracja ---------------------------------------------------------
// Kolejność: env > youtube.config.json (gitignored) > domyślne.
// Klucz API YouTube (dla search.list): YOUTUBE_API_KEY lub config.youtubeApiKey.
// Backend wyszukiwania:     YOUTUBE_SEARCH_BACKEND = "auto" (domyślnie) | "api" | "yt-dlp".
// Proxy/cookies/jobDir/cacheDir/intervalMs — tylko dla ścieżki joba (lib/ytsub-job.mjs).
export function loadConfig(strict = false) {
  const file = join(dirname(fileURLToPath(import.meta.url)), "youtube.config.json");
  let fileCfg = {};
  if (existsSync(file)) {
    try { fileCfg = JSON.parse(readFileSync(file, "utf8")) || {}; } catch (e) {
      // Błąd konfiguracji nigdy nie jest milczeniem: ścieżka pliku + treść błędu.
      const msg = `nieprawidłowy youtube.config.json: ${file} (${e && e.message})`;
      if (strict) throw new Error(msg);
      log(msg);
    }
  }
  const env = process.env;
  const cfg = {
    youtubeApiKey: env.YOUTUBE_API_KEY || fileCfg.youtubeApiKey || "",
    searchBackend: env.YOUTUBE_SEARCH_BACKEND || fileCfg.searchBackend || "auto",
    ytDlpPath: env.YT_DLP || fileCfg.ytDlpPath || "",
    tmp: env.TMP || fileCfg.tmp || "",
    proxy: env.YTS_PROXY || env.HTTPS_PROXY || env.ALL_PROXY || fileCfg.proxy || "",
    proxySource: env.YTS_PROXY ? "YTS_PROXY" : env.HTTPS_PROXY ? "HTTPS_PROXY" : env.ALL_PROXY ? "ALL_PROXY" : fileCfg.proxy ? "config" : "",
    allProxySource: env.ALL_PROXY ? "ALL_PROXY" : "",
    cookiesFile: env.YTS_COOKIES_FILE || fileCfg.cookiesFile || "",
    jobDir: env.YTS_JOB_DIR || fileCfg.jobDir || "",
    cacheDir: env.YTS_CACHE_DIR || fileCfg.cacheDir || "",
    intervalMs: Number(env.YTS_INTERVAL_MS || fileCfg.intervalMs || 4000) || 4000,
    rlStop: Number(env.YTS_RL_STOP || fileCfg.rlStop || 5) || 5,
  };
  const allowed = ["auto", "api", "yt-dlp"];
  if (!allowed.includes(cfg.searchBackend)) cfg.searchBackend = "auto";
  return cfg;
}

const CONFIG = loadConfig();

// Proste logi postępu — ZAWSZE na stderr (stdout w MCP to kanał JSON-RPC).
// Wyłącz: YTS_QUIET=1.
const QUIET = process.env.YTS_QUIET === "1";
function log(msg) {
  if (QUIET) return;
  const ts = new Date().toISOString().slice(11, 19);
  process.stderr.write(`[yts ${ts}] ${msg}\n`);
}

// Szukamy yt-dlp: najpierw config/env, potem PATH, potem typowe miejsca instalacji.
function findYtDlp() {
  if (CONFIG.ytDlpPath) return CONFIG.ytDlpPath;
  const isWin = process.platform === "win32";
  const name = isWin ? "yt-dlp.exe" : "yt-dlp";
  for (const dir of (process.env.PATH || "").split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, name);
    if (existsSync(p)) return p;
  }
  const home = process.env.USERPROFILE || process.env.HOME || "";
  if (home) {
    const candidates = isWin
      ? [join(home, ".local", "bin", name), join(home, "AppData", "Roaming", "Python", "Python314", "Scripts", name)]
      : [join(home, ".local", "bin", name), "/usr/local/bin/yt-dlp"];
    for (const p of candidates) if (existsSync(p)) return p;
  }
  return name; // ostatnia deska ratunku: szukamy w PATH przy starcie procesu
}

const YT_DLP = findYtDlp();

// Binarne rozwiązanie na żądanie: env YT_DLP może być przestawione w czasie
// działania (testy offline przełączają shima bez restartu procesu).
function ytDlpBin() {
  return process.env.YT_DLP || CONFIG.ytDlpPath || YT_DLP;
}

// Wrapper .cmd (shim testowy) wymaga shella; zwykla sciezka/exe - nie.
// Shim .mjs jest uruchamiany przez biezacy node (bez shella, bez ostrzezenia).
function isCmdShim(p) {
  return typeof p === "string" && /\.(cmd|bat)$/i.test(p);
}
function isJsShim(p) {
  return typeof p === "string" && /\.mjs$/i.test(p);
}
const TMP = CONFIG.tmp || tmpdir();

function run(args, opts = {}) {
  const timeoutMs = opts.timeoutMs || 180000;
  return new Promise((resolve) => {
    // Ścieżka joba może wstrzyknąć własne env (proxy przez dziedziczenie, nigdy przez argv).
    const childEnv = opts.env ? { ...process.env, ...opts.env } : undefined;
    const spawnOpts = { stdio: ["ignore", "pipe", "pipe"], windowsVerbatimArguments: isCmdShim(ytDlpBin()), shell: isCmdShim(ytDlpBin()), ...(childEnv ? { env: childEnv } : {}) };
    let cmd = ytDlpBin(), spawnArgs = args;
    if (isJsShim(cmd)) { spawnArgs = [cmd, ...args]; cmd = process.execPath; }
    const child = spawn(cmd, spawnArgs, spawnOpts);
    let out = "", err = "", done = false;
    let killed = false;
    const timer = setTimeout(() => { killed = true; try { child.kill(); } catch (e) {} }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => { if (done) return; done = true; clearTimeout(timer); resolve({ code: -1, out, err: String(e), timedOut: killed }); });
    child.on("close", (code) => { if (done) return; done = true; clearTimeout(timer); resolve({ code, out, err, timedOut: killed }); });
  });
}

function parseArgs(argv) {
  const a = { limit: 5, keywords: [], langs: "en", raw: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--search") a.search = argv[++i];
    else if (k === "--video") a.video = argv[++i];
    else if (k === "--url") a.url = argv[++i];
    else if (k === "--limit") a.limit = parseInt(argv[++i], 10) || 5;
    else if (k === "--keywords") a.keywords = String(argv[++i] || "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (k === "--langs") a.langs = argv[++i];
    else if (k === "--backend") a.backend = argv[++i];
    else if (k === "--raw") a.raw = true;
  }
  return a;
}

// --- wyszukiwanie filmów (ytsearch) -------------------------------------
export async function youtubeSearchYtDlp(query, limit = 5) {
  log(`  yt-dlp ytsearch${limit}: "${query}"`);
  const res = await run(["--flat-playlist", "--dump-json", "--no-warnings", `ytsearch${limit}:${query}`]);
  const items = [];
  for (const line of res.out.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const j = JSON.parse(line);
      if (j.id) items.push({ id: j.id, title: j.title || "", channel: j.channel || j.uploader || "", duration: j.duration || null });
    } catch (e) {}
  }
  return items;
}

// --- wyszukiwanie filmów przez YouTube Data API v3 (search.list) ----------
// Wymaga klucza API (key=...). Koszt: 100 jednostek quota na zapytanie
// (domyślnie 10 000/dzień => ~100 zapytań) + 1 jednostka za videos.list (duration).
const API_BASE = "https://www.googleapis.com/youtube/v3";

async function apiJson(url, timeoutMs = 30000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: "application/json" } });
    const body = await res.text();
    let json = null;
    try { json = JSON.parse(body); } catch (e) {}
    if (!res.ok || !json) {
      const errObj = json && json.error;
      const reason = (errObj && errObj.errors && errObj.errors.map((e) => e.reason).join(",")) || (errObj && errObj.message) || `HTTP ${res.status}`;
      const err = new Error(`youtube api ${reason}`);
      err.status = res.status;
      err.reason = reason;
      throw err;
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

// ISO 8601 (PT1H2M3S) -> sekundy
function isoDurationToSec(iso) {
  if (!iso || typeof iso !== "string") return null;
  const m = iso.match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/);
  if (!m) return null;
  const [, d, h, min, s] = m;
  return Number(d || 0) * 86400 + Number(h || 0) * 3600 + Number(min || 0) * 60 + Number(s || 0);
}

async function fillDurationsApi(items, key) {
  const ids = items.map((i) => i.id).filter(Boolean);
  let filled = 0;
  for (let p = 0; p < ids.length; p += 50) {
    const chunk = ids.slice(p, p + 50);
    const url = `${API_BASE}/videos?part=contentDetails&id=${encodeURIComponent(chunk.join(","))}&key=${encodeURIComponent(key)}`;
    const json = await apiJson(url);
    const map = {};
    for (const v of json.items || []) {
      map[v.id] = isoDurationToSec(v.contentDetails && v.contentDetails.duration);
    }
    for (const it of items) if (map[it.id] != null) it.duration = map[it.id];
    filled += Object.keys(map).length;
  }
  log(`  duration: videos.list -> ${filled}/${items.length} czasów`);
}

export async function youtubeSearchApi(query, limit = 5) {
  const key = CONFIG.youtubeApiKey;
  if (!key) throw new Error("brak klucza API (YOUTUBE_API_KEY)");
  const capped = Math.max(1, Math.min(limit, 50));
  const url = `${API_BASE}/search?part=snippet&q=${encodeURIComponent(query)}&type=video&maxResults=${capped}&order=relevance&key=${encodeURIComponent(key)}`;
  log(`search.list: query="${query}" maxResults=${capped}`);
  const json = await apiJson(url);
  const items = [];
  for (const i of json.items || []) {
    if (!i.id || i.id.kind !== "youtube#video" || !i.id.videoId) continue;
    const sn = i.snippet || {};
    const th = sn.thumbnails || {};
    items.push({
      id: i.id.videoId,
      title: sn.title || "",
      channel: sn.channelTitle || "",
      duration: null,
      publishedAt: sn.publishedAt || null,
      channelId: sn.channelId || null,
      thumbnail: (th.high && th.high.url) || (th.medium && th.medium.url) || (th.default && th.default.url) || null,
      description: (sn.description || "").slice(0, 500),
    });
  }
  log(`  wyniki: ${items.length} filmów (z ${json.pageInfo && json.pageInfo.totalResults} dopasowanych)`);
  try {
    await fillDurationsApi(items, key);
  } catch (e) {
    // duration to tylko wzbogacenie — nie przerywamy wyszukiwania
    log(`  duration niedostępny (${e.message}) — pomijam`);
  }
  return items;
}

// --- wybór backendu wyszukiwania -----------------------------------------
// Zwraca { backend, items }; backend = "api" | "yt-dlp".
export async function searchWithBackend(query, limit = 5, opts = {}) {
  const backend = opts.backend || CONFIG.searchBackend;
  if (backend !== "yt-dlp" && CONFIG.youtubeApiKey) {
    try {
      log(`krok 1/2 — wyszukiwanie: backend=api`);
      const items = await youtubeSearchApi(query, limit);
      return { backend: "api", items };
    } catch (e) {
      if (backend === "api") throw e; // twardy wybór API — bez fallbacku
      log(`YouTube Data API niedostępny (${e.message}) — fallback na yt-dlp`);
    }
  } else if (backend === "yt-dlp") {
    log(`krok 1/2 — wyszukiwanie: backend=yt-dlp (wymuszony)`);
  } else {
    log(`krok 1/2 — wyszukiwanie: backend=yt-dlp (brak klucza API)`);
  }
  const items = await youtubeSearchYtDlp(query, limit);
  log(`  wyniki: ${items.length} filmów (ytsearch)`);
  return { backend: "yt-dlp", items };
}

// Kompatybilność: stara nazwa i stary kształt wyniku.
export async function youtubeSearch(query, limit = 5) {
  return (await searchWithBackend(query, limit)).items;
}

// --- pobranie transkrypcji ----------------------------------------------
// videoTranscript(videoId, langs, opts?) — opts nieobowiązkowe; bez niego zachowanie
// jak do tej zmiany (3 próby, 4/8 s). opts = { retries, sleepMs, extraArgs, env, timeoutMs }.
export async function youtubeTranscript(videoId, langs = "en", opts = {}) {
  // D7 read-through przez cache: tylko gdy wołający podał cacheDir (ścieżka MCP).
  // Ścieżka CLI --search cache'u nie czyta i dostaje cache: null.
  const cacheRead = opts.cacheDir !== undefined
    ? lookupCacheForRequest(opts.cacheDir, videoId, langs, { captionPreference: opts.captionPreference })
    : null;
  if (cacheRead && (cacheRead.cache === "ok" || cacheRead.cache === "raw_missing" || (cacheRead.cache === "stale" && cacheRead.raw))) {
    const text = cacheRead.text !== null ? cacheRead.text : vttToText(cacheRead.raw);
    const segments = cacheRead.raw ? vttToSegments(cacheRead.raw) : [];
    log(`  ${videoId}: napisy z cache (${cacheRead.cache}, ${text.length} znaków)`);
    return { videoId, ok: true, lang: cacheRead.rec.lang, kind: cacheRead.rec.kind, text, segments, cache: cacheRead.cache, reason: null };
  }
  const dir = mkdtempSync(join(TMP, "ytsubs-"));
  const target = join(dir, `s.%(id)s.%(lang)s.%(ext)s`);
  const maxAttempts = opts.retries || 3;
  let lastErr = "";
  let lastCode = 0;
  let lastTimedOut = false;
  try {
    // YouTube rate-limituje (429) - próbujemy kilka razy z rosnącą przerwą.
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const args = [
        "--skip-download", "--write-subs", "--write-auto-subs",
        "--sub-langs", langs, "--sub-format", "vtt",
        "--no-warnings", "--no-playlist", "--retries", "3", "--sleep-requests", "2",
        ...(opts.extraArgs || []),
        "-o", target, `https://www.youtube.com/watch?v=${videoId}`,
      ];
      const res = await run(args, { env: opts.env, timeoutMs: opts.timeoutMs });
      lastCode = res.code; lastTimedOut = !!res.timedOut;
      // Nazwa zawiera %(lang)s; marker NA w nazwie oznacza napisy auto-generated.
      // Dokładnie wyliczona nazwa w kolejnosci --langs, nigdy skan katalogu (D3).
      const pick = expectedFilenames(videoId, langs).map((n) => join(dir, n)).find((p) => existsSync(p));
      if (pick) {
        const name = pick.split(/[\\/]/).pop();
        const raw = readFileSync(pick, "utf8");
        const parsed = { videoId, ok: true, lang: resolveLang(name, raw), kind: kindFromVtt(raw), text: vttToText(raw), segments: vttToSegments(raw) };
        log(`  ${videoId}: napisy OK (lang=${parsed.lang}, kind=${parsed.kind}, ${parsed.text.length} znaków)`);
        return { ...parsed, reason: null, cache: cacheRead ? cacheRead.cache : null };
      }
      lastErr = (res.err || "").split("\n").filter((l) => /ERROR/.test(l)).slice(-1)[0] || (res.code === 0 ? "" : `yt-dlp exit ${res.code}`);
      log(`  ${videoId}: brak napisów — próba ${attempt}/${maxAttempts} (${lastErr.slice(0, 120)})`);
      if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, attempt * (opts.sleepMs || 4000)));
    }
    return { videoId, ok: false, error: lastErr || "brak napisów (subs) dla tego filmu", reason: classifyFailure(lastErr, lastCode, lastTimedOut), text: "", segments: [], cache: cacheRead ? cacheRead.cache : null };
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  }
}

// Nazwa pliku napisow YouTube: s.<id>.NA.<lang>.vtt — marker NA stoi PRZED kodem
// jezyka i NIE rozstrzyga manual vs auto (yt-dlp pisze oba rodzaje pod te sama
// nazwe; sprawdzone na zywo 2026.11). Jezyk: ostatni segment przed .vtt,
// z naglowka Language: jako zapas.
function resolveLang(name, raw) {
  const parts = String(name).replace(/\.vtt$/i, "").split(".");
  const rest = parts[0] === "s" ? parts.slice(1) : parts;
  const last = rest.length ? rest[rest.length - 1] : "";
  if (last && last.toUpperCase() !== "NA") return last;
  const h = String(raw || "").match(/^\s*Language:\s*(\S+)/m);
  return h ? h[1] : "";
}
// Rodzaj napisow rozstrzyga zawartosc VTT: generowane automatycznie maja okno
// przewijania <c>...</c> i/lub align:start w linii czasu; manualne sa statyczne.
function kindFromVtt(raw) {
  const s = String(raw || "");
  return /<c>|<\/c>/.test(s) || /align:start|position:\d+%/.test(s) ? "auto" : "manual";
}

// Jedyne miejsce w kodzie, które interpretuje stderr yt-dlp. timeOut osobo,
// bo zabity proces nie zostawia linii ERROR.
export function classifyFailure(stderr, exitCode, timedOut = false) {
  if (timedOut) return "timeout";
  const line = String(stderr || "");
  if (/HTTP Error 429/.test(line)) return "rate_limited";
  if (/is not available|Video unavailable|private video|This video is private/i.test(line)) return "video_unavailable";
  if (/Sign in to confirm you're not a bot|confirm you.re not a bot|captcha/i.test(line)) return "bot_check";
  if (/Unable to connect to proxy|proxy|SOCKS|Tunnel connection failed/i.test(line)) return "proxy_error";
  if (/Unable to download video subtitles|no subtitles|has no subtitles/i.test(line)) return "no_subtitles";
  // yt-dlp z blew bez bledu i bez pliku: film nie ma napisow w zadanym jezyku.
  if (exitCode === 0 && !line.trim()) return "no_subtitles";
  return "unknown";
}

// --- parsowanie VTT (YouTube: auto-napisy toczące się okno tekstu) -------
function decodeEntities(s) {
  return s
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function parseCues(vtt) {
  const blocks = vtt.replace(/\r/g, "").split(/\n{2,}/);
  const cues = [];
  for (const b of blocks) {
    const lines = b.split("\n").map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    if (/^WEBVTT/i.test(lines[0]) || /^Kind:/i.test(lines[0]) || /^Language:/i.test(lines[0])) continue;
    const tsIdx = lines.findIndex((l) => /-->/.test(l));
    if (tsIdx === -1) continue;
    const m = lines[tsIdx].match(/^(\d\d:\d\d:\d\d\.\d+)\s+-->\s+(\d\d:\d\d:\d\d\.\d+)/);
    if (!m) continue;
    const text = decodeEntities(
      lines.slice(tsIdx + 1).join(" ").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim()
    );
    if (text) cues.push({ start: m[1], end: m[2], dur: durSec(m[1], m[2]), text });
  }
  return cues;
}

function durSec(a, b) {
  const p = (s) => s.split(":").reduce((acc, v) => acc * 60 + parseFloat(v), 0);
  return p(b) - p(a);
}

// Napisy auto-generowane YouTube składają się z:
//   - cue głównego (rolling window z tagami <c>…</c>)
//   - krótkich "snapshot" cue'ów (~10 ms) z czystą, aktualną linią
// Bierzemy snapshoty (brak duplikacji), a gdy ich nie ma - cue główne z deltą.
function dedupeCues(cues) {
  const snapshots = cues.filter((c) => c.dur <= 0.2);
  if (snapshots.length >= 2) {
    const out = [];
    let prev = "";
    for (const c of snapshots) {
      let delta = c.text;
      if (prev && delta.startsWith(prev)) delta = delta.slice(prev.length);
      delta = delta.trim();
      if (delta && (!out.length || out[out.length - 1].text !== delta)) out.push({ start: c.start, text: delta });
      prev = c.text;
    }
    return out;
  }
  const out = [];
  let prev = "";
  for (const c of cues) {
    let delta = c.text;
    if (prev) {
      if (delta.startsWith(prev)) delta = delta.slice(prev.length);
      else {
        const i = delta.indexOf(prev);
        if (i >= 0) delta = delta.slice(i + prev.length);
      }
    }
    delta = delta.trim();
    if (!delta) { prev = c.text; continue; }
    out.push({ start: c.start, text: delta });
    prev = c.text;
  }
  return out;
}

export function vttToText(vtt) {
  return dedupeCues(parseCues(vtt)).map((c) => c.text).join(" ").replace(/\s+/g, " ").trim();
}

export function vttToSegments(vtt) {
  return dedupeCues(parseCues(vtt));
}

// --- wyszukiwanie słów kluczowych w transkrypcji ------------------------
export function findKeywords(text, keywords, context = 120) {
  const hits = [];
  for (const kw of keywords) {
    const re = new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    let m, count = 0;
    const positions = [];
    while ((m = re.exec(text)) !== null) {
      count++;
      if (positions.length < 5) positions.push(m.index);
      if (m.index === re.lastIndex) re.lastIndex++;
    }
    hits.push({
      keyword: kw,
      count,
      contexts: positions.map((p) => text.slice(Math.max(0, p - context), p + context).trim()),
    });
  }
  return hits;
}

// --- pełny przepływ: wyszukaj -> transkrypcje -> słowa kluczowe -----------
export async function searchTranscripts(query, keywords, limit = 5, langs = "en", opts = {}) {
  log(`krok 0 — start: query="${query}" keywords=[${(keywords || []).join(", ")}] limit=${limit} langs=${langs}`);
  const { backend, items: videos } = await searchWithBackend(query, limit, opts);
  const out = [];
  for (let v = 0; v < videos.length; v++) {
    const vid = videos[v];
    log(`krok 2/${videos.length + 1} — napisy ${v + 1}/${videos.length}: ${vid.id}`);
    const t = await youtubeTranscript(vid.id, langs);
    const hits = t.ok ? findKeywords(t.text, keywords) : [];
    const totalHits = hits.reduce((sum, h) => sum + h.count, 0);
    out.push({
      id: vid.id,
      title: vid.title,
      channel: vid.channel,
      duration: vid.duration != null ? vid.duration : null,
      url: `https://www.youtube.com/watch?v=${vid.id}`,
      searchBackend: backend,
      transcriptAvailable: t.ok,
      transcriptError: t.ok ? undefined : t.error,
      reason: t.ok ? null : (t.reason || "unknown"),
      lang: t.ok ? (t.lang || null) : null,
      kind: t.ok ? (t.kind || null) : null,
      cache: t.cache ?? null,
      transcriptLength: t.text.length,
      keywords: hits,
    });
    log(`  ${vid.id}: ${t.ok ? "OK" : "BŁĄD: " + (t.reason || "unknown")} — trafienia: ${totalHits}`);
  }
  const okCount = out.filter((o) => o.transcriptAvailable).length;
  const byReason = out.filter((o) => !o.transcriptAvailable).reduce((acc, o) => { acc[o.reason] = (acc[o.reason] || 0) + 1; return acc; }, {});
  log(`krok ${videos.length + 2} — koniec: kandydaci=${out.length}, z napisami=${okCount}, bez napisów=${JSON.stringify(byReason)}, backend=${backend}`);
  return out;
}

// --- CLI ------------------------------------------------------------------
if (process.argv[1] && process.argv[1].endsWith("youtube-transcripts.mjs")) {
  const a = parseArgs(process.argv.slice(2));
  if (a.video || a.url) {
    const id = a.video || (a.url.match(/[?&]v=([\w-]+)/) || [])[1];
    const t = await youtubeTranscript(id, a.langs);
    if (!t.ok) { console.error("BŁĄD:", t.error); process.exit(2); }
    if (a.raw) { console.log(t.text); process.exit(0); }
    console.log(JSON.stringify({ videoId: id, length: t.text.length, keywords: findKeywords(t.text, a.keywords), text: t.text.slice(0, 4000) }, null, 2));
    process.exit(0);
  }
  if (a.search) {
    const res = await searchTranscripts(a.search, a.keywords, a.limit, a.langs, a.backend ? { backend: a.backend } : {});
    const okCount = res.filter((r) => r.transcriptAvailable).length;
    const byReason = res.filter((r) => !r.transcriptAvailable).reduce((acc, r) => { acc[r.reason] = (acc[r.reason] || 0) + 1; return acc; }, {});
    process.stderr.write(`[yts] podsumowanie: kandydaci=${res.length}, z napisami=${okCount}, bez napisów=${JSON.stringify(byReason)}\n`);
    console.log(JSON.stringify(res, null, 2));
    process.exit(0);
  }
  console.error("Użycie: --search <fraza> | --video <id> | --url <link>  (opcjonalnie --keywords a,b --limit N --backend api|yt-dlp --raw)");
  process.exit(1);
}