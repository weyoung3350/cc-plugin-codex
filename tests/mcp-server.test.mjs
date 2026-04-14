import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

import {
  createMcpServer,
  RPC_ERROR,
} from "../plugins/cc/scripts/lib/mcp-server.mjs";

/**
 * Spin up a server bound to in-memory streams; returns helpers for driving
 * requests and reading responses line-by-line.
 */
function harness({ tools = [] } = {}) {
  const server = createMcpServer({ name: "test-server", version: "0.0.0" });
  for (const t of tools) server.registerTool(t);

  const input = new PassThrough();
  const output = new PassThrough();
  server.start({ input, output });

  /** @type {object[]} */
  const outbox = [];
  let buffer = "";
  output.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let idx;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.trim().length === 0) continue;
      outbox.push(JSON.parse(line));
    }
  });

  function send(obj) {
    input.write(JSON.stringify(obj) + "\n");
  }

  async function nextMessage() {
    for (let i = 0; i < 100; i++) {
      if (outbox.length > 0) return outbox.shift();
      await new Promise((r) => setTimeout(r, 2));
    }
    throw new Error("timeout waiting for message");
  }

  function close() {
    input.end();
    server.stop();
  }

  return { server, send, nextMessage, outbox, close };
}

test("initialize: matching protocolVersion echoed", async () => {
  const { send, nextMessage, close, server } = harness();
  try {
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05" },
    });
    const resp = await nextMessage();
    assert.equal(resp.id, 1);
    assert.equal(resp.result.protocolVersion, "2024-11-05");
    assert.equal(resp.result.serverInfo.name, "test-server");
    assert.equal(resp.result.serverInfo.version, "0.0.0");
    assert.ok(resp.result.capabilities.tools);
    assert.equal(server.isInitialized, true);
  } finally {
    close();
  }
});

test("initialize: different client version → server responds with its own", async () => {
  const { send, nextMessage, close } = harness();
  try {
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "1999-01-01" },
    });
    const resp = await nextMessage();
    assert.equal(resp.result.protocolVersion, "2024-11-05");
  } finally {
    close();
  }
});

test("initialize: missing protocolVersion → INVALID_PARAMS", async () => {
  const { send, nextMessage, close } = harness();
  try {
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const resp = await nextMessage();
    assert.equal(resp.error.code, RPC_ERROR.INVALID_PARAMS);
  } finally {
    close();
  }
});

test("tools/list returns registered tools", async () => {
  const { send, nextMessage, close } = harness({
    tools: [
      {
        name: "foo",
        description: "does foo",
        inputSchema: { type: "object", properties: { x: { type: "number" } } },
        handler: () => ({ content: [{ type: "text", text: "ok" }] }),
      },
    ],
  });
  try {
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
    await nextMessage();
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const resp = await nextMessage();
    assert.equal(resp.id, 2);
    assert.equal(resp.result.tools.length, 1);
    assert.equal(resp.result.tools[0].name, "foo");
    assert.equal(resp.result.tools[0].description, "does foo");
    assert.equal(resp.result.tools[0].inputSchema.type, "object");
  } finally {
    close();
  }
});

test("tools/call invokes handler and returns content", async () => {
  const { send, nextMessage, close } = harness({
    tools: [
      {
        name: "echo",
        description: "",
        inputSchema: { type: "object" },
        handler: (args) => ({
          content: [{ type: "text", text: JSON.stringify(args) }],
        }),
      },
    ],
  });
  try {
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
    await nextMessage();
    send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "echo", arguments: { hello: "world" } },
    });
    const resp = await nextMessage();
    assert.equal(resp.id, 2);
    assert.deepEqual(resp.result, {
      content: [{ type: "text", text: '{"hello":"world"}' }],
    });
  } finally {
    close();
  }
});

test("tools/call before initialize returns INVALID_REQUEST", async () => {
  const { send, nextMessage, close } = harness({
    tools: [
      {
        name: "x",
        description: "",
        inputSchema: { type: "object" },
        handler: () => ({ content: [{ type: "text", text: "" }] }),
      },
    ],
  });
  try {
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "x" },
    });
    const resp = await nextMessage();
    assert.equal(resp.error.code, RPC_ERROR.INVALID_REQUEST);
    assert.match(resp.error.message, /not initialized/);
  } finally {
    close();
  }
});

test("tools/call unknown tool returns METHOD_NOT_FOUND", async () => {
  const { send, nextMessage, close } = harness();
  try {
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
    await nextMessage();
    send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "ghost" },
    });
    const resp = await nextMessage();
    assert.equal(resp.error.code, RPC_ERROR.METHOD_NOT_FOUND);
    assert.match(resp.error.message, /ghost/);
  } finally {
    close();
  }
});

test("handler throws → result with isError=true, not JSON-RPC error", async () => {
  const { send, nextMessage, close } = harness({
    tools: [
      {
        name: "boom",
        description: "",
        inputSchema: { type: "object" },
        handler: () => {
          throw new Error("kaboom");
        },
      },
    ],
  });
  try {
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
    await nextMessage();
    send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "boom" },
    });
    const resp = await nextMessage();
    assert.equal(resp.id, 2);
    assert.equal(resp.result.isError, true);
    assert.match(resp.result.content[0].text, /kaboom/);
  } finally {
    close();
  }
});

test("handler returning non-content result → INTERNAL_ERROR", async () => {
  const { send, nextMessage, close } = harness({
    tools: [
      {
        name: "bad",
        description: "",
        inputSchema: { type: "object" },
        handler: () => ({}),
      },
    ],
  });
  try {
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
    await nextMessage();
    send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "bad" },
    });
    const resp = await nextMessage();
    assert.equal(resp.error.code, RPC_ERROR.INTERNAL_ERROR);
  } finally {
    close();
  }
});

test("ping returns empty result", async () => {
  const { send, nextMessage, close } = harness();
  try {
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
    await nextMessage();
    send({ jsonrpc: "2.0", id: 2, method: "ping" });
    const resp = await nextMessage();
    assert.equal(resp.id, 2);
    assert.deepEqual(resp.result, {});
  } finally {
    close();
  }
});

test("unknown method returns METHOD_NOT_FOUND", async () => {
  const { send, nextMessage, close } = harness();
  try {
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
    await nextMessage();
    send({ jsonrpc: "2.0", id: 2, method: "weird/thing" });
    const resp = await nextMessage();
    assert.equal(resp.error.code, RPC_ERROR.METHOD_NOT_FOUND);
  } finally {
    close();
  }
});

test("notifications are swallowed (no response)", async () => {
  const { send, nextMessage, outbox, close } = harness();
  try {
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
    await nextMessage();
    // initialized notification: no id, no response expected
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    // Ping after should still work — if notifications/initialized had been
    // treated as request, there'd be an error response in the queue.
    send({ jsonrpc: "2.0", id: 2, method: "ping" });
    const resp = await nextMessage();
    assert.equal(resp.id, 2);
    assert.equal(outbox.length, 0);
  } finally {
    close();
  }
});

test("parse error on invalid JSON yields PARSE_ERROR with null id", async () => {
  const { nextMessage, close, server } = harness();
  try {
    // Directly invoke _handleLine to avoid relying on stream framing.
    server._handleLine("{not valid json");
    const resp = await nextMessage();
    assert.equal(resp.id, null);
    assert.equal(resp.error.code, RPC_ERROR.PARSE_ERROR);
  } finally {
    close();
  }
});

test("wrong jsonrpc version rejected with INVALID_REQUEST", async () => {
  const { send, nextMessage, close } = harness();
  try {
    send({ jsonrpc: "1.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
    const resp = await nextMessage();
    assert.equal(resp.error.code, RPC_ERROR.INVALID_REQUEST);
  } finally {
    close();
  }
});

test("tools/call: arguments must be an object (array rejected)", async () => {
  const { send, nextMessage, close } = harness({
    tools: [
      {
        name: "x",
        description: "",
        inputSchema: { type: "object" },
        handler: () => ({ content: [{ type: "text", text: "" }] }),
      },
    ],
  });
  try {
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
    await nextMessage();
    send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "x", arguments: [1, 2, 3] },
    });
    const resp = await nextMessage();
    assert.equal(resp.error.code, RPC_ERROR.INVALID_PARAMS);
    assert.match(resp.error.message, /arguments must be an object/);
  } finally {
    close();
  }
});

test("tools/call: null arguments rejected", async () => {
  const { send, nextMessage, close } = harness({
    tools: [
      {
        name: "x",
        description: "",
        inputSchema: { type: "object" },
        handler: () => ({ content: [{ type: "text", text: "" }] }),
      },
    ],
  });
  try {
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
    await nextMessage();
    send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "x", arguments: null },
    });
    const resp = await nextMessage();
    assert.equal(resp.error.code, RPC_ERROR.INVALID_PARAMS);
  } finally {
    close();
  }
});

test("tools/call: omitted arguments treated as {}", async () => {
  const seen = [];
  const { send, nextMessage, close } = harness({
    tools: [
      {
        name: "x",
        description: "",
        inputSchema: { type: "object" },
        handler: (args) => {
          seen.push(args);
          return { content: [{ type: "text", text: "" }] };
        },
      },
    ],
  });
  try {
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
    await nextMessage();
    send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "x" },
    });
    await nextMessage();
    assert.deepEqual(seen[0], {});
  } finally {
    close();
  }
});

test("onClose fires when transport input ends", async () => {
  const { createMcpServer } = await import(
    "../plugins/cc/scripts/lib/mcp-server.mjs"
  );
  const { PassThrough } = await import("node:stream");
  const server = createMcpServer({ name: "x", version: "0.0.0" });
  const input = new PassThrough();
  const output = new PassThrough();
  let closedCount = 0;
  server.start({
    input,
    output,
    onClose: () => {
      closedCount += 1;
    },
  });
  assert.equal(closedCount, 0);
  input.end();
  // Give readline a tick to surface the 'close' event.
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(closedCount, 1);
  server.stop();
});

test("registerTool: duplicate name rejected", () => {
  const s = createMcpServer({ name: "x", version: "0.0.0" });
  const t = {
    name: "dup",
    description: "",
    inputSchema: { type: "object" },
    handler: () => ({ content: [] }),
  };
  s.registerTool(t);
  assert.throws(() => s.registerTool(t), /duplicate/);
});
