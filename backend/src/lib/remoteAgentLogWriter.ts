import type { AgentLogRecord } from "./agentStepLogger";

type LogStepResponse = {
  ok: boolean;
  run_id?: string;
  filename?: string;
  relative_path?: string;
  detail?: string;
};

function getRemoteWriterConfig(): {
  baseUrl: string;
  sink: "mike" | "anthropic";
} | null {
  const baseUrl = process.env.AGENT_LOG_WRITER_URL?.trim();
  if (!baseUrl) return null;
  const sinkRaw = process.env.AGENT_LOG_SINK?.trim().toLowerCase() ?? "mike";
  if (sinkRaw !== "mike" && sinkRaw !== "anthropic") {
    throw new Error(`AGENT_LOG_SINK must be "mike" or "anthropic", got "${sinkRaw}"`);
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ""), sink: sinkRaw };
}

export class RemoteAgentLogWriter {
  private readonly baseUrl: string;
  private readonly sink: "mike" | "anthropic";
  private readonly filename: string;
  private runId: string | null = null;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(args: { sessionId: string; sink?: "mike" | "anthropic"; baseUrl?: string }) {
    const config = getRemoteWriterConfig();
    if (!config && !args.baseUrl) {
      throw new Error("RemoteAgentLogWriter requires AGENT_LOG_WRITER_URL or baseUrl");
    }
    this.baseUrl = (args.baseUrl ?? config!.baseUrl).replace(/\/+$/, "");
    this.sink = args.sink ?? config!.sink;
    this.filename = `agent-${args.sessionId}.jsonl`;
  }

  getRunId(): string | null {
    return this.runId;
  }

  getLogFilename(): string {
    return this.filename;
  }

  log(record: AgentLogRecord): void {
    this.writeChain = this.writeChain.then(async () => {
      const response = await fetch(`${this.baseUrl}/log-step`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sink: this.sink,
          run_id: this.runId ?? undefined,
          filename: this.filename,
          record,
        }),
      });

      const payload = (await response.json().catch(() => ({}))) as LogStepResponse;
      if (!response.ok || !payload.ok) {
        throw new Error(payload.detail ?? `Remote log write failed (${response.status})`);
      }
      if (payload.run_id) this.runId = payload.run_id;
    }).catch((error) => {
      console.error("[RemoteAgentLogWriter] failed to write log step", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  async flush(): Promise<void> {
    await this.writeChain;
  }
}

export function getRemoteWriterConfigOrNull(): ReturnType<typeof getRemoteWriterConfig> {
  return getRemoteWriterConfig();
}
