// lib/ytsub-job.mjs — stan joba, lease, polityka D1/D2/D10, raport (D3/D4).
//
// Układ plików (względem katalogu modułu, nie CWD):
//   jobs/<jobId>/state.json            — prawda o wynikach (zapis atomowy + .bak)
//   jobs/<jobId>.log                   — log postępu (rodzeństwo katalogu joba)
//   jobs/<jobId>.lease.json            — strażnik jednego zapisującego (rodzeństwo)
//   jobs/<jobId>.stop.json             — prośba o zatrzymanie (rodzeństwo)
//   .cache/subs/<id>.<lang>.<kind>.p<v>.txt [+ .meta.json, .vtt] — prawda o treści
//   .cache/reports/<jobId>.json        — raport (pochodny, regenerowalny offline)
//
// Autorytet: stan mówi CO się stało, cache mówi CZEGO DOSZŁISMY. `done` wymaga
// obu: brak pliku w cache rozstrzyga `repair` i rekonciliację przy starcie.
import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync, unlinkSync, rmSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { hostname } from "node:os";
import { canonLang, cacheKey, cachePaths, getCache, putCache, configFingerprint, PARSER_VERSION, MIN_CACHE_CHARS, readRaw } from "./ytsub-cache.mjs";
import { classifyFailure, findKeywords, vttToText } from "../youtube-transcripts.mjs";
import { childEnv, expectedFilenames, fetchSubtitleFile, listTracks, resolveTrack, buildArgs, langFromFilename, kindFromVtt, ytDlpVersion } from "./ytsub-ytdlp.mjs";

export const SCHEMA_VERSION = 1;
export const REASONS = ["rate_limited", "no_subtitles", "video_unavailable", "bot_check", "proxy_error", "timeout", "unknown"];
export const LEASE_TTL_MS = 6 * 60 * 60 * 1000; // 6 h
export const DEFAULT_QUOTA_BUDGET = 2000;
export const DEFAULT_ATTEMPT_BUDGET = 3;        // unknown/timeout: powtarzaj do wyczerpania (D1)
export const DEFAULT_RL_STOP = 5;               // placeholder — potwierdza test na żywo
export const BACKOFF_STEPS = [5 * 60000, 10 * 60000, 20 * 60000];
export const JITTER_MS = 15000;
export const TERMINAL_REASONS = ["no_subtitles", "video_unavailable"];   // nie ponawiane nigdy
export const RETRY_STOPPED_REASONS = ["bot_check", "proxy_error"];       // tylko z --retry-stopped (D10)
export const STOP_EXIT = { rate_limited: 3, bot_check: 3, proxy_error: 4 };
export const REFRESHABLE = ["done", "stale"];                             // tylko z --refresh (D10)

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

export class JobError extends Error {
  constructor(msg, code) { super(msg); this.name = "JobError"; this.code = code || 4; }
}

// --- ścieżki ---------------------------------------------------------------
export function resolveJobDir(jobDir) { return jobDir ? jobDir : join(MODULE_DIR, "..", "jobs"); }
export function jobDirFor(jobDir, jobId) { return join(resolveJobDir(jobDir), jobId); }
export function statePathFor(jobDir, jobId) { return join(jobDirFor(jobDir, jobId), "state.json"); }
export function jobLogPathFor(jobDir, jobId) { return join(resolveJobDir(jobDir), `${jobId}.log`); }
export function leasePath(jobDir, jobId) { return join(resolveJobDir(jobDir), `${jobId}.lease.json`); }
export function stopPath(jobDir, jobId) { return join(resolveJobDir(jobDir), `${jobId}.stop.json`); }
export function reportPathFor(cacheDir, jobId) { return join(cacheDir || join(MODULE_DIR, "..", ".cache"), "reports", `${jobId}.json`); }

// --- log postępu: stderr + plik per job ------------------------------------
export function jobLogger(jobDir, jobId) {
  const p = jobLogPathFor(jobDir, jobId);
  try { mkdirSync(dirname(p), { recursive: true }); } catch {}
  return {
    path: p,
    line(msg) {
      const stamp = new Date().toISOString().slice(11, 19);
      try { appendFileSync(p, `${stamp} ${msg}\n`, "utf8"); } catch {}
      if (process.env.YTS_QUIET !== "1") process.stderr.write(`[yts-job] ${msg}\n`);
    },
  };
}

// --- walidacja ID (D7: ^[\w-]{11}$ na każdym wejściu) ----------------------
export function validVideoId(id) {
  return typeof id === "string" && /^[\w-]{11}$/.test(id);
}

// --- stan ------------------------------------------------------------------
// Kandydaci zamrażani przy utworzeniu joba (Goal 4): resume nigdy nie pyta źródła.
export function createJob({ jobId, langs, captionPreference = "manual_first", keywords = [], maxVideos = null, quotaBudget = DEFAULT_QUOTA_BUDGET, cacheDir, jobDir, pacing = {}, candidateIds = [], sources = null }) {
  const ids = [...new Set((candidateIds || []).filter(validVideoId))];
  const srcs = sources || [{ type: "ids", resolvedQuery: null, filters: {}, apiUnits: 0, ids, titleByVideo: {} }];
  // spentUnits = suma jednostek źródła (D8/D15): discovery juz zapłacone.
  const spentUnits = srcs.reduce((n, s) => n + (Number(s.apiUnits) || 0), 0);
  const state = {
    schemaVersion: SCHEMA_VERSION,
    jobId,
    createdAt: new Date().toISOString(),
    finishedAt: null,
    finished: false,
    stopped: null,
    configFingerprint: configFingerprint({ langs, captionPreference }),
    langOrder: String(langs || "").split(",").map((s) => canonLang(s)).filter(Boolean),
    captionPreference,
    keywords: keywords.slice(),
    maxVideos,
    quota: { budgetUnits: quotaBudget, spentUnits },
    pacing: { intervalMs: 4000, rlStop: DEFAULT_RL_STOP, ...pacing },
    sources: srcs,
    candidates: ids,
    videos: {},
  };
  saveState(statePathFor(jobDir, jobId), state);
  return state;
}

export function loadState(jobDir, jobId) {
  const main = statePathFor(jobDir, jobId);
  const bak = main + ".bak";
  if (existsSync(main)) {
    try {
      const state = JSON.parse(readFileSync(main, "utf8"));
      if (state.schemaVersion > SCHEMA_VERSION) {
        throw new JobError(`stan joba ${jobId} ma schemaVersion ${state.schemaVersion}, ten program obsługuje ${SCHEMA_VERSION}. Zaktualizuj youtube-transcript-search.`, 4);
      }
      return { state, path: main };
    } catch (e) { if (e instanceof JobError) throw e; /* spadaj do .bak */ }
  }
  if (existsSync(bak)) {
    try {
      const s = JSON.parse(readFileSync(bak, "utf8"));
      if (s.schemaVersion > SCHEMA_VERSION) {
        throw new JobError(`kopia zapasowa stanu ${jobId} ma schemaVersion ${s.schemaVersion}, ten program obsługuje ${SCHEMA_VERSION}.`, 4);
      }
      jobLogger(jobDir, jobId).line(`stan odtworzony z ${bak}`);
      saveState(main, s);
      return { state: s, path: main };
    } catch (e) { if (e instanceof JobError) throw e; }
  }
  throw new JobError(`stan joba nieczytelny: ${main} (i .bak). Napraw: yts-job repair ${jobId}`, 4);
}

export function saveState(path, state) {
  const tmp = `${path}.tmp`;
  const bak = `${path}.bak`;
  mkdirSync(dirname(path), { recursive: true });
  try { if (existsSync(path)) renameSync(path, bak); } catch {}
  writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  renameSync(tmp, path);
}

// Reconciliacja przy starcie (D2): in_progress -> pending; reszta bez zmian.
export function reconcile(state) {
  let moved = 0;
  for (const rec of Object.values(state.videos)) {
    if (rec.status === "in_progress") { rec.status = "pending"; moved++; }
  }
  return moved;
}

// D2: rekord robi się `stale` w dokładnie trzech przypadkach.
export function evaluateStaleness(state, { cacheDir, fingerprint, requireSameVersion = false, currentVersion = "" } = {}) {
  const counts = { fingerprint: 0, cacheMissing: 0, version: 0 };
  for (const [id, rec] of Object.entries(state.videos)) {
    if (rec.status !== "done") continue;
    let staleReason = "";
    if (fingerprint && rec.configFingerprint && rec.configFingerprint !== fingerprint) staleReason = "fingerprint";
    else if (!getCache(cacheDir, cacheKey(id, rec.lang, rec.kind))) staleReason = "cache_missing";
    else if (requireSameVersion && currentVersion && rec.ytdlpVersion && rec.ytdlpVersion !== currentVersion) staleReason = "version";
    if (staleReason) { rec.status = "stale"; rec.staleReason = staleReason; counts[staleReason === "fingerprint" ? "fingerprint" : staleReason]++; }
  }
  return counts;
}

// D10: --refresh przerabia done+stale na pending; failed rusza się nie rusza.
export function applyRefresh(state) {
  let n = 0;
  for (const rec of Object.values(state.videos)) {
    if (REFRESHABLE.includes(rec.status)) { rec.status = "pending"; n++; }
  }
  return n;
}

// D10: --retry-stopped rusza wyłącznie failed: bot_check/proxy_error.
// `stale` nie jest skutkiem zatrzymania joba, więc go nie rusza (D2).
export function applyRetryStopped(state) {
  let n = 0;
  for (const rec of Object.values(state.videos)) {
    if (rec.status === "failed" && RETRY_STOPPED_REASONS.includes(rec.reason)) { rec.status = "pending"; n++; }
  }
  return n;
}

// --- lease ------------------------------------------------------------------
export function acquireLease(jobDir, jobId) {
  const p = leasePath(jobDir, jobId);
  mkdirSync(dirname(p), { recursive: true });
  if (existsSync(p)) {
    try {
      const l = JSON.parse(readFileSync(p, "utf8"));
      const age = Date.now() - new Date(l.startedAt).getTime();
      if (isPidAlive(l.pid) && age < LEASE_TTL_MS) {
        throw new JobError(`job ${jobId} jest już uruchomiony (pid ${l.pid} na ${l.hostname}, wiek ${Math.round(age / 60000)} min). Zatrzymaj go: yts-job stop ${jobId}.`, 4);
      }
    } catch (e) { if (e instanceof JobError) throw e; }
  }
  const lease = { pid: process.pid, hostname: hostname(), startedAt: new Date().toISOString() };
  writeFileSync(p, JSON.stringify(lease, null, 2), "utf8");
  return () => { try { if (existsSync(p)) unlinkSync(p); } catch {} };
}

export function releaseLease(jobDir, jobId) {
  try { const p = leasePath(jobDir, jobId); if (existsSync(p)) unlinkSync(p); } catch {}
}

function isPidAlive(pid) {
  if (!pid || typeof pid !== "number") return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// --- prośba o zatrzymanie ---------------------------------------------------
// `yts-job stop` dopisuje plik; runner sprawdza go między filmami i kończy
// czysto (stan zrzucony, lease zwolniony). Zabity proces odtwarzany przez
// rekonciliację in_progress -> pending.
export function requestStop(jobDir, jobId) {
  const p = stopPath(jobDir, jobId);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ requestedAt: new Date().toISOString(), pid: process.pid }, null, 2), "utf8");
  return p;
}

export function isStopRequested(jobDir, jobId) {
  try { return existsSync(stopPath(jobDir, jobId)); } catch { return false; }
}

export function clearStop(jobDir, jobId) {
  try { const p = stopPath(jobDir, jobId); if (existsSync(p)) unlinkSync(p); } catch {}
}

export function stopJob(jobDir, jobId) {
  const p = leasePath(jobDir, jobId);
  if (existsSync(p)) {
    try {
      const l = JSON.parse(readFileSync(p, "utf8"));
      if (isPidAlive(l.pid)) {
        requestStop(jobDir, jobId);
        return { running: true, pid: l.pid, hostname: l.hostname };
      }
    } catch {}
  }
  return { running: false };
}

// --- rekordy ---------------------------------------------------------------
function nowIso() { return new Date().toISOString(); }

export function setRecordDone(state, path, id, rec) {
  state.videos[id] = {
    status: "done", lang: rec.lang, kind: rec.kind, chars: rec.chars,
    attempts: rec.attempts, cachePath: rec.cachePath, fetchedAt: rec.fetchedAt,
    ytdlpVersion: rec.ytdlpVersion || "", configFingerprint: rec.configFingerprint || "", rawTails: [],
  };
  saveState(path, state);
}

export function setRecordFailed(state, path, id, reason, attempts, rawTails = []) {
  const r = REASONS.includes(reason) ? reason : "unknown";
  state.videos[id] = { status: "failed", reason: r, attempts, rawTails, lastAttemptAt: nowIso() };
  saveState(path, state);
}

// rate_limited (D1): film ZOSTAJE pending — job ponawia go po cooldownie.
export function setRecordPending(state, path, id, attempts, rawTails = []) {
  const prev = state.videos[id] || {};
  state.videos[id] = { ...prev, status: "pending", attempts, rawTails, lastAttemptAt: nowIso() };
  saveState(path, state);
}

export function setRecordInProgress(state, path, id, attemptNo) {
  const prev = state.videos[id] || {};
  state.videos[id] = { ...prev, status: "in_progress", attempts: attemptNo, startedAt: nowIso() };
  saveState(path, state);
}

// --- raport (pochodny ze stanu + cache; zero ruchu sieciowego) --------------
// `keywords` = lista z --keywords; bez podania bierzemy z zapisanego joba.
// Trafienia liczone z cache — Goal 9: nowe słowa bez jednego zapytania do YouTube.
export function buildReport(state, { elapsedMs = null, cacheDir, keywords = null } = {}) {
  const kws = (keywords && keywords.length ? keywords : state.keywords || []).filter(Boolean);
  // Raport ma wymienic KAZDEGO zamrożonego kandydata — te, których nikt nie
  // ruszył, sa `pending`, a nie niewidzialne (inaczej kandydaci != videos[]).
  const ids = [...new Set([...(state.candidates || Object.keys(state.videos)), ...Object.keys(state.videos)])];
  const titleFor = (id) => (state.sources || []).map((s) => (s.titleByVideo || {})[id]).find(Boolean) || null;
  const videos = ids.map((id) => {
    const r = state.videos[id] || {};
    const rec = {
      id, status: r.status || "pending", reason: r.reason || null, lang: r.lang || null, kind: r.kind || null,
      chars: r.chars ?? null, url: `https://www.youtube.com/watch?v=${id}`,
      cachePath: r.cachePath || null, fetchedAt: r.fetchedAt || null,
      title: titleFor(id), channel: null,
    };
    if (kws.length && r.status === "done") {
      const hit = getCache(cacheDir, cacheKey(id, r.lang, r.kind));
      rec.keywords = kws.map((k) => keywordHits(hit ? hit.text : "", k));
    }
    return rec;
  });
  const keywordTotals = {};
  for (const k of kws) keywordTotals[k] = { count: 0, contexts: [] };
  for (const v of videos) {
    for (const k of v.keywords || []) {
      const bucket = keywordTotals[k.keyword];
      if (!bucket) continue;
      bucket.count += k.count;
      for (const c of k.contexts) if (bucket.contexts.length < 5) bucket.contexts.push(c);
    }
  }
  const byReason = {};
  for (const v of videos) if (v.status === "failed") byReason[v.reason] = (byReason[v.reason] || 0) + 1;
  const obtained = videos.filter((v) => v.status === "done").length;
  const versions = [...new Set(Object.values(state.videos).map((r) => r.ytdlpVersion).filter(Boolean))];
  return {
    jobId: state.jobId,
    createdAt: state.createdAt,
    finishedAt: state.finishedAt,
    finished: state.finished,
    stopped: state.stopped || null,
    candidates: (state.candidates || Object.keys(state.videos)).length,
    obtained,
    failedByReason: byReason,
    quotaSpentUnits: state.quota.spentUnits,
    elapsedMs: elapsedMs,
    ytdlpVersions: versions,
    langOrder: state.langOrder,
    keywords: kws.map((k) => ({ keyword: k, count: keywordTotals[k].count, contexts: keywordTotals[k].contexts })),
    videos,
  };
}

function keywordHits(text, keyword) {
  try { return findKeywords(text, [keyword])[0] || { keyword, count: 0, contexts: [] }; } catch { return { keyword, count: 0, contexts: [] }; }
}

// Ludzkie podsumowanie na stderr — liczniki, nigdy "pusto".
export function reportSummary(r) {
  const parts = [];
  parts.push(`kandydaci=${r.candidates}`);
  parts.push(`z napisami=${r.obtained}`);
  parts.push(`bez napisow=${JSON.stringify(r.failedByReason)}`);
  if (r.keywords.length) parts.push(`trafienia=${r.keywords.map((k) => `${k.keyword}:${k.count}`).join(",")}`);
  if (r.ytdlpVersions.length) parts.push(`yt-dlp=${r.ytdlpVersions.join(",")}`);
  return parts.join(" ");
}

export function writeReportFile(cacheDir, jobId, report) {
  const p = reportPathFor(cacheDir, jobId);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(report, null, 2), "utf8");
  return p;
}

// --- runner (D1: tempo na poziomie joba, stop po N, retries=0) --------------
// opts: { langs, ytdlpPath, cacheDir, jobDir, intervalMs, rlStop, attemptBudget,
//         proxy, allProxySource, cookiesFile, refresh, retryStopped,
//         requireSameVersion, versionProbe, clock, sleep, jitter, fetch }
export async function runJob(jobId, opts = {}) {
  const jobDir = opts.jobDir, cacheDir = opts.cacheDir;
  const clock = opts.clock || (() => Date.now());
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const jitter = opts.jitter || (() => Math.floor(Math.random() * JITTER_MS));
  const langs = opts.langs;
  if (!langs) throw new JobError("--langs jest wymagane w trybie joba (D5)", 5);

  const { state, path } = loadState(jobDir, jobId);
  const fingerprint = configFingerprint({ langs, captionPreference: state.captionPreference });
  reconcile(state);
  const stale = evaluateStaleness(state, { cacheDir, fingerprint, requireSameVersion: opts.requireSameVersion, currentVersion: opts.versionProbe });
  const refreshed = opts.refresh ? applyRefresh(state) : 0;
  const retriedStopped = opts.retryStopped ? applyRetryStopped(state) : 0;
  saveState(path, state);

  const release = acquireLease(jobDir, jobId);
  clearStop(jobDir, jobId);
  const log = jobLogger(jobDir, jobId);
  const ytDlpPath = opts.ytdlpPath;
  const intervalMs = opts.intervalMs ?? 4000;
  const rlStop = opts.rlStop ?? DEFAULT_RL_STOP;
  const attemptBudget = opts.attemptBudget || DEFAULT_ATTEMPT_BUDGET;
  const versionProbe = opts.versionProbe !== undefined ? opts.versionProbe : await ytDlpVersion(ytDlpPath);
  const frozen = state.candidates || [];
  const todo = frozen.filter((id) => (state.videos[id]?.status || "pending") === "pending");

  log.line(`start: job=${jobId} langi=${state.langOrder.join(",")} kandydaci=${frozen.length} do zrobienia=${todo.length} interwal=${intervalMs}ms yt-dlp=${versionProbe || "?"}`);
  if (refreshed) log.line(`--refresh: ${refreshed} rekordow(ow) do ponownego pobrania`);
  if (retriedStopped) log.line(`--retry-stopped: ${retriedStopped} rekordow(ow) failed:bot_check/proxy_error ponowionych`);
  if (stale.fingerprint || stale.cacheMissing || stale.version) log.line(`stale: ${JSON.stringify(stale)}`);

  const startedAt = clock();
  let consecutiveRl = 0, backoffIdx = 0, stopped = null, processed = 0;
  try {
    for (let i = 0; i < todo.length; i++) {
      const id = todo[i];
      const pos = `${i + 1}/${todo.length}`;
      if (isStopRequested(jobDir, jobId)) {
        clearStop(jobDir, jobId); // prosba zostala spelniona — nie moze zabic kolejnego biegu
        stopped = { reason: "user_stop", exitCode: 0, videoId: id, position: `${i + 1}` };
        log.line(`stop: prosba uzytkownika po ${processed} filmach - stan zrzucony, lease zwolniony. Kontynuuj: yts-job resume ${jobId}`);
        break;
      }
      if (!validVideoId(id)) { setRecordFailed(state, path, id, "unknown", 1, [`invalid video id: ${id}`]); log.line(`${pos} ${id}: failed unknown (nieprawidłowe ID)`); continue; }
      const t0 = clock();
      const outcome = await attemptVideo(id);
      const elapsed = Math.round((clock() - t0) / 1000);
      processed++;
      if (outcome.ok) {
        const rec = { videoId: id, lang: outcome.lang, kind: outcome.kind, parserVersion: PARSER_VERSION };
        const saved = putCache(cacheDir, rec, { text: outcome.text, raw: outcome.raw, meta: { ytdlpVersion: versionProbe, fetchedAt: nowIso() } });
        if (saved) {
          setRecordDone(state, path, id, { lang: outcome.lang, kind: outcome.kind, chars: outcome.text.length, attempts: outcome.attempts, cachePath: cachePaths(cacheDir, rec).text, fetchedAt: nowIso(), ytdlpVersion: versionProbe, configFingerprint: fingerprint });
          consecutiveRl = 0;
          log.line(`${pos} ${id}: done (${outcome.lang}/${outcome.kind}, ${outcome.text.length} znakow, ${elapsed}s)`);
        } else {
          setRecordFailed(state, path, id, "unknown", outcome.attempts, [`cache odrzucil: ponizej ${MIN_CACHE_CHARS} znakow`]);
          consecutiveRl = 0;
          log.line(`${pos} ${id}: failed unknown (zapisanej tresci < ${MIN_CACHE_CHARS} znakow, ${elapsed}s)`);
        }
      } else if (outcome.reason === "rate_limited") {
        consecutiveRl++;
        setRecordPending(state, path, id, outcome.attempts, outcome.rawTails);
        if (consecutiveRl >= rlStop) {
          stopped = { reason: "rate_limited", exitCode: 3, videoId: id, position: String(i + 1) };
          log.line(`stop: ${consecutiveRl} kolejnych limitow (429) — zatrzymuje sie po ${processed} filmach. Wznow: yts-job resume ${jobId}`);
          break;
        }
        const wait = BACKOFF_STEPS[Math.min(backoffIdx, BACKOFF_STEPS.length - 1)] + jitter();
        log.line(`${pos} ${id}: rate_limited — pauza ${Math.round(wait / 1000)}s (${consecutiveRl}/${rlStop}), ten sam film po cooldownie`);
        backoffIdx++;
        await sleep(wait);
        i--;
        continue;
      } else if (STOP_EXIT[outcome.reason] !== undefined) {
        setRecordFailed(state, path, id, outcome.reason, outcome.attempts, outcome.rawTails);
        stopped = { reason: outcome.reason, exitCode: STOP_EXIT[outcome.reason], videoId: id, position: String(i + 1) };
        const remedy = outcome.reason === "bot_check" ? "YTS_COOKIES_FILE lub proxy rezydencjalne" : "sprawdz proxy (YTS_PROXY/HTTPS_PROXY)";
        log.line(`stop: ${outcome.reason} przy ${id} po ${processed} filmach — ${remedy}. Ponow tylko z --retry-stopped: yts-job resume ${jobId} --retry-stopped`);
        break;
      } else {
        setRecordFailed(state, path, id, outcome.reason, outcome.attempts, outcome.rawTails);
        consecutiveRl = 0;
        log.line(`${pos} ${id}: failed ${outcome.reason} (${elapsed}s)`);
      }
      if ((i + 1) % 10 === 0) log.line(`postep ${i + 1}/${todo.length}: ${counts(state)}`);
      if (intervalMs > 0) await sleep(intervalMs);
    }
  } finally {
    release();
    state.finished = true;
    state.finishedAt = nowIso();
    if (stopped) state.stopped = stopped.reason;
    saveState(path, state);
  }
  if (!stopped && todo.length === 0) log.line(`nic do zrobienia: wszystkie ${frozen.length} rekordy maja wynik`);
  const report = buildReport(state, { elapsedMs: clock() - startedAt, cacheDir, keywords: state.keywords });
  log.line(`koniec: ${reportSummary(report)}`);
  writeReportFile(cacheDir, jobId, report);
  return { stopped, report, state };

  // --- jeden film: listing sciezek (D5), potem dokladnie jedno pobranie ----
  async function attemptVideo(id) {
    const tails = [];
    let last = "unknown";
    let tracks;
    // attempts kumuluja sie miedzy probami (tez po cooldownie): licznik w rekordzie.
    const baseAttempts = (state.videos[id] && state.videos[id].attempts) || 0;
    for (let attempt = 1; attempt <= attemptBudget; attempt++) {
      const attemptNo = baseAttempts + attempt;
      setRecordInProgress(state, path, id, attemptNo);
      if (opts.fetch) {
        const r = await opts.fetch(id, { approach: "list", args: ["--skip-download", "--print-json", `https://www.youtube.com/watch?v=${id}`], env: childEnv({ proxy: opts.proxy, allProxySource: opts.allProxySource }) });
        tracks = r.tracks || { manual: [], auto: [], failed: true, err: r.err || "", code: r.code ?? -1, timedOut: !!r.timedOut };
      } else {
        tracks = (await listTracks(ytDlpPath, id, { timeoutMs: opts.timeoutMs })) || { manual: [], auto: [], failed: true, err: "", code: -1, timedOut: false };
      }
      if (tracks.failed) {
        const reason = classifyFailure(tracks.err || "", tracks.code || -1, tracks.timedOut);
        tails.push(`listing: ${(tracks.err || "").split("\n").filter((l) => /ERROR/.test(l)).slice(-1)[0] || `yt-dlp exit ${tracks.code}`}`);
        last = reason;
        if (reason === "rate_limited" || STOP_EXIT[reason] !== undefined) return { ok: false, reason, rawTails: tails, attempts: attemptNo };
        if (attempt < attemptBudget) { await sleep(attempt * 5000); continue; }
        return { ok: false, reason, rawTails: tails, attempts: attemptNo };
      }
      const track = resolveTrack(tracks, langs);
      if (!track) return { ok: false, reason: "no_subtitles", rawTails: tails, attempts: attemptNo };
      const outDir = join(cacheDir && resolveCacheDirSafe(cacheDir), "incoming", jobId, id);
      mkdirSync(outDir, { recursive: true });
      const downloadArgs = buildArgs({ videoId: id, lang: track.lang, kind: track.kind, outDir, cookiesFile: opts.cookiesFile });
      const env = childEnv({ proxy: opts.proxy, allProxySource: opts.allProxySource });
      const res = opts.fetch ? await opts.fetch(id, { approach: "download", args: downloadArgs, env, lang: track.lang, kind: track.kind }) : await fetchSubtitleFile(ytDlpPath, downloadArgs, { env, timeoutMs: opts.timeoutMs });
      const found = expectedFilenames(id, track.lang).map((n) => join(outDir, n)).filter((p) => existsSync(p));
      if (found.length) {
        const raw = readFileSync(found[0], "utf8");
        const langFromName = langFromFilename(found[0].split(/[\\/]/).pop());
        const kind = kindFromVtt(raw);
        if (kind !== track.kind) log.line(`  ${id}: uwaga — listing mowi ${track.kind}, plik wyglada na ${kind}`);
        rmSyncSafe(outDir);
        return { ok: true, lang: canonLang(langFromName || track.lang), kind, text: vttToText(raw), raw, attempts: attemptNo };
      }
      const err = (res.err || "").split("\n").filter((l) => /ERROR/.test(l));
      tails.push(err.slice(-1)[0] || `yt-dlp exit ${res.code}`);
      last = classifyFailure(err.join("\n"), res.code, res.timedOut);
      rmSyncSafe(outDir);
      if (last === "rate_limited" || STOP_EXIT[last] !== undefined) return { ok: false, reason: last, rawTails: tails, attempts: attemptNo };
      if (TERMINAL_REASONS.includes(last)) return { ok: false, reason: last, rawTails: tails, attempts: attemptNo };
      if (attempt < attemptBudget) { log.line(`  ${id}: ${last} — próba ${attempt}/${attemptBudget}, ponawiam`); await sleep(attempt * 5000); }
    }
    return { ok: false, reason: last, rawTails: tails, attempts: baseAttempts + attemptBudget };
  }
}

function counts(state) {
  const c = { done: 0, failed: 0, pending: 0 };
  for (const r of Object.values(state.videos)) c[r.status] = (c[r.status] || 0) + 1;
  return JSON.stringify(c);
}

function resolveCacheDirSafe(cacheDir) {
  return cacheDir || join(MODULE_DIR, "..", ".cache");
}

function rmSyncSafe(p) { try { rmSync(p, { recursive: true, force: true }); } catch {} }

// --- repair (tabela przypadków) ---------------------------------------------
// done + brak/niewazny cache -> stale; failed + poprawny cache -> done;
// in_progress starszy niz TTL lease'a -> pending; oba pliki nieczytelne -> odmowa.
export function repair(jobDir, cacheDir, jobId) {
  const { state, path } = loadState(jobDir, jobId);
  const cases = { doneToStale: 0, failedToDone: 0, inProgressToPending: 0, staleUntouched: 0 };
  const seen = {};
  for (const [id, rec] of Object.entries(state.videos)) {
    seen[id] = true;
    if (rec.status === "done") {
      if (!getCache(cacheDir, cacheKey(id, rec.lang, rec.kind))) { rec.status = "stale"; cases.doneToStale++; }
    } else if (rec.status === "failed") {
      const hit = getCache(cacheDir, cacheKey(id, rec.lang || state.langOrder[0], rec.kind || "auto"));
      if (hit) { rec.status = "done"; cases.failedToDone++; }
    } else if (rec.status === "in_progress") {
      const age = Date.now() - new Date(rec.startedAt || 0).getTime();
      if (age >= LEASE_TTL_MS) { rec.status = "pending"; cases.inProgressToPending++; }
    } else if (rec.status === "stale") {
      cases.staleUntouched++;
    }
  }
  saveState(path, state);
  return cases;
}
