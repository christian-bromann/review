import { DenoSandbox } from "@langchain/deno";
import { step, info } from "./display.ts";

export async function createSandbox() {
  const provider = process.env.SANDBOX_PROVIDER ?? "deno";

  if (provider === "local") {
    step("📦", "Creating local Node VFS sandbox...");
    const { VfsSandbox } = await import("@langchain/node-vfs");
    const sandbox = await VfsSandbox.create({ timeout: 300_000 });
    info("Sandbox ready (Node VFS — local, no cloud)");
    return { sandbox, close: () => sandbox.stop() };
  }

  step("📦", "Creating Deno cloud sandbox...");
  const sandbox = await DenoSandbox.create({
    memoryMb: 2048,
    lifetime: "15m",
  });
  info("Sandbox ready (Deno — isolated cloud microVM)");
  return { sandbox, close: () => sandbox.close() };
}
