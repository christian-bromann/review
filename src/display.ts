import { createInterface } from "node:readline";
import type { Review } from "./types.ts";

/** ANSI color helpers for pretty terminal output */
export const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  bgRed: "\x1b[41m",
  bgGreen: "\x1b[42m",
  bgYellow: "\x1b[43m",
};

export function header(text: string) {
  const line = "─".repeat(60);
  console.log(`\n${c.cyan}${line}${c.reset}`);
  console.log(`${c.bold}${c.cyan}  ${text}${c.reset}`);
  console.log(`${c.cyan}${line}${c.reset}\n`);
}

export function step(emoji: string, text: string) {
  console.log(`${c.bold}${emoji}  ${text}${c.reset}`);
}

export function info(text: string) {
  console.log(`${c.dim}   ${text}${c.reset}`);
}

export async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

export function displayReview(review: Review) {
  header("PROPOSED REVIEW");

  const verdictColors: Record<string, string> = {
    approve: `${c.bgGreen}${c.white}${c.bold} APPROVE ${c.reset}`,
    comment: `${c.bgYellow}${c.white}${c.bold} COMMENT ${c.reset}`,
    request_changes: `${c.bgRed}${c.white}${c.bold} REQUEST CHANGES ${c.reset}`,
  };
  console.log(`  Verdict: ${verdictColors[review.verdict] ?? review.verdict}`);
  console.log();

  console.log(`${c.bold}  Summary:${c.reset}`);
  for (const line of review.summary.split("\n")) {
    console.log(`${c.dim}  ${line}${c.reset}`);
  }
  console.log();

  if (review.comments.length > 0) {
    console.log(
      `${c.bold}  Line comments (${review.comments.length}):${c.reset}\n`
    );
    for (let i = 0; i < review.comments.length; i++) {
      const comment = review.comments[i]!;
      console.log(
        `  ${c.cyan}${i + 1}.${c.reset} ${c.bold}${comment.path}${c.reset}${c.dim}:${comment.line}${c.reset}`
      );
      for (const line of comment.body.split("\n")) {
        console.log(`     ${c.dim}${line}${c.reset}`);
      }
      console.log();
    }
  } else {
    console.log(`${c.dim}  No line-specific comments.${c.reset}\n`);
  }
}
