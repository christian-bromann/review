import type { PRData, PRFile, Review } from "./types.ts";

function ghHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "ai-review-cli",
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  return headers;
}

export async function fetchPR(
  owner: string,
  repo: string,
  number: number
): Promise<PRData> {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${number}`,
    { headers: ghHeaders() }
  );
  if (!res.ok) {
    if (res.status === 404) {
      throw new Error(
        `#${number} is not a pull request. This tool only reviews PRs.`
      );
    }
    throw new Error(`GitHub API error: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as PRData;
}

export async function fetchPRFiles(
  owner: string,
  repo: string,
  number: number
): Promise<PRFile[]> {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${number}/files?per_page=100`,
    { headers: ghHeaders() }
  );
  if (!res.ok) throw new Error(`Failed to fetch PR files: ${res.status}`);
  return (await res.json()) as PRFile[];
}

export async function fetchLinkedIssues(
  owner: string,
  repo: string,
  prBody: string
): Promise<Array<{ number: number; title: string; body: string }>> {
  const issueRefs = [
    ...prBody.matchAll(
      /(?:fix(?:es)?|close[sd]?|resolve[sd]?)\s+#(\d+)/gi
    ),
  ];
  const issues: Array<{ number: number; title: string; body: string }> = [];

  for (const match of issueRefs) {
    const issueNum = parseInt(match[1]!, 10);
    try {
      const res = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/issues/${issueNum}`,
        { headers: ghHeaders() }
      );
      if (res.ok) {
        const data = (await res.json()) as any;
        issues.push({
          number: issueNum,
          title: data.title,
          body: data.body ?? "",
        });
      }
    } catch {
      // Skip issues we can't fetch
    }
  }

  return issues;
}

export async function postReviewToGitHub(
  owner: string,
  repo: string,
  prNumber: number,
  commitSha: string,
  review: Review
): Promise<{ html_url: string }> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("GITHUB_TOKEN is required to post reviews.");
  }

  const eventMap: Record<string, string> = {
    comment: "COMMENT",
    approve: "APPROVE",
    request_changes: "REQUEST_CHANGES",
  };

  const body: Record<string, any> = {
    commit_id: commitSha,
    body: review.summary,
    event: eventMap[review.verdict] ?? "COMMENT",
  };

  if (review.comments.length > 0) {
    body.comments = review.comments.map((comment) => ({
      path: comment.path,
      line: comment.line,
      side: "RIGHT",
      body: comment.body,
    }));
  }

  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/reviews`,
    {
      method: "POST",
      headers: {
        ...ghHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );

  if (!res.ok) {
    const error = await res.text();
    throw new Error(`Failed to post review: ${res.status} — ${error}`);
  }

  return (await res.json()) as { html_url: string };
}
