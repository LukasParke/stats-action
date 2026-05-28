import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";
import {
  BackfillFailure,
  BackfillItem,
  CACHE_SCHEMA_VERSION,
  CachedContributionYear,
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

export function writeStableCache(path: string, cache: StableCache): void {
  writeJsonFile(path, { ...cache, updatedAt: Date.now() });
}

export function writeVolatileCache(path: string, cache: VolatileCache): void {
  writeJsonFile(path, { ...cache, updatedAt: Date.now() });
}

export function cacheContributionYear(
  cache: StableCache,
  year: CachedContributionYear
): void {
  cache.contributionYears[year.year] = year;
}

export function cacheRepository(cache: StableCache, repository: RepositoryRecord): void {
  cache.repositories[repository.id] = {
    fetchedAt: Date.now(),
    repository: metadataOnlyRepository(repository),
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
