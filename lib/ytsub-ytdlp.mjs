// lib/ytsub-ytdlp.mjs — granica z binarnym yt-dlp (D6, D5, część D1).
// Jedyne miejsce, przez które ścieżka joba uruchamia yt-dlp i czyta jego stderr.
//
// Ustalenia z weryfikacji na żywo (yt-dlp 2026.10.26, November 2026):
//   - yt-dlp pisze napisy YouTube do `s.%(id)s.NA.%(lang)s.%(ext)s`, czyli dla
//     manual ORAZ auto w to samo miejsce. Marker NA NIE rozstrzyga manual vs auto.
//   - dlatego D5 ("manual przed auto") wymaga wcześniejszego listingu ścieżek
//     (`--print-json`), a potem jednego pobrania z jedną flagą
//     (`--write-subs --no-write-auto-subs` albo `--write-auto-subs --no-write-subs`).
//   - rodzaj napisów rozstrzyga zawartość VTT: auto ma okno przewijania `<c>…</c>`
//     (i/lub `align:start` w linii czasu), manualne — nie.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { join, delimiter } from "node:path";
import { tmpdir } from "node:os";

// --- odkrycie binarnego (jak findYtDlp w rdzeniu) --------------------------
export function findYtDlp(explicitPath) {
  if (explicitPath && existsSync(explicitPath)) return explicitPath;
  const isWin = process.platform === "win32";
  const name = isWin ? "yt-dlp.exe" : "yt-dlp";
  for (const dir of (process.env.PATH || "").split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, name);
    if (existsSync(p)) return p;
  }
  const home = process.env.USERPROFILE || process.env.HOME || "";
  if (home) {
    const cands = isWin
      ? [join(home, ".local", "bin", name), join(home, "AppData", "Roaming", "Python", "Python314", "Scripts", name)]
      : [join(home, ".local", "bin", name), "/usr/local/bin/yt-dlp"];
    for (const p of cands) if (existsSync(p)) return p;
  }
  return name;
}

export async function ytDlpVersion(ytDlpPath) {
  const r = await run(ytDlpPath, ["--version"], { timeoutMs: 20000 });
  return r.code === 0 ? r.out.trim() : "";
}

// --- środowisko dziecka (D6) ------------------------------------------------
// Proxy DOCIERA do dziecka zmienną, którą yt-dlp czyta — niezależnie od źródła
// wartości (env YTS_PROXY/HTTPS_PROXY/ALL_PROXY albo plik config).
export function childEnv(cfg) {
  if (!cfg || !cfg.proxy) return undefined;
  const env = { ...(cfg.allProxySource === "ALL_PROXY" ? { ALL_PROXY: cfg.proxy } : {}), HTTPS_PROXY: cfg.proxy };
  return env;
}

// --- lista ścieżek napisów (D5) --------------------------------------------
// Jeden proces, zero pobierania napisów. Zwraca kody języków z `subtitles`
// (manual) i `automatic_captions` (auto), zanonimizowane do postaci kanonicznej.
export async function listTracks(ytDlpPath, videoId, opts = {}) {
  const r = await run(ytDlpPath, ["--skip-download", "--print-json", `https://www.youtube.com/watch?v=${videoId}`], { timeoutMs: opts.timeoutMs || 90000 });
  if (r.code !== 0 || !r.out) return { manual: [], auto: [], failed: true, err: r.err, code: r.code, timedOut: !!r.timedOut };
  let json = null;
  try {
    const line = r.out.split(/\r?\n/).find((l) => l.trim().startsWith("{"));
    json = JSON.parse(line || "{}");
  } catch { return { manual: [], auto: [], failed: true, err: r.err, code: r.code, timedOut: false }; }
  if (!json || typeof json !== "object") return { manual: [], auto: [], failed: true, err: r.err, code: r.code, timedOut: false };
  // klucz `-orig` = auto oryginalnego języka; kanonizujemy do kodu języka.
  const canonKeys = (obj) => Object.keys(obj || {}).map((k) => k.replace(/-orig$/, ""));
  return {
    manual: [...new Set(canonKeys(json.subtitles))],
    auto: [...new Set(canonKeys(json.automatic_captions))],
    duration: json.duration ?? null,
    failed: false,
  };
}

// D5: pierwszy język z --langs, który ma ścieżkę; manual przed auto w tym języku.
// D5: pierwszy jezyk z --langs, który ma ścieżkę; manual przed auto w tym języku.
// Kody ścieżek kanonizujemy tutaj też (pl-PL -> pl), żeby wołający mógł podać
// surowe klucze z yt-dlp (w tym z przyrostkiem -orig).
export function resolveTrack(tracks, langs) {
  const order = String(langs || "").split(",").map((s) => canon(s)).filter(Boolean);
  const has = (list, lang) => (list || []).map((k) => canon(k)).includes(lang);
  for (const lang of order) {
    if (has(tracks.manual, lang)) return { lang, kind: "manual" };
    if (has(tracks.auto, lang)) return { lang, kind: "auto" };
  }
  return null;
}

function canon(lang) {
  const s = String(lang || "").trim();
  return s ? s.split("-")[0].toLowerCase() : "";
}

// --- argumenty pobierania DOKŁADNIE jednego napisu (D5) --------------------
export function buildArgs({ videoId, lang, kind, outDir, extraArgs = [], cookiesFile = "" }) {
  const pick = kind === "manual"
    ? ["--write-subs", "--no-write-auto-subs"]
    : ["--write-auto-subs", "--no-write-subs"];
  return [
    "--skip-download", ...pick,
    "--sub-langs", lang,
    "--sub-format", "vtt",
    "--no-warnings", "--no-playlist", "--retries", "0",
    ...(cookiesFile ? ["--cookies-file", cookiesFile] : []),
    ...extraArgs,
    "-o", join(outDir, "s.%(id)s.NA.%(lang)s.%(ext)s"),
    `https://www.youtube.com/watch?v=${videoId}`,
  ];
}

// Wyliczone nazwy plików — dokładnie te są czytane, nigdy skan katalogu (D3).
export function expectedFilenames(videoId, langs) {
  const list = String(langs || "").split(",").map((s) => s.trim()).filter(Boolean);
  const langs2 = list.length ? list : ["en"];
  const names = [];
  for (const l of langs2) {
    names.push(`s.${videoId}.NA.${l}.vtt`);
    names.push(`s.${videoId}.${l}.vtt`);
  }
  return names;
}

// Język z nazwy: s.<id>.NA.<lang>.vtt albo s.<id>.<lang>.vtt.
export function langFromFilename(name) {
  const parts = String(name || "").replace(/\.vtt$/i, "").split(".");
  const rest = parts[0] === "s" ? parts.slice(1) : parts;
  if (!rest.length) return "";
  const last = rest[rest.length - 1];
  return last.toLowerCase() === "na" ? "" : last;
}

// Rodzaj napisów z zawartości VTT: okno przewijania `<c>…</c>` i/lub `align:start`
// w linii czasu oznaczają napisy auto-generated; manualne ich nie mają.
export function kindFromVtt(raw) {
  const s = String(raw || "");
  if (/<c>|<\/c>/.test(s)) return "auto";
  if (/align:start|position:\d+%/.test(s)) return "auto";
  return "manual";
}

export async function fetchSubtitleFile(ytDlpPath, args, opts = {}) {
  const spawnOpts = { env: opts.env ? { ...process.env, ...opts.env } : undefined, timeoutMs: opts.timeoutMs || 180000, shell: /\.(cmd|bat)$/i.test(String(ytDlpPath)) };
  return run(ytDlpPath, args, spawnOpts);
}

// Tymczasowy katalog na pobierany plik (bierze też udział w sweepie .tmp).
export function tempIncomingDir(videoId) {
  return mkdtempSync(join(tmpdir(), `yts-incoming-${videoId}-`));
}

function run(cmd, args, opts = {}) {
  const timeoutMs = opts.timeoutMs || 180000;
  const shell = !!opts.shell;
  return new Promise((resolve) => {
    let bin = cmd, spawnArgs = args;
    if (/\.mjs$/i.test(String(cmd))) { spawnArgs = [cmd, ...args]; bin = process.execPath; }
    const child = spawn(bin, spawnArgs, { stdio: ["ignore", "pipe", "pipe"], shell, windowsVerbatimArguments: shell, ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}) });
    let out = "", err = "", done = false, killed = false;
    const timer = setTimeout(() => { killed = true; try { child.kill(); } catch {} }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => { if (done) return; done = true; clearTimeout(timer); resolve({ code: -1, out, err: String(e), timedOut: killed }); });
    child.on("close", (code) => { if (done) return; done = true; clearTimeout(timer); resolve({ code, out, err, timedOut: killed }); });
  });
}
