import type { ChatWrapper, LlamaChatSession, LlamaDecisionContext, LlamaModel } from "node-llama-cpp";
import { loadRuntimeModule } from "./runtime";

// node-llama-cpp is never bundled and is loaded via
// runtime.ts, which unpacks it from the packaged build. It is imported on
// first use: a missing or broken install must fail this feature, not the whole
// app at startup.
const llamaLib = () => loadRuntimeModule<typeof import("node-llama-cpp")>("node-llama-cpp");

// Tells whichever chat-wrapper type node-llama-cpp resolves for the loaded
// GGUF to skip its reasoning/<think> phase, where that wrapper exposes a
// knob for it. DeepSeek-/Harmony-style wrappers have no such knob — for
// those, reasoning is structural to the architecture and can't be turned
// off this way.
const NON_THINKING_WRAPPER_SETTINGS = {
  qwen: { thoughts: "discourage" },
  gemma4: { reasoning: false },
  seed: { thinkingBudget: 0 },
  jinjaTemplate: { reasoning: false },
} as const;

export type DecideChoiceResult = {
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
  tokenUsage: { input: number; output: number };
};

export type GenerateTextResult = {
  generationMs: number;
  inputTokens: number;
  outputTokens: number;
  ttftMs: number | null;
  /** "length" means generation was cut off by maxTokens, not that the model produced bad output. */
  finishReason: "stop" | "length" | "tool_calls" | "content_filter" | null;
  generatedText: string;
};

/**
 * Runs the bundled minion via node-llama-cpp (a native llama.cpp
 * binding) in the bun backend, replacing the old wllama/WebGPU Worker that
 * used to run in the webview. Reads the GGUF `MinionRuntime` already
 * downloaded — this class never downloads anything itself.
 *
 * Three independent lazily-created pieces, sharing one loaded `LlamaModel`:
 * - a `LlamaDecisionContext` for `decideChoice` — single forward pass,
 *   reads raw next-token logits filtered to just the candidate tokens, no
 *   prompt-engineering tricks needed (see the type's own JSDoc upstream).
 *   Short document+instruction+criteria inputs only, so it keeps the small
 *   2048 context.
 * - a `LlamaChatSession` for `generateText` (backs runSingleShot) — real
 *   streaming multi-token generation for free-form text/JSON output
 *   (MCP tool selection, single-shot generation, etc.). Also kept at 2048:
 *   runSingleShot is the one-shot generation primitive, which is meant to
 *   stay short and fast; option-picking is decideChoice's job instead.
 * - a second `LlamaChatSession`, at a much larger (`"auto"`, effectively
 *   "as much as the model/VRAM allow") context, for generateChatText
 *   (backs runChat) — genuinely long input (e.g. whole file contents for
 *   a project overview) belongs on this one, not on the decision session.
 */
export class MinionInferenceRuntime {
  private modelPromise: Promise<LlamaModel> | null = null;
  private chatWrapperPromise: Promise<ChatWrapper> | null = null;
  private decisionContextPromise: Promise<LlamaDecisionContext> | null = null;
  private chatSessionPromise: Promise<LlamaChatSession> | null = null;
  private longChatSessionPromise: Promise<LlamaChatSession> | null = null;

  constructor(private resolveModelPath: () => string | null) {}

  /** Loads the node-llama-cpp module + native binding, without a model file. */
  async ensureEngine(): Promise<void> {
    const { getLlama } = await llamaLib();
    await getLlama();
  }

  private getModel(): Promise<LlamaModel> {
    if (!this.modelPromise) {
      this.modelPromise = (async () => {
        const modelPath = this.resolveModelPath();
        if (!modelPath) {
          throw new Error("The minion hasn't been downloaded yet — download it from Settings → Models.");
        }
        const { getLlama } = await llamaLib();
        const llama = await getLlama();
        return llama.loadModel({ modelPath });
      })().catch((error) => {
        this.modelPromise = null; // allow retrying after a failed load instead of caching the rejection forever
        throw error;
      });
    }
    return this.modelPromise;
  }

  private getChatWrapper(): Promise<ChatWrapper> {
    if (!this.chatWrapperPromise) {
      this.chatWrapperPromise = this.getModel()
        .then(async (model) => {
          const { resolveChatWrapper } = await llamaLib();
          return resolveChatWrapper(model, { customWrapperSettings: NON_THINKING_WRAPPER_SETTINGS });
        })
        .catch((error) => {
          this.chatWrapperPromise = null;
          throw error;
        });
    }
    return this.chatWrapperPromise;
  }

  private getDecisionContext(): Promise<LlamaDecisionContext> {
    if (!this.decisionContextPromise) {
      this.decisionContextPromise = Promise.all([this.getModel(), this.getChatWrapper()])
        .then(([model, chatWrapper]) => model.createDecisionContext({ contextSize: { max: 2048 }, chatWrapper }))
        .catch((error) => {
          this.decisionContextPromise = null;
          throw error;
        });
    }
    return this.decisionContextPromise;
  }

  private getChatSession(): Promise<LlamaChatSession> {
    if (!this.chatSessionPromise) {
      this.chatSessionPromise = Promise.all([this.getModel(), this.getChatWrapper()])
        .then(async ([model, chatWrapper]) => {
          const { LlamaChatSession } = await llamaLib();
          const context = await model.createContext({ contextSize: { max: 2048 } });
          return new LlamaChatSession({ contextSequence: context.getSequence(), chatWrapper });
        })
        .catch((error) => {
          this.chatSessionPromise = null;
          throw error;
        });
    }
    return this.chatSessionPromise;
  }

  private getLongChatSession(): Promise<LlamaChatSession> {
    if (!this.longChatSessionPromise) {
      this.longChatSessionPromise = Promise.all([this.getModel(), this.getChatWrapper()])
        .then(async ([model, chatWrapper]) => {
          const { LlamaChatSession } = await llamaLib();
          // "auto": as much context as the model was trained on and
          // available VRAM allow — the closest thing to "unlimited" node-
          // llama-cpp offers, since there's no literal unbounded option.
          const context = await model.createContext({ contextSize: "auto" });
          return new LlamaChatSession({ contextSequence: context.getSequence(), chatWrapper });
        })
        .catch((error) => {
          this.longChatSessionPromise = null;
          throw error;
        });
    }
    return this.longChatSessionPromise;
  }

  /** Warms every context up front, so the first real call doesn't pay the full load cost. */
  async warmup(): Promise<void> {
    await Promise.all([this.getDecisionContext(), this.getChatSession(), this.getLongChatSession()]);
  }

  async decideChoice(document: string, instruction: string, criteria: Record<string, string>): Promise<DecideChoiceResult> {
    const decisionContext = await this.getDecisionContext();
    const result = await decisionContext.decideWithMeta(document, {
      choice: { type: "choice", instruction, criteria },
    });
    const answer = result.answers.choice;
    return {
      choice: answer.choice,
      confidence: answer.confidence,
      probabilities: answer.probabilities,
      tokenUsage: result.tokenUsage,
    };
  }

  private async runPrompt(
    session: LlamaChatSession,
    prompt: string,
    options: { jsonMode: boolean; maxTokens?: number; temperature?: number },
    onUpdate?: (partialText: string) => void,
  ): Promise<GenerateTextResult> {
    // Each call is a one-shot, independent generation (no multi-turn memory
    // carried between runSingleShot/runChat/runMcpCall calls) — matches the
    // old worker.js rawGenerate's per-call semantics.
    session.resetChatHistory();

    const systemContent = options.jsonMode
      ? "Respond with exactly one JSON value and nothing else — no markdown, no explanation, no surrounding text."
      : "Respond directly to the user's message.";
    const combinedPrompt = `${systemContent}\n\n${prompt}`;

    const started = performance.now();
    let firstTokenAt: number | null = null;
    let accumulated = "";
    const initialMeter = session.sequence.tokenMeter.getState();

    const result = await session.promptWithMeta(combinedPrompt, {
      // This model can burn a chunk of a small token budget on hidden
      // reasoning before ever emitting the real answer — more of a problem
      // for JSON mode (truncates mid-structure, unparseable) than free text
      // (just reads as cut short), so JSON mode gets a bigger default.
      maxTokens: options.maxTokens ?? (options.jsonMode ? 1024 : 512),
      temperature: options.temperature ?? (options.jsonMode ? 0 : 0.7),
      onTextChunk: (chunk) => {
        if (firstTokenAt == null) firstTokenAt = performance.now();
        accumulated += chunk;
        onUpdate?.(accumulated);
      },
    });

    const { TokenMeter } = await llamaLib();

    const usage = TokenMeter.diff(session.sequence.tokenMeter.getState(), initialMeter);
    return {
      generationMs: performance.now() - started,
      inputTokens: usage.usedInputTokens,
      outputTokens: usage.usedOutputTokens,
      ttftMs: firstTokenAt == null ? null : firstTokenAt - started,
      finishReason: result.stopReason === "maxTokens" ? "length" : "stop",
      generatedText: result.responseText.trim(),
    };
  }

  /** Backs runSingleShot — short, fast, 2048-context generation. */
  async generateText(
    prompt: string,
    options: { jsonMode: boolean; maxTokens?: number; temperature?: number },
    onUpdate?: (partialText: string) => void,
  ): Promise<GenerateTextResult> {
    const session = await this.getChatSession();
    return this.runPrompt(session, prompt, options, onUpdate);
  }

  /** Backs runChat — same one-shot prompting as generateText, just against the long-context session. */
  async generateChatText(
    prompt: string,
    options: { jsonMode: boolean; maxTokens?: number; temperature?: number },
    onUpdate?: (partialText: string) => void,
  ): Promise<GenerateTextResult> {
    const session = await this.getLongChatSession();
    return this.runPrompt(session, prompt, options, onUpdate);
  }

  async dispose(): Promise<void> {
    const [decisionContext, chatSession, longChatSession] = await Promise.all([
      this.decisionContextPromise?.catch(() => null) ?? null,
      this.chatSessionPromise?.catch(() => null) ?? null,
      this.longChatSessionPromise?.catch(() => null) ?? null,
    ]);
    await decisionContext?.dispose();
    chatSession?.dispose({ disposeSequence: true });
    longChatSession?.dispose({ disposeSequence: true });
    this.decisionContextPromise = null;
    this.chatSessionPromise = null;
    this.longChatSessionPromise = null;
    this.chatWrapperPromise = null;
    this.modelPromise = null;
  }
}
