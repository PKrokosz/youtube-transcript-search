# youtube-transcript-search

Serwer MCP + CLI, który **przeszukuje transkrypcje filmów YouTube pod kątem słów kluczowych**.

Używający agentów (Claude Desktop / Claude Code / OpenCode / Cursor) mogą pytać:
> „znajdź filmy o X, w których ktoś mówi *Y*"

i dostają listę filmów z liczbą wystąpień oraz kontekstem wokół trafień.

## Jak to działa

1. **Wyszukanie filmów** — `yt-dlp` w trybie `ytsearchN:` (bez pobierania wideo).
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

# jeden film
node youtube-transcripts.mjs --video gYU9-dVdgkA --keywords rust

# pełny tekst transkrypcji
node youtube-transcripts.mjs --url "https://www.youtube.com/watch?v=gYU9-dVdgkA" --raw
```

## Zmienne środowiskowe
| Zmienna | Domyślnie | Znaczenie |
|---|---|---|
| `YT_DLP` | `%USERPROFILE%\.local\bin\yt-dlp.exe` | ścieżka do yt-dlp |
| `TMP` | katalog temp | miejsce na tymczasowe pliki VTT |

## Ograniczenia
- **Rate limit**: YouTube zwraca HTTP 429 przy masowym pobieraniu napisów.
  Narzędzie ponawia 3× z rosnącą przerwą (4/8/12 s). Przy dużej skali
  potrzebny jest proxy residential — obsługa proxy jest w planie (patrz TODO w repo agentmg).
- **Język napisów**: domyślnie `en`. Dla polskich filmów użyj `--langs pl`
  (obsługiwane przez yt-dlp; kolejność prób: `en,pl`).
- **Brak napisów**: część filmów nie ma napisów w danym języku — wtedy
  `transcriptAvailable: false`.
- Napisy są chronione prawami autorskimi — używaj lokalnie / do researchu.

## Testy
```bash
node e2e-youtube.mjs      # 9 kroków: handshake, lista narzędzi, search, transcript, trafienia
```
Test wymaga internetu i zainstalowanego `yt-dlp`.

## Licencja
MIT — patrz `LICENSE`.
