export interface PRRepo {
  full_name: string;
  clone_url: string;
}

export interface PRData {
  number: number;
  title: string;
  body: string;
  head: { ref: string; sha: string; repo: PRRepo };
  base: { ref: string; sha: string; repo: PRRepo };
  user: { login: string };
  html_url: string;
  additions: number;
  deletions: number;
  changed_files: number;
}

export interface PRFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

export interface ReviewComment {
  path: string;
  line: number;
  body: string;
}

export interface Review {
  summary: string;
  verdict: "comment" | "approve" | "request_changes";
  comments: ReviewComment[];
}

export interface CheckRun {
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string;
}

export interface ExistingReview {
  user: string;
  state: string;
  body: string;
  submitted_at: string;
}

export interface ReviewThreadComment {
  user: string;
  body: string;
  path: string;
  line: number | null;
  created_at: string;
}

export interface ReviewContext {
  checkRuns: CheckRun[];
  existingReviews: ExistingReview[];
  reviewComments: ReviewThreadComment[];
  hasChangeset: boolean;
}

export interface LinkedIssue {
  number: number;
  title: string;
  body: string;
}

export interface CliArgs {
  owner: string;
  repo: string;
  prNumber: number;
  branch?: string;
}
