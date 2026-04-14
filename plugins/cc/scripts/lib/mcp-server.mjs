// Minimal MCP (Model Context Protocol) stdio server.
//
// Transport: newline-delimited JSON-RPC 2.0 over stdin/stdout.
// Implements: initialize, initialized (notification), tools/list, tools/call,
// ping.  Everything else returns JSON-RPC method-not-found.
//
// No shutdown message: per MCP spec 2024-11-05, stdio servers end when the
// transport closes. The library forwards readline "close" to an optional
// onClose callback; the binary entrypoint decides whether to process.exit().
//
// Zero dependencies — handwritten on purpose to keep the plugin deployable
// as a single Node script.
//
// Usage:
//   import { createMcpServer } from "./lib/mcp-server.mjs";
//   const server = createMcpServer({
//     name: "cc-plugin-codex",
//     version: "0.0.1",
//   });
//   server.registerTool({
//     name: "claude_health",
//     description: "...",
//     inputSchema: { type: "object", properties: {...}, additionalProperties: false },
//     handler: async (args) => ({ content: [{ type: "text", text: "..." }] }),
//   });
//   server.start();   // begins reading process.stdin

import readline from "node:readline";

const JSONRPC_VERSION = "2.0";
const PROTOCOL_VERSION = "2024-11-05";

// JSON-RPC error codes (https://www.jsonrpc.org/specification#error_object)
export const RPC_ERROR = Object.freeze({
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
});

/**
 * @typedef {object} ToolContent
 * @property {"text"|"json"} type
 * @property {string} [text]
 * @property {unknown} [json]
 *
 * @typedef {object} ToolCallResult
 * @property {ToolContent[]} content
 * @property {boolean} [isError]
 * @property {unknown} [structuredContent]
 *
 * @typedef {object} ToolRegistration
 * @property {string} name
 * @property {string} description
 * @property {object} inputSchema   JSON Schema describing tool arguments.
 * @property {(args: any, ctx: {request_id: string|number|null}) => Promise<ToolCallResult>|ToolCallResult} handler
 */

/**
 * @param {{ name: string, version: string, instructions?: string }} info
 */
export function createMcpServer(info) {
  if (!info || typeof info.name !== "string" || typeof info.version !== "string") {
    throw new Error("createMcpServer: info.name and info.version are required");
  }

  /** @type {Map<string, ToolRegistration>} */
  const tools = new Map();

  let initialized = false;
  /** Echoed back to clients (may differ from what client asked for). */
  let negotiatedVersion = PROTOCOL_VERSION;

  /** @type {NodeJS.WritableStream} */
  let out = process.stdout;
  /** @type {readline.Interface | null} */
  let rl = null;

  function registerTool(tool) {
    if (!tool || typeof tool.name !== "string" || typeof tool.handler !== "function") {
      throw new Error("registerTool: {name, handler} required");
    }
    if (tools.has(tool.name)) {
      throw new Error(`registerTool: duplicate tool name ${tool.name}`);
    }
    tools.set(tool.name, {
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: tool.inputSchema ?? { type: "object" },
      handler: tool.handler,
    });
  }

  function send(message) {
    try {
      out.write(JSON.stringify(message) + "\n");
    } catch (err) {
      // stdout closed; nothing useful we can do beyond surfacing on stderr.
      process.stderr.write(
        `mcp-server: failed to write response: ${String(err)}\n`,
      );
    }
  }

  function sendResult(id, result) {
    send({ jsonrpc: JSONRPC_VERSION, id, result });
  }

  function sendError(id, code, message, data) {
    /** @type {any} */
    const err = { code, message };
    if (data !== undefined) err.data = data;
    send({ jsonrpc: JSONRPC_VERSION, id, error: err });
  }

  async function handleInitialize(id, params) {
    // Protocol version negotiation (MCP spec 2024-11-05):
    //   - Client sends its supported protocolVersion.
    //   - Server responds with the version it will speak. Server MAY respond
    //     with a different version than the client asked for. If the client
    //     can't work with the server's response, it disconnects.
    //   - Missing/malformed protocolVersion → INVALID_PARAMS.
    const clientVersion = params?.protocolVersion;
    if (typeof clientVersion !== "string" || clientVersion.length === 0) {
      sendError(
        id,
        RPC_ERROR.INVALID_PARAMS,
        "initialize: params.protocolVersion (string) is required",
      );
      return;
    }
    // We currently speak exactly PROTOCOL_VERSION. We echo the client's
    // version if it matches; otherwise we respond with ours and let the
    // client decide whether to continue. This matches how the reference
    // Python/TS SDKs behave.
    negotiatedVersion =
      clientVersion === PROTOCOL_VERSION ? clientVersion : PROTOCOL_VERSION;
    initialized = true;
    sendResult(id, {
      protocolVersion: negotiatedVersion,
      capabilities: {
        tools: { listChanged: false },
      },
      serverInfo: {
        name: info.name,
        version: info.version,
      },
      instructions: info.instructions ?? undefined,
    });
  }

  function handleToolsList(id) {
    const list = [];
    for (const t of tools.values()) {
      list.push({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      });
    }
    sendResult(id, { tools: list });
  }

  async function handleToolsCall(id, params) {
    if (!params || typeof params.name !== "string") {
      sendError(id, RPC_ERROR.INVALID_PARAMS, "tools/call: name required");
      return;
    }
    const tool = tools.get(params.name);
    if (!tool) {
      sendError(id, RPC_ERROR.METHOD_NOT_FOUND, `unknown tool: ${params.name}`);
      return;
    }
    // Arguments must be a plain object (not array / primitive / null).
    const rawArgs = params.arguments;
    if (
      rawArgs !== undefined &&
      (rawArgs === null ||
        typeof rawArgs !== "object" ||
        Array.isArray(rawArgs))
    ) {
      sendError(
        id,
        RPC_ERROR.INVALID_PARAMS,
        "tools/call: arguments must be an object",
      );
      return;
    }
    const args = rawArgs ?? {};
    try {
      const result = await tool.handler(args, { request_id: id });
      if (!result || !Array.isArray(result.content)) {
        sendError(
          id,
          RPC_ERROR.INTERNAL_ERROR,
          `tool ${tool.name} returned invalid result (missing content[])`,
        );
        return;
      }
      sendResult(id, result);
    } catch (err) {
      // Tool threw: return as isError content per MCP convention, not
      // as a JSON-RPC error (caller is the Codex model, not a broken
      // protocol peer).
      const text = err instanceof Error ? (err.stack ?? err.message) : String(err);
      sendResult(id, {
        content: [{ type: "text", text: `tool ${tool.name} threw: ${text}` }],
        isError: true,
      });
    }
  }

  async function dispatch(message) {
    // Notifications have no id; requests have id.
    const isRequest =
      message && Object.prototype.hasOwnProperty.call(message, "id");
    const id = isRequest ? message.id : null;
    const method = message?.method;

    if (typeof method !== "string") {
      if (isRequest) sendError(id, RPC_ERROR.INVALID_REQUEST, "missing method");
      return;
    }

    // Notifications
    if (!isRequest) {
      if (method === "notifications/initialized" || method === "initialized") {
        // client signals initialization done; no-op for us
        return;
      }
      if (method === "notifications/cancelled" || method === "$/cancel") {
        // We don't support request cancellation yet — silently ignored.
        return;
      }
      // Unknown notification: spec says ignore.
      return;
    }

    try {
      switch (method) {
        case "initialize":
          await handleInitialize(id, message.params);
          return;
        case "ping":
          sendResult(id, {});
          return;
        case "tools/list":
          if (!initialized) {
            sendError(id, RPC_ERROR.INVALID_REQUEST, "not initialized");
            return;
          }
          handleToolsList(id);
          return;
        case "tools/call":
          if (!initialized) {
            sendError(id, RPC_ERROR.INVALID_REQUEST, "not initialized");
            return;
          }
          await handleToolsCall(id, message.params);
          return;
        default:
          sendError(
            id,
            RPC_ERROR.METHOD_NOT_FOUND,
            `unsupported method: ${method}`,
          );
      }
    } catch (err) {
      const text = err instanceof Error ? (err.stack ?? err.message) : String(err);
      sendError(id, RPC_ERROR.INTERNAL_ERROR, "internal error", { text });
    }
  }

  function handleLine(line) {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch (err) {
      sendError(null, RPC_ERROR.PARSE_ERROR, "invalid JSON");
      return;
    }
    if (!msg || msg.jsonrpc !== JSONRPC_VERSION) {
      sendError(
        msg?.id ?? null,
        RPC_ERROR.INVALID_REQUEST,
        "jsonrpc must be '2.0'",
      );
      return;
    }
    // Fire-and-forget: dispatch may be async but we don't await in the reader
    // so multiple inbound requests can overlap.
    dispatch(msg).catch((err) => {
      process.stderr.write(
        `mcp-server: dispatch threw: ${err?.stack ?? String(err)}\n`,
      );
    });
  }

  /**
   * @param {{
   *   input?: NodeJS.ReadableStream,
   *   output?: NodeJS.WritableStream,
   *   onClose?: () => void,
   * }} [options]
   */
  function start({
    input = process.stdin,
    output = process.stdout,
    onClose,
  } = {}) {
    out = output;
    rl = readline.createInterface({ input, crlfDelay: Infinity });
    rl.on("line", handleLine);
    rl.on("close", () => {
      if (typeof onClose === "function") onClose();
    });
  }

  function stop() {
    if (rl) {
      rl.close();
      rl = null;
    }
  }

  return {
    registerTool,
    start,
    stop,
    // Exposed for unit tests only.
    _dispatch: dispatch,
    _handleLine: handleLine,
    get isInitialized() {
      return initialized;
    },
    get toolCount() {
      return tools.size;
    },
  };
}
