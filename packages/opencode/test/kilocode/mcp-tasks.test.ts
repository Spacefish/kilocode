import { describe, expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTaskStore } from "@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { McpCatalog } from "@/mcp/catalog"
import { Effect } from "effect"

const options = { toolCallId: "call_mcp", abortSignal: new AbortController().signal } as any

function mcpTool() {
  return {
    name: "screenshot",
    description: "Take a screenshot",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  } as any
}

describe("McpCatalog.convertTool tasks", () => {
  const taskTool = () => ({ ...mcpTool(), execution: { taskSupport: "optional" } })
  const stream = (messages: unknown[]) =>
    ({
      getServerCapabilities: () => ({ tasks: { requests: { tools: { call: {} } } } }),
      callTool: async () => {
        throw new Error("should not call callTool")
      },
      experimental: {
        tasks: {
          callToolStream: async function* () {
            yield* messages
          },
        },
      },
    }) as unknown as Client

  test("uses task streaming and returns the final result", async () => {
    const content = [{ type: "text" as const, text: "done" }]
    const client = stream([
      { type: "taskCreated", task: { taskId: "t1", status: "working" } },
      { type: "taskStatus", task: { taskId: "t1", status: "working" } },
      { type: "result", result: { content } },
    ])
    const output = await McpCatalog.convertTool(taskTool(), client).execute?.({}, options)
    expect(output).toMatchObject({ content })
  })

  test("rejects when the task is cancelled", async () => {
    const client = stream([{ type: "taskStatus", task: { taskId: "t1", status: "cancelled" } }])
    await expect(McpCatalog.convertTool(taskTool(), client).execute?.({}, options)).rejects.toThrow("cancelled")
  })

  test("falls back to callTool when the tool does not declare task support", async () => {
    const content = [{ type: "text" as const, text: "plain" }]
    const client = {
      getServerCapabilities: () => ({ tasks: { requests: { tools: { call: {} } } } }),
      callTool: async () => ({ content }),
    } as unknown as Client
    const output = await McpCatalog.convertTool(mcpTool(), client).execute?.({}, options)
    expect(output).toMatchObject({ content })
  })
})

test("runs a task-capable tool end to end against a real task server", async () => {
  const store = new InMemoryTaskStore()
  const server = new Server(
    { name: "tasks", version: "1.0.0" },
    {
      capabilities: { tools: {}, tasks: { requests: { tools: { call: {} } }, list: {}, cancel: {} } },
      taskStore: store,
    },
  )
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [{ ...mcpTool(), name: "build", execution: { taskSupport: "required" } }],
  }))
  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const task = await extra.taskStore!.createTask({ ttl: 10_000 })
    setTimeout(() => {
      void store.storeTaskResult(task.taskId, "completed", { content: [{ type: "text", text: "built" }] })
    }, 20)
    return { task } as any
  })
  const client = new Client({ name: "client", version: "1.0.0" }, { capabilities: { tasks: {} } })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(a), client.connect(b)])

  const defs = await Effect.runPromise(McpCatalog.defs(client))
  const output = await McpCatalog.convertTool(defs![0], client).execute?.({}, options)
  expect(output).toMatchObject({ content: [{ type: "text", text: "built" }] })
  await client.close()
  await server.close()
})

test("MCP.TaskStatus event is registered", async () => {
  const { McpEvent } = await import("@opencode-ai/schema/mcp-event")
  expect(McpEvent.TaskStatus.type).toBe("mcp.task.status")
  expect(McpEvent.Definitions).toContain(McpEvent.TaskStatus)
})
