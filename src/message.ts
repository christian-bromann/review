import type { PRData, PRFile, ReviewContext, LinkedIssue } from "./types.ts";
import { VOLUME_MOUNT, PNPM_STORE } from "./sandbox.ts";

/**
 * Build the setup commands for the sandbox.
 * @param pr - The pull request data.
 * @returns The setup commands.
 */
function buildSetupCommands(pr: PRData): string {
  const repoDir = VOLUME_MOUNT;
  const isFork = pr.head.repo.full_name !== pr.base.repo.full_name;
  const headRemote = isFork ? "pr-fork" : "origin";
  const headCloneUrl = pr.head.repo.clone_url;

  if (isFork) {
    return `\`\`\`bash
cd ${repoDir}
git remote add ${headRemote} ${headCloneUrl} || git remote set-url ${headRemote} ${headCloneUrl}
git fetch ${headRemote} ${pr.head.ref}:refs/remotes/${headRemote}/${pr.head.ref} --depth 200
git fetch origin ${pr.base.ref}:refs/remotes/origin/${pr.base.ref} --depth 200
git checkout -B ${pr.head.ref} ${headRemote}/${pr.head.ref}
pnpm install --store-dir ${PNPM_STORE}
\`\`\`

**This PR is from a fork** (\`${pr.head.repo.full_name}\`), so the branch does NOT exist on \`origin\`.
You MUST add the fork as a separate remote (\`${headRemote}\`) and fetch from it. Do NOT try to fetch the branch from \`origin\` — it will fail.`;
  }

  return `\`\`\`bash
cd ${repoDir}
git fetch origin ${pr.head.ref}:refs/remotes/origin/${pr.head.ref} --depth 200
git fetch origin ${pr.base.ref}:refs/remotes/origin/${pr.base.ref} --depth 200
git checkout -B ${pr.head.ref} origin/${pr.head.ref}
pnpm install --store-dir ${PNPM_STORE}
\`\`\``;
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

/**
 * Build the system prompt that instructs the agent on how to review a PR.
 */
export function buildSystemPrompt(pr: PRData): string {
  const repoDir = VOLUME_MOUNT;
  const setupCommands = buildSetupCommands(pr);

  return `You are an expert code reviewer working inside an isolated sandbox.
You have been given a pull request to review. Your job is to:

1. Check out the PR branch on the pre-cloned repository
2. Install any new/changed dependencies
3. Understand the changes by reading the diff and relevant source files
4. Check for bugs, logic errors, edge cases, security issues, and style problems
5. Check CI status and changeset presence (details provided in context)
6. Optionally run tests if a test suite exists and it's practical to do so
7. Submit a code review using the submit_review tool

## Setup commands (follow EXACTLY — do NOT deviate)
The repository is already cloned at \`${repoDir}\` on a read-only snapshot with
dependencies pre-installed on the default branch. The \`origin\` remote points
to \`${pr.base.repo.full_name}\`.
**Do NOT checkout \`${pr.base.ref}\`** — it is already available as a remote ref.
Run these commands in order:

${setupCommands}

- The \`git fetch\` for \`${pr.base.ref}\` is ONLY so \`git diff\` works — do NOT check it out.
- \`pnpm install\` MUST run AFTER \`git checkout\` so it picks up dependency changes from the PR branch.

After checkout, run \`git diff origin/${pr.base.ref}...HEAD\` to see all changes.

## Tone & wording rules (CRITICAL — follow these strictly)
- **Start with a thank-you** — e.g. "Thanks for the contribution!" or "Thanks for tackling this!"
- **Don't state the obvious** — never re-explain what the code does or how the fix works. The author already knows. Don't describe the implementation approach, the problem being solved, or how the pieces fit together — all of that is visible in the diff and PR description. Never praise the implementation quality (e.g. "excellent implementation", "comprehensive and well-tested", "well-structured approach") — that's just parroting the PR description in different words
- **Keep approvals short** — if the PR looks good, just say "LGTM 👍" with a brief thank-you. No sentences evaluating the PR's scope, approach, or quality. No need for "Summary", "Analysis", "Code Quality", "Verification", or "Risk Assessment" sections
- **Skip code quality commentary** unless there are severe issues not caught by automated tooling (prettier, eslint, CI)
- **Don't duplicate information** — the diff speaks for itself; don't re-describe what it shows. The summary should contain a thank-you and verdict. If you have multiple line comments, add one brief sentence summarizing the themes (e.g. "A few edge-case and error-handling suggestions below.") — but don't rehash each comment individually
- **Only include actionable line comments** — every inline comment must ask the author to do something or consider something specific (fix a bug, handle an edge case, rename something, add a test, etc.). Do NOT post comments that are just praise ("Good solution!", "Nice work here"), observations ("This ensures consistency"), or narration of what the code does. If you have nothing actionable to say about a line, don't comment on it. An empty comments array is perfectly fine
- When you DO leave feedback, be constructive and suggest solutions
- **Suggestion indentation** — when using \`\`\`suggestion\`\`\` blocks, the replacement code MUST have the exact same leading whitespace as the original line in the diff. Count the spaces/tabs from the diff and replicate them precisely

## Follow-up reviews
If the PR context includes existing reviews or review comments:
- Read the conversation history carefully before writing your review
- If you (or a previous reviewer) previously requested changes and the author addressed them, acknowledge that and approve or note remaining items — don't start fresh
- Follow the conversation naturally, referencing earlier feedback
- Don't repeat feedback that was already addressed

## CI checks
- If failing CI checks are provided in the context, investigate the failure and include guidance on how to fix in your review
- If all checks pass, don't mention them — that's the expected state

## Changesets
- If the context indicates no changeset was found and the PR has user-facing changes, mention it and guide the author: "Looks like this PR is missing a changeset. You can add one by running \`npx changeset\` and committing the generated file."
- If the PR is purely internal (CI, tests, docs) or a changeset is present, don't mention changesets

## Important
- The repo is pre-cloned at ${repoDir} — do NOT clone again
- Work inside ${repoDir} after checkout
- After checkout, check if \`${repoDir}/AGENTS.md\` exists and read it — it contains project-specific guidelines for how to work with the codebase (test commands, coding conventions, etc.)
- Use \`read_file\` to explore the code for context
- Use \`execute\` to run git commands
- When ready, call \`submit_review\` with your complete review
- Do NOT post partial reviews — collect all comments first, then submit once`;
}

/**
 * Build the user-facing message that contains full PR context
 * (metadata, diffs, CI status, changeset info, review history).
 * 
 * @param pr - The pull request data.
 * @param files - The files in the pull request.
 * @param linkedIssues - The linked issues.
 * @param context - The review context.
 * @returns The user-facing message.
 */
export function buildUserMessage(
  pr: PRData,
  files: PRFile[],
  linkedIssues: LinkedIssue[],
  context: ReviewContext,
): string {
  const parts: string[] = [];

  // ---- PR header ----
  parts.push(`# Pull Request: ${pr.title}\n`);
  parts.push(`**Author:** @${pr.user.login}`);
  parts.push(`**Branch:** \`${pr.head.ref}\` → \`${pr.base.ref}\``);
  parts.push(
    `**Changes:** ${pr.changed_files} files, +${pr.additions} / -${pr.deletions}`,
  );
  parts.push(`**URL:** ${pr.html_url}\n`);

  // ---- PR description ----
  if (pr.body) {
    parts.push(`## PR Description\n\n${pr.body}\n`);
  }

  // ---- Linked issues ----
  if (linkedIssues.length > 0) {
    parts.push(`## Linked Issues\n`);
    for (const issue of linkedIssues) {
      parts.push(`### #${issue.number}: ${issue.title}\n\n${issue.body}\n\n---\n`);
    }
  }

  // ---- Changed files / diffs ----
  parts.push(`## Changed Files\n`);
  for (const file of files) {
    parts.push(
      `### ${file.filename} (${file.status}, +${file.additions}/-${file.deletions})\n`,
    );
    if (file.patch) {
      const patch =
        file.patch.length > 3000
          ? file.patch.slice(0, 3000) +
            "\n... (truncated, read full file in sandbox)"
          : file.patch;
      parts.push(`\`\`\`diff\n${patch}\n\`\`\`\n`);
    }
  }

  // ---- CI check status ----
  if (context.checkRuns.length > 0) {
    parts.push(`## CI Check Status\n`);
    const failing = context.checkRuns.filter(
      (cr) => cr.conclusion === "failure" || cr.conclusion === "cancelled",
    );
    const passing = context.checkRuns.filter(
      (cr) => cr.conclusion === "success",
    );
    const pending = context.checkRuns.filter(
      (cr) => cr.status !== "completed",
    );

    if (failing.length > 0) {
      parts.push(`**⚠️ Failing checks (${failing.length}):**`);
      for (const cr of failing) {
        parts.push(
          `- ❌ \`${cr.name}\` — ${cr.conclusion} ([logs](${cr.html_url}))`,
        );
      }
      parts.push("");
    }
    if (pending.length > 0) {
      parts.push(`**⏳ Pending checks (${pending.length}):**`);
      for (const cr of pending) {
        parts.push(`- ⏳ \`${cr.name}\` — ${cr.status}`);
      }
      parts.push("");
    }
    if (passing.length > 0) {
      parts.push(`**✅ Passing checks: ${passing.length}**\n`);
    }
  }

  // ---- Changeset info ----
  if (!context.hasChangeset) {
    parts.push(`## Changeset\n`);
    parts.push(
      `⚠️ No changeset file was found in this PR. If this PR introduces user-facing changes, a changeset should be added.\n`,
    );
  }

  // ---- Existing reviews & conversation history ----
  if (context.existingReviews.length > 0 || context.reviewComments.length > 0) {
    parts.push(`## Existing Review History\n`);
    parts.push(
      `**This PR has been reviewed before. Read the history below and follow the conversation naturally.**\n`,
    );

    for (const review of context.existingReviews) {
      const stateEmoji =
        review.state === "APPROVED"
          ? "✅"
          : review.state === "CHANGES_REQUESTED"
            ? "🔴"
            : "💬";
      parts.push(
        `### ${stateEmoji} Review by @${review.user} (${review.state}) — ${review.submitted_at}\n`,
      );
      if (review.body) {
        parts.push(`${review.body}\n`);
      }
    }

    if (context.reviewComments.length > 0) {
      parts.push(`### Inline review comments\n`);
      for (const comment of context.reviewComments) {
        parts.push(
          `- **@${comment.user}** on \`${comment.path}${comment.line ? `:${comment.line}` : ""}\`:\n  ${comment.body}\n`,
        );
      }
    }
  }

  parts.push(
    "\nPlease review the changes thoroughly and submit your review using the submit_review tool. The repository is already cloned — just follow the setup commands from the system prompt exactly.",
  );

  return parts.join("\n");
}
