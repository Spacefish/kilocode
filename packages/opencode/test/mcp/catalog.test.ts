import { describe, expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { McpCatalog } from "@/mcp/catalog"
import { Effect } from "effect"

const options = { toolCallId: "call_mcp", abortSignal: new AbortController().signal } as any

function clientReturning(result: unknown) {
  return {
    callTool: async () => result,
  } as unknown as Client
}

function mcpTool() {
  return {
    name: "screenshot",
    description: "Take a screenshot",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  } as any
}

describe("McpCatalog.convertTool", () => {
  test("preserves content when structuredContent is also present", async () => {
    const content = [{ type: "image" as const, mimeType: "image/png", data: "AAAA" }]
    const structuredContent = { image: { mimeType: "image/png", data: "AAAA" } }
    const converted = McpCatalog.convertTool(mcpTool(), clientReturning({ content, structuredContent }))

    const output = await converted.execute?.({}, options)

    expect(output).toMatchObject({ content, structuredContent })
  })

  test("falls back to structuredContent only when content is absent", async () => {
    const structuredContent = { results: [{ title: "one" }] }
    const converted = McpCatalog.convertTool(mcpTool(), clientReturning({ content: [], structuredContent }))

    const output = await converted.execute?.({}, options)

    expect(output).toMatchObject({
      structuredContent,
      content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    })
  })
})

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

test("preserves output schema validation across paginated tool discovery", async () => {
  const server = new Server({ name: "pagination", version: "1.0.0" }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, ({ params }) =>
    Promise.resolve(
      params?.cursor === "page-2"
        ? {
            tools: [
              {
                name: "second",
                inputSchema: { type: "object" },
                outputSchema: {
                  type: "object",
                  properties: { value: { type: "number" } },
                  required: ["value"],
                },
              },
            ],
          }
        : {
            tools: [
              {
                name: "first",
                inputSchema: { type: "object" },
                outputSchema: {
                  type: "object",
                  properties: { value: { type: "string" } },
                  required: ["value"],
                },
              },
            ],
            nextCursor: "page-2",
          },
    ),
  )
  server.setRequestHandler(CallToolRequestSchema, ({ params }) =>
    Promise.resolve({
      content: [],
      structuredContent: { value: params.name === "first" ? 42 : 1 },
    }),
  )

  const client = new Client({ name: "pagination-test", version: "1.0.0" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])

  try {
    const tools = await Effect.runPromise(McpCatalog.defs(client))
    expect(tools?.map((tool) => tool.name)).toEqual(["first", "second"])
    await expect(client.callTool({ name: "first", arguments: {} })).rejects.toThrow(
      "Structured content does not match the tool's output schema",
    )
  } finally {
    await Promise.all([client.close(), server.close()])
  }
})
