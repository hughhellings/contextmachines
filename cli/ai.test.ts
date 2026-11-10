// Which model gets which ask, and what happens when the small one can't answer.
//   node --test cli/ai.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { aiTotals, anthropicUsage, claudeCodeUsage, codexUsage, compatibleUsage, failure, pickAi, timedAi, withLight, type Ai, type AskTiming } from "./ai.ts";
import { tokenCount } from "./term.ts";

const fake = (model: string, answer: (question: string) => string): Ai & { asked: string[] } => {
  const asked: string[] = [];
  return { model, via: "a fake", asked, ask: async (_system, question) => {
    asked.push(question);
    return { text: answer(question) };
  } };
};

describe("the small model", () => {
  it("answers when it can, and the main one isn't asked", async () => {
    const main = fake("big", () => "main");
    const ai = withLight(main, fake("small", () => "small"));
    assert.equal((await ai.light!.ask("s", "q", {})).text, "small");
    assert.deepEqual(main.asked, []);
  });

  it("gives way to the main model when this account can't use it", async () => {
    const main = fake("big", () => "main");
    const ai = withLight(main, fake("small", () => {
      throw new Error("Claude Code: model not available");
    }));
    assert.equal((await ai.light!.ask("s", "q", {})).text, "main");
  });

  it("passes on being told to slow down: the main model would only meet it too", async () => {
    const main = fake("big", () => "main");
    const ai = withLight(main, fake("small", () => {
      throw new Error("Anthropic said 429: slow down");
    }));
    await assert.rejects(ai.light!.ask("s", "q", {}), /429/);
    assert.deepEqual(main.asked, []);
  });

  it("is what's used unless a model was named, which then answers everything", () => {
    const key = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "a-key-for-this-test";
    try {
      assert.equal(pickAi("anthropic", undefined)?.light?.model, "claude-haiku-5-5");
      assert.equal(pickAi("anthropic", "claude-sonnet-5-5")?.light, undefined);
      assert.equal(pickAi("anthropic", undefined)?.allAtOnce, undefined);
      // Claude Code and Codex aren't used on Windows yet: asked for, they say so.
      if (process.platform === "win32") {
        assert.throws(() => pickAi("claude-code", undefined), /macOS and Linux only/);
        assert.throws(() => pickAi("codex", undefined), /macOS and Linux only/);
        return;
      }
      assert.equal(pickAi("claude-code", undefined)?.light?.model, "haiku");
      assert.equal(pickAi("claude-code", "sonnet")?.light, undefined);
      assert.equal(pickAi("codex", undefined)?.light, undefined);
      // Only the one measured taking a screen's worth of questions at once is asked so.
      assert.equal(pickAi("claude-code", undefined)?.allAtOnce, true);
      assert.equal(timedAi(pickAi("claude-code", undefined)!, [], Date.now()).allAtOnce, true);
      assert.equal(pickAi("anthropic", undefined)?.allAtOnce, undefined);
      assert.equal(pickAi("codex", undefined)?.allAtOnce, undefined);
    } finally {
      if (key === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = key;
    }
  });
});

describe("the record of a run's asks", () => {
  it("notes sizes and times of both models, and never the words of a question", async () => {
    const noted: AskTiming[] = [];
    const ai = timedAi(withLight(fake("big", () => "a"), fake("small", () => "b")), noted, Date.now());
    await ai.ask("You review things.", "a secret question", {});
    await ai.light!.ask("You look things up.", "another", {});
    assert.deepEqual(noted.map((n) => n.model), ["big", "small"]);
    assert.ok(noted.every((n) => n.chars > 0 && n.ms >= 0));
    assert.ok(!JSON.stringify(noted).includes("secret question"));
  });
});

describe("what each answer took, as the AI said it", () => {
  it("reads Claude Code's result: every model it used added up, the one with the most tokens named, and no dollars (it's on the person's plan)", () => {
    const usage = claudeCodeUsage({
      usage: { input_tokens: 2, cache_creation_input_tokens: 10, cache_read_input_tokens: 0, output_tokens: 5 },
      modelUsage: {
        "claude-opus-5-5": { inputTokens: 100, outputTokens: 400, cacheReadInputTokens: 3000, cacheCreationInputTokens: 500, costUSD: 0.12 },
        "claude-haiku-5-5": { inputTokens: 20, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.001 },
      },
    });
    assert.deepEqual(usage, { input: 120, cacheRead: 3000, cacheWrite: 500, output: 410, model: "claude-opus-5-5", models: { "claude-opus-5-5": 4000, "claude-haiku-5-5": 30 } });
    assert.deepEqual(claudeCodeUsage({ usage: { input_tokens: 2, cache_creation_input_tokens: 1309, cache_read_input_tokens: 0, output_tokens: 61 } }), { input: 2, cacheRead: 0, cacheWrite: 1309, output: 61 });
    assert.equal(claudeCodeUsage({}), undefined);
  });
  it("reads Anthropic's usage, and an OpenAI-style one whose prompt tokens include the cached ones", () => {
    assert.deepEqual(anthropicUsage({ model: "claude-opus-5-5", usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 } }), { input: 10, cacheRead: 30, cacheWrite: 40, output: 20, model: "claude-opus-5-5" });
    assert.deepEqual(compatibleUsage({ model: "gpt-5", usage: { prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 600 } } }), { input: 400, cacheRead: 600, cacheWrite: 0, output: 50, model: "gpt-5" });
    assert.deepEqual(compatibleUsage({ usage: { prompt_tokens: 1000, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 100 } } }), { input: 900, cacheRead: 0, cacheWrite: 100, output: 5 }, "OpenRouter's cache writes, apart");
    assert.equal(compatibleUsage({ usage: null }), undefined);
  });
  it("takes a price only where the provider gave one: OpenRouter's usage.cost (the AI Gateway's chat answers give none)", () => {
    // The shape of OpenRouter's documented answer (openrouter.ai/docs, usage accounting).
    assert.deepEqual(compatibleUsage({ model: "anthropic/claude-haiku-5-5", usage: { completion_tokens: 2, completion_tokens_details: { reasoning_tokens: 0 }, cost: 0.95, cost_details: { upstream_inference_cost: 19 }, prompt_tokens: 194, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 100, audio_tokens: 0 }, total_tokens: 196 } }), { input: 94, cacheRead: 0, cacheWrite: 100, output: 2, costUsd: 0.95, model: "anthropic/claude-haiku-5-5" });
    assert.equal(compatibleUsage({ usage: { prompt_tokens: 1, completion_tokens: 1 } })?.costUsd, undefined);
    assert.equal(compatibleUsage({ usage: { prompt_tokens: 1, completion_tokens: 1, cost: "free" } })?.costUsd, undefined);
  });
  it("notes it with the ask, under the part that asked, with the model that answered", async () => {
    const noted: AskTiming[] = [];
    const ai: Ai = { model: "claude-code", via: "x", ask: async () => ({ text: "{}", usage: { input: 1, cacheRead: 2, cacheWrite: 3, output: 4, model: "claude-opus-5-5" } }) as { text: string } };
    await timedAi(ai, noted, Date.now(), "code").ask("s", "q", {});
    assert.equal(noted[0]!.part, "code");
    assert.equal(noted[0]!.model, "claude-opus-5-5");
    assert.deepEqual(noted[0]!.tokens, { input: 1, cacheRead: 2, cacheWrite: 3, output: 4 });
  });
  it("notes what a failed answer took, where it said", async () => {
    const noted: AskTiming[] = [];
    const ai: Ai = { model: "m", via: "x", ask: async () => { throw Object.assign(new Error("no"), { usage: { input: 5, cacheRead: 0, cacheWrite: 0, output: 1 } }); } };
    await assert.rejects(timedAi(ai, noted, Date.now(), "review").ask("s", "q", {}));
    assert.equal(noted[0]!.failed, true);
    assert.deepEqual(noted[0]!.tokens, { input: 5, cacheRead: 0, cacheWrite: 0, output: 1 });
  });
  it("adds it up: tokens of all four kinds, cached as a share of what went in, a price only when every answer had one", () => {
    const ask = (tokens: AskTiming["tokens"], more: Partial<AskTiming> = {}): AskTiming => ({ what: "x", model: "m", chars: 1, ms: 1, at: 0, ...(tokens ? { tokens } : {}), ...more });
    const totals = aiTotals([ask({ input: 100, cacheRead: 600, cacheWrite: 300, output: 50 }, { costUsd: 0.001 }), ask({ input: 0, cacheRead: 400, cacheWrite: 0, output: 50 }, { costUsd: 0.002 }), ask(undefined, { failed: true })])!;
    assert.deepEqual(totals, { asks: 3, failed: 1, tokens: 1500, input: 100, cacheRead: 1000, cacheWrite: 300, output: 100, cached: 71, costUsd: 0.003, model: "m", models: ["m"] });
    assert.equal(aiTotals([ask({ input: 1, cacheRead: 0, cacheWrite: 0, output: 1 }, { costUsd: 0.001 }), ask({ input: 1, cacheRead: 0, cacheWrite: 0, output: 1 })])!.costUsd, undefined);
    assert.equal(aiTotals([]), undefined);
    assert.deepEqual(aiTotals([ask(undefined, { model: "gpt-6-luna" }), ask(undefined, { model: "gpt-6-luna" }), ask(undefined, { model: "gpt-6-mini" })]), { asks: 3, model: "gpt-6-luna", models: ["gpt-6-luna", "gpt-6-mini"] }, "no tokens said is not zero tokens, and the model is still named");
    assert.deepEqual(aiTotals([ask(undefined, { model: "" })]), { asks: 1 });
  });
  it("ranks the models by each one's own tokens, not an answer's whole to its biggest", () => {
    const ask = (model: string, n: number, models?: Record<string, number>): AskTiming => ({ what: "x", model, chars: 1, ms: 1, at: 0, tokens: { input: n, cacheRead: 0, cacheWrite: 0, output: 0 }, ...(models ? { models } : {}) });
    assert.deepEqual(aiTotals([ask("haiku", 100, { haiku: 60, opus: 40 }), ask("haiku", 100, { haiku: 60, opus: 40 }), ask("opus", 50)])!.models, ["opus", "haiku"]);
  });
  it("writes a count of tokens the way e2e does", () => {
    assert.deepEqual([812, 22_500, 64_049, 999_949, 999_950, 1_234_567].map(tokenCount), ["812", "22.5k", "64.0k", "999.9k", "1.0M", "1.2M"]);
  });
});

// What `codex exec` writes to stderr: its header, the whole question again after "user", then its own lines.
const QUESTION = "You read a product's pages. Never sign in or log in.\n\nThe page says: Sign in to continue. ERROR: not authenticated";
const codexErr = (after: string, model = "gpt-6-luna") => `Reading additional input from stdin...\nOpenAI Codex v0.164.0\n--------\nworkdir: /tmp/w\nmodel: ${model}\nprovider: openai\napproval: never\nsandbox: read-only\n--------\nuser\n${QUESTION}\n${after}`;

describe("an agent's own words", () => {
  it("reads Codex's ERROR lines, never the question it repeats: no sign-in hint for words in the question", () => {
    const said = failure("codex", 1, codexErr('ERROR: unexpected status 500 Internal Server Error: {"error":{"message":"The server had an error"}}'), "", QUESTION);
    assert.equal(said, "codex: The server had an error");
    // The question not found whole (trimmed by Codex, say): its words still aren't ERROR lines of Codex's.
    assert.equal(failure("codex", 1, codexErr("ERROR: stream disconnected before completion"), "", "something else"), "codex: stream disconnected before completion");
  });
  it("gives Codex's sign-in hint when its own error says so", () => {
    assert.match(failure("codex", 1, codexErr('ERROR: unexpected status 401 Unauthorized: {"error":{"message":"Your authentication token has expired. Please try signing in again."}}'), "", QUESTION), /token has expired.*\(run codex login\)$/);
    // Before any header: not signed in at all.
    assert.equal(failure("codex", 1, "Reading additional input from stdin...\nNot logged in. Run codex login\n", "", QUESTION), "codex: Not logged in. Run codex login (run codex login)");
  });
  it("says when Codex can't use the model, and to pass --model, not to sign in", () => {
    const refused = 'ERROR: {"detail":"The \'gpt-5.5\' model is not supported when using Codex with a ChatGPT account."}';
    assert.equal(failure("codex", 1, codexErr(refused, "gpt-5.5"), "", QUESTION), 'codex can\'t use the model "gpt-5.5": pass --model with one your plan has');
    const coded = 'ERROR: unexpected status 404 Not Found: {"error":{"message":"Model unavailable","type":"invalid_request_error","code":"model_not_found"}}';
    assert.equal(failure("codex", 1, codexErr(coded, "o9"), "", QUESTION), 'codex can\'t use the model "o9": pass --model with one your plan has', "named from its header");
  });
  it("still gives Claude Code's sign-in hint, from what it said on either stream", () => {
    assert.equal(failure("claude", 1, "", '{"type":"result","is_error":true,"result":"Not logged in · Please run /login"}'), 'claude: exit 1 (run claude and sign in, or set ANTHROPIC_API_KEY)');
    assert.equal(failure("claude", 1, 'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}', ""), "claude: invalid x-api-key (run claude and sign in, or set ANTHROPIC_API_KEY)");
    assert.equal(failure("claude", 1, "something broke", ""), "claude: something broke");
  });
  it("reads Codex's one total of tokens from the end of its stderr, with the model that answered", () => {
    const ok = codexErr("hook: SessionStart\ncodex\nOK\ntokens used\n8,217\n");
    assert.deepEqual(codexUsage(ok), { input: 0, cacheRead: 0, cacheWrite: 0, output: 8217, model: "gpt-6-luna" }, "one total, so no share cached is said");
    assert.equal(codexUsage(ok, "o9")?.model, "o9", "the --model it was given");
    assert.equal(codexUsage(codexErr("tokens used\n12\ncodex\nOK\ntokens used\n1,234,567"))?.output, 1234567, "the last, after the question");
    assert.equal(codexUsage("OpenAI Codex\ncodex\nOK\ntokens used\n5")?.model, undefined, "no header, no model guessed");
    assert.equal(codexUsage(codexErr("codex\nOK")), undefined);
  });
});
