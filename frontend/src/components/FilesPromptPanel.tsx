import { useState, useRef, useEffect } from "react";
import { getAgentWebSocketUrl } from "../api/client";

interface FilesPromptPanelProps {
  workspaceId: string;
  onRefresh?: () => void;
}

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
}

export default function FilesPromptPanel({
  workspaceId,
  onRefresh: _onRefresh,
}: FilesPromptPanelProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [wsError, setWsError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const streamBufferRef = useRef<string>("");

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const sendMessage = () => {
    const text = input.trim();
    if (!text || streaming) return;

    const userMsg: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
    };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setStreaming(true);
    setWsError(null);

    const assistantId = crypto.randomUUID();
    setMessages((prev) => [
      ...prev,
      { id: assistantId, role: "assistant", content: "", streaming: true },
    ]);
    streamBufferRef.current = "";

    const url = getAgentWebSocketUrl();
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "run", workspaceId, message: text }));
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data as string);
        if (data.type === "chunk") {
          streamBufferRef.current += data.data ?? "";
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? { ...m, content: streamBufferRef.current }
                : m
            )
          );
        } else if (data.type === "end" || data.type === "error") {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId ? { ...m, streaming: false } : m
            )
          );
          setStreaming(false);
          ws.close();
        }
      } catch {
        // ignore
      }
    };

    ws.onerror = () => setWsError("WebSocket error");
    ws.onclose = () => {
      setStreaming(false);
      wsRef.current = null;
    };
  };

  const abortRun = () => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "abort", workspaceId }));
      wsRef.current.close();
    }
    setStreaming(false);
  };

  return (
    <div className="h-full flex flex-col bg-surface-800">
      {/* Chat section: "No file selected" + large "Ask OpenCode to..." input only */}
      <div className="flex-shrink-0 p-4 border-b border-surface-500">
        <p className="text-sm text-gray-500 mb-3">No file selected</p>
        <div className="flex gap-3 items-end">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
              }
            }}
            placeholder="Ask OpenCode to..."
            rows={4}
            className="flex-1 resize-none rounded-lg bg-surface-700 border border-surface-500 px-4 py-3 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent"
            disabled={streaming}
          />
          {streaming ? (
            <button
              onClick={abortRun}
              className="flex-shrink-0 px-4 py-3 rounded-lg bg-red-600/90 text-white text-sm font-medium hover:bg-red-600"
            >
              Stop
            </button>
          ) : (
            <button
              onClick={sendMessage}
              className="flex-shrink-0 px-4 py-3 rounded-lg bg-accent text-white text-sm font-medium hover:opacity-90"
            >
              Send
            </button>
          )}
        </div>
      </div>

      {/* Conversation */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {messages.length === 0 && (
          <p className="text-gray-500 text-sm">
            Ask OpenCode to build features, fix bugs, or explain code.
          </p>
        )}
        {messages.map((m) => (
          <div key={m.id} className={m.role === "user" ? "text-right" : "text-left"}>
            <span className="text-xs text-gray-500 block mb-1">
              {m.role === "user" ? "You" : "OpenCode"}
            </span>
            <div
              className={
                m.role === "user"
                  ? "inline-block text-sm bg-surface-600 rounded-lg px-4 py-2 text-left max-w-[85%]"
                  : "text-sm text-gray-300 whitespace-pre-wrap break-words"
              }
            >
              {m.content || (m.streaming ? "…" : "")}
            </div>
          </div>
        ))}
        {wsError && <p className="text-red-400 text-sm">{wsError}</p>}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
