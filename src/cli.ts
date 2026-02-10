import { c } from "./display.ts";
import type { CliArgs } from "./types.ts";

export function parseArgs(): CliArgs {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(`
${c.bold}review${c.reset} — AI-powered PR reviewer with sandboxed code analysis

${c.bold}Usage:${c.reset}
  npx review <owner/repo#number>
  npx review <github-pr-url>
  npx review <owner/repo#number> --branch <branch>

${c.bold}Examples:${c.reset}
  npx review langchain-ai/langchainjs#7898
  npx review https://github.com/langchain-ai/langchainjs/pull/7898
  npx review langchain-ai/langchainjs#7898 --branch fix/parser

${c.bold}Environment variables:${c.reset}
  ANTHROPIC_API_KEY                Required. LLM provider key.
  GITHUB_TOKEN                     Required. For fetching PR data and posting reviews.
  SANDBOX_PROVIDER                 Optional. "deno" (default) or "local" (Node VFS).
  DENO_SUBHOSTING_ACCESS_TOKEN     Required for Deno sandbox.
  DENO_SUBHOSTING_DEPLOY_ORG_ID   Required for Deno sandbox.
`);
    process.exit(0);
  }

  const input = args[0]!;

  // Try full URL: https://github.com/{owner}/{repo}/pull/{number}
  let match = input.match(
    /github\.com\/([^/]+)\/([^/]+)\/(?:pull|issues)\/(\d+)/
  );

  // Try shorthand: owner/repo#number
  if (!match) {
    match = input.match(/^([^/]+)\/([^#]+)#(\d+)$/);
  }

  if (!match) {
    console.error(
      `${c.red}Error: Could not parse PR reference.${c.reset}\n` +
        `Expected: owner/repo#number or https://github.com/owner/repo/pull/number`
    );
    process.exit(1);
  }

  const [, owner, repo, num] = match;

  // Parse optional --branch flag
  let branch: string | undefined;
  const branchIdx = args.indexOf("--branch");
  if (branchIdx !== -1 && args[branchIdx + 1]) {
    branch = args[branchIdx + 1]!;
  }

  return { owner: owner!, repo: repo!, prNumber: parseInt(num!, 10), branch };
}
