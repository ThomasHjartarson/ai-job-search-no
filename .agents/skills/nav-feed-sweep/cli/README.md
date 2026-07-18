# nav-feed-sweep CLI

Walks [NAV's official job-vacancy feed](https://navikt.github.io/pam-stilling-feed/) — the
sanctioned API. Zero runtime dependencies.

```bash
bun install
bun run src/cli.ts sweep --since 1 --format table
bun run src/cli.ts detail <uuid> --format plain
bun run typecheck
bun test
```

See [`../SKILL.md`](../SKILL.md) for flags and [`../url-reference.md`](../url-reference.md) for the
API map.

## This is a feed, not a search index

There is no keyword parameter. `--query` filters client-side after walking the feed, so using this
for keyword search means pulling thousands of entries to find a few — that is
[`nav-search`](../../nav-search/SKILL.md)'s job. Use this for "everything new since X".

## Two behaviours worth knowing

**A third of entries are INACTIVE.** The feed logs ad *state changes*, so filled and expired
positions flow through it. `sweep` drops them unless `--include-inactive` is passed.

**The window must be bounded.** The feed reaches back to ~2019. `--since` (default 1 day) sets an
`If-Modified-Since` header, and `MAX_PAGES` caps the walk at 10 pages.

## Auth

`NAV_FEED_TOKEN` if you have a registered token (free — email `nav.team.arbeidsplassen@nav.no`).
Otherwise the public development token is fetched automatically; NAV rotates it, so a 401 usually
means it moved rather than anything being broken.

## Testing

`bun test` is network-free — `globalThis.fetch` is stubbed, and the one test that needs a real
payload serves it from a localhost `Bun.serve` via `NAV_FEED_URL`.

That test is a regression guard for a bug worth understanding precisely, because the obvious
description of it is wrong.

The CLIs used to end with `process.exit(code)`, which discards stdout that has not drained. Piped
output was cut at the 64KB pipe buffer — a 137KB result arrived as exactly 65536 bytes of invalid
JSON, and `/scrape` consumes this output through a pipe.

But `process.exit()` alone does not do it. The trigger is `process.exit()` **plus more than one
HTTP request in the same process**. Measured on this CLI:

| Run | Bytes through `\| cat` |
|---|---|
| token fetch + feed fetch | 65536 (truncated) |
| feed fetch only (`NAV_FEED_TOKEN` set) | 137910 (intact) |

A single-request CLI does not reproduce it at all — a sibling skill was tested to 1.5MB of output
and came through whole. That is why `sweep` is affected (it fetches a token, then the feed) and
why any command that pages is at risk, while a one-shot lookup is not.

Two things will hide this bug if you try to test it: `Bun.spawn`'s own pipe drains eagerly enough
to mask it (read the child's stdout directly and you get the full payload either way), and a large
argv hits `E2BIG`. The test therefore drives the real CLI through a real shell pipe (`| cat`)
against a localhost server, and was verified to fail when `process.exit()` is reintroduced.
