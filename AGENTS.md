# AGENTS.md — youtube-transcript-search

## Co tu jest
Serwer MCP (stdio) + CLI, który wyszukuje filmy YouTube i przeszukuje ich
transkrypcje pod kątem słów kluczowych. Rdzeń: `youtube-transcripts.mjs`
(oparty o `yt-dlp`), serwer MCP: `mcp-server.mjs`, test E2E: `e2e-youtube.mjs`.

Dodatkowo tryb **batch** (`yts-job.mjs` + moduły `lib/ytsub-*.mjs`) pobiera
transkrypcje 30–100 filmów w kawałkach, przeżywa przerwanie i raportuje uczciwie,
co się stało z każdym filmem. Design: `docs/designs/batch-transcript-jobs.md`.

## Zasady
1. **Nie commitujemy** sekretów, proxy, cache napisów ani raportów z testów
   (patrz `.gitignore`). W repo jest tylko `youtube.config.example.json`.
   Stan jobów (`jobs/`), cache (`.cache/`) i pliki cookies są lokalne.
2. **Brak zależności runtime** — `yt-dlp` jest zależnością zewnętrzną (PATH albo `YT_DLP`).
   Nie dodajemy `node_modules` do repo. Testy offline używają shima `YT_DLP`, nie mocka modułu.
3. **Node >= 22**, ESM (`.mjs`), `type: module` w `package.json`.
4. **Nie psujemy kontraktu MCP**: nazwy, schematy, domyślne wartości i capy narzędzi
   z `mcp-server.mjs` są stabilne. Dozwolone są wyłącznie dodatki z D7 designu:
   `reason` na wpisie `youtube_transcript_search` i w komunikacie błędu
   `youtube_transcript`, `cache` (`ok`/`stale`/`missing`/`raw_missing`) na wyniku
   `youtube_transcript`, `lang` jako kod języka (nie rozszerzenie kontenera),
   oraz odmowa zamiast cichego obcięcia limitu. Każda z tych zmian ma asercję w `e2e-youtube.mjs`.
5. **YouTube zmienia mechanizmy** → po aktualizacji yt-dlp zawsze puszczamy
   `node e2e-youtube.mjs` i sprawdzamy, czy `transcriptAvailable` nadal działa.
   Sprawdzone na żywo (2026.11, yt-dlp 2026.10.26): pobieranie napisów idzie do
   `s.%(id)s.NA.%(lang)s.%(ext)s` **zarówno dla manual, jak i auto** — marker `NA`
   w nazwie NIE rozstrzyga rodzaju napisów (rozstrzyga go okno przewijania `<c>…</c>`
   w VTT). Jeśli yt-dlp to zmieni, łapią to testy offline na shimie.
6. **Jeden klasyfikator błędów** w całym kodzie: `classifyFailure` w
   `youtube-transcripts.mjs` (ścieżka interaktywna) i ten sam import w
   `lib/ytsub-job.mjs` (ścieżka joba). Zamknięty zestaw powodów D1:
   `rate_limited`, `no_subtitles`, `video_unavailable`, `bot_check`, `proxy_error`,
   `timeout`, `unknown`. `rate_limited` (wróć później) i `no_subtitles` (nie próbuj)
   to dwa różne błędy i nigdy nie trafiają do tego samego pola.
7. **Autorytet rozdzielony**: plik stanu (`jobs/<jobId>/state.json`) mówi, CO się
   stało z filmem; cache (`.cache/subs/…`) mówi, CZEGO DOSZLIŚMY. `done` wymaga
   obu — brak pliku w cache rozstrzyga `yts-job repair` i rekonciliacja przy starcie.
8. **Polityka joba (D1/D2)**: `no_subtitles` i `video_unavailable` terminalne;
   `unknown` i `timeout` do wyczerpania budżetu prób; `rate_limited` zostawia film
   `pending` i ponawia go po cooldownie, a job zatrzymuje się po N kolejnych 429;
   `bot_check` i `proxy_error` zatrzymują job od razu i wracają tylko z
   `--retry-stopped` (D10). Żaden powód nie jest cicho zamieniany na inny.
9. **Bez TTL i bez ewikcji cache**: staleness jest widoczny przez znaczniki czasu,
   a `--refresh` i `--retry-stopped` są jawne. Cicha ewikcja płaci podwójnie.
10. **Bez współbieżności**: tempo to odstęp między filmami (`YTS_INTERVAL_MS`),
    a dźwignia prędkości to proxy rezydencjalne — nie równoległość.
11. **Proxy nigdy nie idzie przez argv** (D6): wartość dociera do dziecka zmienną,
    którą yt-dlp czyta (`HTTPS_PROXY`, a przy `ALL_PROXY` także `ALL_PROXY`).
    Flaga `--proxy` w CLI jest odrzucana. Cookies jako `--cookies-file <ścieżka>`
    (ścieżka, nigdy zawartość). Żadna z tych wartości nie trafia do stanu ani logu.
12. **`--langs` jest wymagane w trybie joba i nie ma wartości domyślnej** (D5):
    job polskich filmów nie może cicho odziedziczyć kolejności angielskiej.

## Jak uruchomić lokalnie
```bash
uv tool install yt-dlp        # raz
node mcp-server.mjs           # serwer MCP
node test/yts-job.test.mjs    # offline: batch (bez sieci)
node e2e-youtube.mjs          # test E2E (wymaga internetu)
node youtube-transcripts.mjs --search "rust headless browser" --limit 3 --keywords rust,obscura
node yts-job.mjs new --ids-file ids.txt --langs pl,en --keywords nawrocki
```

## Plan dalszych prac
Pełny plan (fazy 0–3) jest w repo `PKrokosz/agentmg`:
`docs/ci/CI-AGENTMG.todo` → sekcja „12. Obscura + YouTube Transcript Search".
Design batcha: `docs/designs/batch-transcript-jobs.md` (etap 0 w Appendix B —
wyniki pomiarów, które ustaliły tempo i sygnatury plików).
