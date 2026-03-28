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
    const [schema, period] = await Promise.all([
      callMCPTool("get_schema", {}),
      callMCPTool("get_available_period", {})
    ]);

    const schemaJson = JSON.parse(schema);
    const periodJson = JSON.parse(period);

    const today = new Date();
    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, "0");
    const currentMonth = `${year}-${month}`;
    
    const prompt = `SQL para: "${userText}"

TABLA: ventas_items
PERIODO: ${periodJson.fecha_min} a ${periodJson.fecha_max}

COLUMNAS: fecha, sucursal, cantidad, precio_final, descripcion, metodo_de_venta

Si pregunta por DINERO/TOTAL/VENDIO:
- USA: SUM(precio_final)
- Si filtra por método de pago: metodo_de_venta ILIKE '%efectivo%'

Si pregunta por PUERTAS:
- Filtro: descripcion LIKE 'H-%'
- GROUP BY descripcion

"este mes" = ${currentMonth}
SUCURSAL: sucursal ILIKE '%leones%'

Usa: SUM(precio_final), ILIKE, >= y <
NO: metodo_pago, JOIN, BETWEEN

Responde SOLO: \`\`\`sql\nSELECT...\n\`\`\``;

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
          const total = data.rows.reduce((sum: number, row: any) => sum + (row.total || row.sum || 0), 0);
          const lines = data.rows.map((row: any) => `${row.descripcion}: ${row.total || row.sum || 0}`);
          value = `Total: ${total}\n` + lines.join("\n");
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
