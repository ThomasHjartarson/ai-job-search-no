# Maintaining this fork

This is the **Norwegian fork** of [MadsLorentzen/ai-job-search](https://github.com/MadsLorentzen/ai-job-search),
retargeted from Denmark to Norway. This file is for whoever maintains the fork; end-user
setup lives in [README.md](README.md) and [SETUP.md](SETUP.md).

## Two repositories, one lineage

| Repo | Remote | Holds | Pushes to |
|------|--------|-------|-----------|
| **Public fork** (this repo) | `origin` → `ThomasHjartarson/ai-job-search-no` | Framework + Norwegian portals (`nav-search`, `nav-feed-sweep`) | `origin` (public) |
| **Private workspace** | `origin` → `ThomasHjartarson/ai-job-search-personal` | Everything here **plus** `finn-search` and real profile data | its own private `origin` |
| **Upstream** | `upstream` → `MadsLorentzen/ai-job-search` | The universal template | — (read only) |

**This repo is finn-free by construction.** `finn-search` scrapes finn.no, whose `robots.txt`
prohibits automated crawling, so it must never be published. Rather than guard against that
with a hook, the split keeps `finn-search` out of this repo entirely — it lives only in the
private workspace, which has a `.githooks/pre-push` guard as a second line of defence. NAV
(`nav-search`) republishes 65–76% of finn's tech/commercial ads with full advert text, so
public users lose little. See [README.md](README.md#reaching-finnno).

The private workspace is a content superset of this repo, so it consumes public changes by
**merging from** `public`, never by pushing its branch here.

## Pulling upstream updates

Upstream keeps maintaining the four Danish demo portals this fork deleted
(`jobnet` / `jobindex` / `jobbank` / `jobdanmark-search`), so a plain `git merge upstream/master`
throws a modify/delete conflict on each of their files — on **every** pull. Use the resolver:

```bash
tools/merge_upstream.sh          # fetches upstream, merges upstream/master
```

It auto-resolves any conflict (or clean-added file) under a portal directory that no longer
exists in this tree as a deletion — the retired-portal case — and **stops for a human on any
other conflict**, because methodology files (`apply.md`, `README.md`, the skill templates)
carry Norwegian retargeting that must be read, not auto-merged. The rule is derived from the
tree, not a hardcoded portal list, so it keeps working as portals come and go. Resolve any
remaining conflicts by keeping the Norwegian content and adopting upstream's methodology
change around it (see [SETUP.md](SETUP.md) §"Pulling upstream updates"), then
`git commit`.

`tools/check_upstream_updates.py` is complementary: it flags drift in the nine
`framework_version`-marked methodology files, none of which the fork retargets. Run it after
merging to confirm nothing was missed.

## Adding a portal for a new market

`/add-portal` scaffolds a portal skill that `/scrape` discovers automatically (it globs
`.agents/skills/*/SKILL.md`). The only manual registration is adding the directory name to the
`cli-checks` matrix in `.github/workflows/ci.yml`. Per upstream policy, country-specific
portals stay in forks and are not PR'd upstream — the generator is upstream's, its output is
yours.
