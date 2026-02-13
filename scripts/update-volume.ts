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
import { intro, outro, spinner, log, box, taskLog, cancel } from "@clack/prompts";
import pc from "picocolors";
import { INSTALL_EXCLUDE_FILTERS } from "../src/sandbox.ts";

const VOLUME_SLUG = "langchainjs-dev";
const SNAPSHOT_SLUG = "langchainjs-dev-snapshot";
const VOLUME_REGION = "ord";
const VOLUME_CAPACITY = "10GB";
const REPO_URL = "https://github.com/langchain-ai/langchainjs.git";
const MOUNT_PATH = "/data/repo";

/**
 * Run a shell command inside the sandbox, streaming stdout/stderr live
 * via a clack taskLog (scrolling window of 15 lines).  After completion
 * the last 15 lines are re-printed permanently so they stay visible.
 *
 * Returns the captured stdout on success; throws on failure.
 */
async function run(
  sandbox: Sandbox,
  description: string,
  command: string,
  { verbose = false } = {}
): Promise<string> {
  const TAIL = 15;
  const tl = taskLog({ title: description, limit: verbose ? undefined : TAIL });

  const child = await sandbox.spawn("bash", {
    args: ["-c", command],
    stdout: "piped",
    stderr: "piped",
  });

  const stdoutLines: string[] = [];
  /** Last N non-empty lines for the permanent post-run display. */
  const tailLines: string[] = [];

  /** Read a ReadableStream line-by-line, piping each to the taskLog. */
  async function streamLines(
    stream: ReadableStream<Uint8Array> | null,
    collector: string[] | null,
    style: (s: string) => string
  ) {
    if (!stream) return;
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop()!; // keep incomplete trailing line in buffer
      for (const line of lines) {
        collector?.push(line);
        if (line.trim()) {
          tl.message(style(line));
          tailLines.push(line);
          if (tailLines.length > TAIL) tailLines.shift();
        }
      }
    }
    // Flush whatever remains after the stream closes
    const remaining = buffer + decoder.decode();
    if (remaining.trim()) {
      collector?.push(remaining);
      tl.message(style(remaining));
      tailLines.push(remaining);
      if (tailLines.length > TAIL) tailLines.shift();
    }
  }

  // Read stdout + stderr concurrently
  await Promise.all([
    streamLines(child.stdout, stdoutLines, pc.dim),
    streamLines(child.stderr, null, (s) => pc.dim(pc.red(s))),
  ]);

  const status = await child.status;

  if (!status.success) {
    tl.error(`${description} — failed (exit ${status.code})`);
    throw new Error(`Command failed: ${description}`);
  }

  // taskLog.success() clears the live output, so re-print the tail permanently
  tl.success(description);
  if (tailLines.length > 0) {
    log.message(pc.dim(tailLines.join("\n")));
  }

  return stdoutLines.join("\n");
}

async function main() {
  intro("update-volume");

  const client = new Client();

  // -----------------------------------------------------------------------
  // 1. Create or retrieve the persistent volume
  // -----------------------------------------------------------------------

  log.step("Checking for existing volume...");
  let volume = await client.volumes.get(VOLUME_SLUG);

  if (volume && !volume.isBootable) {
    log.warn("Volume exists but is not bootable — deleting and recreating...");
    await client.volumes.delete(VOLUME_SLUG);
    volume = null;
  }

  if (!volume) {
    const s = spinner({ indicator: "timer" });
    s.start(`Creating bootable volume "${VOLUME_SLUG}" (${VOLUME_CAPACITY}) in ${VOLUME_REGION}...`);
    volume = await client.volumes.create({
      slug: VOLUME_SLUG,
      region: VOLUME_REGION,
      capacity: VOLUME_CAPACITY,
      from: "builtin:debian-13",
    });
    s.stop(`Created bootable volume ${volume.slug} (${volume.capacity} bytes)`);
  } else {
    log.info(
      `Volume "${volume.slug}" exists (bootable) — ` +
      `${volume.estimatedFlattenedSize} / ${volume.capacity} bytes used`
    );
  }

  // -----------------------------------------------------------------------
  // 2. Kill any stale sandboxes that may still hold the volume
  // -----------------------------------------------------------------------

  {
    const tl = taskLog({ title: "Cleaning up stale sandboxes..." });
    let cleaned = 0;
    const staleSandboxes = await client.sandboxes.list({ labels: { job: "update-volume" } });
    for (const meta of staleSandboxes) {
      try {
        tl.message(`Killing sandbox ${meta.id}...`);
        const stale = await Sandbox.connect(meta.id);
        await stale.kill();
        cleaned++;
      } catch {
        // Already gone — ignore
      }
    }
    if (cleaned > 0) {
      tl.success(`Killed ${cleaned} stale sandbox(es)`);
    } else {
      tl.success("No stale sandboxes found");
    }
  }

  // -----------------------------------------------------------------------
  // 3. Spin up a sandbox with the volume mounted
  // -----------------------------------------------------------------------

  const sandboxSpinner = spinner({ indicator: "timer" });
  sandboxSpinner.start("Creating sandbox with bootable volume as root...");

  const sandbox = await Sandbox.create({
    region: VOLUME_REGION as "ord" | "ams",
    memory: "4GiB",
    timeout: "15m",
    root: volume.slug,
    labels: { job: "update-volume" },
  });

  sandboxSpinner.stop(`Sandbox ready (id: ${sandbox.id})`);

  // -----------------------------------------------------------------------
  // 4. Clone or update the repository
  // -----------------------------------------------------------------------

  // The bootable Debian image runs as a non-root user, so we need sudo to
  // create directories outside the home folder.
  await run(
    sandbox,
    "Ensuring repo and store directories exist with correct permissions...",
    `sudo mkdir -p ${MOUNT_PATH} /data/pnpm-store && sudo chown "$(whoami):$(id -gn)" ${MOUNT_PATH} /data/pnpm-store`
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
    log.info("Repository already present — pulling latest changes...");
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

  // The pnpm content-addressable store lives outside the repo directory so it
  // doesn't show up as untracked in git status, but still on the same volume
  // so it gets baked into the snapshot.
  const PNPM_STORE = "/data/pnpm-store";
  const FILTER_STRING = INSTALL_EXCLUDE_FILTERS.join(' --filter ');

  await run(
    sandbox,
    "Installing dependencies with pnpm...",
    `cd ${MOUNT_PATH} && pnpm install --store-dir ${PNPM_STORE} --frozen-lockfile --filter ${FILTER_STRING} --network-concurrency=5 || pnpm install --store-dir ${PNPM_STORE} --filter ${FILTER_STRING} --network-concurrency=5`
  );

  // Verify the pnpm store was actually populated — an empty/missing store
  // means the snapshot will force a full re-download on every sandbox boot.
  await run(
    sandbox,
    "Verifying pnpm store is populated...",
    `du -sh ${PNPM_STORE} && echo "Store files:" && ls ${PNPM_STORE}/v3/files 2>/dev/null | head -5 || echo "WARNING: pnpm store appears empty at ${PNPM_STORE}"`
  );

  // -----------------------------------------------------------------------
  // 6. Build the project so TypeScript declarations are available
  // -----------------------------------------------------------------------

  await run(
    sandbox,
    "Building workspace packages...",
    `cd ${MOUNT_PATH} && pnpm --filter ${FILTER_STRING} build`,
    { verbose: true }
  );
  log.success("Build succeeded!");

  // -----------------------------------------------------------------------
  // 6b. Ensure the build left the git tree clean
  // -----------------------------------------------------------------------
  // Some builds mutate package.json files (e.g. version fields, exports maps).
  // A dirty tree means `git checkout <branch>` will fail later in the review
  // agent, so we catch it here early.

  log.step("Checking git tree is clean after build...");
  const dirtyFiles = (
    await run(
      sandbox,
      "Checking for uncommitted changes...",
      `cd ${MOUNT_PATH} && git status --porcelain`
    )
  ).trim();

  if (dirtyFiles) {
    // Show exactly what changed so the developer can fix the root cause.
    log.warn("Build left the following dirty files:");
    log.message(pc.dim(dirtyFiles));

    await run(
      sandbox,
      "Showing diff of dirty files...",
      `cd ${MOUNT_PATH} && git diff`,
      { verbose: true }
    );

    // Reset so the snapshot is usable regardless.
    log.step("Resetting dirty files to restore clean git state...");
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

    log.success("Git tree restored to clean state.");
  } else {
    log.success("Git tree is clean after build.");
  }

  // -----------------------------------------------------------------------
  // 7. Run unit tests to verify the environment
  // -----------------------------------------------------------------------

  log.step("Running unit tests to verify the environment...");
  try {
    await run(
      sandbox,
      "Running tests...",
      `cd ${MOUNT_PATH} && pnpm --filter langchain test`
    );
    log.success("All tests passed — environment is ready!");
  } catch {
    log.warn("Some tests failed — but the volume is still usable for reviews.");
    log.info("You may want to investigate test failures separately.");
  }

  // -----------------------------------------------------------------------
  // 8. Check on-disk usage, shut down, and report volume stats
  // -----------------------------------------------------------------------

  // `du` inside the sandbox is the source of truth for volume size.
  // The API's `estimatedFlattenedSize` can lag by minutes and is unreliable
  // immediately after close.
  const duOutput = await run(
    sandbox,
    "Measuring volume usage (du)...",
    `du -sh ${MOUNT_PATH}`
  );

  const closeSpinner = spinner({ indicator: "timer" });
  closeSpinner.start("Closing sandbox...");
  await sandbox.kill();
  closeSpinner.stop("Sandbox terminated — volume data persisted.");

  // Parse the du output (e.g. "3.4G\t/data/repo\n") for the summary line.
  const duSize = duOutput.trim().split(/\s+/)[0] ?? "unknown";

  log.info(
    `Volume usage: ${duSize} on disk ` +
    `(capacity: ${(volume.capacity / 1024 / 1024 / 1024).toFixed(1)} GB)`
  );

  // -----------------------------------------------------------------------
  // 9. Create a snapshot from the volume for concurrent sandbox use
  // -----------------------------------------------------------------------

  log.step("Creating snapshot from volume...");

  // Delete existing snapshot if present (snapshots are immutable — we must
  // recreate to pick up volume changes).
  const existingSnapshot = await client.snapshots.get(SNAPSHOT_SLUG);
  if (existingSnapshot) {
    // Before deleting the snapshot, we must remove any volumes that were
    // forked from it (e.g. review-tmp-* volumes).  The API rejects snapshot
    // deletion while dependent volumes exist (SNAPSHOT_IN_USE).
    {
      const tl = taskLog({ title: "Cleaning up volumes derived from the snapshot..." });
      const dependentVolumes = await client.volumes.list({ search: "review-tmp" });
      let deletedVolumes = 0;
      for await (const vol of dependentVolumes) {
        try {
          tl.message(`Deleting volume "${vol.slug}"...`);
          await client.volumes.delete(vol.slug);
          deletedVolumes++;
        } catch {
          // Best-effort — the volume may already be gone or still in use by a
          // running sandbox.  We'll still attempt the snapshot delete below and
          // surface a clear error if it fails.
          tl.message(`Could not delete volume "${vol.slug}" — skipping`);
        }
      }
      if (deletedVolumes > 0) {
        tl.success(`Deleted ${deletedVolumes} dependent volume(s)`);
      } else {
        tl.success("No dependent volumes found");
      }
    }

    // Retry snapshot deletion with back-off.  After dependent volumes are
    // deleted the backend may need a few seconds to fully release them before
    // the snapshot can be removed (JOB_IS_DEAD / transient 500 errors).
    const deleteSpinner = spinner({ indicator: "timer" });
    deleteSpinner.start(`Deleting existing snapshot "${SNAPSHOT_SLUG}"...`);

    const MAX_RETRIES = 5;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        await client.snapshots.delete(SNAPSHOT_SLUG);
        deleteSpinner.stop(`Deleted snapshot "${SNAPSHOT_SLUG}"`);
        break; // success
      } catch (err: unknown) {
        const isRetryable =
          err instanceof Error &&
          "status" in err &&
          ((err as { status: number }).status >= 500 ||
            (err as { code?: string }).code === "SNAPSHOT_IN_USE");

        if (isRetryable && attempt < MAX_RETRIES) {
          const delaySec = attempt * 5;
          deleteSpinner.message(
            `Retry ${attempt}/${MAX_RETRIES} — waiting ${delaySec}s...`
          );
          await new Promise((r) => setTimeout(r, delaySec * 1000));
        } else {
          deleteSpinner.error("Snapshot deletion failed");
          throw err;
        }
      }
    }
  }

  const snapshotSpinner = spinner({ indicator: "timer" });
  snapshotSpinner.start("Creating snapshot from volume...");
  const snapshot = await client.volumes.snapshot(volume.slug, {
    slug: SNAPSHOT_SLUG,
  });
  snapshotSpinner.stop(`Snapshot created: ${snapshot.slug} (${snapshot.flattenedSize} bytes)`);

  // -----------------------------------------------------------------------
  // Done!
  // -----------------------------------------------------------------------

  box(
    [
      `Volume slug:   ${pc.cyan(VOLUME_SLUG)}`,
      `Snapshot slug: ${pc.cyan(SNAPSHOT_SLUG)}`,
      `Repo path:     ${pc.cyan(MOUNT_PATH)}`,
    ].join("\n"),
    "Setup complete!",
    { titleAlign: "center", contentAlign: "left", rounded: true }
  );

  outro("The review agent can now use the snapshot.");
}

main().catch((err) => {
  cancel("Fatal error");
  log.error(String(err));
  Deno.exit(1);
});
