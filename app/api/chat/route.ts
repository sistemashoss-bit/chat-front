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

  const systemPrompt = `Eres un asistente de ventas. 

El usuario pregunta: "${userText}"

Responde SOLO con:
TOTAL: [numero]
[producto]: [cantidad]
[producto]: [cantidad]
...

Si pregunta por puertas: filtra solo descripciones que empiezan con H-
Excluye tipo_de_pago con "cancelado" o "instalación"
NO pongas filtros, notas ni código en la respuesta.`;

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

  return new Response(chatResponse.choices[0]?.message?.content || "Sin respuesta", {
    headers: { "Content-Type": "text/plain" }
  });
}
