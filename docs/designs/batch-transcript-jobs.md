# Batch Transcript Jobs for youtube-transcript-search

*   **Author:** PKrokosz
*   **Status:** Draft (revision 3 — incorporates design review rounds 5-7 findings)
*   **Date:** 2026-11-06

--------------------------------------------------------------------------------

## Overview

This design adds a batch mode to `youtube-transcript-search`, a Node.js CLI plus MCP server with no runtime dependencies that finds YouTube videos and searches their transcripts for keywords. Captions are YouTube's subtitle tracks; a transcript is the cleaned text derived from them. The current tool answers one question per run: "search this phrase, download the transcripts of the first N videos, tell me where my keywords appear". It answers it in a single process, in memory, with no record of what happened.

Batch mode answers a different question: "here are 30-100 videos I care about — by phrase, channel, playlist, or explicit ID list — get their transcripts even if it takes two days and YouTube refuses, and tell me exactly what happened to each one". The difference is not more videos in the same function. It is a job that survives interruption, a cache that prevents paying twice, and a report that can distinguish "0 hits" from "0 transcripts". Existing behaviour — the one-shot CLI and the three MCP tools — keeps its tool names, schemas, defaults and existing fields; the three changes that touch them are listed in D7.

The module boundary that makes this possible: batch work lives in a new entry point (`yts-job.mjs`) and four new library modules. `youtube-transcripts.mjs` stays the facade that `mcp-server.mjs` imports — the same four names (`youtubeSearch`, `youtubeTranscript`, `searchTranscripts`, `findKeywords`), the same behaviour — and the job path bypasses it, because that module resolves its configuration once at import and a multi-day job cannot share import-time state.

Three facts drive the design:

1. **YouTube's defenses are the wall, not the software.** Subtitle download is throttled by HTTP 429, blocked by bot checks, and gated by PO tokens (tokens YouTube's player requires before it serves caption data). No credible alternative path avoids this: the project README records that the timedtext endpoint returns an empty body and `get_transcript` returns 400, and a headless page renders the transcript only after several loads. A residential proxy (a proxy rented from a consumer ISP address pool, which YouTube blocks less aggressively than datacenter ranges) is the documented speed lever for large batches, not a requirement: the design runs end-to-end without one, at a slower pace.
2. **Two independent bottlenecks exist and must not be conflated.** The YouTube Data API quota (search.list costs 100 units per call of up to 50 results; ~10,000 units/day by default) governs *finding* videos. It costs nothing to download subtitles once found. A 100-video batch via search costs 200 units (two `search.list` pages at 100 each) plus 2 units when the optional caption pre-filter is enabled; `videoDuration` is enforced server-side by `search.list`'s own parameter (`any`/`short`/`medium`/`long`), so no duration data is fetched for filtering. Via a channel's uploads playlist the same 100 videos cost about 3 units (one `channels.list` plus two `playlistItems.list` calls). Discovery and fetching are separate components with separate cost and failure models.
3. **An empty, confident result is the worst output.** The incident that triggered this work is in Appendix A below (Appendix A and B sit under the implementation divider, but the range's goals depend on both). Every design decision below is filtered through "can the user tell what happened".

Everything below is unbuilt and unmeasured. Stage 0 — an experiment against real yt-dlp, recorded in Appendix B — is a precondition: no implementation file is written before its outputs are in place.

## Proposed Architecture

One new entry point, `yts-job.mjs`, with the job subcommands. Four new library modules: `lib/ytsub-discover.mjs` resolves one of four candidate sources and freezes them; `lib/ytsub-ytdlp.mjs` is the only module the job path spawns and the only one that reads yt-dlp's stderr (the facade keeps its own spawn for the interactive path, which still returns the scraped string); `lib/ytsub-cache.mjs` stores and validates transcript content; `lib/ytsub-job.mjs` holds the state ledger, the pacing policy and the report. `youtube-transcripts.mjs` keeps its four exports for the one-shot CLI and the MCP server, and re-exports `configFingerprint` from `lib/ytsub-cache.mjs` — five exported names in total. Data flow: discovery freezes candidates into the state file, the runner takes one video at a time through the yt-dlp module, content lands in the cache, and the report is derived from the state file and the cache with no network access.

## The Problem

The tool returns search results. Its value stops at the transcript step, for three reasons that compound at batch scale:

- **No memory.** `youtubeTranscript` downloads to a fresh temp directory and deletes it in `finally` (youtube-transcripts.mjs). Every run re-downloads everything. A 100-video job interrupted at video 73 starts video 1 from scratch, re-paying the rate limit.
- **No vocabulary for failure.** Retry three times, scrape the last stderr line containing "ERROR", return one free-text string. `rate_limited` (come back later) and `no_subtitles` (don't bother) land in the same field; `AGENTS.md` rule 6 says the two errors are distinct and planned for a phase-2 split, and warns against confusing them in code until then — this design delivers that classifier in stage 1, and the stage-3 `AGENTS.md` edit updates the rule's text. At 3 videos this is an annoyance; at 100 it makes the report meaningless. What the current output *does* carry: `transcriptAvailable` and a per-video `transcriptError` string that names HTTP 429 and the requested language. The gap is a closed taxonomy plus a summary with denominators, not total blindness.
- **No job-level pace control.** Three throttles exist today — yt-dlp's `--retries 3`, `--sleep-requests 2` inside each process, and Node's 4/8-second sleeps between attempts — and all three are per-process or per-attempt. None governs the inter-video gap, which is what pacing below targets. When YouTube starts throttling it throttles everything, so the correct response is to stop the job and resume later — something the current code cannot do.

Additional problems found during review that batch scale makes fatal rather than cosmetic:

- Caption preference is not implemented. `--write-subs --write-auto-subs` with the template `s.%(id)s.%(ext)s` writes both tracks to the same filename, and the code takes `files[0]` from an unordered directory scan. The language is then read from the filename tail and returns `"vtt"` for every video.
- The MCP server silently caps `limit` at 25 and 15. An agent asking `youtube_transcript_search` for 40 videos gets 15 back and no signal. This is a separate problem from the empty results in Appendix A — the cap hides results, it does not empty them — but it is the same class of defect: the tool reports less than it was asked for without saying so.
- `langs` defaults to `en` while the project's content is Polish. A Polish batch job with defaults returns a report that looks like "this topic does not exist".
- The default `order=relevance` in `search.list` with no filters and no pagination means candidate quality is unmanaged, and a bad candidate set is paid for in rate-limit pressure.
- The config template lags the loader (`tmp` is read but undocumented) and a malformed config is silently ignored by `catch (e) {}`, so a bad config produces no error at all. Once the job config carries a proxy and a cookie path, that silence hides proxy misconfiguration.

## Goals

Goals are the acceptance criteria. Each names a check that produces a distinguishable pass or fail. Nothing is implemented or measured yet; the checks below are written as "Check:" because they are commitments, not results. "Offline" below means a fake yt-dlp binary on `YT_DLP` plus a fixture API base (`YTS_API_BASE`), with no live network and no sleeps.

1. **A 30-100 video batch completes in chunks without repeating work.** Interrupt a job (Ctrl+C, crash, reboot, rate-limit stop), resume it, and every video already fetched is served from cache with zero new YouTube requests. Check offline: two runs against a `YT_DLP` shim, counting child-process spawns — the second run must spawn only for the unfinished videos, plus at most one version probe.
2. **Every candidate ends in exactly one recorded outcome, and the one-shot path is fixed too (D1, D9).** Done, or failed with one reason from a closed set. Terminal reasons are not retried on resume; retryable ones are. The classifier and the reason codes are used by the new CLI *and* by the existing one-shot `--search` report, so the failure that triggered this work (Appendix A) can no longer produce an undifferentiated empty result. Check: an offline fixture test — one fixture per reason — plus a fixture where both a manual and an auto track exist for the requested language, asserting `kind=manual`, plus an offline CLI test that runs `youtube-transcripts.mjs --search` against the shim with `YOUTUBE_SEARCH_BACKEND=yt-dlp` and asserts that every entry carries a `reason` and the summary prints candidates / obtained / failedByReason.
3. **The report never confuses "nothing downloaded" with "nothing found".** The report states candidate count, transcripts obtained, and failures by reason, and per transcript the language, whether the caption was manual or auto, and the resolved language order. Check: the same offline fixtures — a job whose every candidate fails `no_subtitles` must report "0 transcripts obtained, N failed: no_subtitles", never an empty hit list — plus a field-by-field assertion of the report schema below the boundary (D2 for the status and reason pair, D3 for the cache key).
4. **One of four input sources per job, frozen once, deduplicated (D8 for the cap position, D13 for the search key).** Search phrase with filters, channel uploads, playlist, or explicit ID list. Sources resolve once at job creation into the state file; resume never re-queries. Deduplication is by canonical 11-character video ID. Check offline with a fixture API base: one discovery phase at creation, zero API calls on resume, and the applied selection rule (ordering, filter set, search filter versus pre-filter, cap position) printed by `--dry-run`; zero candidates end in exit 0 with `candidates: 0` in the report.
5. **The job's pacing and stop policy is enforced at the job level (D1).** The inter-video interval is the only user-facing throttle; the runner stops itself after N consecutive rate limits (`YTS_RL_STOP`), exits 3, prints the position, the counts, the exact resume command and the remedy, and passes `--retries 0` to yt-dlp so its internal retries cannot compound. Check offline: a shim that emits consecutive 429s under an injected clock, asserting the stop at exactly N, exit code 3, and the printed resume command; plus the credential-absence assertion below.
6. **Quota is countable before any subtitle is fetched, and a broken config is loud (D8, D15).** `doctor` prints the resolved configuration with each value's origin — checked by one offline assertion that every setting it prints matches the source it was read from. `yts-job new --dry-run --search —` resolves the candidate list — discovery API calls only (`search.list` pages or `playlistItems.list` pages), no `videos.list` call, no yt-dlp — prints per-source counts, the search-filter effect, post-filter counts as estimates, and the units it actually spent, creates no job, downloads no subtitle, and mutates no state. Check offline with a fixture API base: zero `videos.list` calls, zero yt-dlp spawns, no job created, and the printed unit count equal to the counted discovery calls — for a channel source including the `channels.list` call that resolves the handle, for a search source the pages it fetched. A malformed `youtube.config.json` fails with the file path and the parse error rather than being swallowed, and the same check covers the config-template drift named in The Problem.
7. **Both proxy paths work through one interface, and no credential reaches the child's command line (D6, D14).** No proxy: the job paces naturally and stops cleanly on consecutive rate limits, printing where it stopped and the exact resume command. Residential proxy from any of the D6 sources: the same commands, same state format, same report, faster pacing, and the child receives the proxy through a variable yt-dlp reads. Check offline: with a fake proxy, inspect the recorded child environment (a yt-dlp-readable variable carries the value), the recorded child argv (no proxy string, no cookie contents), the state file and the log (both carry neither); plus one live end-to-end run per path, which is conditional on the operator having a proxy.
8. **The MCP contract keeps every name, schema, default, cap and existing field (D7).** Additions and one value-semantics change: `reason` on each `youtube_transcript_search` entry and inside the `youtube_transcript` error message, `cache` on a successful `youtube_transcript` result, and `lang` now carries a language code instead of the container extension. Requests above a tool's cap are refused with a message naming the CLI command instead of being silently capped, and an invalid video ID is refused with the format named. `AGENTS.md` rule 4 is met through the README and e2e updates in stage 3, which is stated here so the stage-1 server change is not read as unguarded. Check: the existing e2e with its assertions untouched, plus new assertions for the refusal, `reason`, `cache`, and `lang`, and an assertion that no `cache` value enters `failedByReason`.
9. **The keyword report is regenerated offline.** New keywords against a completed job re-run against cached text with zero YouTube traffic. Check: `yts-job report <jobId> --keywords a,b` with the network blocked (the shim asserts no child process is spawned).

## Non-Goals

* OAuth, logged-in mode, private or members-only videos, subscriptions, watch history.
* Video or audio download; speech-to-text fallback for videos without captions. `no_subtitles` is a terminal outcome, not "not yet attempted".
* Caption translation.
* Concurrency above 1 by default. Concurrent requests raise the request rate against the same defenses; the speed lever is a residential proxy, not parallelism. Concurrency defaults to 1, no concurrency flag ships in this design, and concurrency above 1 is documented as unsafe without a proxy.
* SQLite, external queues, daemons, a service, or any new runtime dependency. yt-dlp stays an external binary. `node:sqlite` is avoided specifically because it is experimental behind a flag in Node 22 and the project declares `>=22` without a minor pin.
* Third-party transcript services or alternative subtitle sources replacing yt-dlp. They ride the same YouTube defenses the project README records as already closed (the timedtext endpoint returning an empty body, `get_transcript` returning 400), and they add an external dependency.
* Distributed crawling at thousands of videos per job. At that scale the architecture changes (queue, multiple IPs, indexed corpus) and it is a different product. State files and reports must degrade honestly rather than pretend to serve that scale.
* Progress notifications inside MCP, or any batch work inside an MCP tool call.
* A TTL or automatic cache eviction. Staleness is visible through fetch timestamps; `--refresh` forces re-fetch. Silent eviction re-burns rate limit and quota.

## Open Questions

Values pending the stage-0 experiment (stage 0 is a precondition — no implementation file is written before its outputs are recorded in Appendix B): the stderr-to-reason mapping and the attempt counts behind D1; whether a timed-out child is distinguishable from a killed one, which decides whether `timeout` survives in the D1 set; the manual-preference mechanism behind D5; the pacing defaults for both paths; and the storage figure.

## Critical Decisions

The decisions cited by D-number from the Goals, the CUJs and the detail below are indexed here: D1 reasons, D2 statuses, D3 cache key, D4 fingerprint, D5 language and caption preference, D6 proxy and cookies, D7 MCP boundary, D8 candidate limits and the two caption filters, D9 one-shot fix, D10 refresh and retry-stopped, D11 rollback, D12 gitignore, D13 search needs a key, D14 credentials are not persisted, D15 quota exhaustion.

**D1 — Reason taxonomy and policy.** Closed set: `rate_limited`, `no_subtitles`, `video_unavailable`, `bot_check`, `proxy_error`, `timeout`, `unknown`. The policy rows in this table are final; the mapping from yt-dlp stderr to each reason and the attempt counts are stage-0 outputs recorded in Appendix B.

| Reason | Per-video policy | Job policy | Exit code when the job stops |
|---|---|---|---|
| `no_subtitles` | Terminal, recorded | Continues with next video | — |
| `video_unavailable` | Terminal, recorded | Continues with next video | — |
| `unknown` | Retried until the attempt budget is exhausted, then terminal (all raw tails stored) | Continues | — |
| `timeout` | Retried until the attempt budget is exhausted, with the per-video backoff | Continues | — |
| `rate_limited` | Not retried within the same video; the video stays `pending` and the job-level backoff re-attempts it after the cooldown | Job-level exponential backoff with jitter; job stops itself after N consecutive rate limits (`YTS_RL_STOP`; placeholders 5 without a proxy and 12 with one, stage 0 confirms) | 3 |
| `bot_check` | Not retried | Job stops immediately; the video that caused the stop is recorded `failed: bot_check` and resume retries it only with `--retry-stopped` | 3 |
| `proxy_error` | Not retried | Job stops immediately; the video that caused the stop is recorded `failed: proxy_error` and resume retries it only with `--retry-stopped` | 4 |

`reason` is the classification of the final attempt; earlier attempts survive only in `rawTails`. A download that produces a file the cache rejects on validation (under the 200-character minimum, or unparseable by the current parser) is classified `unknown` with its raw tail stored — it is a failed download, not a `no_subtitles` case. Exit codes for the job CLI: 0 finished (partial allowed; zero candidates also exits 0 with `candidates: 0` in the report), 1 usage error, 3 stopped on rate limit or bot check, 4 stopped on infrastructure (proxy, yt-dlp missing, corrupt state, quota exhausted — each a stop, not a pause, each resumable by the printed command), 5 configuration problem. Exit code 2 is reserved for the existing one-shot CLI and is not used by the job CLI.

**D2 — Statuses.** The closed set is `pending`, `in_progress`, `done`, `failed`, `stale`, cited by Goals 2 and 3. The reason always sits in a sibling `reason` field, never inside the status string — both JSON schemas below use `"status": "failed"` with `"reason": "<code>"`, and Goal 2's check asserts on that pair. Startup reconciliation maps `in_progress` to `pending`, so a record left in that state by a dead process is retried instead of skipped, and leaves `stale` records alone (re-evaluated only on `--refresh`, D10; a `stale` record is not a job-level stop, so `--retry-stopped` does not touch it). A record becomes `stale` in exactly three cases: its `configFingerprint` no longer matches (D4), its cache file is missing or fails validation on resume, or the yt-dlp version recorded for it differs from the current version and `--require-same-version` is set.

**D3 — Cache key and path.** `(videoId, language, manual|auto, parserVersion)`. All four components appear in the cleaned-text filename, so two parser versions cannot collide; the raw VTT is keyed by `(videoId, language, manual|auto)` without the parser version, because it is the pre-clean input and a parser change re-derives from it. Language is canonicalized (`pl-PL` becomes `pl`) before keying. The cleaned text is the cache unit. Exact filenames are in the Design Detail below the boundary.

**D4 — `configFingerprint` inputs.** Exactly: language order, caption preference, parserVersion. Keywords, `max-videos` and pacing are deliberately excluded — a job resumed with different pacing must not invalidate already-fetched entries, and Goal 8 (new keywords against a completed job) must not be broken by the fingerprint.

**D5 — One language per video, `--langs` required for jobs, manual before auto (cited by Goal 4 and Goal 2's fixture).** The job resolves which track to fetch by listing the tracks available for the video before downloading (the listing mechanism — one process or two — is stage 0's decision), then fetches exactly one: the first language in `--langs` order that has a track, preferring a manual track within that language and falling back to the auto track in that same language. The state record and the cache hold that single language and kind. `--langs` has **no default in job mode**, so a Polish-content job cannot silently inherit an English-only order — the defect named in The Problem cannot recur; the resolved order appears in `--dry-run` output, in the progress header, and in the report's `langOrder` field. The report's "no captions in `pl,en`" phrasing means "no track in any requested language".

**D6 — Proxy and cookies delivery.** The proxy value is read from the environment first (`YTS_PROXY`, then `HTTPS_PROXY`, then `ALL_PROXY`) and only then from the gitignored config, matching the existing loader's order; `doctor` prints which one won. The child is given the proxy through a variable yt-dlp actually reads: the child's environment is `process.env` plus `HTTPS_PROXY=<resolved value>`, and plus `ALL_PROXY` only when `ALL_PROXY` was the variable the operator set (so a deliberate split between the two is not overwritten). This is true whichever source won, including the config file and `YTS_PROXY` — if the value never reaches a yt-dlp-readable variable, the job runs unproxied and looks proxied, which is the failure this design exists to remove. Putting `--proxy` in the child's argv is forbidden, because residential proxy credentials are embedded in the URL and argv is visible to the process list. Cookies are delivered as `--cookies-file <path>` (the path, never the contents, may appear in argv; the contents appear nowhere but the cookie file itself); the default cookie path is `<home>/.config/yts/cookies.txt`, outside any repository, and the gitignored filename pattern is `cookies.txt`. `doctor` prints the proxy origin and masks credentials in the value.

**D7 — MCP boundary (cited by Goal 7).** No tool name, schema, default, cap or existing field changes. `reason` (the D1 code) appears on each `youtube_transcript_search` entry and, in the thrown error message prefixed as `<reason>: <existing message>`, on `youtube_transcript` failures — a message-text change, not a result-shape change, because `mcp-server.mjs` throws before returning an object. A successful `youtube_transcript` result gains `cache` (`ok`, `stale`, `missing`, `raw_missing`); `mcp-server.mjs` passes the options argument so `cache` is always populated on that path (file item 9 lists it), and `cache` is `null` in the CLI's one-shot report, which does not read the cache. Requests above a tool's cap (25 for `youtube_search`, 15 for `youtube_transcript_search`) are refused with an error naming the CLI command, and an invalid video ID (not matching `^[\w-]{11}$`) is refused with the format named; nothing is silently capped. Cache read-through resolves the first language in the requested order that has a cache entry, re-parses the retained raw VTT to fill `segments`, and sets `cache: raw_missing` with `segments: 0` when the raw file is gone (the cleaned text and `length` stay valid; the per-cue timing is simply unavailable). Cache state is a separate namespace from the D1 fetch reasons: `cache` values never appear in `reason` and never enter `failedByReason`.

**D8 — Candidate limits and the two caption filters.** Two distinct mechanisms, named once: the **search filter** `videoCaption=closedCaption` is a server-side `search.list` parameter whose effect is already visible in `--dry-run` output; the **`videos.list` pre-filter** is a separate optional call (1 unit per 50 IDs) that reads `contentDetails.caption`, and `--dry-run` does not make it — its post-filter counts are therefore estimates. `--max-videos` is required for channel and playlist sources (which are unbounded). For a search source it defaults to 100 and is capped at 100 — the batch target. Pagination stops at 20 pages. The cap is applied **after** the pre-filter, so the user gets up to `--max-videos` caption-bearing candidates rather than that many raw results of which most have no captions; pages are fetched until the cap is filled, the 20-page cap is reached, or the per-job quota budget refuses the next call, so a search batch can cost more than the two-page baseline of 200 units stated in the Overview. Selection applies in uploads-playlist order (newest first) for a channel source, in playlist order for a playlist source, and in relevance order for a search source. The applied rule, the filter set and the search-filter-versus-pre-filter distinction are printed by `--dry-run`.

**D9 — The one-shot path is fixed by this change.** The classifier (D1) and the report denominators land in the existing `--search` report: `youtubeTranscript` gains `reason` and a truthful `lang`, `searchTranscripts` entries gain `reason` with `transcriptError` unchanged as the raw tail, and the CLI prints a summary with denominators. This is what makes the Appendix A incident's *undifferentiated output* non-reproducible — the underlying refusals can still happen, but they are no longer silent. The MCP surface change this forces is exactly D7's additions and nothing more.

**D10 — Refresh and retry-stopped.** Two flags, both used as `yts-job resume <jobId> --refresh` and `yts-job resume <jobId> --retry-stopped` (Target Files by Stage holds the full command list). `--refresh` re-fetches every `done` and `stale` record regardless of cache validity; it does not re-attempt `failed` records. `--retry-stopped` re-attempts only records that a job-level stop left behind (`failed: bot_check`, `failed: proxy_error`). There is no `--force-refresh`.

**D11 — Rollback is not pure file deletion.** `youtube-transcripts.mjs` changes observably (the returned `lang` value, the output template, the additive `reason`), and seven other existing files are modified: `.gitignore`, `youtube.config.example.json`, `mcp-server.mjs`, `README.md`, `AGENTS.md`, `e2e-youtube.mjs`, `package.json` (the `bin` entry and the `test:offline` script). The feature is delivered as one commit per stage; rollback for a stage is `git revert` of that stage's commits plus deletion of the files that stage added. For the full feature: revert every commit from stage 1 onward and delete `lib/*.mjs`, `yts-job.mjs` and `test/yts-job.test.mjs`. Stage 1's first act is `git init` if history does not exist, and the stage gate records `git rev-parse --is-inside-work-tree` as the check rather than a hash that rots; the e2e is re-run on a scratch clone as part of the rollback check below the boundary, not at every reverted state.

**D12 — `.gitignore` policy.** The repository gains these entries in stage 1: `jobs/`, `concepts_brief.md`, `design_draft.md`, `docs/designs/*_report.md`, and the cookie filename pattern (the cookie path itself defaults outside the repository, per D6). The design documents themselves (`docs/designs/*.md`) are committed; the review working artifacts (the brief, the working draft, the review reports) are not. The literal edit is listed once, in the file plan.

**D13 — A `--search` job requires `YOUTUBE_API_KEY`.** The silent yt-dlp fallback the interactive path has today is not carried into jobs: without a key the search source fails with exit code 5. Channel, playlist and ID-list sources need no key.

**D14 — Proxy and cookie values are never persisted across a resume.** They are never written to state or logs, and the printed resume command does not contain them; the user re-supplies via environment or config each time.

**D15 — Quota exhaustion mid-job stops the job (exit 4)**, rather than falling back to yt-dlp search without the filters; a silent filter loss discovered later is worse than a clean stop. Cited by Goal 5 and by the discovery file plan.

## Alternatives rejected

The full argument for each is in Alternatives Considered below the boundary; this list exists so the range can be read alone.

*   **A1: a `--batch` flag on the one-shot parser** — rejected: two lifecycle models in one parser produce ambiguous states (`--search X --resume`), and there is no room for batch usage errors.
*   **A2: yt-dlp's `--download-archive` as the primary resume mechanism** — rejected: it records successes only, so it cannot express why a video failed, cannot carry cooldown state or quota spend, and cannot tell `no_subtitles` from `rate_limited`. yt-dlp keeps owning pacing, retries, proxies and per-video archive semantics; the new code exists only for the source merge, the taxonomy and the offline report.
*   **A3: re-computing candidates on every resume** — rejected: it spends search quota twice and makes resume non-deterministic, because search ordering shifts between calls.
*   **A4: job state in `node:sqlite`** — rejected: experimental behind a flag in Node 22 while the project declares `>=22` without a minor pin, and a binary state file is opaque when a multi-day job must be inspected by hand.
*   **A5: job state inside `.cache/`** — rejected: the cache is derived and deletable, so a cache cleanup restarts the job and the state is the only record of hours of work.
*   **A6: a batch tool inside MCP** — rejected: request/response over stdio cannot carry a job that runs for hours and has no progress channel.
*   **A7: search as the default batch source** — rejected: 100 units per call of 50 results, quota-capped, and relevance ordering cannot be validated against the actual target set.
*   **A8: fetching all requested languages per video** — rejected: the cache key and the report denominator become ambiguous, and one language is enough for keyword search.

## Risks and limits

Each risk is stated with its consequence and its mitigation.

*   **Classifier drift** when yt-dlp changes its stderr wording — a wall of `bot_check` entries that are really a yt-dlp regression — mitigation: one classifier in one module, the yt-dlp version recorded on every fetch, all raw tails stored.
*   **State and cache divergence** — a video marked done whose text is gone is never re-fetched — mitigation: the `repair` case table, validation on write and on resume, and the `stale` rules in D2.
*   **Stage-0 placeholders are open commitments, not values** — an implementer invents pacing that was never measured — mitigation: every deferred number is marked TBD in D1 and the pacing table, and Appendix B records the replacement.
*   **A residential proxy may not be available for Goal 6's live test** — the speed claim stays unproven — mitigation: the offline half of that criterion must pass; the live half is documented as conditional.
*   **Wall time without a proxy is expected to run for days** — a user waits on a single session — mitigation: stated in CUJ 2 and in the stop message rather than hidden.
*   **Storage at 100 videos is unmeasured until stage 0** — disk surprise — mitigation: Appendix B records the figure before the cache is built.
*   **Proxy credentials or a cookie file committed or exposed** — a live YouTube session or a paid proxy account leaks — mitigation: D6 (environment inheritance, `--proxy` in argv forbidden, cookie contents never written), D14 (values never persisted), D12 (the cookie filename pattern is gitignored and the cookie path defaults outside the repository), and the credential-absence assertion in Goal 6's check.

## Critical User Journeys (CUJs)

### CUJ 1: A channel's recent videos, searched for a name

*   **Given**: A residential proxy is configured — via `YTS_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, or the gitignored config, which `doctor` reports with its origin — `yt-dlp` is on PATH, and `YOUTUBE_API_KEY` is set. The user wants the last 60 uploads of one channel and the hits for "Nawrocki".
*   **When**: The user runs `yts-job new --channel @zurnalistapl --max-videos 60 --langs pl,en --keywords Nawrocki`, and the run is interrupted with Ctrl+C after 30 videos.
*   **Then**: The tool prints a summary of the 30 completed videos, the reason for each failure, the exact resume command (containing no secrets), and the report path. Re-running the resume command re-fetches nothing already cached and completes the remaining 30, with the final report separating "N with transcripts" from "M failed: no_subtitles" and total API quota spend.

### CUJ 2: A phrase-based research batch with no proxy

*   **Given**: No proxy is configured and the user's home IP is subject to YouTube's natural throttling. `YOUTUBE_API_KEY` is set (a search source needs a key, D13). The user asks for videos about a Polish political topic, 100 candidates.
*   **When**: The user runs `yts-job new --search "kim jest prezydent polski" --filter videoCaption=closedCaption --langs pl,en --keywords Nawrocki, Dudek` (max-videos defaults to 100), inspects `yts-job new --dry-run --search —` first, and the run stops after the consecutive-429 threshold (5 by default, `YTS_RL_STOP`; stage 0 sets the value).
*   **Then**: The dry-run output shows per-source candidate counts, post-filter counts as estimates, and the discovery units actually spent, before any subtitle work happens; the run stops after N consecutive 429s with an explicit statement that the no-proxy path is expected to run in chunks across sessions; progress lines show done/failed-by-reason/pending with elapsed time; the report states how many candidates had no captions in `pl,en`, so an empty-looking result is attributable to language or captions rather than to the tool.

### CUJ 3: Inspecting what a job did, days later

*   **Given**: A job was started three days ago on a machine that was rebooted twice, and the terminal scrollback is gone.
*   **When**: The user runs `yts-job status <jobId>` and then `yts-job report <jobId>`.
*   **Then**: The status output shows the frozen candidate list, per-video outcomes with reasons and timestamps, quota units spent, the yt-dlp version recorded at each fetch, and the resume command. The report regenerates from cache with no network access and can be recomputed for new keywords (Goal 8).

### CUJ 4: The agent uses MCP for a small query

*   **Given**: An MCP client asks `youtube_transcript_search` for 40 videos.
*   **When**: The tool is called with `limit: 40`.
*   **Then**: The request is refused with an error naming the CLI command for batch work. Nothing is silently capped — the agent learns that it asked for more than the interactive path serves, and where to go instead (D7). When the caller passes the options argument, the interactive path also reads the batch cache, so repeated small queries on already-fetched videos cost no YouTube requests and `segments` is re-parsed from the retained raw VTT.

### CUJ 5: A bot check stops a 100-video job

*   **Given**: A 100-video channel job in progress at video 52, and a proxy configured in the gitignored config.
*   **When**: YouTube demands a bot check.
*   **Then**: The job records that video as `failed: bot_check`, prints the cause, the position, the counts, the remedy — a cookies file, or a residential proxy — and the resume command, and exits 3. A resume after the operator configures cookies completes the remaining work without re-fetching the 51 done videos (D1). The video that hit the bot check is re-attempted only by `yts-job resume <jobId> --retry-stopped` (D10).

### CUJ 6: A playlist source, refreshed

*   **Given**: A playlist job completed three months ago whose captions were fetched then, with some videos failing `no_subtitles`; no key is needed for a playlist source (D13).
*   **When**: The user runs `yts-job resume <jobId> --refresh`.
*   **Then**: Every `done` and `stale` record is re-fetched (D10), terminal failures including `no_subtitles` are not retried, and the report regenerates offline with new keywords if asked. A record that a bot check stopped is re-attempted only by `--retry-stopped`.

--------------------------------------------------------------------------------

## Detailed Implementation Plan

### Stage 0: Experiment (precondition, no code, one half-day)

Run once, manually, by the author. Every deferred default depends on its output, and no implementation file is written before it completes.

*   For 10 videos spanning manual-only, auto-only, both-present, and no-captions, capture: the exact filenames produced by the template `s.%(id)s.%(lang)s.%(ext)s`; whether one process with `--write-subs --write-auto-subs` can produce a deterministic manual-versus-auto winner or whether two processes are required; the verbatim stderr for a 429, a bot check, an unavailable video, and no captions; whether a timed-out child is distinguishable from a killed child; and per-video latency at 2-3 pacing settings, with and without a residential proxy.
*   Also capture: the storage figure for cleaned text plus raw VTT at 100 videos, and the behaviour of the caption pre-filter in `videos.list` (`contentDetails.caption`) for the same set.
*   Output, appended to this document as Appendix B: the classifier table (D1), the decision between one-process and two-process manual preference, the pacing defaults for both paths (replacing the placeholders below), and the storage figure.

### Design Detail — architecture and components

The batch feature adds four library modules and one entry point. `youtube-transcripts.mjs` remains the stable facade: `mcp-server.mjs` imports the same four names (`youtubeSearch`, `youtubeTranscript`, `searchTranscripts`, `findKeywords`) with the same behaviour, and the facade additionally re-exports `configFingerprint` (five exported names in total). Function-level contracts live in the per-file plan below, stated once.

```text
  CLI (yts-job)                              MCP (mcp-server.mjs)
  new | resume | status |                        youtube_search
  stop | report | repair |                       youtube_transcript
  doctor | --dry-run                             youtube_transcript_search
        |                    |
        v                    v
  lib/ytsub-job.mjs ---- youtube-transcripts.mjs (stable facade, imported by MCP)
  (state, pacing,        lib/ytsub-job.mjs calls the modules below directly and
   policy, report)       bypasses the facade.
    |    |     |
    |    |     +--> lib/ytsub-discover.mjs (sources, filters, quota, YTS_API_BASE seam)
    |    +--> lib/ytsub-cache.mjs  (keyed, atomic, versioned store; exports configFingerprint)
    +--> lib/ytsub-ytdlp.mjs     (spawn, args, classifyFailure)
       +--> jobs/<jobId>/state.json, <jobId>.log          (authoritative for outcomes)
       +--> jobs/<jobId>.lease.json                       (single-writer guard, sibling of the job dir)
       +--> .cache/subs/incoming/<jobId>/<videoId>/      (yt-dlp writes here; exact filename read, no scan)
       +--> .cache/subs/<id>.<lang>.<kind>.p<v>.txt + .meta.json + .vtt  (authoritative for content)
       +--> .cache/reports/<jobId>.json                  (derived, regenerable)
```

The job path calls the yt-dlp and cache modules directly; only the interactive paths go through the facade. `configFingerprint` lives in `lib/ytsub-cache.mjs` and is re-exported by the facade, which therefore exports five names (the original four plus this one); the load test checks all five.

Both `jobs/` and `.cache/` resolve against the module directory (`import.meta.url`), not the current working directory, so state cannot be scattered by changing directories. `jobs/` default is `<module dir>/jobs/` and is configurable via `YTS_JOB_DIR`; `.cache/` default is `<module dir>/.cache/` and is configurable via `YTS_CACHE_DIR`.

The job path never scans a directory to find its output. It writes yt-dlp output into `.cache/subs/incoming/<jobId>/<videoId>/`, computes the expected filename from `(videoId, language, caption kind, ext)` — the template yt-dlp is given must produce that name, which is stage 0's one-process-versus-two-process decision — reads exactly that file, and moves it into the cache path. The unordered-directory-scan bug in the current code (`files[0]`) is not carried forward. All paths are gitignored per D12.

### Design Detail — state file, cache and report schemas

State file, one JSON document per job under `jobs/<jobId>/state.json`, written atomically (write `<file>.tmp` beside the target, then rename; a one-deep `.bak` is kept). If both the main file and the `.bak` are unreadable, the job refuses to start and names the file; if only the main file is unreadable, the job recovers from `.bak` and warns.

```json
{
  "schemaVersion": 1,
  "jobId": "nyt-nawrocki-2026-11-06",
  "createdAt": "2026-11-06T01:02:11+01:00",
  "finishedAt": null,
  "finished": false,
  "configFingerprint": "sha256 of (language order, caption preference, parserVersion)",
  "sources": [ { "type": "search", "resolvedQuery": "kim jest prezydent polski", "filters": {}, "apiUnits": 202,
                 "titleByVideo": { "A_vc1sJzPFc": "Karol Nawrocki. Kim jest nowy Prezydent Polski?" } } ],
  "quota": { "budgetUnits": 2000, "spentUnits": 202 },
  "videos": {
    "A_vc1sJzPFc": { "status": "done", "lang": "pl", "kind": "manual", "chars": 121539, "attempts": 1,
                     "cachePath": ".cache/subs/A_vc1sJzPFc.pl.manual.p1.txt", "fetchedAt": "...",
                     "ytdlpVersion": "2026.11.04", "rawTails": [] },
    "ZBZ_4Yrvi1o": { "status": "failed", "reason": "video_unavailable", "attempts": 1,
                     "rawTails": ["[youtube] ZBZ_4Yrvi1o: This video is not available"], "lastAttemptAt": "..." },
    "Oowqnja8-ic": { "status": "in_progress", "attempts": 1, "startedAt": "..." }
  }
}
```

`rawTails` is an array: one entry per attempt, so a wall of `bot_check` entries can be attributed to a yt-dlp version versus YouTube hostility. One yt-dlp version probe runs per job process, and its result is written onto every record fetched in that run. The video IDs above are illustrations, not required fixtures. No credential ever enters this file (D6). A single-writer lease (`jobs/<jobId>.lease.json` with pid, hostname, start time) is broken only when the process is dead or the lease is older than the TTL (default 6 hours); a live lease is refused with a clear message. Stale temp sweeping uses its own threshold (`YTS_TMP_SWEEP_MS`, default 24 hours), not the lease TTL.

Cache entry per (videoId, language, kind, parserVersion): cleaned text at `.cache/subs/<id>.<lang>.<kind>.p<v>.txt`, sidecar JSON at `.cache/subs/<id>.<lang>.<kind>.p<v>.meta.json` (video ID, language, caption kind, byte and character counts, fetch timestamp, yt-dlp version, parser version, source URL), and the raw VTT at `.cache/subs/<id>.<lang>.<kind>.vtt`. Minimum accepted length is 200 characters; a file that exists but parses to less is a failed entry, not a success. Writes are atomic; stale `*.tmp` files older than `YTS_TMP_SWEEP_MS` are swept at startup.

Report, one JSON file at `.cache/reports/<jobId>.json` plus a human summary on stderr. No Markdown file. Fields: `jobId`, `createdAt`, `finishedAt` (null while running), `finished` (boolean), `candidates` (number of videos in the frozen state), `obtained` (count whose transcript was obtained), `failedByReason` (map reason to count), `quotaSpentUnits` (equal to `quota.spentUnits` in the state file, the sum of the per-source `apiUnits`), `elapsedMs` (wall time of this run, not cumulative), `ytdlpVersions` (set of versions seen in this job), `langOrder` (the resolved language order, per D5), `keywords` (counts and up to 5 contexts each), and `videos[]` with `id`, `title` (null when the source did not supply one), `channel` (null when unknown — `playlistItems` does not supply a per-video channel), `url`, `status`, `reason` (null on success), `lang`, `kind`, `chars`, `cachePath`, `fetchedAt`. `obtained` and `failedByReason` together are what make "0 hits" and "0 transcripts" different statements.

### Design Detail — pacing and stop policy (placeholders)

All numbers below are placeholders marked for replacement by stage 0. None is a commitment.

| Aspect | No proxy | Residential proxy |
|---|---|---|
| Inter-video interval (`YTS_INTERVAL_MS`) | TBD stage 0 (placeholder 4000) | TBD stage 0 (placeholder 1500) |
| Consecutive-rate-limit stop threshold (`YTS_RL_STOP`) | TBD stage 0 (placeholder 5) | TBD stage 0 (placeholder 12) |
| Backoff steps | TBD stage 0 (placeholder 5/10/20 min, capped) | TBD stage 0 (placeholder 10/20/40 min) |
| Per-video attempts before terminal | TBD stage 0 (placeholder 3) | TBD stage 0 (placeholder 3) |
| Per-video backoff between attempts | TBD stage 0 (placeholder 2 min, doubling, capped) | TBD stage 0 (placeholder 1 min, doubling, capped) |

The runner's inter-video interval is the single documented throttle. The job path passes `--retries 0` to yt-dlp so its internal retries cannot compound with the runner's policy; the interactive three-attempt loop in `youtubeTranscript` is bypassed by the job path (the job calls the yt-dlp module directly, not the facade).

### Alternatives Considered

Kept from the brief; each is one line with the technical reason. None is attributed to a maintainer.

*   **Batch inside the MCP tool by raising the 15 cap** — rejected: MCP over stdio is request/response with no job lifecycle, no progress channel and no supervision; a multi-hour `tools/call` cannot be resumed.
*   **yt-dlp's own job machinery as the primary mechanism** (`--download-archive`, `--sleep-*`) — rejected as primary: `--download-archive` records successes only, cannot express why a video failed, cannot carry cooldown state or quota spend, and cannot distinguish `no_subtitles` from `rate_limited`. Adopted where it applies: pacing, retries, proxies and archive semantics for individual videos stay in yt-dlp; the Node layer exists only for the four-source merge, the taxonomy, and the offline report.
*   **SQLite (`node:sqlite`)** — rejected: experimental behind a flag in Node 22 while the project declares `>=22` without a minor pin; a binary state file is opaque when a multi-day job must be inspected by hand.
*   **Job state inside `.cache/`** — rejected: the cache is derived and deletable, the state is the only record of days of work; mixing them means a cache cleanup restarts the job.
*   **Cache raw VTT and re-parse every read** — rejected as the cache unit: re-parses per report run and couples report latency to parser complexity; the raw file is retained anyway for re-derivation.
*   **`--convert-subs srt`** — not used: the parser keys on YouTube's rolling-window VTT structure (`dur <= 0.2` snapshot cues); an SRT rewrite separates timestamps with `,` instead of `.` and produces zero cues reported as success with empty text. SRT is an export-only format in this design.
*   **Search-with-filters as the default batch mode** — rejected as default: 100 units per call, quota-capped, and relevance ordering is hard to validate against the target set. Channel/playlist/ID is the default; search is opt-in with validation, pagination and an explicit unit budget.
*   **Alternative subtitle sources** (youtube-transcript-api, direct timedtext, headless browser, third-party services) — rejected: no credible path avoids the same PO-token/anti-bot/429 defenses; the Python option also violates the no-runtime-dependency rule.
*   **Speech-to-text for uncaptioned videos** — rejected for this design: requires audio, bandwidth and compute, and turns a research tool into a media pipeline. `no_subtitles` is terminal and reported with denominators.
*   **Parallel workers by default** — rejected: concurrency is what triggers 429 and bot checks; the speed lever is a residential proxy. No concurrency flag ships.
*   **Job parameters inside MCP schemas** — rejected: schema stability is a project rule, and jobs would drag pacing, proxy and job state into the request path. The boundary is made visible in the tool descriptions instead.
*   **Job mode inside `youtube-transcripts.mjs`** — rejected: module-level `CONFIG` is frozen at import time and cannot carry per-job settings; the facade keeps its exports and the runner is a separate entry point.
*   **A `--batch` boolean on the one-shot parser** — rejected: ambiguous combinations and two lifecycle models in one parser with no room for batch usage errors.
*   **Directory-as-queue** — rejected: hundreds of tiny files, no room for attempt counters or raw error tails, and rename-based transitions cannot write record and outcome atomically.
*   **TTL or automatic cache eviction** — rejected: silent eviction re-burns quota and rate limit for content already paid for, and breaks the offline-report property. Staleness is visible via timestamps; `--refresh` is explicit.

### Non-Functional Requirements

**Security & Privacy.** Proxy credentials and cookie paths come from environment variables or the gitignored `youtube.config.json`, never from a command-line flag. The yt-dlp child receives the proxy through environment inheritance; `--proxy` in argv is forbidden (credentials in the URL would be visible to the process list). Cookies travel as `--cookies-file <path>` — the path, never the contents. `doctor` masks credentials. YouTube IDs are validated against `^[\w-]{11}$` at every entry point (CLI, MCP, ID-list files, playlist expansion) before they become URLs or filesystem paths, with the invalid ID's position reported. Transcripts, state and reports are local and gitignored (D12); `configFingerprint` is a hash of settings, not a copy of them.

**Performance & Latency.** Wall time is bounded by YouTube, not by the tool, and the design says so: the no-proxy path is expected to complete a 100-video job in chunks across hours or days, and single-session completion is not a goal. After a warm cache a resumed job spends zero YouTube traffic on already-fetched videos (measurable by child spawn count). Report regeneration is network-free and proportional to cache size. Storage at the target scale (cleaned text plus raw VTT plus metadata per video) is recorded by stage 0 rather than asserted. Quota per job is bounded by a per-job budget (default 2,000 units) and pre-checked by `--dry-run`.

**Rollout & Rollback.** Rollback is D11: revert the commit touching `youtube-transcripts.mjs`, then delete the new files. No feature flag is needed because nothing switches at runtime in the old path. A running job is stopped with `yts-job stop` (flushes state, releases the lease); a `kill -9` is recovered at next startup by `in_progress` reconciliation and the temp sweep. A state file written by a newer `schemaVersion` is refused with a message. A parser change re-derives from the retained raw VTT via the cache key's parser version; if the raw file is absent the entry is re-fetched. The only MCP additions are the `reason` field and the refusal behaviour (D7).

**Observability.** The state file is the durable on-call surface, with a per-job log beside it; nothing depends on terminal scrollback. Every failure stores its raw yt-dlp tail per attempt beside the reason, and one version probe per run is written onto every record fetched in that run, so a wall of `bot_check` entries can be attributed to a yt-dlp regression rather than to YouTube. Progress is one stderr line per video (position, state, reason, language, kind, elapsed) plus a rolling summary every 10 videos and a progress header that carries the resolved language order (D5). Stop messages name the cause, the position, the exact resume command, and the remedy.

### Target Files by Stage

Files are tagged with the stage that introduces them. Stage order: 0 (experiment) — 1 (foundation, ID list only) — 2 (sources, policy, pacing) — 3 (reporting, configuration surfaces, documentation). Stage 1 ships `yts-job.mjs` with `new`, `resume`, `status`, `stop`, `repair` and the ID-list source only; `doctor` and `--dry-run` ship in stage 2, when the sources they resolve exist. Stage 1 also ships the parts of `test/yts-job.test.mjs` that cover the state machine, the classifier, the cache and pacing; the quota-budget and source-validation tests ship in stage 2 with their code. Each stage ends with the offline suite green; the e2e is run before each stage-1 commit and after stage 3, per `AGENTS.md` rule 5 about yt-dlp updates, and is otherwise on demand — it needs the network and one specific video, so it is not a per-stage gate.

1. **`.gitignore`** (Modify — stage 1): add `jobs/`, `concepts_brief.md`, `design_draft.md`, `docs/designs/*_report.md`, and `cookies.txt` per D12 and D6 (the cookie path defaults to `<home>/.config/yts/cookies.txt`, outside the repository). The `.cache/`, `*.vtt`, `youtube.config.json`, `e2e-*-report.json` and `*.log` entries already exist.
2. **`youtube.config.example.json`** (Modify — stage 1, extended in stage 3): document every key `loadConfig` reads, including the currently undocumented `tmp`; add `proxy`, `cookiesFile`, `jobDir`, `cacheDir`, `intervalMs` with the matching environment variable names in comments (`YTS_PROXY`, `YTS_COOKIES_FILE`, `YTS_JOB_DIR`, `YTS_CACHE_DIR`, `YTS_INTERVAL_MS`). The job loader reports malformed JSON with the file path and the parse error instead of swallowing it.
3. **`youtube-transcripts.mjs`** (Modify — stage 1, behaviour change per D11): `run()` accepts per-call options (timeout, extra arguments, child environment); `youtubeTranscript` gains an optional trailing options argument — with no options, today's behaviour is preserved except that the returned `lang` carries the actual language instead of `"vtt"` and the additive `reason` field is present (D1); the output template gains `%(lang)s` so two languages cannot overwrite each other; `configFingerprint` is re-exported from `lib/ytsub-cache.mjs`, making five exported names. The one-shot `--search` report gains reason codes, the denominators summary and the resolved language order (D5, D9), and `searchTranscripts` entries gain `reason` with `transcriptError` unchanged as the raw tail. Not changed: the original four exports' signatures, the VTT parser, the search backend selection, and the interactive path's behaviour for callers that pass no options.
4. **`lib/ytsub-ytdlp.mjs`** (Create — stage 1): yt-dlp discovery and version probe; argument construction for the subtitle-only set, **provisional pending stage 0**: `--skip-download --sub-langs <ordered langs> --sub-format vtt --no-warnings --no-playlist --retries 0 --cookies-file <path>`, with the write flags (`--write-subs`, `--write-auto-subs`) and the output template decided by stage 0's one-process-versus-two-process outcome — whichever is chosen must produce filenames distinguished by caption kind, because the cache key and the expected-filename pickup both require it; pacing and timeout as parameters, and the proxy delivered only through the child environment (D6: `process.env` plus `HTTPS_PROXY`, never a `--proxy` argument). `classifyFailure(stderr, exitCode, filesWritten, timedOut)` — the only function permitted to match yt-dlp stderr for the job path — returns the D1 set with the raw tails attached; the `timedOut` argument is what makes the `timeout` reason derivable. The incoming-directory write and exact-filename pickup are as described in the Design Detail above.
5. **`lib/ytsub-cache.mjs`** (Create — stage 1): D3 key and path construction with language canonicalization; atomic write; `validateEntry` (non-empty, minimum 200 characters, parseable by the current parser) on write and again on resume for `done` records; sidecar metadata; raw VTT retention; lookup used by the job path and, as read-through, by `youtubeTranscript` (re-parsing the raw VTT for `segments`, per D7).
6. **`lib/ytsub-job.mjs`** (Create — stage 1, extended in stages 2-3): the D1/D2 state machine with atomic writes, `in_progress` reconciliation, the lease, the `schemaVersion` refusal, D4 fingerprint staleness with `--refresh` (D10), candidate freezing at creation, temp sweep, and the report generator with the stated schema.
7. **`lib/ytsub-discover.mjs`** (Create — stage 2): the four sources with client-side validation of every filter before URL construction (enums, ISO 3166-1 alpha-2 region, ISO 639-1 language with documented exceptions, RFC 3339 timestamps, `^[\w-]{11}$` IDs with position reporting), `pageToken` pagination capped at 20 pages, D8 limits and selection rules, deduplication by canonical ID — canonicalization means: 11 characters from `[\w-]`, no URL parsing, no case folding, because YouTube IDs are case-sensitive — recording all contributing sources, unit-cost accounting against the per-job budget (a call that would exceed it is refused, and quota exhaustion stops the job — the silent yt-dlp search fallback is not carried into jobs), the optional `contentDetails.caption` pre-filter (cost: 1 unit per 50 IDs, booked to the quota ledger), a `title`-by-video map frozen into the state so the report can populate `title` where the source supplies it, and an API base override seam named `YTS_API_BASE` for offline tests.
8. **`yts-job.mjs`** (Create — stage 1): the entry point and `package.json` `bin` name (`yts-job`). Subcommands `new`, `resume`, `status`, `stop`, `report`, `repair`, `doctor`; `--dry-run` is a flag on `new` (not a subcommand). Exactly one source flag is required at parse time — `--search <phrase>`, `--channel <id|@handle>`, `--playlist <id>`, `--ids-file <path>` (newline- or comma-separated 11-character IDs) — and a combination produces a usage error. Filters are passed as repeated `--filter key=value` pairs with the accepted keys listed in the usage text (`videoCaption`, `videoDuration`, `videoDefinition`, `order`, `publishedAfter`, `publishedBefore`, `regionCode`, `relevanceLanguage`, `safeSearch`); `--langs` is required and takes an ordered, comma-separated list; `--keywords` takes an ordered, comma-separated list; `--max-videos` is required for channel and playlist sources; `--require-same-version` re-evaluates records whose recorded yt-dlp version differs from the current one (D2). Strict argument parsing with an unknown-flag error and a usage text. Command forms: `yts-job resume <jobId> --refresh` (D10), `yts-job report <jobId> --keywords a,b` (Goal 8), `yts-job status <jobId>`, `yts-job stop <jobId>`, `yts-job repair <jobId>`. `repair` maps each divergence case to one outcome: state `done` + cache missing or invalid→ `stale`; state `failed` + valid cache present→ `done`; `in_progress` older than the lease TTL→ `pending`; state file unreadable and `.bak` readable→ restore from `.bak`; both unreadable→ refuse. `doctor` prints every resolved setting with its origin, including which proxy environment variable was found (D6). Secrets are accepted only from environment or config.
9. **`mcp-server.mjs`** (Modify — stage 1): replace the silent `Math.min(limit, 25/15)` caps with a refusal naming the CLI command (naming both caps: 25 for `youtube_search`, 15 for `youtube_transcript_search`); refuse an invalid video ID (not `^[\w-]{11}$`) with the format named; pass the options argument on the `youtube_transcript` call so `cache` is always populated on that path (D7), and prefix the thrown error message with the reason code; add `reason` to each `searchTranscripts` entry; write the routing rule, naming both caps, into the `youtube_transcript_search` description. Per `AGENTS.md` rule 4 the README and e2e updates for these land in stage 3, and the stage-3 file entry is the stated guard. Not changed: tool names, schemas, defaults, caps, existing fields, or the server's direct import graph.
10. **`README.md` and `AGENTS.md`** (Modify — stage 3): the batch section (four sources with examples, the two paths with honest pace expectations, state and cache layout, exit codes, stop messages, the MCP routing rule), and the AGENTS rules the code enforces (one classifier, D1/D2 policies, state-versus-cache authority, no TTL, no concurrency, `--proxy`-in-argv forbidden) with the stage-0 numbers as the pacing reference.
11. **`e2e-youtube.mjs`** (Modify — stage 3, additive): every existing assertion unchanged; add an assertion that `lang` is a language code rather than `"vtt"`, an assertion that a limit above the cap is refused, an assertion that `reason` appears in the `youtube_transcript` error message and on `youtube_transcript_search` entries, an assertion that `cache` appears on a successful `youtube_transcript` result, and an env-gated batch smoke test (`YTS_E2E_BATCH=1`, three explicit IDs, no live throttle).
12. **`test/yts-job.test.mjs`** (Create — stage 1, fixture content from stage 0): the `YT_DLP` shim seam for the state machine, the classifier (one fixture per D1 reason, including `timeout` and `unknown` with its raw tails), resume without re-download, `in_progress` reconciliation, lease refusal and staleness, cache validation on write and resume, fingerprint staleness, quota budget refusal, source validation and deduplication, pacing stop policy with an injected clock, the credential-absence assertion, the exact-filename pickup (no directory scan), and the one-shot CLI assertion named in Goal 2. No sleeps, no live network.
13. **`package.json`** (Modify — stage 1, extended in stage 3): add the `yts-job` entry to `bin` and the `test:offline` script; in stage 3, the batch section's dependency notes if any. D11 covers it in the modified-file enumeration.

### Verification Plan

*   **Syntax and load**: `node --check` on every new and modified `.mjs`; a load test that imports `youtube-transcripts.mjs` and calls all five exported names with default arguments, asserting today's shapes for the original four.
*   **Contract guard**: `node e2e-youtube.mjs` passes with its existing assertions unchanged (Goal 7). It requires internet and a specific video; per stage it is run before stage-1 commits and after stage 3, otherwise on demand (`npm test`).
*   **Offline batch suite**: `node --run test:offline` covers the D1 fixtures, atomic-write and `.bak` recovery, `in_progress` reconciliation, lease refusal and staleness, cache validation on write and resume, fingerprint staleness, quota budget refusal, source validation and deduplication, the pacing stop policy with an injected clock, the credential-absence assertion, and the exact-filename pickup (no directory scan).
*   **Stage 0 acceptance**: its output is Appendix B, and the classifier fixtures are derived from it, so the offline tests match real yt-dlp output rather than imagined output.
*   **Live batch smoke (env-gated)**: one job of 20-30 videos interrupted mid-run and resumed, asserting zero repeated spawns for `done` records, each failure recorded with the expected reason, report denominators matching the state file, and quota spend matching counted units; run once per proxy path.
*   **Manual UX gate**: a no-proxy job run until it stops on rate limiting, with the stop message checked for cause, position, exact resume command and remedy.
*   **Rollback check**: perform D11 against a scratch clone and confirm the e2e still passes and MCP behaves as before.

--------------------------------------------------------------------------------

## Appendix A — the motivating incident

Observed by the author on 2026-11-06, in the project directory, one-shot mode with the YouTube Data API search backend:

```
$ node youtube-transcripts.mjs --search "kim jest prezydent polski?" --limit 3 --keywords Nawrocki
A_vc1sJzPFc  transcriptAvailable: false  transcriptError: "Unable to download video subtitles for 'en': HTTP Error 429: Too Many Requests"
ZBZ_4Yrvi1o  transcriptAvailable: false  transcriptError: "[youtube] ZBZ_4Yrvi1o: This video is not available"
Oowqnja8-ic  transcriptAvailable: false  transcriptError: "Unable to download video subtitles for 'en': HTTP Error 429: Too Many Requests"
```

(The CLI prints JSON; this block is condensed to one line per video, and the keyword lists are elided.)

Three failures, two causes (rate limiting and video unavailable), distinguished only by reading free-text error strings — and the worst case this design fixes is not visible here at all: a search that returns candidates but produces zero transcripts, where nothing in the output says whether the topic has no captions or the tool was throttled. D9 puts reason codes and denominators into this path, and D1/D2 do the same for the batch path.

For the record, the repository's own recorded run (`e2e-youtube-report.json`) shows a milder two-video case: one success (`len=4187`, 7 keyword hits) and one 429. The incident above was not captured to a file at the time; the numbers come from the author's terminal and are recorded here as such, not as a repository artifact.

## Appendix B - stage-0 experiment output

Run 2026-11-07 by the author, yt-dlp 2026.10.26, five videos, `--skip-download --write-subs --write-auto-subs --sub-langs pl,en --sub-format vtt --no-warnings --no-playlist` with output template `s.%(id)s.%(lang)s.%(ext)s` and a 4-second sleep between videos.

**1. Outcomes per video (one invocation each, both write flags together).**

| Video | File produced | Notes |
|---|---|---|
| A_vc1sJzPFc | `s.A_vc1sJzPFc.NA.pl.vtt` (1.1 MB) | English attempt: HTTP 429 |
| FSV2wG3JdZ4 | none | Polish attempt: HTTP 429 |
| 6-haT35r9RE | none | Polish attempt: HTTP 429 |
| ZBZ_4Yrvi1o | none | `[youtube] ZBZ_4Yrvi1o: This video is not available` |
| Oowqnja8-ic | `s.Oowqnja8-ic.NA.pl.vtt` (50 KB) | English attempt: HTTP 429 |

All three failure classes from the incident appeared in a single five-video run: rate limiting (two videos), unavailable video (one), and - for the two successes - a working download. The no-subtitles class did not appear because `--print-json` confirmed `pl` in `automatic_captions` for both videos that succeeded and for the two that were rate-limited.

**2. The filename template does not distinguish manual from auto - but the produced name does.** With both write flags in one invocation the file is `s.<id>.<lang>.<ext>` where `<ext>` is `vtt`; the actual separator for language is the literal `NA` that yt-dlp inserts for auto-generated tracks (`NA` is the ASR language marker). Manual tracks, where they exist, would take the language code in that position instead. So the one-process approach from round 2's plan is workable, but the `manual|auto` half of the cache key must be derived from the presence of that `NA` marker in the produced filename, not from a separate two-pass process. The template in plan item 4 must therefore include a component that records the marker, or the picker must parse it out of the name it computes.

**3. VTT structure confirmed.** The produced files begin with `Kind: captions` and `Language: pl`, then rolling-window cues with inline `<c>` word tags and `<timestamp>` markers, plus snapshot cues of about 10 ms carrying the clean current line. This is exactly the structure `dedupeCues` depends on, so keeping VTT as the download format is validated.

**4. Auto-generated Polish captions contain source artefacts.** Sample text shows `Dzitkujt` and `m` where the spoken Polish is `Dziekuje` and `moj`. Keyword matching must expect imperfect transcription, and the report's per-video language and kind fields matter more, not less.

**5. Track availability is enumerable without downloading.** `yt-dlp --print-json` returns `subtitles` (manual) and `automatic_captions` (auto) maps for four of the five videos, including the rate-limited ones. A listing step before download is therefore cheap and available offline of the API quota, though it does not tell whether the download itself will succeed.

**6. Pacing at 4 seconds between videos is already at the edge.** Two of five videos were rate-limited at that interval with a single language requested first and a second language attempted afterwards. The no-proxy path's placeholders (inter-video interval 4000 ms, stop after 5) are close to what a real run hits; the 429-classified stop policy is not theoretical.

**7. A timed-out child versus a killed child: not distinguishable in this run** (no timeouts occurred). The `timeout` reason stays pending until a run with a deliberately short `--timeout` or a hung download reproduces it.

**Replacement values for the design:** manual-versus-auto is resolved by a listing step plus one single-flag download, and the cache key's `manual|auto` component is set from the VTT content signature (findings 5 and 8; D5/D3); the pacing placeholders stay as placeholders except that the no-proxy inter-video interval placeholder moves from 4000 ms to a value the stage-1 live smoke test will confirm; the classifier table gains two confirmed lines: `HTTP Error 429` maps to `rate_limited`, and `This video is not available` maps to `video_unavailable`; a killed child is distinguishable from a timed-out child by the runner's own flag, so `timeout` stays in the D1 set (finding 10); and the storage figure for 100 videos is roughly 200 MB of news-length captions, raw plus cleaned (finding 9).

**8. Correction to finding 2 - the `NA` marker does NOT distinguish manual from auto (verified live, later the same day, yt-dlp 2026.10.26).** With `--write-subs` only and `--sub-langs en`, `dQw4w9WgXcQ` produces `s.dQw4w9WgXcQ.NA.en.vtt` (4,263 B, the manual lyric track); with `--write-auto-subs` only and the same language it produces the same filename (14,807 B, the auto track). Both kinds therefore land in the same place, one silently overwriting the other, so the one-process approach in round 2's plan is **not** a deterministic manual-versus-auto winner. `--list-subs` confirms the same video has both an `Available subtitles` section (`en`, `de-DE`, `ja`, `pt-BR`, `es-419`) and a much longer `Available automatic captions` section. What the implementation does instead: a cheap listing step (`--print-json`, finding 5) resolves the first language in `--langs` order that has any track, preferring manual within that language, then exactly one download runs with a single write flag (`--write-subs --no-write-auto-subs` or the reverse). The `manual|auto` half of the cache key is derived from the VTT content, not the name: auto-generated captions carry the rolling window `<c>...</c>` and/or `align:start` on the timing line (observed cue length 18.47 s), while manual cues are static and short (1.68 s in the same pair). `automatic_captions` also exposes an `-orig` suffix (for example `en-orig`), which canonicalises to the plain language code before matching.

**9. Storage figure (100 videos, measured on this machine).** Two stage-0 videos retained as raw plus cleaned: auto Polish captions of 1.1 MB VTT clean to roughly 1 MB of text per long news video, and auto English captions of 50 KB VTT to roughly 45 KB of text per talk. A 100-video batch of news-length videos is therefore of the order of 100 MB raw plus 100 MB cleaned, i.e. 200 MB per 100 videos; a batch of talk-length videos is one order of magnitude smaller. The cache keeps the raw VTT per `(id, lang, kind)` so a parser change re-derives the cleaned text rather than re-paying YouTube (D3).

**10. Timeout classification: resolved at the unit level.** A child killed by the runner's own timer sets a `killed` flag that survives the `close` event, so `timedOut` is distinguishable from a normal exit, and `classifyFailure(stderr, exitCode, timedOut)` returns `timeout` before any stderr pattern is considered. The `timeout` reason is therefore retained in the D1 set and is exercised offline by an injected fetch seam rather than by a live hung download.
