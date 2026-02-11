import { createDeepAgent, type BaseSandbox } from "deepagents";
import { ChatAnthropic } from "@langchain/anthropic";
import { MemorySaver } from "@langchain/langgraph";
import { tool } from "@langchain/core/tools";
import { AIMessage } from "@langchain/core/messages";
import { z } from "zod";

import type { PRData, PRFile, Review, CheckRun, ExistingReview, ReviewThreadComment } from "./types.ts";
import { postReviewToGitHub } from "./github.ts";
import { c, step, prompt, displayReview } from "./display.ts";
import { VOLUME_MOUNT, PNPM_STORE } from "./sandbox.ts";

interface ReviewContext {
  checkRuns: CheckRun[];
  existingReviews: ExistingReview[];
  reviewComments: ReviewThreadComment[];
  hasChangeset: boolean;
}

export async function runReview(
  sandbox: BaseSandbox,
  pr: PRData,
  files: PRFile[],
  linkedIssues: Array<{ number: number; title: string; body: string }>,
  owner: string,
  repo: string,
  context: ReviewContext
): Promise<Review | null> {
  const model = new ChatAnthropic({
    model: "claude-sonnet-4-20250514",
  });

  // -----------------------------------------------------------------------
  // submit_review tool — HITL-gated; we post to GitHub ourselves after approval
  // -----------------------------------------------------------------------

  const reviewSchema = z.object({
    summary: z
      .string()
      .describe(
        "Overall review summary. Start with a thank-you. For approvals with no line comments, keep it short (e.g. 'Thanks for the contribution! LGTM 👍'). If you have multiple line comments, add one brief sentence summarizing the themes (e.g. 'A few edge-case and error-handling suggestions below.') — but don't rehash each comment individually. NEVER describe what the PR does or how the implementation works — the author already knows. NEVER praise the implementation quality (e.g. 'excellent implementation', 'comprehensive and well-tested', 'well-structured') — that just parrots the PR description. Don't include sections like Summary/Analysis/Verification. Use markdown."
      ),
    verdict: z
      .enum(["comment", "approve", "request_changes"])
      .describe(
        "Review verdict: 'approve' if the code looks good, 'request_changes' for required fixes, 'comment' for general feedback."
      ),
    comments: z
      .array(
        z.object({
          path: z
            .string()
            .describe(
              "File path relative to the repository root (e.g. 'src/utils/parser.ts')"
            ),
          line: z
            .number()
            .describe(
              "Line number in the NEW version of the file where the comment applies. Must be a line that appears in the diff."
            ),
          body: z
            .string()
            .describe(
              "Comment text in markdown. For code suggestions, use GitHub's suggestion syntax. CRITICAL: the replacement code inside the suggestion block MUST preserve the exact leading whitespace (indentation) of the original line in the diff. Look at the diff to see how many spaces/tabs the line uses and replicate them exactly. Example — if the original line is '      await foo();' (6 spaces), the suggestion must also have 6 spaces:\n```suggestion\n      await bar();\n```"
            ),
        })
      )
      .describe("Line-specific review comments. ONLY include comments that contain actionable feedback (bugs, suggestions, questions, requested changes). Do NOT include praise, observations, or commentary that doesn't ask the author to do something or consider something specific. If you have no actionable line comments, return an empty array."),
  });

  // The submit_review tool is HITL-gated — the agent calls it to propose a
  // review, but execution is interrupted so we can show it to the human first.
  // We post to GitHub ourselves after approval (not via the agent resume).
  const submitReviewTool = tool(
    (_args: Review) => {
      return "Review submitted for human approval.";
    },
    {
      name: "submit_review",
      description:
        "Submit your code review for human approval before it is posted to GitHub. A human will review your proposed comments first. Call this once you have completed your review.",
      schema: reviewSchema,
    }
  );

  // -----------------------------------------------------------------------
  // Agent setup
  // -----------------------------------------------------------------------

  const checkpointer = new MemorySaver();
  const threadId = `review-${pr.number}-${Date.now()}`;
  const config = { configurable: { thread_id: threadId } };

  const repoDir = VOLUME_MOUNT;

  // Detect fork PRs — the branch lives on a different remote
  const isFork = pr.head.repo.full_name !== pr.base.repo.full_name;
  const headRemote = isFork ? "pr-fork" : "origin";
  const headCloneUrl = pr.head.repo.clone_url;

  // Build setup commands depending on whether the PR is from a fork
  let setupCommands: string;
  if (isFork) {
    setupCommands = `\`\`\`bash
cd ${repoDir}
git remote add ${headRemote} ${headCloneUrl} || git remote set-url ${headRemote} ${headCloneUrl}
git fetch ${headRemote} ${pr.head.ref}:refs/remotes/${headRemote}/${pr.head.ref} --depth 30
git fetch origin ${pr.base.ref}:refs/remotes/origin/${pr.base.ref} --depth 30
git checkout -B ${pr.head.ref} ${headRemote}/${pr.head.ref}
pnpm install --store-dir ${PNPM_STORE}
\`\`\`

**This PR is from a fork** (\`${pr.head.repo.full_name}\`), so the branch does NOT exist on \`origin\`.
You MUST add the fork as a separate remote (\`${headRemote}\`) and fetch from it. Do NOT try to fetch the branch from \`origin\` — it will fail.`;
  } else {
    setupCommands = `\`\`\`bash
cd ${repoDir}
git fetch origin ${pr.head.ref}:refs/remotes/origin/${pr.head.ref} --depth 30
git fetch origin ${pr.base.ref}:refs/remotes/origin/${pr.base.ref} --depth 30
git checkout -B ${pr.head.ref} origin/${pr.head.ref}
pnpm install --store-dir ${PNPM_STORE}
\`\`\``;
  }

  const agent = createDeepAgent({
    model,
    backend: sandbox,
    tools: [submitReviewTool],
    skills: [
      "./.agents/skills/pr-review/SKILL.md",
      `${repoDir}/AGENTS.md`,
    ],
    interruptOn: { submit_review: true },
    checkpointer,
    systemPrompt: `You are an expert code reviewer working inside an isolated sandbox.
You have been given a pull request to review. Your job is to:

1. Check out the PR branch on the pre-cloned repository
2. Install any new/changed dependencies
3. Understand the changes by reading the diff and relevant source files
4. Check for bugs, logic errors, edge cases, security issues, and style problems
5. Check CI status and changeset presence (details provided in context)
6. Optionally run tests if a test suite exists and it's practical to do so
7. Submit a code review using the submit_review tool

## Setup commands (follow EXACTLY — do NOT deviate)
The repository is already cloned at \`${repoDir}\` on a persistent volume with
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
- Use \`read_file\` to explore the code for context
- Use \`execute\` to run git commands
- When ready, call \`submit_review\` with your complete review
- Do NOT post partial reviews — collect all comments first, then submit once`,
  });

  // -----------------------------------------------------------------------
  // Build user message with full PR context
  // -----------------------------------------------------------------------

  let userMessage = `# Pull Request: ${pr.title}\n\n`;
  userMessage += `**Author:** @${pr.user.login}\n`;
  userMessage += `**Branch:** \`${pr.head.ref}\` → \`${pr.base.ref}\`\n`;
  userMessage += `**Changes:** ${pr.changed_files} files, +${pr.additions} / -${pr.deletions}\n`;
  userMessage += `**URL:** ${pr.html_url}\n\n`;

  if (pr.body) {
    userMessage += `## PR Description\n\n${pr.body}\n\n`;
  }

  if (linkedIssues.length > 0) {
    userMessage += `## Linked Issues\n\n`;
    for (const issue of linkedIssues) {
      userMessage += `### #${issue.number}: ${issue.title}\n\n${issue.body}\n\n---\n\n`;
    }
  }

  userMessage += `## Changed Files\n\n`;
  for (const file of files) {
    userMessage += `### ${file.filename} (${file.status}, +${file.additions}/-${file.deletions})\n\n`;
    if (file.patch) {
      const patch =
        file.patch.length > 3000
          ? file.patch.slice(0, 3000) +
            "\n... (truncated, read full file in sandbox)"
          : file.patch;
      userMessage += `\`\`\`diff\n${patch}\n\`\`\`\n\n`;
    }
  }

  // CI check status
  if (context.checkRuns.length > 0) {
    userMessage += `## CI Check Status\n\n`;
    const failing = context.checkRuns.filter(
      (cr) => cr.conclusion === "failure" || cr.conclusion === "cancelled"
    );
    const passing = context.checkRuns.filter(
      (cr) => cr.conclusion === "success"
    );
    const pending = context.checkRuns.filter(
      (cr) => cr.status !== "completed"
    );

    if (failing.length > 0) {
      userMessage += `**⚠️ Failing checks (${failing.length}):**\n`;
      for (const cr of failing) {
        userMessage += `- ❌ \`${cr.name}\` — ${cr.conclusion} ([logs](${cr.html_url}))\n`;
      }
      userMessage += `\n`;
    }
    if (pending.length > 0) {
      userMessage += `**⏳ Pending checks (${pending.length}):**\n`;
      for (const cr of pending) {
        userMessage += `- ⏳ \`${cr.name}\` — ${cr.status}\n`;
      }
      userMessage += `\n`;
    }
    if (passing.length > 0) {
      userMessage += `**✅ Passing checks: ${passing.length}**\n\n`;
    }
  }

  // Changeset info
  if (!context.hasChangeset) {
    userMessage += `## Changeset\n\n`;
    userMessage += `⚠️ No changeset file was found in this PR. If this PR introduces user-facing changes, a changeset should be added.\n\n`;
  }

  // Existing reviews & conversation history
  if (context.existingReviews.length > 0 || context.reviewComments.length > 0) {
    userMessage += `## Existing Review History\n\n`;
    userMessage += `**This PR has been reviewed before. Read the history below and follow the conversation naturally.**\n\n`;

    for (const review of context.existingReviews) {
      const stateEmoji =
        review.state === "APPROVED"
          ? "✅"
          : review.state === "CHANGES_REQUESTED"
            ? "🔴"
            : "💬";
      userMessage += `### ${stateEmoji} Review by @${review.user} (${review.state}) — ${review.submitted_at}\n\n`;
      if (review.body) {
        userMessage += `${review.body}\n\n`;
      }
    }

    if (context.reviewComments.length > 0) {
      userMessage += `### Inline review comments\n\n`;
      for (const comment of context.reviewComments) {
        userMessage += `- **@${comment.user}** on \`${comment.path}${comment.line ? `:${comment.line}` : ""}\`:\n  ${comment.body}\n\n`;
      }
    }
  }

  userMessage +=
    "\nPlease review the changes thoroughly and submit your review using the submit_review tool. The repository is already cloned — just follow the setup commands from the system prompt exactly.";

  // -----------------------------------------------------------------------
  // Phase 1: Stream agent work until HITL interrupt on submit_review
  // -----------------------------------------------------------------------

  step("🤖", "Agent is reviewing the PR inside the sandbox...\n");

  let pendingReview: Review | null = null;

  const stream = await agent.stream(
    { messages: [{ role: "user", content: userMessage }] },
    { ...config, streamMode: "updates" }
  );

  for await (const chunk of stream) {
    for (const [_nodeName, update] of Object.entries(chunk)) {
      if (!update?.messages) continue;

      for (const msg of update.messages) {
        if (AIMessage.isInstance(msg) && msg.tool_calls?.length) {
          for (const tc of msg.tool_calls) {
            if (tc.name === "submit_review") {
              pendingReview = tc.args as Review;
              console.log(
                `\n${c.yellow}  📝 submit_review${c.reset}${c.dim} (interrupted — waiting for your approval)${c.reset}`
              );
            } else {
              const args =
                typeof tc.args === "string"
                  ? tc.args
                  : JSON.stringify(tc.args);
              const display =
                args.length > 150 ? args.slice(0, 150) + "…" : args;
              console.log(
                `${c.yellow}  🔧 ${tc.name}${c.reset}${c.dim}(${display})${c.reset}`
              );
            }
          }
        }

        if (msg.constructor?.name === "ToolMessage" || msg.type === "tool") {
          const content =
            typeof msg.content === "string"
              ? msg.content
              : JSON.stringify(msg.content);
          const lines = content.split("\n");
          const preview =
            lines.length > 6
              ? lines.slice(0, 6).join("\n") +
                `\n   ... (${lines.length - 6} more lines)`
              : content;
          console.log(`${c.dim}  ↳ ${preview}${c.reset}`);
        }

        if (
          (msg.constructor?.name === "AIMessage" || msg.type === "ai") &&
          typeof msg.content === "string" &&
          msg.content.length > 0 &&
          !(AIMessage.isInstance(msg) && msg.tool_calls?.length)
        ) {
          const lines = msg.content.split("\n").slice(0, 3);
          for (const line of lines) {
            console.log(`${c.blue}  💬 ${line}${c.reset}`);
          }
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // Phase 2: HITL — display review and ask for approval
  // -----------------------------------------------------------------------

  if (!pendingReview) {
    step("⚠️", "Agent finished without submitting a review.");
    return null;
  }

  displayReview(pendingReview);

  const answer = await prompt(
    `${c.bold}  Post this review to GitHub? ${c.reset}${c.dim}(y)es / (n)o: ${c.reset}`
  );

  if (answer === "y" || answer === "yes") {
    step("📤", "Posting review to GitHub...");

    // Post directly — we already have the review data from the interrupted
    // tool call. This is more reliable than resuming the agent which can
    // replay the entire conversation.
    try {
      const result = await postReviewToGitHub(
        owner,
        repo,
        pr.number,
        pr.head.sha,
        pendingReview
      );
      console.log(
        `${c.green}  ✓ Review posted successfully! View at: ${result.html_url}${c.reset}`
      );
    } catch (err) {
      console.error(
        `${c.red}  ✗ Failed to post review: ${err instanceof Error ? err.message : String(err)}${c.reset}`
      );
      return null;
    }

    return pendingReview;
  } else {
    step("🚫", "Review cancelled. Nothing was posted to GitHub.");
    return null;
  }
}
