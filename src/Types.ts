export const OUTPUT_SCHEMA_VERSION = 2;
export const CACHE_SCHEMA_VERSION = 1;

export type Language = {
  languageName: string;
  color: string | null;
  value: number;
  percentage: number;
};

export type ContributionData = {
  contributionCount: number;
  date: string;
};

export type ContributionWeek = {
  contributionDays: ContributionData[];
};

export type ContributionsCollection = {
  totalCommitContributions: number;
  restrictedContributionsCount: number;
  totalIssueContributions: number;
  totalRepositoryContributions: number;
  totalPullRequestContributions: number;
  totalPullRequestReviewContributions: number;
  contributionCalendar: {
    totalContributions: number;
    weeks: ContributionWeek[];
  };
};

export type MonthlyContribution = {
  month: string;
  contributions: number;
};

export type YearlyContribution = {
  year: string;
  contributions: number;
};

export type ContributionStats = {
  longestStreak: number;
  currentStreak: number;
  mostActiveDay: string;
  averagePerDay: number;
  averagePerWeek: number;
  averagePerMonth: number;
  monthlyBreakdown: MonthlyContribution[];
  yearlyBreakdown: YearlyContribution[];
  peakDay: { date: string; contributions: number } | null;
};

export type RateLimitInfo = {
  limit: number;
  remaining: number;
  used: number;
  resetAt: string;
};

export type ActionConfig = {
  outputPath: string;
  cachePath: string;
  volatileCachePath: string;
  maxRuntimeSeconds: number;
  graphqlConcurrency: number;
  restConcurrency: number;
  minGraphqlRemaining: number;
  minRestRemaining: number;
  includeTraffic: boolean;
  includeRestRepoStats: boolean;
  includePrivateRepositoryDetails: boolean;
  includePrivateCacheDetails: boolean;
  backfillMode: "resume" | "refresh" | "off";
};

export type CollectionSource =
  | "owned"
  | "affiliated"
  | "contributed"
  | "profile-contribution"
  | "cache";

export type RepositoryContributionCounts = {
  commits: number;
  issues: number;
  pullRequests: number;
  pullRequestReviews: number;
  repositoryCreations: number;
};

export type RepositoryRecord = {
  id: string;
  name: string;
  nameWithOwner: string;
  owner: string;
  ownerType: string | null;
  description: string | null;
  url: string | null;
  isArchived: boolean;
  isFork: boolean;
  isPrivate: boolean;
  visibility: string | null;
  viewerPermission: string | null;
  createdAt: string;
  updatedAt: string;
  pushedAt: string | null;
  defaultBranchOid: string | null;
  stars: number;
  forks: number;
  primaryLanguage: string | null;
  topics: string[];
  languages: Language[];
  codeByteTotal: number;
  sources: CollectionSource[];
  contributionCounts: RepositoryContributionCounts;
  metadataFetchedAt: number;
};

export type RepoDetails = {
  name: string;
  nameWithOwner: string;
  description: string | null;
  stars: number;
  forks: number;
  isArchived: boolean;
  isFork: boolean;
  isPrivate: boolean;
  primaryLanguage: string | null;
  topics: string[];
  updatedAt: string;
  createdAt: string;
};

export type RepoStats = {
  totalRepos: number;
  publicRepos: number;
  privateRepos: number;
  archivedRepos: number;
  forkedRepos: number;
  originalRepos: number;
  activeRepos: number;
  reposWithStars: number;
  reposCreatedThisYear: number;
  averageStarsPerRepo: number;
};

export type TopicCount = {
  name: string;
  count: number;
};

export type ComputedStats = {
  totalRepos: number;
  publicRepos: number;
  privateRepos: number;
  archivedRepos: number;
  forkedRepos: number;
  originalRepos: number;
  activeRepos: number;
  reposWithStars: number;
  reposCreatedThisYear: number;
  averageStarsPerRepo: number;
  languageCount: number;
  primaryLanguage: string | null;
  primaryLanguageThisYear: string | null;
  topLanguagesThisYear: Language[];
  totalTopics: number;
  topTopics: TopicCount[];
  allTopics: string[];
  contributionsThisYear: number;
  contributionsLastYear: number;
  yearOverYearGrowth: number | null;
  mostProductiveMonth: { month: string; contributions: number } | null;
};

export type ContributorStatsSummary = {
  additions: number;
  deletions: number;
  commits: number;
  fetchedAt: number;
  defaultBranchOid: string | null;
  status: "fresh" | "cached" | "pending" | "failed" | "skipped";
  error?: string;
};

export type TrafficDay = {
  timestamp: string;
  count: number;
  uniques: number;
};

export type TrafficSummary = {
  count: number;
  uniques: number;
  days: TrafficDay[];
  fetchedAt: number;
  status: "fresh" | "cached" | "pending" | "failed" | "skipped";
  error?: string;
};

export type BackfillItemType = "contributors" | "traffic";

export type BackfillItem = {
  key: string;
  type: BackfillItemType;
  repoId: string;
  nameWithOwner: string;
  priority: number;
  reason: string;
};

export type BackfillFailure = {
  key: string;
  failedAt: number;
  attempts: number;
  message: string;
};

export type CachedContributionYear = {
  year: string;
  from: string;
  to: string;
  fetchedAt: number;
  immutable: boolean;
  data: ContributionsCollection;
  repositoryContributions: RepositoryContributionSummary[];
  repositories: RepositoryRecord[];
};

export type CachedRepository = {
  fetchedAt: number;
  repository: RepositoryRecord;
};

export type CachedContributorStats = ContributorStatsSummary;

export type CachedTraffic = TrafficSummary;

export type StableCache = {
  schemaVersion: typeof CACHE_SCHEMA_VERSION;
  updatedAt: number;
  contributionYears: Record<string, CachedContributionYear>;
  repositories: Record<string, CachedRepository>;
  contributorStats: Record<string, CachedContributorStats>;
  traffic: Record<string, CachedTraffic>;
  backfill: {
    pending: BackfillItem[];
    completed: Record<string, number>;
    failures: Record<string, BackfillFailure>;
  };
};

export type CachedEtag = {
  etag?: string;
  lastModified?: string;
  updatedAt: number;
};

export type VolatileCache = {
  schemaVersion: typeof CACHE_SCHEMA_VERSION;
  updatedAt: number;
  restEtags: Record<string, CachedEtag>;
};

export type CollectionStatus = {
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  complete: boolean;
  coreComplete: boolean;
  cache: {
    stablePath: string;
    volatilePath: string;
    contributionYearsFromCache: number;
    contributionYearsFetched: number;
    repositoriesFromCache: number;
    repositoriesFetched: number;
  };
  backfill: {
    enabled: boolean;
    completedThisRun: number;
    pending: number;
    failedThisRun: number;
    skippedThisRun: number;
  };
  rateLimit: {
    graphql: RateLimitInfo | null;
    rest: RateLimitInfo | null;
  };
  warnings: string[];
  errors: string[];
};

export type UserProfile = {
  name: string;
  login: string;
  bio: string | null;
  company: string | null;
  location: string | null;
  email: string | null;
  twitterUsername: string | null;
  websiteUrl: string | null;
  avatarUrl: string;
  createdAt: string;
  followers: number;
  following: number;
};

export type ActivityStats = {
  totalPullRequests: number;
  openIssues: number;
  closedIssues: number;
  repositoriesContributedTo: number;
  discussionsStarted: number;
  discussionsAnswered: number;
  starsGiven: number;
};

export type RepositoryContributionSummary = {
  repositoryId: string;
  nameWithOwner: string;
  owner: string;
  counts: RepositoryContributionCounts;
};

export type ProfileContributions = {
  totalContributions: number;
  totalCommitContributions: number;
  restrictedContributionsCount: number;
  totalIssueContributions: number;
  totalRepositoryContributions: number;
  totalPullRequestContributions: number;
  totalPullRequestReviewContributions: number;
  contributionCalendar: ContributionsCollection["contributionCalendar"];
  stats: ContributionStats;
  repositoryContributions: RepositoryContributionSummary[];
  completeness: {
    complete: boolean;
    yearsFetched: string[];
    yearsFromCache: string[];
    missingYears: string[];
  };
};

export type RepoMetrics = {
  starCount: number;
  forkCount: number;
  codeByteTotal: number;
  topLanguages: Language[];
  topTopics: TopicCount[];
  contributorStats: {
    totalCommits: number;
    linesAdded: number;
    linesDeleted: number;
    linesOfCodeChanged: number;
    reposCompleted: number;
    reposPending: number;
    reposFailed: number;
  };
  traffic: {
    repoViews: number;
    repoViewUniques: number;
    reposCompleted: number;
    reposPending: number;
    reposFailed: number;
  };
  repoStats: RepoStats;
  computedStats: ComputedStats;
};

export type PresentationData = {
  readmeSummary: {
    name: string;
    username: string;
    totalContributions: number;
    currentStreak: number;
    longestStreak: number;
    topLanguages: Language[];
    starsReceived: number;
    forksReceived: number;
    activeRepos: number;
    refreshedAt: string;
    complete: boolean;
  };
  cards: Array<{ id: string; label: string; value: string | number; detail?: string }>;
  timeline: Array<{ period: string; contributions: number }>;
  highlights: Array<{ id: string; label: string; value: string | number; detail?: string }>;
  remotion: {
    scenes: Array<{ id: string; title: string; metric: string | number; supportingText?: string }>;
  };
};

export type PrivacyReport = {
  privateRepositoryDetailsIncluded: boolean;
  privateCacheDetailsIncluded: boolean;
  redactedPrivateRepositories: number;
  redactedRepositoryContributions: number;
  redactedOptionalMetrics: number;
};

export type LegacyStats = {
  name: string;
  username: string;
  avatarUrl: string;
  bio: string | null;
  company: string | null;
  location: string | null;
  email: string | null;
  twitterUsername: string | null;
  websiteUrl: string | null;
  createdAt: string;
  repoViews: number;
  linesOfCodeChanged: number;
  linesAdded: number;
  linesDeleted: number;
  commitCount: number;
  totalCommits: number;
  totalPullRequests: number;
  totalPullRequestReviews: number;
  openIssues: number;
  closedIssues: number;
  fetchedAt: number;
  forkCount: number;
  starCount: number;
  starsGiven: number;
  followers: number;
  following: number;
  repositoriesContributedTo: number;
  discussionsStarted: number;
  discussionsAnswered: number;
  totalContributions: number;
  codeByteTotal: number;
  topLanguages: Language[];
  contributionStats: ContributionStats;
  repoStats: RepoStats;
  computedStats: ComputedStats;
  contributionsCollection: ContributionsCollection;
  topRepos: RepoDetails[];
};

export type GitHubStatsOutput = LegacyStats & {
  schemaVersion: typeof OUTPUT_SCHEMA_VERSION;
  generatedAt: string;
  profile: UserProfile;
  profileContributions: ProfileContributions;
  activity: ActivityStats;
  repositories: RepositoryRecord[];
  repoMetrics: RepoMetrics;
  presentation: PresentationData;
  privacy: PrivacyReport;
  collectionStatus: CollectionStatus;
  legacy: LegacyStats;
};

export type RawGraphQLLanguageEdge = {
  size: number;
  node: {
    color: string | null;
    name: string;
  };
};

export type RawGraphQLRepository = {
  id: string;
  name: string;
  nameWithOwner: string;
  owner: {
    login: string;
    __typename?: string;
  };
  description: string | null;
  url?: string | null;
  isArchived: boolean;
  isFork: boolean;
  isPrivate: boolean;
  visibility?: string | null;
  viewerPermission?: string | null;
  createdAt: string;
  updatedAt: string;
  pushedAt?: string | null;
  defaultBranchRef?: {
    target?: {
      oid?: string | null;
    } | null;
  } | null;
  stargazers?: {
    totalCount: number;
  };
  forkCount: number;
  primaryLanguage: {
    name: string;
    color?: string | null;
  } | null;
  repositoryTopics: {
    nodes: Array<{
      topic: {
        name: string;
      };
    }>;
  };
  languages: {
    edges: RawGraphQLLanguageEdge[];
  };
};

export type GraphQLContributionRepositoryGroup = {
  repository: RawGraphQLRepository;
  contributions: {
    totalCount: number;
  };
};

export type GraphQLViewerProfile = {
  name: string | null;
  login: string;
  bio: string | null;
  company: string | null;
  location: string | null;
  email: string | null;
  twitterUsername: string | null;
  websiteUrl: string | null;
  avatarUrl: string;
  createdAt: string;
  followers: { totalCount: number };
  following: { totalCount: number };
  starredRepositories: { totalCount: number };
  pullRequests: { totalCount: number };
  repositoriesContributedTo: { totalCount: number };
  openIssues: { totalCount: number };
  closedIssues: { totalCount: number };
  repositoryDiscussions: { totalCount: number };
  repositoryDiscussionComments: { totalCount: number };
};

export type GraphQLResponse<T> = T & {
  rateLimit?: RateLimitInfo;
};
