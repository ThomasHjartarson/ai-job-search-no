# arbeidsplassen.nav.no — endpoint and parsing reference

Maintainer's map of what this skill depends on. When NAV changes its markup, this is the file
to re-verify.

## Access status

`https://arbeidsplassen.nav.no/robots.txt`:

```
User-agent: *
Disallow:

Sitemap: https://arbeidsplassen.nav.no/sitemap.xml
```

An empty `Disallow:` permits everything. No authentication, no API key, no rate-limit header
documented.

## Endpoints

| Purpose | Request | Notes |
|---|---|---|
| Search | `GET /stillinger?q=<kw>&from=<n>&county=<FYLKE>&published=now-<n>d` | HTML page, data in RSC chunks |
| Ad detail | `GET /stillinger/stilling/<uuid>` | Same RSC format. No JSON-LD on the page |

### Search parameters (verified July 2026)

| Param | Maps to CLI flag | Notes |
|---|---|---|
| `q` | `--query`, `-q` | Free-text. Omit for an unfiltered browse |
| `from` | `--page` | Offset, not a page number: `from = (page - 1) * 25` |
| `county` | `--county` | Uppercase fylke name, e.g. `OSLO`, `VESTLAND`. Repeatable |
| `municipal` | `--municipal` | Uppercase kommune name, e.g. `BERGEN`. Repeatable |
| `published` | `--jobage` | Relative form `now-14d`. Verified: `now-7d` cut 213 hits to 33 |
| `size` | — | **Ignored.** Page size is fixed at 25 |

`--limit` and `--source` are client-side: the skill pages until it has enough rows, and filters
on the ad's `source` field after parsing.

## Response structure

The search page is a Next.js app that streams data as React Server Component chunks:

```html
<script>self.__next_f.push([1,"<js-escaped json fragment>"])</script>
```

There are ~23 such chunks on a search page and **ad objects straddle chunk boundaries**, so the
parse is: collect every chunk → concatenate → decode the JS string escapes → scan the result.
Each `push()` is independently a valid JS string literal, so a chunk never ends mid-escape.

Ad objects are found by scanning for the literal `{"uuid":"` and brace-balancing forward
(string-aware, so braces inside ad prose don't unbalance it). Each object is parsed on its own
and a malformed one is skipped rather than failing the page.

`"totalAds":<n>` appears once per search page and is the total match count.

### Ad object (annotated sample, trimmed)

```jsonc
{
  "uuid": "80df5041-7bb3-4ba5-87d4-c814e6770e8f", // ad id; detail takes this
  "score": 20.99,                                  // relevance, not exposed
  "source": "FINN",                                // FINN | IMPORTAPI | AMEDIA | DIR
  "reference": "469427096",                        // finn ad id when source=FINN
  "published": "2026-07-14T08:12:27.9+02:00",
  "expires":   "2026-08-21T00:00:00+02:00",
  "applicationDue": "21.08.2026",                  // or ISO, or free text ("Snarest")
  "jobTitle": "Devops-utvikler",
  "title":    "Devops-utvikler",                   // prefer title, fall back to jobTitle
  "description": "",                               // EMPTY for FINN-sourced ads
  "status": "ACTIVE",                              // INACTIVE ads also appear
  "locationList": [
    { "country": "NORGE", "address": "Solheimsgaten 5", "city": "BERGEN",
      "postalCode": "5058", "county": "VESTLAND", "municipal": "BERGEN" }
  ],
  "employer": { "name": "Instech Solutions", "orgnr": "974004313",
                "homepage": "https://www.instech.no/", "sector": "Privat" },
  "categoryList": [{ "categoryType": "STYRK08", "name": "Programvareutviklere" }],
  "searchtagsai": ["Azure", "DevOps", "Kubernetes"],
  "applicationUrl": "https://www.finn.no/job-apply/469427096/apply"
}
```

## The detail page is a different shape

This is the trap in this portal. The search payload streams lowercase, `uuid`-keyed ad objects.
The **detail** page keys the main ad `adData`, uses `id` instead of `uuid`, and is camelCase
throughout:

```jsonc
"adData": {
  "id": "b3485a09-…",              // NOT "uuid"
  "status": "ACTIVE",
  "title": "Fullstack-AI utvikler til Iterate AS",
  "source": "FINN",
  "reference": "444782157",
  "adTextHtml": "$2c",             // RSC reference, resolved separately
  "engagementType": "Fast",        // camelCase (search uses "engagementtype")
  "extent": "Heltid",
  "positionCount": 2,
  "employer":    { "orgnr": "…", "name": "Iterate AS", "sector": "Privat", "homepage": "…" },
  "application": { "applicationDueDate": null, "applicationDueLabel": "Snarest",
                   "applicationUrl": "https://www.finn.no/job-apply/444782157/job/apply" },
  "locationList":[{ "city": "OSLO", "county": "OSLO", "municipal": "OSLO" }]
}
```

**The `{"uuid":` objects on a detail page are the suggested-ads sidebar, not the ad requested.**
Scanning for `{"uuid":` on a detail page silently returns someone else's job — which for a job
application tool is the worst possible failure. Match `adData.id` against the requested id.

### Lazy RSC references

Long strings are not inlined. `"adTextHtml":"$2c"` means "chunk 2c", which arrives later as:

```
2c:T14d0,<p>Norges skarpeste fagmiljø innen digital produktutvikling …
```

`T<hexlen>` is a **byte** length while the decoded blob is a JS string, so the two diverge as
soon as the ad contains æ/ø/å. Bound the content by scanning to the next `\n<hex>:` chunk marker
instead of trusting the prefix.

## Parsing notes

- **Place names are uppercase.** `BERGEN`, `VESTLAND`. Title-cased for display. Oslo is both a
  city and a county, so the two are collapsed rather than rendered "Oslo, Oslo".
- **`description` is empty in *search* results for FINN-sourced ads — but not in `detail`.**
  It is tempting to conclude NAV stores metadata only for republished finn ads. It does not: the
  detail page carries the full advert via `adTextHtml`. `finn_url` is built as
  `https://www.finn.no/<reference>` (finn resolves the bare ad id) and is still worth exposing so
  a person can open and apply on finn.
- **Deadlines have three shapes**: search gives `applicationDue` as `dd.mm.yyyy`, an ISO
  timestamp, or free text (`Snarest`, `Fortløpende`). Detail splits this into
  `application.applicationDueDate` (often null) and `application.applicationDueLabel`. Dates are
  normalised to `YYYY-MM-DD`; free text is kept as-is because it is meaningful.
- **Soft 404 with HTTP 200.** A missing ad returns a page with **no `adData`**, only suggestions.
  Absence of `adData` is the reliable signal. The phrase "Vi fant dessverre ikke
  stillingsannonsen" is **not** — it ships inside the JS bundle on every page, valid ads
  included, so matching on it reports every lookup as not-found.
- **`status` can be `INACTIVE`.** Search results are live ads in practice, but the field is
  exposed so callers can check.

## Re-verification recipe

```bash
curl -sSL -A "Mozilla/5.0" -H "Accept-Language: nb,no,en;q=0.9" \
  "https://arbeidsplassen.nav.no/stillinger?q=utvikler" -o page.html

python3 - <<'EOF'
import re, codecs, collections
h = open('page.html', encoding='utf-8').read()
blob = codecs.decode("".join(re.findall(r'self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)', h, re.S)), 'unicode_escape')
print("totalAds:", re.search(r'"totalAds":(\d+)', blob).group(1))
print("ads:", len(set(re.findall(r'"uuid":"([a-f0-9-]{36})"', blob))))
print("sources:", collections.Counter(re.findall(r'"source":"([A-Z_]+)"', blob)))
EOF
```

If `ads` is 0 the RSC envelope changed; if `sources` no longer contains `FINN` the
republication arrangement changed and the finn coverage claim needs revisiting.
