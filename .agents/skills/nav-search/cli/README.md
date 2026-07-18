# nav-search CLI

Searches [arbeidsplassen.nav.no](https://arbeidsplassen.nav.no), NAV's public Norwegian job
board. Zero runtime dependencies — `bun install` here only pulls TypeScript dev types.

```bash
bun install
bun run src/cli.ts search -q "utvikler" --county Oslo --limit 10 --format table
bun run src/cli.ts detail <uuid> --format plain
bun run typecheck
bun test
```

See [`../SKILL.md`](../SKILL.md) for the full flag reference and
[`../url-reference.md`](../url-reference.md) for the endpoint and parsing map.

## How it works

The search page is a Next.js app that streams its data as React Server Component chunks
(`self.__next_f.push([1,"…"])`). Ad objects straddle chunk boundaries, so `helpers.ts`
concatenates every chunk, decodes the JS string escapes, then brace-balances JSON objects out of
the result. No HTML parser and no runtime dependency — the same approach as the
`linkedin-search` skill.

## Three things worth knowing

**Search and detail are different shapes.** Search streams lowercase `uuid`-keyed ad objects.
The detail page keys the ad `adData`, uses `id` and camelCase, and streams long strings lazily as
RSC references (`"adTextHtml":"$2c"` → a later `2c:T<hexlen>,<content>` chunk). The `uuid`
objects on a detail page are the *suggested ads* sidebar, not the ad you asked for.

**Detail carries the posting text, even for finn ads.** Search leaves `description` empty for
FINN-sourced ads, which makes it look like NAV only stores metadata. It does not — `detail`
returns the full advert. `finn_url` is still exposed for opening the original on finn.no.

**NAV soft-404s with HTTP 200.** A missing ad returns a page with no `adData`, only suggestions,
so `detail` reports `NOT_FOUND`. It also checks the returned ad's id against the requested one
(`ID_MISMATCH`) — handing back a suggestion would mean applying to the wrong job. Note the
"Vi fant dessverre ikke stillingsannonsen" string is *not* a usable signal: it ships in the JS
bundle on every page, valid ones included.

## Testing

`bun test` is fully network-free: parser tests run against RSC fixtures, command tests stub
`globalThis.fetch`, and the CLI contract tests assert on validation errors emitted before any
request. Run a live smoke test by hand after changing the parser:

```bash
bun run src/cli.ts search -q "utvikler" --limit 5 --format table
```
