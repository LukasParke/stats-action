# GitHub Stats Action

A GitHub Action that collects versioned GitHub profile statistics for profile
sites, Remotion pipelines, and profile README summaries.

The collector is built around three goals:

- gather profile contribution data across owned, org, collaborator, and external repositories
- avoid repeatedly fetching stable historical data
- stay within GitHub API limits through bounded concurrency, caching, and resumable backfill

## What It Collects

- Profile identity, social fields, followers, following, and stars given
- GitHub contribution graph totals and daily calendar data
- Monthly and yearly contribution rollups, streaks, peak days, and README-ready summaries
- Owned, affiliated, and contributed repository metadata, deduped by repository ID
- Languages, topics, stars, forks, active repository counts, and top repositories
- Optional REST backfill for repository contributor statistics and traffic data
- Collection status, cache usage, incomplete years, pending backfill, and rate-limit metadata
- Public-safe privacy defaults that keep private repository names and metadata out of committed output/cache

## Requirements

This action should run with a Personal Access Token for the profile being
collected.

Recommended token access:

| Access | Purpose |
| --- | --- |
| `read:user` | Profile and private contribution counts |
| `repo` | Private repositories, traffic, and contributor stats where permitted |

The default `GITHUB_TOKEN` is usually not enough for profile-grade collection
because GraphQL `viewer` data and private contribution visibility depend on the
token owner.

## Usage

```yaml
name: Collect GitHub Stats

on:
  schedule:
    - cron: "0 0 * * *"
  workflow_dispatch:

jobs:
  collect-stats:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Collect GitHub Stats
        uses: LukeHagar/stats-action@v1
        env:
          GITHUB_TOKEN: ${{ secrets.USER_PAT }}

      - name: Commit stats and stable cache
        uses: stefanzweifel/git-auto-commit-action@v5
        with:
          commit_message: "chore: update github stats"
          file_pattern: |
            github-user-stats.json
            .github-profile-stats/cache.json
```

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `output-path` | `github-user-stats.json` | Generated v2 stats JSON |
| `cache-path` | `.github-profile-stats/cache.json` | Stable cache intended to be committed |
| `volatile-cache-path` | `.github-profile-stats/volatile-cache.json` | Actions-cache-backed REST metadata |
| `max-runtime-seconds` | `480` | Soft budget for optional backfill |
| `graphql-concurrency` | `2` | GraphQL collection concurrency |
| `rest-concurrency` | `4` | REST backfill concurrency |
| `min-graphql-remaining` | `500` | Stop optional GraphQL work below this budget |
| `min-rest-remaining` | `750` | Stop optional REST work below this budget |
| `include-traffic` | `true` | Collect repo traffic where permitted |
| `include-rest-repo-stats` | `true` | Collect expensive contributor stats |
| `include-private-repository-details` | `false` | Include private repo names, metadata, and per-repo metrics in output |
| `include-private-cache-details` | `false` | Include private repo identifiers and metadata in committed stable cache |
| `backfill-mode` | `resume` | `resume`, `refresh`, or `off` |

## Output Shape

The output uses `schemaVersion: 2` and keeps legacy top-level aliases for older
README consumers.

Main v2 sections:

- `profile`: user identity and social profile data
- `profileContributions`: canonical GitHub contribution graph totals, calendar, rollups, and completeness
- `activity`: visible authored activity counts such as PRs, issues, discussions, and stars given
- `repositories`: deduped repository universe with source and contribution metadata
- `repoMetrics`: repository-derived metrics, optional contributor stats, and traffic summaries
- `presentation`: compact data for README cards, interactive sites, and Remotion scenes
- `privacy`: whether private details were included and how many records were redacted
- `collectionStatus`: cache usage, backfill status, warnings, errors, and rate-limit state
- `legacy`: mirrored v1-style fields

## Privacy Defaults

By default, private repository details are redacted from committed output and
stable cache files. Aggregate values such as private repository count,
restricted contribution count, and total contribution counts can still appear,
but private repository names, descriptions, URLs, topics, branch identifiers,
and per-repository traffic/contributor metrics are excluded.

Set `include-private-repository-details: true` only if the generated JSON is
not public. Set `include-private-cache-details: true` only if the stable cache
will not be committed to a public repository.

## Caching Model

The action uses two caches:

- Stable cache: committed at `cache-path`; stores historical contribution years,
  repository metadata, REST contributor summaries, traffic history, and pending
  backfill state.
- Volatile cache: restored/saved through `actions/cache`; stores REST ETag and
  last-modified metadata.

Historical contribution years older than the previous year are treated as
immutable when cached. Current and previous years are refreshed by default.
Expensive REST work is queued and resumed across scheduled runs.

## Development

```bash
bun install
bun test
bun run typecheck
```

Run locally with:

```bash
GITHUB_TOKEN=your_pat_here bun run start
```

## License

MIT - see [LICENSE.md](LICENSE.md)
