# youtube-transcript-search

Serwer MCP + CLI, który **przeszukuje transkrypcje filmów YouTube pod kątem słów kluczowych**.

Używający agentów (Claude Desktop / Claude Code / OpenCode / Cursor) mogą pytać:
> „znajdź filmy o X, w których ktoś mówi *Y*"

i dostają listę filmów z liczbą wystąpień oraz kontekstem wokół trafień.

## Jak to działa

1. **Wyszukanie filmów** — YouTube Data API `search.list` (gdy jest `YOUTUBE_API_KEY`)
   z fallbackiem na `yt-dlp` w trybie `ytsearchN:` (bez pobierania wideo).
2. **Pobranie napisów** — `yt-dlp --write-subs --write-auto-subs --sub-format vtt`
   (napisy manualne lub auto-generowane).
3. **Czyszczenie** — auto-napisy YouTube to „toczące się okno" (każdy cue zawiera
   poprzedni tekst). Parser bierze krótkie cue’y (~10 ms) i składa z nich czysty tekst.
4. **Wyszukiwanie słów** — regex case-insensitive + kontekst wokół trafień.

> Dlaczego `yt-dlp`, a nie scraping? YouTube zamknęło endpointy:
> `/api/timedtext` zwraca HTTP 200 z **pustym body** (wymaga tokenu `pot`),
> a `youtubei/v1/get_transcript` zwraca HTTP 400 „Precondition check failed”.
> Przeglądarka (także headless) renderuje po kilku załadowaniach w jednej sesji
> stronę „tylko player” — bez opisu i transkrypcji.

## Wymagania
- **Node.js >= 22**
- **yt-dlp** (zewnętrzna zależność):
  ```
  uv tool install yt-dlp        # %USERPROFILE%\.local\bin\yt-dlp.exe
  # albo: pip install yt-dlp
  ```
  Ścieżkę nadpisz zmienną `YT_DLP`.

## Instalacja
```bash
git clone https://github.com/PKrokosz/youtube-transcript-search.git
cd youtube-transcript-search
npm install          # brak zależności runtime, ale porządkuje skrypty
```

## Użycie jako serwer MCP

```bash
node mcp-server.mjs
```

Konfiguracja klienta:
```json
{
  "mcpServers": {
    "youtube-transcript-search": {
      "command": "node",
      "args": ["C:/Users/admin/Desktop/youtube-transcript-search/mcp-server.mjs"]
    }
  }
}
```

### Narzędzia
| Narzędzie | Co robi | Argumenty |
|---|---|---|
| `youtube_search` | filmy po frazie | `query`, `limit` |
| `youtube_transcript` | transkrypcja jednego filmu + trafienia słów | `video` (id lub URL), `keywords[]`, `langs`, `maxChars` |
| `youtube_transcript_search` | **przeszukiwanie transkrypcji**: filmy → napisy → trafienia | `query`, `keywords[]`, `limit`, `langs` |

Przykład wyniku `youtube_transcript_search`:
```json
[
  {
    "id": "gYU9-dVdgkA",
    "title": "Cloudflare built a browser for AI agents in Rust",
    "channel": "Let's Get Rusty",
    "url": "https://www.youtube.com/watch?v=gYU9-dVdgkA",
    "transcriptAvailable": true,
    "transcriptLength": 7125,
    "keywords": [
      { "keyword": "rust", "count": 18, "contexts": ["…they did it in Rust. The best part…"] }
    ]
  }
]
```

## Użycie z CLI
```bash
# filmy + przeszukanie transkrypcji
node youtube-transcripts.mjs --search "rust headless browser" --limit 3 --keywords rust,obscura

# wymuszenie backendu wyszukiwania (api | yt-dlp)
node youtube-transcripts.mjs --search "rust headless browser" --limit 3 --backend api

# jeden film
node youtube-transcripts.mjs --video gYU9-dVdgkA --keywords rust

# pełny tekst transkrypcji
node youtube-transcripts.mjs --url "https://www.youtube.com/watch?v=gYU9-dVdgkA" --raw
```

## Zmienne środowiskowe
| Zmienna | Domyślnie | Znaczenie |
|---|---|---|
| `YT_DLP` | `%USERPROFILE%\.local\bin\yt-dlp.exe` | ścieżka do yt-dlp |
| `YOUTUBE_API_KEY` | — | klucz YouTube Data API v3 (backend wyszukiwania `api`) |
| `YOUTUBE_SEARCH_BACKEND` | `auto` | `auto` (API gdy jest klucz, inaczej yt-dlp), `api` (tylko API, bez fallbacku), `yt-dlp` |
| `TMP` | katalog temp | miejsce na tymczasowe pliki VTT |
| `YTS_PROXY` | — | proxy rezydencjalne (też `HTTPS_PROXY`, `ALL_PROXY`; kolejność: `YTS_PROXY` → `HTTPS_PROXY` → `ALL_PROXY` → config) |
| `YTS_COOKIES_FILE` | `~/.config/yts/cookies.txt` | ścieżka do pliku cookies (nigdy zawartość, nigdy w argv) |
| `YTS_JOB_DIR` | `<katalog skryptu>/jobs` | katalog stanu jobów batch |
| `YTS_CACHE_DIR` | `<katalog skryptu>/.cache` | katalog cache napisów i raportów |
| `YTS_INTERVAL_MS` | `4000` | odstęp między filmami w jobie (placeholder — patrz etap 0) |
| `YTS_RL_STOP` | `5` | stop po N kolejnych 429 |
| `YTS_API_BASE` | `https://www.googleapis.com/youtube/v3` | baza API (seam do testów offline) |
| `YTS_QUIET` | — | `1` wyłącza logi postępu na stderr (log per job zostaje) |

Klucza można też podać w pliku `youtube.config.json` (gitignored —
skopiuj `youtube.config.example.json`):
```json
{ "youtubeApiKey": "AIza...", "searchBackend": "auto" }
```

### Backend wyszukiwania
Krok 1 (znalezienie filmów) ma dwie implementacje:
- **`api`** — `GET https://www.googleapis.com/youtube/v3/search?part=snippet&q=...&type=video&maxResults=...&key=KLUCZ`
  + dodatkowo `videos.list` (1 jednostka) po `duration`. Koszt `search.list`:
  100 jednostek quota na zapytanie (domyślnie 10 000/dzień ⇒ ~100 zapytań).
  Zwraca też `publishedAt`, `channelId`, `thumbnail`, `description`.
- **`yt-dlp`** — dotychczasowe `ytsearchN:` (bez klucza, ale bardziej kruche).

W trybie `auto` błąd API (brak quota, 403/429) automatycznie przełącza na `yt-dlp`
(komunikat na stderr). Możesz wymusić backend flagą CLI `--backend api|yt-dlp`;
każdy wynik zawiera pole `searchBackend`.

## Ograniczenia
- **Rate limit (429)**: YouTube zwraca HTTP 429 przy masowym pobieraniu napisów.
  Ścieżka interaktywna ponawia 3× z rosnącą przerwą; tryb batch (`yts-job`)
  stosuje odstęp między filmami, backoff 5/10/20 min z jitterem i zatrzymuje
  joba po N kolejnych limitach — wtedy wracasz `yts-job resume <jobId>`.
  Proxy residential jest **wspierane** przez `YTS_PROXY` / `HTTPS_PROXY` /
  `ALL_PROXY` (nigdy przez flagę w linii komend — D6).
- **Język napisów**: w trybie interaktywnym domyślnie `en`. W trybie joba
  `--langs` jest **wymagane i nie ma wartości domyślnej** (D5) — job polskich
  filmów nie może cicho odziedziczyć kolejności angielskiej.
- **Brak napisów**: część filmów nie ma napisów w danym języku — wtedy
  `transcriptAvailable: false` w ścieżce interaktywnej i `failed: no_subtitles`
  w jobie (inny powód niż `rate_limited`, nigdy mylone w kodzie).
- Napisy są chronione prawami autorskimi — używaj lokalnie / do researchu.

## Testy
```bash
node test/yts-job.test.mjs  # offline: stan, classifier, cache, polityka, CLI (bez sieci)
node e2e-youtube.mjs        # live: handshake MCP, search, transcript, trafienia, odmowy D7
npm run test:offline        # to samo co pierwsza linia
npm test                    # e2e
```
Test e2e wymaga internetu, `yt-dlp` oraz (opcjonalnie) `YOUTUBE_API_KEY` dla
backendu `api`. Offline suite używa shima `YT_DLP` i fixture'u API — zero sieci,
zero sleepów.

## Tryb batch — `yts-job`

Dla 30–100 filmów, gdzie przebieg liczą się godziny lub dni. Job przeżywa
przerwanie: to, co pobrane, jest w cache i **nigdy nie jest pobierane ponownie**
(Goal 1). Ścieżka MCP i CLI interaktywne działają jak do tej pory — batch jest
osobnym wejściem (`yts-job.mjs`) i nie zmienia kontraktu narzędzi.

```bash
# lista ID (bez klucza API)
node yts-job.mjs new --ids-file ids.txt --langs pl,en --keywords nawrocki,prezydent

# fraza z filtrami (wymaga YOUTUBE_API_KEY — bez cichego fallbacku na yt-dlp, D13)
node yts-job.mjs new --search "kim jest prezydent polski" --langs pl,en \
  --keywords nawrocki --filter videoCaption=closedCaption --filter order=date \
  --max-videos 100 --interval-ms 4000

# uploads kanału / playlista (wymagają --max-videos)
node yts-job.mjs new --channel @zurnalistapl --max-videos 100 --langs pl,en --keywords nawrocki
node yts-job.mjs new --playlist PLxxxx --max-videos 50 --langs pl --keywords rust

# rozwiazanie zrodla bez pobran i bez state.json
node yts-job.mjs new --search "prezydent" --langs pl --keywords a --max-videos 5 --dry-run

# wszystko co potem
node yts-job.mjs status <jobId>
node yts-job.mjs stop <jobId>          # czyste zatrzymanie po biezacym filmie
node yts-job.mjs resume <jobId>        # zawsze: zero ponownych pobran dla done
node yts-job.mjs resume <jobId> --refresh            # ponow done+stale (D10)
node yts-job.mjs resume <jobId> --retry-stopped     # tylko failed: bot_check/proxy_error (D10)
node yts-job.mjs resume <jobId> --require-same-version
node yts-job.mjs report <jobId> [--keywords a,b]     # offline, z cache
node yts-job.mjs repair <jobId>         # roiz jazdu stan vs cache
node yts-job.mjs doctor                 # kazde ustawienie z zrodla wartosci
```

### Co job robi z każdym filmem (D5)
Jeden proces listuje dostępne ścieżki napisów (`--print-json`), potem **dokładnie
jedno** pobranie z jedną flagą: `--write-subs --no-write-auto-subs` albo
`--write-auto-subs --no-write-subs`. Język = pierwszy z `--langs`, który ma
ścieżkę; w tym języku **manual przed auto**. Napisy auto i manual lądą w tym samym
pliku (`s.<id>.NA.<lang>.vtt`) — marker `NA` w nazwie **nie** rozstrzyga rodzaju;
rozstrzyga go zawartość VTT (okno przewijania `<c>…</c>` = auto).

### Powody końca filmu (`reason`, D1)
`no_subtitles` i `video_unavailable` są terminalne (nigdy ponawiane); `unknown` i
`timeout` ponawiane do wyczerpania budżetu prób; `rate_limited` zostawia film
`pending` i ponawia go po cooldownie, a job zatrzymuje się po N kolejnych 429;
`bot_check` i `proxy_error` zatrzymują job od razu i wracają tylko z
`--retry-stopped`. Raport zawsze podaje liczniki — „0 trafień" i „0 transkryptów"
to różne zdania (Goal 3).

### Układ plików (wszystko gitignored)
```
jobs/<jobId>/state.json      # prawda o wyniku kazdego filmu (zapis atomowy + .bak)
jobs/<jobId>.log             # log postepu (jeden wiersz na film + podsumowanie co 10)
jobs/<jobId>.lease.json      # straznik jednego zapisujacego (TTL 6 h)
.cache/subs/<id>.<lang>.<kind>.p<v>.txt  # prawda o tresci (+ .meta.json, + surowe .vtt)
.cache/reports/<jobId>.json  # raport (pochodny, regenerowalny offline)
```
Autorytet: **stan mówi co się stało, cache mówi czego doszliśmy** — `done` wymaga
obu; brak pliku w cache rozstrzyga `repair` i rekonciliacja przy starcie.

### Kody wyjścia
`0` zakończono (także częściowo i przy pustym zbiorze)  | `1` błąd użycia
`3` stop po 429 albo bot-check  | `4` infra (proxy, yt-dlp, stan, lease, quota API)
`5` problem konfiguracji lub brak klucza API dla `--search` (D13).

### Proxy
Wartość proxy DOCIERA do procesu yt-dlp zmienną, którą yt-dlp czyta
(`HTTPS_PROXY`, a przy `ALL_PROXY` także `ALL_PROXY`) — niezależnie od tego, czy
wzięła się z `YTS_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` czy z pliku config. Flaga
`--proxy` wlinii komend jest zabroniona: dane dostępowe są w URL-u, a argv jest
widoczny na liście procesów. Komunikat stopu i polecenie resume nigdy nie
zawierają proxy ani cookies (D14).

## Licencja
MIT — patrz `LICENSE`.
