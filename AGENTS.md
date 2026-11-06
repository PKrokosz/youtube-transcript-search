# AGENTS.md — youtube-transcript-search

## Co tu jest
Serwer MCP (stdio) + CLI, który wyszukuje filmy YouTube i przeszukuje ich
transkrypcje pod kątem słów kluczowych. Rdzeń: `youtube-transcripts.mjs`
(oparty o `yt-dlp`), serwer MCP: `mcp-server.mjs`, test E2E: `e2e-youtube.mjs`.

## Zasady
1. **Nie commitujemy** sekretów, proxy, cache napisów ani raportów z testów
   (patrz `.gitignore`). W repo jest tylko `youtube.config.example.json`.
2. **Brak zależności runtime** — `yt-dlp` jest zależnością zewnętrzną (PATH albo `YT_DLP`).
   Nie dodawajemy `node_modules` do repo.
3. **Node >= 22**, ESM (`.mjs`), `type: module` w `package.json`.
4. **Nie psujemy kontraktu MCP**: nazwy i schematy narzędzi z `mcp-server.mjs`
   są stabilne — zmiana wymaga aktualizacji README i testu E2E.
5. **YouTube zmienia mechanizmy** → po aktualizacji yt-dlp zawsze puszczamy
   `node e2e-youtube.mjs` i sprawdzamy, czy `transcriptAvailable` nadal działa.
6. **Rozróżniaj `rate_limited` vs `no_subtitles`** — to dwa różne błędy
   (implementowane w fazie 2 planu; do czasu wdrożenia nie myl ich w kodzie).

## Jak uruchomić lokalnie
```bash
uv tool install yt-dlp        # raz
node mcp-server.mjs           # serwer MCP
node e2e-youtube.mjs          # test E2E (wymaga internetu)
node youtube-transcripts.mjs --search "rust headless browser" --limit 3 --keywords rust,obscura
```

## Plan dalszych prac
Pełny plan (fazy 0–3) jest w repo `PKrokosz/agentmg`:
`docs/ci/CI-AGENTMG.todo` → sekcja „12. Obscura + YouTube Transcript Search”.
