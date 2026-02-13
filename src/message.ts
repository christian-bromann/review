import type { PRData, PRFile, ReviewContext, LinkedIssue } from "./types.ts";
import { VOLUME_MOUNT, PNPM_STORE } from "./sandbox.ts";

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

/**
 * Build the system prompt that instructs the agent on how to review a PR.
 */
export function buildSystemPrompt(pr: PRData, opts: { depsInstalled: boolean }): string {
  const repoDir = VOLUME_MOUNT;

  const depsNote = opts.depsInstalled
    ? `dependencies installed. You can start reviewing immediately — do NOT run
git checkout, git fetch, or pnpm install.`
    : `the branch checked out. Dependency installation failed during setup (likely OOM).
You can still review code by reading files. If you need to run tests, try:
\`cd ${repoDir} && NODE_OPTIONS=--max-old-space-size=3584 pnpm install --store-dir ${PNPM_STORE}\`
Do NOT run git checkout or git fetch — that is already done.`;

  return `You are an expert code reviewer working inside an isolated sandbox.
You have been given a pull request to review. The repository is already set up:
the PR branch (\`${pr.head.ref}\`) is checked out at \`${repoDir}\` with
${depsNote}

Your job is to:
1. Understand the changes by reading the diff (provided below) and relevant source files
2. Check for bugs, logic errors, edge cases, security issues, and style problems
3. Check CI status and changeset presence (details provided in context)
4. Optionally run tests if a test suite exists and it's practical to do so
5. Submit a code review using the submit_review tool

## Efficient exploration (IMPORTANT — read files in parallel)
- **Batch your \`read_file\` calls**: when you need to read multiple files, call them ALL in a single turn rather than one at a time. For example, if you need to read 5 files, issue 5 \`read_file\` calls in parallel — don't read one, wait, read the next, etc.
- **Plan your reads**: look at the file list and diffs first, identify ALL files you need more context on, then read them all at once
- **Use \`execute\` for batch operations too**: e.g. \`grep -rn\` across multiple directories in one command
- The diffs for each changed file are provided in the user message. Only use \`read_file\` when you need additional context beyond the diff (e.g. surrounding code, imported modules, type definitions)
- You can run \`git diff origin/${pr.base.ref}...HEAD\` if you need the full diff, but the per-file patches are already included below

## First step
Check if \`${repoDir}/AGENTS.md\` exists and read it — it contains project-specific guidelines.
You can read AGENTS.md and other context files in the same parallel batch.

## Tone & wording rules (CRITICAL — follow these strictly)
- **Start with a thank-you** — e.g. "Thanks for the contribution!" or "Thanks for tackling this!"
- **Don't state the obvious** — never re-explain what the code does or how the fix works. The author already knows. Don't describe the implementation approach, the problem being solved, or how the pieces fit together — all of that is visible in the diff and PR description. Never praise the implementation quality (e.g. "excellent implementation", "comprehensive and well-tested", "well-structured approach") — that's just parroting the PR description in different words
- **Keep approvals short** — if the PR looks good, just say "LGTM 👍" with a brief thank-you. No sentences evaluating the PR's scope, approach, or quality. No need for "Summary", "Analysis", "Code Quality", "Verification", or "Risk Assessment" sections
- **Skip code quality commentary** unless there are severe issues not caught by automated tooling (prettier, eslint, CI)
- **Don't duplicate information** — the diff speaks for itself; don't re-describe what it shows. The summary should contain a thank-you and verdict. If you have multiple line comments, add one brief sentence summarizing the themes (e.g. "A few edge-case and error-handling suggestions below.") — but don't rehash each comment individually
- **Only include actionable line comments** — every inline comment must ask the author to do something or consider something specific (fix a bug, handle an edge case, rename something, add a test, etc.). Do NOT post comments that are just praise ("Good solution!", "Nice work here"), observations ("This ensures consistency"), or narration of what the code does. If you have nothing actionable to say about a line, don't comment on it. An empty comments array is perfectly fine
- When you DO leave feedback, be constructive and suggest solutions
- **Suggestion indentation** — when using \`\`\`suggestion\`\`\` blocks, the replacement code MUST have the exact same leading whitespace as the original line in the diff. Count the spaces/tabs from the diff and replicate them precisely
- **Suggestion line targeting (CRITICAL)** — the \`line\` field must point to the LAST line being replaced, not the first or a nearby line:
  - **Single-line suggestion:** set \`line\` to the exact line being replaced. For example, if you want to replace \`throw new Error("msg")\` on line 42, set \`line: 42\` — NOT the line above it (like the \`if\` statement on line 41)
  - **Multi-line suggestion:** set \`start_line\` to the FIRST line of the range being replaced and \`line\` to the LAST line. For example, if you want to replace lines 10–15, set \`start_line: 10, line: 15\`. The suggestion block content replaces the ENTIRE range from start_line to line
  - **Common mistake:** placing the comment on a context line (like an \`if\` or function signature) when the actual replacement is on lines below it. Always target the exact lines being replaced

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

## Monorepo commands — ALWAYS scope to the affected package (CRITICAL)
This is a large monorepo. Running build, lint, test, or typecheck commands against the
entire repository will be extremely slow and may OOM the sandbox.
**NEVER** run unscoped commands like:
- \`pnpm build\` (builds every package)
- \`pnpm lint\` (lints every package)
- \`pnpm test\` (tests every package)
- \`pnpm tsc\` or \`pnpm typecheck\` (typechecks everything)

**ALWAYS** scope commands to the specific package(s) affected by the PR using \`--filter\`:
- \`pnpm --filter @langchain/<package-name> build\`
- \`pnpm --filter @langchain/<package-name> lint\`
- \`pnpm --filter @langchain/<package-name> test\`

Determine the affected package(s) from the file paths in the diff. For example, if the
changes are in \`libs/providers/langchain-anthropic/\`, use \`--filter @langchain/anthropic\`.
If you're unsure of the package name, check the \`package.json\` in that directory.

## Important
- The repo is already checked out at ${repoDir} with the PR branch — do NOT clone again or run git checkout/fetch
- Use \`read_file\` to explore the code for context — **batch multiple reads in a single turn**
- Use \`execute\` to run git commands or tests — **always scope to the affected package** (see above)
- When ready, call \`submit_review\` with your complete review
- Do NOT post partial reviews — collect all comments first, then submit once`;
}

/**
 * Group files by their top-level directory for better context organization.
 */
function groupFilesByDirectory(files: PRFile[]): Map<string, PRFile[]> {
  const groups = new Map<string, PRFile[]>();
  for (const file of files) {
    // Use the first two path segments as the group key, or the full dirname
    const parts = file.filename.split("/");
    const groupKey = parts.length > 2
      ? parts.slice(0, 2).join("/")
      : parts.length > 1
        ? parts[0]
        : "(root)";

    if (!groups.has(groupKey)) {
      groups.set(groupKey, []);
    }
    groups.get(groupKey)!.push(file);
  }
  return groups;
}

/** Max characters per patch before truncation. */
const PATCH_TRUNCATION_LIMIT = 12_000;

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

  // ---- Changed files / diffs (grouped by directory) ----
  parts.push(`## Changed Files\n`);

  const fileGroups = groupFilesByDirectory(files);
  for (const [dir, groupFiles] of fileGroups) {
    if (fileGroups.size > 1) {
      parts.push(`### 📁 ${dir}\n`);
    }
    for (const file of groupFiles) {
      const statusIcon = file.status === "added" ? "+" : file.status === "removed" ? "-" : "~";
      parts.push(
        `#### ${statusIcon} ${file.filename} (${file.status}, +${file.additions}/-${file.deletions})\n`,
      );
      if (file.patch) {
        const patch =
          file.patch.length > PATCH_TRUNCATION_LIMIT
            ? file.patch.slice(0, PATCH_TRUNCATION_LIMIT) +
              "\n... (truncated, read full file in sandbox)"
            : file.patch;
        parts.push(`\`\`\`diff\n${patch}\n\`\`\`\n`);
      }
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
    "\nPlease review the changes thoroughly and submit your review using the submit_review tool. The repository is already set up — start by reading AGENTS.md and any files you need context on (batch your read_file calls in parallel).",
  );

  return parts.join("\n");
}
