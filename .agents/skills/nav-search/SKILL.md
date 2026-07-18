---
name: nav-search
version: 1.0.0
description: >
  Use this skill to search live job ads in Norway from arbeidsplassen.nav.no, NAV's
  public national job board. It covers most of the Norwegian market including the
  majority of finn.no listings, which NAV republishes with a link back to the
  original finn ad. Trigger phrases: find a job in Norway, Norwegian jobs, jobs in
  Oslo/Bergen/Trondheim/Stavanger, NAV jobs, arbeidsplassen, finn.no jobs,
  ledige stillinger, finn jobb, stillingsannonse, jobbsøk, søke jobb,
  stilling i Oslo, jobb i Bergen, utlyste stillinger.
context: fork
enabled: true  # set to false to keep this portal installed but have /scrape skip it
allowed-tools: Bash(bun run skills/nav-search/cli/src/cli.ts *)
---

# nav-search

Searches [arbeidsplassen.nav.no](https://arbeidsplassen.nav.no), the job board run by NAV
(the Norwegian Labour and Welfare Administration). It is the closest thing Norway has to a
national register of job ads: employers post directly, and NAV additionally republishes ads
from other portals — finn.no above all.

## Why this is the finn.no channel

finn.no is Norway's largest job portal, and its `robots.txt` prohibits automated crawling
without written permission, citing åndsverksloven. NAV's `robots.txt` permits everything.

Because NAV republishes finn's ads, this skill reaches most finn inventory through a channel
that welcomes automation — **including the full advert text**, which the detail page carries even
for finn-sourced ads. Every FINN-sourced result also carries `finn_url`, the canonical finn
posting, for opening and applying there.

Measured share of results NAV attributes to FINN (July 2026, one page per query):

| Query | FINN-sourced |
|---|---|
| utvikler | 76% |
| prosjektleder | 68% |
| selger | 69% |
| data scientist | 64% |
| regnskap | 41% |
| sykepleier | 4% |

Coverage is strongest for tech and commercial roles. Healthcare and public-sector employers
tend to post straight to NAV, so finn matters less there — the ads are still here.

## When to use this skill

- Any job search targeting Norway or a Norwegian city.
- Whenever finn.no coverage is wanted — this is the compliant route to it.
- As the default Norwegian portal in `/scrape`.

## Commands

### search

```bash
bun run .agents/skills/nav-search/cli/src/cli.ts search -q "utvikler" --county Oslo --limit 10 --format table
```

- `--query`, `-q` `<text>` — keywords (title, skill, role). Optional.
- `--jobage <days>` — published within N days. Any positive value works. NAV's own
  `published` filter only accepts `now/d`, `now-3d` and `now-7d`, so windows up to 7 days are
  narrowed server-side and the exact cutoff is always applied client-side against each ad's
  date. Windows beyond 7 days are filtered purely client-side, which means more pages are
  fetched (still capped at 10) and `meta.total` reflects NAV's pre-filter count.
- `--page <n>` — 1-indexed page, 25 ads per page. Default 1.
- `--limit`, `-n` `<n>` — max results. Default 25. Pages are fetched serially as needed,
  hard-capped at 10 pages so a large limit cannot become an unbounded crawl.
- `--county <names>` — fylke filter, comma-separated (`--county Oslo,Vestland`). Case and a
  trailing "fylke" are both tolerated.
- `--municipal <names>` — kommune filter, comma-separated.
- `--source <names>` — keep only these NAV sources: `FINN`, `IMPORTAPI`, `AMEDIA`, `DIR`.
  Use `--source FINN` to see only ads that originated on finn.no.
- `--format <fmt>` — `json` (default), `table`, `plain`.

### detail

```bash
bun run .agents/skills/nav-search/cli/src/cli.ts detail <uuid|url> --format plain
```

- `<uuid|url>` — a NAV ad uuid (a search result's `id`) or a full
  `https://arbeidsplassen.nav.no/stillinger/stilling/<uuid>` URL.
- `--format <fmt>` — `json` (default), `plain`.

## Usage examples

```bash
# Developer roles in Oslo, last two weeks
bun run .agents/skills/nav-search/cli/src/cli.ts search -q "utvikler" --county Oslo --jobage 14 --format table

# Only ads that came from finn.no, in Vestland
bun run .agents/skills/nav-search/cli/src/cli.ts search -q "prosjektleder" --county Vestland --source FINN --format plain

# Data roles nationwide, 50 results
bun run .agents/skills/nav-search/cli/src/cli.ts search -q "data scientist" --limit 50

# Nurses in Bergen kommune
bun run .agents/skills/nav-search/cli/src/cli.ts search -q "sykepleier" --municipal Bergen --format table

# Full record for one ad
bun run .agents/skills/nav-search/cli/src/cli.ts detail 80df5041-7bb3-4ba5-87d4-c814e6770e8f --format plain
```

## Output formats

| Format | Use |
|---|---|
| `json` | Default. `{ "meta": {count, page, total}, "results": [...] }` — for `/scrape` and scripts. |
| `table` | Fixed-width columns for scanning: ID, TITTEL, BEDRIFT, STED, DATO, KILDE. |
| `plain` | Readable blocks including the application deadline and the finn.no link. |

Each result carries `id`, `title`, `company`, `location`, `date`, `url` plus the Norway-specific
`source`, `finn_url`, `county`, `municipal` and `deadline`. Missing values are `null`, never omitted.

All errors are written to **stderr** as `{ "error": "...", "code": "..." }` and the process exits
with code `1`.

## Notes

- **Use `detail` to get the posting text — including for finn ads.** Search results leave
  `description` empty for FINN-sourced ads, but the *detail* page carries the full advert text
  even for those. So `search` then `detail` is enough for `/apply`, and there is normally no need
  to fetch anything from finn.no at all. `finn_url` remains available for opening the original.
- **Search and detail return different shapes.** Search streams lowercase `uuid`-keyed ad
  objects; the detail page keys the ad `adData` with `id` and camelCase fields, and streams long
  text lazily as an RSC reference the skill resolves. The `uuid` objects on a *detail* page are
  the suggested-ads sidebar — never the ad you asked for.
- **NAV soft-404s with HTTP 200.** A missing ad returns a page carrying no `adData`, only
  suggestions. The skill reports `NOT_FOUND`, and it verifies the returned ad's id matches the
  one requested (`ID_MISMATCH` otherwise) so it can never hand back the wrong job.
- **Paging is by offset.** NAV fixes the page size at 25 and ignores a `size` parameter.
- Place names come back uppercase from NAV and are rendered as words (`BERGEN` → `Bergen`).
  Oslo is both a city and a county, so it renders once rather than "Oslo, Oslo".
- Deadlines may be a date or meaningful free text such as `Snarest` (as soon as possible);
  both are passed through.
