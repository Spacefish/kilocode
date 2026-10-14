export * as McpEvent from "./mcp-event"

import { Schema } from "effect"
import { Event } from "./event"

export const ToolsChanged = Event.define({
  type: "mcp.tools.changed",
  schema: {
    server: Schema.String,
  },
})

export const BrowserOpenFailed = Event.define({
  type: "mcp.browser.open.failed",
  schema: {
    mcpName: Schema.String,
    url: Schema.String,
  },
})

// kilocode_change start - let HTTP clients take over opening the MCP OAuth authorization URL
export const AuthUrl = Event.define({
  type: "mcp.auth.url",
  schema: {
    mcpName: Schema.String,
    url: Schema.String,
  },
})

export const TaskStatus = Event.define({
  type: "mcp.task.status",
  schema: {
    server: Schema.String,
    taskId: Schema.String,
    status: Schema.String,
    statusMessage: Schema.optional(Schema.String),
  },
})

export const Definitions = Event.inventory(ToolsChanged, BrowserOpenFailed, AuthUrl, TaskStatus)
// kilocode_change end
