#!/usr/bin/env node
// yts-job.mjs — batch CLI napisów YouTube.
// Etap 1: źródło „lista ID", polityka D1/D2/D10, raport, repair, stop.
// Etap 2: cztery źródła (--search/--channel/--playlist/--ids-file), filtry,
//         budget jednostek API, --dry-run, doctor.
// Kontrakt: stdout jest czytelny dla maszyn — postęp i podsumowania na stderr.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadConfig } from "./youtube-transcripts.mjs";
import {
  createJob, loadState, saveState, runJob, repair, buildReport, writeReportFile, reportSummary,
  resolveJobDir, validVideoId, stopJob, JobError,
} from "./lib/ytsub-job.mjs";
import { findYtDlp, ytDlpVersion } from "./lib/ytsub-ytdlp.mjs";
import { parseFilters, pickSource, resolveCandidates, FILTER_KEYS, SEARCH_MAX_DEFAULT } from "./lib/ytsub-discover.mjs";

const USAGE = `yts-job — batch napisow YouTube

  yts-job new <zrodlo> --langs pl,en --keywords a,b [opcje]
  yts-job resume <jobId> [--refresh|--retry-stopped|--require-same-version|--keywords a,b]
  yts-job status <jobId>
  yts-job stop <jobId>
  yts-job report <jobId> [--keywords a,b]
  yts-job repair <jobId>
  yts-job doctor

Zrodla (dokladnie jedno na joba — Goal 4):
  --search <fraza>             wymaga YOUTUBE_API_KEY (D13), bez cichego fallbacku
  --channel <id|@handle|nazwa> uploads, wymaga --max-videos
  --playlist <id>              kolejnosc playlisty, wymaga --max-videos
  --ids-file <path>            nowe linie lub przecinki, albo --id <11 znakow>

Wymagane (new):
  --langs pl,en     kolejnosc jezykow, bez domyslnej (D5)
  --keywords a,b    slowa kluczowe (po przecinku)

Opcje:
  --job <jobId>            nazwa joba (domyslnie job-<czas>)
  --job-dir <path>         katalog stanu (domyslnie <katalog skryptu>/jobs)
  --cache-dir <path>       katalog cache (domyslnie <katalog skryptu>/.cache)
  --interval-ms <n>        odstep miedzy filmami (domyslnie 4000)
  --rl-stop <n>            stop po N kolejnych 429 (domyslnie 5)
  --max-videos <n>         wymagane dla --channel/--playlist; dla --search
                           domyslnie 100 i maksimum 100 (D8)
  --budget-units <n>       budget jednostek YouTube Data API (domyslnie 2000)
  --caption-prefilter      odejmij filmy bez napisow przez videos.list (D8)
  --filter key=value       filtry, powtarzalne: ${FILTER_KEYS.join(", ")}
  --cookies-file <path>    sciezka do cookies (nigdy zawartosc) — domyslnie
                           <home>/.config/yts/cookies.txt, jesli istnieje
  --dry-run                (new tylko) rozwiaz zrodlo bez pobran i bez state.json
  --refresh                (resume) ponow done+stale, nie failed (D10)
  --retry-stopped          (resume) ponow tylko failed: bot_check/proxy_error (D10)
  --require-same-version   (resume) zmieniona wersja yt-dlp -> rekord stale

Proxy NIGDY nie idzie przez flage (D6): YTS_PROXY, HTTPS_PROXY albo ALL_PROXY.

Kody wyjscia: 0 zakonczono, 1 blad uzytku, 3 stop po 429/bot-check,
4 infra (proxy, yt-dlp, stan, lease, quota API), 5 problem konfiguracji/klucza.
`;

const FLAGS = {
  new: ["ids-file", "id", "search", "channel", "playlist", "langs", "keywords", "job", "job-dir", "cache-dir", "interval-ms", "rl-stop", "max-videos", "budget-units", "caption-prefilter", "filter", "cookies-file", "dry-run", "help"],
  resume: ["refresh", "retry-stopped", "require-same-version", "langs", "keywords", "job-dir", "cache-dir", "interval-ms", "rl-stop", "cookies-file", "help"],
  status: ["job-dir", "cache-dir", "help"],
  stop: ["job-dir", "help"],
  report: ["job-dir", "cache-dir", "keywords", "help"],
  repair: ["job-dir", "cache-dir", "help"],
  doctor: ["help"],
};
const BOOLEAN_FLAGS = ["refresh", "retry-stopped", "require-same-version", "dry-run", "caption-prefilter", "help"];
const REPEATED_FLAGS = ["filter"];

function parseArgs(cmd, argv) {
  const allowed = FLAGS[cmd] || [];
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith("--")) { a._.push(k); continue; }
    const name = k.slice(2);
    if (!allowed.includes(name)) errUsage(`nieznana flaga: ${k}${allowed.length ? ` (dozwolone: ${allowed.join(", ")})` : ""}`);
    if (BOOLEAN_FLAGS.includes(name)) { a[name] = true; continue; }
    if (REPEATED_FLAGS.includes(name)) { (a[name] = a[name] || []).push(argv[++i]); continue; }
    a[name] = argv[++i];
  }
  return a;
}

function errUsage(msg) {
  process.stderr.write(`[yts-job] ${msg}\n${USAGE}\n`);
  process.exit(1);
}

function log(m) { if (process.env.YTS_QUIET !== "1") process.stderr.write(`[yts-job] ${m}\n`); }
function fail(e, fallback = 4) {
  process.stderr.write(`[yts-job] ${e && e.message}\n`);
  process.exit(e instanceof JobError ? e.code : (e && e.exitCode) || fallback);
}

async function loadCfg(strict) {
  try { return loadConfig(strict); }
  catch (e) { process.stderr.write(`[yts-job] ${e && e.message}\n`); process.exit(5); }
}

function defaultCookiesFile(cfg) {
  if (cfg.cookiesFile) return cfg.cookiesFile;
  const p = join(homedir(), ".config", "yts", "cookies.txt");
  return p;
}

function num(v, dflt) { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : dflt; }

function collectIds(a) {
  const ids = [];
  if (a["ids-file"]) {
    if (!existsSync(a["ids-file"])) errUsage(`plik nie istnieje: ${a["ids-file"]}`);
    for (const piece of readFileSync(a["ids-file"], "utf8").split(/[\s,]+/)) {
      const s = piece.trim();
      if (s) ids.push(s);
    }
  }
  if (a.id) ids.push(a.id);
  return [...new Set(ids)];
}

function maskProxy(value) {
  if (!value) return null;
  return String(value).replace(/\/\/([^:@/]+):([^@/]*)@/, "//$1:***@");
}

// doctor: kazde ustawienie z zrodla, skad wzielo wartosc (D6/D8).
function doctor(cfg, jobDir) {
  const ytDlpPath = process.env.YT_DLP || cfg.ytDlpPath || findYtDlp();
  const out = {
    ytDlpPath: { value: ytDlpPath, origin: process.env.YT_DLP ? "YT_DLP" : cfg.ytDlpPath ? "config.ytDlpPath" : (process.platform === "win32" ? "PATH albo ~/.local/bin" : "PATH albo ~/.local/bin") },
    ytDlpVersion: { value: null, origin: "jeden pomiar na proces (yt-dlp --version)" },
    youtubeApiKey: { present: !!cfg.youtubeApiKey, origin: cfg.youtubeApiKey ? (process.env.YOUTUBE_API_KEY ? "YOUTUBE_API_KEY" : "config.youtubeApiKey") : "nie ustawiony" },
    searchBackend: { value: cfg.searchBackend, origin: process.env.YOUTUBE_SEARCH_BACKEND ? "YOUTUBE_SEARCH_BACKEND" : cfg.searchBackend ? "config" : "domyslny (auto)" },
    proxy: { present: !!cfg.proxy, masked: maskProxy(cfg.proxy), origin: cfg.proxySource || "nie ustawiony", allProxySource: cfg.allProxySource || null },
    cookiesFile: { value: defaultCookiesFile(cfg) || null, origin: process.env.YTS_COOKIES_FILE ? "YTS_COOKIES_FILE" : cfg.cookiesFile ? "config.cookiesFile" : "domyslny <home>/.config/yts/cookies.txt" },
    jobDir: { value: resolveJobDir(jobDir), origin: jobDirArgOrigin(jobDir) },
    cacheDir: { value: cfg.cacheDir || "<katalog skryptu>/.cache", origin: process.env.YTS_CACHE_DIR ? "YTS_CACHE_DIR" : cfg.cacheDir ? "config.cacheDir" : "domyslny" },
    intervalMs: { value: num(process.env.YTS_INTERVAL_MS || cfg.intervalMs || 4000, 4000), origin: process.env.YTS_INTERVAL_MS ? "YTS_INTERVAL_MS" : cfg.intervalMs ? "config.intervalMs" : "domyslny 4000 (placeholder etapu 1)" },
    caps: { youtube_search: 25, youtube_transcript_search: 15, note: "nad limitem odmowa, nie ciche obciecie (D7)" },
    sources: ["--search (wymaga klucza)", "--channel", "--playlist", "--ids-file/--id"],
    filterKeys: FILTER_KEYS,
    searchMaxDefault: SEARCH_MAX_DEFAULT,
    units: { search: 100, channels: 1, playlistItems: 1, videosList: 1 },
    proxyInArgvForbidden: true,
  };
  return out;
}

function jobDirArgOrigin(jobDir) {
  return process.env.YTS_JOB_DIR && jobDir === process.env.YTS_JOB_DIR ? "YTS_JOB_DIR" : jobDir ? "--job-dir" : "domyslny <katalog skryptu>/jobs";
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd || cmd === "help") { process.stdout.write(USAGE); process.exit(0); }
  const a = parseArgs(cmd, argv.slice(1));
  if (a.help) { process.stdout.write(USAGE); process.exit(0); }
  const jobDir = a["job-dir"] || undefined, cacheDir = a["cache-dir"] || undefined;

  if (cmd === "doctor") {
    const cfg = await loadCfg(false);
    process.stdout.write(JSON.stringify(doctor(cfg), null, 2) + "\n");
    process.exit(0);
  }

  if (cmd === "new") {
    if (a.proxy) errUsage("--proxy w linii komend jest zabroniony (D6). Uzyj YTS_PROXY, HTTPS_PROXY albo ALL_PROXY.");
    const cfg = await loadCfg(true);
    if (!a.langs) errUsage("--langs jest wymagane (D5: bez domyslnej wartosci)");
    if (!a.keywords) errUsage("--keywords jest wymagane");
    const { filters, errors } = parseFilters(a.filter || []);
    if (errors.length) errUsage(errors.join("; "));
    const ids = (a["ids-file"] || a.id) ? collectIds(a) : [];
    if (!ids.length && (a["ids-file"] || a.id)) errUsage("plik z ID jest pusty");
    const bad = ids.find((x) => !validVideoId(x));
    if (bad) errUsage(`nieprawidlowe ID (11 znakow [A-Za-z0-9_-]): ${bad}`);
    const pick = pickSource({ search: a.search, channel: a.channel, playlist: a.playlist, ids });
    if (pick.error) errUsage(pick.error);
    const maxVideos = num(a["max-videos"], 0);
    const budgetUnits = num(a["budget-units"], 2000);
    const keywords = String(a.keywords).split(",").map((s) => s.trim()).filter(Boolean);

    // --- dry-run: rozwiazanie zrodla, zero pobran, zero state.json ----------
    let resolved;
    try {
      resolved = await resolveCandidates({ search: a.search, channel: a.channel, playlist: a.playlist, ids, filters }, {
        apiKey: cfg.youtubeApiKey, apiBase: process.env.YTS_API_BASE, maxVideos, budgetUnits,
        captionPreFilter: !!a["caption-prefilter"], fetchJson: process.env.YTS_API_BASE ? undefined : undefined,
      });
    } catch (e) { fail(e, 4); }
    const src = (resolved.sources || [])[0] || {};
    if (a["dry-run"]) {
      const lines = [];
      lines.push(`zrodlo=${src.type || "ids"}${src.resolvedQuery ? ` "${src.resolvedQuery}"` : ""}${src.channel ? ` ${src.channel}` : ""}${src.playlistId ? ` ${src.playlistId}` : ""}`);
      if (Object.keys(src.filters || {}).length) lines.push(`filtry=${JSON.stringify(src.filters)}`);
      lines.push(`kandydaci=${resolved.candidates.length} (max-videos=${maxVideos || (src.type === "search" ? SEARCH_MAX_DEFAULT : "n/a")})`);
      lines.push(`jednostki API=${resolved.apiUnits} (budget ${budgetUnits})`);
      if (resolved.preFilter) lines.push(`pre-filtr napisow: ${resolved.preFilter.before} -> ${resolved.preFilter.after} (${resolved.preFilter.units} jednostek)`);
      else lines.push(`pre-filtr napisow nie byl wywolany — licznik po filtrze jest szacunkiem (D8)`);
      process.stderr.write(`[yts-job] dry-run: ${lines.join(" | ")}\n`);
      process.stderr.write(`[yts-job] dry-run: zadne pobranie napisow, zadne videos.list, zadne yt-dlp, brak state.json\n`);
      process.stdout.write(JSON.stringify({ dryRun: true, source: src.type, candidates: resolved.candidates.length, apiUnits: resolved.apiUnits, ids: resolved.candidates }, null, 2) + "\n");
      process.exit(0);
    }

    const jobId = a.job || `job-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    if (existsSync(join(resolveJobDir(jobDir), jobId, "state.json"))) errUsage(`job ${jobId} juz istnieje — uzyj resume albo innej nazwy`);
    createJob({
      jobId, langs: a.langs, captionPreference: "manual_first", keywords,
      quotaBudget: budgetUnits, jobDir, cacheDir,
      candidateIds: resolved.candidates, sources: resolved.sources,
      pacing: { intervalMs: num(a["interval-ms"], cfg.intervalMs || 4000), rlStop: num(a["rl-stop"], 5) },
    });
    log(`utworzono job ${jobId} — ${resolved.candidates.length} kandydatow, jednostki API=${resolved.apiUnits}`);
    const ytDlpPath = process.env.YT_DLP || cfg.ytDlpPath || findYtDlp();
    const versionProbe = process.env.YTS_SKIP_PROBE ? "" : await ytDlpVersion(ytDlpPath);
    let result;
    try {
      result = await runJob(jobId, {
        langs: a.langs, ytdlpPath: ytDlpPath, jobDir, cacheDir,
        intervalMs: num(a["interval-ms"], cfg.intervalMs || 4000), rlStop: num(a["rl-stop"], cfg.rlStop || 5),
        proxy: cfg.proxy, allProxySource: cfg.allProxySource,
        cookiesFile: defaultCookiesFile(cfg) || "",
        versionProbe,
      });
    } catch (e) { fail(e); }
    const { stopped, report } = result;
    process.stderr.write(`[yts-job] ${report.finished && !stopped ? "zakonczono" : "przerwano"}: ${reportSummary(report)}\n`);
    if (stopped && stopped.reason !== "user_stop") {
      const remedy = stopped.reason === "rate_limited" ? "poczekaj na spadek limitu" : stopped.reason === "bot_check" ? "ustaw YTS_COOKIES_FILE albo proxy, potem --retry-stopped" : "sprawdz proxy, potem --retry-stopped";
      process.stderr.write(`[yts-job] przyczyna: ${stopped.reason} przy ${stopped.videoId} — ${remedy}\n`);
    }
    process.exit(stopped ? stopped.exitCode : 0);
  }

  if (cmd === "resume") {
    if (a.proxy) errUsage("--proxy w linii komend jest zabroniony (D6).");
    if (a["ids-file"] || a.id || a.search || a.channel || a.playlist) errUsage("resume uzywa zamrozonego zbioru z state.json (Goal 4); nie podawaj zrodela");
    if (a.refresh && a["retry-stopped"]) errUsage("--refresh i --retry-stopped to rozne rzeczy (D10) — pojedynczo");
    const cfg = await loadCfg(false);
    const jobId = a._[0];
    if (!jobId) errUsage("podaj jobId: yts-job resume <jobId>");
    let langs = a.langs || undefined;
    if (!langs) {
      try { langs = loadState(jobDir, jobId).state.langOrder.join(","); }
      catch (e) { fail(e); }
    } else {
      try {
        const { state, path } = loadState(jobDir, jobId);
        const next = String(a.langs).split(",").map((s) => s.trim()).filter(Boolean);
        if (next.join(",") !== state.langOrder.join(",")) log(`--langs zmienilo kolejnosc (${state.langOrder.join(",")} -> ${next.join(",")}): rekordy done stana sie stale (D4)`);
      } catch (e) { fail(e); }
    }
    if (a.keywords) {
      try {
        const { state, path } = loadState(jobDir, jobId);
        state.keywords = String(a.keywords).split(",").map((s) => s.trim()).filter(Boolean);
        saveState(path, state);
        log(`keywords zaktualizowane: ${state.keywords.join(",")}`);
      } catch (e) { fail(e); }
    }
    const ytDlpPath = process.env.YT_DLP || cfg.ytDlpPath || findYtDlp();
    const versionProbe = process.env.YTS_SKIP_PROBE ? "" : await ytDlpVersion(ytDlpPath);
    let result;
    try {
      result = await runJob(jobId, {
        langs, ytdlpPath: ytDlpPath, jobDir, cacheDir,
        intervalMs: num(a["interval-ms"], cfg.intervalMs || 4000), rlStop: num(a["rl-stop"], cfg.rlStop || 5),
        proxy: cfg.proxy, allProxySource: cfg.allProxySource,
        cookiesFile: defaultCookiesFile(cfg) || "",
        refresh: !!a.refresh, retryStopped: !!a["retry-stopped"], requireSameVersion: !!a["require-same-version"],
        versionProbe,
      });
    } catch (e) { fail(e); }
    const { stopped, report } = result;
    process.stderr.write(`[yts-job] ${report.finished && !stopped ? "zakonczono" : "przerwano"}: ${reportSummary(report)}\n`);
    if (stopped && stopped.reason !== "user_stop") {
      const remedy = stopped.reason === "rate_limited" ? "poczekaj na spadek limitu" : stopped.reason === "bot_check" ? "ustaw YTS_COOKIES_FILE albo proxy, potem --retry-stopped" : "sprawdz proxy, potem --retry-stopped";
      process.stderr.write(`[yts-job] przyczyna: ${stopped.reason} przy ${stopped.videoId} — ${remedy}\n`);
    }
    process.exit(stopped ? stopped.exitCode : 0);
  }

  if (cmd === "status") {
    const id = a._[0];
    if (!id) errUsage("podaj jobId: yts-job status <jobId>");
    let state;
    try { state = loadState(jobDir, id).state; } catch (e) { fail(e); }
    const byReason = {};
    for (const v of Object.values(state.videos)) if (v.status === "failed") byReason[v.reason] = (byReason[v.reason] || 0) + 1;
    const frozen = state.candidates || [];
    const pending = frozen.filter((vid) => (state.videos[vid]?.status || "pending") === "pending").length;
    process.stdout.write(JSON.stringify({
      jobId: state.jobId, finished: state.finished, stopped: state.stopped || null,
      candidates: frozen.length,
      done: Object.values(state.videos).filter((v) => v.status === "done").length,
      failed: Object.values(state.videos).filter((v) => v.status === "failed").length,
      stale: Object.values(state.videos).filter((v) => v.status === "stale").length,
      pending, failedByReason: byReason, quota: state.quota,
      langOrder: state.langOrder,
      sources: (state.sources || []).map((s) => ({ type: s.type, apiUnits: s.apiUnits, resolvedQuery: s.resolvedQuery || null })),
      ytdlpVersions: [...new Set(Object.values(state.videos).map((v) => v.ytdlpVersion).filter(Boolean))],
    }, null, 2) + "\n");
    process.exit(0);
  }

  if (cmd === "stop") {
    const id = a._[0];
    if (!id) errUsage("podaj jobId: yts-job stop <jobId>");
    try { loadState(jobDir, id); } catch (e) { fail(e); }
    const r = stopJob(jobDir, id);
    if (r.running) {
      log(`prosba o stop zapisana — job ${id} (pid ${r.pid}) zatrzyma sie po biezacym filmie`);
      process.exit(0);
    }
    log(`job ${id} nie jest uruchomiony — nic do zatrzymania`);
    process.exit(0);
  }

  if (cmd === "report") {
    const id = a._[0];
    if (!id) errUsage("podaj jobId: yts-job report <jobId>");
    let state;
    try { state = loadState(jobDir, id).state; } catch (e) { fail(e); }
    const keywords = a.keywords ? String(a.keywords).split(",").map((s) => s.trim()).filter(Boolean) : null;
    const report = buildReport(state, { cacheDir, keywords });
    const written = writeReportFile(cacheDir, id, report);
    process.stderr.write(`[yts-job] raport: ${reportSummary(report)}\n`);
    process.stderr.write(`[yts-job] zapisano: ${written}\n`);
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    process.exit(0);
  }

  if (cmd === "repair") {
    const id = a._[0];
    if (!id) errUsage("podaj jobId: yts-job repair <jobId>");
    let cases;
    try { cases = repair(jobDir, cacheDir, id); } catch (e) { fail(e); }
    process.stdout.write(JSON.stringify(cases, null, 2) + "\n");
    process.exit(0);
  }

  errUsage(`nieznana komenda: ${cmd}`);
}

main().catch((e) => {
  process.stderr.write(`[yts-job] blad: ${e && e.message}\n`);
  process.exit(e instanceof JobError ? e.code : 4);
});
