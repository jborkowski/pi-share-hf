import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type DiscoveredSessionKind = "transcript" | "trajectory";

export interface DiscoveredSession {
  agentId: string;
  kind: DiscoveredSessionKind;
  workspaceFile: string;
  sourcePath: string;
}

export interface DiscoverOpenClawSessionsOptions {
  agents?: string[];
  session?: string;
  allSessions?: boolean;
}

const OPENCLAW_AGENTS_BASE = path.join(os.homedir(), ".openclaw", "agents");

function normalizeCwd(cwd: string): string {
  return path.resolve(cwd);
}

function cwdMatches(eventCwd: string, targetCwd: string): boolean {
  return normalizeCwd(eventCwd) === normalizeCwd(targetCwd);
}

function isExcludedSessionFile(name: string): boolean {
  if (name === "sessions.json") return true;
  if (name.endsWith(".trajectory-path.json")) return true;
  if (/\.reset\./.test(name) && name.endsWith(".jsonl")) return true;
  return false;
}

function isTrajectoryFile(name: string): boolean {
  return name.endsWith(".trajectory.jsonl");
}

function isTranscriptFile(name: string): boolean {
  return name.endsWith(".jsonl") && !isTrajectoryFile(name);
}

function matchesSessionFilter(agentId: string, fileName: string, sessionFilter: string): boolean {
  const workspaceFile = `${agentId}/${fileName}`;
  return fileName.includes(sessionFilter) || workspaceFile.includes(sessionFilter);
}

export function discoverOpenClawSessions(cwd: string, options?: DiscoverOpenClawSessionsOptions): DiscoveredSession[] {
  if (!fs.existsSync(OPENCLAW_AGENTS_BASE)) {
    throw new Error(`OpenClaw agents directory not found: ${OPENCLAW_AGENTS_BASE}`);
  }

  const allSessions = !!options?.allSessions;
  const targetCwd = normalizeCwd(cwd);
  const agentFilter = options?.agents && options.agents.length > 0 ? new Set(options.agents) : undefined;
  const sessionFilter = options?.session;

  const agentIds = fs.readdirSync(OPENCLAW_AGENTS_BASE, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((agentId) => !agentFilter || agentFilter.has(agentId))
    .sort();

  const discovered: DiscoveredSession[] = [];
  const transcriptCwds = new Map<string, string>();
  const seenTrajectoryPaths = new Set<string>();

  for (const agentId of agentIds) {
    const sessionsDir = path.join(OPENCLAW_AGENTS_BASE, agentId, "sessions");
    if (!fs.existsSync(sessionsDir)) continue;

    const files = fs.readdirSync(sessionsDir).filter((fileName) => !isExcludedSessionFile(fileName)).sort();

    for (const fileName of files) {
      if (!isTranscriptFile(fileName)) continue;
      if (sessionFilter && !matchesSessionFilter(agentId, fileName, sessionFilter)) continue;

      const sourcePath = path.join(sessionsDir, fileName);
      const sessionCwd = readTranscriptCwd(sourcePath);
      if (!allSessions && (!sessionCwd || !cwdMatches(sessionCwd, targetCwd))) continue;

      if (sessionCwd) transcriptCwds.set(sourcePath, sessionCwd);
      discovered.push({
        agentId,
        kind: "transcript",
        workspaceFile: `${agentId}/${fileName}`,
        sourcePath,
      });
    }

    for (const fileName of files) {
      if (!isTrajectoryFile(fileName)) continue;
      if (sessionFilter && !matchesSessionFilter(agentId, fileName, sessionFilter)) continue;

      const sourcePath = path.join(sessionsDir, fileName);
      if (seenTrajectoryPaths.has(sourcePath)) continue;

      if (!allSessions && !trajectoryMatchesCwd(sourcePath, sessionsDir, fileName, transcriptCwds, targetCwd)) continue;

      seenTrajectoryPaths.add(sourcePath);
      discovered.push({
        agentId,
        kind: "trajectory",
        workspaceFile: `${agentId}/${fileName}`,
        sourcePath,
      });
    }

    for (const fileName of files) {
      if (!fileName.endsWith(".trajectory-path.json")) continue;

      const base = fileName.slice(0, -".trajectory-path.json".length);
      if (sessionFilter && !matchesSessionFilter(agentId, base, sessionFilter)) continue;

      const pointerPath = path.join(sessionsDir, fileName);
      const trajectoryPath = resolveTrajectoryPointer(pointerPath);
      if (!trajectoryPath || !fs.existsSync(trajectoryPath) || seenTrajectoryPaths.has(trajectoryPath)) continue;

      const trajectoryFileName = path.basename(trajectoryPath);
      if (!allSessions && !trajectoryMatchesCwd(trajectoryPath, sessionsDir, trajectoryFileName, transcriptCwds, targetCwd)) continue;

      seenTrajectoryPaths.add(trajectoryPath);
      discovered.push({
        agentId,
        kind: "trajectory",
        workspaceFile: `${agentId}/${trajectoryFileName}`,
        sourcePath: trajectoryPath,
      });
    }
  }

  if (discovered.length === 0) {
    const agentHint = agentFilter ? ` (agents: ${[...agentFilter].join(", ")})` : "";
    if (allSessions) {
      throw new Error(`No OpenClaw sessions found under ${OPENCLAW_AGENTS_BASE}${agentHint}`);
    }
    throw new Error(`No OpenClaw sessions found for cwd: ${targetCwd}${agentHint}`);
  }

  return discovered.sort((a, b) => a.workspaceFile.localeCompare(b.workspaceFile));
}

function trajectoryMatchesCwd(
  trajectoryPath: string,
  sessionsDir: string,
  trajectoryFileName: string,
  transcriptCwds: Map<string, string>,
  targetCwd: string,
): boolean {
  const workspaceDir = readTrajectoryWorkspaceDir(trajectoryPath);
  if (workspaceDir && cwdMatches(workspaceDir, targetCwd)) return true;

  const pairedTranscript = trajectoryFileName.replace(/\.trajectory\.jsonl$/, ".jsonl");
  const pairedPath = path.join(sessionsDir, pairedTranscript);
  const inheritedCwd = transcriptCwds.get(pairedPath) ?? (fs.existsSync(pairedPath) ? readTranscriptCwd(pairedPath) : undefined);
  return inheritedCwd !== undefined && cwdMatches(inheritedCwd, targetCwd);
}

function readTranscriptCwd(sourcePath: string): string | undefined {
  try {
    const content = fs.readFileSync(sourcePath, "utf-8");
    const firstLine = content.split("\n").find((line) => line.trim() !== "");
    if (!firstLine) return undefined;

    const parsed = JSON.parse(firstLine) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;

    const record = parsed as Record<string, unknown>;
    if (record.type !== "session") return undefined;
    return typeof record.cwd === "string" ? record.cwd : undefined;
  } catch {
    return undefined;
  }
}

function readTrajectoryWorkspaceDir(sourcePath: string, maxLines = 50): string | undefined {
  try {
    const content = fs.readFileSync(sourcePath, "utf-8");
    const lines = content.split("\n").filter((line) => line.trim() !== "").slice(0, maxLines);

    for (const line of lines) {
      const parsed = JSON.parse(line) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;

      const record = parsed as Record<string, unknown>;
      if (typeof record.workspaceDir === "string") return record.workspaceDir;
    }

    return undefined;
  } catch {
    return undefined;
  }
}

function resolveTrajectoryPointer(pointerPath: string): string | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(pointerPath, "utf-8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;

    const record = parsed as Record<string, unknown>;
    const filePath = typeof record.path === "string"
      ? record.path
      : typeof record.filePath === "string"
        ? record.filePath
        : typeof record.trajectoryPath === "string"
          ? record.trajectoryPath
          : undefined;

    if (!filePath) return undefined;
    if (path.isAbsolute(filePath)) return filePath;
    return path.resolve(path.dirname(pointerPath), filePath);
  } catch {
    return undefined;
  }
}
