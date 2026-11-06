#!/usr/bin/env node
// youtube-transcript-search — serwer MCP (stdio) z narzędziami YouTube.
//
// Narzędzia:
//   youtube_search             — filmy po frazie
//   youtube_transcript        — transkrypcja jednego filmu (+ opcjonalne trafienia słów)
//   youtube_transcript_search — przeszukiwanie transkrypcji pod kątem słów kluczowych
//
// Uruchomienie:  node mcp-server.mjs
// Konfiguracja klienta (Claude Desktop / OpenCode):
//   { "mcpServers": { "youtube-transcript-search": {
//       "command": "node", "args": ["<absolutna ścieżka>/mcp-server.mjs"] } } }

import { createInterface } from "node:readline";
import { youtubeSearch, youtubeTranscript, searchTranscripts, findKeywords } from "./youtube-transcripts.mjs";

const TOOLS = [
  {
    name: "youtube_search",
    description: "Search videos on YouTube by keyword. Returns video ids, titles and channels.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search phrase" },
        limit: { type: "number", description: "Max videos (default 5, max 25)" },
      },
      required: ["query"],
    },
  },
  {
    name: "youtube_transcript",
    description: "Fetch the transcript (auto or manual captions) of a YouTube video. Pass video id or full URL.",
    inputSchema: {
      type: "object",
      properties: {
        video: { type: "string", description: "YouTube video id or watch URL" },
        langs: { type: "string", description: "Caption languages, comma separated (default 'en')" },
        keywords: { type: "array", items: { type: "string" }, description: "Optional keywords to highlight in the transcript" },
        maxChars: { type: "number", description: "Truncate transcript to this many characters (default 8000, 0 = full)" },
      },
      required: ["video"],
    },
  },
  {
    name: "youtube_transcript_search",
    description:
      "Find YouTube videos whose transcripts contain given keywords. Searches videos by query, downloads captions and reports keyword hits with context.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to search on YouTube" },
        keywords: { type: "array", items: { type: "string" }, description: "Words to look for inside transcripts" },
        limit: { type: "number", description: "Max videos to inspect (default 5, max 15)" },
        langs: { type: "string", description: "Caption languages (default 'en')" },
      },
      required: ["query", "keywords"],
    },
  },
];

function text(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function idFrom(video) {
  const s = String(video || "").trim();
  const m = s.match(/[?&]v=([\w-]+)/);
  return m ? m[1] : s;
}

async function callTool(name, args) {
  if (name === "youtube_search") {
    return youtubeSearch(args.query, Math.min(args.limit || 5, 25));
  }
  if (name === "youtube_transcript") {
    const id = idFrom(args.video);
    const t = await youtubeTranscript(id, args.langs || "en");
    if (!t.ok) throw new Error(t.error);
    const max = args.maxChars === 0 ? t.text.length : args.maxChars || 8000;
    return {
      videoId: id,
      url: `https://www.youtube.com/watch?v=${id}`,
      lang: t.lang,
      length: t.text.length,
      segments: t.segments.length,
      keywords: args.keywords && args.keywords.length ? findKeywords(t.text, args.keywords) : undefined,
      text: t.text.slice(0, max),
    };
  }
  if (name === "youtube_transcript_search") {
    return searchTranscripts(args.query, args.keywords || [], Math.min(args.limit || 5, 15), args.langs || "en");
  }
  throw new Error(`Unknown tool: ${name}`);
}

const rl = createInterface({ input: process.stdin });
const pending = new Map();
let nextId = 1;

rl.on("line", async (line) => {
  line = line.trim();
  if (!line) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  if (msg.id === undefined) return; // notyfikacja - ignorujemy

  if (msg.method === "initialize") {
    text({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: msg.params?.protocolVersion || "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "youtube-transcript-search", version: "1.0.0" },
      },
    });
    return;
  }

  if (msg.method === "tools/list") {
    text({ jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS } });
    return;
  }

  if (msg.method === "tools/call") {
    const name = msg.params?.name;
    try {
      const result = await callTool(name, msg.params?.arguments || {});
      text({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] } });
    } catch (e) {
      text({
        jsonrpc: "2.0",
        id: msg.id,
        result: { content: [{ type: "text", text: "Error: " + (e && e.message || e) }], isError: true },
      });
    }
    return;
  }

  if (msg.method === "ping") {
    text({ jsonrpc: "2.0", id: msg.id, result: {} });
  }
});
