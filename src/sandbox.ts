import { DenoSandbox } from "@langchain/deno";
import { step, info } from "./display.ts";

/** Volume slug and mount path — must match scripts/update-volume.ts */
export const VOLUME_SLUG = "langchainjs-dev";
export const VOLUME_MOUNT = "/data/repo";
/** pnpm store on the persistent volume so packages survive sandbox restarts */
export const PNPM_STORE = `${VOLUME_MOUNT}/.pnpm-store`;
const VOLUME_REGION = "ord" as const;

export async function createSandbox() {
  step("📦", "Creating Deno cloud sandbox with volume...");

  // Create the raw Deno sandbox with the persistent volume mounted.
  // This gives us access to the volumes option which @langchain/deno
  // doesn't expose directly.
  const rawSandbox = await DenoSandbox.create({
    region: VOLUME_REGION,
    memory: "2GiB",
    lifetime: "15m",
    volumes: {
      [VOLUME_MOUNT]: VOLUME_SLUG,
    },
  });

  info(`Raw sandbox created (id: ${rawSandbox.id})`);

  // Wrap in DenoSandbox so the agent gets the LangChain-compatible backend
  const sandbox = await DenoSandbox.fromId(rawSandbox.id);

  info("Sandbox ready (Deno — isolated cloud microVM with langchainjs volume)");

  return {
    sandbox,
    close: async () => {
      await sandbox.close();
      await rawSandbox.close();
    },
  };
}
