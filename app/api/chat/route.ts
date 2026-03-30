import OpenAI from "openai";
import { callMCPTool } from "@/lib/mcp-client";

const openai = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
});

export async function POST(req: Request) {
  const body = await req.json();
  let messages: any[] = body.messages || [];
  
  const userMessage = messages.find((m: any) => m.role === "user");
  const userText = userMessage?.parts?.[0]?.text || userMessage?.content || "";
  
  if (!userText) {
    return new Response("No message found", { status: 400 });
  }

  console.log("[CHAT]", userText);

  try {
    const period = await callMCPTool("get_available_period", {});
    const periodJson = JSON.parse(period);

    const today = new Date();
    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, "0");
    const currentMonth = `${year}-${month}`;
    const nextMonth = month === "12" ? `${year + 1}-01` : `${year}-${String(parseInt(month) + 1).padStart(2, "0")}`;

    const userLower = userText.toLowerCase();
    const isPrediccion = userLower.includes("predic") || userLower.includes("pronosti") || userLower.includes("van a vender") || userLower.includes("se vender") || userLower.includes("vender") || userLower.includes("predecir") || userLower.includes("forecast") || userLower.includes("proyect");
    const isPuertas = userLower.includes("puerta");
    
    if (isPrediccion && isPuertas) {
      const tools = [{
        type: "function",
        function: {
          name: "predict_puertas",
          description: "Predice ventas de puertas para N meses usando datos históricos",
          parameters: {
            type: "object",
            properties: {
              sucursal: { type: "string", description: "Nombre de la sucursal (ej: Altamisa, Leones). Omitir para total" },
              meses: { type: "number", description: "Cantidad de meses a predecir (ej: 1, 2, 3, 6)" }
            }
          }
        }
      }];
      
      const aiResponse = await openai.chat.completions.create({
        messages: [
          { role: "system", content: "Eres un asistente que extrae parámetros para predicciones. Extrae: 1) sucursal (nombre de tienda), 2) meses (número). Si no hay sucursal, usa null. Si no hay número, deduce: 'siguiente mes' = 1, 'próximos 3 meses' = 3, etc." },
          { role: "user", content: userText }
        ],
        model: "mistralai/mistral-small-2603",
        tools,
        tool_choice: { type: "function", function: { name: "predict_puertas" } }
      });
      
      const toolCall = aiResponse.choices[0]?.message?.tool_calls?.[0];
      const args = toolCall?.function?.arguments ? JSON.parse(toolCall.function.arguments) : {};
      const sucursal = args.sucursal || null;
      const meses = args.meses || 3;
      
      const predResult = await callMCPTool("predict_puertas", { sucursal, meses });
      const predJson = JSON.parse(predResult);
      
      if (!predJson.success) {
        return new Response(`Error: ${predJson.error}`, { status: 400 });
      }
      
      let responseText = `📊 PREDICCIÓN DE PUERTAS\n\n`;
      if (predJson.sucursal !== "total") {
        responseText += `Sucursal: ${predJson.sucursal}\n`;
      }
      responseText += `Meses predichos: ${predJson.meses_predecidos}\n\n`;
      
      for (const [puerta, data] of Object.entries(predJson.predicciones_por_puerta)) {
        responseText += `🚪 ${puerta}\n`;
        responseText += `   Método: ${data.metodo_usado}\n`;
        responseText += `   Predicciones:\n`;
        for (const p of data.predicciones) {
          responseText += `   - ${p.mes}: ${p.cantidad} unidades\n`;
        }
        responseText += `\n`;
      }
      
      return new Response(responseText, { headers: { "Content-Type": "text/plain" } });
    }

    const prompt = `Eres un ASISTENTE DE VENTAS de una ferretería. Tu trabajo es generar consultas SQL para responder preguntas sobre ventas.

TABLA: ventas_items
FECHA DISPONIBLE: ${periodJson.fecha_min} a ${periodJson.fecha_max}

COLUMNAS VÁLIDAS (SOLO USA ESTAS - NO INVENTES OTRAS):
- folio (string) - ID único de transacción
- item_index (integer) - Índice del item dentro del folio
- fecha_captura (date) - Fecha cuando se capturó en el sistema
- fecha (date) - Fecha de la venta
- departamento (string) - Departamento de la tienda
- cliente (string) - Nombre del cliente
- metodo_de_venta (string) - Método de venta (presencial, en línea, etc.)
- num_sucursal (integer) - Número de sucursal
- sucursal (string) - Nombre de la sucursal
- vendedor (string) - Nombre del vendedor
- cantidad (integer) - Cantidad de productos
- categoria (string) - Categoría del producto
- descripcion (string) - Descripción del producto
- precio_final (float) - Precio final de la venta
- tipo_de_pago (string) - Tipo de pago (efectivo, tarjeta, etc.)
- salida (string) - Tipo de salida
- comentario_cupon (string) - Comentario de cupón
- monto_cupon (float) - Monto del cupón
- synced_at (datetime) - Fecha de última sincronización

REGLAS:
1. SOLO usa las columnas de arriba
2. Para "este mes": fecha >= '${currentMonth}-01' AND fecha < '${nextMonth}-01'
3. Para suma de dinero: SUM(precio_final)
4. Para cantidad de productos: SUM(cantidad)
5. Para filtrar por método de pago usa tipo_de_pago: tipo_de_pago ILIKE '%[palabra del usuario%'
6. Para buscar productos en descripción: descripcion ILIKE '%[palabra%'
7. Para filtrar por sucursal SIEMPRE usa ILIKE: sucursal ILIKE '%Altamisa%' (no uses =)
8. Para ventas por sucursal: GROUP BY sucursal
9. Para ventas por categoría: GROUP BY categoria
10. IMPORTANTE: Si pregunta por puertas (códigos H-0101, H-001, etc): descripcion ILIKE 'H-%'. Si pregunta por cerraduras: descripcion ILIKE '%cerradura%'. Siempre incluye GROUP BY descripcion y SELECT descripcion, SUM(cantidad)

EJEMPLOS:
- "¿Cuánto vendí este mes?": SELECT SUM(precio_final) FROM ventas_items WHERE fecha >= '${currentMonth}-01' AND fecha < '${nextMonth}-01'
- "¿Cuántas puertas vendió Altamisa este mes?": SELECT descripcion, SUM(cantidad) as cantidad FROM ventas_items WHERE descripcion ILIKE 'H-%' AND sucursal ILIKE '%altamisa%' AND fecha >= '${currentMonth}-01' AND fecha < '${nextMonth}-01' GROUP BY descripcion ORDER BY cantidad DESC
- "¿Ventas por sucursal este mes?": SELECT sucursal, SUM(precio_final) FROM ventas_items WHERE fecha >= '${currentMonth}-01' AND fecha < '${nextMonth}-01' GROUP BY sucursal

Responde SOLO:
\`\`\`sql
SELECT...
\`\`\``;

    const aiResponse = await openai.chat.completions.create({
      messages: [
        { role: "system", content: prompt },
        { role: "user", content: userText + " [req:" + Date.now() + "]" }
      ],
      model: "mistralai/mistral-small-2603",
      temperature: 1,
      max_tokens: 500
    });

    const queryText = aiResponse.choices[0]?.message?.content || "";
    console.log("[AI] Response:", aiResponse.choices[0]?.message?.content);
    console.log("[SQL]", queryText);
    console.log("[SQL]", queryText);

    const sqlMatch = queryText.match(/```sql\n?([\s\S]*?)```/);
    let query = sqlMatch ? sqlMatch[1].trim() : queryText.trim();
    query = query.replace(/;$/, "").trim();

    const result = await callMCPTool("query_ventas", { query });
    const data = JSON.parse(result);
    
    console.log("[DATA]", JSON.stringify(data.rows));
    
    if (!data.success) {
      return new Response(`Error: ${data.error}`, { status: 400 });
    }

    const rowsText = JSON.stringify(data.rows);
    console.log("[RESULT]", rowsText);
    
    let value = "Sin datos";
    
    if (data.rows && data.rows.length > 0) {
      const firstRow = data.rows[0];
      
      if (data.rows.length === 1) {
        for (const key of Object.keys(firstRow)) {
          if (typeof firstRow[key] === "number") {
            value = String(firstRow[key]);
            break;
          }
        }
      } else {
        const keys = Object.keys(firstRow);
        const hasDesc = keys.includes("descripcion");
        
        if (hasDesc) {
          const hasCantidad = keys.includes("cantidad");
          const total = data.rows.reduce((sum: number, row: any) => sum + (row.total || row.sum || row.cantidad || 0), 0);
          if (hasCantidad) {
            const lines = data.rows.map((row: any) => `${row.descripcion}: ${row.cantidad}`);
            value = lines.join("\n") + `\nTotal: ${total}`;
          } else {
            const lines = data.rows.map((row: any) => `${row.descripcion}: ${row.total || row.sum || 0}`);
            value = `Total: ${total}\n` + lines.join("\n");
          }
        } else {
          value = JSON.stringify(data.rows, null, 2);
        }
      }
    }

    return new Response(value, {
      headers: { "Content-Type": "text/plain" }
    });

  } catch (error: any) {
    console.error("[ERROR]", error.message);
    return new Response(`Error: ${error.message}`, { status: 500 });
  }
}
