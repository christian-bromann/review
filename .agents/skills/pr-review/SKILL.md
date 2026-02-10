---
name: pr-review
description: Best practices for reviewing pull requests. Guides the agent through structured code review with severity levels, suggestion format, and focus areas. Use when reviewing PRs or code changes.
---

# PR Review Best Practices

## Review approach

1. **Read the PR description and linked issues first** — understand the intent
2. **Examine the full diff** via `git diff origin/<base>...HEAD`
3. **Read surrounding code** for context — don't review the diff in isolation
4. **Check tests** — new functionality should have test coverage
5. **Collect all comments**, then submit once — never post partial reviews

## What to look for

| Category | Examples |
| -------- | -------- |
| **Correctness** | Logic errors, off-by-one, wrong operator, missing null checks |
| **Security** | Injection, hardcoded secrets, unsafe deserialization, path traversal |
| **Performance** | O(n²) in hot paths, unnecessary allocations, missing indexes |
| **Error handling** | Swallowed exceptions, missing try/catch, unclear error messages |
| **Edge cases** | Empty arrays, undefined, NaN, concurrent access, large inputs |
| **API design** | Breaking changes, unclear naming, missing validation |
| **Tests** | Missing coverage, brittle assertions, tests that don't test anything |

## Severity levels

Use these prefixes consistently:

- **🔴 Critical** — Must fix. Bugs, security issues, data loss risk.
- **🟡 Suggestion** — Should consider. Improvements, better patterns, clearer naming.
- **🟢 Nit** — Optional. Style, minor readability, personal preference.

Start the comment body with the severity emoji so the reviewer can triage quickly.

## Code suggestions

When proposing a concrete fix, use GitHub's suggestion syntax so the author can apply it with one click:

````markdown
```suggestion
replacement code here (full lines, not a partial snippet)
```
````

Rules for suggestions:

- Include **complete replacement lines** (GitHub replaces the entire line range)
- Keep the same indentation as the original
- Only suggest on lines that appear in the diff (added or modified)
- One suggestion per comment — don't combine multiple fixes

## Line numbers

- Line numbers MUST refer to the **new version** of the file (right side of the diff)
- Only comment on lines that are **part of the diff** (added or modified lines)
- If you need to reference unchanged code for context, mention the file and function name instead of a line number

## Tone & wording

- **Start with a thank-you** — e.g. "Thanks for the contribution!" or "Thanks for tackling this!" to acknowledge the author's effort
- **Don't state the obvious** — never re-explain what the code does or how the fix works. The author already knows; the diff speaks for itself
- **Keep approvals short** — if the PR looks good, a concise "LGTM 👍" with a brief thank-you is perfectly fine. No need for a full analysis, summary, or "Code Quality" section
- **Skip code quality commentary** unless there are **severe** issues not caught by automated tooling (prettier, eslint, CI). Don't comment on formatting, naming style, or minor preferences
- **Don't duplicate information** — if you approve, don't include a "Summary", "Analysis", "Verification", or "Risk Assessment" section. Those repeat what the diff already shows
- Be **constructive** — when you do leave feedback, suggest solutions, not just problems
- Phrase as questions when unsure: "Could this race if called concurrently?"
- Avoid subjective style debates unless they hurt readability
- Assume good intent — the author may have context you don't

## Follow-up reviews

When the PR already has prior reviews (including your own):

- **Read the conversation history** — check existing reviews and comments before writing yours
- If you previously requested changes and the author addressed them, **acknowledge that** and approve (or note remaining items) — don't write a fresh review from scratch
- **Follow the conversation naturally** — reference earlier feedback, e.g. "The issue I flagged earlier around X looks good now"
- Don't repeat feedback that was already addressed

## CI checks

Before submitting your review:

1. **Check CI status** — look at the check runs / status checks provided in the PR context
2. If checks are **failing**, investigate the failure logs and mention it in your review with guidance on how to fix
3. If checks are **passing**, no need to mention them

## Changesets

For monorepos or projects that use changesets:

1. **Verify a changeset was committed** — look for files in `.changeset/` in the diff
2. If a changeset is **missing** and the PR introduces user-facing changes, mention it in your review and guide the author:
   - "Looks like this PR is missing a changeset. You can add one by running `npx changeset` and committing the generated file."
3. If the PR is purely internal (CI, tests, docs), a changeset may not be required — use your judgment

## Monorepos

- Focus only on the packages changed in the diff
- Don't try to install dependencies or build the entire project

## Review verdicts

| Verdict | When to use |
| ------- | ----------- |
| `approve` | No critical issues. Suggestions are optional. |
| `comment` | Feedback only — no blocking opinion. Use for first-pass reviews or when you lack context. |
| `request_changes` | Critical issues that must be addressed before merge. |

When in doubt, prefer `comment` over `request_changes`.
