/**
 * POST /api/agent/execute-tool
 * Called by OpenCode custom tools to run a tool in our backend and stream results to the session WebSocket.
 * Body: { workspaceId, chatSessionId?, callId?, tool, arguments }
 */
import { Router, type Request, type Response } from "express";
import { executeTool } from "../tool-router.js";
import { getSessionSocket } from "../websocket.js";
import { detectAndRegister, waitForPortReachable, setPreviewHost } from "../preview-manager.js";
import { detectRebuildFromOutput } from "../dev-server-manager.js";
import { registerRunningCommand, unregisterRunningCommand, killRunningCommand } from "../running-commands.js";
import type { ToolCall } from "../types/tools.js";

const router = Router();

/** POST /api/agent/kill-command — kill a running terminal command (e.g. when user clicks X). */
router.post("/agent/kill-command", (req: Request, res: Response): void => {
  const body = req.body as { workspaceId?: string; callId?: string };
  const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId.trim() : "";
  const callId = typeof body.callId === "string" ? body.callId.trim() : "";
  if (!workspaceId || !callId) {
    res.status(400).json({ success: false, error: "Missing workspaceId or callId" });
    return;
  }
  const killed = killRunningCommand(workspaceId, callId);
  res.json({ success: killed });
});

router.post("/agent/execute-tool", async (req: Request, res: Response): Promise<void> => {
  try {
    const body = req.body as {
      workspaceId?: string;
      chatSessionId?: string;
      callId?: string;
      tool?: string;
      arguments?: Record<string, unknown>;
    };
    const workspaceId = body.workspaceId;
    const chatSessionId = typeof body.chatSessionId === "string" ? body.chatSessionId : undefined;
    const callId = typeof body.callId === "string" ? body.callId : `tool-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const tool = typeof body.tool === "string" ? body.tool : "";
    const args = body.arguments && typeof body.arguments === "object" ? body.arguments : {};

    if (!workspaceId || !tool) {
      res.status(400).json({ success: false, error: "Missing workspaceId or tool" });
      return;
    }

    const ws = getSessionSocket(workspaceId, chatSessionId);
    const call: ToolCall = { callId, tool, args };

    // Send pending so the UI shows the tool card (pathStr: for read_file path, for file_search query, for web_search search_term)
    if (ws && ws.readyState === ws.OPEN) {
      const pathVal = tool === "file_search"
        ? (args.query ?? args.path)
        : tool === "web_search"
          ? (args.search_term ?? args.query ?? args.path)
          : (args.relative_workspace_path ?? args.path ?? args.target_file ?? args.file_path);
      const pathStr = typeof pathVal === "string" ? pathVal : (tool === "list_dir" ? "." : undefined);
      const command = (tool === "run_terminal_cmd" && (typeof args.command === "string" || typeof (args as { cmd?: string }).cmd === "string"))
        ? (args.command as string ?? (args as { cmd?: string }).cmd)
        : undefined;
      ws.send(
        JSON.stringify({
          type: "tool_call",
          callId,
          tool,
          pending: true,
          path: pathStr,
          command,
          content: undefined,
        })
      );
    }

    const result = await executeTool(workspaceId, call, {
      onSpawn(cid, kill) {
        if (tool === "run_terminal_cmd" && workspaceId) {
          registerRunningCommand(workspaceId, cid, kill);
        }
      },
      onStream(cid, chunk) {
        if (ws && ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: "tool_output_stream", callId: cid, chunk: String(chunk) }));
          if (tool === "run_terminal_cmd" && workspaceId) {
            const chunkStr = String(chunk);
            const port = detectAndRegister(workspaceId, chunkStr);
            if (port != null) {
              waitForPortReachable(port, 15000).then((host) => {
                if (host) setPreviewHost(workspaceId, host);
                if (ws && ws.readyState === ws.OPEN) {
                  ws.send(JSON.stringify({ type: "preview_ready", workspaceId, port, url: `http://localhost:${port}` }));
                }
              });
            }
            if (detectRebuildFromOutput(chunkStr)) {
              ws.send(JSON.stringify({ type: "preview_refresh", workspaceId }));
            }
          }
        }
      },
      onStreamEnd(cid, exitCode) {
        if (tool === "run_terminal_cmd" && workspaceId) {
          unregisterRunningCommand(workspaceId, cid);
        }
        if (ws && ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: "tool_output_end", callId: cid, exitCode: exitCode ?? undefined }));
        }
      },
    });

    if (tool === "run_terminal_cmd" && workspaceId && result.success && result.output) {
      const port = detectAndRegister(workspaceId, result.output);
      if (port != null && ws && ws.readyState === ws.OPEN) {
        waitForPortReachable(port, 15000).then((host) => {
          if (host) setPreviewHost(workspaceId, host);
          if (ws && ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: "preview_ready", workspaceId, port, url: `http://localhost:${port}` }));
          }
        });
      }
    }

    // Send completed tool_call to UI
    if (ws && ws.readyState === ws.OPEN) {
      const pathVal = tool === "file_search"
        ? (args.query ?? args.path)
        : tool === "web_search"
          ? (args.search_term ?? args.query ?? args.path)
          : (args.relative_workspace_path ?? args.target_file ?? args.path ?? args.file_path);
      const pathStr = typeof pathVal === "string" ? pathVal : (tool === "list_dir" ? "." : undefined);
      const command = (tool === "run_terminal_cmd" && (typeof args.command === "string" || typeof (args as { cmd?: string }).cmd === "string"))
        ? (args.command as string ?? (args as { cmd?: string }).cmd)
        : undefined;
      const payload: Record<string, unknown> = {
        type: "tool_call",
        callId: result.callId,
        tool: result.tool,
        pending: false,
        path: pathStr,
        content: result.success ? result.output : result.error,
        ...(command !== undefined && { command }),
        ...(result.exitCode !== undefined && { exitCode: result.exitCode }),
        ...(result.exitCode !== undefined && result.exitCode !== 0 && { failed: true }),
        ...(result.startLine !== undefined && { startLine: result.startLine }),
        ...(result.endLine !== undefined && { endLine: result.endLine }),
      };
      ws.send(JSON.stringify(payload));
    }

    // Return result to OpenCode (custom tool returns this to the model)
    if (result.success) {
      res.json({ success: true, output: result.output ?? "", exitCode: result.exitCode });
    } else {
      res.json({ success: false, error: result.error ?? "Tool failed", output: result.output });
    }
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    console.error("[execute-tool]", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
