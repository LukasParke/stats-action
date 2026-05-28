import {
  ComputedStats,
  ContributionStats,
  ContributionsCollection,
  Language,
  MonthlyContribution,
  RepoDetails,
  RepositoryRecord,
  RepoStats,
  TopicCount,
  YearlyContribution,
} from "./Types";

type LanguageEdgeRepo = {
  languages: { edges: Array<{ size: number; node: { name: string; color: string | null } }> };
};

type ComputedRepo = LanguageEdgeRepo & {
  stars: number;
  forks: number;
  isArchived: boolean;
  isFork: boolean;
  isPrivate: boolean;
  topics: string[];
  updatedAt: string;
  createdAt: string;
  pushedAt?: string | null;
};

export function emptyContributionsCollection(): ContributionsCollection {
  return {
    totalCommitContributions: 0,
    restrictedContributionsCount: 0,
    totalIssueContributions: 0,
    totalRepositoryContributions: 0,
    totalPullRequestContributions: 0,
    totalPullRequestReviewContributions: 0,
    contributionCalendar: {
      totalContributions: 0,
      weeks: [],
    },
  };
}

export function mergeContributionsCollections(
  collections: ContributionsCollection[]
): ContributionsCollection {
  const merged = emptyContributionsCollection();

  for (const collection of collections) {
    merged.totalCommitContributions += collection.totalCommitContributions;
    merged.restrictedContributionsCount += collection.restrictedContributionsCount;
    merged.totalIssueContributions += collection.totalIssueContributions;
    merged.totalRepositoryContributions += collection.totalRepositoryContributions;
    merged.totalPullRequestContributions += collection.totalPullRequestContributions;
    merged.totalPullRequestReviewContributions +=
      collection.totalPullRequestReviewContributions;
    merged.contributionCalendar.totalContributions +=
      collection.contributionCalendar.totalContributions;
    merged.contributionCalendar.weeks.push(...collection.contributionCalendar.weeks);
  }

  return merged;
}

export function calculateContributionStats(
  contributionsCollection: ContributionsCollection
): ContributionStats {
  const allDays: { date: string; count: number }[] = [];
  const monthlyMap = new Map<string, number>();
  const yearlyMap = new Map<string, number>();
  const dayOfWeekCounts = new Map<string, number>();
  let peakDay: { date: string; contributions: number } | null = null;

  for (const week of contributionsCollection.contributionCalendar.weeks) {
    for (const day of week.contributionDays) {
      allDays.push({ date: day.date, count: day.contributionCount });

      const month = day.date.substring(0, 7);
      monthlyMap.set(month, (monthlyMap.get(month) || 0) + day.contributionCount);

      const year = day.date.substring(0, 4);
      yearlyMap.set(year, (yearlyMap.get(year) || 0) + day.contributionCount);

      const dayOfWeek = new Date(`${day.date}T00:00:00.000Z`).toLocaleDateString(
        "en-US",
        { weekday: "long", timeZone: "UTC" }
      );
      dayOfWeekCounts.set(
        dayOfWeek,
        (dayOfWeekCounts.get(dayOfWeek) || 0) + day.contributionCount
      );

      if (!peakDay || day.contributionCount > peakDay.contributions) {
        peakDay = { date: day.date, contributions: day.contributionCount };
      }
    }
  }

  allDays.sort((a, b) => a.date.localeCompare(b.date));

  let longestStreak = 0;
  let tempStreak = 0;
  for (const day of allDays) {
    if (day.count > 0) {
      tempStreak++;
      longestStreak = Math.max(longestStreak, tempStreak);
    } else {
      tempStreak = 0;
    }
  }

  const today = new Date().toISOString().split("T")[0];
  let currentStreak = 0;
  for (let i = allDays.length - 1; i >= 0; i--) {
    const day = allDays[i];
    if (day.count > 0) {
      currentStreak++;
      continue;
    }
    if (day.date !== today) break;
  }

  let mostActiveDay = "Sunday";
  let maxDayCount = 0;
  for (const [day, count] of dayOfWeekCounts) {
    if (count > maxDayCount) {
      maxDayCount = count;
      mostActiveDay = day;
    }
  }

  const totalDays = allDays.length || 1;
  const totalContributions =
    contributionsCollection.contributionCalendar.totalContributions;
  const averagePerDay = totalContributions / totalDays;

  const monthlyBreakdown: MonthlyContribution[] = Array.from(monthlyMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, contributions]) => ({ month, contributions }));

  const yearlyBreakdown: YearlyContribution[] = Array.from(yearlyMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([year, contributions]) => ({ year, contributions }));

  return {
    longestStreak,
    currentStreak,
    mostActiveDay,
    averagePerDay: Math.round(averagePerDay * 100) / 100,
    averagePerWeek: Math.round(averagePerDay * 700) / 100,
    averagePerMonth: Math.round(averagePerDay * 3000) / 100,
    monthlyBreakdown,
    yearlyBreakdown,
    peakDay,
  };
}

export function aggregateLanguages(
  repos: LanguageEdgeRepo[]
): { languages: Language[]; codeByteTotal: number } {
  const languageMap = new Map<string, { color: string | null; value: number }>();
  let codeByteTotal = 0;

  for (const repo of repos) {
    for (const edge of repo.languages.edges) {
      const langName = edge.node.name;
      const existing = languageMap.get(langName);
      if (existing) {
        existing.value += edge.size;
      } else {
        languageMap.set(langName, {
          color: edge.node.color,
          value: edge.size,
        });
      }
      codeByteTotal += edge.size;
    }
  }

  const languages: Language[] = Array.from(languageMap.entries())
    .map(([languageName, data]) => ({
      languageName,
      color: data.color,
      value: data.value,
      percentage:
        codeByteTotal > 0 ? Math.round((data.value / codeByteTotal) * 10000) / 100 : 0,
    }))
    .sort((a, b) => b.value - a.value || a.languageName.localeCompare(b.languageName));

  return { languages, codeByteTotal };
}

export function aggregateRepositoryLanguages(
  repos: RepositoryRecord[]
): { languages: Language[]; codeByteTotal: number } {
  const languageMap = new Map<string, { color: string | null; value: number }>();
  let codeByteTotal = 0;

  for (const repo of repos) {
    for (const language of repo.languages) {
      const existing = languageMap.get(language.languageName);
      if (existing) {
        existing.value += language.value;
      } else {
        languageMap.set(language.languageName, {
          color: language.color,
          value: language.value,
        });
      }
      codeByteTotal += language.value;
    }
  }

  const languages = Array.from(languageMap.entries())
    .map(([languageName, data]) => ({
      languageName,
      color: data.color,
      value: data.value,
      percentage:
        codeByteTotal > 0 ? Math.round((data.value / codeByteTotal) * 10000) / 100 : 0,
    }))
    .sort((a, b) => b.value - a.value || a.languageName.localeCompare(b.languageName));

  return { languages, codeByteTotal };
}

export function calculateRepoStats(repoInfoList: ComputedRepo[]): RepoStats {
  const currentYearStr = `${new Date().getFullYear()}`;
  const totalRepos = repoInfoList.length;
  const publicRepos = repoInfoList.filter((r) => !r.isPrivate).length;
  const privateRepos = repoInfoList.filter((r) => r.isPrivate).length;
  const archivedRepos = repoInfoList.filter((r) => r.isArchived).length;
  const forkedRepos = repoInfoList.filter((r) => r.isFork).length;
  const originalRepos = totalRepos - forkedRepos;
  const activeRepos = repoInfoList.filter((r) =>
    (r.pushedAt || r.updatedAt).startsWith(currentYearStr)
  ).length;
  const reposWithStars = repoInfoList.filter((r) => r.stars > 0).length;
  const reposCreatedThisYear = repoInfoList.filter((r) =>
    r.createdAt.startsWith(currentYearStr)
  ).length;
  const totalStars = repoInfoList.reduce((sum, r) => sum + r.stars, 0);
  const averageStarsPerRepo =
    totalRepos > 0 ? Math.round((totalStars / totalRepos) * 100) / 100 : 0;

  return {
    totalRepos,
    publicRepos,
    privateRepos,
    archivedRepos,
    forkedRepos,
    originalRepos,
    activeRepos,
    reposWithStars,
    reposCreatedThisYear,
    averageStarsPerRepo,
  };
}

export function calculateComputedStats(
  repoInfoList: ComputedRepo[],
  topLanguages: Language[],
  contributionStats: ContributionStats
): ComputedStats {
  const currentYear = new Date().getFullYear();
  const currentYearStr = `${currentYear}`;
  const lastYearStr = `${currentYear - 1}`;
  const repoStats = calculateRepoStats(repoInfoList);

  const languageCount = topLanguages.length;
  const primaryLanguage = topLanguages[0]?.languageName || null;

  const reposThisYear = repoInfoList.filter((r) =>
    (r.pushedAt || r.updatedAt).startsWith(currentYearStr)
  );
  const { languages: languagesThisYear } = aggregateLanguages(reposThisYear);
  const topLanguagesThisYear = languagesThisYear.slice(0, 10);
  const primaryLanguageThisYear = topLanguagesThisYear[0]?.languageName || null;

  const contributionsThisYear = contributionStats.monthlyBreakdown
    .filter((m) => m.month.startsWith(currentYearStr))
    .reduce((sum, m) => sum + m.contributions, 0);

  const contributionsLastYear = contributionStats.monthlyBreakdown
    .filter((m) => m.month.startsWith(lastYearStr))
    .reduce((sum, m) => sum + m.contributions, 0);

  const yearOverYearGrowth =
    contributionsLastYear > 0
      ? Math.round(
          ((contributionsThisYear - contributionsLastYear) / contributionsLastYear) *
            10000
        ) / 100
      : null;

  let mostProductiveMonth: { month: string; contributions: number } | null = null;
  for (const m of contributionStats.monthlyBreakdown) {
    if (!mostProductiveMonth || m.contributions > mostProductiveMonth.contributions) {
      mostProductiveMonth = m;
    }
  }

  const topicCountMap = new Map<string, number>();
  const allTopicsSet = new Set<string>();
  for (const repo of repoInfoList) {
    for (const topic of repo.topics) {
      topicCountMap.set(topic, (topicCountMap.get(topic) || 0) + 1);
      allTopicsSet.add(topic);
    }
  }
  const topTopics: TopicCount[] = Array.from(topicCountMap.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  return {
    ...repoStats,
    languageCount,
    primaryLanguage,
    primaryLanguageThisYear,
    topLanguagesThisYear,
    totalTopics: allTopicsSet.size,
    topTopics,
    allTopics: Array.from(allTopicsSet).sort(),
    contributionsThisYear,
    contributionsLastYear,
    yearOverYearGrowth,
    mostProductiveMonth,
  };
}

export function toTopRepos(repositories: RepositoryRecord[], limit = 10): RepoDetails[] {
  return repositories
    .filter((r) => r.sources.includes("owned") && !r.isArchived)
    .sort((a, b) => b.stars - a.stars || a.nameWithOwner.localeCompare(b.nameWithOwner))
    .slice(0, limit)
    .map((r) => ({
      name: r.name,
      nameWithOwner: r.nameWithOwner,
      description: r.description,
      stars: r.stars,
      forks: r.forks,
      isArchived: r.isArchived,
      isFork: r.isFork,
      isPrivate: r.isPrivate,
      primaryLanguage: r.primaryLanguage,
      topics: r.topics,
      updatedAt: r.updatedAt,
      createdAt: r.createdAt,
    }));
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function formatNumber(num: number): string {
  if (num < 1000) return num.toString();
  if (num < 1000000) return `${(num / 1000).toFixed(1)}K`;
  return `${(num / 1000000).toFixed(1)}M`;
}
