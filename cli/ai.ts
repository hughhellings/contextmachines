/**
 * Bring your own AI: whichever the developer already has. An API key (Anthropic, OpenAI, Google,
 * Vercel AI Gateway, OpenRouter, or any OpenAI-compatible server such as Ollama), or the coding agent
 * they're already signed in to (Claude Code, Codex): their subscription, no key. Each answers the
 * same question in JSON, checked the same way.
 */
import Anthropic from "@anthropic-ai/sdk";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AskJson } from "../packages/understanding/src/features/describe.ts";
import { agentLaunch, onPath } from "./hand-off.ts";

export interface Ai extends AskJson {
  /** How it's named to the person: "Anthropic API", "your Claude Code sign-in". */
  via: string;
  /**
   * The same AI on a smaller, faster model, for asks that look a thing up rather than judge it: which
   * files decide the routes, what a screen's code holds, sample rows, a product's sentence. Every
   * answer is checked by machine either way (code-map.ts), so a slip costs a dropped claim, not a
   * false one. There's none when --model names a model, or where an AI gives no way to choose one.
   */
  light?: AskJson;
  /** It takes a screen's worth of questions at once (see code-map.ts SCREENS_AT_ONCE): only where that was measured. */
  allAtOnce?: boolean;
  /** Paid for by the person's own plan (a coding agent they're signed in to): never shown in dollars. */
  plan?: true;
  /** The coding agent's command, when it's one: the end of a run can hand the list to that same agent. */
  agent?: "claude" | "codex";
}

/**
 * What one answer took, as the AI itself said: tokens read fresh, read from its cache, written to its
 * cache, and written out. A dollar cost only where the provider gave one: never worked out from a
 * price list, which would be a guess. The model is the one that answered, where it says.
 */
export interface AiUsage {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  costUsd?: number;
  model?: string;
  /** Where an answer came from more than one model (Claude Code's own small helpers): each one's tokens, all four kinds together. */
  models?: Record<string, number>;
}

/** An answer, with what it took when the AI said. */
export interface AiAnswer {
  text: string;
  costUsd?: number;
  usage?: AiUsage;
}

/** A number the AI said, or 0: a field it left out, or one in a shape we don't know, counts as none. */
const tokens = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0);
/** A price the provider said, as a number or a string of one; anything else is none. */
const dollars = (n: unknown) => {
  const v = typeof n === "string" ? Number(n) : n;
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
};

/**
 * What Claude Code's JSON result says an answer took. modelUsage has every model it used for the
 * answer (its own small helpers too), added up; without it, usage. Its dollar figure is a list price
 * for a run that's on the person's plan, so it's left out.
 */
export function claudeCodeUsage(reply: { usage?: Record<string, unknown>; modelUsage?: Record<string, Record<string, unknown>> }): AiUsage | undefined {
  const models = Object.entries(reply.modelUsage ?? {});
  if (models.length) {
    const each = models.map(([model, u]) => ({ model, input: tokens(u.inputTokens), cacheRead: tokens(u.cacheReadInputTokens), cacheWrite: tokens(u.cacheCreationInputTokens), output: tokens(u.outputTokens) }));
    const sum = (k: "input" | "cacheRead" | "cacheWrite" | "output") => each.reduce((n, u) => n + u[k], 0);
    const size = (u: (typeof each)[number]) => u.input + u.cacheRead + u.cacheWrite + u.output;
    const main = each.reduce((a, b) => (size(b) > size(a) ? b : a));
    const several = each.length > 1 ? { models: Object.fromEntries(each.map((u) => [u.model, size(u)])) } : {};
    return { input: sum("input"), cacheRead: sum("cacheRead"), cacheWrite: sum("cacheWrite"), output: sum("output"), model: main.model, ...several };
  }
  const u = reply.usage;
  if (!u) return undefined;
  return { input: tokens(u.input_tokens), cacheRead: tokens(u.cache_read_input_tokens), cacheWrite: tokens(u.cache_creation_input_tokens), output: tokens(u.output_tokens) };
}

/** What Anthropic's API says an answer took. It gives no price. */
export function anthropicUsage(res: { model?: string; usage?: Record<string, unknown> | null }): AiUsage | undefined {
  const u = res.usage;
  if (!u) return undefined;
  return { input: tokens(u.input_tokens), cacheRead: tokens(u.cache_read_input_tokens), cacheWrite: tokens(u.cache_creation_input_tokens), output: tokens(u.output_tokens), ...(res.model ? { model: res.model } : {}) };
}

/**
 * What an OpenAI-style server says an answer took. Its prompt tokens include the cached ones, which
 * it counts apart (prompt_tokens_details.cached_tokens, and OpenRouter's cache_write_tokens). A price
 * only where the server says one: OpenRouter's usage.cost, in its credits, which are dollars (as its
 * usage-accounting docs show). The Vercel AI Gateway's chat answers show no price, so none is read.
 */
export function compatibleUsage(data: { model?: unknown; usage?: Record<string, unknown> | null }): AiUsage | undefined {
  const u = data.usage;
  if (!u) return undefined;
  const details = u.prompt_tokens_details as Record<string, unknown> | undefined;
  const [cached, written] = [tokens(details?.cached_tokens), tokens(details?.cache_write_tokens)];
  const costUsd = dollars(u.cost);
  return { input: Math.max(0, tokens(u.prompt_tokens) - cached - written), cacheRead: cached, cacheWrite: written, output: tokens(u.completion_tokens), ...(costUsd !== undefined ? { costUsd } : {}), ...(typeof data.model === "string" && data.model ? { model: data.model } : {}) };
}

export const AI_CHOICES = ["anthropic", "openai", "google", "gateway", "openrouter", "ollama", "openai-compatible", "claude-code", "codex", "none"] as const;
type Choice = (typeof AI_CHOICES)[number];

/** OpenAI-style providers: where they are, the key that unlocks them, and a model to start with. */
const COMPATIBLE: Record<"openai" | "google" | "gateway" | "openrouter", { base: string; key: string[]; model: string; light: string; via: string }> = {
  openai: { base: "https://api.openai.com/v1", key: ["OPENAI_API_KEY"], model: "gpt-5", light: "gpt-5-mini", via: "OpenAI API" },
  google: { base: "https://generativelanguage.googleapis.com/v1beta/openai", key: ["GEMINI_API_KEY", "GOOGLE_API_KEY"], model: "gemini-2.5-pro", light: "gemini-2.5-flash", via: "Google Gemini API" },
  gateway: { base: "https://ai-gateway.vercel.sh/v1", key: ["AI_GATEWAY_API_KEY"], model: "anthropic/claude-sonnet-5-5", light: "anthropic/claude-haiku-5-5", via: "Vercel AI Gateway" },
  openrouter: { base: "https://openrouter.ai/api/v1", key: ["OPENROUTER_API_KEY"], model: "anthropic/claude-sonnet-5-5", light: "anthropic/claude-haiku-5-5", via: "OpenRouter" },
};
/** Ollama on this machine: no key. */
const OLLAMA = { base: "http://localhost:11434/v1", model: "llama3.1", via: "Ollama on this machine" };

/** One question to the AI: which, how big and how long, for the run's own record of where its time went. */
export interface AskTiming {
  /** The first words of what it was told to do. */
  what: string;
  model: string;
  chars: number;
  ms: number;
  /** It began this long into the run. */
  at: number;
  failed?: true;
  /** Which part of the run asked: the code read or the AI's review (with its reading of the product). */
  part?: "code" | "review";
  /** What it took, as the AI said (see AiUsage): fresh, cache read, cache written, out. None where it didn't say. */
  tokens?: { input: number; cacheRead: number; cacheWrite: number; output: number };
  /** Dollars, only where the provider said. */
  costUsd?: number;
  /** Each model's tokens, where the answer came from more than one (see AiUsage.models). */
  models?: Record<string, number>;
}

/** Every question to the AI added up, for the run's last rows and map.json (learner.ai). */
export interface AiTotals {
  asks: number;
  /** How many of the asks failed, when any did. */
  failed?: number;
  /**
   * All four kinds of token together. The token counts are left out when no answer said any: none
   * would read as no tokens used, not as none reported. Codex says one total, counted as input.
   */
  tokens?: number;
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
  output?: number;
  /** Of what went in, the share read from the AI's cache, in whole percent. */
  cached?: number;
  /** Only when every answer with tokens came with a price: a sum of some would read as the whole. */
  costUsd?: number;
  /** The model that took the most tokens, as it named itself. */
  model?: string;
  /** Every model that answered, the most tokens first: the review's and the small one's for look-ups. */
  models?: string[];
}

/** The asks added up, or nothing when there were none. Tokens only from the answers that said them. */
export function aiTotals(asks: readonly AskTiming[]): AiTotals | undefined {
  if (!asks.length) return undefined;
  const failed = asks.filter((a) => a.failed).length;
  const counted = { asks: asks.length, ...(failed ? { failed } : {}) };
  const said = asks.filter((a) => a.tokens);
  if (!said.length) {
    // No tokens said, but the asks still name who answered: the most asked first.
    const byAsks = new Map<string, number>();
    for (const a of asks) if (a.model) byAsks.set(a.model, (byAsks.get(a.model) ?? 0) + 1);
    const named = [...byAsks].sort((a, b) => b[1] - a[1]).map(([name]) => name);
    return { ...counted, ...(named.length ? { model: named[0], models: named } : {}) };
  }
  const sum = (k: "input" | "cacheRead" | "cacheWrite" | "output") => said.reduce((n, a) => n + a.tokens![k], 0);
  const [input, cacheRead, cacheWrite, output] = [sum("input"), sum("cacheRead"), sum("cacheWrite"), sum("output")];
  const into = input + cacheRead + cacheWrite;
  const byModel = new Map<string, number>();
  for (const a of said) {
    const each = a.models ?? { [a.model]: a.tokens!.input + a.tokens!.cacheRead + a.tokens!.cacheWrite + a.tokens!.output };
    for (const [name, n] of Object.entries(each)) byModel.set(name, (byModel.get(name) ?? 0) + n);
  }
  const models = [...byModel].sort((a, b) => b[1] - a[1]).map(([name]) => name).filter(Boolean);
  const model = models[0];
  const priced = said.length > 0 && said.every((a) => a.costUsd !== undefined);
  return {
    ...counted,
    tokens: into + output,
    input,
    cacheRead,
    cacheWrite,
    output,
    cached: into ? Math.round((cacheRead / into) * 100) : 0,
    ...(priced ? { costUsd: Number(said.reduce((n, a) => n + a.costUsd!, 0).toFixed(6)) } : {}),
    ...(model ? { model, models } : {}),
  };
}

/**
 * The same AI, noting every question it's asked, under the part of the run that asked it. Only sizes,
 * times and the tokens the AI said it took: never a question's words. Nothing is waited for to note it.
 */
export function timedAi(ai: Ai, noted: AskTiming[], begun: number, part?: AskTiming["part"]): Ai {
  const timed = <T extends AskJson>(asked: T): T => ({
    ...asked,
    async ask(system: string, question: string, schema: object) {
      const at = Date.now();
      const note = (failed: boolean, usage?: AiUsage) =>
        noted.push({
          what: system.slice(0, 48),
          model: usage?.model ?? asked.model ?? "",
          chars: system.length + question.length,
          ms: Date.now() - at,
          at: at - begun,
          ...(failed ? { failed: true as const } : {}),
          ...(part ? { part } : {}),
          ...(usage ? { tokens: { input: usage.input, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, output: usage.output } } : {}),
          ...(usage?.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
          ...(usage?.models ? { models: usage.models } : {}),
        });
      try {
        const answer: AiAnswer = await asked.ask(system, question, schema);
        note(false, answer.usage);
        return answer;
      } catch (error) {
        // An answer that failed may still say what it took (Claude Code's is_error reply does).
        note(true, (error as { usage?: AiUsage } | null)?.usage);
        throw error;
      }
    },
  });
  return { ...timed(ai), ...(ai.light ? { light: timed(ai.light) } : {}) };
}

/** How long one AI answer may take: a local model loading, or a busy provider, but never forever. */
export const ANSWER_TIMEOUT_MS = 5 * 60_000;

const keyFor = (names: string[]) => names.map((n) => process.env[n]).find((v) => v);
/** Whether the agent answers --version, started as every ask starts it: never through a shell (see agentLaunch). */
const installed = (command: "claude" | "codex") => {
  const launch = agentLaunch(command);
  return Boolean(launch) && spawnSync(launch!.command, [...launch!.args, "--version"], { stdio: "ignore", timeout: 5000, windowsHide: true }).status === 0;
};

/**
 * The AI to use: the one asked for, else the first the person already has: an API key in the
 * environment, then a coding agent they're signed in to. Undefined: none (screens and actions only).
 */
export function pickAi(choice: string | undefined, model: string | undefined): Ai | undefined {
  if (choice !== undefined && !(AI_CHOICES as readonly string[]).includes(choice)) throw new Error(`--ai must be one of: ${AI_CHOICES.join(", ")}`);
  const want = choice as Choice | undefined;
  if (want === "none") return undefined;
  // Nothing chosen: a signed-in agent comes first, as init lists them, so a key left in the shell
  // never bills per token for a run your plan would have covered.
  if (!want) {
    if (installed("claude")) return model ? claudeCode(model) : withLight(claudeCode(undefined), claudeCode("haiku", "low"));
    if (installed("codex")) return codex(model);
  }
  if (want === "anthropic" || (!want && process.env.ANTHROPIC_API_KEY)) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("--ai anthropic needs ANTHROPIC_API_KEY");
    return model ? anthropic(model) : withLight(anthropic("claude-opus-5-5"), anthropic("claude-haiku-5-5"));
  }
  // A base URL names the server to use (Ollama, LM Studio, a company proxy): it wins over OpenAI itself.
  if (want === "openai-compatible" || (!want && process.env.OPENAI_BASE_URL)) {
    const base = process.env.OPENAI_BASE_URL;
    if (!base) throw new Error("--ai openai-compatible needs OPENAI_BASE_URL (and OPENAI_API_KEY if it asks for one)");
    if (!model) throw new Error("--ai openai-compatible needs --model");
    return compatible(base.replace(/\/$/, ""), process.env.OPENAI_API_KEY ?? "", model, new URL(base).host);
  }
  for (const name of ["openai", "google", "gateway", "openrouter"] as const) {
    const p = COMPATIBLE[name];
    if (want === name || (!want && keyFor(p.key))) {
      const key = keyFor(p.key);
      if (!key) throw new Error(`--ai ${name} needs ${p.key.join(" or ")}`);
      return model ? compatible(p.base, key, model, p.via) : withLight(compatible(p.base, key, p.model, p.via), compatible(p.base, key, p.light, p.via));
    }
  }
  if (want === "ollama") return compatible(OLLAMA.base, "ollama", model ?? OLLAMA.model, OLLAMA.via, "is it running? (ollama serve)");
  if (want === "claude-code" || (!want && installed("claude"))) return model ? claudeCode(model) : withLight(claudeCode(undefined), claudeCode("haiku", "low"));
  if (want === "codex" || (!want && installed("codex"))) return codex(model);
  return undefined;
}

/** Said by an AI that wants fewer questions: going to the bigger model would only meet it too. */
const SLOW_DOWN = /\b(?:429|529)\b|rate.?limit|usage limit|too many requests|overloaded/i;

/**
 * The small model, with the main one behind it: an account may not have the small one, and a run
 * shouldn't lose its code read over that. Being told to slow down isn't that, and is passed on.
 */
export function withLight(main: Ai, small: Ai): Ai {
  return {
    ...main,
    light: {
      model: small.model,
      async ask(system, question, schema) {
        try {
          return await small.ask(system, question, schema);
        } catch (error) {
          if (error instanceof Error && SLOW_DOWN.test(error.message)) throw error;
          return main.ask(system, question, schema);
        }
      },
    },
  };
}

function anthropic(model: string): Ai {
  const client = new Anthropic({ timeout: ANSWER_TIMEOUT_MS });
  return {
    model,
    via: "Anthropic API",
    async ask(system, question, schema) {
      const res = await client.messages.create({
        model,
        max_tokens: 16000,
        system,
        output_config: { format: { type: "json_schema", schema } },
        messages: [{ role: "user", content: question }],
      } as Anthropic.MessageCreateParamsNonStreaming).catch((error: unknown) => {
        if (error instanceof Anthropic.APIError && error.status) throw new Error(`Anthropic said ${error.status}: ${refusal(error.error)}`);
        throw error;
      });
      const text = res.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text;
      if (!text) throw new Error(`no answer (${res.stop_reason})`);
      const usage = anthropicUsage(res as unknown as { model?: string; usage?: Record<string, unknown> });
      const answer: AiAnswer = { text, ...(usage ? { usage } : {}) };
      return answer;
    },
  };
}

/**
 * The sentence in an AI server's refusal. They all answer in JSON, as {"error":{"message":…}} or
 * {"error":"…"} (Gemini's in a list of one), and that sentence is what tells the person what to do
 * ("Your credit balance is too low…"): cut from the raw body, it's lost among the braces.
 */
export function refusal(body: unknown): string {
  let said = body;
  if (typeof body === "string") {
    try {
      said = JSON.parse(body);
    } catch {
      return body.trim().slice(0, 160);
    }
  }
  const one = (Array.isArray(said) ? said[0] : said) as { error?: { message?: unknown } | string; message?: unknown } | null | undefined;
  const sentence = typeof one?.error === "string" ? one.error : (one?.error?.message ?? one?.message);
  return typeof sentence === "string" && sentence.trim() ? sentence.trim().slice(0, 160) : (typeof body === "string" ? body : JSON.stringify(body) ?? "").trim().slice(0, 160);
}

/**
 * Why a connection failed, in the fewest words. Node's fetch says only "fetch failed" and keeps the
 * reason in its cause; connecting to localhost tries two addresses, so the cause is an AggregateError
 * whose own message is empty and whose reason is the first attempt's code (ECONNREFUSED).
 */
export function connectionReason(error: unknown): string {
  const cause = (error as { cause?: unknown } | null)?.cause ?? error;
  const said = cause as { message?: unknown; code?: unknown; errors?: unknown[] } | null;
  const first = said?.errors?.[0] as { code?: unknown; message?: unknown } | undefined;
  const reasons = [said?.code, first?.code, said?.message, first?.message, (error as { message?: unknown } | null)?.message];
  return reasons.find((r): r is string => typeof r === "string" && r.trim() !== "") ?? "";
}

/** The sentence for a server that couldn't be reached: a reason only when there is one, and what to try. */
function unreachable(via: string, base: string, error: unknown, hint: string): string {
  const reason = connectionReason(error);
  return `couldn't reach ${via} at ${base}${reason ? `: ${reason}` : ""}${hint ? `; ${hint}` : ""}`;
}

/** Any server that speaks the OpenAI chat format: OpenAI itself, Gemini, gateways, Ollama, LM Studio. */
function compatible(base: string, key: string, model: string, via: string, hint = ""): Ai {
  const post = (body: object) =>
    fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(ANSWER_TIMEOUT_MS),
    }).catch((error: unknown) => {
      if (error instanceof Error && error.name === "TimeoutError") throw new Error(`${via} didn't answer in ${ANSWER_TIMEOUT_MS / 60_000} minutes`);
      throw new Error(unreachable(via, base, error, hint));
    });
  return {
    model,
    via,
    async ask(system, question, schema) {
      const messages = [{ role: "system", content: system }, { role: "user", content: question }];
      let res = await post({ model, messages, response_format: { type: "json_schema", json_schema: { name: "reading", schema } } });
      // Some servers take JSON but not a schema: the schema goes in the question instead.
      if (res.status === 400) {
        res = await post({ model, messages: [messages[0], { role: "user", content: `${question}\n\nAnswer with JSON only, following this JSON Schema:\n${JSON.stringify(schema)}` }], response_format: { type: "json_object" } });
      }
      if (!res.ok) throw new Error(`${via} said ${res.status}: ${refusal(await res.text())}${res.status === 404 ? " (is the model right? set --model)" : ""}`);
      const data = (await res.json()) as { choices?: { message?: { content?: string } }[]; model?: unknown; usage?: Record<string, unknown> | null };
      const text = data.choices?.[0]?.message?.content;
      if (!text) throw new Error(`${via} gave no answer`);
      const usage = compatibleUsage(data);
      // The price at the top as well, where the code read adds up its own (codeRead.costUsd in map.json).
      const answer: AiAnswer = { text, ...(usage ? { usage } : {}), ...(usage?.costUsd !== undefined ? { costUsd: usage.costUsd } : {}) };
      return answer;
    },
  };
}

/** The Claude Code the person is signed in to: their subscription. Nothing of their own setup is loaded. */
function claudeCode(model: string | undefined, effort?: "low"): Ai {
  return {
    model: model ?? "claude-code",
    via: "your Claude Code sign-in",
    allAtOnce: true,
    plan: true,
    agent: "claude",
    async ask(system, question, schema) {
      // On Windows the instructions go in a file: its command line holds 32,767 characters in all.
      const dir = process.platform === "win32" ? mkdtempSync(join(tmpdir(), "contextmachines-ask-")) : undefined;
      if (dir) writeFileSync(join(dir, "system.txt"), system);
      // Telemetry, update checks and error reports off: each start cost ~9s of CPU, beside the browsers.
      const { out } = await run("claude", { ...agentEnv("claude"), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" }, [
        "-p", "--output-format", "json", "--json-schema", JSON.stringify(schema), ...(dir ? ["--system-prompt-file", join(dir, "system.txt")] : ["--system-prompt", system]),
        // Only the question: no tools, settings, skills or connected servers of theirs.
        "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--disable-slash-commands", "--no-session-persistence",
        ...(model ? ["--model", model] : []),
        ...(effort ? ["--effort", effort] : []),
      ], question).finally(() => {
        if (dir) rmSync(dir, { recursive: true, force: true });
      });
      const reply = JSON.parse(out) as { is_error?: boolean; result?: string; structured_output?: unknown; usage?: Record<string, unknown>; modelUsage?: Record<string, Record<string, unknown>> };
      const usage = claudeCodeUsage(reply);
      if (reply.is_error) throw Object.assign(new Error(`Claude Code: ${reply.result ?? "failed"}${SIGN_IN.test(reply.result ?? "") ? ` (${SIGN_IN_HINT.claude})` : ""}`), usage ? { usage } : {});
      const answer: AiAnswer = { text: JSON.stringify(reply.structured_output ?? JSON.parse(reply.result ?? "null")), ...(usage ? { usage } : {}) };
      return answer;
    },
  };
}

/**
 * Codex is an agent, so it only answers the question here: it starts in an empty folder of its own,
 * in a read-only sandbox, with its shell, web search, connected servers, plugins and helpers off, and
 * nothing kept afterwards. The question holds a third-party site's text, which must not get to run
 * anything or read this machine's files. Its own model settings stay unless --model is given.
 */
const CODEX_FEATURES_OFF = [
  "shell_tool", "unified_exec", "apps", "plugins", "multi_agent", "multi_agent_v2", "browser_use", "browser_use_external", "computer_use",
  "image_generation", "view_image", "hooks", "memories", "goals", "skill_search", "tool_suggest",
];
const CODEX_QUIET = ["web_search=\"disabled\"", ...CODEX_FEATURES_OFF.map((f) => `features.${f}=false`)].flatMap((c) => ["-c", c]);

/**
 * The MCP servers in the person's own Codex setup, each turned off by name for this run: Codex merges
 * `-c mcp_servers={}` into their config rather than replacing it, so an empty table leaves every
 * server they configured running. A name Codex can't take in a `-c` key can't be turned off, so Codex
 * isn't used at all rather than used with a server we can't stop.
 */
let codexServersOff: Promise<string[]> | undefined;
function codexServers(): Promise<string[]> {
  codexServersOff ??= run("codex", agentEnv("codex"), ["mcp", "list", "--json", ...CODEX_QUIET], "").then(({ out }) => {
    const servers = (JSON.parse(out) as { name: string; enabled?: boolean }[]).filter((s) => s.enabled !== false).map((s) => s.name);
    const odd = servers.find((name) => !/^[A-Za-z0-9_-]+$/.test(name));
    if (odd) throw new Error(`codex: its MCP server "${odd}" can't be turned off for this run, so it isn't used. Use an API key instead (see --help)`);
    return servers.flatMap((name) => ["-c", `mcp_servers.${name}.enabled=false`]);
  });
  return codexServersOff;
}

/**
 * Names in the environment that hold a credential: tokens, secrets, keys and passwords, and
 * everything GitHub Actions hands a job. The coding agent gets none of these but its own sign-in
 * (see AGENT_NEEDS): it reads a third-party site's text, and needs nothing else of this machine's.
 */
const CREDENTIAL = /(TOKEN|SECRET|KEY|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|AUTH|COOKIE|SESSION)|^(ACTIONS_|GITHUB_|GH_|RUNNER_|NPM_CONFIG__AUTH)/i;
/** What each agent needs to sign in, which a credential filter would otherwise take away. */
const AGENT_NEEDS: Record<"claude" | "codex", (name: string, env: NodeJS.ProcessEnv) => boolean> = {
  claude: (name, env) =>
    // Never an Anthropic API key or token: Claude Code would bill it, and the run is on the person's plan.
    // Except where it signs in elsewhere with them: a cloud, or a gateway at ANTHROPIC_BASE_URL.
    (/^(ANTHROPIC_|CLAUDE_CODE_|CLAUDE_CONFIG_DIR$)/.test(name) && (!/^ANTHROPIC_(API_KEY|AUTH_TOKEN)$/.test(name) || onCloud(env) || Boolean(env.ANTHROPIC_BASE_URL))) ||
    // Claude Code through Amazon Bedrock or Google Vertex signs in with those clouds' own credentials.
    (Boolean(env.CLAUDE_CODE_USE_BEDROCK) && /^AWS_/.test(name)) ||
    (Boolean(env.CLAUDE_CODE_USE_VERTEX) && /^(GOOGLE_APPLICATION_CREDENTIALS|CLOUD_ML_REGION|ANTHROPIC_VERTEX_)/.test(name)),
  // Never an API key either: Codex would bill it, and the run is on the person's ChatGPT plan.
  codex: (name) => /^(OPENAI_BASE_URL|OPENAI_ORG_ID|OPENAI_PROJECT_ID|CODEX_[A-Z_]*)$/.test(name) && name !== "CODEX_API_KEY",
};

/** Claude Code through Amazon Bedrock or Google Vertex: billed by that cloud, with its settings kept as they are. */
const onCloud = (env: NodeJS.ProcessEnv) => Boolean(env.CLAUDE_CODE_USE_BEDROCK || env.CLAUDE_CODE_USE_VERTEX);

/** This process's environment for an agent: without any credential it doesn't need to sign in. */
export function agentEnv(agent: "claude" | "codex", env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !CREDENTIAL.test(name) || AGENT_NEEDS[agent](name, env)));
}

/** What to do when an agent says it isn't signed in. */
const SIGN_IN = /not (logged|signed) in|log ?in|sign ?in|unauthori[sz]ed|authenticat|credential|api key|401/i;
const SIGN_IN_HINT: Record<"claude" | "codex", string> = {
  claude: "run claude and sign in, or use --ai anthropic with ANTHROPIC_API_KEY",
  codex: "run codex login",
};

/** The Codex the person is signed in to (see CODEX_QUIET for what it may do). */
function codex(model: string | undefined): Ai {
  return {
    model: model ?? "codex",
    via: "your Codex sign-in",
    plan: true,
    agent: "codex",
    async ask(system, question, schema) {
      const dir = mkdtempSync(join(tmpdir(), "contextmachines-codex-"));
      const work = join(dir, "work");
      try {
        mkdirSync(work);
        writeFileSync(join(dir, "schema.json"), JSON.stringify(schema));
        const serversOff = await codexServers();
        const { err } = await run("codex", agentEnv("codex"), ["exec", "--skip-git-repo-check", "--ephemeral", "-s", "read-only", ...CODEX_QUIET, ...serversOff, "-C", work, "--output-schema", join(dir, "schema.json"), "--output-last-message", join(dir, "answer.json"), ...(model ? ["-m", model] : []), "-"], `${system}\n\n${question}`, work);
        const usage = codexUsage(err, model);
        const answer: AiAnswer = { text: readFileSync(join(dir, "answer.json"), "utf8"), ...(usage ? { usage } : {}) };
        return answer;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

/** Codex's header, between its first two rules ("model: gpt-6-luna"): the question it repeats comes after. */
const codexHeader = (err: string) => err.split(/^-{4,}$/m)[1] ?? "";

/**
 * What a Codex answer took, from the end of its stderr ("tokens used\n8,217"): one total, so it's
 * counted as input. The last one, as the question it repeats comes before. The model is the one
 * asked for, else the one its header names.
 */
export function codexUsage(err: string, model?: string): AiUsage | undefined {
  const said = [...err.matchAll(/tokens used\s*\n([\d,]+)/g)].pop()?.[1];
  if (!said) return undefined;
  const name = model ?? codexHeader(err).match(/^model: *(\S+)/m)?.[1];
  // One total, never split: counted as output, so no "% cached" is said of what Codex never says it cached.
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: Number(said.replace(/,/g, "")), ...(name ? { model: name } : {}) };
}

/** Said when the plan can't use the model asked for (or Codex's own default). */
const MODEL_REFUSED = /model_not_found|model is not supported|does not have access to (?:the )?model/i;

/**
 * Why an agent failed, in its own words, with how to sign in when that's why. Codex repeats the whole
 * question on stderr after a "user" line, and the question holds words like "sign in": it's taken out,
 * and only Codex's own ERROR lines are read, else what it said before its header ended.
 */
export function failure(command: "claude" | "codex", code: number | null, err: string, out: string, input = ""): string {
  if (command === "codex") {
    const asked = input.trim();
    const own = asked && err.includes(asked) ? err.replace(asked, "") : err;
    const lines = own.split("\n").filter((l) => l.startsWith("ERROR:"));
    // No ERROR line: what it said before the question, past its header (a sign-in that failed at the start).
    const before = own.split(/^user$/m)[0]!.split(/^-{4,}$/m);
    const errors = lines.length ? lines.join("\n") : (before.length > 2 ? before.slice(2).join("\n") : before[0]!).replace(/^Reading additional input from stdin\.*$/m, "");
    const last = errors.trim().split("\n").pop() ?? "";
    const said = (last.match(/"message":\s*"([^"]+)"/)?.[1] ?? last.match(/"detail":\s*"([^"]+)"/)?.[1] ?? last.replace(/^ERROR:\s*/, "")).trim() || `exit ${code}`;
    if (MODEL_REFUSED.test(errors)) {
      const name = said.match(/model\s+[`'"]([^`'"\s]+)[`'"]|[`'"]([^`'"\s]+)[`'"]\s+model/)?.slice(1).find(Boolean) ?? codexHeader(err).match(/^model: *(\S+)/m)?.[1];
      return `codex can't use ${name ? `the model "${name.slice(0, 60)}"` : "its model"}: pass --model with one your plan has, or save it as "model" in contextmachines.config.json`;
    }
    return `codex: ${said.slice(0, 200)}${SIGN_IN.test(errors) ? ` (${SIGN_IN_HINT.codex})` : ""}`;
  }
  // Claude Code says why on stdout, as its JSON reply's result ("Failed to authenticate: …"), with nothing on stderr.
  let result: string | undefined;
  try {
    const reply = JSON.parse(out) as { result?: unknown };
    if (typeof reply.result === "string" && reply.result.trim()) result = reply.result.trim();
  } catch {
    // not its JSON: what's below
  }
  const said = (err.match(/"message":"([^"]+)"/)?.[1] ?? result ?? (err.trim().split("\n").pop() || out.trim().slice(0, 200))) || `exit ${code}`;
  return `${command}: ${said.slice(0, 200)}${SIGN_IN.test(`${err}\n${out}`) ? ` (${SIGN_IN_HINT[command]})` : ""}`;
}

/** Said on Windows when the agent is there but its launcher can't be read, so it can't be started without a shell. */
export function launcherUnreadable(command: "claude" | "codex"): string {
  const install = command === "claude" ? "Claude Code's own installer, or npm i -g @anthropic-ai/claude-code" : "npm i -g @openai/codex";
  return `the ${command} on your PATH starts through a launcher that can only run in cmd.exe, which isn't safe with a site's text: install it with ${install}, or use an API key (see --help)`;
}

/** Said when the agent's command can't be found, in place of Node's "spawn claude ENOENT". */
export function commandMissing(command: "claude" | "codex"): string {
  const setUp = command === "claude" ? "install Claude Code and sign in" : "install Codex and run codex login";
  return `the ${command} command isn't installed or isn't on your PATH: ${setUp}, or use --ai none`;
}

/**
 * A command run with its question on stdin, in `cwd`, with only the environment it is given; its
 * output and stderr, or its own words when it fails or takes too long (see failure).
 */
function run(command: "claude" | "codex", env: NodeJS.ProcessEnv, args: string[], input: string, cwd = tmpdir()): Promise<{ out: string; err: string }> {
  return new Promise((resolve, reject) => {
    // Never through a shell: the question and the site's words are in what it's given (see agentLaunch).
    const launch = agentLaunch(command);
    if (!launch) return reject(new Error(onPath(command) ? launcherUnreadable(command) : commandMissing(command)));
    const child = spawn(launch.command, [...launch.args, ...args], { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let out = "";
    let err = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, ANSWER_TIMEOUT_MS);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    // A command that exits before reading its question: the exit below says why, not a broken pipe.
    child.stdin.on("error", () => {});
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(error.code === "ENOENT" ? new Error(commandMissing(command)) : error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error(`${command} didn't answer in ${ANSWER_TIMEOUT_MS / 60_000} minutes`));
      if (code === 0) return resolve({ out, err });
      reject(new Error(failure(command, code, err, out, input)));
    });
    child.stdin.end(input);
  });
}
