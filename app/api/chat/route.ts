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

OBLIGATORIO - después de obtener el total, SIEMPRE haz estas consultas adicionales:
1. Desglose por tipo: PUERTAS, SEGUROS, INSTALACIONES, RESTO (usa SUM(cantidad) por tipo)
2. Top 5 productos más vendidos (agrupa por descripcion, suma cantidad, ordena descendente)
3. Luego presenta TODOS los resultados juntos

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
    model: "openai/gpt-oss-120b:free",
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

    let maxRounds = 3;
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
        model: "openai/gpt-oss-120b:free"
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
        // If we have tool results, format them nicely with another LLM call
        if (allToolResults.length > 0) {
          try {
            const formatPrompt = `El usuario preguntó: "${userText}"

Resultados de las consultas realizadas:
${allToolResults.map((tr, i) => `Consulta ${i+1}: ${tr.result}`).join('\n\n')}}

PRESENTA LOS RESULTADOS de forma clara y amigable para el usuario. NO muestres las consultas SQL. Solo los datos relevantes y organizados en tablas si es necesario.`;

            const formatResponse = await openai.chat.completions.create({
              messages: [
                { role: "system", content: "Eres un asistente que presenta resultados de ventas de forma clara y profesional. Nunca muestres código SQL." },
                { role: "user", content: formatPrompt }
              ],
              model: "openai/gpt-oss-120b:free"
            });

            const formattedText = formatResponse.choices[0]?.message?.content;
            if (formattedText) {
              return new Response(formattedText, {
                headers: { "Content-Type": "text/plain" }
              });
            }
          } catch (e) {
            console.log("Error formatting:", e);
          }
        }
        
        // Return content or reasoning if there's no tool call
        const responseText = lastContent || reasoningToCheck || "Sin respuesta";
        if (responseText && responseText.length > 10) {
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
