/**
 * Every key-based AI provider in one table: where it is, which env names hold its key, the wire
 * format it speaks, and the models to start with (checked against each provider's model list, 2026-11-17). providerFor()
 * builds the main ask and, unless --model named one, the light one for look-ups (ai.ts's withLight
 * puts them together). A key is read from the environment and goes only into the request header: it is
 * never in a message, a URL or an error (scrub.ts).
 */
import { anthropicMessages } from "./anthropic.ts";
import { geminiGenerate } from "./gemini.ts";
import { ollamaBase, ollamaChat } from "./ollama.ts";
import { openAiChat } from "./openai.ts";
import type { CallOptions, ProviderAi } from "./types.ts";

export type Wire = "openai" | "anthropic" | "gemini" | "ollama";

export interface ProviderSpec {
  wire: Wire;
  via: string;
  /** Env names for the key, the first set wins. Empty: no key (a local server). */
  keys: readonly string[];
  /** A key is required (a hosted API) rather than optional. */
  needsKey: boolean;
  /** The default base; an env name in baseEnv overrides it. */
  base: string;
  baseEnv?: string;
  /** Undefined: --model is required (a server we can't know the models of). */
  model?: string;
  light?: string;
  /** The role the instructions go in: OpenAI's own API says "developer" (it replaced "system" from o1 on); every other server takes "system". */
  systemRole?: "system" | "developer";
}

export const PROVIDERS = {
  anthropic: { wire: "anthropic", via: "Anthropic API", keys: ["ANTHROPIC_API_KEY"], needsKey: true, base: "https://api.anthropic.com", baseEnv: "ANTHROPIC_BASE_URL", model: "claude-opus-5-5", light: "claude-haiku-5-5" },
  openai: { wire: "openai", via: "OpenAI API", keys: ["OPENAI_API_KEY"], needsKey: true, base: "https://api.openai.com/v1", model: "gpt-6.1-sol", light: "gpt-6.1-terra", systemRole: "developer" },
  google: { wire: "gemini", via: "Google Gemini API", keys: ["GEMINI_API_KEY", "GOOGLE_API_KEY"], needsKey: true, base: "https://generativelanguage.googleapis.com/v1beta", model: "gemini-3.8-flash", light: "gemini-3.5-flash-lite" },
  gateway: { wire: "openai", via: "Vercel AI Gateway", keys: ["AI_GATEWAY_API_KEY"], needsKey: true, base: "https://ai-gateway.vercel.sh/v1", model: "anthropic/claude-sonnet-5.5", light: "anthropic/claude-haiku-5.5" },
  openrouter: { wire: "openai", via: "OpenRouter", keys: ["OPENROUTER_API_KEY"], needsKey: true, base: "https://openrouter.ai/api/v1", model: "anthropic/claude-sonnet-5.5", light: "anthropic/claude-haiku-5.5" },
  ollama: { wire: "ollama", via: "Ollama on this machine", keys: ["OLLAMA_API_KEY"], needsKey: false, base: "http://localhost:11434", baseEnv: "OLLAMA_HOST", model: "llama3.1" },
  "openai-compatible": { wire: "openai", via: "", keys: ["OPENAI_API_KEY"], needsKey: false, base: "", baseEnv: "OPENAI_BASE_URL" },
} as const satisfies Record<string, ProviderSpec>;

export type ProviderName = keyof typeof PROVIDERS;
export const PROVIDER_NAMES = Object.keys(PROVIDERS) as ProviderName[];

export interface ProviderPick {
  main: ProviderAi;
  /** The smaller model for look-ups; none when --model named one, or the provider has no second model. */
  light?: ProviderAi;
  /** It bills per token, or may: a hosted API, or a server not on this machine. Only a server on this machine is not. */
  paid: boolean;
}

/** An address on this machine: localhost, 127.x.x.x (a whole address: not 127.0.0.1.nip.io), ::1. */
export function onThisMachine(base: string): boolean {
  const host = new URL(base).hostname.replace(/^\[|\]$/g, "");
  return host === "localhost" || host.endsWith(".localhost") || /^127(?:\.\d{1,3}){3}$/.test(host) || host === "::1";
}

/** The first env name in the list that holds a value: its name and value (the value never printed). */
export function keyFrom(names: readonly string[], env: NodeJS.ProcessEnv): { name: string; value: string } | undefined {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return { name, value };
  }
  return undefined;
}

/** A base URL from the environment, checked: a clear error rather than fetch's "Invalid URL". */
function baseFrom(spec: ProviderSpec, env: NodeJS.ProcessEnv, name: string): string {
  const set = spec.baseEnv ? env[spec.baseEnv]?.trim() : undefined;
  if (spec.wire === "ollama") return ollamaBase(set || undefined);
  const raw = set || spec.base;
  if (!raw) throw new Error(`--ai ${name} needs ${spec.baseEnv} (the server's address, such as http://localhost:1234/v1)`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${spec.baseEnv ?? "the base URL"} isn't an address: it should look like http://localhost:1234/v1`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`${spec.baseEnv ?? "the base URL"} must start with http:// or https://`);
  // A key in the address would be printed wherever the address is: refuse it.
  if (url.username || url.password || /[?&](key|api[_-]?key|token)=/i.test(url.search)) throw new Error(`${spec.baseEnv} must not hold a key: put it in ${spec.keys[0]} instead`);
  return raw.replace(/\/+$/, "");
}

/**
 * The provider asked for, built from the environment. Throws a sentence that says what to set: the
 * env names, never a value.
 */
export function providerFor(name: ProviderName, opts: { model?: string; env?: NodeJS.ProcessEnv; call?: CallOptions } = {}): ProviderPick {
  const spec: ProviderSpec = PROVIDERS[name];
  const env = opts.env ?? process.env;
  const key = keyFrom(spec.keys, env);
  if (spec.needsKey && !key) throw new Error(`--ai ${name} needs ${spec.keys.join(" or ")} set to your key`);
  const base = baseFrom(spec, env, name);
  const via = spec.via || new URL(base).host;
  const model = opts.model ?? spec.model;
  if (!model) throw new Error(`--ai ${name} needs --model (the model's name on that server)`);
  const make = (m: string): ProviderAi => {
    const k = key?.value ?? "";
    switch (spec.wire) {
      case "anthropic":
        return anthropicMessages({ base, key: k, model: m, via }, opts.call);
      case "gemini":
        return geminiGenerate({ base, key: k, model: m, via }, opts.call);
      case "ollama":
        return ollamaChat({ base, model: m, ...(k ? { key: k } : {}), via: base === "http://localhost:11434" ? via : `Ollama at ${new URL(base).host}` }, opts.call);
      case "openai":
        return openAiChat({ base, key: k, model: m, via, ...(spec.systemRole ? { systemRole: spec.systemRole } : {}) }, opts.call);
    }
  };
  const main = make(model);
  const paid = spec.needsKey || !onThisMachine(base);
  return opts.model || !spec.light ? { main, paid } : { main, light: make(spec.light), paid };
}
