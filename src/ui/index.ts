import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerUiResources } from "./resources.js";
import { registerUiTools } from "./tools.js";

export * from "./data.js";
export * from "./resources.js";
export { registerUiTools, revisePlan } from "./tools.js";

/** Register the inline MCP Apps views (ui:// resources) and their helper tools. */
export function registerUi(server: McpServer): void {
  registerUiResources(server);
  registerUiTools(server);
}
