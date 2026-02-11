/**
 * display — App-specific display helpers built on @clack/prompts.
 *
 * All consumers should import clack primitives (`log`, `spinner`, `intro`, …)
 * directly from "@clack/prompts".  This module only provides app-specific
 * helpers that don't belong in individual feature files.
 */

import { log, box, confirm, isCancel, cancel } from "@clack/prompts";
import pc from "picocolors";
import type { Review } from "./types.ts";

/**
 * Pretty-print a proposed PR review using clack box + log primitives.
 */
export function displayReview(review: Review) {
  const verdictLabels: Record<string, string> = {
    approve: pc.green(pc.bold("APPROVE")),
    comment: pc.yellow(pc.bold("COMMENT")),
    request_changes: pc.red(pc.bold("REQUEST CHANGES")),
  };

  const verdictIcons: Record<string, string> = {
    approve: "✅",
    comment: "💬",
    request_changes: "❌",
  };

  const icon = verdictIcons[review.verdict] ?? "";
  const label = verdictLabels[review.verdict] ?? review.verdict;

  // Build box content: verdict + summary
  const content = [
    `${icon}  Verdict: ${label}`,
    "",
    ...review.summary.split("\n").map((l) => pc.dim(l)),
  ].join("\n");

  box(content, "Proposed Review", {
    titleAlign: "center",
    contentAlign: "left",
    rounded: true,
  });

  // Line comments
  if (review.comments.length > 0) {
    log.step(`Line comments (${review.comments.length})`);
    for (let i = 0; i < review.comments.length; i++) {
      const comment = review.comments[i]!;
      log.info(
        `${pc.cyan(`${i + 1}.`)} ${pc.bold(comment.path)}${pc.dim(`:${comment.line}`)}`
      );
      log.message(pc.dim(comment.body));
    }
  } else {
    log.info(pc.dim("No line-specific comments."));
  }
}

/**
 * Ask the user a yes/no question using clack's styled confirm prompt.
 * Handles Ctrl+C gracefully with `cancel()`.
 */
export async function confirmAction(message: string): Promise<boolean> {
  const result = await confirm({ message });
  if (isCancel(result)) {
    cancel("Operation cancelled.");
    // deno-lint-ignore no-process-global
    process.exit(0);
  }
  return result;
}
