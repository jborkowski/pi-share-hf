import fs from "node:fs";
import path from "node:path";
import { bold, cyan, dim, green, yellow } from "./colors.ts";
import { uploadDatasetFolder } from "./hf.ts";
import type { ChunkReviewResult, UploadOptions } from "./types.ts";
import { REJECT_FILE, REMOTE_MANIFEST_CACHE_FILE, REMOTE_MANIFEST_FILE } from "./types.ts";
import { runCommand } from "./process.ts";
import { loadReviewFile } from "./review-state.ts";
import { downloadRemoteManifest, ensureParentDir, loadLocalManifest, readWorkspaceConfig, workspacePath } from "./workspace.ts";

function loadRejectSet(workspace: string): Set<string> {
  const file = workspacePath(workspace, REJECT_FILE);
  if (!fs.existsSync(file)) return new Set();
  return new Set(fs.readFileSync(file, "utf-8").split("\n").map((line) => line.trim()).filter(Boolean));
}

export async function runUpload(options: UploadOptions): Promise<void> {
  const config = readWorkspaceConfig(options.workspace);
  const repo = config.repo;
  const isPrivate = options.private || !!config.private;

  const localManifest = loadLocalManifest(workspacePath(options.workspace, "manifest.local.jsonl"));
  if (localManifest.size === 0) {
    console.log(`No local manifest entries found in ${workspacePath(options.workspace, "manifest.local.jsonl")}`);
    return;
  }

  const rejectedByUser = loadRejectSet(options.workspace);
  const entries = [...localManifest.values()].sort((a, b) => a.file.localeCompare(b.file));
  let approved = 0;
  let rejected = 0;
  let rejectedManual = 0;
  let noReview = 0;
  let missingLocal = 0;
  let unchanged = 0;

  const remoteManifestPath = workspacePath(options.workspace, REMOTE_MANIFEST_CACHE_FILE);
  const remoteManifest = await downloadRemoteManifest(repo, remoteManifestPath);

  for (const entry of entries) {
    const localFile = workspacePath(options.workspace, "redacted", entry.file);

    if (rejectedByUser.has(entry.file)) {
      rejectedManual++;
      continue;
    }

    if (!fs.existsSync(localFile)) {
      missingLocal++;
      continue;
    }

    if (!isPrivate) {
      const reviewFile = loadReviewFile(workspacePath(options.workspace, "review", `${entry.file}.review.json`));
      if (!reviewFile) {
        noReview++;
        continue;
      }
      if (hasReviewErrors(reviewFile) || !isUploadApproved(reviewFile.aggregate)) {
        rejected++;
        continue;
      }
    }

    const remoteEntry = remoteManifest.get(entry.file);
    if (remoteEntry?.redacted_hash === entry.redacted_hash) {
      unchanged++;
      continue;
    }

    approved++;
  }

  console.log(`${bold("Total sessions:")} ${cyan(String(entries.length))}`);
  if (isPrivate) {
    console.log(`${bold("Mode:")} ${dim("private (no LLM review required)")}`);
    console.log(`${bold("Ready to upload:")} ${green(String(approved))}`);
  } else {
    console.log(`${bold("Approved by review:")} ${green(String(approved))}`);
    console.log(`${bold("Rejected by review:")} ${yellow(String(rejected))}`);
    console.log(`${bold("No review data:")} ${noReview > 0 ? String(noReview) : String(noReview)}`);
  }
  console.log(`${bold("Rejected manually:")} ${yellow(String(rejectedManual))}`);
  console.log(`${bold("Already uploaded (unchanged):")} ${unchanged}`);
  console.log(`${bold("Missing local redacted file:")} ${missingLocal}`);

  if (!isPrivate && noReview > 0) {
    console.log(`\nRefusing to upload: ${noReview} session(s) have no review data. Run review first, or use --private.`);
    return;
  }
  if (options.dryRun) {
    console.log(`\n${yellow("Dry run, not uploading.")}`);
    return;
  }
  if (approved === 0) {
    console.log(`\n${yellow("Nothing to upload.")}`);
    return;
  }

  const uploadDir = workspacePath(options.workspace, "_upload_staging");
  fs.rmSync(uploadDir, { recursive: true, force: true });
  fs.mkdirSync(uploadDir, { recursive: true });

  const updatedManifest = new Map(remoteManifest);
  let staged = 0;

  for (const entry of entries) {
    if (rejectedByUser.has(entry.file)) continue;

    if (!isPrivate) {
      const reviewFile = loadReviewFile(workspacePath(options.workspace, "review", `${entry.file}.review.json`));
      if (!reviewFile || hasReviewErrors(reviewFile) || !isUploadApproved(reviewFile.aggregate)) continue;
    }

    const remoteEntry = remoteManifest.get(entry.file);
    if (remoteEntry?.redacted_hash === entry.redacted_hash) continue;

    const localFile = workspacePath(options.workspace, "redacted", entry.file);
    if (!fs.existsSync(localFile)) continue;

    const stagedFile = path.join(uploadDir, entry.file);
    ensureParentDir(stagedFile);
    fs.copyFileSync(localFile, stagedFile);
    updatedManifest.set(entry.file, {
      file: entry.file,
      source_hash: entry.source_hash,
      redaction_key: entry.redaction_key,
      redacted_hash: entry.redacted_hash,
    });
    staged++;
  }

  const manifestContents = [...updatedManifest.values()]
    .sort((a, b) => a.file.localeCompare(b.file))
    .map((entry) => JSON.stringify(entry))
    .join("\n");
  fs.writeFileSync(path.join(uploadDir, REMOTE_MANIFEST_FILE), manifestContents.length > 0 ? `${manifestContents}\n` : "");
  fs.writeFileSync(
    path.join(uploadDir, "README.md"),
    await generateDatasetCard(config.cwd, repo, entries.length, approved, rejected + rejectedManual, unchanged, isPrivate),
  );

  console.log(`${bold("Staged for upload:")} ${cyan(String(staged))}`);
  console.log(green("Uploading..."));

  await uploadFolder(repo, uploadDir);

  fs.copyFileSync(path.join(uploadDir, REMOTE_MANIFEST_FILE), workspacePath(options.workspace, REMOTE_MANIFEST_FILE));
  fs.rmSync(uploadDir, { recursive: true, force: true });

  console.log(`${bold("Uploaded:")} ${green(String(staged))}`);
  console.log(`${bold("Updated remote manifest:")} ${REMOTE_MANIFEST_FILE}`);
  if (isPrivate) {
    console.log(dim("Ensure the Hugging Face dataset repo is set to private in repo settings."));
  }
}

async function generateDatasetCard(
  cwd: string,
  repo: string,
  totalSessions: number,
  approved: number,
  blocked: number,
  unchanged: number,
  isPrivate: boolean,
): Promise<string> {
  const sourceRepo = await resolveGitOrigin(cwd);
  const lines = [
    "---",
    "pretty_name: coding agent session traces",
    "task_categories:",
    "- text-generation",
    "tags:",
    "- agent-traces",
    "- coding-agent",
    "- openclaw-share-hf",
    "language:",
    "- en",
    "- code",
    "license: other",
    "---",
    "",
    `# Coding agent session traces for ${repo}`,
    "",
  ];

  if (isPrivate) {
    lines.push(
      "Private backup of redacted OpenClaw agent session traces exported with [openclaw-share-hf](https://www.npmjs.com/package/openclaw-share-hf).",
      "Uploaded in private mode without LLM public-share review.",
      "",
    );
  } else {
    lines.push(
      sourceRepo
        ? `This dataset contains redacted OpenClaw agent session traces collected while working on ${sourceRepo}. The traces were exported with [openclaw-share-hf](https://www.npmjs.com/package/openclaw-share-hf) from local OpenClaw sessions and filtered to keep only sessions that passed deterministic redaction and LLM review.`
        : `This dataset contains redacted OpenClaw agent session traces exported with [openclaw-share-hf](https://www.npmjs.com/package/openclaw-share-hf) from local OpenClaw sessions. The traces were filtered to keep only sessions that passed deterministic redaction and LLM review.`,
      "",
    );
  }

  lines.push(
    "## Data description",
    "",
    "Each `*.jsonl` file is a redacted OpenClaw transcript session. Each `*.trajectory.jsonl` file is a redacted OpenClaw trajectory sidecar. Sessions are stored as JSON Lines files where each line is a structured entry. Transcript entries include session headers, user and assistant messages, tool results, compaction summaries, branch summaries, and custom extension data. Trajectory entries follow the `openclaw-trajectory` schema and capture runtime timeline events.",
    "",
    "OpenClaw transcript files are tree-structured via `id` and `parentId`, so a single session file may contain multiple branches of work. See the upstream documentation for the exact schemas:",
    "",
    "- https://docs.openclaw.ai/reference/session-management-compaction",
    "- https://docs.openclaw.ai/tools/trajectory",
    "",
    sourceRepo ? `Source git repo: ${sourceRepo}` : "Source git repo: (not detected)",
    "",
    "## Redaction and review",
    "",
    isPrivate
      ? "The data was processed with [openclaw-share-hf](https://www.npmjs.com/package/openclaw-share-hf) using deterministic secret redaction. Private mode skips LLM public-share review."
      : "The data was processed with [openclaw-share-hf](https://www.npmjs.com/package/openclaw-share-hf) using deterministic secret redaction plus an LLM review step. Deterministic redaction targets exact known secrets and curated credential patterns. The LLM review decides whether a session is about the OSS project, whether it is fit to share publicly, and whether any sensitive content appears to have been missed.",
    "",
    "Embedded images may be preserved in the uploaded sessions unless the workspace was initialized with `--no-images`.",
    "",
    "## Limitations",
    "",
    "This dataset is best-effort redacted. Coding agent transcripts can still contain sensitive or off-topic content, especially if a session mixed OSS work with unrelated private tasks. Use with appropriate caution.",
    "",
  );
  return `${lines.join("\n")}\n`;
}

async function resolveGitOrigin(cwd: string): Promise<string | undefined> {
  const inside = await runCommand("git", ["-C", cwd, "rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok || inside.stdout.trim() !== "true") return undefined;
  const origin = await runCommand("git", ["-C", cwd, "remote", "get-url", "origin"]);
  if (!origin.ok) return undefined;
  return origin.stdout.trim() || undefined;
}

function hasReviewErrors(reviewFile: { chunks: Array<{ error?: string }> }): boolean {
  return reviewFile.chunks.some((chunk) => typeof chunk.error === "string" && chunk.error.length > 0);
}

function isUploadApproved(result: ChunkReviewResult): boolean {
  if (result.shareable !== "yes") return false;
  if (result.missed_sensitive_data !== "no") return false;
  if (result.about_project === "no") return false;
  return true;
}

async function uploadFolder(repo: string, localDir: string): Promise<void> {
  await uploadDatasetFolder(repo, localDir, `openclaw-share-hf upload ${new Date().toISOString()}`);
}
