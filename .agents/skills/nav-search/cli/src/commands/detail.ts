import {
  detailToResult,
  extractAdData,
  extractRscBlob,
  fetchHtml,
  normalizeId,
  writeError,
  type JobDetailResult,
} from "../helpers.js"

export interface DetailOpts {
  id: string // a NAV uuid or an arbeidsplassen ad URL
  format: "json" | "plain"
}

/** A human-readable rendering of one ad: header, present fields, description. */
function renderPlain(job: JobDetailResult): string {
  const lines = [job.title, `${job.company ?? "—"} · ${job.location ?? "—"}`]

  const field = (label: string, value: string | null) => {
    if (value) lines.push(`${label}: ${value}`)
  }
  field("Publisert", job.date)
  field("Søknadsfrist", job.deadline)
  field("Sektor", job.sector)
  field("Ansettelsesform", job.employment_type)
  field("Omfang", job.extent)
  field("Kilde", job.source)

  lines.push("", job.description ?? "(ingen annonsetekst)", "")
  field("Søk her", job.apply_url)
  field("FINN", job.finn_url)
  lines.push(`URL: ${job.url}`, `id: ${job.id}`)
  return lines.join("\n")
}

export async function runDetail(opts: DetailOpts): Promise<number> {
  const id = normalizeId(opts.id)
  if (!id) {
    writeError(`could not parse a NAV ad id from "${opts.id}"`, "BAD_ID")
    return 1
  }
  try {
    const html = await fetchHtml(`/stillinger/stilling/${encodeURIComponent(id)}`)
    if (html === null) {
      writeError("job not found", "NOT_FOUND")
      return 1
    }

    const blob = extractRscBlob(html)
    const ad = extractAdData(blob)
    if (!ad) {
      // NAV answers a missing ad with HTTP 200 and a page that carries no
      // adData (only suggested ads), so this covers both "gone" and "markup
      // changed". Note the not-found *phrase* is no signal: it ships in the JS
      // bundle on every page, valid ones included.
      writeError(
        `NAV returned no ad data for ${id} — the ad may have been removed or NAV's markup changed`,
        "NOT_FOUND",
      )
      return 1
    }
    // Never return a different ad than the one asked for: the page also embeds
    // suggestions, and handing one back would mean applying to the wrong job.
    if (ad.id && ad.id !== id) {
      writeError(`NAV returned ad ${ad.id} for a request for ${id}`, "ID_MISMATCH")
      return 1
    }

    const job = detailToResult(ad, blob)

    if (opts.format === "plain") {
      process.stdout.write(renderPlain(job) + "\n")
    } else {
      process.stdout.write(JSON.stringify(job, null, 2) + "\n")
    }
    return 0
  } catch (e) {
    writeError(e instanceof Error ? e.message : String(e), "DETAIL_FAILED")
    return 1
  }
}
