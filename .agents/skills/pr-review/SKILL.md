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

## Tone

- Be **constructive** — suggest solutions, not just problems
- Phrase as questions when unsure: "Could this race if called concurrently?"
- Acknowledge good patterns: "Nice use of X here"
- Avoid subjective style debates unless they hurt readability
- Assume good intent — the author may have context you don't

## Monorepos

- Focus only on the packages changed in the diff
- Don't try to install dependencies or build the entire project
- Check if the changeset / version bump is included when needed

## Review verdicts

| Verdict | When to use |
| ------- | ----------- |
| `approve` | No critical issues. Suggestions are optional. |
| `comment` | Feedback only — no blocking opinion. Use for first-pass reviews or when you lack context. |
| `request_changes` | Critical issues that must be addressed before merge. |

When in doubt, prefer `comment` over `request_changes`.
