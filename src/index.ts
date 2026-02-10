#!/usr/bin/env node
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
 *   SANDBOX_PROVIDER=local npx review langchain-ai/langchainjs#7898
 */

import { parseArgs } from "./cli.ts";
import { c, header, step, info } from "./display.ts";
import { fetchPR, fetchPRFiles, fetchLinkedIssues } from "./github.ts";
import { createSandbox } from "./sandbox.ts";
import { runReview } from "./agent.ts";

async function main() {
  const args = parseArgs();

  header("review — AI-powered PR reviewer");

  // Validate required env vars
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      `${c.red}Error: ANTHROPIC_API_KEY is required.${c.reset}`
    );
    process.exit(1);
  }

  if (!process.env.GITHUB_TOKEN) {
    console.error(
      `${c.red}Error: GITHUB_TOKEN is required (for fetching PR data and posting reviews).${c.reset}`
    );
    process.exit(1);
  }

  // Fetch PR details
  step(
    "🌐",
    `Fetching PR #${args.prNumber} from ${args.owner}/${args.repo}...`
  );
  const pr = await fetchPR(args.owner, args.repo, args.prNumber);
  info(`Title: ${pr.title}`);
  info(`Author: @${pr.user.login}`);
  info(`Branch: ${pr.head.ref} → ${pr.base.ref}`);
  info(
    `Changes: ${pr.changed_files} files, +${pr.additions} / -${pr.deletions}`
  );

  if (args.branch) {
    info(`Branch override: ${args.branch}`);
  }

  // Fetch changed files
  step("📄", "Fetching changed files...");
  const files = await fetchPRFiles(args.owner, args.repo, args.prNumber);
  for (const f of files) {
    info(
      `  ${f.status === "added" ? "+" : f.status === "removed" ? "-" : "~"} ${f.filename}`
    );
  }

  // Fetch linked issues
  const linkedIssues = pr.body
    ? await fetchLinkedIssues(args.owner, args.repo, pr.body)
    : [];
  if (linkedIssues.length > 0) {
    step("🔗", `Found ${linkedIssues.length} linked issue(s)`);
    for (const issue of linkedIssues) {
      info(`  #${issue.number}: ${issue.title}`);
    }
  }

  console.log(
    `\n${c.dim}  The agent will clone the repo into a sandbox, review the code,`
  );
  console.log(
    `  and propose a review. You'll approve before anything is posted.${c.reset}\n`
  );

  // Create sandbox
  const { sandbox, close } = await createSandbox();

  try {
    // Run the review agent with HITL
    header("AGENT EXECUTION");
    const review = await runReview(
      sandbox,
      pr,
      files,
      linkedIssues,
      args.owner,
      args.repo
    );

    header("DONE");
    if (review) {
      step("✅", `Review posted for: ${pr.title}`);
      step("🔗", pr.html_url);
    } else {
      step("ℹ️", "No review was posted.");
    }
  } finally {
    step("🧹", "Closing sandbox...");
    await close();
    info("Sandbox destroyed.\n");
  }
}

main().catch((err) => {
  console.error(`${c.red}Fatal error:${c.reset}`, err);
  process.exit(1);
});
