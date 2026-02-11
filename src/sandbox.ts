import { DenoSandbox } from "@langchain/deno";
import { step, info } from "./display.ts";

/** Snapshot slug — must match scripts/update-volume.ts */
export const SNAPSHOT_SLUG = "langchainjs-dev-snapshot";
/** Path where the repo lives inside the snapshot's root filesystem */
export const VOLUME_MOUNT = "/data/repo";
/** pnpm store path inside the snapshot */
export const PNPM_STORE = `${VOLUME_MOUNT}/.pnpm-store`;
const VOLUME_REGION = "ord" as const;

export async function createSandbox() {
  step("📦", "Creating Deno cloud sandbox from snapshot...");

  // Boot from the read-only snapshot. Snapshots can be mounted by multiple
  // sandboxes simultaneously (unlike volumes which have an exclusive lock).
  // Writes inside the sandbox are ephemeral — they vanish when the session
  // ends — but reads pull from the snapshot's pre-built filesystem.
  const sandbox = await DenoSandbox.create({
    region: VOLUME_REGION,
    memory: "4GiB",
    timeout: "15m",
    root: SNAPSHOT_SLUG,
  });

  info(`Sandbox created (id: ${sandbox.id})`);
  info("Sandbox ready (Deno — isolated cloud microVM booted from langchainjs snapshot)");

  return {
    sandbox,
    close: async () => {
      await sandbox.close();
    },
  };
}
