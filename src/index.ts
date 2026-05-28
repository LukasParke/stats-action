import core from "@actions/core";
import { mkdirSync, writeFileSync } from "fs";
import { dirname } from "path";
import { Octokit } from "octokit";
import { throttling } from "@octokit/plugin-throttling";
import {
  ActionConfig,
  CollectionStatus,
  GitHubStatsOutput,
} from "./Types";
import {
  formatBytes,
  formatNumber,
  aggregateLanguages,
  calculateContributionStats,
  calculateComputedStats,
} from "./aggregate";
import {
  readStableCache,
  readVolatileCache,
  cacheRepository,
  writeStableCache,
  writeVolatileCache,
} from "./cache";
import {
  buildBackfillQueue,
  collectContributionYears,
  collectProfile,
  collectRepositoryUniverse,
  mergeRepositories,
  processBackfillQueue,
} from "./github";
import { buildOutput } from "./output";
import { RequestScheduler } from "./scheduler";

export {
  formatBytes,
  formatNumber,
  aggregateLanguages,
  calculateContributionStats,
  calculateComputedStats,
};

const ThrottledOctokit = Octokit.plugin(throttling);

export function readActionConfig(): ActionConfig {
  return {
    outputPath: inputString("output-path", "github-user-stats.json"),
    cachePath: inputString("cache-path", ".github-profile-stats/cache.json"),
    volatileCachePath: inputString(
      "volatile-cache-path",
      ".github-profile-stats/volatile-cache.json"
    ),
    maxRuntimeSeconds: inputNumber("max-runtime-seconds", 480),
    graphqlConcurrency: inputNumber("graphql-concurrency", 2),
    restConcurrency: inputNumber("rest-concurrency", 4),
    minGraphqlRemaining: inputNumber("min-graphql-remaining", 500),
    minRestRemaining: inputNumber("min-rest-remaining", 750),
    includeTraffic: inputBoolean("include-traffic", true),
    includeRestRepoStats: inputBoolean("include-rest-repo-stats", true),
    includePrivateRepositoryDetails: inputBoolean(
      "include-private-repository-details",
      false
    ),
    includePrivateCacheDetails: inputBoolean("include-private-cache-details", false),
    backfillMode: inputBackfillMode("backfill-mode", "resume"),
  };
}

export async function runStatsCollection(
  config: ActionConfig,
  token: string
): Promise<GitHubStatsOutput> {
  const startedAt = Date.now();
  const scheduler = new RequestScheduler(config, startedAt);
  const octokit = new ThrottledOctokit({
    auth: token,
    throttle: {
      onRateLimit: (retryAfter, options, octokit) => {
        octokit.log.warn(
          `Request quota exhausted for request ${options.method} ${options.url}`
        );
        octokit.log.info(`Retrying after ${retryAfter} seconds`);
        return true;
      },
      onSecondaryRateLimit: (retryAfter, options, octokit) => {
        octokit.log.warn(
          `Secondary rate limit detected for request ${options.method} ${options.url}`
        );
        octokit.log.info(`Retrying after ${retryAfter} seconds`);
        return true;
      },
    },
  });

  const stableCache = readStableCache(config.cachePath);
  const volatileCache = readVolatileCache(config.volatileCachePath);
  const warnings: string[] = [];
  const errors: string[] = [];

  console.log("Collecting viewer profile and activity counts");
  const { profile, activity } = await collectProfile(octokit, scheduler);

  console.log("Collecting contribution years with cache reuse");
  const contributions = await collectContributionYears(
    octokit,
    scheduler,
    stableCache,
    profile.createdAt,
    config.includePrivateCacheDetails,
    config.graphqlConcurrency
  );
  if (
    contributions.collection.contributionCalendar.weeks.length === 0 &&
    contributions.missingYears.length > 0
  ) {
    throw new Error(
      `Unable to collect any contribution calendar data; missing years: ${contributions.missingYears.join(", ")}`
    );
  }
  if (contributions.missingYears.length > 0) {
    warnings.push(
      `Contribution data is incomplete for years: ${contributions.missingYears.join(", ")}`
    );
  }

  console.log("Collecting owned, affiliated, and contributed repositories");
  const repositoryUniverse = await collectRepositoryUniverse(
    octokit,
    scheduler,
    stableCache,
    config.includePrivateCacheDetails,
    profile.login
  );
  let repositories = mergeRepositories([
    ...repositoryUniverse.repositories,
    ...contributions.repositories,
  ]);

  for (const repository of repositories) {
    cacheRepository(stableCache, repository, config.includePrivateCacheDetails);
  }

  console.log("Building resumable optional repository metric queue");
  stableCache.backfill.pending = buildBackfillQueue(
    repositories,
    stableCache,
    config
  );
  const backfillResult = await processBackfillQueue(
    octokit,
    scheduler,
    stableCache,
    volatileCache,
    repositories,
    stableCache.backfill.pending,
    profile.login,
    config
  );

  repositories = mergeRepositories(
    [
      ...Object.values(stableCache.repositories).map((entry) => entry.repository),
      ...contributions.repositories,
    ]
  );

  const finishedAt = Date.now();
  const schedulerState = scheduler.state();
  const collectionStatus: CollectionStatus = {
    startedAt,
    finishedAt,
    durationMs: finishedAt - startedAt,
    coreComplete: contributions.missingYears.length === 0,
    complete:
      contributions.missingYears.length === 0 &&
      stableCache.backfill.pending.length === 0 &&
      backfillResult.failed === 0,
    cache: {
      stablePath: config.cachePath,
      volatilePath: config.volatileCachePath,
      contributionYearsFromCache: contributions.yearsFromCache.length,
      contributionYearsFetched: contributions.yearsFetched.length,
      repositoriesFromCache: repositoryUniverse.repositoriesFromCache,
      repositoriesFetched: repositoryUniverse.repositoriesFetched,
    },
    backfill: {
      enabled: config.backfillMode !== "off",
      completedThisRun: backfillResult.completed,
      pending: backfillResult.pending.length,
      failedThisRun: backfillResult.failed,
      skippedThisRun: backfillResult.skipped,
    },
    rateLimit: {
      graphql: schedulerState.graphqlRateLimit,
      rest: schedulerState.restRateLimit,
    },
    warnings: [...warnings, ...schedulerState.warnings],
    errors,
  };

  const output = buildOutput({
    profile,
    activity,
    contributions,
    repositories,
    cache: stableCache,
    config,
    collectionStatus,
    fetchedAt: finishedAt,
  });

  writeJsonOutput(config.outputPath, output);
  writeStableCache(config.cachePath, stableCache, config.includePrivateCacheDetails);
  writeVolatileCache(config.volatileCachePath, volatileCache);

  await writeSummary(output);
  console.log(
    `Collection complete in ${((finishedAt - startedAt) / 1000).toFixed(2)}s`
  );

  return output;
}

async function main(): Promise<void> {
  const token = process.env["GITHUB_TOKEN"];
  if (!token) {
    core.setFailed("GITHUB_TOKEN is not present");
    return;
  }

  const config = readActionConfig();
  await runStatsCollection(config, token);
}

async function writeSummary(output: GitHubStatsOutput): Promise<void> {
  const rows: Array<[string, string | number]> = [
    ["Schema", output.schemaVersion],
    ["Username", output.username],
    ["Total Repos", output.repoStats.totalRepos],
    ["Repository Views", formatNumber(output.repoViews)],
    ["Lines Changed", formatNumber(output.linesOfCodeChanged)],
    ["Profile Commits", formatNumber(output.totalCommits)],
    ["Total Pull Requests", output.totalPullRequests],
    ["Total PR Reviews", output.totalPullRequestReviews],
    ["Code Bytes", formatBytes(output.codeByteTotal)],
    ["Languages", output.computedStats.languageCount],
    ["Stars Received", output.starCount],
    ["Followers", output.followers],
    ["Current Streak", `${output.contributionStats.currentStreak} days`],
    ["Longest Streak", `${output.contributionStats.longestStreak} days`],
    ["Total Contributions", output.totalContributions],
    ["Backfill Pending", output.collectionStatus.backfill.pending],
    ["Complete", String(output.collectionStatus.complete)],
  ];

  console.table(rows.map(([Name, Value]) => ({ Name, Value })));

  if (process.env["GITHUB_WORKFLOW"]) {
    await core.summary
      .addHeading("GitHub Stats")
      .addTable([
        [
          { data: "Metric", header: true },
          { data: "Value", header: true },
        ],
        ...rows.map(([name, value]) => [name, String(value)]),
      ])
      .write();
  }
}

function inputString(name: string, defaultValue: string): string {
  const value = process.env[statsEnvName(name)] || core.getInput(name);
  return value.trim() || defaultValue;
}

function inputNumber(name: string, defaultValue: number): number {
  const value = process.env[statsEnvName(name)] || core.getInput(name);
  if (!value.trim()) return defaultValue;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

function inputBoolean(name: string, defaultValue: boolean): boolean {
  const value = process.env[statsEnvName(name)] || core.getInput(name);
  if (!value.trim()) return defaultValue;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function inputBackfillMode(
  name: string,
  defaultValue: ActionConfig["backfillMode"]
): ActionConfig["backfillMode"] {
  const value = (process.env[statsEnvName(name)] || core.getInput(name)).trim();
  if (value === "resume" || value === "refresh" || value === "off") return value;
  return defaultValue;
}

function statsEnvName(name: string): string {
  return `STATS_${name.toUpperCase().replace(/-/g, "_")}`;
}

function writeJsonOutput(path: string, value: unknown): void {
  const dir = dirname(path);
  if (dir && dir !== ".") mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

if (import.meta.main) {
  main().catch((error) => {
    console.error("Fatal error:", error);
    core.setFailed(error instanceof Error ? error.message : String(error));
  });
}
