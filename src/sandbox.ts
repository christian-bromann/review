import { Client } from "@deno/sandbox";
import { DenoSandbox } from "@langchain/deno";
import type { PRData } from "./types.ts";
import { step, info } from "./display.ts";

/** Snapshot slug — must match scripts/update-volume.ts */
export const SNAPSHOT_SLUG = "langchainjs-dev-snapshot";
/** Path where the repo lives inside the snapshot's root filesystem */
export const VOLUME_MOUNT = "/data/repo";
/** pnpm store path inside the snapshot */
export const PNPM_STORE = `${VOLUME_MOUNT}/.pnpm-store`;
const VOLUME_REGION = "ord" as const;

export async function createSandbox() {
  step("📦", "Creating writable volume from snapshot...");

  // Fork the read-only snapshot into a writable temporary volume.
  // Volumes created from snapshots are copy-on-write, so this is fast and
  // only consumes space for data that changes (git checkout, pnpm install).
  const client = new Client();
  const volumeSlug = `review-tmp-${Date.now()}`;
  const volume = await client.volumes.create({
    slug: volumeSlug,
    region: VOLUME_REGION,
    capacity: "10GB",
    from: SNAPSHOT_SLUG,
  });
  info(`Writable volume created: ${volume.slug}`);

  // Boot the sandbox from the writable volume (not the snapshot).
  step("📦", "Booting sandbox from writable volume...");
  const sandbox = await DenoSandbox.create({
    region: VOLUME_REGION,
    memory: "4GiB",
    timeout: "15m",
    root: volume.slug,
  });

  info(`Sandbox created (id: ${sandbox.id})`);
  info("Sandbox ready (Deno — isolated cloud microVM with writable root)");

  return {
    sandbox,
    close: async () => {
      await sandbox.close();
      // Clean up the temporary volume after the sandbox is destroyed
      try {
        await client.volumes.delete(volumeSlug);
        info(`Temporary volume "${volumeSlug}" deleted`);
      } catch {
        // Best-effort cleanup — don't fail the whole run
        info(`⚠️  Could not delete temporary volume "${volumeSlug}"`);
      }
    },
  };
}

/**
 * Pre-run deterministic setup commands on the sandbox before the agent starts.
 * This saves ~5 agent turns that would otherwise be spent on git fetch/checkout
 * and dependency installation.
 *
 * @returns Whether dependency installation succeeded.
 */
export async function setupSandbox(
  sandbox: DenoSandbox,
  pr: PRData
): Promise<{ depsInstalled: boolean }> {
  const repoDir = VOLUME_MOUNT;
  const isFork = pr.head.repo.full_name !== pr.base.repo.full_name;
  const headRemote = isFork ? "pr-fork" : "origin";
  const headCloneUrl = pr.head.repo.clone_url;

  step("⚙️", "Setting up sandbox (git checkout + dependency install)...");

  // Step 1: Add fork remote if needed
  if (isFork) {
    const addRemote = await sandbox.execute(
      `cd ${repoDir} && (git remote add ${headRemote} ${headCloneUrl} 2>/dev/null || git remote set-url ${headRemote} ${headCloneUrl})`
    );
    if (addRemote.exitCode !== 0) {
      throw new Error(`Failed to add fork remote: ${addRemote.output}`);
    }
    info(`Added fork remote: ${headRemote} → ${headCloneUrl}`);
  }

  // Step 2: Fetch head and base branches in parallel using shell background jobs
  // Use ; (not &&) to separate backgrounded commands — `cmd & && next` is a syntax error
  const fetchCmd = `cd ${repoDir} && git fetch ${headRemote} ${pr.head.ref}:refs/remotes/${headRemote}/${pr.head.ref} --depth 200 & git fetch origin ${pr.base.ref}:refs/remotes/origin/${pr.base.ref} --depth 200 & wait`;
  const fetchResult = await sandbox.execute(fetchCmd);
  if (fetchResult.exitCode !== 0) {
    throw new Error(`Failed to fetch branches: ${fetchResult.output}`);
  }
  info(`Fetched branches: ${pr.head.ref}, ${pr.base.ref}`);

  // Step 3: Checkout the PR branch
  const checkoutResult = await sandbox.execute(
    `cd ${repoDir} && git checkout -B ${pr.head.ref} ${headRemote}/${pr.head.ref}`
  );
  if (checkoutResult.exitCode !== 0) {
    throw new Error(`Failed to checkout PR branch: ${checkoutResult.output}`);
  }
  info(`Checked out branch: ${pr.head.ref}`);

  // Step 4: Install dependencies
  const installResult = await sandbox.execute(
    `cd ${repoDir} && pnpm install --store-dir ${PNPM_STORE}`
  );
  if (installResult.exitCode !== 0) {
    info("⚠️  Dependency install failed (agent can retry if needed for tests)");
    return { depsInstalled: false };
  }
  info("Dependencies installed");
  return { depsInstalled: true };
}
