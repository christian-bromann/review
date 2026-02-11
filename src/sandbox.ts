import { Client } from "@deno/sandbox";
import { DenoSandbox } from "@langchain/deno";
import { spinner, log } from "@clack/prompts";
import type { PRData } from "./types.ts";

/** Snapshot slug — must match scripts/update-volume.ts */
export const SNAPSHOT_SLUG = "langchainjs-dev-snapshot";
/** Path where the repo lives inside the snapshot's root filesystem */
export const VOLUME_MOUNT = "/data/repo";
/** pnpm store path — lives on the volume but outside the repo so it doesn't
 *  interfere with git status / git clean inside /data/repo. */
export const PNPM_STORE = "/data/pnpm-store";
const VOLUME_REGION = "ord" as const;

/**
 * Workspace packages excluded from dependency installation.
 * These are heavy / rarely-needed packages (e.g. @langchain/community pulls in
 * TensorFlow). Must stay in sync with scripts/update-volume.ts so the snapshot
 * store matches what setupSandbox installs.
 */
export const INSTALL_EXCLUDE_FILTERS = [
  "!@langchain/community",
  "!create-langchain-integration",
  "!examples",
  "!@langchain/classic",
];

export async function createSandbox() {
  const s = spinner({ indicator: "timer" });
  s.start("Creating writable volume from snapshot...");

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

  s.message("Booting sandbox from writable volume...");

  // Boot the sandbox from the writable volume (not the snapshot).
  const sandbox = await DenoSandbox.create({
    region: VOLUME_REGION,
    memory: "4GiB",
    timeout: "15m",
    root: volume.slug,
  });

  s.stop(`Sandbox ready (id: ${sandbox.id})`);

  return {
    sandbox,
    close: async () => {
      await sandbox.close();
      // Clean up the temporary volume after the sandbox is destroyed
      try {
        await client.volumes.delete(volumeSlug);
        log.info(`Temporary volume "${volumeSlug}" deleted`);
      } catch {
        // Best-effort cleanup — don't fail the whole run
        log.warn(`Could not delete temporary volume "${volumeSlug}"`);
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

  const s = spinner({ indicator: "timer" });
  s.start("Setting up sandbox (git checkout + dependency install)...");

  /**
   * Step 1: Add fork remote if needed
   */
  if (isFork) {
    s.message(`Adding fork remote: ${headRemote} → ${headCloneUrl}`);
    const addRemote = await sandbox.execute(
      `cd ${repoDir} && (git remote add ${headRemote} ${headCloneUrl} 2>/dev/null || git remote set-url ${headRemote} ${headCloneUrl})`
    );
    if (addRemote.exitCode !== 0) {
      s.error("Failed to add fork remote");
      throw new Error(`Failed to add fork remote: ${addRemote.output}`);
    }
  }

  /**
   * Step 2: Fetch head and base branches in parallel using shell background jobs
   */
  s.message(`Fetching branches: ${pr.head.ref}, ${pr.base.ref}`);
  const fetchCmd = `cd ${repoDir} && git fetch ${headRemote} ${pr.head.ref}:refs/remotes/${headRemote}/${pr.head.ref} --depth 200 & git fetch origin ${pr.base.ref}:refs/remotes/origin/${pr.base.ref} --depth 200 & wait`;
  const fetchResult = await sandbox.execute(fetchCmd);
  if (fetchResult.exitCode !== 0) {
    s.error("Failed to fetch branches");
    throw new Error(`Failed to fetch branches: ${fetchResult.output}`);
  }

  /**
   * Step 3: Checkout the PR branch
   */
  s.message(`Checking out branch: ${pr.head.ref}`);
  const checkoutResult = await sandbox.execute(
    `cd ${repoDir} && git checkout -B ${pr.head.ref} ${headRemote}/${pr.head.ref}`
  );
  if (checkoutResult.exitCode !== 0) {
    s.error("Failed to checkout PR branch");
    throw new Error(`Failed to checkout PR branch: ${checkoutResult.output}`);
  }

  /**
   * Step 4: Install dependencies
   * Use the same workspace filters as update-volume.ts so we only install
   * packages whose dependencies are already cached in the snapshot's pnpm store.
   * This avoids downloading heavy transitive deps (e.g. TensorFlow from
   * @langchain/community) that would OOM the sandbox.
   */
  s.message("Installing dependencies...");
  const filterArgs = INSTALL_EXCLUDE_FILTERS.map((f) => `--filter ${f}`).join(" ");
  const installResult = await sandbox.execute(
    `cd ${repoDir} && NODE_OPTIONS="--max-old-space-size=2560" pnpm install --store-dir ${PNPM_STORE} --prefer-offline ${filterArgs}`
  );
  if (installResult.exitCode !== 0) {
    s.stop("Sandbox ready — dependencies failed (agent can retry)");
    log.warn("Dependency install failed (agent can retry if needed for tests)");
    return { depsInstalled: false };
  }

  s.stop("Sandbox ready — dependencies installed");
  return { depsInstalled: true };
}
