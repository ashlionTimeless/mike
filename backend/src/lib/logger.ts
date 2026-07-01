import path from "path";

const DEFAULT_AGENT_LOG_DIR = path.join(process.cwd(), "logs");

/**
 * Root directory for agent step logs written by agent-log-writer and read by
 * /agent-run-logs download routes. Set via AGENT_LOG_DIR in backend/.env.
 */
export function getAgentLogDir(): string {
  const configured = process.env.AGENT_LOG_DIR?.trim();
  if (!configured) return DEFAULT_AGENT_LOG_DIR;
  return path.isAbsolute(configured)
    ? configured
    : path.resolve(process.cwd(), configured);
}

const RUN_ID_RE = /^run_\d{14}(?:_\d+)?(?:_[0-9a-f]{8})?$/i;
const LOG_FILENAME_RE = /^agent-[0-9a-f-]+\.jsonl$/i;

export function buildAgentRunLogDownloadUrl(
  runId: string,
  filename: string,
): string {
  return `/agent-run-logs/${encodeURIComponent(runId)}/${encodeURIComponent(filename)}`;
}

export function resolveAgentRunLogFilePath(
  runId: string,
  filename: string,
): string | null {
  if (!RUN_ID_RE.test(runId) || !LOG_FILENAME_RE.test(filename)) return null;
  const logsRoot = path.resolve(getAgentLogDir());
  const resolved = path.resolve(path.join(logsRoot, runId, filename));
  if (!resolved.startsWith(`${logsRoot}${path.sep}`)) return null;
  return resolved;
}
