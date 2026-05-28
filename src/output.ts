import {
  ActivityStats,
  CollectionStatus,
  GitHubStatsOutput,
  LegacyStats,
  OUTPUT_SCHEMA_VERSION,
  PresentationData,
  ProfileContributions,
  RepoMetrics,
  RepositoryRecord,
  StableCache,
  UserProfile,
} from "./Types";
import type { ContributionCollectionResult } from "./github";
import {
  aggregateRepositoryLanguages,
  calculateComputedStats,
  calculateContributionStats,
  calculateRepoStats,
  formatBytes,
  formatNumber,
  toTopRepos,
} from "./aggregate";

export function buildOutput(params: {
  profile: UserProfile;
  activity: ActivityStats;
  contributions: ContributionCollectionResult;
  repositories: RepositoryRecord[];
  cache: StableCache;
  collectionStatus: CollectionStatus;
  fetchedAt: number;
}): GitHubStatsOutput {
  const contributionStats = calculateContributionStats(params.contributions.collection);
  const { languages: topLanguages, codeByteTotal } = aggregateRepositoryLanguages(
    params.repositories
  );
  const computedRepos = params.repositories.map((repo) => ({
    ...repo,
    languages: {
      edges: repo.languages.map((language) => ({
        size: language.value,
        node: {
          name: language.languageName,
          color: language.color,
        },
      })),
    },
  }));
  const computedStats = calculateComputedStats(
    computedRepos,
    topLanguages,
    contributionStats
  );
  const repoStats = calculateRepoStats(computedRepos);
  const ownedRepos = params.repositories.filter((repo) => repo.sources.includes("owned"));
  const starCount = ownedRepos.reduce((sum, repo) => sum + repo.stars, 0);
  const forkCount = ownedRepos.reduce((sum, repo) => sum + repo.forks, 0);
  const contributorSummaries = Object.values(params.cache.contributorStats);
  const trafficSummaries = Object.values(params.cache.traffic);
  const linesAdded = contributorSummaries.reduce(
    (sum, stats) => sum + stats.additions,
    0
  );
  const linesDeleted = contributorSummaries.reduce(
    (sum, stats) => sum + stats.deletions,
    0
  );
  const commitCount = contributorSummaries.reduce((sum, stats) => sum + stats.commits, 0);
  const repoViews = trafficSummaries.reduce((sum, traffic) => sum + traffic.count, 0);
  const repoViewUniques = trafficSummaries.reduce(
    (sum, traffic) => sum + traffic.uniques,
    0
  );
  const topRepos = toTopRepos(params.repositories);

  const repoMetrics: RepoMetrics = {
    starCount,
    forkCount,
    codeByteTotal,
    topLanguages,
    topTopics: computedStats.topTopics,
    contributorStats: {
      totalCommits: commitCount,
      linesAdded,
      linesDeleted,
      linesOfCodeChanged: linesAdded + linesDeleted,
      reposCompleted: contributorSummaries.filter((stats) =>
        ["fresh", "cached"].includes(stats.status)
      ).length,
      reposPending: params.cache.backfill.pending.filter(
        (item) => item.type === "contributors"
      ).length,
      reposFailed: Object.values(params.cache.backfill.failures).filter((failure) =>
        failure.key.startsWith("contributors:")
      ).length,
    },
    traffic: {
      repoViews,
      repoViewUniques,
      reposCompleted: trafficSummaries.filter((traffic) =>
        ["fresh", "cached"].includes(traffic.status)
      ).length,
      reposPending: params.cache.backfill.pending.filter((item) => item.type === "traffic")
        .length,
      reposFailed: Object.values(params.cache.backfill.failures).filter((failure) =>
        failure.key.startsWith("traffic:")
      ).length,
    },
    repoStats,
    computedStats,
  };

  const profileContributions: ProfileContributions = {
    totalContributions:
      params.contributions.collection.contributionCalendar.totalContributions,
    totalCommitContributions: params.contributions.collection.totalCommitContributions,
    restrictedContributionsCount:
      params.contributions.collection.restrictedContributionsCount,
    totalIssueContributions: params.contributions.collection.totalIssueContributions,
    totalRepositoryContributions:
      params.contributions.collection.totalRepositoryContributions,
    totalPullRequestContributions:
      params.contributions.collection.totalPullRequestContributions,
    totalPullRequestReviewContributions:
      params.contributions.collection.totalPullRequestReviewContributions,
    contributionCalendar: params.contributions.collection.contributionCalendar,
    stats: contributionStats,
    repositoryContributions: params.contributions.repositoryContributions,
    completeness: {
      complete: params.contributions.missingYears.length === 0,
      yearsFetched: params.contributions.yearsFetched,
      yearsFromCache: params.contributions.yearsFromCache,
      missingYears: params.contributions.missingYears,
    },
  };

  const legacy: LegacyStats = {
    name: params.profile.name,
    avatarUrl: params.profile.avatarUrl,
    username: params.profile.login,
    bio: params.profile.bio,
    company: params.profile.company,
    location: params.profile.location,
    email: params.profile.email,
    twitterUsername: params.profile.twitterUsername,
    websiteUrl: params.profile.websiteUrl,
    createdAt: params.profile.createdAt,
    repoViews,
    linesOfCodeChanged: linesAdded + linesDeleted,
    linesAdded,
    linesDeleted,
    commitCount,
    totalCommits: params.contributions.collection.totalCommitContributions,
    totalPullRequests: params.activity.totalPullRequests,
    totalPullRequestReviews:
      params.contributions.collection.totalPullRequestReviewContributions,
    codeByteTotal,
    topLanguages,
    forkCount,
    starCount,
    starsGiven: params.activity.starsGiven,
    followers: params.profile.followers,
    following: params.profile.following,
    repositoriesContributedTo: params.activity.repositoriesContributedTo,
    discussionsStarted: params.activity.discussionsStarted,
    discussionsAnswered: params.activity.discussionsAnswered,
    totalContributions:
      params.contributions.collection.contributionCalendar.totalContributions,
    contributionStats,
    repoStats,
    computedStats,
    contributionsCollection: params.contributions.collection,
    topRepos,
    closedIssues: params.activity.closedIssues,
    openIssues: params.activity.openIssues,
    fetchedAt: params.fetchedAt,
  };

  const presentation = buildPresentation({
    profile: params.profile,
    legacy,
    repoMetrics,
    complete: params.collectionStatus.complete,
  });

  return {
    ...legacy,
    schemaVersion: OUTPUT_SCHEMA_VERSION,
    generatedAt: new Date(params.fetchedAt).toISOString(),
    profile: params.profile,
    profileContributions,
    activity: params.activity,
    repositories: params.repositories,
    repoMetrics,
    presentation,
    collectionStatus: params.collectionStatus,
    legacy,
  };
}

function buildPresentation(params: {
  profile: UserProfile;
  legacy: LegacyStats;
  repoMetrics: RepoMetrics;
  complete: boolean;
}): PresentationData {
  const topLanguage = params.legacy.topLanguages[0];
  const mostProductiveMonth = params.legacy.computedStats.mostProductiveMonth;
  const peakDay = params.legacy.contributionStats.peakDay;

  return {
    readmeSummary: {
      name: params.profile.name,
      username: params.profile.login,
      totalContributions: params.legacy.totalContributions,
      currentStreak: params.legacy.contributionStats.currentStreak,
      longestStreak: params.legacy.contributionStats.longestStreak,
      topLanguages: params.legacy.topLanguages.slice(0, 5),
      starsReceived: params.legacy.starCount,
      forksReceived: params.legacy.forkCount,
      activeRepos: params.legacy.repoStats.activeRepos,
      refreshedAt: new Date(params.legacy.fetchedAt).toISOString(),
      complete: params.complete,
    },
    cards: [
      {
        id: "total-contributions",
        label: "Total contributions",
        value: formatNumber(params.legacy.totalContributions),
      },
      {
        id: "current-streak",
        label: "Current streak",
        value: `${params.legacy.contributionStats.currentStreak} days`,
      },
      {
        id: "languages",
        label: "Languages",
        value: params.legacy.computedStats.languageCount,
        detail: topLanguage ? `${topLanguage.languageName} leads` : undefined,
      },
      {
        id: "code-volume",
        label: "Code volume",
        value: formatBytes(params.legacy.codeByteTotal),
      },
      {
        id: "stars",
        label: "Stars received",
        value: formatNumber(params.legacy.starCount),
      },
    ],
    timeline: params.legacy.contributionStats.yearlyBreakdown.map((year) => ({
      period: year.year,
      contributions: year.contributions,
    })),
    highlights: [
      ...(peakDay
        ? [
            {
              id: "peak-day",
              label: "Peak day",
              value: peakDay.contributions,
              detail: peakDay.date,
            },
          ]
        : []),
      ...(mostProductiveMonth
        ? [
            {
              id: "top-month",
              label: "Most productive month",
              value: mostProductiveMonth.contributions,
              detail: mostProductiveMonth.month,
            },
          ]
        : []),
      ...(topLanguage
        ? [
            {
              id: "top-language",
              label: "Top language",
              value: topLanguage.languageName,
              detail: `${topLanguage.percentage}%`,
            },
          ]
        : []),
    ],
    remotion: {
      scenes: [
        {
          id: "intro",
          title: params.profile.name || params.profile.login,
          metric: params.profile.login,
          supportingText: "GitHub profile activity",
        },
        {
          id: "contributions",
          title: "Contribution history",
          metric: formatNumber(params.legacy.totalContributions),
          supportingText: `${params.legacy.contributionStats.longestStreak} day longest streak`,
        },
        {
          id: "repositories",
          title: "Repository footprint",
          metric: params.legacy.repoStats.totalRepos,
          supportingText: `${params.legacy.repoStats.activeRepos} active this year`,
        },
        {
          id: "languages",
          title: "Language mix",
          metric: topLanguage?.languageName || "N/A",
          supportingText: `${params.legacy.computedStats.languageCount} languages detected`,
        },
      ],
    },
  };
}
