import { createDeepAgent, type BaseSandbox } from "deepagents";
import { ChatAnthropic } from "@langchain/anthropic";
import { MemorySaver } from "@langchain/langgraph";
import { tool } from "@langchain/core/tools";
import { AIMessage } from "@langchain/core/messages";
import { z } from "zod";

import { log, spinner } from "@clack/prompts";
import pc from "picocolors";

import type { PRData, PRFile, Review, ReviewContext, LinkedIssue } from "./types.ts";
import { postReviewToGitHub } from "./github.ts";
import { displayReview, confirmAction } from "./display.ts";
import { buildSystemPrompt, buildUserMessage } from "./message.ts";

export async function runReview(
  sandbox: BaseSandbox,
  pr: PRData,
  files: PRFile[],
  linkedIssues: LinkedIssue[],
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

  const agent = createDeepAgent({
    model,
    backend: sandbox,
    tools: [submitReviewTool],
    skills: [
      "./.agents/skills/pr-review/SKILL.md",
    ],
    interruptOn: { submit_review: true },
    checkpointer,
    systemPrompt: buildSystemPrompt(pr, { depsInstalled: context.depsInstalled }),
  });

  const userMessage = buildUserMessage(pr, files, linkedIssues, context);

  // -----------------------------------------------------------------------
  // Phase 1: Stream agent work until HITL interrupt on submit_review
  // -----------------------------------------------------------------------

  log.info("Agent is reviewing the PR inside the sandbox...");

  let pendingReview: Review | null = null;

  // Track seen message IDs to deduplicate replayed messages from the
  // langgraph checkpointer. Without this, every agent step replays ALL
  // previous tool calls in the stream output.
  const seenMessageIds = new Set<string>();

  const stream = await agent.stream(
    { messages: [{ role: "user", content: userMessage }] },
    { ...config, streamMode: "updates" }
  );

  for await (const chunk of stream) {
    for (const [_nodeName, update] of Object.entries(chunk)) {
      if (!update?.messages) continue;

      for (const msg of update.messages) {
        // Skip messages we've already displayed (replayed from checkpoint)
        const msgId = (msg as { id?: string }).id;
        if (msgId) {
          if (seenMessageIds.has(msgId)) continue;
          seenMessageIds.add(msgId);
        }

        if (AIMessage.isInstance(msg) && msg.tool_calls?.length) {
          for (const tc of msg.tool_calls) {
            if (tc.name === "submit_review") {
              pendingReview = tc.args as Review;
              log.warn(
                `${pc.yellow("📝 submit_review")} ${pc.dim("— interrupted, waiting for your approval")}`
              );
            } else {
              // Skip noisy internal tools from the display
              if (tc.name === "write_todos") continue;

              const args =
                typeof tc.args === "string"
                  ? tc.args
                  : JSON.stringify(tc.args);
              const display =
                args.length > 150 ? args.slice(0, 150) + "…" : args;
              log.message(
                `${pc.yellow(`🔧 ${tc.name}`)}${pc.dim(`(${display})`)}`
              );
            }
          }
        }

        if (msg.constructor?.name === "ToolMessage" || msg.type === "tool") {
          // Skip tool results for write_todos (noisy internal bookkeeping)
          const toolName = (msg as { name?: string }).name;
          if (toolName === "write_todos") continue;

          const content =
            typeof msg.content === "string"
              ? msg.content
              : JSON.stringify(msg.content);
          const lines = content.split("\n");
          const preview =
            lines.length > 6
              ? lines.slice(0, 6).join("\n") +
                `\n... (${lines.length - 6} more lines)`
              : content;
          log.message(pc.dim(`↳ ${preview}`));
        }

        if (
          (msg.constructor?.name === "AIMessage" || msg.type === "ai") &&
          typeof msg.content === "string" &&
          msg.content.length > 0 &&
          !(AIMessage.isInstance(msg) && msg.tool_calls?.length)
        ) {
          const lines = msg.content.split("\n").slice(0, 3);
          for (const line of lines) {
            log.message(pc.blue(`💬 ${line}`));
          }
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // Phase 2: HITL — display review and ask for approval
  // -----------------------------------------------------------------------

  if (!pendingReview) {
    log.warn("Agent finished without submitting a review.");
    return null;
  }

  displayReview(pendingReview);

  const approved = await confirmAction("Post this review to GitHub?");

  if (approved) {
    const postSpinner = spinner({ indicator: "timer" });
    postSpinner.start("Posting review to GitHub...");

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
      postSpinner.stop("Review posted successfully!");
      log.info(pc.cyan(result.html_url));
    } catch (err) {
      postSpinner.error("Failed to post review");
      log.error(err instanceof Error ? err.message : String(err));
      return null;
    }

    return pendingReview;
  } else {
    log.info("Review cancelled. Nothing was posted to GitHub.");
    return null;
  }
}
