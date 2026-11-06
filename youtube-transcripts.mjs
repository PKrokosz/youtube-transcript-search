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
import { join, delimiter } from "node:path";

// Szukamy yt-dlp: najpierw env, potem PATH, potem typowe miejsca instalacji.
function findYtDlp() {
  if (process.env.YT_DLP) return process.env.YT_DLP;
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
const TMP = process.env.TMP || tmpdir();

function run(args, opts = {}) {
  const timeoutMs = opts.timeoutMs || 180000;
  return new Promise((resolve) => {
    const child = spawn(YT_DLP, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "", done = false;
    const timer = setTimeout(() => { try { child.kill(); } catch (e) {} }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => { if (done) return; done = true; clearTimeout(timer); resolve({ code: -1, out, err: String(e) }); });
    child.on("close", (code) => { if (done) return; done = true; clearTimeout(timer); resolve({ code, out, err }); });
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
    else if (k === "--raw") a.raw = true;
  }
  return a;
}

// --- wyszukiwanie filmów (ytsearch) -------------------------------------
export async function youtubeSearch(query, limit = 5) {
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

// --- pobranie transkrypcji ----------------------------------------------
export async function youtubeTranscript(videoId, langs = "en") {
  const dir = mkdtempSync(join(TMP, "ytsubs-"));
  const target = join(dir, `s.%(id)s.%(ext)s`);
  let lastErr = "";
  try {
    // YouTube rate-limituje (429) - próbujemy kilka razy z rosnącą przerwą.
    for (let attempt = 1; attempt <= 3; attempt++) {
      const res = await run([
        "--skip-download", "--write-subs", "--write-auto-subs",
        "--sub-langs", langs, "--sub-format", "vtt",
        "--no-warnings", "--no-playlist", "--retries", "3", "--sleep-requests", "2",
        "-o", target, `https://www.youtube.com/watch?v=${videoId}`,
      ]);
      const files = readdirSync(dir).filter((f) => f.endsWith(".vtt"));
      if (files.length) {
        const raw = readFileSync(join(dir, files[0]), "utf8");
        return { videoId, ok: true, lang: files[0].split(".").pop(), text: vttToText(raw), segments: vttToSegments(raw) };
      }
      lastErr = (res.err || "").split("\n").filter((l) => /ERROR/.test(l)).slice(-1)[0] || `yt-dlp exit ${res.code}`;
      if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 4000));
    }
    return { videoId, ok: false, error: lastErr || "brak napisów (subs) dla tego filmu", text: "", segments: [] };
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  }
}

// --- parsowanie VTT (YouTube: auto-napisy toczące się okno tekstu) -------
function decodeEntities(s) {
  return s
    .replace(/</g, "<").replace(/>/g, ">").replace(/"/g, '"')
    .replace(/'/g, "'").replace(/&apos;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/&/g, "&");
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

function vttToText(vtt) {
  return dedupeCues(parseCues(vtt)).map((c) => c.text).join(" ").replace(/\s+/g, " ").trim();
}

function vttToSegments(vtt) {
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
export async function searchTranscripts(query, keywords, limit = 5, langs = "en") {
  const videos = await youtubeSearch(query, limit);
  const out = [];
  for (const v of videos) {
    const t = await youtubeTranscript(v.id, langs);
    out.push({
      id: v.id,
      title: v.title,
      channel: v.channel,
      url: `https://www.youtube.com/watch?v=${v.id}`,
      transcriptAvailable: t.ok,
      transcriptError: t.ok ? undefined : t.error,
      transcriptLength: t.text.length,
      keywords: t.ok ? findKeywords(t.text, keywords) : [],
    });
  }
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
    const res = await searchTranscripts(a.search, a.keywords, a.limit, a.langs);
    console.log(JSON.stringify(res, null, 2));
    process.exit(0);
  }
  console.error("Użycie: --search <fraza> | --video <id> | --url <link>  (opcjonalnie --keywords a,b --limit N --raw)");
  process.exit(1);
}