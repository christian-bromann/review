#!/usr/bin/env -S deno run -A --env-file
/**
 * review — AI-powered PR reviewer with sandboxed code analysis
 *
 * Clones a PR's branch into an isolated sandbox, lets an AI agent review the
 * code, then posts the review to GitHub — but only after you approve it.
 *
 * Usage:
 *   npx review langchain-ai/langchainjs#7898
 *   npx review https://github.com/langchain-ai/langchainjs/pull/7898
 *   npx review langchain-ai/langchainjs#7898 --branch fix/parser
 */
// deno-lint-ignore-file no-process-global

import { intro, outro, spinner, log, note, cancel } from "@clack/prompts";
import pc from "picocolors";

import { parseArgs } from "./cli.ts";
import {
  fetchPR,
  fetchPRFiles,
  fetchLinkedIssues,
  fetchCheckRuns,
  fetchExistingReviews,
  fetchReviewComments,
} from "./github.ts";
import { createSandbox, setupSandbox } from "./sandbox.ts";
import { runReview } from "./agent.ts";

async function main() {
  const args = parseArgs();

  intro("review — AI-powered PR reviewer");

  /**
   * Validate required env vars
   */
  if (!process.env.ANTHROPIC_API_KEY) {
    log.error("ANTHROPIC_API_KEY is required.");
    cancel("Missing environment variable");
    process.exit(1);
  }

  if (!process.env.GITHUB_TOKEN) {
    log.error("GITHUB_TOKEN is required (for fetching PR data and posting reviews).");
    cancel("Missing environment variable");
    process.exit(1);
  }

  /**
   * Fetch PR details
   */
  const prSpinner = spinner({ indicator: "timer" });
  prSpinner.start(`Fetching PR #${args.prNumber} from ${args.owner}/${args.repo}...`);
  const pr = await fetchPR(args.owner, args.repo, args.prNumber);
  prSpinner.stop(`Fetched PR #${args.prNumber}`);

  log.info(
    [
      `Title:   ${pc.bold(pr.title)}`,
      `Author:  ${pc.cyan(`@${pr.user.login}`)}`,
      `Branch:  ${pc.dim(`${pr.head.ref} → ${pr.base.ref}`)}`,
      `Changes: ${pr.changed_files} files, ${pc.green(`+${pr.additions}`)} / ${pc.red(`-${pr.deletions}`)}`,
      ...(args.branch ? [`Override: ${pc.yellow(args.branch)}`] : []),
    ].join("\n")
  );

  /**
   * Fetch changed files
   */
  const filesSpinner = spinner({ indicator: "timer" });
  filesSpinner.start("Fetching changed files...");
  const files = await fetchPRFiles(args.owner, args.repo, args.prNumber);
  filesSpinner.stop(`${files.length} changed file(s)`);

  const fileLines = files.map((f) => {
    const icon = f.status === "added" ? pc.green("+") : f.status === "removed" ? pc.red("-") : pc.yellow("~");
    return `${icon} ${pc.dim(f.filename)}`;
  });
  log.message(fileLines.join("\n"));

  /**
   * Fetch linked issues
   */
  const linkedIssues = pr.body
    ? await fetchLinkedIssues(args.owner, args.repo, pr.body)
    : [];
  if (linkedIssues.length > 0) {
    log.step(`Found ${linkedIssues.length} linked issue(s)`);
    for (const issue of linkedIssues) {
      log.info(pc.dim(`#${issue.number}: ${issue.title}`));
    }
  }

  /**
   * Fetch CI check runs
   */
  const ciSpinner = spinner({ indicator: "timer" });
  ciSpinner.start("Fetching CI status...");
  const checkRuns = await fetchCheckRuns(
    args.owner,
    args.repo,
    pr.head.sha
  );
  const failing = checkRuns.filter(
    (cr) => cr.conclusion === "failure" || cr.conclusion === "cancelled"
  );
  if (checkRuns.length > 0) {
    const passing = checkRuns.filter((cr) => cr.conclusion === "success").length;
    ciSpinner.stop(
      `${checkRuns.length} check(s): ${pc.green(`${passing} passing`)}, ${failing.length > 0 ? pc.red(`${failing.length} failing`) : pc.dim("0 failing")}`
    );
  } else {
    ciSpinner.stop("No CI checks found");
  }

  /**
   * Fetch existing reviews & comments
   */
  const reviewSpinner = spinner({ indicator: "timer" });
  reviewSpinner.start("Fetching existing reviews...");
  const existingReviews = await fetchExistingReviews(
    args.owner,
    args.repo,
    args.prNumber
  );
  const reviewComments = await fetchReviewComments(
    args.owner,
    args.repo,
    args.prNumber
  );

  if (existingReviews.length > 0) {
    reviewSpinner.stop(`${existingReviews.length} existing review(s) found`);
    const reviewLines = existingReviews.map((r) => {
      const stateColor = r.state === "APPROVED" ? pc.green : r.state === "CHANGES_REQUESTED" ? pc.red : pc.dim;
      return `${pc.cyan(`@${r.user}`)} ${stateColor(r.state)}`;
    });
    log.message(pc.dim(reviewLines.join("\n")));
  } else {
    reviewSpinner.stop("No existing reviews");
  }

  if (reviewComments.length > 0) {
    log.info(pc.dim(`${reviewComments.length} inline comment(s)`));
  }

  /**
   * Check for changeset
   */
  const hasChangeset = files.some((f) =>
    f.filename.startsWith(".changeset/") && f.status === "added"
  );
  if (!hasChangeset) {
    log.warn("No changeset file detected in this PR");
  }

  note(
    "The agent will use the pre-cloned repo in the sandbox,\n" +
    "check out the PR branch, and review the code.\n" +
    "You'll approve before anything is posted.",
    "What happens next"
  );

  /**
   * Create sandbox and pre-run setup commands
   */
  const { sandbox, close } = await createSandbox();

  try {
    const { depsInstalled } = await setupSandbox(sandbox, pr);

    /**
     * Run the review agent with HITL
     */
    log.step("Agent Execution");
    const review = await runReview(
      sandbox,
      pr,
      files,
      linkedIssues,
      args.owner,
      args.repo,
      { checkRuns, existingReviews, reviewComments, hasChangeset, depsInstalled }
    );

    if (review) {
      log.success(`Review posted for: ${pc.bold(pr.title)}`);
      log.info(pc.cyan(pr.html_url));
    } else {
      log.info("No review was posted.");
    }
  } finally {
    const closeSpinner = spinner({ indicator: "timer" });
    closeSpinner.start("Closing sandbox...");
    await close();
    closeSpinner.stop("Sandbox destroyed");
  }

  outro("Done!");
}

main().catch((err) => {
  cancel("Fatal error");
  log.error(String(err));
  process.exit(1);
});
