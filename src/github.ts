import type { PRData, PRFile, Review } from "./types.ts";

// ---------------------------------------------------------------------------
// Headers helpers
// ---------------------------------------------------------------------------

/** Headers with auth token for write operations. */
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

/** Headers WITHOUT auth — for read-only calls on public repos when the token
 *  is rejected by an org (e.g. orgs that block classic PATs). */
function publicHeaders(): Record<string, string> {
  return {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "ai-review-cli",
  };
}

/**
 * Fetch a URL from the GitHub API. On 403 / 401, automatically retries
 * without the auth token (works for public repos whose org blocks classic PATs).
 */
async function ghFetch(url: string): Promise<Response> {
  const res = await fetch(url, { headers: ghHeaders() });

  if ((res.status === 403 || res.status === 401) && process.env.GITHUB_TOKEN) {
    // Some orgs (e.g. langchain-ai) block classic PATs.
    // Retry without auth — works fine for public repos.
    const retry = await fetch(url, { headers: publicHeaders() });
    if (retry.ok) return retry;
  }

  return res;
}

// ---------------------------------------------------------------------------
// Read operations
// ---------------------------------------------------------------------------

export async function fetchPR(
  owner: string,
  repo: string,
  number: number
): Promise<PRData> {
  const res = await ghFetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${number}`
  );
  if (!res.ok) {
    if (res.status === 404) {
      throw new Error(
        `#${number} is not a pull request. This tool only reviews PRs.`
      );
    }
    if (res.status === 403 || res.status === 401) {
      const body = await res.text();
      throw new Error(
        `GitHub API returned ${res.status}.\n` +
          `  → Some orgs block classic PATs — use a fine-grained token instead\n` +
          `  → Fine-grained token: set "Pull requests" to "Read and write"\n` +
          `  → Details: ${body}`
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
  const res = await ghFetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${number}/files?per_page=100`
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
      const res = await ghFetch(
        `https://api.github.com/repos/${owner}/${repo}/issues/${issueNum}`
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

// ---------------------------------------------------------------------------
// Write operations (always require auth)
// ---------------------------------------------------------------------------

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
    if (res.status === 403) {
      throw new Error(
        `GitHub returned 403 Forbidden.\n` +
          `  → Some orgs block classic PATs — use a fine-grained token\n` +
          `  → Fine-grained token: set "Pull requests" to "Read and write"\n` +
          `  → Make sure the token has access to ${owner}/${repo}\n` +
          `  → Details: ${error}`
      );
    }
    throw new Error(`Failed to post review: ${res.status} — ${error}`);
  }

  return (await res.json()) as { html_url: string };
}
