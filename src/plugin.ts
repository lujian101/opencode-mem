import type { Plugin } from "@opencode-ai/plugin";
import { basename } from "path";
import { ClaudeMemClient } from "./client.js";
import { createCompactionHook } from "./hooks/compaction.js";
import { createContextInjectionHook } from "./hooks/context-inject.js";
import { createCapturePromptHook } from "./hooks/capture-prompt.js";
import { createSaveObservationHook } from "./hooks/save-observation.js";
import { createCommandExecuteHook } from "./hooks/command-execute.js";
import { createTextCompleteHook } from "./hooks/text-complete.js";
import { createSummaryHandler } from "./hooks/summary.js";
import { detectClaudeMem, getWorkerHost, getWorkerPort } from "./utils/detect.js";
import { autoSetup } from "./setup/auto-setup.js";
import { createDefaultDeps } from "./setup/types.js";
import type { PluginState } from "./types.js";

type PluginHooks = Awaited<ReturnType<Plugin>>;

type LogLevel = "info" | "warn" | "error";

interface PluginClientLike {
  app: {
    log(opts: { body: { service: string; message: string; level: LogLevel } }): void;
  };
}

type PluginFactories = {
  clientFactory: (port: number, timeout: number, log: (msg: string) => void, host?: string) => ClaudeMemClient;
  detectFn: () => Promise<{ installed: boolean; workerRunning: boolean }>;
  getPortFn: () => number;
  getHostFn: () => string;
  autoSetupFn: (deps: ReturnType<typeof createDefaultDeps>) => Promise<{ worker: { status: string } }>;
};

function resolveProjectName(project: unknown, directory: string): string {
  // Priority 1: Use worktree basename if available and valid
  if (typeof project === "object" && project !== null) {
    const worktree = (project as Record<string, unknown>).worktree;
    if (typeof worktree === "string" && worktree.length > 0) {
      const name = basename(worktree);
      if (name) return name;
    }
  }

  // Priority 2: Use directory basename
  if (directory && directory.length > 0) {
    const name = basename(directory);
    if (name) return name;
  }

  // Priority 3: Fallback to current working directory
  return basename(process.cwd());
}

function createLogger(client: PluginClientLike): { log: (msg: string, level?: LogLevel) => void; setReady: () => void } {
  let ready = false;

  const log = (msg: string, level: LogLevel = "info") => {
    if (!ready) return;
    try {
      client.app.log({
        body: {
          service: "opencode-mem",
          message: `[opencode-mem] ${msg}`,
          level,
        },
      });
    } catch {
      // Never crash plugin on logging failures.
    }
  };

  return {
    log,
    setReady: () => {
      ready = true;
    },
  };
}

function buildHooks(
  memClient: ClaudeMemClient,
  state: PluginState,
  projectName: string,
  port: number,
  cwd: string,
): PluginHooks {
  const summaryHandler = createSummaryHandler(memClient, state);
  const contextInjectionHook = createContextInjectionHook(memClient, projectName, port);

  return {
    event: async ({ event }) => {
      if (event.type === "session.created") {
        const newSessionId = event.properties.info.id;

        // If switching to a different session, complete the old one so the worker
        // marks it as completed and context injection can find it.
        if (state.sessionId && state.sessionId !== newSessionId) {
          void memClient.completeSession({ contentSessionId: state.sessionId });
        }

        // Reset all per-session state for the new session
        state.sessionId = newSessionId;
        state.summarySent = false;
        state.promptNumber = 0;
        state.lastUserMessage = "";
        state.lastAssistantMessage = "";
      }

      if (event.type === "session.deleted") {
        const sessionId = event.properties.info.id;

        if (sessionId) {
          if (!state.summarySent) {
            void memClient.sendSummary({
              contentSessionId: sessionId,
              last_assistant_message: state.lastAssistantMessage || undefined,
            });
            state.summarySent = true;
          }
          void memClient.completeSession({
            contentSessionId: sessionId,
          });
        }
      }

      await summaryHandler({ event });
    },
    "chat.message": createCapturePromptHook(memClient, state) as PluginHooks["chat.message"],
    "tool.execute.after": createSaveObservationHook(memClient, state, cwd) as PluginHooks["tool.execute.after"],
    "experimental.chat.system.transform": (async (input, output) => {
      try {
        // First: inject memory context (original behavior)
        await contextInjectionHook(input, output);

        // Then: prepend memory status block
        const status = await memClient.getMemoryStatus();
        let statusBlock: string;
        if (status.connected) {
          const version = status.version ? ` ${status.version}` : "";
          statusBlock = [
            "## \uD83E\uDDE0 Claude-Mem Status",
            `- Connection: \u2713 Active (${status.workerUrl})`,
            `- Worker Version:${version}`,
            "- Available Commands: /mem-search, /mem-save, /mem-status, /mem-timeline",
            `- Memory Viewer: ${status.workerUrl}`,
          ].join("\n");
        } else {
          statusBlock = [
            "## \uD83E\uDDE0 Claude-Mem Status",
            "- Connection: \u2717 Disconnected",
            "- Memory features unavailable. Start worker: claude-mem start",
          ].join("\n");
        }
        output.system.unshift(statusBlock);
      } catch {
        // Never crash \u2014 status display is best-effort
      }
    }) as PluginHooks["experimental.chat.system.transform"],
    "experimental.session.compacting": createCompactionHook(
      memClient,
      projectName,
    ) as PluginHooks["experimental.session.compacting"],
    "command.execute.before": createCommandExecuteHook(memClient, state, cwd) as PluginHooks["command.execute.before"],
    "experimental.text.complete": createTextCompleteHook(memClient, state, cwd) as PluginHooks["experimental.text.complete"],
  };
}


/**
 * OpenCodeMem - opencode plugin for claude-mem persistent memory.
 * Connects to the shared claude-mem worker (port 37777) and maps
 * opencode session lifecycle events to claude-mem hooks.
 */
const OpenCodeMem: Plugin = async ({ client, project, directory }) => {
  return initializePlugin(
    {
      clientFactory: (port, timeout, log, host) => new ClaudeMemClient(port, timeout, log, host),
      detectFn: detectClaudeMem,
      getPortFn: getWorkerPort,
      getHostFn: getWorkerHost,
      autoSetupFn: autoSetup,
    },
    { client, project, directory },
  );
};

// Internal function for testing - allows injecting mock client and detect functions
export function createPluginWithDependencies(
  clientFactory: (port: number, timeout: number, log: (msg: string) => void, host?: string) => ClaudeMemClient,
  detectFn?: () => Promise<{ installed: boolean; workerRunning: boolean }>,
  getPortFn?: () => number,
  autoSetupFn?: (deps: ReturnType<typeof createDefaultDeps>) => Promise<{ worker: { status: string } }>,
  getHostFn?: () => string,
): Plugin {
  return async ({ client, project, directory }) => {
    return initializePlugin(
      {
        clientFactory: clientFactory as PluginFactories["clientFactory"],
        detectFn: (detectFn || detectClaudeMem) as PluginFactories["detectFn"],
        getPortFn: (getPortFn || getWorkerPort) as PluginFactories["getPortFn"],
        getHostFn: (getHostFn || getWorkerHost) as PluginFactories["getHostFn"],
        autoSetupFn: (autoSetupFn || autoSetup) as PluginFactories["autoSetupFn"],
      },
      { client, project, directory },
    );
  };
}

// Alias for backward compatibility
export const createPluginWithClient = (
  clientFactory: (port: number, timeout: number, log: (msg: string) => void, host?: string) => ClaudeMemClient,
) =>
  createPluginWithDependencies(clientFactory);

async function initializePlugin(
  factories: PluginFactories,
  input: { client: PluginClientLike; project: unknown; directory: string },
): Promise<PluginHooks> {
  const { client, project, directory } = input;
  const port = factories.getPortFn();
  const host = factories.getHostFn();
  const projectName = resolveProjectName(project, directory);
  const logger = createLogger(client);

  const memClient = factories.clientFactory(port, 2000, logger.log, host);

  const state: PluginState = {
    isWorkerRunning: false,
    projectName,
    sessionId: "",
    promptNumber: 0,
    lastUserMessage: "",
    lastAssistantMessage: "",
    summarySent: false,
  };

  const detection = await factories.detectFn();
  state.isWorkerRunning = detection.workerRunning;

  if (detection.workerRunning) {
    logger.log(`Connected to claude-mem worker on port ${port}`);
    logger.log(`Memory viewer: http://${host}:${port}`);
  } else if (detection.installed) {
    logger.log("Claude-mem installed but worker not running. Memory features disabled.");
  } else {
    logger.log("Claude-mem not detected. Memory features disabled.");
  }

  const setupDeps = createDefaultDeps(logger.log);
  void factories
    .autoSetupFn(setupDeps)
    .then((result) => {
      if (result.worker.status === "success" && !state.isWorkerRunning) {
        state.isWorkerRunning = true;
        logger.log("Auto-setup started the worker. Memory features now active.");
      }
    })
    .catch((err) => {
      logger.log(`Auto-setup failed: ${err}`, "error");
    });

  logger.setReady();
  return buildHooks(memClient, state, projectName, port, directory);
}

export default OpenCodeMem;
export { OpenCodeMem };
export type { PluginState };
