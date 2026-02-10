export interface PRData {
  number: number;
  title: string;
  body: string;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
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

export interface CliArgs {
  owner: string;
  repo: string;
  prNumber: number;
  branch?: string;
}
