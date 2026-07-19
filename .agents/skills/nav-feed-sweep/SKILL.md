---
name: nav-feed-sweep
version: 1.0.0
description: >
  Use this skill to sweep NAV's official job-vacancy feed API for everything
  published in Norway within a time window — a daily or weekly "what's new"
  pass, rather than a keyword search. It is the sanctioned NAV API
  (pam-stilling-feed), free and token-authenticated. For "find me X jobs in Y"
  use nav-search instead; this feed has no keyword parameter. Trigger phrases:
  what's new in Norwegian jobs, new job ads today, daily job sweep, NAV feed,
  nye stillinger i dag, nye stillingsannonser, siste stillinger.
context: fork
enabled: false  # redundant with nav-search day to day; enable for exhaustive sweeps
allowed-tools: Bash(bun run .agents/skills/nav-feed-sweep/cli/src/cli.ts *)
---

# nav-feed-sweep

Walks [NAV's official job-vacancy feed](https://navikt.github.io/pam-stilling-feed/) — the
sanctioned API behind arbeidsplassen.nav.no. Free, documented, token-authenticated.

## When to use this rather than nav-search

They answer different questions:

| Question | Skill |
|---|---|
| "Find me devops jobs in Oslo" | **nav-search** — it has a real search index |
| "Show me everything published since yesterday" | **nav-feed-sweep** |

This is a **chronological event feed, not a search index**. There is no keyword parameter, so
`--query` filters client-side after walking the feed. Using it for keyword search means pulling
thousands of entries to find a handful — that is what `nav-search` is for.

**Ships disabled** (`enabled: false`) because it duplicates `nav-search` for everyday use. Enable
it when you want an exhaustive sweep rather than a ranked search.

## Two things the feed will do to you

- **It reports every ad *state change*, not just live ads.** Roughly a third of a typical page is
  `INACTIVE` — filled or expired positions. The skill drops these by default; `--include-inactive`
  keeps them. Without that filter a sweep sends you after jobs that no longer exist.
- **It reaches back to ~2019.** Always bounded by `--since` (default 1 day) and capped at 10
  pages, so a wide window cannot walk years of history.

## Authentication

Set `NAV_FEED_TOKEN` to a registered token — free, email `nav.team.arbeidsplassen@nav.no`, and
what NAV asks anyone building on the feed to do.

Without it the skill fetches NAV's public development token automatically. That token **rotates at
irregular intervals**, so a sudden auth failure usually means it moved rather than anything being
broken; the error message says so.

## Commands

### sweep

```bash
bun run .agents/skills/nav-feed-sweep/cli/src/cli.ts sweep --since 1 --format table
```

- `--since <days>` — how far back to walk. Default 1.
- `--query`, `-q` `<text>` — keep entries whose title or employer contains this (client-side).
- `--municipal <names>` — kommune filter, comma-separated.
- `--limit`, `-n` `<n>` — max results. Default 50.
- `--include-inactive` — also report filled/expired ads. Off by default.
- `--format <fmt>` — `json` (default), `table`, `plain`.

### detail

```bash
bun run .agents/skills/nav-feed-sweep/cli/src/cli.ts detail <uuid|url> --format plain
```

Fetches the full ad behind a feed entry, including the advert text.

## Usage examples

```bash
# Everything new since yesterday
bun run .agents/skills/nav-feed-sweep/cli/src/cli.ts sweep --since 1 --format table

# Developer roles in Oslo from the last three days
bun run .agents/skills/nav-feed-sweep/cli/src/cli.ts sweep --since 3 -q utvikler --municipal Oslo --format table

# Full record for one ad
bun run .agents/skills/nav-feed-sweep/cli/src/cli.ts detail 80df5041-7bb3-4ba5-87d4-c814e6770e8f --format plain
```

## Output formats

| Format | Use |
|---|---|
| `json` | Default. `{ "meta": {count, page, total, scanned, since_days}, "results": [...] }` |
| `table` | Fixed-width columns: ID, TITTEL, BEDRIFT, STED, ENDRET. |
| `plain` | Readable blocks. |

`meta.scanned` reports how many feed entries were examined to produce the results — useful for
seeing how much of the feed a filter is discarding.

Results carry `id`, `title`, `company`, `location`, `date`, `url`, `status`. Missing values are
`null`, never omitted. `url` points at the public ad page on arbeidsplassen, not the API path,
because that is what a person wants to open.

All errors are written to **stderr** as `{ "error": "...", "code": "..." }` and the process exits
with code `1`.

## Notes

- `date` is the entry's `date_modified` (when NAV last changed the ad), not strictly its
  publication date. `detail` returns the true `published` date.
- Feed entries are thin — uuid, status, title, employer, municipality. Anything more (advert text,
  county, deadline, sector) requires `detail`.
- Pagination follows the feed's own `next_url`; entries repeat across page boundaries and are
  deduplicated by uuid.
