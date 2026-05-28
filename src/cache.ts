import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";
import {
  BackfillFailure,
  BackfillItem,
  CACHE_SCHEMA_VERSION,
  CachedContributionYear,
  CachedRepository,
  RepositoryRecord,
  StableCache,
  VolatileCache,
} from "./Types";

export function createEmptyStableCache(now = Date.now()): StableCache {
  return {
    schemaVersion: CACHE_SCHEMA_VERSION,
    updatedAt: now,
    contributionYears: {},
    repositories: {},
    contributorStats: {},
    traffic: {},
    backfill: {
      pending: [],
      completed: {},
      failures: {},
    },
  };
}

export function createEmptyVolatileCache(now = Date.now()): VolatileCache {
  return {
    schemaVersion: CACHE_SCHEMA_VERSION,
    updatedAt: now,
    restEtags: {},
  };
}

export function readStableCache(path: string): StableCache {
  return readJsonFile(path, createEmptyStableCache, isStableCache);
}

export function readVolatileCache(path: string): VolatileCache {
  return readJsonFile(path, createEmptyVolatileCache, isVolatileCache);
}

export function writeStableCache(
  path: string,
  cache: StableCache,
  includePrivateDetails = false
): void {
  writeJsonFile(path, {
    ...sanitizeStableCache(cache, includePrivateDetails),
    updatedAt: Date.now(),
  });
}

export function writeVolatileCache(path: string, cache: VolatileCache): void {
  writeJsonFile(path, { ...cache, updatedAt: Date.now() });
}

export function cacheContributionYear(
  cache: StableCache,
  year: CachedContributionYear,
  includePrivateDetails = false
): void {
  cache.contributionYears[year.year] = sanitizeContributionYear(
    year,
    includePrivateDetails
  );
}

export function cacheRepository(
  cache: StableCache,
  repository: RepositoryRecord,
  includePrivateDetails = false
): void {
  if (repository.isPrivate && !includePrivateDetails) return;

  cache.repositories[repository.id] = {
    fetchedAt: Date.now(),
    repository: metadataOnlyRepository(repository),
  };
}

export function sanitizeStableCache(
  cache: StableCache,
  includePrivateDetails: boolean
): StableCache {
  if (includePrivateDetails) return cache;

  const repositories = Object.fromEntries(
    Object.entries(cache.repositories).filter(
      ([, entry]) => !entry.repository.isPrivate
    )
  ) as Record<string, CachedRepository>;
  const publicRepositoryIds = new Set(Object.keys(repositories));

  return {
    ...cache,
    repositories,
    contributionYears: Object.fromEntries(
      Object.entries(cache.contributionYears).map(([year, contributionYear]) => [
        year,
        sanitizeContributionYear(contributionYear, false, publicRepositoryIds),
      ])
    ),
    contributorStats: filterRecordByPublicRepoId(
      cache.contributorStats,
      publicRepositoryIds
    ),
    traffic: filterRecordByPublicRepoId(cache.traffic, publicRepositoryIds),
    backfill: {
      pending: cache.backfill.pending.filter((item) =>
        publicRepositoryIds.has(item.repoId)
      ),
      completed: filterBackfillRecord(cache.backfill.completed, publicRepositoryIds),
      failures: filterBackfillRecord(cache.backfill.failures, publicRepositoryIds),
    },
  };
}

export function shouldReuseContributionYear(
  cached: CachedContributionYear | undefined,
  year: number,
  currentYear: number
): cached is CachedContributionYear {
  if (!cached) return false;
  if (year >= currentYear - 1) return false;
  return cached.immutable;
}

export function mergeBackfillQueue(
  existing: BackfillItem[],
  next: BackfillItem[]
): BackfillItem[] {
  const byKey = new Map<string, BackfillItem>();
  for (const item of existing) byKey.set(item.key, item);
  for (const item of next) {
    const current = byKey.get(item.key);
    if (!current || item.priority < current.priority) byKey.set(item.key, item);
  }
  return Array.from(byKey.values()).sort(
    (a, b) => a.priority - b.priority || a.key.localeCompare(b.key)
  );
}

export function recordBackfillFailure(
  failures: Record<string, BackfillFailure>,
  item: BackfillItem,
  message: string
): void {
  const current = failures[item.key];
  failures[item.key] = {
    key: item.key,
    failedAt: Date.now(),
    attempts: (current?.attempts || 0) + 1,
    message,
  };
}

function readJsonFile<T>(
  path: string,
  createEmpty: () => T,
  validate: (value: unknown) => value is T
): T {
  if (!existsSync(path)) return createEmpty();

  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (validate(parsed)) return parsed;
  } catch {
    return createEmpty();
  }

  return createEmpty();
}

function writeJsonFile(path: string, value: unknown): void {
  const dir = dirname(path);
  if (dir && dir !== ".") mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function isStableCache(value: unknown): value is StableCache {
  if (!isRecord(value)) return false;
  return (
    value["schemaVersion"] === CACHE_SCHEMA_VERSION &&
    isRecord(value["contributionYears"]) &&
    isRecord(value["repositories"]) &&
    isRecord(value["contributorStats"]) &&
    isRecord(value["traffic"]) &&
    isRecord(value["backfill"])
  );
}

function isVolatileCache(value: unknown): value is VolatileCache {
  if (!isRecord(value)) return false;
  return value["schemaVersion"] === CACHE_SCHEMA_VERSION && isRecord(value["restEtags"]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeContributionYear(
  year: CachedContributionYear,
  includePrivateDetails: boolean,
  publicRepositoryIds = new Set(
    year.repositories.filter((repository) => !repository.isPrivate).map((repo) => repo.id)
  )
): CachedContributionYear {
  if (includePrivateDetails) return year;

  return {
    ...year,
    repositories: year.repositories
      .filter((repository) => publicRepositoryIds.has(repository.id))
      .map(metadataOnlyRepository),
    repositoryContributions: year.repositoryContributions.filter((summary) =>
      publicRepositoryIds.has(summary.repositoryId)
    ),
  };
}

function metadataOnlyRepository(repository: RepositoryRecord): RepositoryRecord {
  return {
    ...repository,
    contributionCounts: {
      commits: 0,
      issues: 0,
      pullRequests: 0,
      pullRequestReviews: 0,
      repositoryCreations: 0,
    },
  };
}

function filterRecordByPublicRepoId<T>(
  record: Record<string, T>,
  publicRepositoryIds: Set<string>
): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).filter(([repoId]) => publicRepositoryIds.has(repoId))
  );
}

function filterBackfillRecord<T>(
  record: Record<string, T>,
  publicRepositoryIds: Set<string>
): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).filter(([key]) =>
      Array.from(publicRepositoryIds).some((repoId) => key.includes(repoId))
    )
  );
}
