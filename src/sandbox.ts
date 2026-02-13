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
  s.start("Booting sandbox from snapshot...");

  // Boot the sandbox directly from the read-only snapshot.
  // Writes during the session (git checkout, pnpm install) are allowed but
  // ephemeral — they're discarded once the sandbox session ends, which is
  // exactly what we want for throwaway review sessions.
  const sandbox = await DenoSandbox.create({
    region: VOLUME_REGION,
    memory: "4GiB",
    timeout: "15m",
    root: SNAPSHOT_SLUG,
  });

  s.stop(`Sandbox ready (id: ${sandbox.id})`);

  return {
    sandbox,
    close: () => sandbox.close(),
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
