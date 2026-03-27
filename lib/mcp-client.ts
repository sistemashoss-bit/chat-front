const MCP_SERVER_URL = process.env.MCP_SERVER_URL || "http://localhost:8080";

export async function callMCPTool(
  toolName: string,
  args: Record<string, unknown> = {}
): Promise<string> {
  console.log("Calling MCP:", MCP_SERVER_URL, toolName, args);
  
  const response = await fetch(`${MCP_SERVER_URL}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      method: "tools/call",
      params: {
        name: toolName,
        arguments: args,
      },
    }),
  });

  console.log("MCP response status:", response.status);
  
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`MCP error: ${response.status} - ${errorText}`);
  }

  const data = await response.json();

  if (data.result?.content?.[0]?.type === "text") {
    return data.result.content[0].text;
  }

  return JSON.stringify(data);
}
