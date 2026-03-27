"use client";

import { useState } from "react";

interface Message {
  role: "user" | "assistant";
  content: string;
}

export default function Home() {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);

  const sendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || loading) return;

    const userMessage = input;
    setInput("");
    setMessages(prev => [...prev, { role: "user", content: userMessage }]);
    setLoading(true);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [...messages, { role: "user", content: userMessage }]
        })
      });

      const text = await response.text();
      setMessages(prev => [...prev, { role: "assistant", content: text }]);
    } catch (error) {
      setMessages(prev => [...prev, { role: "assistant", content: "Error: " + error }]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-100 p-4">
      <div className="max-w-2xl mx-auto">
        <h1 className="text-2xl font-bold text-center mb-4 text-gray-800">
          Chat con datos de ventas
        </h1>

        <div className="bg-white rounded-lg shadow-lg h-[500px] overflow-y-auto p-4 mb-4">
          {messages.length === 0 && (
            <p className="text-gray-500 text-center">
              Pregunta sobre tus ventas...
            </p>
          )}
          {messages.map((m, i) => (
            <div key={i} className={`mb-4 ${m.role === "user" ? "text-right" : "text-left"}`}>
              <div className={`inline-block max-w-[80%] p-3 rounded-lg ${
                m.role === "user" ? "bg-blue-500 text-white" : "bg-gray-200 text-gray-800"
              }`}>
                <div className="whitespace-pre-wrap">{m.content}</div>
              </div>
            </div>
          ))}
          {loading && (
            <div className="text-left">
              <div className="inline-block bg-gray-200 p-3 rounded-lg">
                <span className="animate-pulse">Pensando...</span>
              </div>
            </div>
          )}
        </div>

        <form onSubmit={sendMessage} className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Escribe tu pregunta..."
            className="flex-1 p-3 border rounded-lg"
            disabled={loading}
          />
          <button
            type="submit"
            disabled={loading || !input.trim()}
            className="bg-blue-500 text-white px-6 py-3 rounded-lg disabled:opacity-50"
          >
            Enviar
          </button>
        </form>
      </div>
    </div>
  );
}
