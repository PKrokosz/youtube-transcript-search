#!/usr/bin/env node
// E2E: narzędzia YouTube (search + transkrypcje + wyszukiwanie słów kluczowych)
// przez wrapper MCP.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const child = spawn("node", [join(HERE, "mcp-server.mjs")], { stdio: ["pipe","pipe","pipe"] });
const rl = createInterface({ input: child.stdout });
const pending = new Map();
let nextId = 1;
let stderr = "";
child.stderr.on("data", (d) => { stderr += d.toString(); });
rl.on("line", (line) => {
  line = line.trim(); if (!line) return;
  try { const m = JSON.parse(line); if (m.id !== undefined && pending.has(m.id)) { const {resolve}=pending.get(m.id); pending.delete(m.id); resolve(m); } } catch(e){}
});
function send(method,params){const id=nextId++;const msg={jsonrpc:"2.0",id,method,params:params||{}};child.stdin.write(JSON.stringify(msg)+"\n");return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});setTimeout(()=>{if(pending.has(id)){pending.delete(id);reject(new Error("timeout "+method));}},240000);});}
function notify(m,p){child.stdin.write(JSON.stringify({jsonrpc:"2.0",method:m,params:p||{}})+"\n");}
function textOf(res){ const c = res.result && res.result.content; return c && c[0] ? c[0].text : ""; }

const report = { steps: [], errors: [] };
function step(name, ok, detail) {
  report.steps.push({ name, ok, detail });
  console.log("[" + (ok ? "PASS" : "FAIL") + "] " + name + (detail ? " :: " + String(detail).slice(0, 250) : ""));
}

(async () => {
  try {
    const init = await send("initialize",{protocolVersion:"2024-11-05",capabilities:{},clientInfo:{name:"yt-e2e",version:"1.0.0"}});
    step("initialize", !!init.result, init.error ? JSON.stringify(init.error) : "ok");
    notify("notifications/initialized",{});

    const list = await send("tools/list",{});
    const names = (list.result.tools||[]).map(t=>t.name);
    step("tools/list", names.length>0, "count="+names.length);
    step("youtube_search listed", names.includes("youtube_search"), "");
    step("youtube_transcript listed", names.includes("youtube_transcript"), "");
    step("youtube_transcript_search listed", names.includes("youtube_transcript_search"), "");

    const s = await send("tools/call",{name:"youtube_search",arguments:{query:"rust headless browser",limit:3}});
    const videos = JSON.parse(textOf(s));
    step("youtube_search", Array.isArray(videos)&&videos.length>0, "found="+(videos.length||0)+" first="+(videos[0]&&videos[0].id));

    const t = await send("tools/call",{name:"youtube_transcript",arguments:{video:"gYU9-dVdgkA",keywords:["rust","obscura"],maxChars:400}});
    const tr = JSON.parse(textOf(t));
    step("youtube_transcript", !!tr.videoId && tr.length>500, "len="+tr.length+" lang="+tr.lang);
    const rustHit = (tr.keywords||[]).find(k=>k.keyword==="rust");
    step("youtube_transcript keyword rust", !!rustHit && rustHit.count>0, rustHit ? "count="+rustHit.count : "no hit");

    const ts = await send("tools/call",{name:"youtube_transcript_search",arguments:{query:"rust headless browser for AI agents",keywords:["rust"],limit:2}});
    const arr = JSON.parse(textOf(ts));
    const withHits = arr.filter(v=>v.transcriptAvailable && (v.keywords||[]).some(k=>k.count>0));
    step("youtube_transcript_search", arr.length>0, "videos="+arr.length+" withHits="+withHits.length);
    if (arr[0]) console.log("   ->", arr[0].title, "| transcript:", arr[0].transcriptAvailable, "| len:", arr[0].transcriptLength);
  } catch(e) {
    report.errors.push(String(e&&e.stack||e));
    step("exception", false, String(e));
  } finally {
    try { child.kill(); } catch(e){}
    report.stderr = stderr.slice(0,1500);
    writeFileSync(join(HERE, "e2e-youtube-report.json"), JSON.stringify(report,null,2));
    console.log("\nReport written.");
    process.exit(report.steps.some(s=>!s.ok)?1:0);
  }
})();