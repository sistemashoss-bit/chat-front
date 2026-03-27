import OpenAI from "openai";
import { callMCPTool } from "@/lib/mcp-client";

const openai = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
});

export async function POST(req: Request) {
  const body = await req.json();
  
  let messages = [];
  if (body.messages && Array.isArray(body.messages)) {
    messages = body.messages;
  }
  
  const userMessage = messages.find((m: any) => m.role === "user");
  const userText = userMessage?.parts?.[0]?.text || userMessage?.content || "";
  
  if (!userText) {
    return new Response("No message found", { status: 400 });
  }

  let periodInfo = "";
  try {
    const periodResult = await callMCPTool("get_available_period", {});
    const period = JSON.parse(periodResult);
    periodInfo = `\n\nDATOS DISPONIBLES:\n- Fecha mínima: ${period.fecha_min}\n- Fecha máxima: ${period.fecha_max}\n- La fecha actual es 27 de marzo de 2026`;
  } catch (e) {
    periodInfo = "\n\n(No se pudo obtener información del período)";
  }

  const systemPrompt = `Eres un asistente que ayuda a analizar datos de ventas.${periodInfo}

REGLAS OBLIGATORIAS - SIEMPRE CUMPLIR:
- Tabla: ventas_items
- FECHA: usar siempre fecha_captura (no fecha)
- DUPLICADOS: si hay registros duplicados (mismo folio+item_index), usar solo el de synced_at más reciente
- SIEMPRE excluye: tipo_de_pago CONTIENE 'cancelado' 
- SIEMPRE excluye: tipo_de_pago CONTIENE 'instalación' (esto aplica también para puertas - nunca contar puertas con instalación)
- Tipos de productos:
  - PUERTAS: descripcion empieza con 'H-' o 'h-'
  - SEGUROS: descripcion CONTIENE 'seguro' o 'Seguro'
  - INSTALACIONES: descripcion empieza con 'Instalacion' o 'instalacion'
  - RESTO: cualquier otro producto
- Por defecto EXCLUYE seguros e instalaciones
- Búsquedas: usar LIKE con lower() para mayúsculas/minúsculas
- IMPORTANTE: NUNCA uses punto y coma (;) al final de las consultas SQL

Tienes acceso a estas herramientas:
- query_ventas: Ejecuta consultas SQL SELECT en la tabla de ventas
- get_schema: Muestra el esquema de la tabla de ventas
- get_sucursales: Lista las sucursales disponibles
- get_available_period: Muestra el rango de fechas con datos

Cuando el usuario pregunte sobre ventas, usa las herramientas para obtener los datos.`;

  const chatResponse = await openai.chat.completions.create({
    messages: [
      { role: "system", content: systemPrompt },
      ...messages.map((m: any) => ({
        role: m.role,
        content: m.parts?.[0]?.text || m.content || ""
      }))
    ],
    model: "x-ai/grok-4.1-fast",
    tools: [
      {
        type: "function",
        function: {
          name: "query_ventas",
          description: "Ejecuta consultas SQL SELECT en la tabla de ventas",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", description: "Consulta SQL" }
            },
            required: ["query"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "get_schema",
          description: "Muestra el esquema de la tabla",
          parameters: { type: "object", properties: {} }
        }
      },
      {
        type: "function",
        function: {
          name: "get_sucursales",
          description: "Lista las sucursales",
          parameters: { type: "object", properties: {} }
        }
      },
      {
        type: "function",
        function: {
          name: "get_available_period",
          description: "Muestra el rango de fechas",
          parameters: { type: "object", properties: {} }
        }
      }
    ],
    tool_choice: "auto",
    stream: false
  });

  console.log("Chat response:", JSON.stringify(chatResponse));

  const assistantMessage = chatResponse.choices?.[0]?.message;
  
  if (!assistantMessage) {
    return new Response("No response from model", { status: 500 });
  }

  let toolCalls = assistantMessage.tool_calls;
  const initialReasoning = (assistantMessage as any)?.reasoning || "";
  
  // If there's only one tool call (total), add breakdown queries automatically
  if (toolCalls && toolCalls.length === 1 && toolCalls[0]) {
    const func = (toolCalls[0] as any).function || toolCalls[0];
    if (func?.name === "query_ventas") {
      // Get the original query to extract filters
      let args = {};
      try {
        const argStr = typeof func.arguments === 'string' ? func.arguments : JSON.stringify(func.arguments || {});
        args = argStr ? JSON.parse(argStr) : {};
      } catch {}
      
      const originalQuery = args.query || "";
      
      // Add breakdown by product type queries
      const queries = [
        // Puertas
        originalQuery.replace("SELECT", "SELECT 'PUERTAS' as tipo, descripcion, SUM(cantidad) as cantidad FROM").replace("SELECT", "WITH data AS (").replace("GROUP BY", ") SELECT * FROM data GROUP BY"),
        // Resto (no H-, no seguro, no instalacion)
      ];
      
      // For now, let's just append the breakdown query as a second tool call
      // Actually, let's make the model do this by adding to the prompt
    }
  }
  
  // Parse tool calls from content if not in tool_calls field
  if (!toolCalls) {
    const content = assistantMessage?.content || "" + " " + initialReasoning;
    
    // Parse JSON format: {"tool": "query_ventas", "action": "run", "arguments": {...}}
    const jsonMatch = content.match(/"tool"\s*:\s*"(\w+)"[\s\S]*?"arguments"\s*:\s*({[^}]+})/);
    if (jsonMatch) {
      const toolName = jsonMatch[1];
      const argsStr = "{" + jsonMatch[2] + "}";
      try {
        const args = JSON.parse(argsStr.replace(/'/g, '"'));
        toolCalls = [{
          id: "tool_" + Date.now(),
          type: "function",
          function: { name: toolName, arguments: JSON.stringify(args) }
        }];
      } catch {}
    }
    
    // Parse XML format: <function=query_ventas><parameter=query>...
    if (!toolCalls) {
      const funcMatch = content.match(/<function=(\w+)>/);
      const paramMatch = content.match(/<parameter=(\w+)>([\s\S]*?)<\/parameter>/);
      if (funcMatch && paramMatch) {
        toolCalls = [{
          id: "tool_" + Date.now(),
          type: "function",
          function: {
            name: funcMatch[1],
            arguments: JSON.stringify({ [paramMatch[1]]: paramMatch[2].trim() })
          }
        }];
      }
    }
  }
  
  if (toolCalls && toolCalls.length > 0) {
    let allMessages = [
      { role: "system", content: systemPrompt },
      ...messages.map((m: any) => ({
        role: m.role,
        content: m.parts?.[0]?.text || m.content || ""
      }))
    ];

    let maxRounds = 6;
    let round = 0;
    let lastContent = "";
    let allToolResults: {query: string, result: string}[] = [];

    while (round < maxRounds) {
      const toolResults = [];
      
      for (const toolCall of toolCalls) {
        let result = "";
        let args = {};
        try {
          const func = (toolCall as any).function || toolCall;
          const argStr = typeof func.arguments === 'string' ? func.arguments : JSON.stringify(func.arguments || {});
          args = argStr ? JSON.parse(argStr) : {};
        } catch (e) { 
          console.log("Error parsing args:", e);
          args = {}; 
        }
        
        const func = (toolCall as any).function || toolCall;
        const toolName = func.name;
        
        if (toolName === "query_ventas") {
          result = await callMCPTool("query_ventas", args);
          const queryStr = (args as any).query || "";
          allToolResults.push({ query: queryStr, result: result });
          
          // Auto generate breakdown if this is a sales query
          if (queryStr.toLowerCase().includes('ventas') || queryStr.toLowerCase().includes('cantidad') || queryStr.toLowerCase().includes('puertas')) {
            try {
              // Extract filters from original query
              const whereMatch = queryStr.match(/WHERE\s+([\s\S]+?)(?:\s+GROUP|\s+ORDER|\s+LIMIT|\s*$)/i);
              let filters = whereMatch ? whereMatch[1] : "1=1";
              
              // Check if query has puertas filter
              const isPuertasQuery = queryStr.toLowerCase().includes("descripcion") && 
                (queryStr.toLowerCase().includes("h-%") || queryStr.toLowerCase().includes("like 'h"));
              
              // If puertas query, only get puertas in breakdown
              let descFilter = "";
              if (isPuertasQuery) {
                descFilter = "AND LOWER(descripcion) LIKE 'h-%'";
              }
              
              // Todas las descripciones (desglose completo)
              const descQuery = `SELECT descripcion, SUM(cantidad) as cantidad
              FROM ventas_items
              WHERE ${filters}
              ${descFilter}
              AND tipo_de_pago NOT ILIKE '%cancelado%'
              AND tipo_de_pago NOT ILIKE '%instalación%'
              GROUP BY descripcion
              ORDER BY cantidad DESC`;
              
              const descResult = await callMCPTool("query_ventas", { query: descQuery });
              allToolResults.push({ query: "desglose_descripcion", result: descResult });
            } catch (e) {
              console.log("Auto breakdown error:", e);
            }
          }
        } else if (toolName === "get_schema") {
          result = await callMCPTool("get_schema", {});
        } else if (toolName === "get_sucursales") {
          result = await callMCPTool("get_sucursales", {});
        } else if (toolName === "get_available_period") {
          result = await callMCPTool("get_available_period", {});
        }
        
        toolResults.push({ toolCallId: toolCall.id, result });
      }

      const assistantToolCalls = toolCalls.map((tc: any, i: number) => ({
        id: tc.id || `call_${i}`,
        type: "function" as const,
        function: {
          name: tc.function?.name || tc.name,
          arguments: typeof (tc.function?.arguments || tc.arguments) === 'string' ? tc.function.arguments : JSON.stringify(tc.function?.arguments || tc.arguments || {})
        }
      }));

      allMessages.push({ 
        role: "assistant" as const, 
        tool_calls: assistantToolCalls 
      });
      
      for (const tr of toolResults) {
        allMessages.push({ role: "tool" as const, tool_call_id: tr.toolCallId, content: tr.result });
      }

      const nextResponse = await openai.chat.completions.create({
        messages: allMessages,
        model: "x-ai/grok-4.1-fast"
      });

      const nextMessage = nextResponse.choices[0]?.message;
      console.log("Next round response:", JSON.stringify(nextMessage));
      
      let nextToolCalls = nextMessage?.tool_calls;
      
      // Save content in case we need to return it
      const contentToCheck = nextMessage?.content || "";
      const reasoningToCheck = (nextMessage as any)?.reasoning || "";
      
      // Also save reasoning as content if content is empty
      if (contentToCheck) {
        lastContent = contentToCheck;
      } else if (reasoningToCheck) {
        lastContent = reasoningToCheck;
      }
      
      if (!nextMessage) {
        return new Response(lastContent || "Error: No message from model", {
          headers: { "Content-Type": "text/plain" }
        });
      }
      
      // Parse tool calls from content or reasoning if not in tool_calls field
      if (!nextToolCalls) {
        const searchText = contentToCheck + " " + reasoningToCheck;
        
        // Try to find tool call in JSON format
        const toolMatch = searchText.match(/"tool"\s*:\s*"(\w+)"/);
        const argsMatch = searchText.match(/"arguments"\s*:\s*(\{[\s\S]*?\})/);
        
        console.log("searchText length:", searchText.length);
        console.log("Searching for tool in:", searchText.substring(0, 300));
        console.log("Tool match:", toolMatch);
        console.log("Args match:", argsMatch);
        
        if (toolMatch && argsMatch) {
          const toolName = toolMatch[1];
          let argsStr = argsMatch[1].replace(/\\n/g, ' ').replace(/\\"/g, '"').replace(/'/g, '"');
          try {
            const args = JSON.parse(argsStr);
            nextToolCalls = [{
              id: "tool_" + Date.now(),
              type: "function",
              function: { name: toolName, arguments: JSON.stringify(args) }
            }];
          } catch (e) {
            console.log("Failed to parse args:", e);
          }
        }
      }
      
      if (!nextToolCalls || nextToolCalls.length === 0) {
        // Build clean response from tool results
        if (allToolResults.length > 0) {
          let responseText = "";
          
          // First result - the main query
          const mainResult = allToolResults[0];
          try {
            const main = JSON.parse(mainResult.result);
            if (main.rows && main.rows.length > 0) {
              const firstRow = main.rows[0];
              // Try to find the total field
              const totalKey = Object.keys(firstRow).find(k => k.toLowerCase().includes('total') || k.toLowerCase().includes('sum'));
              if (totalKey) {
                responseText = `Total: ${firstRow[totalKey]}\n\n`;
              }
            }
          } catch {}
          
          // Find desglose_descripcion result
          const descResult = allToolResults.find(r => r.query === "desglose_descripcion");
          if (descResult) {
            try {
              const desc = JSON.parse(descResult.result);
              if (desc.rows && desc.rows.length > 0) {
                responseText += "Desglose por producto:\n";
                for (const row of desc.rows) {
                  responseText += `${row.descripcion}: ${row.cantidad}\n`;
                }
              }
            } catch {}
          }
          
          if (responseText) {
            return new Response(responseText, {
              headers: { "Content-Type": "text/plain" }
            });
          }
        }
        
        // Fallback: clean up response
        let responseText = (lastContent || reasoningToCheck || "Sin respuesta")
          .replace(/```[\s\S]*?```/g, '')
          .replace(/Detalle[\s\S]*/g, '')
          .replace(/Filtros[\s\S]*/g, '')
          .replace(/Nota[\s\S]*/g, '')
          .replace(/\*\*/g, '')
          .replace(/✅/g, '')
          .replace(/\n{3,}/g, '\n\n')
          .trim();
        
        if (responseText.length > 10) {
          return new Response(responseText, {
            headers: { "Content-Type": "text/plain" }
          });
        }
        
        return new Response(nextMessage?.content || lastContent || "Sin respuesta", {
          headers: { "Content-Type": "text/plain" }
        });
      }

      toolCalls = nextToolCalls;
      round++;
    }

    return new Response("Se alcanzaron múltiples rondas de herramientas", {
      headers: { "Content-Type": "text/plain" }
    });
  }

  return new Response(assistantMessage?.content || "Sin respuesta", {
    headers: { "Content-Type": "text/plain" }
  });
}
