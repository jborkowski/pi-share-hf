import fs from "node:fs";
import path from "node:path";
import type { TruffleHogFinding, TruffleHogFindingStatus, TruffleHogReport, TruffleHogSummary } from "./types.ts";
import { TRUFFLEHOG_REPORT_SUFFIX } from "./types.ts";
import { runCommand } from "./process.ts";
import { isRecord, sha256Text, workspacePath, ensureParentDir } from "./workspace.ts";

export function trufflehogReportPath(workspace: string, file: string): string {
  return workspacePath(workspace, "reports", `${file}${TRUFFLEHOG_REPORT_SUFFIX}`);
}

export function loadTruffleHogReport(filePath: string): TruffleHogReport | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown;
    if (!isRecord(parsed)) return undefined;
    if (typeof parsed.file !== "string") return undefined;
    if (typeof parsed.redacted_hash !== "string") return undefined;
    if (!isRecord(parsed.summary)) return undefined;
    if (!Array.isArray(parsed.findings)) return undefined;
    return parsed as unknown as TruffleHogReport;
  } catch {
    return undefined;
  }
}

export async function scanFilesWithTruffleHog(
  files: Array<{ file: string; redactedPath: string; redactedHash: string }>,
): Promise<Map<string, TruffleHogReport>> {
  const reports = new Map<string, TruffleHogReport>();
  if (files.length === 0) return reports;

  const pathToFile = new Map<string, { file: string; redactedHash: string }>();
  for (const entry of files) {
    pathToFile.set(path.resolve(entry.redactedPath), {
      file: entry.file,
      redactedHash: entry.redactedHash,
    });
  }

  const result = await runCommand("trufflehog", [
    "filesystem",
    ...files.map((entry) => entry.redactedPath),
    "-j",
    "--results=verified,unknown,unverified",
    "--no-color",
    "--no-update",
  ]);

  if (!result.ok) {
    throw new Error(`trufflehog failed: ${result.stderr || result.stdout || "unknown error"}`);
  }

  const dedupedByFile = new Map<string, Map<string, TruffleHogFinding>>();

  for (const line of result.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      continue;
    }

    const finding = parseTruffleHogFinding(parsed);
    if (!finding) continue;

    const filesystem = readFilesystemMetadata(parsed);
    const findingPath = filesystem?.file ? path.resolve(filesystem.file) : undefined;
    const source = findingPath ? pathToFile.get(findingPath) : undefined;
    if (!source) continue;

    const deduped = dedupedByFile.get(source.file) ?? new Map<string, TruffleHogFinding>();
    const key = JSON.stringify([
      finding.detector,
      finding.decoder ?? "",
      finding.status,
      finding.line ?? -1,
      finding.raw_sha256 ?? "",
    ]);
    if (!deduped.has(key)) {
      deduped.set(key, finding);
    }
    dedupedByFile.set(source.file, deduped);
  }

  for (const entry of files) {
    const deduped = dedupedByFile.get(entry.file) ?? new Map<string, TruffleHogFinding>();
    const findings = [...deduped.values()].sort((a, b) => {
      const lineA = a.line ?? Number.MAX_SAFE_INTEGER;
      const lineB = b.line ?? Number.MAX_SAFE_INTEGER;
      if (lineA !== lineB) return lineA - lineB;
      if (a.detector !== b.detector) return a.detector.localeCompare(b.detector);
      return (a.decoder ?? "").localeCompare(b.decoder ?? "");
    });

    reports.set(entry.file, {
      file: entry.file,
      redacted_hash: entry.redactedHash,
      findings,
      summary: summarizeFindings(findings),
    });
  }

  return reports;
}

export function saveTruffleHogReport(filePath: string, report: TruffleHogReport): void {
  ensureParentDir(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(report, null, 2)}\n`);
}

export function blockingTruffleHogReason(report: TruffleHogReport): { reason: string; evidence: string; missedSensitiveData: "yes" | "maybe" } | undefined {
  if (report.summary.findings === 0) return undefined;

  return {
    reason: "trufflehog-findings",
    evidence: formatSummaryEvidence(report),
    missedSensitiveData: report.summary.verified > 0 || report.summary.unknown > 0 ? "yes" : "maybe",
  };
}

export function formatTruffleHogFinding(finding: TruffleHogFinding): string {
  const line = finding.line !== undefined ? `L${finding.line}` : "L?";
  return `${line} ${finding.status} ${finding.detector} ${finding.masked}`;
}

function parseTruffleHogFinding(value: unknown): TruffleHogFinding | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.DetectorName !== "string") return undefined;

  const status = parseFindingStatus(value);
  const filesystem = readFilesystemMetadata(value);
  const raw = typeof value.Raw === "string" && value.Raw.length > 0 ? value.Raw : undefined;

  return {
    detector: value.DetectorName,
    decoder: typeof value.DecoderName === "string" ? value.DecoderName : undefined,
    status,
    line: filesystem?.line,
    raw_sha256: raw ? sha256Text(raw) : undefined,
    masked: raw ? maskSecret(raw) : "[REDACTED]",
    verification_from_cache: value.VerificationFromCache === true,
  };
}

function parseFindingStatus(value: Record<string, unknown>): TruffleHogFindingStatus {
  if (value.Verified === true) return "verified";

  const extraData = isRecord(value.ExtraData) ? value.ExtraData : undefined;
  if (extraData) {
    if (typeof extraData.verification_error === "string" && extraData.verification_error.trim() !== "") {
      return "unknown";
    }
    if (typeof extraData.verificationError === "string" && extraData.verificationError.trim() !== "") {
      return "unknown";
    }
    if (typeof extraData.error === "string" && extraData.error.trim() !== "") {
      return "unknown";
    }
  }

  return "unverified";
}

function readFilesystemMetadata(value: unknown): { file?: string; line?: number } | undefined {
  if (!isRecord(value)) return undefined;
  const sourceMetadata = isRecord(value.SourceMetadata) ? value.SourceMetadata : undefined;
  const data = sourceMetadata && isRecord(sourceMetadata.Data) ? sourceMetadata.Data : undefined;
  const filesystem = data && isRecord(data.Filesystem) ? data.Filesystem : undefined;
  if (!filesystem) return undefined;
  return {
    file: typeof filesystem.file === "string" ? filesystem.file : undefined,
    line: typeof filesystem.line === "number" ? filesystem.line : undefined,
  };
}

function summarizeFindings(findings: TruffleHogFinding[]): TruffleHogSummary {
  const detectorCounts = new Map<string, number>();
  const summary: TruffleHogSummary = {
    findings: findings.length,
    verified: 0,
    unverified: 0,
    unknown: 0,
    top_detectors: [],
  };

  for (const finding of findings) {
    summary[finding.status]++;
    detectorCounts.set(finding.detector, (detectorCounts.get(finding.detector) ?? 0) + 1);
  }

  summary.top_detectors = [...detectorCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([detector]) => detector);

  return summary;
}

function formatSummaryEvidence(report: TruffleHogReport): string {
  const summary = report.summary;
  const detectors = summary.top_detectors.length > 0 ? summary.top_detectors.join(", ") : "none";
  const examples = report.findings.slice(0, 5).map((finding) => `${finding.detector}:${finding.masked}`).join(", ");
  return `verified=${summary.verified}, unknown=${summary.unknown}, unverified=${summary.unverified}, detectors=${detectors}${examples ? `, examples=${examples}` : ""}`;
}

function maskSecret(raw: string): string {
  if (raw.length <= 8) return "***";

  const prefixLength = raw.startsWith("npm_") ? Math.min(8, raw.length - 4) : Math.min(4, raw.length - 4);
  const suffixLength = Math.min(4, raw.length - prefixLength);

  return `${raw.slice(0, prefixLength)}***${raw.slice(raw.length - suffixLength)}`;
}
