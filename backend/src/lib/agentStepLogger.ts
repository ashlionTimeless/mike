import { randomUUID } from "crypto";
import path from "path";
import type { LlmIterationLog, NormalizedToolCall } from "./llm/types";
import { Logger, createAgentRunLogDir } from "./logger";

export type AgentLogStatus = "success" | "error";

export type AgentLogSource = "api" | "estimated";

export type AgentLogArtifacts = {
  /** Text that input_tokens was computed from. */
  input?: string;
  /** Text that output_tokens was computed from (or user-visible output). */
  output?: string;
};

/** JSONL schema aligned with harness-style agent run logs. */
export type AgentLogRecord = {
  step: string;
  action: string;
  tool?: string;
  filepath?: string;
  status: AgentLogStatus;
  notes?: string;
  artifacts?: AgentLogArtifacts;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  source: AgentLogSource;
};

const MAX_ARTIFACT_OUTPUT = 500_000;

function truncateArtifactOutput(text: string, max = MAX_ARTIFACT_OUTPUT): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}…`;
}

function withArtifacts(
  input?: string | null,
  output?: string | null,
): Pick<AgentLogRecord, "artifacts"> {
  const artifacts: AgentLogArtifacts = {};
  const inputText = input?.trim();
  const outputText = output?.trim();
  if (inputText) artifacts.input = truncateArtifactOutput(inputText);
  if (outputText) artifacts.output = truncateArtifactOutput(outputText);
  if (!artifacts.input && !artifacts.output) return {};
  return { artifacts };
}

function serializeLlmInputs(inputs: {
  systemPrompt: string;
  messages: unknown;
}): string {
  return JSON.stringify({
    systemPrompt: inputs.systemPrompt,
    messages: inputs.messages,
  });
}

function serializeLlmOutput(artifacts: {
  text: string;
  toolCalls: NormalizedToolCall[];
}): string {
  const parts: string[] = [];
  if (artifacts.text.trim()) parts.push(artifacts.text);
  if (artifacts.toolCalls.length) {
    parts.push(JSON.stringify(artifacts.toolCalls));
  }
  return parts.join("\n\n");
}

export function isAgentStepLoggingEnabled(): boolean {
  return process.env.AGENT_STEP_LOGGING !== "false";
}

function estimateTokens(value: unknown): number {
  if (value == null) return 0;
  const text =
    typeof value === "string" ? value : JSON.stringify(value) ?? "";
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

function tokenFields(args: {
  inputTokens?: number | null;
  outputTokens?: number | null;
  source: AgentLogSource;
}): Pick<
  AgentLogRecord,
  "input_tokens" | "output_tokens" | "total_tokens" | "source"
> {
  const input_tokens = Math.max(0, args.inputTokens ?? 0);
  const output_tokens = Math.max(0, args.outputTokens ?? 0);
  return {
    input_tokens,
    output_tokens,
    total_tokens: input_tokens + output_tokens,
    source: args.source,
  };
}

function truncateNotes(notes: string, max = 4000): string {
  const trimmed = notes.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}…`;
}

function summarizeText(text: string, label: string): string {
  const trimmed = text.trim();
  if (!trimmed) return `${label}: empty.`;
  return `${label}: ${trimmed.length} chars.`;
}

/**
 * Structured agent-step logger. Each step is one JSONL record via Logger.
 */
export class AgentStepLogger {
  private readonly logger: Logger;
  private readonly sessionId: string;
  private readonly runLogDir: string;
  private readonly runId: string;
  private readonly model: string | null;

  constructor(args: { userId?: string; model?: string }) {
    this.sessionId = randomUUID();
    this.model = args.model ?? null;
    this.runLogDir = createAgentRunLogDir();
    this.runId = path.basename(this.runLogDir);
    this.logger = new Logger(`agent-${this.sessionId}.jsonl`, this.runLogDir);
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getRunLogDir(): string {
    return this.runLogDir;
  }

  getRunId(): string {
    return this.runId;
  }

  getLogFilename(): string {
    return `agent-${this.sessionId}.jsonl`;
  }

  private write(record: AgentLogRecord): void {
    if (!isAgentStepLoggingEnabled()) return;
    const entry: AgentLogRecord = { ...record };
    if (entry.notes) entry.notes = truncateNotes(entry.notes);
    if (entry.artifacts) {
      if (entry.artifacts.input) {
        entry.artifacts.input = truncateArtifactOutput(entry.artifacts.input);
      }
      if (entry.artifacts.output) {
        entry.artifacts.output = truncateArtifactOutput(entry.artifacts.output);
      }
      if (!entry.artifacts.input && !entry.artifacts.output) {
        delete entry.artifacts;
      }
    }
    if (!entry.tool) delete entry.tool;
    if (!entry.filepath) delete entry.filepath;
    if (!entry.notes) delete entry.notes;
    this.logger.log(entry as unknown as Record<string, unknown>, {
      omitTimestamp: true,
    });
  }

  logTurnStart(inputs: { systemPrompt: string; messages: unknown }): void {
    const messageCount = Array.isArray(inputs.messages)
      ? inputs.messages.length
      : 0;
    const inputText = serializeLlmInputs(inputs);
    const inputTokens = estimateTokens(inputText);
    this.write({
      step: "turn_start",
      action: "Loaded conversation context and system prompt",
      status: "success",
      notes: `${messageCount} chat message(s); system prompt ${inputs.systemPrompt.length} chars.`,
      ...withArtifacts(inputText),
      ...tokenFields({
        inputTokens,
        outputTokens: 0,
        source: "estimated",
      }),
    });
  }

  logLlmIteration(info: LlmIterationLog): void {
    const toolNames = info.artifacts.toolCalls.map((call) => call.name);
    const hasApiUsage =
      info.inputTokens != null && info.outputTokens != null;
    const inputText = serializeLlmInputs(info.inputs);
    const outputText = serializeLlmOutput(info.artifacts);
    const notes = [
      summarizeText(info.artifacts.text, "Model text"),
      toolNames.length
        ? `Tool calls: ${toolNames.join(", ")}.`
        : "No tool calls in this iteration.",
      this.model ? `Model: ${this.model}.` : null,
    ]
      .filter(Boolean)
      .join(" ");

    this.write({
      step: `llm_iteration_${info.iteration}`,
      action: `Completed model iteration ${info.iteration}`,
      status: "success",
      notes,
      ...withArtifacts(inputText, outputText),
      ...tokenFields({
        inputTokens: hasApiUsage
          ? info.inputTokens
          : estimateTokens(inputText),
        outputTokens: hasApiUsage
          ? info.outputTokens
          : estimateTokens(outputText),
        source: hasApiUsage ? "api" : "estimated",
      }),
    });
  }

  logThinking(text: string, iteration: number | null): void {
    this.write({
      step: iteration == null ? "thinking" : `thinking_${iteration}`,
      action: "Recorded model reasoning block",
      status: "success",
      notes: summarizeText(text, "Reasoning"),
      ...withArtifacts(undefined, text),
      ...tokenFields({
        inputTokens: 0,
        outputTokens: estimateTokens(text),
        source: "estimated",
      }),
    });
  }

  logContent(text: string, iteration: number | null): void {
    this.write({
      step: iteration == null ? "response_content" : `response_content_${iteration}`,
      action: "Recorded assistant response text segment",
      status: "success",
      notes: summarizeText(text, "Response"),
      ...withArtifacts(undefined, text),
      ...tokenFields({
        inputTokens: 0,
        outputTokens: estimateTokens(text),
        source: "estimated",
      }),
    });
  }

  logToolExecution(args: {
    tool: string;
    action: string;
    filepath?: string;
    status?: AgentLogStatus;
    notes?: string;
    inputText?: string;
    outputText?: string;
  }): void {
    this.write({
      step: args.tool,
      action: args.action,
      tool: args.tool,
      filepath: args.filepath,
      status: args.status ?? "success",
      notes: args.notes,
      ...withArtifacts(args.inputText, args.outputText),
      ...tokenFields({
        inputTokens: estimateTokens(args.inputText ?? ""),
        outputTokens: estimateTokens(args.outputText ?? ""),
        source: "estimated",
      }),
    });
  }

  logAssistantOutput(args: {
    step: string;
    action: string;
    output: string;
    tool?: string;
    filepath?: string;
  }): void {
    this.write({
      step: args.step,
      action: args.action,
      tool: args.tool,
      filepath: args.filepath,
      status: "success",
      notes: summarizeText(args.output, "Output"),
      ...withArtifacts(undefined, args.output),
      ...tokenFields({
        inputTokens: 0,
        outputTokens: estimateTokens(args.output),
        source: "estimated",
      }),
    });
  }

  recordAgentStreamLine(line: string): void {
    const payload = parseSseDataPayload(line);
    if (!payload) return;
    const formatted = formatAgentStreamOutput(payload);
    if (!formatted) return;
    this.logAssistantOutput(formatted);
  }

  logCitations(citations: unknown[]): void {
    const outputText = JSON.stringify(citations);
    this.write({
      step: "citations",
      action: "Parsed and emitted citation annotations",
      status: "success",
      notes: `${citations.length} citation(s) emitted.`,
      ...withArtifacts(undefined, outputText),
      ...tokenFields({
        inputTokens: 0,
        outputTokens: estimateTokens(outputText),
        source: "estimated",
      }),
    });
  }

  logTurnComplete(args: {
    fullText: string;
    events: unknown[];
    annotations: unknown[];
  }): void {
    const inputText = JSON.stringify(args.events);
    this.write({
      step: "turn_complete",
      action: "Completed assistant turn",
      status: "success",
      notes: [
        summarizeText(args.fullText, "Final response"),
        `${args.events.length} event(s), ${args.annotations.length} annotation(s).`,
      ].join(" "),
      ...withArtifacts(inputText, args.fullText),
      ...tokenFields({
        inputTokens: estimateTokens(inputText),
        outputTokens: estimateTokens(args.fullText),
        source: "estimated",
      }),
    });
  }

  logError(message: string, context?: unknown): void {
    const inputText =
      context == null ? "" : JSON.stringify(context);
    this.write({
      step: "error",
      action: "Agent turn failed",
      status: "error",
      notes: context
        ? `${message} Context: ${truncateNotes(inputText, 2000)}`
        : message,
      ...withArtifacts(inputText || undefined, message),
      ...tokenFields({
        inputTokens: estimateTokens(inputText),
        outputTokens: estimateTokens(message),
        source: "estimated",
      }),
    });
  }

  async flush(): Promise<void> {
    await this.logger.flush();
  }
}

export function buildToolExecutionLogs(args: {
  calls: NormalizedToolCall[];
  toolResults: { tool_call_id: string; content?: unknown }[];
  docStoragePath?: (docLabel: string) => string | undefined;
}): Array<{
  tool: string;
  action: string;
  filepath?: string;
  notes: string;
  inputText: string;
  outputText: string;
  status: AgentLogStatus;
}> {
  const resultById = new Map(
    args.toolResults.map((row) => [row.tool_call_id, row.content]),
  );

  return args.calls.map((call) => {
    const inputText = JSON.stringify(call.input ?? {});
    const rawResult = resultById.get(call.id);
    const outputText =
      typeof rawResult === "string"
        ? rawResult
        : rawResult == null
          ? ""
          : JSON.stringify(rawResult);

    const action = buildToolAction(call.name, call.input);
    const filepath = resolveToolFilepath(call, args.docStoragePath);
    const notes = buildToolNotes(call.name, call.input, outputText);
    const status: AgentLogStatus =
      /"error"|^error:|failed/i.test(outputText.slice(0, 200))
        ? "error"
        : "success";

    return {
      tool: call.name,
      action,
      filepath,
      notes,
      inputText,
      outputText,
      status,
    };
  });
}

function buildToolAction(tool: string, input: Record<string, unknown>): string {
  switch (tool) {
    case "read_document":
      return `Read document ${String(input.doc_id ?? "unknown")}`;
    case "find_in_document":
      return `Searched document ${String(input.doc_id ?? "unknown")} for "${String(input.query ?? "")}"`;
    case "list_documents":
      return "Listed available documents";
    case "fetch_documents":
      return `Fetched ${Array.isArray(input.doc_ids) ? input.doc_ids.length : 0} document(s)`;
    case "generate_docx":
      return `Generated document "${String(input.title ?? "untitled")}"`;
    case "edit_document":
      return `Edited document ${String(input.doc_id ?? "unknown")}`;
    case "replicate_document":
      return `Replicated document ${String(input.doc_id ?? "unknown")}`;
    case "apply_workflow":
      return `Applied workflow ${String(input.workflow_id ?? "unknown")}`;
    default:
      if (tool.startsWith("mcp_")) {
        return `Executed MCP tool ${tool}`;
      }
      if (tool.startsWith("courtlistener_")) {
        return `Executed CourtListener tool ${tool}`;
      }
      return `Executed ${tool}`;
  }
}

function resolveToolFilepath(
  call: NormalizedToolCall,
  docStoragePath?: (docLabel: string) => string | undefined,
): string | undefined {
  const docId = call.input.doc_id;
  if (
    (call.name === "read_document" || call.name === "find_in_document") &&
    typeof docId === "string" &&
    docStoragePath
  ) {
    return docStoragePath(docId);
  }
  if (call.name === "generate_docx" && typeof call.input.title === "string") {
    return call.input.title;
  }
  return undefined;
}

function buildToolNotes(
  tool: string,
  input: Record<string, unknown>,
  outputText: string,
): string {
  const parts = [summarizeText(outputText, "Tool output")];

  if (tool === "find_in_document") {
    try {
      const parsed = JSON.parse(outputText) as { total_matches?: number };
      if (typeof parsed.total_matches === "number") {
        parts.push(`${parsed.total_matches} match(es).`);
      }
    } catch {
      /* ignore */
    }
  }

  if (tool === "generate_docx" && typeof input.title === "string") {
    parts.push(`Title: ${input.title}.`);
  }

  if (tool.startsWith("mcp_")) {
    parts.push(`MCP tool ${tool}.`);
  }

  return parts.join(" ");
}

export function parseSseDataPayload(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data: ")) return null;
  const data = trimmed.slice(6).trim();
  if (!data || data === "[DONE]") return null;
  try {
    const parsed = JSON.parse(data) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* ignore malformed SSE payloads */
  }
  return null;
}

/** Formats SSE event payloads into the same strings shown in the chat UI. */
export function formatAgentStreamOutput(payload: Record<string, unknown>): {
  step: string;
  action: string;
  output: string;
  tool?: string;
  filepath?: string;
} | null {
  const type = payload.type;
  if (typeof type !== "string") return null;

  switch (type) {
    case "doc_find": {
      const query = String(payload.query ?? "");
      const filename = String(payload.filename ?? "");
      const total =
        typeof payload.total_matches === "number" ? payload.total_matches : 0;
      const matchLabel = total === 1 ? "1 match" : `${total} matches`;
      return {
        step: "doc_find",
        action: `Searched document for "${query}"`,
        output: `Found "${query}" (${matchLabel}) in ${filename}`,
        tool: "find_in_document",
        filepath: filename,
      };
    }
    case "doc_find_start": {
      const query = String(payload.query ?? "");
      const filename = String(payload.filename ?? "");
      return {
        step: "doc_find_start",
        action: `Searching document for "${query}"`,
        output: `Finding "${query}" in ${filename}...`,
        tool: "find_in_document",
        filepath: filename,
      };
    }
    case "doc_read": {
      const filename = String(payload.filename ?? "");
      return {
        step: "doc_read",
        action: "Read document",
        output: `Read ${filename}`,
        tool: "read_document",
        filepath: filename,
      };
    }
    case "doc_read_start": {
      const filename = String(payload.filename ?? "");
      return {
        step: "doc_read_start",
        action: "Reading document",
        output: `Reading ${filename}...`,
        tool: "read_document",
        filepath: filename,
      };
    }
    case "doc_created": {
      const filename = String(payload.filename ?? "");
      return {
        step: "doc_created",
        action: "Created document",
        output: `Created ${filename}`,
        tool: "generate_docx",
        filepath: filename,
      };
    }
    case "doc_created_start": {
      const filename = String(payload.filename ?? "");
      return {
        step: "doc_created_start",
        action: "Creating document",
        output: `Creating ${filename}...`,
        tool: "generate_docx",
        filepath: filename,
      };
    }
    case "doc_edited": {
      const filename = String(payload.filename ?? "");
      return {
        step: "doc_edited",
        action: "Edited document",
        output: `Edited ${filename}`,
        tool: "edit_document",
        filepath: filename,
      };
    }
    case "doc_edited_start": {
      const filename = String(payload.filename ?? "");
      return {
        step: "doc_edited_start",
        action: "Editing document",
        output: `Editing ${filename}...`,
        tool: "edit_document",
        filepath: filename,
      };
    }
    case "doc_replicated": {
      const filename = String(payload.filename ?? "");
      const count = typeof payload.count === "number" ? payload.count : 1;
      const suffix = count > 1 ? ` ${count} times` : "";
      return {
        step: "doc_replicated",
        action: "Replicated document",
        output: `Replicated ${filename}${suffix}`,
        tool: "replicate_document",
        filepath: filename,
      };
    }
    case "doc_replicate_start": {
      const filename = String(payload.filename ?? "");
      return {
        step: "doc_replicate_start",
        action: "Replicating document",
        output: `Replicating ${filename}...`,
        tool: "replicate_document",
        filepath: filename,
      };
    }
    case "workflow_applied": {
      const title = String(payload.title ?? payload.workflow_id ?? "workflow");
      return {
        step: "workflow_applied",
        action: "Applied workflow",
        output: `Applied Workflow ${title}`,
        tool: "apply_workflow",
      };
    }
    default:
      return null;
  }
}
