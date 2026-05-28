import { Octokit } from "octokit";
import {
  ActionConfig,
  ActivityStats,
  BackfillItem,
  CachedContributionYear,
  CachedTraffic,
  ContributorStatsSummary,
  ContributionsCollection,
  GraphQLContributionRepositoryGroup,
  GraphQLResponse,
  GraphQLViewerProfile,
  RateLimitInfo,
  RawGraphQLRepository,
  RepositoryContributionCounts,
  RepositoryContributionSummary,
  RepositoryRecord,
  StableCache,
  TrafficDay,
  UserProfile,
  VolatileCache,
} from "./Types";
import {
  cacheContributionYear,
  cacheRepository,
  mergeBackfillQueue,
  recordBackfillFailure,
  shouldReuseContributionYear,
} from "./cache";
import { aggregateLanguages, mergeContributionsCollections } from "./aggregate";
import { isBudgetStopped, RequestScheduler, runLimited } from "./scheduler";

const REPO_FIELDS = `
  id
  name
  nameWithOwner
  owner {
    login
    __typename
  }
  description
  url
  isArchived
  isFork
  isPrivate
  visibility
  viewerPermission
  createdAt
  updatedAt
  pushedAt
  defaultBranchRef {
    target {
      oid
    }
  }
  stargazers {
    totalCount
  }
  forkCount
  primaryLanguage {
    name
    color
  }
  repositoryTopics(first: 20) {
    nodes {
      topic {
        name
      }
    }
  }
  languages(first: 20, orderBy: {field: SIZE, direction: DESC}) {
    edges {
      size
      node {
        color
        name
      }
    }
  }
`;

const REPO_DISCOVERY_FIELDS = `
  id
  name
  nameWithOwner
  owner {
    login
    __typename
  }
  updatedAt
  pushedAt
  defaultBranchRef {
    target {
      oid
    }
  }
`;

const RATE_LIMIT_FIELDS = `
  rateLimit {
    limit
    remaining
    used
    resetAt
  }
`;

export type ProfileCollection = {
  profile: UserProfile;
  activity: ActivityStats;
};

export type ContributionCollectionResult = {
  collection: ContributionsCollection;
  repositoryContributions: RepositoryContributionSummary[];
  repositories: RepositoryRecord[];
  yearsFetched: string[];
  yearsFromCache: string[];
  missingYears: string[];
};

export type RepositoryUniverseResult = {
  repositories: RepositoryRecord[];
  repositoriesFetched: number;
  repositoriesFromCache: number;
};

export type BackfillResult = {
  completed: number;
  failed: number;
  skipped: number;
  pending: BackfillItem[];
};

type PageInfo = {
  endCursor: string | null;
  hasNextPage: boolean;
};

type RepositoryDiscovery = Pick<
  RawGraphQLRepository,
  "id" | "name" | "nameWithOwner" | "owner" | "updatedAt" | "pushedAt" | "defaultBranchRef"
>;

type RepositoryDiscoveryConnection = {
  nodes: RepositoryDiscovery[];
  pageInfo: PageInfo;
};

type RepositoryDiscoveryWithSource = {
  repository: RepositoryDiscovery;
  source: RepositoryRecord["sources"][number];
};

type ContributionsCollectionWithRepositories = ContributionsCollection & {
  commitContributionsByRepository: GraphQLContributionRepositoryGroup[];
  issueContributionsByRepository: GraphQLContributionRepositoryGroup[];
  pullRequestContributionsByRepository: GraphQLContributionRepositoryGroup[];
  pullRequestReviewContributionsByRepository: GraphQLContributionRepositoryGroup[];
  repositoryContributions: {
    nodes: Array<{ repository: RawGraphQLRepository }>;
    pageInfo: PageInfo;
    totalCount: number;
  };
};

type ContributionRepositoryEnrichment = Pick<
  ContributionsCollectionWithRepositories,
  | "commitContributionsByRepository"
  | "issueContributionsByRepository"
  | "pullRequestContributionsByRepository"
  | "pullRequestReviewContributionsByRepository"
  | "repositoryContributions"
>;

export async function collectProfile(
  octokit: Octokit,
  scheduler: RequestScheduler
): Promise<ProfileCollection> {
  const response = await scheduler.graphql(
    "viewer profile",
    () =>
      octokit.graphql<
        GraphQLResponse<{
          viewer: GraphQLViewerProfile;
        }>
      >(
        `query viewerProfile {
          viewer {
            name
            login
            bio
            company
            location
            email
            twitterUsername
            websiteUrl
            avatarUrl
            createdAt
            followers {
              totalCount
            }
            following {
              totalCount
            }
            starredRepositories {
              totalCount
            }
            pullRequests(first: 1) {
              totalCount
            }
            repositoriesContributedTo(first: 1, contributionTypes: [COMMIT, ISSUE, PULL_REQUEST, REPOSITORY, PULL_REQUEST_REVIEW]) {
              totalCount
            }
            openIssues: issues(states: OPEN) {
              totalCount
            }
            closedIssues: issues(states: CLOSED) {
              totalCount
            }
            repositoryDiscussions {
              totalCount
            }
            repositoryDiscussionComments(onlyAnswers: true) {
              totalCount
            }
          }
          ${RATE_LIMIT_FIELDS}
        }`
      ),
    false
  );

  const viewer = response.viewer;
  return {
    profile: {
      name: viewer.name || "",
      login: viewer.login,
      bio: viewer.bio,
      company: viewer.company,
      location: viewer.location,
      email: viewer.email,
      twitterUsername: viewer.twitterUsername,
      websiteUrl: viewer.websiteUrl,
      avatarUrl: viewer.avatarUrl,
      createdAt: viewer.createdAt,
      followers: viewer.followers.totalCount,
      following: viewer.following.totalCount,
    },
    activity: {
      totalPullRequests: viewer.pullRequests.totalCount,
      openIssues: viewer.openIssues.totalCount,
      closedIssues: viewer.closedIssues.totalCount,
      repositoriesContributedTo: viewer.repositoriesContributedTo.totalCount,
      discussionsStarted: viewer.repositoryDiscussions.totalCount,
      discussionsAnswered: viewer.repositoryDiscussionComments.totalCount,
      starsGiven: viewer.starredRepositories.totalCount,
    },
  };
}

export async function collectRepositoryUniverse(
  octokit: Octokit,
  scheduler: RequestScheduler,
  cache: StableCache,
  includePrivateCacheDetails: boolean,
  username: string
): Promise<RepositoryUniverseResult> {
  const fetchedAt = Date.now();
  const discoveredRepositories: RepositoryDiscoveryWithSource[] = [];

  const affiliated = await paginateRepositoryDiscoveryConnection(
    "viewer repositories",
    scheduler,
    (cursor) =>
      octokit.graphql<
        GraphQLResponse<{
          viewer: { repositories: RepositoryDiscoveryConnection };
        }>
      >(
        `query viewerRepositories($cursor: String) {
          viewer {
            repositories(
              first: 100
              after: $cursor
              ownerAffiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]
              orderBy: {field: UPDATED_AT, direction: DESC}
            ) {
              nodes {
                ${REPO_DISCOVERY_FIELDS}
              }
              pageInfo {
                endCursor
                hasNextPage
              }
            }
          }
          ${RATE_LIMIT_FIELDS}
        }`,
        { cursor }
      ),
    (response) => response.viewer.repositories
  );

  for (const repository of affiliated) {
    const source = repository.owner.login === username ? "owned" : "affiliated";
    discoveredRepositories.push({ repository, source });
  }

  const contributed = await paginateRepositoryDiscoveryConnection(
    "repositories contributed to",
    scheduler,
    (cursor) =>
      octokit.graphql<
        GraphQLResponse<{
          viewer: { repositoriesContributedTo: RepositoryDiscoveryConnection };
        }>
      >(
        `query viewerContributedRepositories($cursor: String) {
          viewer {
            repositoriesContributedTo(
              first: 100
              after: $cursor
              includeUserRepositories: false
              contributionTypes: [COMMIT, ISSUE, PULL_REQUEST, REPOSITORY, PULL_REQUEST_REVIEW]
              orderBy: {field: UPDATED_AT, direction: DESC}
            ) {
              nodes {
                ${REPO_DISCOVERY_FIELDS}
              }
              pageInfo {
                endCursor
                hasNextPage
              }
            }
          }
          ${RATE_LIMIT_FIELDS}
        }`,
        { cursor }
      ),
    (response) => response.viewer.repositoriesContributedTo
  );

  for (const repository of contributed) {
    discoveredRepositories.push({ repository, source: "contributed" });
  }

  const materialized = await materializeDiscoveredRepositories(
    octokit,
    scheduler,
    cache,
    discoveredRepositories,
    fetchedAt
  );

  const merged = mergeRepositories([
    ...Object.values(cache.repositories).map((entry) => ({
      ...entry.repository,
      sources: addSource(entry.repository.sources, "cache"),
    })),
    ...materialized.repositories,
  ]);

  for (const repository of merged) {
    cacheRepository(cache, repository, includePrivateCacheDetails);
  }

  return {
    repositories: merged,
    repositoriesFetched: materialized.fetched,
    repositoriesFromCache: materialized.reused,
  };
}

export async function collectContributionYears(
  octokit: Octokit,
  scheduler: RequestScheduler,
  cache: StableCache,
  createdAt: string,
  includePrivateCacheDetails = false,
  graphqlConcurrency = 2
): Promise<ContributionCollectionResult> {
  const createdYear = new Date(createdAt).getUTCFullYear();
  const currentYear = new Date().getUTCFullYear();
  const years = Array.from(
    { length: currentYear - createdYear + 1 },
    (_, index) => createdYear + index
  );
  const fetched: CachedContributionYear[] = [];
  const fromCache: CachedContributionYear[] = [];
  const missingYears: string[] = [];

  await runLimited(years, graphqlConcurrency, async (year) => {
    const cached = cache.contributionYears[String(year)];
    if (shouldReuseContributionYear(cached, year, currentYear)) {
      fromCache.push(cached);
      return;
    }

    try {
      const contributionYear = await fetchContributionYear(
        octokit,
        scheduler,
        createdAt,
        year,
        currentYear
      );
      fetched.push(contributionYear);
      cacheContributionYear(cache, contributionYear, includePrivateCacheDetails);
    } catch (error) {
      if (cached) {
        fromCache.push(cached);
      } else {
        missingYears.push(String(year));
      }
      console.warn(
        `Failed to collect contribution year ${year}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  });

  const orderedYears = [...fromCache, ...fetched].sort((a, b) =>
    a.year.localeCompare(b.year)
  );
  const collection = mergeContributionsCollections(orderedYears.map((year) => year.data));
  const repositoryContributions = mergeRepositoryContributions(
    orderedYears.flatMap((year) => year.repositoryContributions)
  );
  const repositories = mergeRepositories(
    orderedYears.flatMap((year) => year.repositories || [])
  );
  for (const repository of repositories) {
    cacheRepository(cache, repository, includePrivateCacheDetails);
  }

  return {
    collection,
    repositoryContributions,
    repositories,
    yearsFetched: fetched.map((year) => year.year).sort(),
    yearsFromCache: fromCache.map((year) => year.year).sort(),
    missingYears,
  };
}

export function buildBackfillQueue(
  repositories: RepositoryRecord[],
  cache: StableCache,
  config: ActionConfig
): BackfillItem[] {
  if (config.backfillMode === "off") return [];

  const next: BackfillItem[] = [];
  const forceRefresh = config.backfillMode === "refresh";
  for (const repo of repositories) {
    if (repo.isPrivate && !config.includePrivateRepositoryDetails) continue;

    const basePriority = getRepositoryPriority(repo);
    const contributorStats = cache.contributorStats[repo.id];
    const contributorStatsComplete =
      contributorStats?.defaultBranchOid === repo.defaultBranchOid &&
      ["fresh", "cached"].includes(contributorStats.status);
    if (
      config.includeRestRepoStats &&
      repo.defaultBranchOid &&
      (forceRefresh || !contributorStatsComplete)
    ) {
      next.push({
        key: `contributors:${repo.id}:${repo.defaultBranchOid}`,
        type: "contributors",
        repoId: repo.id,
        nameWithOwner: repo.nameWithOwner,
        priority: basePriority,
        reason: "default branch stats missing or stale",
      });
    }

    const traffic = cache.traffic[repo.id];
    if (
      config.includeTraffic &&
      canReadTraffic(repo) &&
      (forceRefresh || !traffic || Date.now() - traffic.fetchedAt > 20 * 60 * 60 * 1000)
    ) {
      next.push({
        key: `traffic:${repo.id}`,
        type: "traffic",
        repoId: repo.id,
        nameWithOwner: repo.nameWithOwner,
        priority: basePriority + 5,
        reason: "traffic data missing or older than 20 hours",
      });
    }
  }

  const merged = forceRefresh ? next : mergeBackfillQueue(cache.backfill.pending, next);
  return merged.sort((a, b) => a.priority - b.priority || a.key.localeCompare(b.key));
}

export async function processBackfillQueue(
  octokit: Octokit,
  scheduler: RequestScheduler,
  cache: StableCache,
  volatileCache: VolatileCache,
  repositories: RepositoryRecord[],
  queue: BackfillItem[],
  username: string,
  config: ActionConfig
): Promise<BackfillResult> {
  if (config.backfillMode === "off") {
    cache.backfill.pending = [];
    return { completed: 0, failed: 0, skipped: 0, pending: [] };
  }

  const byId = new Map(repositories.map((repo) => [repo.id, repo]));
  let completed = 0;
  let failed = 0;
  let skipped = 0;
  const pending = new Set(queue.map((item) => item.key));

  await runLimited(queue, config.restConcurrency, async (item) => {
    const repo = byId.get(item.repoId);
    if (!repo) {
      skipped++;
      pending.delete(item.key);
      return;
    }

    if (!scheduler.shouldStartOptional("rest")) {
      skipped++;
      return;
    }

    try {
      if (item.type === "contributors") {
        cache.contributorStats[repo.id] = await fetchContributorStats(
          octokit,
          scheduler,
          volatileCache,
          cache.contributorStats[repo.id],
          repo,
          username
        );
      } else {
        cache.traffic[repo.id] = await fetchTraffic(
          octokit,
          scheduler,
          volatileCache,
          cache.traffic[repo.id],
          repo
        );
      }
      cache.backfill.completed[item.key] = Date.now();
      delete cache.backfill.failures[item.key];
      pending.delete(item.key);
      completed++;
    } catch (error) {
      if (isBudgetStopped(error)) {
        skipped++;
        return;
      }
      failed++;
      pending.delete(item.key);
      recordBackfillFailure(
        cache.backfill.failures,
        item,
        error instanceof Error ? error.message : String(error)
      );
    }
  });

  cache.backfill.pending = queue.filter((item) => pending.has(item.key));
  return {
    completed,
    failed,
    skipped,
    pending: cache.backfill.pending,
  };
}

export function mergeRepositories(repositories: RepositoryRecord[]): RepositoryRecord[] {
  const byId = new Map<string, RepositoryRecord>();

  for (const repository of repositories) {
    const current = byId.get(repository.id);
    if (!current) {
      byId.set(repository.id, {
        ...repository,
        sources: unique(repository.sources),
      });
      continue;
    }

    const newer =
      repository.metadataFetchedAt >= current.metadataFetchedAt ? repository : current;
    byId.set(repository.id, {
      ...newer,
      sources: unique([...current.sources, ...repository.sources]),
      contributionCounts: addContributionCounts(
        current.contributionCounts,
        repository.contributionCounts
      ),
      metadataFetchedAt: Math.max(current.metadataFetchedAt, repository.metadataFetchedAt),
    });
  }

  return Array.from(byId.values()).sort((a, b) =>
    a.nameWithOwner.localeCompare(b.nameWithOwner)
  );
}

export function normalizeRepository(
  repository: RawGraphQLRepository,
  source: RepositoryRecord["sources"][number],
  fetchedAt: number,
  contributionCounts: Partial<RepositoryContributionCounts> = {}
): RepositoryRecord {
  const { languages, codeByteTotal } = aggregateLanguages([repository]);
  return {
    id: repository.id,
    name: repository.name,
    nameWithOwner: repository.nameWithOwner,
    owner: repository.owner.login,
    ownerType: repository.owner.__typename || null,
    description: repository.description,
    url: repository.url || null,
    isArchived: repository.isArchived,
    isFork: repository.isFork,
    isPrivate: repository.isPrivate,
    visibility: repository.visibility || null,
    viewerPermission: repository.viewerPermission || null,
    createdAt: repository.createdAt,
    updatedAt: repository.updatedAt,
    pushedAt: repository.pushedAt || null,
    defaultBranchOid: repository.defaultBranchRef?.target?.oid || null,
    stars: repository.stargazers?.totalCount || 0,
    forks: repository.forkCount,
    primaryLanguage: repository.primaryLanguage?.name || null,
    topics: repository.repositoryTopics.nodes.map((node) => node.topic.name),
    languages,
    codeByteTotal,
    sources: [source],
    contributionCounts: {
      commits: contributionCounts.commits || 0,
      issues: contributionCounts.issues || 0,
      pullRequests: contributionCounts.pullRequests || 0,
      pullRequestReviews: contributionCounts.pullRequestReviews || 0,
      repositoryCreations: contributionCounts.repositoryCreations || 0,
    },
    metadataFetchedAt: fetchedAt,
  };
}

async function fetchContributionYear(
  octokit: Octokit,
  scheduler: RequestScheduler,
  createdAt: string,
  year: number,
  currentYear: number
): Promise<CachedContributionYear> {
  const from = year === new Date(createdAt).getUTCFullYear()
    ? createdAt
    : `${year}-01-01T00:00:00.000Z`;
  const to =
    year === currentYear
      ? new Date().toISOString()
      : `${year + 1}-01-01T00:00:00.000Z`;

  const data = await fetchContributionYearCore(
    octokit,
    scheduler,
    from,
    to,
    year
  );
  const fetchedAt = Date.now();
  let summaries: RepositoryContributionSummary[] = [];
  let repositories: RepositoryRecord[] = [];

  try {
    const enrichment = await fetchContributionYearRepositoryEnrichment(
      octokit,
      scheduler,
      from,
      to,
      year
    );
    const extracted = extractContributionRepositories(enrichment, fetchedAt);
    summaries = extracted.summaries;
    repositories = extracted.repositories;
  } catch (error) {
    console.warn(
      `Skipped repository contribution enrichment for ${year}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  return {
    year: String(year),
    from,
    to,
    fetchedAt,
    immutable: year < currentYear - 1,
    data,
    repositoryContributions: summaries,
    repositories,
  };
}

async function fetchContributionYearCore(
  octokit: Octokit,
  scheduler: RequestScheduler,
  from: string,
  to: string,
  year: number
): Promise<ContributionsCollection> {
  const response = await scheduler.graphql(
    `contribution year ${year} core`,
    () =>
      octokit.graphql<
        GraphQLResponse<{
          viewer: {
            contributionsCollection: ContributionsCollection;
          };
        }>
      >(
        `query contributionYearCore($from: DateTime!, $to: DateTime!) {
          viewer {
            contributionsCollection(from: $from, to: $to) {
              totalCommitContributions
              restrictedContributionsCount
              totalIssueContributions
              totalRepositoryContributions
              totalPullRequestContributions
              totalPullRequestReviewContributions
              contributionCalendar {
                totalContributions
                weeks {
                  contributionDays {
                    contributionCount
                    date
                  }
                }
              }
            }
          }
          ${RATE_LIMIT_FIELDS}
        }`,
        { from, to }
      ),
    false
  );

  return response.viewer.contributionsCollection;
}

async function fetchContributionYearRepositoryEnrichment(
  octokit: Octokit,
  scheduler: RequestScheduler,
  from: string,
  to: string,
  year: number
): Promise<ContributionRepositoryEnrichment> {
  const response = await scheduler.graphql(
    `contribution year ${year} repository enrichment`,
    () =>
      octokit.graphql<
        GraphQLResponse<{
          viewer: {
            contributionsCollection: ContributionRepositoryEnrichment;
          };
        }>
      >(
        `query contributionYearRepositoryEnrichment($from: DateTime!, $to: DateTime!) {
          viewer {
            contributionsCollection(from: $from, to: $to) {
              commitContributionsByRepository(maxRepositories: 100) {
                repository {
                  ${REPO_FIELDS}
                }
                contributions(first: 1) {
                  totalCount
                }
              }
              issueContributionsByRepository(maxRepositories: 100) {
                repository {
                  ${REPO_FIELDS}
                }
                contributions(first: 1) {
                  totalCount
                }
              }
              pullRequestContributionsByRepository(maxRepositories: 100) {
                repository {
                  ${REPO_FIELDS}
                }
                contributions(first: 1) {
                  totalCount
                }
              }
              pullRequestReviewContributionsByRepository(maxRepositories: 100) {
                repository {
                  ${REPO_FIELDS}
                }
                contributions(first: 1) {
                  totalCount
                }
              }
              repositoryContributions(first: 100) {
                nodes {
                  repository {
                    ${REPO_FIELDS}
                  }
                }
                totalCount
                pageInfo {
                  endCursor
                  hasNextPage
                }
              }
            }
          }
          ${RATE_LIMIT_FIELDS}
        }`,
        { from, to }
      ),
    true,
    2
  );

  return response.viewer.contributionsCollection;
}

function extractContributionRepositories(
  collection: ContributionRepositoryEnrichment,
  fetchedAt: number
): {
  summaries: RepositoryContributionSummary[];
  repositories: RepositoryRecord[];
} {
  const repositories: RepositoryRecord[] = [];
  const summaryMap = new Map<string, RepositoryContributionSummary>();

  function add(
    group: GraphQLContributionRepositoryGroup,
    key: keyof RepositoryContributionCounts
  ): void {
    const counts: Partial<RepositoryContributionCounts> = {
      [key]: group.contributions.totalCount,
    };
    const repository = normalizeRepository(
      group.repository,
      "profile-contribution",
      fetchedAt,
      counts
    );
    repositories.push(repository);
    mergeContributionSummary(summaryMap, repository);
  }

  for (const group of collection.commitContributionsByRepository) add(group, "commits");
  for (const group of collection.issueContributionsByRepository) add(group, "issues");
  for (const group of collection.pullRequestContributionsByRepository) {
    add(group, "pullRequests");
  }
  for (const group of collection.pullRequestReviewContributionsByRepository) {
    add(group, "pullRequestReviews");
  }
  for (const node of collection.repositoryContributions.nodes) {
    const repository = normalizeRepository(
      node.repository,
      "profile-contribution",
      fetchedAt,
      { repositoryCreations: 1 }
    );
    repositories.push(repository);
    mergeContributionSummary(summaryMap, repository);
  }

  return {
    summaries: Array.from(summaryMap.values()).sort((a, b) =>
      a.nameWithOwner.localeCompare(b.nameWithOwner)
    ),
    repositories: mergeRepositories(repositories),
  };
}
async function materializeDiscoveredRepositories(
  octokit: Octokit,
  scheduler: RequestScheduler,
  cache: StableCache,
  discovered: RepositoryDiscoveryWithSource[],
  fetchedAt: number
): Promise<{ repositories: RepositoryRecord[]; fetched: number; reused: number }> {
  const byId = new Map<
    string,
    { repository: RepositoryDiscovery; sources: RepositoryRecord["sources"] }
  >();

  for (const item of discovered) {
    const current = byId.get(item.repository.id);
    if (current) {
      current.sources = addSource(current.sources, item.source);
    } else {
      byId.set(item.repository.id, {
        repository: item.repository,
        sources: [item.source],
      });
    }
  }

  const repositories: RepositoryRecord[] = [];
  const idsToFetch: string[] = [];
  let reused = 0;
  for (const [id, item] of byId) {
    const cached = cache.repositories[id]?.repository;
    if (cached && !repositoryDiscoveryChanged(cached, item.repository)) {
      repositories.push({
        ...cached,
        sources: unique([...cached.sources, ...item.sources]),
      });
      reused++;
    } else {
      idsToFetch.push(id);
    }
  }

  for (let i = 0; i < idsToFetch.length; i += 50) {
    const batchIds = idsToFetch.slice(i, i + 50);
    const details = await fetchRepositoryDetails(octokit, scheduler, batchIds);
    for (const detail of details) {
      const sourceInfo = byId.get(detail.id);
      if (!sourceInfo) continue;
      const normalized = normalizeRepository(
        detail,
        sourceInfo.sources[0] || "contributed",
        fetchedAt
      );
      repositories.push({
        ...normalized,
        sources: unique([...normalized.sources, ...sourceInfo.sources]),
      });
    }
  }

  return {
    repositories,
    fetched: idsToFetch.length,
    reused,
  };
}

async function fetchRepositoryDetails(
  octokit: Octokit,
  scheduler: RequestScheduler,
  ids: string[]
): Promise<RawGraphQLRepository[]> {
  if (ids.length === 0) return [];
  const response = await scheduler.graphql(
    "repository details",
    () =>
      octokit.graphql<
        GraphQLResponse<{
          nodes: Array<RawGraphQLRepository | null>;
        }>
      >(
        `query repositoryDetails($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on Repository {
              ${REPO_FIELDS}
            }
          }
          ${RATE_LIMIT_FIELDS}
        }`,
        { ids }
      ),
    false
  );

  return response.nodes.filter((node): node is RawGraphQLRepository => Boolean(node));
}

function repositoryDiscoveryChanged(
  cached: RepositoryRecord,
  discovered: RepositoryDiscovery
): boolean {
  return (
    cached.nameWithOwner !== discovered.nameWithOwner ||
    cached.updatedAt !== discovered.updatedAt ||
    cached.pushedAt !== (discovered.pushedAt || null) ||
    cached.defaultBranchOid !== (discovered.defaultBranchRef?.target?.oid || null)
  );
}

async function paginateRepositoryDiscoveryConnection<T extends { rateLimit?: RateLimitInfo }>(
  label: string,
  scheduler: RequestScheduler,
  request: (cursor: string | null) => Promise<T>,
  getConnection: (response: T) => RepositoryDiscoveryConnection
): Promise<RepositoryDiscovery[]> {
  const repositories: RepositoryDiscovery[] = [];
  let cursor: string | null = null;

  do {
    const response = await scheduler.graphql(label, () => request(cursor), false);
    const connection = getConnection(response);
    repositories.push(...connection.nodes);
    cursor = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (cursor);

  return repositories;
}

async function fetchContributorStats(
  octokit: Octokit,
  scheduler: RequestScheduler,
  volatileCache: VolatileCache,
  cached: ContributorStatsSummary | undefined,
  repo: RepositoryRecord,
  username: string
): Promise<ContributorStatsSummary> {
  const [owner, repoName] = repo.nameWithOwner.split("/");
  const etagKey = `contributors:${repo.id}:${repo.defaultBranchOid || "none"}`;
  const headers = conditionalHeaders(volatileCache, etagKey);
  let lastStatus = 0;

  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const response = await scheduler.rest(
        `contributors ${repo.nameWithOwner}`,
        () =>
          octokit.rest.repos.getContributorsStats({
            owner,
            repo: repoName,
            headers,
          }),
        true
      );

      rememberEtag(volatileCache, etagKey, response.headers);
      lastStatus = response.status;
      if (response.status === 202) {
        await delay(Math.min(8000, 1000 * Math.pow(2, attempt)));
        continue;
      }

      const stats = Array.isArray(response.data) ? response.data : [];
      const userStats = stats.find(
        (contributor) => contributor.author?.login === username
      );
      let additions = 0;
      let deletions = 0;
      let commits = 0;

      for (const week of userStats?.weeks || []) {
        additions += week.a || 0;
        deletions += week.d || 0;
        commits += week.c || 0;
      }

      return {
        additions,
        deletions,
        commits,
        fetchedAt: Date.now(),
        defaultBranchOid: repo.defaultBranchOid,
        status: "fresh",
      };
    } catch (error) {
      if (getErrorStatus(error) === 304 && cached) {
        return {
          ...cached,
          status: "cached",
          fetchedAt: Date.now(),
        };
      }
      throw error;
    }
  }

  return {
    additions: 0,
    deletions: 0,
    commits: 0,
    fetchedAt: Date.now(),
    defaultBranchOid: repo.defaultBranchOid,
    status: "pending",
    error: `GitHub still computing contributor stats (${lastStatus || 202})`,
  };
}

async function fetchTraffic(
  octokit: Octokit,
  scheduler: RequestScheduler,
  volatileCache: VolatileCache,
  cached: CachedTraffic | undefined,
  repo: RepositoryRecord
): Promise<CachedTraffic> {
  const [owner, repoName] = repo.nameWithOwner.split("/");
  const etagKey = `traffic:${repo.id}`;
  const headers = conditionalHeaders(volatileCache, etagKey);

  try {
    const response = await scheduler.rest(
      `traffic ${repo.nameWithOwner}`,
      () =>
        octokit.rest.repos.getViews({
          owner,
          repo: repoName,
          per: "day",
          headers,
        }),
      true
    );
    rememberEtag(volatileCache, etagKey, response.headers);

    const days = mergeTrafficDays(
      cached?.days || [],
      response.data.views.map((view) => ({
        timestamp: view.timestamp,
        count: view.count,
        uniques: view.uniques,
      }))
    );

    return {
      count: response.data.count,
      uniques: response.data.uniques,
      days,
      fetchedAt: Date.now(),
      status: "fresh",
    };
  } catch (error) {
    if (getErrorStatus(error) === 304 && cached) {
      return { ...cached, status: "cached" };
    }
    throw error;
  }
}

function mergeRepositoryContributions(
  summaries: RepositoryContributionSummary[]
): RepositoryContributionSummary[] {
  const byId = new Map<string, RepositoryContributionSummary>();
  for (const summary of summaries) {
    const current = byId.get(summary.repositoryId);
    if (!current) {
      byId.set(summary.repositoryId, { ...summary, counts: { ...summary.counts } });
      continue;
    }
    current.counts = addContributionCounts(current.counts, summary.counts);
  }
  return Array.from(byId.values()).sort((a, b) =>
    a.nameWithOwner.localeCompare(b.nameWithOwner)
  );
}

function mergeContributionSummary(
  summaryMap: Map<string, RepositoryContributionSummary>,
  repository: RepositoryRecord
): void {
  const current = summaryMap.get(repository.id);
  if (!current) {
    summaryMap.set(repository.id, {
      repositoryId: repository.id,
      nameWithOwner: repository.nameWithOwner,
      owner: repository.owner,
      counts: { ...repository.contributionCounts },
    });
    return;
  }
  current.counts = addContributionCounts(current.counts, repository.contributionCounts);
}

function addContributionCounts(
  a: RepositoryContributionCounts,
  b: RepositoryContributionCounts
): RepositoryContributionCounts {
  return {
    commits: a.commits + b.commits,
    issues: a.issues + b.issues,
    pullRequests: a.pullRequests + b.pullRequests,
    pullRequestReviews: a.pullRequestReviews + b.pullRequestReviews,
    repositoryCreations: a.repositoryCreations + b.repositoryCreations,
  };
}

function addSource(
  sources: RepositoryRecord["sources"],
  source: RepositoryRecord["sources"][number]
): RepositoryRecord["sources"] {
  return unique([...sources, source]);
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function getRepositoryPriority(repo: RepositoryRecord): number {
  let priority = 50;
  if (repo.sources.includes("owned")) priority -= 30;
  if (repo.sources.includes("profile-contribution")) priority -= 20;
  if (repo.sources.includes("contributed")) priority -= 10;
  if (repo.isArchived) priority += 40;
  if (repo.pushedAt?.startsWith(String(new Date().getUTCFullYear()))) priority -= 10;
  return Math.max(1, priority);
}

function canReadTraffic(repo: RepositoryRecord): boolean {
  return ["ADMIN", "MAINTAIN", "WRITE"].includes(repo.viewerPermission || "");
}

function mergeTrafficDays(existing: TrafficDay[], next: TrafficDay[]): TrafficDay[] {
  const byTimestamp = new Map<string, TrafficDay>();
  for (const day of existing) byTimestamp.set(day.timestamp, day);
  for (const day of next) byTimestamp.set(day.timestamp, day);
  return Array.from(byTimestamp.values()).sort((a, b) =>
    a.timestamp.localeCompare(b.timestamp)
  );
}

function conditionalHeaders(
  volatileCache: VolatileCache,
  key: string
): Record<string, string> | undefined {
  const cached = volatileCache.restEtags[key];
  if (!cached?.etag && !cached?.lastModified) return undefined;
  return {
    ...(cached.etag ? { "If-None-Match": cached.etag } : {}),
    ...(cached.lastModified ? { "If-Modified-Since": cached.lastModified } : {}),
  };
}

function rememberEtag(
  volatileCache: VolatileCache,
  key: string,
  headers: Record<string, string | number | undefined>
): void {
  const etag = typeof headers.etag === "string" ? headers.etag : undefined;
  const lastModified =
    typeof headers["last-modified"] === "string" ? headers["last-modified"] : undefined;
  if (!etag && !lastModified) return;
  volatileCache.restEtags[key] = {
    etag,
    lastModified,
    updatedAt: Date.now(),
  };
}

function getErrorStatus(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
