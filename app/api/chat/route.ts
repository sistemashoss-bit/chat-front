import OpenAI from "openai";
import { callMCPTool } from "@/lib/mcp-client";

const openai = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
});

export async function POST(req: Request) {
  const body = await req.json();
  
  let messages: any[] = [];
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
    periodInfo = `\n\nFechas disponibles: ${period.fecha_min} a ${period.fecha_max}`;
  } catch {}

  const systemPrompt = `Eres un asistente de ventas.${periodInfo}

REGLAS:
- Tabla: ventas_items, fecha: fecha_captura
- SIEMPRE excluye: tipo_de_pago CONTIENE 'cancelado' o 'instalación'
- Si hay duplicados, usa el registro más reciente (ORDER BY synced_at DESC)
- Tipos: PUERTAS (descripcion LIKE 'H-%'), SEGUROS, INSTALACIONES, RESTO

CUANDO RESPONDAS A PREGUNTAS DE VENTAS:
1. Haz una sola consulta que traiga: total Y desglose por descripcion
2. NO pongas código SQL en la respuesta
3. Solo presenta los resultados de forma clara

Ejemplo de query:
SELECT descripcion, SUM(cantidad) as cantidad FROM ventas_items 
WHERE fecha_captura >= '2026-03-01' AND fecha_captura <= '2026-03-31' 
AND tipo_de_pago NOT ILIKE '%cancelado%' AND tipo_de_pago NOT ILIKE '%instalación%'
GROUP BY descripcion ORDER BY cantidad DESC`;

  const chatResponse = await openai.chat.completions.create({
    messages: [
      { role: "system", content: systemPrompt },
      ...messages.map((m: any) => ({
        role: m.role,
        content: m.parts?.[0]?.text || m.content || ""
      }))
    ],
    model: "x-ai/grok-4.1-fast"
  });

  const response = chatResponse.choices[0]?.message?.content || "Sin respuesta";
  
  // Clean response
  const cleaned = response
    .replace(/```[\s\S]*?```/g, '')
    .replace(/SELECT|INSERT|UPDATE|DELETE|WHERE|GROUP BY|ORDER BY|ILIKE|LIKE/gi, '')
    .replace(/\*\*.*?\*\*/g, '')
    .replace(/✅/g, '')
    .replace(/Filtros.*?Nota/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return new Response(cleaned, {
    headers: { "Content-Type": "text/plain" }
  });
}
