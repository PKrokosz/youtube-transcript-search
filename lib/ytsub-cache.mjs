// lib/ytsub-cache.mjs — magazyn treści transkryptów (D3, D4).
// Klucz: (videoId, language, manual|auto, parserVersion). Wartość: czysty tekst + sidecar.
// Ścieżki rozwiązywane względem katalogu modułu, nie CWD (D11/D3).
import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync, unlinkSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

export const PARSER_VERSION = 1;
export const MIN_CACHE_CHARS = 200;
export const DEFAULT_TMP_SWEEP_MS = 24 * 60 * 60 * 1000; // 24 h (D2: własny próg, nie TTL lease'a)

// Język kanonicalizowany przed kluczowaniem: pl-PL -> pl (D3).
export function canonLang(lang) {
  const s = String(lang || "").trim();
  if (!s) return "";
  return s.split("-")[0].toLowerCase();
}

export function resolveCacheDir(cacheDir) {
  return cacheDir ? cacheDir : join(MODULE_DIR, "..", ".cache");
}

export function cacheKey(videoId, lang, kind, parserVersion = PARSER_VERSION) {
  const k = kind === "manual" ? "manual" : "auto";
  return { videoId, lang: canonLang(lang), kind: k, parserVersion };
}

export function cachePaths(cacheDir, rec) {
  const dir = join(resolveCacheDir(cacheDir), "subs");
  const base = `${rec.videoId}.${rec.lang}.${rec.kind}.p${rec.parserVersion}`;
  return {
    base,
    text: join(dir, `${base}.txt`),
    meta: join(dir, `${base}.meta.json`),
    raw: join(dir, `${rec.videoId}.${rec.lang}.${rec.kind}.vtt`),
  };
}

// Zapis atomowy: tmp obok celu, potem rename. Zwraca false jeśli treść nie przechodzi walidacji.
export function putCache(cacheDir, rec, { text, raw, meta = {} }) {
  if (typeof text !== "string" || text.length < MIN_CACHE_CHARS) return false;
  const p = cachePaths(cacheDir, rec);
  mkdirSync(dirname(p.text), { recursive: true });
  const full = { videoId: rec.videoId, lang: rec.lang, kind: rec.kind, parserVersion: rec.parserVersion, chars: text.length, bytes: Buffer.byteLength(text, "utf8"), ...meta };
  atomicWrite(p.text, text);
  atomicWrite(p.meta, JSON.stringify(full, null, 2));
  if (typeof raw === "string" && raw.length) atomicWrite(p.raw, raw);
  return true;
}

// Odczyt + walidacja istnienia (D3: done wymaga poprawnego pliku cache).
export function getCache(cacheDir, rec) {
  const p = cachePaths(cacheDir, rec);
  if (!existsSync(p.text)) return null;
  let text;
  try { text = readFileSync(p.text, "utf8"); } catch { return null; }
  if (text.length < MIN_CACHE_CHARS) return null;
  let meta = null;
  try { meta = JSON.parse(readFileSync(p.meta, "utf8")); } catch { /* meta opcjonalne */ }
  return { text, meta, paths: p };
}

// Stan cache dla pary (videoId, język, rodzaj) — przestrzeń nazw oddzielna od D1 (D7).
// "ok" | "raw_missing" | "missing" (dla bieżącej wersji parsera).
export function cacheStatus(cacheDir, rec) {
  const hit = getCache(cacheDir, rec);
  if (!hit) return "missing";
  return readRaw(cacheDir, rec) ? "ok" : "raw_missing";
}

// Odczyt przez cache dla pojedynczego żądania (D7, fasada/MCP):
// pierwszy język w podanej kolejności, manual przed auto (D5).
// Trafienie dla bieżącego parsera -> "ok" / "raw_missing".
// Brak czystego tekstu, ale jest surowy VTT (starszy parser) -> "stale" (re-derive u wołającego).
// Nic -> "missing" (wołający pobiera z sieci).
export function lookupCacheForRequest(cacheDir, videoId, langs, opts = {}) {
  const order = String(langs || "").split(",").map((s) => canonLang(s)).filter(Boolean);
  const kinds = opts.captionPreference === "auto_first" ? ["auto", "manual"] : ["manual", "auto"];
  for (const lang of order) {
    for (const kind of kinds) {
      const rec = cacheKey(videoId, lang, kind);
      const hit = getCache(cacheDir, rec);
      if (hit) {
        const raw = readRaw(cacheDir, rec);
        return { rec, text: hit.text, raw, meta: hit.meta, cache: raw ? "ok" : "raw_missing" };
      }
      const raw = readRaw(cacheDir, rec);
      if (raw) return { rec, text: null, raw, meta: null, cache: "stale" };
    }
  }
  return { rec: null, text: null, raw: null, meta: null, cache: "missing" };
}

// configFingerprint (D4): dokładnie kolejność języków, preferencja napisów, wersja parsera.
// Słowa kluczowe, max-videos i tempo celowo wykluczone.
export function configFingerprint({ langs, captionPreference, parserVersion = PARSER_VERSION }) {
  const payload = JSON.stringify({
    langs: String(langs || "").split(",").map((s) => canonLang(s)).filter(Boolean),
    captionPreference: captionPreference === "auto_first" ? "auto_first" : "manual_first",
    parserVersion,
  });
  return "sha256:" + createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

function atomicWrite(target, content) {
  const tmp = `${target}.tmp`;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, target);
}

export function readRaw(cacheDir, rec) {
  const p = cachePaths(cacheDir, rec);
  if (!existsSync(p.raw)) return null;
  try { return readFileSync(p.raw, "utf8"); } catch { return null; }
}

export function removeCache(cacheDir, rec) {
  const p = cachePaths(cacheDir, rec);
  for (const f of [p.text, p.meta, p.raw]) {
    try { if (existsSync(f)) unlinkSync(f); } catch {}
  }
}

// Sweep osieroconych *.tmp (próg YTS_TMP_SWEEP_MS, domyślnie 24 h — nie TTL lease'a).
// Wołane raz na starcie joba; nigdy nie dotyka plików .txt/.vtt/.meta.json.
export function sweepTmp(cacheDir, jobDir, olderThanMs = DEFAULT_TMP_SWEEP_MS) {
  let removed = 0;
  const now = Date.now();
  const visit = (dir) => {
    if (!dir || !existsSync(dir)) return;
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      try {
        if (e.isDirectory()) {
          if (e.name === "node_modules" || e.name === ".git") continue;
          visit(p);
        } else if (e.name.endsWith(".tmp") && now - statSync(p).mtimeMs > olderThanMs) {
          unlinkSync(p);
          removed++;
        }
      } catch { /* plik zniknął w międzyczasie */ }
    }
  };
  const root = resolveCacheDir(cacheDir);
  visit(join(root, "subs"));
  visit(join(resolveJobDirSafe(jobDir), ".."));
  return removed;
}

// Lokalna kopia, żeby cache nie importował modułu joba (brak cyklu).
function resolveJobDirSafe(jobDir) {
  return jobDir ? jobDir : join(MODULE_DIR, "..", "jobs");
}
