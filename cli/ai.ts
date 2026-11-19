/**
 * Bring your own AI: whichever the developer already has. An API key (Anthropic, OpenAI, Google,
 * Vercel AI Gateway, OpenRouter, or any OpenAI-compatible server), Ollama, or the coding agent
 * they're already signed in to (Claude Code, Codex): their subscription, no key. Each answers the
 * same question in JSON, checked the same way.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import type { AskJson } from "../packages/understanding/src/features/describe.ts";
import { agentLaunch, onPath } from "./hand-off.ts";
import { claudeStreamArgs, claudeStreamInput, claudeStreamReply, codexImageArgs, imageRefused, OLLAMA_SEES, type AskMore } from "./vision.ts";
import { anthropicUsage as providerAnthropicUsage } from "./providers/anthropic.ts";
import { connectionReason as providerConnectionReason } from "./providers/http.ts";
import { PROVIDERS, providerFor, type ProviderName } from "./providers/index.ts";
import { openAiUsage } from "./providers/openai.ts";
import type { AskImage as ProviderImage } from "./providers/types.ts";
export type { AskImage, AskMore } from "./vision.ts";

export interface Ai extends AskJson {
  /** How it's named to the person: "Anthropic API", "your Claude Code sign-in". */
  via: string;
  ask(system: string, question: string, schema: object, more?: AskMore): Promise<AiAnswer>;
  /** Billed per token to a key, or a server that may be (not this machine): a run with no one watching needs a cap (providers/spend.ts). */
  paid?: true;
  /**
   * The same AI on a smaller, faster model, for asks that look a thing up rather than judge it: which
   * files decide the routes, what a screen's code holds, sample rows, a product's sentence. Every
   * answer is checked by machine either way (code-map.ts), so a slip costs a dropped claim, not a
   * false one. There's none when --model names a model, or where an AI gives no way to choose one.
   */
  light?: Pick<Ai, "model" | "ask">;
  /** It takes a screen's worth of questions at once (see code-map.ts SCREENS_AT_ONCE): only where that was measured. */
  allAtOnce?: boolean;
  /** Paid for by the person's own plan (a coding agent they're signed in to): never shown in dollars. */
  plan?: true;
  /** The coding agent's command, when it's one: the end of a run can hand the list to that same agent. */
  agent?: "claude" | "codex";
  /** It takes pictures of the screen (vision.ts): only the actor and the judge ever send one. */
  sees?: boolean;
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

/** What Anthropic's API says an answer took (providers/anthropic.ts). It gives no price. */
export const anthropicUsage = providerAnthropicUsage;

/**
 * What an OpenAI-style server says an answer took (providers/openai.ts): prompt tokens include the
 * cached ones, counted apart; a price only where the server says one (OpenRouter's usage.cost).
 */
export const compatibleUsage = openAiUsage;

export const AI_CHOICES = ["anthropic", "openai", "google", "gateway", "openrouter", "ollama", "openai-compatible", "claude-code", "codex", "none"] as const;
type Choice = (typeof AI_CHOICES)[number];

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
  /** Pictures sent with it: a count, never the pictures. */
  images?: number;
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
  const timed = <T extends Pick<Ai, "model" | "ask">>(asked: T): T => ({
    ...asked,
    async ask(system: string, question: string, schema: object, more?: AskMore) {
      const at = Date.now();
      const note = (failed: boolean, usage?: AiUsage) =>
        noted.push({
          what: system.slice(0, 48),
          model: usage?.model ?? asked.model ?? "",
          chars: system.length + question.length + (more?.images ?? []).reduce((n, i) => n + Math.ceil(i.data.length / 3) * 4, 0),
          ms: Date.now() - at,
          at: at - begun,
          ...(failed ? { failed: true as const } : {}),
          ...(part ? { part } : {}),
          ...(usage ? { tokens: { input: usage.input, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, output: usage.output } } : {}),
          ...(usage?.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
          ...(usage?.models ? { models: usage.models } : {}),
          ...(more?.images?.length ? { images: more.images.length } : {}),
        });
      try {
        const answer: AiAnswer = await asked.ask(system, question, schema, ...(more ? [more] : []));
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

/**
 * A stop for every ask made inside `work` (the web view's Stop): an agent asked is killed, a request
 * to an API is aborted, and the ask fails at once. Asks made outside it are untouched.
 */
const askStop = new AsyncLocalStorage<AbortSignal>();
export function withAskSignal<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  return askStop.run(signal, work);
}
/** The stop of the asks made here, if there is one. */
const stopSignal = () => askStop.getStore();
/** Said by an ask that was stopped. */
export const ASK_STOPPED = "the AI's answer wasn't waited for: stopped";

/** Every agent still answering: killed when this process exits, so none is left running on the person's plan. */
const answering = new Set<ChildProcess>();
let killOnExit = false;
function track(child: ChildProcess): void {
  answering.add(child);
  child.once("close", () => answering.delete(child));
  if (killOnExit) return;
  killOnExit = true;
  process.once("exit", () => {
    for (const c of answering) c.kill();
  });
}
/** How many agents are answering now (for tests). */
export const agentsAnswering = () => answering.size;

const keyFor = (names: readonly string[]) => names.map((n) => process.env[n]?.trim()).find((v) => v);
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
  if (want === "anthropic" || (!want && process.env.ANTHROPIC_API_KEY)) return fromProviders("anthropic", model);
  // A base URL names the server to use (LM Studio, vLLM, a company proxy): it wins over OpenAI itself.
  if (want === "openai-compatible" || (!want && process.env.OPENAI_BASE_URL)) return fromProviders("openai-compatible", model);
  for (const name of ["openai", "google", "gateway", "openrouter"] as const) {
    if (want === name || (!want && keyFor(PROVIDERS[name].keys))) return fromProviders(name, model);
  }
  if (want === "ollama") return fromProviders("ollama", model);
  if (want === "claude-code" || (!want && installed("claude"))) return model ? claudeCode(model) : withLight(claudeCode(undefined), claudeCode("haiku", "low"));
  if (want === "codex" || (!want && installed("codex"))) return codex(model);
  return undefined;
}

/**
 * A key-based provider (providers/), with the run's stop, and its light model behind withLight. It
 * takes pictures; it is marked paid unless it is a server on this machine (see providers/spend.ts).
 */
function fromProviders(name: ProviderName, model: string | undefined): Ai {
  const { main, light, paid } = providerFor(name, { model, call: { signal: stopSignal } });
  // Ollama takes pictures only on the models named for it (vision.ts OLLAMA_SEES); every other provider does.
  const sees = name !== "ollama" || OLLAMA_SEES.test(main.model);
  const mark = { ...(sees ? { sees: true } : {}), ...(paid ? { paid: true as const } : {}) };
  const ai: Ai = { ...seeing(main, sees), ...mark };
  return light ? withLight(ai, { ...seeing(light, sees), via: main.via, ...mark }) : ai;
}

/**
 * A provider's ask with the run's pictures (vision.ts's JPEG in memory) in the provider's shape. A
 * server that refuses a picture is asked again without it, and is sent none again in this process.
 */
export function seeing(p: { model: string; via: string; ask(system: string, question: string, schema: object, images?: readonly ProviderImage[]): Promise<AiAnswer> }, sees = true): Pick<Ai, "model" | "via" | "ask"> {
  let blind = !sees;
  return {
    model: p.model,
    via: p.via,
    async ask(system, question, schema, more?: AskMore) {
      const images: ProviderImage[] = blind ? [] : (more?.images ?? []).map((i) => ({ mimeType: i.mime, base64: i.data.toString("base64") }));
      if (!images.length) return p.ask(system, question, schema);
      try {
        return await p.ask(system, question, schema, images);
      } catch (error) {
        const status = (error as { status?: unknown } | null)?.status;
        if (!(error instanceof Error) || typeof status !== "number" || !imageRefused(status, error.message)) throw error;
        blind = true;
        return p.ask(system, question, schema);
      }
    },
  };
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
      async ask(system, question, schema, more) {
        try {
          return await small.ask(system, question, schema, ...(more ? [more] : []));
        } catch (error) {
          if (error instanceof Error && SLOW_DOWN.test(error.message)) throw error;
          return main.ask(system, question, schema, ...(more ? [more] : []));
        }
      },
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
 * Why a connection failed, in the fewest words (providers/http.ts): Node's fetch keeps the reason in
 * its cause, and on localhost that is an AggregateError whose first attempt has the code.
 */
export const connectionReason = providerConnectionReason;

/**
 * What every Claude Code ask starts with besides the question: nothing of the person's. Their
 * CLAUDE.md files, auto-memory, settings, hooks, skills, plugins and connected servers stay out
 * (safe mode, set by its environment variable so an older Claude Code that doesn't know the flag
 * still starts), and telemetry, update checks and error reports are off (each start cost ~9s of CPU,
 * beside the browsers). It runs in an empty folder of its own, so no project or git status is seen.
 * What it can't leave out: Claude Code tells the model the signed-in account's email, whatever it's
 * given (see PRIVACY.md), so the tester's prompts ask for plainly made-up test names.
 */
export const CLAUDE_QUIET_ENV = {
  CLAUDE_CODE_SAFE_MODE: "1",
  CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
} as const;

/** The environment of a Claude Code ask: no credential it doesn't need (agentEnv), and nothing of the person's setup. */
export function claudeAskEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...agentEnv("claude", env), ...CLAUDE_QUIET_ENV };
}

/** The command line of a Claude Code ask: the question only, with no tools, settings, skills or servers of theirs. */
export function claudeAskArgs(system: { text: string } | { file: string }, schema: object, model?: string, effort?: "low"): string[] {
  return [
    "-p", "--output-format", "json", "--json-schema", JSON.stringify(schema), ...("file" in system ? ["--system-prompt-file", system.file] : ["--system-prompt", system.text]),
    "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--disable-slash-commands", "--no-session-persistence",
    ...(model ? ["--model", model] : []),
    ...(effort ? ["--effort", effort] : []),
  ];
}

/**
 * Where an agent's empty folder goes. Claude Code tells the model the folder it starts in, so that
 * path must say nothing of the person: on Windows the temporary folder is under their profile
 * (C:\Users\<name>\AppData\Local\Temp), so ProgramData, or the system drive's root, is used
 * there instead. Elsewhere the temporary folder holds no name (/tmp, /var/folders/…).
 */
export function askRoots(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, temp: string): string[] {
  if (platform !== "win32") return [temp];
  const roots = [env.ProgramData, env.ALLUSERSPROFILE, env.PUBLIC, `${env.SystemDrive ?? "C:"}\\`].filter((r): r is string => Boolean(r));
  const name = (() => {
    try {
      return userInfo().username.toLowerCase();
    } catch {
      return (env.USERNAME ?? "").toLowerCase();
    }
  })();
  return roots.filter((r) => !name || !r.toLowerCase().includes(name));
}

/** A new empty folder for one ask, in the first of askRoots that takes one. */
function askFolder(prefix: string): string {
  for (const root of askRoots(process.platform, process.env, tmpdir())) {
    try {
      return mkdtempSync(join(root, prefix));
    } catch {
      // not writable here: the next
    }
  }
  return mkdtempSync(join(tmpdir(), prefix));
}

/** The Claude Code the person is signed in to: their subscription. Nothing of their own setup is loaded (see CLAUDE_QUIET_ENV). */
function claudeCode(model: string | undefined, effort?: "low"): Ai {
  return {
    model: model ?? "claude-code",
    via: "your Claude Code sign-in",
    allAtOnce: true,
    plan: true,
    agent: "claude",
    sees: true,
    async ask(system, question, schema, more?: AskMore) {
      // An empty folder of its own to start in. On Windows the instructions go in a file there: its
      // command line holds 32,767 characters in all.
      const dir = askFolder("contextmachines-ask-");
      const work = join(dir, "work");
      mkdirSync(work);
      const onFile = process.platform === "win32";
      if (onFile) writeFileSync(join(dir, "system.txt"), system);
      const args = claudeAskArgs(onFile ? { file: join(dir, "system.txt") } : { text: system }, schema, model, effort);
      // With a picture: one stream-json message on stdin, the same quiet flags (no tools: it can read no file).
      const images = more?.images ?? [];
      const { out } = await run("claude", claudeAskEnv(), images.length ? claudeStreamArgs(args) : args, images.length ? claudeStreamInput(question, images) : question, work).finally(() => {
        rmSync(dir, { recursive: true, force: true });
      });
      const reply = (images.length ? claudeStreamReply(out) : JSON.parse(out)) as { is_error?: boolean; result?: string; structured_output?: unknown; usage?: Record<string, unknown>; modelUsage?: Record<string, Record<string, unknown>> };
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
/** project_doc_max_bytes=0: no AGENTS.md of the person's (their global one included) is read into the ask. */
export const CODEX_QUIET = ["web_search=\"disabled\"", "project_doc_max_bytes=0", ...CODEX_FEATURES_OFF.map((f) => `features.${f}=false`)].flatMap((c) => ["-c", c]);

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

/**
 * Test-account and site values in the environment (CM_ACCOUNT_ADMIN_PASSWORD, CM_SITE_STAGING_HEADER,
 * CM_VAR_PASSWORD): typed into the page by the browser, never handed to the AI's process, whatever
 * their names say.
 */
const ACCOUNT_ENV = /^CM_(ACCOUNT|SITE|VAR)_/i;
/** Env names the loaded config points a secret at ({ "env": "NAME" }): never handed to the AI's process either. */
const configNamed = new Set<string>();

/** Keeps these env names (a config's secret references) out of every AI process started from now on. */
export function hideFromAgent(names: Iterable<string>): void {
  for (const n of names) configNamed.add(n);
}

/** This process's environment for an agent: without any credential it doesn't need to sign in, or any account or site value. */
export function agentEnv(agent: "claude" | "codex", env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !ACCOUNT_ENV.test(name) && !configNamed.has(name) && (!CREDENTIAL.test(name) || AGENT_NEEDS[agent](name, env))));
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
    sees: true,
    async ask(system, question, schema, more?: AskMore) {
      const dir = askFolder("contextmachines-codex-");
      const work = join(dir, "work");
      try {
        mkdirSync(work);
        writeFileSync(join(dir, "schema.json"), JSON.stringify(schema));
        // A picture is the one file Codex needs: in this ask's own folder, deleted with it below.
        const files = (more?.images ?? []).map((img, i) => {
          const file = join(dir, `screen-${i + 1}.jpg`);
          writeFileSync(file, img.data);
          return file;
        });
        const serversOff = await codexServers();
        const { err } = await run("codex", agentEnv("codex"), codexImageArgs(["exec", "--skip-git-repo-check", "--ephemeral", "-s", "read-only", ...CODEX_QUIET, ...serversOff, "-C", work, "--output-schema", join(dir, "schema.json"), "--output-last-message", join(dir, "answer.json"), ...(model ? ["-m", model] : []), "-"], files), `${system}\n\n${question}`, work);
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
    const stop = stopSignal();
    if (stop?.aborted) return reject(new Error(ASK_STOPPED));
    const child = spawn(launch.command, [...launch.args, ...args], { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    track(child);
    let out = "";
    let err = "";
    let timedOut = false;
    let stopped = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, ANSWER_TIMEOUT_MS);
    // Stop: the agent is killed now, not left to answer for minutes on the person's plan.
    const onStop = () => {
      stopped = true;
      child.kill();
    };
    stop?.addEventListener("abort", onStop, { once: true });
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    // A command that exits before reading its question: the exit below says why, not a broken pipe.
    child.stdin.on("error", () => {});
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      stop?.removeEventListener("abort", onStop);
      reject(error.code === "ENOENT" ? new Error(commandMissing(command)) : error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      stop?.removeEventListener("abort", onStop);
      if (stopped) return reject(new Error(ASK_STOPPED));
      if (timedOut) return reject(new Error(`${command} didn't answer in ${ANSWER_TIMEOUT_MS / 60_000} minutes`));
      if (code === 0) return resolve({ out, err });
      reject(new Error(failure(command, code, err, out, input)));
    });
    child.stdin.end(input);
  });
}
