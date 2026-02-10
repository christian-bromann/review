import { createDeepAgent } from "deepagents";
import { ChatAnthropic } from "@langchain/anthropic";
import { MemorySaver, Command } from "@langchain/langgraph";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

import type { PRData, PRFile, Review } from "./types.ts";
import { postReviewToGitHub } from "./github.ts";
import { c, step, prompt, displayReview } from "./display.ts";

export async function runReview(
  sandbox: any,
  pr: PRData,
  files: PRFile[],
  linkedIssues: Array<{ number: number; title: string; body: string }>,
  owner: string,
  repo: string
): Promise<Review | null> {
  const model = new ChatAnthropic({
    model: "claude-sonnet-4-20250514",
  });

  // -----------------------------------------------------------------------
  // submit_review tool — posts to GitHub, gated by HITL
  // -----------------------------------------------------------------------

  const reviewSchema = z.object({
    summary: z
      .string()
      .describe(
        "Overall review summary. Be thorough but concise. Use markdown."
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
              "Comment text in markdown. For code suggestions, use:\n```suggestion\nreplacement code here\n```"
            ),
        })
      )
      .describe("Line-specific review comments on the diff"),
  });

  const submitReviewTool = tool(
    async (args: Review) => {
      try {
        const result = await postReviewToGitHub(
          owner,
          repo,
          pr.number,
          pr.head.sha,
          args
        );
        return `Review posted successfully! View at: ${result.html_url}`;
      } catch (err: any) {
        return `Failed to post review: ${err.message}`;
      }
    },
    {
      name: "submit_review",
      description:
        "Submit your code review to GitHub. A human will review your proposed comments before they are posted. Call this once you have completed your review.",
      schema: reviewSchema,
    }
  );

  // -----------------------------------------------------------------------
  // Agent setup
  // -----------------------------------------------------------------------

  const checkpointer = new MemorySaver();
  const threadId = `review-${pr.number}-${Date.now()}`;
  const config = { configurable: { thread_id: threadId } };

  const cloneUrl = `https://github.com/${owner}/${repo}.git`;

  const agent = createDeepAgent({
    model,
    backend: sandbox,
    tools: [submitReviewTool],
    interruptOn: { submit_review: true },
    checkpointer,
    systemPrompt: `You are an expert code reviewer working inside an isolated sandbox.
You have been given a pull request to review. Your job is to:

1. Clone the repository and check out the PR branch
2. Understand the changes by reading the diff and relevant source files
3. Check for bugs, logic errors, edge cases, security issues, and style problems
4. Run tests if a test suite exists to verify correctness
5. Submit a thorough code review using the submit_review tool

## Setup commands
\`\`\`bash
git clone --depth 30 --branch ${pr.head.ref} --single-branch ${cloneUrl} /workspace
cd /workspace
git fetch origin ${pr.base.ref}:refs/remotes/origin/${pr.base.ref} --depth 30
\`\`\`

## Review guidelines
- Focus on the **diff** between \`origin/${pr.base.ref}\` and \`HEAD\`
- Run \`git diff origin/${pr.base.ref}...HEAD\` to see all changes
- Read full files for context when needed (don't just review the diff in isolation)
- Check that tests exist for new functionality
- Look for: bugs, security issues, performance problems, missing error handling, unclear naming
- Be constructive and specific — suggest fixes, not just problems
- Use \`\`\`suggestion blocks for concrete code fixes
- Line numbers in comments MUST refer to lines in the NEW version of the file
- Only comment on lines that are part of the diff (added or modified lines)

## Important
- Work inside /workspace after cloning
- Use \`edit_file\` and \`read_file\` to explore the code
- Use \`execute\` to run git commands and tests
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

  userMessage +=
    "\nPlease clone the repository, review the changes thoroughly, and submit your review using the submit_review tool.";

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
    for (const [_nodeName, update] of Object.entries(chunk) as [
      string,
      any,
    ][]) {
      if (!update?.messages) continue;

      for (const msg of update.messages) {
        if (msg.tool_calls?.length) {
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
          !msg.tool_calls?.length
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

    const resumeStream = await agent.stream(
      new Command({ resume: { decisions: [{ type: "approve" }] } }),
      { ...config, streamMode: "updates" }
    );

    for await (const chunk of resumeStream) {
      for (const [_nodeName, update] of Object.entries(chunk) as [
        string,
        any,
      ][]) {
        if (!update?.messages) continue;
        for (const msg of update.messages) {
          if (msg.constructor?.name === "ToolMessage" || msg.type === "tool") {
            const content =
              typeof msg.content === "string"
                ? msg.content
                : JSON.stringify(msg.content);
            console.log(`${c.green}  ✓ ${content}${c.reset}`);
          }
        }
      }
    }

    return pendingReview;
  } else {
    step("🚫", "Review cancelled. Nothing was posted to GitHub.");
    return null;
  }
}
