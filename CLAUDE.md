---
description: Use Deno as the runtime for this project.
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, deno.json"
alwaysApply: false
---

Default to using Deno instead of Node.js or Bun.

- Use `deno run -A <file>` instead of `node <file>` or `bun <file>`
- Use `deno test` instead of `jest` or `vitest`
- Use `deno task <name>` instead of `npm run <name>`
- Use `deno install` to install dependencies from deno.json
- Use `deno run -A --env-file <file>` to load .env automatically
- npm packages are mapped in the `imports` field of `deno.json` using `npm:` specifiers

## Testing

Use `deno test` to run tests.

```ts#index.test.ts
import { assertEquals } from "jsr:@std/assert";

Deno.test("hello world", () => {
  assertEquals(1, 1);
});
```
