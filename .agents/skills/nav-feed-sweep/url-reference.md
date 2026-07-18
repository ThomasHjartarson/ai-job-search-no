# NAV job-vacancy feed (pam-stilling-feed) — endpoint reference

Official docs: <https://navikt.github.io/pam-stilling-feed/>
Terms: <https://arbeidsplassen.nav.no/vilkar-api>

This is a **sanctioned API**, not a scrape. Free to use; NAV asks consumers to register.

## Authentication

Bearer token in the `Authorization` header.

| Source | How | Notes |
|---|---|---|
| Registered token | Email `nav.team.arbeidsplassen@nav.no` | Free. Preferred. Set `NAV_FEED_TOKEN` |
| Public dev token | `GET /api/publicToken` | **Rotates at irregular intervals** |

`/api/publicToken` answers with a human-readable blurb wrapping the JWT, not bare JSON:

```
Current public token for Nav Job Vacancy Feed:
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

so the token is extracted with `/eyJ[A-Za-z0-9_.-]+/` rather than parsed.

## Endpoints

| Purpose | Request |
|---|---|
| Feed page | `GET /api/v1/feed` |
| Entry detail | `GET /api/v1/feedentry/<uuid>` |

Base URL: `https://pam-stilling-feed.nav.no` (overridable via `NAV_FEED_URL`, which the tests use
to point at a localhost server).

### Windowing and pagination

There is **no keyword, location or date query parameter**. Two controls only:

- `If-Modified-Since: <HTTP-date>` — start the walk at a point in time. This is the only way to
  bound it; the feed reaches back to ~2019.
- `next_url` / `next_id` in the response — follow for the next page. Both `null` at the end.

Verified: 1000 items per page. `If-Modified-Since` two days back returned entries spanning exactly
that window.

## Response shapes

### Feed page (JSON Feed 1.1)

```jsonc
{
  "version": "https://jsonfeed.org/version/1.1",
  "title": "NAV job vacancy feed",
  "next_url": "…", "next_id": "be71fb04-…",   // null at the end
  "items": [
    {
      "id": "aacf9c18-…",
      "url": "/api/v1/feedentry/aacf9c18-…",   // API path, not the public page
      "title": "Stillingsannonse",             // generic, not the job title
      "date_modified": "2026-07-18T00:13:52+02:00",
      "_feed_entry": {                          // the useful part
        "uuid": "aacf9c18-…",
        "status": "ACTIVE",                     // or INACTIVE
        "title": "Devops-utvikler",             // the real job title
        "businessName": "INSTECH SOLUTIONS AS",
        "municipal": "BERGEN",
        "sistEndret": "2026-07-18T00:13:52+02:00"
      }
    }
  ]
}
```

Note the top-level `title` is always "Stillingsannonse" — the job title lives in `_feed_entry`.
Entries are thin; anything richer needs `detail`.

### Entry detail

```jsonc
{
  "uuid": "…", "status": "ACTIVE", "sistEndret": "…",
  "ad_content": {
    "title": "…", "jobtitle": "…", "description": "<p>full advert HTML</p>",
    "published": "…", "expires": "…", "applicationDue": "21.08.2026",
    "applicationUrl": "…", "link": "…", "source": "Stillingsregistrering",
    "sector": "Privat", "engagementtype": "Fast", "extent": "Heltid", "positioncount": 1,
    "employer": { "name": "…", "orgnr": "…", "homepage": "…" },
    "workLocations": [{ "city": "…", "county": "…", "municipal": "…", "address": "…" }],
    "categoryList": [{ "name": "…" }], "contactList": [{ "name": "…", "email": "…" }]
  }
}
```

Note `ad_content` uses lowercase keys (`engagementtype`, `positioncount`) — the same convention as
NAV's *search* payload, and unlike the arbeidsplassen *detail page*, which is camelCase. Three
shapes across one organisation's surfaces; do not assume.

## Parsing notes

- **INACTIVE entries are ~a third of every page.** The feed is a log of ad state changes, so
  filled and expired positions flow through it. Filter on `status === "ACTIVE"` unless the caller
  explicitly wants history.
- **Entries repeat across page boundaries.** Deduplicate by uuid.
- **`date_modified` is not the publication date.** It is when NAV last touched the ad. Use
  `ad_content.published` from `detail` when the true posting date matters.
- **Masked ads.** Per NAV's docs, an ad that is actively stopped (rather than merely expired) has
  its title, employer and contact fields masked or removed. Such entries still appear in the feed.
- Place names are uppercase (`BERGEN`) and title-cased for display.

## Re-verification recipe

```bash
TOK=$(curl -sS https://pam-stilling-feed.nav.no/api/publicToken | grep -oE 'eyJ[A-Za-z0-9_.-]+' | head -1)
curl -sS -H "Authorization: Bearer $TOK" -H "Accept: application/json" \
  -H "If-Modified-Since: $(date -u -d '2 days ago' '+%a, %d %b %Y %H:%M:%S GMT')" \
  https://pam-stilling-feed.nav.no/api/v1/feed |
python3 -c "
import json,sys,collections
d=json.load(sys.stdin); it=d['items']
print('items:',len(it),'| next_id:',d.get('next_id'))
print('statuses:',collections.Counter(i['_feed_entry']['status'] for i in it))
"
```

A 401 here means the public token rotated — refetch it, or register your own.
