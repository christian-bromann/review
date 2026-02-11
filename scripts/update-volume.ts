#!/usr/bin/env -S deno run -A --env-file
/**
 * update-volume — Prepares a persistent Deno Sandbox volume with the
 * langchainjs repository cloned, dependencies installed, and unit tests
 * verified, then creates a snapshot for concurrent sandbox use.
 *
 * Run once (or periodically) to keep the snapshot up-to-date:
 *
 *   deno task update-volume
 *
 * The review agent boots from the snapshot so it only needs to
 * `git checkout <branch> && pnpm install` — saving minutes per review.
 * Snapshots are read-only and can be mounted by multiple sandboxes at once,
 * unlike volumes which have an exclusive lock.
 */

import { Client, Sandbox } from "@deno/sandbox";

const VOLUME_SLUG = "langchainjs-dev";
const SNAPSHOT_SLUG = "langchainjs-dev-snapshot";
const VOLUME_REGION = "ord";
const VOLUME_CAPACITY = "10GB";
const REPO_URL = "https://github.com/langchain-ai/langchainjs.git";
const MOUNT_PATH = "/data/repo";

// ANSI helpers
const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  red: "\x1b[31m",
};

function step(emoji: string, text: string) {
  console.log(`${c.bold}${emoji}  ${text}${c.reset}`);
}

function info(text: string) {
  console.log(`${c.dim}   ${text}${c.reset}`);
}

async function run(sandbox: Sandbox, description: string, command: string, { verbose = false } = {}) {
  step("⚙️", description);
  // SDK stdout piping is unreliable — redirect to files and read back.
  await sandbox.fs.writeTextFile("/tmp/_cmd.sh", command);
  const { status } = await sandbox.sh`bash /tmp/_cmd.sh >/tmp/_out 2>/tmp/_err`.noThrow();
  const stdout = await sandbox.fs.readTextFile("/tmp/_out").catch(() => "");
  const stderr = await sandbox.fs.readTextFile("/tmp/_err").catch(() => "");

  const stdoutLines = stdout.trimEnd().split("\n");
  if (stdout.trim()) {
    if (verbose) {
      // Print everything
      for (const line of stdoutLines) {
        info(line);
      }
    } else if (status.success) {
      // On success, show first 20 lines
      for (const line of stdoutLines.slice(0, 20)) {
        info(line);
      }
      if (stdoutLines.length > 20) {
        info(`... (${stdoutLines.length - 20} more lines)`);
      }
    } else {
      // On failure, show first 10 + last 30 lines to capture the error
      for (const line of stdoutLines.slice(0, 10)) {
        info(line);
      }
      if (stdoutLines.length > 40) {
        info(`... (${stdoutLines.length - 40} more lines)`);
      }
      if (stdoutLines.length > 10) {
        for (const line of stdoutLines.slice(-30)) {
          info(line);
        }
      }
    }
  }
  if (!status.success) {
    console.error(`${c.red}   Command failed (exit ${status.code})${c.reset}`);
    if (stderr.trim()) {
      const stderrLines = stderr.trimEnd().split("\n");
      const lines = verbose ? stderrLines : stderrLines.slice(-30);
      for (const line of lines) {
        console.error(`${c.red}   ${line}${c.reset}`);
      }
    }
    throw new Error(`Command failed: ${description}`);
  }
  return stdout;
}

async function main() {
  const client = new Client();

  // -----------------------------------------------------------------------
  // 1. Create or retrieve the persistent volume
  // -----------------------------------------------------------------------

  step("📦", "Checking for existing volume...");
  let volume = await client.volumes.get(VOLUME_SLUG);

  if (volume && !volume.isBootable) {
    step("⚠️", "Volume exists but is not bootable — deleting and recreating...");
    await client.volumes.delete(VOLUME_SLUG);
    volume = null;
  }

  if (!volume) {
    step("📦", `Creating bootable volume "${VOLUME_SLUG}" (${VOLUME_CAPACITY}) in ${VOLUME_REGION}...`);
    volume = await client.volumes.create({
      slug: VOLUME_SLUG,
      region: VOLUME_REGION,
      capacity: VOLUME_CAPACITY,
      from: "builtin:debian-13",
    });
    info(`Created bootable volume ${volume.slug} (${volume.capacity} bytes)`);
  } else {
    info(
      `Volume "${volume.slug}" exists (bootable) — ` +
      `${volume.estimatedFlattenedSize} / ${volume.capacity} bytes used`
    );
  }

  // -----------------------------------------------------------------------
  // 2. Kill any stale sandboxes that may still hold the volume
  // -----------------------------------------------------------------------

  step("🧹", "Cleaning up stale sandboxes...");
  let cleaned = 0;
  const staleSandboxes = await client.sandboxes.list({ labels: { job: "update-volume" } });
  for (const meta of staleSandboxes) {
    try {
      const stale = await Sandbox.connect(meta.id);
      await stale.kill();
      cleaned++;
    } catch {
      // Already gone — ignore
    }
  }
  if (cleaned > 0) {
    info(`Killed ${cleaned} stale sandbox(es)`);
  } else {
    info("No stale sandboxes found");
  }

  // -----------------------------------------------------------------------
  // 3. Spin up a sandbox with the volume mounted
  // -----------------------------------------------------------------------

  step("🚀", "Creating sandbox with bootable volume as root...");

  const sandbox = await Sandbox.create({
    region: VOLUME_REGION as "ord" | "ams",
    memory: "4GiB",
    timeout: "15m",
    root: volume.slug,
    labels: { job: "update-volume" },
  });

  info(`Sandbox ready (id: ${sandbox.id})`);

  // -----------------------------------------------------------------------
  // 4. Clone or update the repository
  // -----------------------------------------------------------------------

  // The bootable Debian image runs as a non-root user, so we need sudo to
  // create directories outside the home folder.
  await run(
    sandbox,
    "Ensuring repo directory exists with correct permissions...",
    `sudo mkdir -p ${MOUNT_PATH} && sudo chown "$(whoami):$(id -gn)" ${MOUNT_PATH}`
  );

  const repoState = (
    await run(sandbox, "Checking repo state...", `test -d ${MOUNT_PATH}/.git && echo exists || echo fresh`)
  ).trim();

  if (repoState === "fresh") {
    await run(
      sandbox,
      `Cloning ${REPO_URL} into ${MOUNT_PATH}...`,
      `git clone --depth 30 ${REPO_URL} ${MOUNT_PATH}`
    );
  } else {
    step("🔄", "Repository already present — pulling latest changes...");
    await run(
      sandbox,
      "Fetching latest from origin...",
      `cd ${MOUNT_PATH} && git fetch origin && git reset --hard origin/main`
    );
  }

  // -----------------------------------------------------------------------
  // 5. Install pnpm and dependencies
  // -----------------------------------------------------------------------

  await run(
    sandbox,
    "Installing pnpm globally...",
    `npm install -g --force pnpm`
  );

  // The pnpm content-addressable store lives alongside the repo so it gets
  // baked into the snapshot.  Without --store-dir the store may land elsewhere
  // and only tiny symlinks end up in the repo directory.
  const PNPM_STORE = `${MOUNT_PATH}/.pnpm-store`;
  const FILTERS = ['!@langchain/community', '!create-langchain-integration', '!examples', '!@langchain/classic'];
  const FILTER_STRING = FILTERS.join(' --filter ');

  await run(
    sandbox,
    "Installing dependencies with pnpm...",
    `cd ${MOUNT_PATH} && pnpm install --store-dir ${PNPM_STORE} --frozen-lockfile --filter ${FILTER_STRING} --network-concurrency=5 || pnpm install --store-dir ${PNPM_STORE} --filter ${FILTER_STRING} --network-concurrency=5`
  );

  // -----------------------------------------------------------------------
  // 6. Build the project so TypeScript declarations are available
  // -----------------------------------------------------------------------

  step("🔨", "Building the project...");
  await run(
    sandbox,
    "Building workspace packages...",
    `cd ${MOUNT_PATH} && pnpm --filter ${FILTER_STRING} build`,
    { verbose: true }
  );
  step("✅", "Build succeeded!");

  // -----------------------------------------------------------------------
  // 6b. Ensure the build left the git tree clean
  // -----------------------------------------------------------------------
  // Some builds mutate package.json files (e.g. version fields, exports maps).
  // A dirty tree means `git checkout <branch>` will fail later in the review
  // agent, so we catch it here early.

  step("🔍", "Checking git tree is clean after build...");
  const dirtyFiles = (
    await run(
      sandbox,
      "Checking for uncommitted changes...",
      `cd ${MOUNT_PATH} && git status --porcelain`
    )
  ).trim();

  if (dirtyFiles) {
    // Show exactly what changed so the developer can fix the root cause.
    step("⚠️", "Build left the following dirty files:");
    for (const line of dirtyFiles.split("\n")) {
      info(line);
    }

    await run(
      sandbox,
      "Showing diff of dirty files...",
      `cd ${MOUNT_PATH} && git diff`,
      { verbose: true }
    );

    // Reset so the snapshot is usable regardless.
    step("🧹", "Resetting dirty files to restore clean git state...");
    await run(
      sandbox,
      "Resetting working tree...",
      `cd ${MOUNT_PATH} && git checkout -- . && git clean -fd`
    );

    // Verify the reset worked
    const stillDirty = (
      await run(
        sandbox,
        "Verifying clean state...",
        `cd ${MOUNT_PATH} && git status --porcelain`
      )
    ).trim();

    if (stillDirty) {
      throw new Error(
        "Failed to restore clean git state after build. " +
        "The snapshot would have dirty files that block PR checkouts.\n" +
        `Still dirty:\n${stillDirty}`
      );
    }

    step("✅", "Git tree restored to clean state.");
  } else {
    step("✅", "Git tree is clean after build.");
  }

  // -----------------------------------------------------------------------
  // 7. Run unit tests to verify the environment
  // -----------------------------------------------------------------------

  step("🧪", "Running unit tests to verify the environment...");
  try {
    await run(
      sandbox,
      "Running tests...",
      `cd ${MOUNT_PATH} && pnpm --filter langchain test`
    );
    step("✅", "All tests passed — environment is ready!");
  } catch {
    step("⚠️", "Some tests failed — but the volume is still usable for reviews.");
    info("You may want to investigate test failures separately.");
  }

  // -----------------------------------------------------------------------
  // 7. Check on-disk usage, shut down, and report volume stats
  // -----------------------------------------------------------------------

  // `du` inside the sandbox is the source of truth for volume size.
  // The API's `estimatedFlattenedSize` can lag by minutes and is unreliable
  // immediately after close.
  const duOutput = await run(
    sandbox,
    "Measuring volume usage (du)...",
    `du -sh ${MOUNT_PATH}`
  );

  step("🧹", "Closing sandbox...");
  await sandbox.kill();
  info("Sandbox terminated — volume data persisted.");

  // Parse the du output (e.g. "3.4G\t/data/repo\n") for the summary line.
  const duSize = duOutput.trim().split(/\s+/)[0] ?? "unknown";

  step(
    "📊",
    `Volume usage: ${duSize} on disk ` +
    `(capacity: ${(volume.capacity / 1024 / 1024 / 1024).toFixed(1)} GB)`
  );

  // -----------------------------------------------------------------------
  // 8. Create a snapshot from the volume for concurrent sandbox use
  // -----------------------------------------------------------------------

  step("📸", "Creating snapshot from volume...");

  // Delete existing snapshot if present (snapshots are immutable — we must
  // recreate to pick up volume changes).
  const existingSnapshot = await client.snapshots.get(SNAPSHOT_SLUG);
  if (existingSnapshot) {
    info(`Deleting existing snapshot "${SNAPSHOT_SLUG}"...`);
    await client.snapshots.delete(SNAPSHOT_SLUG);
  }

  const snapshot = await client.volumes.snapshot(volume.slug, {
    slug: SNAPSHOT_SLUG,
  });
  info(`Snapshot created: ${snapshot.slug} (${snapshot.flattenedSize} bytes)`);

  step("🎉", "Volume + snapshot setup complete! The review agent can now use the snapshot.");
  info(`Volume slug:   ${VOLUME_SLUG}`);
  info(`Snapshot slug: ${SNAPSHOT_SLUG}`);
  info(`Repo path:     ${MOUNT_PATH}`);
}

main().catch((err) => {
  console.error(`${c.red}Fatal error:${c.reset}`, err);
  Deno.exit(1);
});
