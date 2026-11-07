#!/usr/bin/env node
// test/yts-job.test.mjs — offline testy sciezki batch (etap 1, bez sieci i sleepow).
//
// Shim YT_DLP odwzorowuje wylacznie ustalenia z weryfikacji na zywo (2026.11):
//   - `--print-json` listuje sciezki (`subtitles`/`automatic_captions`) bez pobierania,
//   - pobranie idzie z JEDNA flaga (`--write-subs` albo `--write-auto-subs`),
//   - plik to `s.<id>.NA.<lang>.vtt` dla obu rodzajow napisow,
//   - napisy auto maja okno przewijania <c>...</c> i align:start, manualne nie.
import { spawnSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { cacheKey, putCache, getCache, cachePaths, PARSER_VERSION, MIN_CACHE_CHARS, configFingerprint, canonLang, lookupCacheForRequest, cacheStatus } from "../lib/ytsub-cache.mjs";
import { findYtDlp, langFromFilename, kindFromVtt, resolveTrack, buildArgs, expectedFilenames, listTracks } from "../lib/ytsub-ytdlp.mjs";
import { parseFilters, resolveCandidates, discoverSearch, discoverPlaylist, discoverChannel, captionPreFilter, pickSource } from "../lib/ytsub-discover.mjs";
import {
  createJob, loadState, saveState, runJob, repair, buildReport, reportSummary, writeReportFile,
  acquireLease, validVideoId, stopJob, requestStop, isStopRequested, resolveJobDir, JobError, SCHEMA_VERSION,
} from "../lib/ytsub-job.mjs";
import { youtubeTranscript as youtubeTranscriptFn, classifyFailure as classifyFn } from "../youtube-transcripts.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`[PASS] ${name}`); }
  else { fail++; failures.push(name + (detail ? ` :: ${detail}` : "")); console.log(`[FAIL] ${name}${detail ? ` :: ${detail}` : ""}`); }
}

const ID_A = "AAAAAAAAAAA", ID_B = "BBBBBBBBBBB", ID_C = "CCCCCCCCCCC", ID_D = "DDDDDDDDDDD";
const ID_E = "EEEEEEEEEEE", ID_F = "FFFFFFFFFFF", ID_G = "GGGGGGGGGGG", ID_H = "HHHHHHHHHHH", ID_I = "IIIIIIIIIII";

// --- shim yt-dlp -----------------------------------------------------------
// `rule` opisuje JAWNE sciezki: { manual: ["pl"], auto: ["pl","en"], short, error }.
function makeShim(dir, rules) {
  const scriptPath = join(dir, "shim-yt-dlp.mjs");
  const logPath = join(dir, "spawns.log");
  const script = `
import { writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
const args = process.argv.slice(2);
const b = ${JSON.stringify({ rules, logPath })};
const url = args.find((a) => a.startsWith("http")) || "";
const id = (url.match(/[?&]v=([\\w-]+)/) || [])[1] || "unknown";
function log(what) { try { appendFileSync(b.logPath, what + " " + id + "\\n"); } catch {} }
if (args[0] === "--version") { process.stdout.write("2099.01.01\\n"); process.exit(0); }
const rule = (b.rules && b.rules[id]) || { manual: ["pl"], auto: [] };
const errFor = {
  "429": "ERROR: Unable to download video subtitles for 'X': HTTP Error 429: Too Many Requests",
  bot: "ERROR: Sign in to confirm you're not a bot",
  proxy: "ERROR: Unable to connect to proxy",
  unavailable: "ERROR: [youtube] " + id + ": This video is not available",
};
function emit(kind) {
  process.stderr.write(errFor[kind].replace("'X'", "'pl'") + "\\n");
  process.exit(1);
}
const searchArg = args.find((a) => a.startsWith("ytsearch"));
if (searchArg) {
  log("search");
  const n = Number((searchArg.match(/ytsearch(\\d+):/) || [])[1] || 2);
  const out = [];
  for (let i = 0; i < n; i++) {
    const id = ["AAAAAAAAAAA", "BBBBBBBBBBB", "CCCCCCCCCCC", "DDDDDDDDDDD"][i % 4];
    out.push(JSON.stringify({ id, title: "film testowy " + i, channel: "Kanal " + i, duration: 100 + i }));
  }
  process.stdout.write(out.join("\\n") + "\\n");
  process.exit(0);
}
const isList = args.includes("--print-json");
if (isList) {
  log("list");
  if (rule.error) emit(rule.error);
  const mk = (list) => { const o = {}; for (const l of list || []) o[l] = [{ ext: "vtt", url: "https://x.invalid/" + l }]; return o; };
  process.stdout.write(JSON.stringify({ subtitles: mk(rule.manual), automatic_captions: mk(rule.auto) }) + "\\n");
  process.exit(0);
}
log("download");
if (rule.error) emit(rule.error);
const outIdx = args.indexOf("-o");
const template = outIdx >= 0 ? args[outIdx + 1] : "s.%(id)s.NA.%(lang)s.%(ext)s";
const langIdx = args.indexOf("--sub-langs");
const langs = langIdx >= 0 ? String(args[langIdx + 1]).split(",").map((s) => s.trim()).filter(Boolean) : ["pl"];
const wantManual = args.includes("--write-subs");
const wantAuto = args.includes("--write-auto-subs");
for (const lang of langs) {
  const hasManual = (rule.manual || []).includes(lang);
  const hasAuto = (rule.auto || []).includes(lang);
  const useManual = wantManual && hasManual;
  const useAuto = !useManual && wantAuto && hasAuto;
  if (!useManual && !useAuto) continue;
  const file = template.replace("%(id)s", id).replace("%(lang)s", lang).replace("%(ext)s", "vtt");
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  const lines = ["WEBVTT", "Kind: captions", "Language: " + lang, ""];
  if (rule.short) {
    writeFileSync(file, lines.join("\\n") + "00:00:00.000 --> 00:00:01.000\\nza krotkie\\n", "utf8");
    continue;
  }
  for (let i = 0; i < 20; i++) {
    const s = String(i).padStart(2, "0");
    const e = String(i + 1).padStart(2, "0");
    if (useManual) {
      lines.push("00:00:" + s + ".000 --> 00:00:" + e + ".000");
      lines.push("to jest tekst reczny " + i + " slowo kluczowe rust dla testu");
    } else {
      lines.push("00:00:" + s + ".000 --> 00:00:" + e + ".000 align:start position:0%");
      lines.push("<c>to jest tekst automatyczny " + i + " slowo kluczowe rust dla testu</c>");
    }
    lines.push("");
  }
  writeFileSync(file, lines.join("\\n"), "utf8");
}
process.exit(0);
`;
  writeFileSync(scriptPath, script, "utf8");
  return scriptPath;
}

const RULE = {
  auto: { manual: [], auto: ["pl"] },
  manual: { manual: ["pl"], auto: [] },
  both: { manual: ["pl"], auto: ["pl", "en"] },
  none: { manual: [], auto: [] },
  manualEn: { manual: ["en"], auto: ["pl", "en"] },
  short: { manual: ["pl"], auto: [], short: true },
  e429: { manual: ["pl"], auto: [], error: "429" },
  eBot: { manual: ["pl"], auto: [], error: "bot" },
  eProxy: { manual: ["pl"], auto: [], error: "proxy" },
  eUnavail: { manual: ["pl"], auto: [], error: "unavailable" },
};

function spawnCount(dir, what) {
  const p = join(dir, "spawns.log");
  if (!existsSync(p)) return 0;
  const lines = readFileSync(p, "utf8").split("\n").filter(Boolean);
  return what ? lines.filter((l) => l.startsWith(what)).length : lines.length;
}

function clockStarter(start = 1700000000000) {
  let t = start;
  return { clock: () => t, tick: (ms) => { t += ms; }, now: () => new Date(t).toISOString() };
}
const noSleep = () => Promise.resolve();

(async () => {
  const shimDir = mkdtempSync(join(tmpdir(), "yts-shim-"));

  // ============ 1) ytsub-ytdlp: nazwa pliku, rodzaj napisow, D5 ============
  {
    ok("langFromFilename: NA.<lang> -> lang", langFromFilename(`s.${ID_A}.NA.pl.vtt`) === "pl", langFromFilename(`s.${ID_A}.NA.pl.vtt`));
    ok("langFromFilename: NA.<lang> (en)", langFromFilename(`s.${ID_A}.NA.en.vtt`) === "en");
    ok("langFromFilename: stara forma <lang>", langFromFilename(`s.${ID_A}.pl.vtt`) === "pl");
    ok("langFromFilename: sam NA -> puste", langFromFilename(`s.${ID_A}.NA.vtt`) === "");
    const autoVtt = "WEBVTT\\nKind: captions\\nLanguage: pl\\n\\n00:00:00.000 --> 00:00:18.000 align:start position:0%\\n<c>tekst</c>\\n";
    const manualVtt = "WEBVTT\\nKind: captions\\nLanguage: pl\\n\\n00:00:00.000 --> 00:00:02.000\\ntekst reczny\\n";
    ok("kindFromVtt: <c> + align:start -> auto", kindFromVtt(autoVtt) === "auto");
    ok("kindFromVtt: statyczne cue -> manual", kindFromVtt(manualVtt) === "manual");
    // D5: pierwszy jezyk z kolei; w nim manual przed auto.
    ok("resolveTrack: manual pl przed auto pl", JSON.stringify(resolveTrack({ manual: ["pl"], auto: ["pl", "en"] }, "pl,en")) === JSON.stringify({ lang: "pl", kind: "manual" }));
    ok("resolveTrack: pl tylko auto -> auto pl (nie en manual)", JSON.stringify(resolveTrack({ manual: ["en"], auto: ["pl"] }, "pl,en")) === JSON.stringify({ lang: "pl", kind: "auto" }));
    ok("resolveTrack: brak pl -> en", JSON.stringify(resolveTrack({ manual: ["en"], auto: ["de"] }, "pl,en")) === JSON.stringify({ lang: "en", kind: "manual" }));
    ok("resolveTrack: nic -> null", resolveTrack({ manual: [], auto: [] }, "pl,en") === null);
    ok("resolveTrack: -orig kanonizuje sie", JSON.stringify(resolveTrack({ manual: [], auto: ["en-orig"] }, "pl,en")) === JSON.stringify({ lang: "en", kind: "auto" }));
    const argsManual = buildArgs({ videoId: ID_A, lang: "pl", kind: "manual", outDir: "C:/tmp/x", cookiesFile: "" });
    ok("buildArgs: manual -> tylko --write-subs", argsManual.includes("--write-subs") && !argsManual.includes("--write-auto-subs") && argsManual.includes("--no-write-auto-subs"));
    ok("buildArgs: auto -> tylko --write-auto-subs", buildArgs({ videoId: ID_A, lang: "pl", kind: "auto", outDir: "C:/tmp/x" }).includes("--write-auto-subs"));
    ok("buildArgs: --retries 0 (retries yt-dlp nie kumuluja sie)", buildArgs({ videoId: ID_A, lang: "pl", kind: "auto", outDir: "C:/tmp/x" }).includes("--retries") && buildArgs({ videoId: ID_A, lang: "pl", kind: "auto", outDir: "C:/tmp/x" })[buildArgs({ videoId: ID_A, lang: "pl", kind: "auto", outDir: "C:/tmp/x" }).indexOf("--retries") + 1] === "0");
    ok("buildArgs: proxy NIGDY w argv", !buildArgs({ videoId: ID_A, lang: "pl", kind: "auto", outDir: "C:/tmp/x" }).some((x) => String(x).includes("proxy")));
    ok("buildArgs: cookies idzie jako sciezka", buildArgs({ videoId: ID_A, lang: "pl", kind: "manual", outDir: "C:/tmp/x", cookiesFile: "C:/cookies.txt" }).includes("C:/cookies.txt"));
    const names = expectedFilenames(ID_A, "pl,en");
    ok("expectedFilenames: NA.<lang> pierwsze", names[0] === `s.${ID_A}.NA.pl.vtt` && names[2] === `s.${ID_A}.NA.en.vtt`, JSON.stringify(names));
    ok("expectedFilenames: bez skanu katalogu (dokladna lista)", names.length === 4);
  }

  // ============ 2) cache: klucz, walidacja, status, lookup ==================
  {
    const dir = mkdtempSync(join(tmpdir(), "yts-cache-"));
    const rec = cacheKey(ID_A, "pl-PL", "manual");
    ok("canonLang pl-PL -> pl", canonLang("pl-PL") === "pl");
    ok("cacheKey: parserVersion w kluczu", rec.parserVersion === PARSER_VERSION);
    ok("putCache: odrzuca za krotki tekst", putCache(dir, rec, { text: "krotkie" }) === false);
    ok("getCache: nie zwraca za krotkiego", getCache(dir, rec) === null);
    ok("putCache: akceptuje poprawny tekst", putCache(dir, rec, { text: "x".repeat(300), raw: "WEBVTT" }) === true);
    ok("getCache: zwraca tekst", getCache(dir, rec).text.length === 300);
    const p = cachePaths(dir, rec);
    ok("sciezka: id.lang.kind.p<v>.txt", p.text.split(/[\\/]/).pop() === `${ID_A}.pl.manual.p${PARSER_VERSION}.txt`, p.text);
    ok("sciezka: surowe vtt bez wersji parsera", p.raw.split(/[\\/]/).pop() === `${ID_A}.pl.manual.vtt`, p.raw);
    ok("cacheStatus: ok gdy jest surowe", cacheStatus(dir, rec) === "ok");
    rmSyncSync(p.raw);
    ok("cacheStatus: raw_missing gdy surowe zniknelo", cacheStatus(dir, rec) === "raw_missing", cacheStatus(dir, rec));
    ok("cacheStatus: missing gdy brak tekstu", cacheStatus(dir, cacheKey(ID_B, "pl", "auto")) === "missing");
    const hit = lookupCacheForRequest(dir, ID_A, "pl,en");
    ok("lookup: trafienie + raw_missing", hit.cache === "raw_missing" && hit.text.length === 300 && hit.rec.kind === "manual");
    putCache(dir, cacheKey(ID_A, "en", "auto"), { text: "y".repeat(250), raw: "WEBVTT" });
    putCache(dir, cacheKey(ID_A, "pl", "auto"), { text: "z".repeat(250), raw: "WEBVTT" });
    const hit2 = lookupCacheForRequest(dir, ID_A, "pl,en", { captionPreference: "auto_first" });
    ok("lookup: auto_first wybiera auto w tym samym jezyku", hit2.cache === "ok" && hit2.rec.kind === "auto" && hit2.rec.lang === "pl", JSON.stringify(hit2.rec));
    const hit3 = lookupCacheForRequest(dir, ID_A, "pl,en");
    ok("lookup: manual_first wybiera reczny", hit3.rec.kind === "manual" && hit3.rec.lang === "pl");
    const miss = lookupCacheForRequest(dir, ID_B, "pl,en");
    ok("lookup: brak -> missing (wołajacy pobiera)", miss.cache === "missing" && miss.rec === null);
    const fp1 = configFingerprint({ langs: "pl,en", captionPreference: "manual_first" });
    ok("fingerprint: stabilny", fp1 === configFingerprint({ langs: "pl,en", captionPreference: "manual_first" }));
    ok("fingerprint: zalezy od kolejnoscie jezykow", fp1 !== configFingerprint({ langs: "en,pl", captionPreference: "manual_first" }));
    ok("fingerprint: ignoruje keywords i tempo", fp1 === configFingerprint({ langs: "pl,en", captionPreference: "manual_first", keywords: ["a"], maxVideos: 9 }));
    rmSyncSync(dir);
  }

  // ============ 3) fasadą: lang/kind/reason =================================
  {
    const shimDir2 = mkdtempSync(join(tmpdir(), "yts-shim2-"));
    const shim = makeShim(shimDir2, { [ID_A]: RULE.both, [ID_B]: RULE.auto, [ID_C]: RULE.none, [ID_D]: RULE.eUnavail, [ID_E]: RULE.e429, [ID_F]: RULE.eBot, [ID_H]: RULE.short });
    process.env.YT_DLP = shim;
    const t1 = await youtubeTranscriptFn(ID_A, "pl,en", { retries: 1, sleepMs: 0 });
    ok("fasada: lang=pl (z NA.pl)", t1.ok && t1.lang === "pl", JSON.stringify({ ok: t1.ok, lang: t1.lang }));
    ok("fasada: kind=manual (brak <c> w pliku)", t1.ok && t1.kind === "manual", t1.kind);
    const t2 = await youtubeTranscriptFn(ID_B, "pl,en", { retries: 1, sleepMs: 0 });
    ok("fasada: kind=auto z <c>", t2.ok && t2.kind === "auto", t2.kind);
    ok("fasada: cache: null gdy nie czytano", t2.cache === null);
    const t3 = await youtubeTranscriptFn(ID_C, "pl,en", { retries: 1, sleepMs: 0 });
    ok("fasada: brak napisow -> no_subtitles", !t3.ok && t3.reason === "no_subtitles", JSON.stringify({ ok: t3.ok, reason: t3.reason }));
    const t4 = await youtubeTranscriptFn(ID_D, "pl,en", { retries: 1, sleepMs: 0 });
    ok("fasada: unavailable -> video_unavailable", !t4.ok && t4.reason === "video_unavailable", t4.reason);
    const t5 = await youtubeTranscriptFn(ID_E, "pl,en", { retries: 1, sleepMs: 0 });
    ok("fasada: 429 -> rate_limited", !t5.ok && t5.reason === "rate_limited");
    const t6 = await youtubeTranscriptFn(ID_F, "pl,en", { retries: 1, sleepMs: 0 });
    ok("fasada: bot -> bot_check", !t6.ok && t6.reason === "bot_check");
    // klasyfikator: jeden na calosc (D1)
    ok("classify: 429", classifyFn("HTTP Error 429: Too Many Requests", 1) === "rate_limited");
    ok("classify: bot", classifyFn("Sign in to confirm you're not a bot", 1) === "bot_check");
    ok("classify: proxy", classifyFn("Unable to connect to proxy", 1) === "proxy_error");
    ok("classify: timeout osobno od ERROR", classifyFn("", -1, true) === "timeout");
    ok("classify: exit 0 bez pliku -> no_subtitles", classifyFn("", 0) === "no_subtitles");
    ok("classify: exit 0 z ERROR -> unknown", classifyFn("ERROR: cos innego", 0) === "unknown");
    rmSyncSync(shimDir2);
  }

  // ============ 4) job: pelny przebieg + polityka D1 ========================
  {
    process.env.YT_DLP = makeShim(shimDir, { [ID_A]: RULE.manual, [ID_B]: RULE.both, [ID_C]: RULE.none, [ID_D]: RULE.eUnavail, [ID_E]: RULE.e429, [ID_F]: RULE.eBot, [ID_G]: RULE.eProxy, [ID_H]: RULE.short, [ID_I]: RULE.manualEn });
    const jobDir = join(shimDir, "jobs1"), cacheDir = join(shimDir, "cache1");
    const { clock } = clockStarter();
    const sleep = noSleep;
    const optsBase = { langs: "pl,en", ytdlpPath: process.env.YT_DLP, jobDir, cacheDir, intervalMs: 0, rlStop: 3, clock, sleep, versionProbe: "2099.01.01" };
    createJob({ jobId: "j1", langs: "pl,en", keywords: ["rust"], jobDir, cacheDir, candidateIds: [ID_A, ID_B, ID_C, ID_D] });
    const r1 = await runJob("j1", optsBase);
    ok("job: bez stopu (zadne 429)", !r1.stopped, JSON.stringify(r1.stopped));
    ok("job: 2 done (manual + auto-from-both)", r1.report.obtained === 2, JSON.stringify(r1.report.videos.map((v) => [v.id, v.status])));
    ok("job: no_subtitles nie probuje pobierac", r1.report.failedByReason.no_subtitles === 1, JSON.stringify(r1.report.failedByReason));
    ok("job: video_unavailable wpada do mianownika", r1.report.failedByReason.video_unavailable === 1);
    ok("job: raport nigdy nie jest pusty (Goal 3)", r1.report.candidates === 4 && r1.report.obtained + Object.values(r1.report.failedByReason).reduce((a, b) => a + b, 0) === 4);
    const st = loadState(jobDir, "j1").state;
    ok("stan: manual pl zapisany jako manual", st.videos[ID_A].status === "done" && st.videos[ID_A].kind === "manual" && st.videos[ID_A].lang === "pl");
    ok("stan: both -> manual (D5)", st.videos[ID_B].kind === "manual");
    ok("stan: rekord ma configFingerprint (D2/D4)", typeof st.videos[ID_A].configFingerprint === "string" && st.videos[ID_A].configFingerprint.length > 0);
    ok("stan: rawTails na failed", Array.isArray(st.videos[ID_D].rawTails) && st.videos[ID_D].rawTails.length > 0);
    ok("uklad: state.json w katalogu joba", existsSync(join(jobDir, "j1", "state.json")));
    ok("uklad: log per job (rodzeństwo)", existsSync(join(jobDir, "j1.log")));
    ok("uklad: raport w .cache/reports", existsSync(join(cacheDir, "reports", "j1.json")));
    ok("uklad: lease zwolniony po zakonczeniu", !existsSync(join(jobDir, "j1.lease.json")));
    // cache: rozne klucze dla roznego rodzaju
    ok("cache: manual wpis", !!getCache(cacheDir, cacheKey(ID_A, "pl", "manual")));
    ok("cache: surowe vtt zostaje (parser v2)", existsSync(join(cacheDir, "subs", `${ID_A}.pl.manual.vtt`)));
    // resume: zero nowych spawnow dla zakonczonych (Goal 1)
    const spawnsBefore = spawnCount(shimDir);
    const r1b = await runJob("j1", optsBase);
    ok("resume: brak --langs -> bierze kolejnosc z stanu", r1b.report.candidates === 4);
    ok("resume: zero nowych spawnow gdy nic nie zrobic", spawnCount(shimDir) === spawnsBefore, `${spawnsBefore} -> ${spawnCount(shimDir)}`);
    // jezyk zamrożony, D5: manualEn -> auto pl (bo pl ma tylko auto)
    createJob({ jobId: "j2", langs: "pl,en", keywords: ["rust"], jobDir, cacheDir, candidateIds: [ID_I] });
    const r2 = await runJob("j2", optsBase);
    ok("D5: reczny en NIE wygrywa z auto pl (pierwszy jezyk)", r2.report.videos[0].lang === "pl" && r2.report.videos[0].kind === "auto", JSON.stringify(r2.report.videos[0]));
  }

  // ============ 5) job: bot_check / proxy_error stopuja natychmiast =========
  {
    const dir = join(shimDir, "jobs2"), cacheDir2 = join(shimDir, "cache2");
    const { clock } = clockStarter();
    createJob({ jobId: "jbot", langs: "pl,en", keywords: [], jobDir: dir, cacheDir: cacheDir2, candidateIds: [ID_A, ID_F, ID_B] });
    const r = await runJob("jbot", { langs: "pl,en", ytdlpPath: process.env.YT_DLP, jobDir: dir, cacheDir: cacheDir2, intervalMs: 0, rlStop: 3, clock, sleep: noSleep, versionProbe: "2099.01.01" });
    ok("bot_check: stop natychmiast (exit 3)", r.stopped && r.stopped.reason === "bot_check" && r.stopped.exitCode === 3, JSON.stringify(r.stopped));
    ok("bot_check: film po nim nie ruszony", r.report.videos.find((v) => v.id === ID_B).status === "pending", r.report.videos.find((v) => v.id === ID_B).status);
    ok("bot_check: rekord failed: bot_check", loadState(dir, "jbot").state.videos[ID_F].status === "failed");
    // proxy_error -> exit 4
    createJob({ jobId: "jprox", langs: "pl,en", keywords: [], jobDir: dir, cacheDir: cacheDir2, candidateIds: [ID_G] });
    const r2 = await runJob("jprox", { langs: "pl,en", ytdlpPath: process.env.YT_DLP, jobDir: dir, cacheDir: cacheDir2, intervalMs: 0, rlStop: 3, clock, sleep: noSleep, versionProbe: "2099.01.01" });
    ok("proxy_error: stop (exit 4)", r2.stopped && r2.stopped.reason === "proxy_error" && r2.stopped.exitCode === 4, JSON.stringify(r2.stopped));
  }

  // ============ 5) bot_check / proxy_error stopuja natychmiast ==============
  {
    const dir = join(shimDir, "jobs2"), cacheDir2 = join(shimDir, "cache2");
    const { clock } = clockStarter();
    const base = { langs: "pl,en", ytdlpPath: process.env.YT_DLP, jobDir: dir, cacheDir: cacheDir2, intervalMs: 0, rlStop: 3, clock, sleep: noSleep, versionProbe: "2099.01.01" };
    createJob({ jobId: "jbot", langs: "pl,en", keywords: [], jobDir: dir, cacheDir: cacheDir2, candidateIds: [ID_A, ID_F, ID_B] });
    const r = await runJob("jbot", base);
    ok("bot_check: stop natychmiast (exit 3)", r.stopped && r.stopped.reason === "bot_check" && r.stopped.exitCode === 3, JSON.stringify(r.stopped));
    ok("bot_check: film po nim nie ruszony", r.report.videos.find((v) => v.id === ID_B).status === "pending", r.report.videos.find((v) => v.id === ID_B).status);
    ok("bot_check: rekord failed: bot_check", loadState(dir, "jbot").state.videos[ID_F].status === "failed");
    createJob({ jobId: "jprox", langs: "pl,en", keywords: [], jobDir: dir, cacheDir: cacheDir2, candidateIds: [ID_G] });
    const r2 = await runJob("jprox", base);
    ok("proxy_error: stop (exit 4)", r2.stopped && r2.stopped.reason === "proxy_error" && r2.stopped.exitCode === 4, JSON.stringify(r2.stopped));
  }

  // ============ 6) rate limit: film zostaje pending, cooldown, stop po N ====
  {
    const dir = join(shimDir, "jobs3"), cacheDir3 = join(shimDir, "cache3");
    const { clock } = clockStarter();
    const dir429 = mkdtempSync(join(tmpdir(), "yts-429-"));
    const shim429 = makeShim(dir429, { [ID_A]: RULE.e429, [ID_B]: RULE.e429, [ID_C]: RULE.e429 });
    const sleeps = [];
    const sleep = (ms) => { sleeps.push(ms); return Promise.resolve(); };
    const base = { langs: "pl,en", ytdlpPath: shim429, jobDir: dir, cacheDir: cacheDir3, intervalMs: 0, rlStop: 3, clock, sleep, jitter: () => 0, versionProbe: "2099.01.01" };
    createJob({ jobId: "jrl", langs: "pl,en", keywords: [], jobDir: dir, cacheDir: cacheDir3, candidateIds: [ID_A, ID_B, ID_C] });
    const r = await runJob("jrl", base);
    ok("rate_limited: stop po 3 kolejnych (exit 3)", r.stopped && r.stopped.reason === "rate_limited" && r.stopped.exitCode === 3, JSON.stringify(r.stopped));
    const st = loadState(dir, "jrl").state;
    ok("rate_limited: film ZOSTAJE pending (nie failed)", st.videos[ID_A].status === "pending", st.videos[ID_A].status);
    ok("rate_limited: rawTails zapisane", st.videos[ID_A].rawTails.length > 0);
    ok("rate_limited: nie poszedl dalej po zatrzymaniu", !st.videos[ID_B] || st.videos[ID_B].status !== "done", JSON.stringify(st.videos[ID_B] || null));
    ok("backoff: 5 min, potem 10 min (exponential + jitter=0)", sleeps[0] === 300000 && sleeps[1] === 600000, JSON.stringify(sleeps.slice(0, 3)));

    // cooldown i ponowienie TEGO SAMEGO filmu
    const vttManual = ["WEBVTT", "Kind: captions", "Language: pl", ""];
    for (let i = 0; i < 20; i++) vttManual.push(`00:00:${String(i).padStart(2, "0")}.000 --> 00:00:${String(i + 1).padStart(2, "0")}.000`, `to jest tekst reczny ${i} slowo kluczowe rust dla testu`, "");
    const seen = {};
    const fetch = async (id, call) => {
      if (call.approach === "list") {
        seen[id] = (seen[id] || 0) + 1;
        if (id === ID_A && seen[id] === 1) return { tracks: { manual: [], auto: [], failed: true, err: "ERROR: HTTP Error 429: Too Many Requests", code: 1, timedOut: false } };
        return { tracks: { manual: ["pl"], auto: [] } };
      }
      const idx = call.args.indexOf("-o");
      const file = call.args[idx + 1].replace("%(id)s", id).replace("%(lang)s", call.lang).replace("%(ext)s", "vtt");
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, vttManual.join("\n"), "utf8");
      return { code: 0, out: "", err: "", timedOut: false };
    };
    createJob({ jobId: "jcool", langs: "pl,en", keywords: ["rust"], jobDir: dir, cacheDir: cacheDir3, candidateIds: [ID_A, ID_B] });
    const sleeps2 = [];
    const r2 = await runJob("jcool", { ...base, jobId: undefined, sleep: (ms) => { sleeps2.push(ms); return Promise.resolve(); }, fetch });
    ok("cooldown: ten sam film ponowiony i done", loadState(dir, "jcool").state.videos[ID_A].status === "done", JSON.stringify(loadState(dir, "jcool").state.videos[ID_A]));
    ok("cooldown: czekal przed ponowieniem (5 min)", sleeps2[0] === 300000, JSON.stringify(sleeps2.slice(0, 3)));
    ok("cooldown: attempts > 1 dla tego filmu", (loadState(dir, "jcool").state.videos[ID_A].attempts || 0) > 1);
  }

  // ============ 7) unknown/timeout: budzet prob, potem terminal =============
  {
    const dir = join(shimDir, "jobs4"), cacheDir4 = join(shimDir, "cache4");
    const { clock } = clockStarter();
    let lists = 0, dls = 0;
    const fetch = async (id, call) => {
      if (call.approach === "list") { lists++; return { tracks: { manual: ["pl"], auto: [] } }; }
      dls++;
      return { code: 1, out: "", err: "ERROR: something odd happened", timedOut: false };
    };
    createJob({ jobId: "junk", langs: "pl,en", keywords: [], jobDir: dir, cacheDir: cacheDir4, candidateIds: [ID_A] });
    const r = await runJob("junk", { langs: "pl,en", jobDir: dir, cacheDir: cacheDir4, intervalMs: 0, rlStop: 3, clock, sleep: noSleep, jitter: () => 0, versionProbe: "2099.01.01", fetch, attemptBudget: 3 });
    ok("unknown: 3 proby, potem terminal", r.report.failedByReason.unknown === 1 && dls === 3 && lists === 3, `downloads=${dls} lists=${lists}`);
    ok("unknown: rawTails po jednym na probe", loadState(dir, "junk").state.videos[ID_A].rawTails.length === 3);
    const fetch2 = async (id, call) => ({ code: -1, out: "", err: "", timedOut: true, tracks: call.approach === "list" ? { manual: ["pl"], auto: [] } : undefined });
    createJob({ jobId: "jto", langs: "pl,en", keywords: [], jobDir: dir, cacheDir: cacheDir4, candidateIds: [ID_B] });
    const r2 = await runJob("jto", { langs: "pl,en", jobDir: dir, cacheDir: cacheDir4, intervalMs: 0, rlStop: 3, clock, sleep: noSleep, versionProbe: "2099.01.01", fetch: fetch2, attemptBudget: 2 });
    ok("timeout: osobny powod w liscie (D1)", r2.report.failedByReason.timeout === 1, JSON.stringify(r2.report.failedByReason));
    const shimShort = makeShim(mkdtempSync(join(tmpdir(), "yts-short-")), { [ID_C]: RULE.short });
    createJob({ jobId: "jshort", langs: "pl,en", keywords: [], jobDir: dir, cacheDir: cacheDir4, candidateIds: [ID_C] });
    const r3 = await runJob("jshort", { langs: "pl,en", ytdlpPath: shimShort, jobDir: dir, cacheDir: cacheDir4, intervalMs: 0, rlStop: 3, clock, sleep: noSleep, versionProbe: "2099.01.01" });
    ok("za krotki plik: unknown, nie no_subtitles", r3.report.failedByReason.unknown === 1 && !r3.report.failedByReason.no_subtitles, JSON.stringify(r3.report.failedByReason));
  }

  // ============ 8) D10: --refresh i --retry-stopped =========================
  {
    const dir = join(shimDir, "jobs5"), cacheDir5 = join(shimDir, "cache5");
    const { clock } = clockStarter();
    const base = { langs: "pl,en", ytdlpPath: process.env.YT_DLP, jobDir: dir, cacheDir: cacheDir5, intervalMs: 0, rlStop: 3, clock, sleep: noSleep, versionProbe: "2099.01.01" };
    createJob({ jobId: "jd10", langs: "pl,en", keywords: [], jobDir: dir, cacheDir: cacheDir5, candidateIds: [ID_A, ID_F, ID_C] });
    await runJob("jd10", base);
    const rep0 = buildReport(loadState(dir, "jd10").state, { cacheDir: cacheDir5 });
    ok("setup D10: done + failed bot_check + nieruszony pending", rep0.videos.find((v) => v.id === ID_A).status === "done" && rep0.videos.find((v) => v.id === ID_F).status === "failed" && rep0.videos.find((v) => v.id === ID_C).status === "pending", rep0.videos.map((v) => [v.id, v.status]).join(" "));
    // --refresh: done idzie do ponownego pobrania, failed zostaje
    const dl0 = spawnCount(shimDir, "download");
    const r = await runJob("jd10", { ...base, refresh: true });
    ok("refresh: done ponowione (nowe pobranie)", spawnCount(shimDir, "download") > dl0, `${dl0} -> ${spawnCount(shimDir, "download")}`);
    const repR = r.report;
    ok("refresh: failed bot_check nietkniety", repR.videos.find((v) => v.id === ID_F).status === "failed" && repR.videos.find((v) => v.id === ID_F).reason === "bot_check");
    ok("refresh: pending tez pobierany (jak kazdy resume)", repR.videos.find((v) => v.id === ID_C).status === "failed");
    // --retry-stopped: tylko bot_check/proxy_error; done i no_subtitles nietknięte
    const sp1 = spawnCount(shimDir);
    await runJob("jd10", { ...base, retryStopped: true });
    ok("retry-stopped: bot_check ponowiony (kolejna proba)", spawnCount(shimDir) > sp1, `${sp1} -> ${spawnCount(shimDir)}`);
    ok("retry-stopped: no_subtitles terminalny, nietkniety", loadState(dir, "jd10").state.videos[ID_C].status === "failed" && loadState(dir, "jd10").state.videos[ID_C].reason === "no_subtitles");
    ok("retry-stopped: done nietkniety", loadState(dir, "jd10").state.videos[ID_A].status === "done");
    ok("retry-stopped: rekord bot_check ma attempts > 1", loadState(dir, "jd10").state.videos[ID_F].attempts > 1, String(loadState(dir, "jd10").state.videos[ID_F].attempts));
  }
  // ============ 9) staleness (D2/D4) ========================================
  {
    const dir = join(shimDir, "jobs6"), cacheDir6 = join(shimDir, "cache6");
    const { clock } = clockStarter();
    const base = { langs: "pl,en", ytdlpPath: process.env.YT_DLP, jobDir: dir, cacheDir: cacheDir6, intervalMs: 0, rlStop: 3, clock, sleep: noSleep, versionProbe: "2099.01.01" };
    createJob({ jobId: "jstale", langs: "pl,en", keywords: [], jobDir: dir, cacheDir: cacheDir6, candidateIds: [ID_A] });
    await runJob("jstale", base);
    const r = await runJob("jstale", { ...base, langs: "en,pl" });
    const st = loadState(dir, "jstale").state;
    ok("stale: inna kolejnosc jezykow -> done -> stale (D4)", st.videos[ID_A].status === "stale" && st.videos[ID_A].staleReason === "fingerprint", JSON.stringify(st.videos[ID_A]));
    ok("stale: rekord raportowany jako stale", r.report.videos[0].status === "stale");
    // --require-same-version: inna wersja yt-dlp -> stale
    await runJob("jstale", { ...base, langs: "pl,en", refresh: true });
    const r2 = await runJob("jstale", { ...base, langs: "pl,en", requireSameVersion: true, versionProbe: "2099.02.02" });
    ok("stale: inna wersja yt-dlp + --require-same-version -> stale", loadState(dir, "jstale").state.videos[ID_A].status === "stale", loadState(dir, "jstale").state.videos[ID_A].status);
    ok("stale: bez flagi wersja nie rozstrzyga", (await runJob("jstale", { ...base, langs: "pl,en", refresh: true, versionProbe: "2099.02.02" })).report.obtained === 1);
    // znikniety plik cache -> stale, ale tylko po --refresh (wraca do done)
    await runJob("jstale", { ...base, langs: "pl,en", refresh: true });
    const st3 = loadState(dir, "jstale").state;
    st3.videos[ID_A].status = "done";
    saveState(join(dir, "jstale", "state.json"), st3);
    const cacheFile = join(cacheDir6, "subs", `${ID_A}.pl.manual.p1.txt`);
    if (existsSync(cacheFile)) rmSyncSync(cacheFile);
    await runJob("jstale", { ...base, langs: "pl,en" });
    ok("stale: znikniety plik cache -> stale (autorytet cache)", loadState(dir, "jstale").state.videos[ID_A].status === "stale", loadState(dir, "jstale").state.videos[ID_A].staleReason);
  }

  // ============ 10) prosba o stop ===========================================
  {
    const dir = join(shimDir, "jobs7"), cacheDir7 = join(shimDir, "cache7");
    const { clock } = clockStarter();
    const base = { langs: "pl,en", ytdlpPath: process.env.YT_DLP, jobDir: dir, cacheDir: cacheDir7, intervalMs: 0, rlStop: 3, clock, sleep: noSleep, versionProbe: "2099.01.01" };
    createJob({ jobId: "jstop", langs: "pl,en", keywords: [], jobDir: dir, cacheDir: cacheDir7, candidateIds: [ID_A, ID_B] });
    let stopCalls = 0;
    const stopFetch = async (id, call) => { stopCalls++; if (stopCalls === 1) requestStop(dir, "jstop"); return { tracks: { manual: ["pl"], auto: [] } }; };
    const r = await runJob("jstop", { ...base, fetch: stopFetch });
    ok("stop: czystowe zakonczenie (exit 0)", r.stopped && r.stopped.reason === "user_stop" && r.stopped.exitCode === 0, JSON.stringify(r.stopped));
    ok("stop: stan zamkniety, lease zwolniony", loadState(dir, "jstop").state.finished === true && !existsSync(join(dir, "jstop.lease.json")));
    ok("stop: prosba zuzyta po starcie", !isStopRequested(dir, "jstop"));
    createJob({ jobId: "jstop2", langs: "pl,en", keywords: [], jobDir: dir, cacheDir: cacheDir7, candidateIds: [ID_A, ID_B] });
    let calls = 0;
    const fetch = async (id, call) => { calls++; if (calls === 3) requestStop(dir, "jstop2"); return { tracks: { manual: ["pl"], auto: [] } }; };
    await runJob("jstop2", { ...base, fetch });
    ok("stop w trakcie: runner konczy po bierzacym filmie", loadState(dir, "jstop2").state.stopped === "user_stop", String(loadState(dir, "jstop2").state.stopped));
    // stopJob: zywy lease -> prosba; martwy -> nic
    const release = acquireLease(dir, "jstop2");
    const s = stopJob(dir, "jstop2");
    ok("stopJob: zywy lease -> prosba o stop", s.running === true);
    release();
    ok("stopJob: martwy lease -> nic do zatrzymania", stopJob(dir, "jstop2").running === false);
  }

  // ============ 11) raport offline: nowe slowa, zero ruchu sieciowego =======
  {
    const dir = join(shimDir, "jobs8"), cacheDir8 = join(shimDir, "cache8");
    const { clock } = clockStarter();
    const base = { langs: "pl,en", ytdlpPath: process.env.YT_DLP, jobDir: dir, cacheDir: cacheDir8, intervalMs: 0, rlStop: 3, clock, sleep: noSleep, versionProbe: "2099.01.01" };
    createJob({ jobId: "jrep", langs: "pl,en", keywords: ["rust"], jobDir: dir, cacheDir: cacheDir8, candidateIds: [ID_A, ID_B] });
    await runJob("jrep", base);
    const spawnsBefore = spawnCount(shimDir);
    const { state } = loadState(dir, "jrep");
    const report = buildReport(state, { cacheDir: cacheDir8, keywords: ["rust", "tekst", "nienot"] });
    ok("raport: kandydaci vs z napisami vs bez napisow", report.candidates === 2 && report.obtained === 2);
    const rust = report.keywords.find((k) => k.keyword === "rust");
    ok("raport: trafienia liczone z cache", rust.count > 0, `count=${rust.count}`);
    ok("raport: max 5 kontekstow", rust.contexts.length <= 5 && rust.contexts.length > 0);
    ok("raport: brak trafienia = 0, nie pusta lista", report.keywords.find((k) => k.keyword === "nienot").count === 0);
    ok("raport: zero spawnow przy nowych slowach (Goal 9)", spawnCount(shimDir) === spawnsBefore);
    ok("raport: pola schematu", ["jobId", "createdAt", "finishedAt", "finished", "candidates", "obtained", "failedByReason", "quotaSpentUnits", "elapsedMs", "ytdlpVersions", "langOrder", "keywords", "videos"].every((k) => k in report));
    ok("raport: pola per video", ["id", "title", "channel", "url", "status", "reason", "lang", "kind", "chars", "cachePath", "fetchedAt"].every((k) => k in report.videos[0]));
    ok("raport: zrodlo bez tytulow -> title null", report.videos[0].title === null);
    ok("raport: ytdlpVersions z rekordow", report.ytdlpVersions.includes("2099.01.01"));
    ok("raport: values cache nigdy w failedByReason", !Object.keys(report.failedByReason).some((x) => ["ok", "stale", "missing", "raw_missing"].includes(x)));
    ok("raport: summary ma liczniki", reportSummary(report).includes("kandydaci=2") && reportSummary(report).includes("z napisami=2"));
    ok("raport: zapis do .cache/reports", existsSync(writeReportFile(cacheDir8, "jrep", report)));
    // job z samymi nieudanymi: 0 transcriptow, N failed — nigdy pusta lista
    createJob({ jobId: "jrep0", langs: "pl,en", keywords: ["rust"], jobDir: dir, cacheDir: cacheDir8, candidateIds: [ID_C, ID_D] });
    const r0 = await runJob("jrep0", base);
    const rep0 = buildReport(loadState(dir, "jrep0").state, { cacheDir: cacheDir8, keywords: ["rust"] });
    ok("raport: 0 transcriptow z mianownikiem (Goal 3)", rep0.obtained === 0 && rep0.failedByReason.no_subtitles === 1 && rep0.failedByReason.video_unavailable === 1 && rep0.keywords[0].count === 0, JSON.stringify(rep0.failedByReason));
  }

  // ============ 12) repair ==================================================
  {
    const dir = join(shimDir, "jobs8"), cacheDir8 = join(shimDir, "cache8");
    const st = loadState(dir, "jrep").state;
    const doneId = Object.keys(st.videos).find((id) => st.videos[id].status === "done");
    const p = join(cacheDir8, "subs", `${doneId}.pl.manual.p1.txt`);
    if (existsSync(p)) rmSyncSync(p);
    const cases = repair(dir, cacheDir8, "jrep");
    ok("repair: done bez pliku -> stale", cases.doneToStale === 1, JSON.stringify(cases));
    ok("repair: rekord ma status stale", loadState(dir, "jrep").state.videos[doneId].status === "stale");
    const cases2 = repair(dir, cacheDir8, "jrep");
    ok("repair: stale nie ruszony", cases2.staleUntouched === 1 && cases2.doneToStale === 0, JSON.stringify(cases2));
  }

  // ============ 13) CLI (proces, offline) ===================================
  {
    const dir = join(shimDir, "jobs8"), cacheDir8 = join(shimDir, "cache8");
    const env = { ...process.env, YT_DLP: process.env.YT_DLP, YTS_SKIP_PROBE: "1" };
    const run = (args) => spawnSync("node", [join(ROOT, "yts-job.mjs"), ...args], { encoding: "utf8", env });
    let r = run(["status", "jrep", "--job-dir", dir, "--cache-dir", cacheDir8]);
    ok("CLI status: exit 0 + JSON", r.status === 0 && JSON.parse(r.stdout).jobId === "jrep", String(r.status));
    r = run(["report", "jrep", "--keywords", "rust", "--job-dir", dir, "--cache-dir", cacheDir8]);
    ok("CLI report: exit 0 + keywords", r.status === 0 && JSON.parse(r.stdout).keywords.some((k) => k.keyword === "rust"), String(r.status));
    ok("CLI report: raport zapisany na dysku", existsSync(join(cacheDir8, "reports", "jrep.json")));
    r = run(["stop", "jrep", "--job-dir", dir]);
    ok("CLI stop: nie uruchomiony -> exit 0", r.status === 0 && /nie jest uruchomiony/.test(r.stderr), `${r.status}`);
    r = run(["repair", "jrep", "--job-dir", dir, "--cache-dir", cacheDir8]);
    ok("CLI repair: exit 0 + JSON", r.status === 0 && typeof JSON.parse(r.stdout).staleUntouched === "number");
    r = run(["new", "--id", ID_A, "--keywords", "x", "--job-dir", join(shimDir, "jobs9")]);
    ok("CLI new: brak --langs -> exit 1", r.status === 1 && /--langs/.test(r.stderr));
    r = run(["new", "--id", ID_A, "--langs", "pl", "--keywords", "x", "--proxy", "http://u:p@h:1", "--job-dir", join(shimDir, "jobs9")]);
    ok("CLI new: --proxy zabroniony (D6)", r.status === 1 && /--proxy/.test(r.stderr));
    r = run(["new", "--id", ID_A, "--langs", "pl", "--keywords", "x", "--nie-ma-takiej", "--job-dir", join(shimDir, "jobs9")]);
    ok("CLI new: nieznana flaga -> exit 1", r.status === 1 && /nieznana flaga/.test(r.stderr));
    r = run(["new", "--id", "tooShort", "--langs", "pl", "--keywords", "x", "--job-dir", join(shimDir, "jobs9")]);
    ok("CLI new: nieprawidlowe ID -> exit 1", r.status === 1 && /nieprawidlowe ID/.test(r.stderr));
    r = run(["new", "--id", ID_A, "--langs", "pl", "--keywords", "x", "--job-dir", join(shimDir, "jobs9"), "--cache-dir", join(shimDir, "cache9")]);
    ok("CLI new: tworzy job i konczy go", r.status === 0 && /z napisami=1/.test(r.stderr), r.stderr.slice(-160));
    r = run(["resume", "nie-ma-takiego", "--job-dir", join(shimDir, "jobs9")]);
    ok("CLI resume: nieistniejacy job -> exit 4", r.status === 4, String(r.status));
    r = run(["resume", "jrep", "--job-dir", dir, "--cache-dir", cacheDir8, "--refresh"]);
    ok("CLI resume --refresh: exit 0", r.status === 0 && /refresh/.test(r.stderr), r.stderr.slice(0, 200));
    r = run(["resume", "jrep", "--job-dir", dir, "--cache-dir", cacheDir8, "--refresh", "--retry-stopped"]);
    ok("CLI resume: refresh + retry-stopped -> exit 1 (D10)", r.status === 1);
  }

  // ============ 14) discovery: cztery źródła, filtry, quota (D8/D13/D15) ====
  {
    const { parseFilters, resolveCandidates, discoverSearch, discoverPlaylist, discoverChannel, captionPreFilter } = await import("../lib/ytsub-discover.mjs");
    // API fixture: trzy strony search, strona playlisty, kanał z uploadami
    const calls = [];
    const fixture = (url) => {
      calls.push(url);
      const u = new URL(url);
      const path = u.pathname;
      const page = Number(u.searchParams.get("pageToken") || "0");
      const ids = ["AAAAAAAAAAA", "BBBBBBBBBBB", "CCCCCCCCCCC", "DDDDDDDDDDD", "EEEEEEEEEEE", "FFFFFFFFFFF", "GGGGGGGGGGG", "HHHHHHHHHHH", "IIIIIIIIIII", "JJJJJJJJJJJ", "KKKKKKKKKKK", "LLLLLLLLLLL"];
      const mkItems = (n, kind) => Array.from({ length: n }, (_, i) => kind === "playlist"
        ? { snippet: { resourceId: { videoId: ids[i] }, title: `film ${i}` } }
        : { id: { videoId: ids[i] }, snippet: { title: `film ${i}` } });
      if (path.endsWith("/search")) {
        return { items: mkItems(50, "search"), nextPageToken: page === 0 ? "2" : (page === 1 ? "3" : null) };
      }
      if (path.endsWith("/playlistItems")) return { items: mkItems(50, "playlist"), nextPageToken: page === 0 ? "2" : null };
      if (path.endsWith("/channels")) return { items: [{ contentDetails: { relatedPlaylists: { uploads: "UUuploads" } }, snippet: { title: "Kanal Testowy" } }] };
      if (path.endsWith("/videos")) return { items: ids.slice(0, 3).map((id) => ({ id, contentDetails: { caption: "true" } })) };
      throw new Error("fixture: nieznana sciezka " + path);
    };
    const optsBase = { apiKey: "KEY", apiBase: "https://api.invalid/v3", fetchJson: fixture, budgetUnits: 2000 };
    // filtry
    const pf = parseFilters(["videoCaption=closedCaption", "order=date", "regionCode=PL"]);
    ok("filtry: poprawne parsowanie", JSON.stringify(pf.filters) === JSON.stringify({ videoCaption: "closedCaption", order: "date", regionCode: "PL" }) && pf.errors.length === 0, JSON.stringify(pf));
    ok("filtry: nieznany klucz -> blad", parseFilters(["nieMaTakiego=1"]).errors.length === 1);
    ok("filtry: brak wartosci -> blad", parseFilters(["order"]).errors.length === 1);
    ok("filtry: zla wartosc videoCaption -> blad", parseFilters(["videoCaption=moze"]).errors.length === 1);
    // search: dwie strony po 50, max 100
    const r1 = await discoverSearch("prezydent", pf.filters, 100, optsBase);
    ok("search: 2 strony = 200 jednostek", r1.apiUnits === 200 && r1.pages === 2, `units=${r1.apiUnits}`);
    ok("search: kandydaci po limicie", r1.ids.length === 12, String(r1.ids.length));
    ok("search: max 100 (D8)", (await discoverSearch("x", {}, 500, optsBase)).ids.length <= 12);
    ok("search: titleByVideo", r1.titles["AAAAAAAAAAA"] === "film 0");
    // channel: channels.list 1 + playlistItems 1
    const r2 = await discoverChannel("@handle", 3, optsBase);
    ok("channel: uploads zamiast kanalu", r2.type === "channel" && r2.ids.length === 3, JSON.stringify([r2.type, r2.ids.length]));
    // playlist
    const r3 = await discoverPlaylist("PL123", 3, optsBase);
    ok("playlist: 3 filmy", r3.type === "playlist" && r3.ids.length === 3);
    // pre-filtr: 1 jednostka za 50, zostawia tylko filmy z napisami
    const r4 = await captionPreFilter(["AAAAAAAAAAA", "ZZZZZZZZZZZ"], optsBase);
    ok("pre-filtr: zostawia filmy z napisami", r4.ids.length === 1 && r4.apiUnits === 1, JSON.stringify(r4));
    // resolveCandidates: jedno źródło, ID bez klucza
    const r5 = await resolveCandidates({ ids: ["AAAAAAAAAAA", "tooShort"] }, {});
    ok("ids: zrodlo bez klucza API", r5.candidates.length === 1 && r5.sources[0].type === "ids");
    // D13: search bez klucza -> exit 5
    let threw = null;
    try { await resolveCandidates({ search: "x", filters: {} }, {}); } catch (e) { threw = e; }
    ok("D13: --search bez klucza -> exit 5", threw && threw.exitCode === 5, threw && threw.message);
    // D15: quota zatrzymuje zamiast cichego fallbacku
    let threw2 = null;
    try { await resolveCandidates({ search: "x", filters: {} }, { apiKey: "K", budgetUnits: 50 }); } catch (e) { threw2 = e; }
    ok("D15: quota -> exit 4 (bez fallbacku na yt-dlp)", threw2 && threw2.exitCode === 4, threw2 && threw2.message);
    // pickSource
    ok("pickSource: dwa źródła -> blad", /dokladnie jedno/.test(pickSource({ search: "x", ids: ["AAAAAAAAAAA"] }).error || ""));
    ok("pickSource: brak źródła -> blad", /brak zrodla/.test(pickSource({ ids: [] }).error || ""));
  }

  // ============ 15) CLI: dry-run, doctor, źródła (offline, fixture API) ===
  {
    const dir = join(shimDir, "jobs10"), cacheDir10 = join(shimDir, "cache10");
    // uruchom fixture serwerem HTTP na losowym porcie (CLI czyta YTS_API_BASE)
    const fixturePath = join(shimDir, "api-fixture.mjs");
    writeFileSync(fixturePath, `
import { createServer } from "node:http";
const ids = ["AAAAAAAAAAA","BBBBBBBBBBB","CCCCCCCCCCC","DDDDDDDDDDD","EEEEEEEEEEE","FFFFFFFFFFF","GGGGGGGGGGG","HHHHHHHHHHH","IIIIIIIIIII","JJJJJJJJJJJ","KKKKKKKKKKK","LLLLLLLLLLL"];
createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  res.setHeader("content-type", "application/json");
  if (u.pathname.endsWith("/search")) {
    res.end(JSON.stringify({ items: ids.map((id) => ({ id: { videoId: id }, snippet: { title: "film " + id } })), nextPageToken: u.searchParams.get("pageToken") === "1" ? "2" : null }));
    return;
  }
  if (u.pathname.endsWith("/playlistItems")) {
    res.end(JSON.stringify({ items: ids.map((id) => ({ snippet: { resourceId: { videoId: id }, title: "film" } })) }));
    return;
  }
  if (u.pathname.endsWith("/channels")) {
    res.end(JSON.stringify({ items: [{ contentDetails: { relatedPlaylists: { uploads: "UU" } }, snippet: { title: "K" } }] }));
    return;
  }
  res.statusCode = 404; res.end("{}");
}).listen(0, "127.0.0.1", function () {
  process.stdout.write("PORT " + this.address().port + "\\n");
  setInterval(() => {}, 1000);
});
`, "utf8");
    const srv = spawn("node", [fixturePath], { stdio: ["ignore", "pipe", "ignore"] });
    let port = "";
    await new Promise((resolve) => {
      srv.stdout.on("data", (d) => {
        const m = String(d).match(/PORT (\d+)/);
        if (m) { port = m[1]; resolve(); }
      });
      setTimeout(resolve, 3000);
    });
    ok("CLI fixture: serwer API wstał", !!port, String(port));
    const env = { ...process.env, YT_DLP: process.env.YT_DLP, YTS_SKIP_PROBE: "1", YOUTUBE_API_KEY: "TESTKEY", YTS_API_BASE: `http://127.0.0.1:${port}/v3` };
    const run = (args) => spawnSync("node", [join(ROOT, "yts-job.mjs"), ...args], { encoding: "utf8", env });
    let r = run(["new", "--search", "prezydent polski", "--langs", "pl,en", "--keywords", "nawrocki", "--max-videos", "3", "--dry-run", "--job-dir", dir, "--cache-dir", cacheDir10]);
    ok("CLI dry-run: exit 0", r.status === 0, r.stderr.slice(0, 200));
    ok("CLI dry-run: nie tworzy joba", !existsSync(join(dir, dir)), "brak joba");
    let dry = null;
    try { dry = JSON.parse(r.stdout); } catch {}
    ok("CLI dry-run: kandydaci + jednostki w JSON", !!dry && dry.dryRun === true && dry.candidates === 3 && dry.apiUnits === 100, r.stdout.slice(0, 160));
    ok("CLI dry-run: komunikat o braku pobran", /dry-run: zadne pobranie/.test(r.stderr), r.stderr.slice(0, 200));
    r = run(["new", "--search", "x", "--langs", "pl", "--keywords", "a", "--max-videos", "3", "--interval-ms", "0", "--rl-stop", "2", "--job-dir", join(shimDir, "jobs11"), "--cache-dir", cacheDir10]);
    ok("CLI new --search: z kluczem tworzy job z discovery", r.status === 0 && /kandydatow/.test(r.stderr), r.stderr.slice(0, 200));
    const envNoKey = { ...env, YOUTUBE_API_KEY: "" };
    const rNoKey = spawnSync("node", [join(ROOT, "yts-job.mjs"), "new", "--search", "x", "--langs", "pl", "--keywords", "a", "--job-dir", join(shimDir, "jobs12"), "--cache-dir", cacheDir10], { encoding: "utf8", env: envNoKey });
    ok("CLI new --search: bez klucza -> exit 5 (D13)", rNoKey.status === 5, String(rNoKey.status) + " " + rNoKey.stderr.slice(0, 120));
    r = run(["doctor"]);
    ok("CLI doctor: exit 0 + JSON", r.status === 0 && !!JSON.parse(r.stdout).ytDlpPath, r.stderr.slice(0, 120));
    const doc = JSON.parse(r.stdout);
    ok("doctor: kazde ustawienie ma pochodzenie", ["ytDlpPath", "proxy", "cookiesFile", "jobDir", "intervalMs"].every((k) => doc[k] && doc[k].origin), JSON.stringify(Object.keys(doc)));
    ok("doctor: caps i jednostki", doc.caps.youtube_search === 25 && doc.units.search === 100);
    r = run(["new", "--search", "x", "--channel", "UC123", "--langs", "pl", "--keywords", "a", "--job-dir", dir]);
    ok("CLI new: dwa zrodla -> exit 1", r.status === 1 && /dokladnie jedno/.test(r.stderr), r.stderr.slice(0, 140));
    r = run(["new", "--channel", "UC123", "--langs", "pl", "--keywords", "a", "--job-dir", dir]);
    ok("CLI new: channel bez --max-videos -> exit 1", r.status === 1 && /--max-videos/.test(r.stderr), r.stderr.slice(0, 140));
    srv.kill();
  }


  // ============ 16) one-shot CLI: --search na shimie (Goal 2, D9) =========
  {
    const shimSearch = makeShim(mkdtempSync(join(tmpdir(), "yts-srch-")), { [ID_A]: RULE.manual, [ID_B]: RULE.eUnavail });
    const r = spawnSync("node", [join(ROOT, "youtube-transcripts.mjs"), "--search", "prezydent", "--limit", "2", "--keywords", "rust", "--langs", "pl"], { encoding: "utf8", env: { ...process.env, YT_DLP: shimSearch, YOUTUBE_SEARCH_BACKEND: "yt-dlp" } });
    ok("CLI --search: exit 0", r.status === 0, String(r.status) + " " + r.stderr.slice(0, 200));
    let arr = null;
    try { arr = JSON.parse(r.stdout); } catch {}
    ok("CLI --search: zwraca wpisy", !!arr && arr.length === 2, String(arr && arr.length));
    ok("CLI --search: kazdy wpis ma reason (Goal 2)", !!arr && arr.every((v) => "reason" in v && (v.reason === null || typeof v.reason === "string")), JSON.stringify(arr && arr.map((v) => v.reason)));
    ok("CLI --search: mianowniki na stderr", /kandydaci=2/.test(r.stderr) && /z napisami=/.test(r.stderr) && /bez napis/.test(r.stderr), r.stderr.trim().split("\n").pop());
    ok("CLI --search: lang jako kod jezyka (nie vtt)", !!arr && arr.every((v) => v.transcriptAvailable === false || typeof v.lang === "string"), JSON.stringify(arr && arr.map((v) => v.lang)));
    ok("CLI --search: kind na wpisach z napisami", !!arr && arr.filter((v) => v.transcriptAvailable).every((v) => typeof v.kind === "string"), JSON.stringify(arr && arr.map((v) => v.kind)));
    ok("CLI --search: reason niszy niz reason z yt-dlp (bez pustego wyniku)", !!arr && arr.some((v) => v.reason === "video_unavailable"), JSON.stringify(arr && arr.map((v) => v.reason)));
  }

  rmSyncSync(shimDir);
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log("FAILURES:\n" + failures.join("\n")); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error("test crash:", e); process.exit(1); });

function rmSyncSync(p) { try { rmSync(p, { recursive: true, force: true }); } catch {} }
