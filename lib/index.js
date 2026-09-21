import { LlmAdapter, contentHasImage } from "@deepseek-ai/dsh-llm";

/**
 * dsh-llm-router — the "auto" provider route.
 *
 * One LlmAdapter owns the route `auto` with the single model id `auto`.
 * On every request the adapter classifies the task from the assembled
 * GenerateOptions:
 *
 *   - any image block          -> visionBackend (the only vision-capable model)
 *   - input over the threshold -> longContextBackend (1M-token models)
 *   - otherwise                -> defaultBackend
 *
 * and then streams the request through that backend. If a backend fails
 * with a terminal failure BEFORE any content chunk was emitted (quota,
 * rate limit, transport error, missing credential, ...), the adapter moves
 * to the next candidate in the fallback chain instead of surfacing the
 * failure. Once one byte of content has been yielded the backend owns the
 * stream — a mid-stream failure surfaces normally, because retrying after
 * partial output has no durable attempt boundary.
 *
 * Routing decisions are logged through `ctx.logger`. Backend replay state
 * is stripped at the router boundary (the historical provider is `auto`,
 * the serving provider is the backend — replay must not impersonate it).
 */

export const name = "llm-router";
export const inject = ["llm", "webServer"];

const PROVIDER = "auto";
const MODEL = "auto";

/* -------------------------------------------------------- route log */

/** In-memory circular buffer of recent routing decisions (shared across all requests). */
const MAX_ROUTE_LOG = 200;
/** @type {{ id: number, ts: number, sessionId: string, kind: string, provider: string, model: string, fallbackIndex: number, affiliate: object|null }[]} */
const routeLog = [];
let routeIdCounter = 0;

/**
 * 返利提示表 —— **仅供参考展示，绝不参与路由决策**。
 *
 * 为什么内联查表，而不是运行时调用 dsh-client-ui-model-clock 的
 * `/api/model-clock/affiliate/resolve`：
 *   1. 本插件可能在 `tui` / `headless` profile 下运行 —— 那里没有 webServer，
 *      调不到对方的路由；而内联表在任何 profile 下都可用。
 *   2. 端口未知：web 场景监听 8787，换 profile 就变；靠环境变量传端口比内联表更脆弱。
 *   3. 查表**没有失败模式** —— 不会超时、不会被限流、不依赖对端是否安装。
 *
 * 代价是可能与权威源漂移。权威源是 dsh-client-ui-model-clock 的
 * `config/affiliate.json`；该校验脚本 `verify-router-hint-sync.mjs`
 * （放在 model-clock 仓库）会逐条比对两边，不一致即报错。
 * **改返利配置后必须重跑它。**
 *
 * ⚠️ 用词纪律：这是「提示」不是「推荐」。
 * 提示只能说「该平台有注册福利」，不得暗示「应该选它」。
 * 选择逻辑（`decide()` 的能力分类 + 配置里的 fallback 顺序）**完全不受影响** ——
 * 返利不得影响模型选择，这是本插件的硬约束。
 */
const AFFILIATE_HINTS = new Map([
  ["zai-coding-cn", { name: "智谱 BigModel", badge: "2000万Tokens", itemId: "zhipu-bigmodel-glm53" }],
  ["longcat", { name: "LongCat AI", badge: "送2000万Tokens", itemId: "longcat-ai" }],
]);

/**
 * 查该 provider 是否对应一个作者有推广关系的平台。
 *
 * 纯函数、无 IO —— 调用它不会产生任何失败模式。
 * 返回 null 表示「没有推广关系」，也覆盖「没配到」的情况，两者对调用方无区别。
 *
 * @param {string} provider dsh 的 provider id（不是厂商名，两套命名不同）
 * @returns {{name: string, badge: string, itemId: string}|null}
 */
function lookupAffiliate(provider) {
  if (typeof provider !== "string" || !provider) return null;
  return AFFILIATE_HINTS.get(provider) ?? null;
}

function recordRoute(sessionId, kind, provider, model, fallbackIndex, affiliate) {
  const entry = {
    id: ++routeIdCounter,
    ts: Date.now(),
    sessionId: (typeof sessionId === "string") ? sessionId : "",
    kind,
    provider,
    model,
    fallbackIndex: fallbackIndex ?? 0,
    /**
     * 该 backend 对应的平台是否与作者有推广关系（只用于界面提示）。
     *
     * 刻意与 `provider` / `model` 平级而非嵌套进 `decision` ——
     * 它在语义上属于「记录到的附加信息」，不属于「选择结果」。
     * 任何消费端都应只把它当作展示素材，不得据此重排或推荐模型。
     */
    affiliate: affiliate ?? null,
  };
  routeLog.push(entry);
  while (routeLog.length > MAX_ROUTE_LOG) routeLog.shift();
  return entry;
}

/** Query recent routes, optionally filtered by sessionId (prefix match). */
function queryRoutes(options) {
  const { sessionId, limit = 50 } = options ?? {};
  let list = routeLog;
  if (sessionId) {
    list = list.filter((r) => r.sessionId === sessionId || r.sessionId.startsWith(sessionId));
  }
  return list.slice(-limit).reverse(); // newest first
}

/* ---------------------------------------------------------------- config */

const DEFAULT_CONFIG = {
  defaultBackend: { provider: "deepseek-official", model: "deepseek-v4-pro" },
  visionBackend: { provider: "zai-coding-cn", model: "glm-5v-turbo" },
  longContextBackend: { provider: "longcat", model: "LongCat-2.0" },
  longContextCharThreshold: 200000,
  fallbacks: [
    { provider: "kimi-coding", model: "kimi-for-coding" },
    { provider: "zai-coding-cn", model: "glm-5-turbo" },
    { provider: "zai-coding-cn", model: "glm-5.2" },
    { provider: "zai-coding-cn", model: "glm-4.5-air" },
    { provider: "minimax-cn", model: "MiniMax-M2.7" },
    { provider: "longcat", model: "LongCat-2.0" },
  ],
  advertisedContextWindow: 1000000,
  defaultReasoningEffort: "high",
};

/** Accept `{provider, model}` objects and `"provider/model"` strings. */
function normalizeBackend(value, fallback) {
  if (typeof value === "string") {
    const slash = value.indexOf("/");
    if (slash > 0) {
      const provider = value.slice(0, slash).trim();
      const model = value.slice(slash + 1).trim();
      if (provider && model) return { provider, model };
    }
    return fallback;
  }
  if (
    value !== null && typeof value === "object" &&
    typeof value.provider === "string" && value.provider.length > 0 &&
    typeof value.model === "string" && value.model.length > 0
  ) {
    return { provider: value.provider, model: value.model };
  }
  return fallback;
}

function resolveConfig(config) {
  const c = config ?? {};
  const fallbacks = Array.isArray(c.fallbacks)
    ? dedupe(c.fallbacks.map((entry) => normalizeBackend(entry, null)).filter(Boolean))
    : DEFAULT_CONFIG.fallbacks.map((entry) => ({ ...entry }));
  return {
    defaultBackend: normalizeBackend(c.defaultBackend, DEFAULT_CONFIG.defaultBackend),
    visionBackend: normalizeBackend(c.visionBackend, DEFAULT_CONFIG.visionBackend),
    longContextBackend: normalizeBackend(c.longContextBackend, DEFAULT_CONFIG.longContextBackend),
    longContextCharThreshold:
      Number.isFinite(c.longContextCharThreshold) && c.longContextCharThreshold > 0
        ? c.longContextCharThreshold
        : DEFAULT_CONFIG.longContextCharThreshold,
    fallbacks,
    advertisedContextWindow:
      Number.isFinite(c.advertisedContextWindow) && c.advertisedContextWindow > 0
        ? c.advertisedContextWindow
        : DEFAULT_CONFIG.advertisedContextWindow,
    defaultReasoningEffort:
      typeof c.defaultReasoningEffort === "string"
        ? c.defaultReasoningEffort
        : DEFAULT_CONFIG.defaultReasoningEffort,
  };
}

/* --------------------------------------------------------- classification */

function backendKey(backend) {
  return `${backend.provider}/${backend.model}`;
}

function dedupe(backends) {
  const seen = new Set();
  const result = [];
  for (const backend of backends) {
    if (!backend) continue;
    const key = backendKey(backend);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(backend);
  }
  return result;
}

function requestHasImage(options) {
  for (const message of options.messages ?? []) {
    if (contentHasImage(message.content ?? [])) return true;
  }
  return false;
}

function blocksChars(blocks) {
  let chars = 0;
  for (const block of blocks ?? []) {
    if (block.type === "text" || block.type === "reasoning") {
      chars += block.text?.length ?? 0;
    } else if (block.type === "tool-call") {
      chars += (block.name?.length ?? 0) + (block.arguments?.length ?? 0);
    } else if (block.type === "tool-result") {
      if (typeof block.content === "string") chars += block.content.length;
      else if (Array.isArray(block.content)) chars += blocksChars(block.content);
    }
  }
  return chars;
}

function estimateInputChars(options) {
  let chars = options.system?.length ?? 0;
  for (const message of options.messages ?? []) {
    chars += blocksChars(message.content ?? []);
  }
  return chars;
}

/**
 * Pick the candidate chain for one request.
 * Vision requests do not fall back: no other configured model takes images.
 */
function decide(options, config) {
  if (requestHasImage(options)) {
    return { kind: "vision", backends: dedupe([config.visionBackend]) };
  }
  const chars = estimateInputChars(options);
  if (chars >= config.longContextCharThreshold) {
    return {
      kind: "long-context",
      backends: dedupe([config.longContextBackend, config.defaultBackend, ...config.fallbacks]),
    };
  }
  return { kind: "default", backends: dedupe([config.defaultBackend, ...config.fallbacks]) };
}

/* ---------------------------------------------------------------- helpers */

function toFailure(error) {
  if (error !== null && typeof error === "object" && typeof error.code === "string") {
    return { message: String(error.message ?? error.code), code: error.code };
  }
  return { message: String(error?.message ?? error), code: "TRANSPORT" };
}

function failureFinish(code, message) {
  return { type: "finish", reason: { kind: "error", failure: { message, code } } };
}

function abortedFinish() {
  return {
    type: "finish",
    reason: { kind: "aborted", failure: { message: "aborted", code: "ABORTED" } },
  };
}

/** Strip backend replay state: it belongs to the backend adapter, not to `auto`. */
function sanitizeFinish(chunk) {
  if (chunk?.type === "finish" && chunk.replayState !== undefined) {
    return { type: "finish", reason: chunk.reason };
  }
  return chunk;
}

/* ----------------------------------------------------------------- adapter */

class RouterAdapter extends LlmAdapter {
  constructor(ctx, config) {
    super();
    this.ctx = ctx;
    this.config = config;
  }

  providerInfo(provider) {
    return { id: provider, name: "Auto" };
  }

  listModels(provider) {
    return Promise.resolve([
      {
        provider,
        id: MODEL,
        name: "Auto",
        description: "按任务自动路由：图片 / 长上下文 / 默认，失败自动切换后备模型",
        inputModalities: ["text", "image"],
      },
    ]);
  }

  resolveModel(provider, model) {
    return Promise.resolve({
      provider,
      id: model,
      name: model === MODEL ? "Auto" : model,
      inputModalities: ["text", "image"],
      context: { contextWindow: this.config.advertisedContextWindow },
      reasoning: {
        efforts: [
          { id: "off", name: "Off" },
          { id: "high", name: "High" },
          { id: "max", name: "Max" },
        ],
        defaultEffort: this.config.defaultReasoningEffort,
      },
    });
  }

  /** Drop a reasoning effort the chosen backend cannot serve. */
  async clampEffort(backendOptions) {
    const effort = backendOptions.reasoningEffort;
    if (effort === undefined) return;
    try {
      const info = await this.ctx.llm.resolveModelInfo(
        backendOptions.provider,
        backendOptions.model,
        backendOptions.signal,
      );
      const efforts = info?.reasoning?.efforts ?? [];
      if (!efforts.some((entry) => entry.id === effort)) {
        this.ctx.logger?.warn(
          "llm-router: backend %s/%s does not serve reasoning effort %s — using its own default",
          backendOptions.provider,
          backendOptions.model,
          effort,
        );
        delete backendOptions.reasoningEffort;
      }
    } catch {
      // Metadata lookup failed (e.g. unregistered route): pass the effort
      // through and let the backend request fail or serve on its own.
    }
  }

  async *stream(options) {
    const decision = decide(options, this.config);
    this.ctx.logger?.info(
      "llm-router: %s request -> %s",
      decision.kind,
      decision.backends.map(backendKey).join(" -> "),
    );
    let lastFailure = null;
    for (const backend of decision.backends) {
      if (backend.provider === PROVIDER) {
        yield failureFinish("NO_ROUTE", "llm-router: a routing loop was configured (auto -> auto)");
        return;
      }
      if (options.signal?.aborted) {
        yield abortedFinish();
        return;
      }
      const backendOptions = { ...options, provider: backend.provider, model: backend.model };
      await this.clampEffort(backendOptions);
      let iterator;
      try {
        iterator = this.ctx.llm.stream(backendOptions)[Symbol.asyncIterator]();
      } catch (error) {
        lastFailure = toFailure(error);
        this.ctx.logger?.warn(
          "llm-router: backend %s failed to open (%s) — trying next",
          backendKey(backend),
          lastFailure.code,
        );
        continue;
      }
      let closed = false;
      const close = async () => {
        if (closed) return;
        closed = true;
        await iterator.return?.().catch(() => {});
      };
      let adopted = false;
      try {
        const first = await iterator.next();
        if (first.done) {
          lastFailure = { message: `llm-router: ${backendKey(backend)} produced no output`, code: "EMPTY_RESPONSE" };
          await close();
          continue;
        }
        const chunk = sanitizeFinish(first.value);
        if (chunk.type === "finish" && (chunk.reason.kind === "error" || chunk.reason.kind === "aborted")) {
          lastFailure = chunk.reason.failure;
          await close();
          this.ctx.logger?.warn(
            "llm-router: backend %s failed cleanly (%s) — trying next",
            backendKey(backend),
            lastFailure.code,
          );
          continue;
        }
        adopted = true;
        // Record which backend actually served this request.
        const fallbackIdx = decision.backends.indexOf(backend);
        /**
         * 返利提示**只在「已选中」之后查询** —— 这个时序是刻意的：
         * 查询发生在 decide() 与 fallback 循环都已定论之后，
         * 所以它在结构上不可能影响本次选择（不是「小心不去用它」，而是「用不到」）。
         */
        const affiliate = lookupAffiliate(backend.provider);
        recordRoute(options.sessionId ?? "", decision.kind, backend.provider, backend.model, fallbackIdx, affiliate);
        this.ctx.logger?.info(
          "llm-router: [%s] %s -> %s/%s (fallback #%d)",
          options.sessionId ?? "?",
          decision.kind,
          backend.provider,
          backend.model,
          fallbackIdx,
        );
        if (affiliate) {
          this.ctx.logger?.info(
            "llm-router: [%s] 提示：%s 是作者有推广关系的平台（%s）。仅为展示提示，未参与本次选择。",
            options.sessionId ?? "?",
            affiliate.name,
            affiliate.badge,
          );
        }
        yield chunk;
        for await (const rest of iterator) {
          yield sanitizeFinish(rest);
        }
        closed = true;
        return;
      } catch (error) {
        if (adopted) throw error; // mid-stream failure after content: surface it
        lastFailure = toFailure(error);
        this.ctx.logger?.warn(
          "llm-router: backend %s failed during open (%s) — trying next",
          backendKey(backend),
          lastFailure.code,
        );
        continue;
      } finally {
        if (!closed) await close();
      }
    }
    yield failureFinish(
      lastFailure?.code ?? "NO_ROUTE",
      lastFailure?.message ?? "llm-router: no backend route available",
    );
  }
}

/* ----------------------------------------------------------------- plugin */

export function apply(ctx, config) {
  const resolved = resolveConfig(config);
  ctx.logger?.info(
    "llm-router: auto route ready — default=%s vision=%s longContext=%s (threshold=%d chars, fallbacks=%d)",
    backendKey(resolved.defaultBackend),
    backendKey(resolved.visionBackend),
    backendKey(resolved.longContextBackend),
    resolved.longContextCharThreshold,
    resolved.fallbacks.length,
  );
  // Registration is disposed with this plugin's fiber.
  ctx.llm.registerAdapter([PROVIDER], new RouterAdapter(ctx, resolved));

  // HTTP API: expose recent routing decisions for the route-badge client plugin.
  ctx.effect(() => ctx.webServer.register({
    kind: "prefix",
    path: "/api/llm-router/routes",
    handler: async (req, res) => {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { Allow: "GET, HEAD" });
        res.end();
        return;
      }
      const url = new URL(req.url, "http://localhost");
      const sessionId = url.searchParams.get("sessionId") || "";
      const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get("limit") || "50", 10) || 50));
      const routes = queryRoutes({ sessionId, limit });
      const body = JSON.stringify({ routes, total: routeLog.length });
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(req.method === "HEAD" ? undefined : body);
    },
  }), "llm-router: /api/llm-router/routes");
}

export { RouterAdapter, decide, resolveConfig, lookupAffiliate, AFFILIATE_HINTS };
