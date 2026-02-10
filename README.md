# review

AI-powered PR reviewer that clones a branch into an **isolated sandbox**, reviews the code with an AI agent, and posts the review to GitHub — but **only after you approve it**.

Built with [Deep Agents](https://docs.langchain.com/oss/javascript/deepagents/overview) + [Sandboxes](https://docs.langchain.com/oss/javascript/deepagents/sandboxes) + [Human-in-the-Loop](https://docs.langchain.com/oss/javascript/deepagents/human-in-the-loop).

## How it works

```
npx review langchain-ai/langchainjs#7898
         │
         ▼
  ┌─ Fetch PR details from GitHub API ─┐
  │  (title, body, diff, linked issues) │
  └─────────────────────────────────────┘
         │
         ▼
  ┌─ Create isolated sandbox ──────────┐
  │                                     │
  │  Agent:                             │
  │    git clone --branch pr-branch     │
  │    git diff origin/main...HEAD      │
  │    read_file (explore context)      │
  │    execute (run tests)              │
  │    submit_review ← HITL INTERRUPT   │
  │                                     │
  └─────────────────────────────────────┘
         │
         ▼
  ┌─ You review the proposed comments ──┐
  │                                      │
  │  Verdict: REQUEST CHANGES            │
  │  Summary: The parser has a bug...    │
  │                                      │
  │  1. src/parser.ts:42                 │
  │     Missing null check before...     │
  │                                      │
  │  Post this review? (y/n)             │
  └──────────────────────────────────────┘
         │
         ▼ (if approved)
  ┌─ POST /repos/.../reviews ──────────┐
  │  Review posted to GitHub!           │
  └─────────────────────────────────────┘
```

## Quick start

```bash
# Set environment variables
export ANTHROPIC_API_KEY="your-key"
export GITHUB_TOKEN="your-github-token"

# For Deno cloud sandbox (default):
export DENO_SUBHOSTING_ACCESS_TOKEN="your-token"
export DENO_SUBHOSTING_DEPLOY_ORG_ID="your-org-id"

# Review a PR
npx review langchain-ai/langchainjs#7898
```

## Usage

```bash
# Shorthand format
npx review owner/repo#number

# Full GitHub URL
npx review https://github.com/owner/repo/pull/123

# With branch override
npx review owner/repo#123 --branch fix/parser

# Local sandbox (no cloud required)
SANDBOX_PROVIDER=local npx review owner/repo#123
```

### Development

```bash
# Clone this repo
bun install

# Run directly with Bun
bun run src/index.ts langchain-ai/langchainjs#7898

# Build for npm publishing
bun run build
```

## What the agent does

1. **Clones** the repo into the sandbox (`git clone --depth 30 --branch <pr-branch>`)
2. **Reads** the PR diff (`git diff origin/base...HEAD`)
3. **Explores** the codebase for context (`read_file`, `ls`, `grep`)
4. **Runs tests** if available (`execute`)
5. **Submits a review** via the `submit_review` tool — HITL interrupts here
6. **You review** the proposed comments in your terminal
7. **If approved**, the review is posted to GitHub as a real PR review with line comments

## Human-in-the-Loop

The agent **cannot** post to GitHub without your explicit approval. This uses the [Deep Agents HITL](https://docs.langchain.com/oss/javascript/deepagents/human-in-the-loop) pattern:

1. The `submit_review` tool is configured with `interruptOn: { submit_review: true }`
2. When the agent calls it, execution pauses
3. The proposed review is displayed in your terminal
4. You type `y` to approve or `n` to cancel
5. Only on approval does the tool execute and post to GitHub

This means the agent does all the analysis work, but a human always has the final say.

## Example output

```
──────────────────────────────────────────────────────────────
  review — AI-powered PR reviewer
──────────────────────────────────────────────────────────────

🌐  Fetching PR #7898 from langchain-ai/langchainjs...
   Title: Fix output parser edge case
   Author: @contributor
   Branch: fix/parser → main
   Changes: 3 files, +25 / -8

📄  Fetching changed files...
   ~ src/parsers/output.ts
   + src/parsers/__tests__/output.test.ts
   ~ package.json

📦  Creating Deno cloud sandbox...
🤖  Agent is reviewing the PR inside the sandbox...

  🔧 execute({"command":"git clone --depth 30 --branch fix/parser ..."})
  ↳ Cloning into '/workspace'...
  🔧 execute({"command":"cd /workspace && git diff origin/main...HEAD"})
  🔧 read_file({"path":"/workspace/src/parsers/output.ts"})
  🔧 execute({"command":"cd /workspace && npm test"})
  ↳ Tests: 42 passed, 0 failed

  📝 submit_review (interrupted — waiting for your approval)

──────────────────────────────────────────────────────────────
  PROPOSED REVIEW
──────────────────────────────────────────────────────────────

  Verdict:  APPROVE

  Summary:
  Clean fix for the output parser edge case. The null check
  prevents crashes when the model returns an empty response.
  Tests cover the new behavior well.

  Line comments (2):

  1. src/parsers/output.ts:42
     Good fix! Consider also handling the case where `input`
     is an empty string (not just null/undefined).

  2. src/parsers/output.ts:58
     Nit: this could be simplified:
     ```suggestion
     return input?.trim() ?? "";
     ```

  Post this review to GitHub? (y)es / (n)o: y

📤  Posting review to GitHub...
  ✓ Review posted successfully! View at: https://github.com/...

──────────────────────────────────────────────────────────────
  DONE
──────────────────────────────────────────────────────────────

✅  Review posted for: Fix output parser edge case
🔗  https://github.com/langchain-ai/langchainjs/pull/7898
🧹  Closing sandbox...
```

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key for the LLM |
| `GITHUB_TOKEN` | Yes | GitHub token for API access and posting reviews |
| `SANDBOX_PROVIDER` | No | `"deno"` (default) or `"local"` |
| `DENO_SUBHOSTING_ACCESS_TOKEN` | For Deno | Deno Deploy access token |
| `DENO_SUBHOSTING_DEPLOY_ORG_ID` | For Deno | Deno Deploy org ID |

## Sandbox providers

| Provider | Isolation | Speed | Requirements |
|----------|-----------|-------|-------------|
| **Deno** (default) | Cloud microVM | Fast cold start | Deno Deploy token |
| **Node VFS** (local) | In-memory VFS | Instant | None |
| [Modal](https://docs.langchain.com/oss/javascript/integrations/providers/modal) | Cloud container | GPU support | Modal setup |
| [Daytona](https://docs.langchain.com/oss/javascript/integrations/providers/daytona) | Cloud sandbox | Full dev env | Daytona key |

## Project structure

```
src/
├── index.ts          # CLI entry point & main orchestration
├── cli.ts            # Argument parsing (owner/repo#number or full URL)
├── github.ts         # GitHub API (fetch PR, post review)
├── sandbox.ts        # Sandbox creation (Deno / Node VFS)
├── agent.ts          # Agent setup, streaming, HITL approval flow
├── display.ts        # ANSI colors, terminal formatting, review display
└── types.ts          # Shared interfaces (PRData, Review, etc.)
```

## Key concepts demonstrated

- **`createDeepAgent`** with sandbox backend — agent gets `execute`, `read_file`, `edit_file`, `ls`, `glob`, `grep`
- **Custom tools** — `submit_review` is a user-defined tool with a zod schema
- **Human-in-the-Loop** — `interruptOn` pauses the agent before posting; resumes on approval via `Command`
- **`MemorySaver`** — checkpointer required for HITL state persistence
- **GitHub API** — fetch PR details, post structured reviews with line comments

## License

MIT
