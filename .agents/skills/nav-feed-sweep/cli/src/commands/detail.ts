import {
  baseUrl,
  normalizeId,
  resolveToken,
  toDetail,
  writeError,
  type FeedEntryDetail,
  type JobDetailResult,
} from "../helpers.js"

export interface DetailOpts {
  id: string
  format: "json" | "plain"
}

function renderPlain(job: JobDetailResult): string {
  const lines = [job.title, `${job.company ?? "—"} · ${job.location ?? "—"}`]
  const field = (label: string, value: string | null) => {
    if (value) lines.push(`${label}: ${value}`)
  }
  field("Publisert", job.date)
  field("Søknadsfrist", job.deadline)
  field("Status", job.status)
  field("Sektor", job.sector)
  field("Ansettelsesform", job.employment_type)
  field("Omfang", job.extent)
  field("Kilde", job.source)
  field("Kategorier", job.categories.length ? job.categories.join(", ") : null)

  lines.push("", job.description ?? "(ingen annonsetekst)", "")
  field("Søk her", job.apply_url)
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
    const token = await resolveToken()
    const response = await fetch(`${baseUrl()}/api/v1/feedentry/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    })
    if (response.status === 404) {
      writeError("job not found in the feed", "NOT_FOUND")
      return 1
    }
    if (!response.ok) {
      writeError(`NAV feed request failed: ${response.status} ${response.statusText}`, "DETAIL_FAILED")
      return 1
    }

    const entry = (await response.json()) as FeedEntryDetail
    const job = toDetail(entry)

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
