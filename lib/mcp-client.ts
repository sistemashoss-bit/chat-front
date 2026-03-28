const MCP_SERVER_URL = process.env.MCP_SERVER_URL || "http://localhost:8080";

export async function callMCPTool(
  toolName: string,
  args: Record<string, unknown> = {}
): Promise<string> {
  const startTime = Date.now();
  console.log(`[MCP → ] ${toolName}`, JSON.stringify(args).slice(0, 200));
  
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

  const duration = Date.now() - startTime;
  console.log(`[MCP ← ] ${toolName} (${duration}ms) status: ${response.status}`);
  
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`MCP error: ${response.status} - ${errorText}`);
  }

  const data = await response.json();

  if (data.result?.content?.[0]?.type === "text") {
    const text = data.result.content[0].text;
    console.log(`[MCP ← ] ${toolName} result:`, text.slice(0, 500));
    return text;
  }

  return JSON.stringify(data);
}
