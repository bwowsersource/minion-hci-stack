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

/** Messages the Vulkan backend raises when the driver itself fails (as opposed to a bad request). */
const GPU_DRIVER_ERROR = /vk::|vulkan|ErrorOutOfDeviceMemory|ErrorDeviceLost|device lost/i;

type ContextSlot ="decision" | "chat" | "longChat";
type BuiltContext<T> = { model: LlamaModel; value: T; dispose: () => unknown };
type CpuFallback = { from: LlamaModel; done: Promise<void> };

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
  /** The lazily created contexts, each remembering the model it was built on (see `getContext`). */
  private contexts = new Map<ContextSlot, Promise<BuiltContext<unknown>>>();
  /** Set once a GPU context failed (e.g. the driver can't allocate the buffers); the model is then reloaded on the CPU. */
  private cpuOnly = false;
  /** The one CPU fallback this runtime performs: the GPU model it replaced, and the reload in progress. */
  private fallback: CpuFallback | null = null;
  /** When the model load in progress began, so a failed GPU attempt can be timed apart from the CPU retry. */
  private loadStartedAt = 0;
  /** GPU attempts that failed before the CPU fallback, with the time each took. Empty when the first load worked. */
  readonly failedAttempts: { device: "gpu"; ms: number; error: string }[] = [];

  /**
   * `gpuLayers` caps how many layers node-llama-cpp offloads to the GPU (default: it decides
   * from the free VRAM); 0 keeps the model on the CPU.
   */
  constructor(
    private resolveModelPath: () => string | null,
    private options: { gpuLayers?: number | "auto" | "max" } = {},
  ) {}

  /** Loads the node-llama-cpp module + native binding, without a model file. */
  async ensureEngine(): Promise<void> {
    const { getLlama } = await llamaLib();
    await getLlama();
  }

  private getModel(): Promise<LlamaModel> {
    if (!this.modelPromise) {
      this.loadStartedAt = performance.now();
      this.modelPromise = (async () => {
        const modelPath = this.resolveModelPath();
        if (!modelPath) {
          throw new Error("The minion hasn't been downloaded yet — download it from Settings → Models.");
        }
        const { getLlama } = await llamaLib();
        const llama = await getLlama(this.cpuOnly ? { gpu: false } : undefined);
        return llama.loadModel({ modelPath, gpuLayers: this.options.gpuLayers });
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

  /**
   * Runs `create` against the loaded model. If it fails while the model is on the
   * GPU (typically a Vulkan allocation failure on a small or shared-memory GPU),
   * the model is reloaded CPU-only and `create` is retried once. The fallback
   * happens at most once and is shared: creators that fail concurrently, or that
   * were still using the replaced model, wait for the same reload and retry on it.
   */
  private async withModel<T>(
    create: (model: LlamaModel) => Promise<T>,
    fallBackOn: (error: unknown) => boolean = () => true,
  ): Promise<T> {
    const model = await this.getModel();
    try {
      return await create(model);
    } catch (error) {
      if (!fallBackOn(error)) throw error;
      const fallback = this.fallback ?? (model.gpuLayers ? this.fallBackToCpu(model, error) : null);
      if (!fallback || fallback.from !== model) throw error; // already on the CPU: nothing left to try
      await fallback.done;
      return create(await this.getModel());
    }
  }

  private fallBackToCpu(model: LlamaModel, error: unknown): CpuFallback {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[minion-hci-stack] GPU context failed (${reason}); retrying on the CPU.`);
    this.failedAttempts.push({ device: "gpu", ms: performance.now() - this.loadStartedAt, error: reason });
    this.cpuOnly = true;
    this.modelPromise = null;
    this.fallback = { from: model, done: model.dispose().catch(() => {}) };
    return this.fallback;
  }

  /**
   * The context for `slot`, created on first use. A context built on the GPU model
   * before the CPU fallback replaced it is dead, so it is recreated on the current
   * model instead of being handed out.
   */
  private async getContext<T>(
    slot: ContextSlot,
    create: (model: LlamaModel, chatWrapper: ChatWrapper) => Promise<T>,
    dispose: (value: T) => unknown,
  ): Promise<T> {
    let pending = this.contexts.get(slot) as Promise<BuiltContext<T>> | undefined;
    if (!pending) {
      const created: Promise<BuiltContext<T>> = (async () => {
        const chatWrapper = await this.getChatWrapper();
        return this.withModel(async (model) => {
          const value = await create(model, chatWrapper);
          return { model, value, dispose: () => dispose(value) };
        });
      })();
      created.catch(() => {
        if (this.contexts.get(slot) === created) this.contexts.delete(slot); // allow a retry instead of caching the failure
      });
      this.contexts.set(slot, created);
      pending = created;
    }
    const built = await pending;
    if (built.model.disposed) {
      if (this.contexts.get(slot) === pending) this.contexts.delete(slot);
      return this.getContext(slot, create, dispose);
    }
    return built.value;
  }

  private getDecisionContext(): Promise<LlamaDecisionContext> {
    return this.getContext(
      "decision",
      (model, chatWrapper) => model.createDecisionContext({ contextSize: { max: 2048 }, chatWrapper }),
      (context) => context.dispose(),
    );
  }

  private getChatSession(): Promise<LlamaChatSession> {
    return this.getContext(
      "chat",
      async (model, chatWrapper) => {
        const { LlamaChatSession } = await llamaLib();
        const context = await model.createContext({ contextSize: { max: 2048 } });
        return new LlamaChatSession({ contextSequence: context.getSequence(), chatWrapper });
      },
      (session) => session.dispose({ disposeSequence: true }),
    );
  }

  private getLongChatSession(): Promise<LlamaChatSession> {
    return this.getContext(
      "longChat",
      async (model, chatWrapper) => {
        const { LlamaChatSession } = await llamaLib();
        // "auto": as much context as the model was trained on and
        // available VRAM allow — the closest thing to "unlimited" node-
        // llama-cpp offers, since there's no literal unbounded option.
        const context = await model.createContext({ contextSize: "auto" });
        return new LlamaChatSession({ contextSequence: context.getSequence(), chatWrapper });
      },
      (session) => session.dispose({ disposeSequence: true }),
    );
  }

  /** Loads the model and the context `generateText` uses, so a caller can time loading apart from generating. */
  async load(): Promise<void> {
    await this.getChatSession();
  }

  /** Warms every context up front, so the first real call doesn't pay the full load cost. */
  async warmup(): Promise<void> {
    await Promise.all([this.getDecisionContext(), this.getChatSession(), this.getLongChatSession()]);
  }

  /**
   * Runs a generation, retrying it once on the CPU if the GPU driver fails mid-run. Loading a
   * model and creating its contexts can succeed on a GPU whose driver then fails on the first
   * real graph (Mali panvk: vk::CommandBuffer::end ErrorOutOfDeviceMemory / device lost), so
   * the context-creation fallback alone isn't enough. Only driver errors trigger it, so a
   * bad prompt or an abort isn't mistaken for a GPU fault. `run` fetches its own context, so
   * the retry gets one built on the CPU model.
   */
  private generate<T>(run: () => Promise<T>): Promise<T> {
    return this.withModel(run, (error) => GPU_DRIVER_ERROR.test(error instanceof Error ? error.message : String(error)));
  }

  async decideChoice(document: string, instruction: string, criteria: Record<string, string>): Promise<DecideChoiceResult> {
    const result = await this.generate(async () => {
      const decisionContext = await this.getDecisionContext();
      return decisionContext.decideWithMeta(document, {
        choice: { type: "choice", instruction, criteria },
      });
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
    return this.generate(async () => this.runPrompt(await this.getChatSession(), prompt, options, onUpdate));
  }

  /** Backs runChat — same one-shot prompting as generateText, just against the long-context session. */
  async generateChatText(
    prompt: string,
    options: { jsonMode: boolean; maxTokens?: number; temperature?: number },
    onUpdate?: (partialText: string) => void,
  ): Promise<GenerateTextResult> {
    return this.generate(async () => this.runPrompt(await this.getLongChatSession(), prompt, options, onUpdate));
  }

  async dispose(): Promise<void> {
    const built = await Promise.all([...this.contexts.values()].map((pending) => pending.catch(() => null)));
    this.contexts.clear();
    for (const context of built) {
      // contexts of a model the CPU fallback replaced are already gone with it
      if (context && !context.model.disposed) await context.dispose();
    }
    this.chatWrapperPromise = null;
    this.modelPromise = null;
  }
}
