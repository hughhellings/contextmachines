// Pictures as each AI takes them (vision.ts, ai.ts): request shapes only, no network, no process.
//   node --test cli/vision.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { claudeAskArgs } from "./ai.ts";
import { anthropicContent, claudeStreamArgs, claudeStreamInput, claudeStreamReply, codexImageArgs, compatibleContent, imageRefused, OLLAMA_SEES } from "./vision.ts";

const img = { mime: "image/jpeg" as const, data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) };

describe("a picture, as each AI takes it", () => {
  it("Anthropic: the image block first, then the question; no picture, the question as it was", () => {
    assert.equal(anthropicContent("q"), "q");
    assert.deepEqual(anthropicContent("q", [img]), [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "/9j/2Q==" } }, { type: "text", text: "q" }]);
  });
  it("OpenAI-compatible: the question, then a data address; a refusal about images is told apart", () => {
    assert.equal(compatibleContent("q", []), "q");
    assert.deepEqual(compatibleContent("q", [img]), [{ type: "text", text: "q" }, { type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/2Q==" } }]);
    assert.equal(imageRefused(400, '{"error":{"message":"This model does not support image input"}}'), true);
    assert.equal(imageRefused(400, '{"error":{"message":"Invalid schema"}}'), false);
    assert.equal(imageRefused(500, "image"), false);
    assert.ok(OLLAMA_SEES.test("llava:13b") && OLLAMA_SEES.test("llama3.2-vision") && !OLLAMA_SEES.test("llama3.1"));
  });
  it("Claude Code: one stream-json message on stdin, the same quiet flags, no tools", () => {
    const args = claudeStreamArgs(claudeAskArgs({ text: "sys" }, { type: "object" }, "haiku", "low"));
    assert.deepEqual(args.slice(0, 6), ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"]);
    assert.equal(args.filter((a) => a === "--output-format").length, 1);
    for (const kept of ["--json-schema", "--system-prompt", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence", "--setting-sources"]) assert.ok(args.includes(kept), kept);
    assert.equal(args[args.indexOf("--tools") + 1], "", "no tools: it can read no file");
    const line = JSON.parse(claudeStreamInput("how many bars?", [img])) as { type: string; message: { role: string; content: { type: string }[] } };
    assert.equal(line.type, "user");
    assert.deepEqual(line.message.content.map((c) => c.type), ["image", "text"]);
    assert.ok(claudeStreamInput("q", [img]).endsWith("\n"));
  });
  it("Claude Code's stream-json reply: its last result line", () => {
    const out = ['{"type":"system","subtype":"init"}', "not json", '{"type":"assistant"}', '{"type":"result","is_error":false,"structured_output":{"bars":3},"usage":{"input_tokens":5}}', ""].join("\n");
    assert.deepEqual(claudeStreamReply(out).structured_output, { bars: 3 });
    assert.throws(() => claudeStreamReply('{"type":"system"}'), /no result/);
  });
  it("Codex: each picture with --image right after exec, so the '-' that reads stdin stays the question", () => {
    const base = ["exec", "--skip-git-repo-check", "-C", "/w", "-"];
    assert.deepEqual(codexImageArgs(base, []), base);
    const args = codexImageArgs(base, ["/a/screen-1.jpg"]);
    assert.deepEqual(args, ["exec", "--image", "/a/screen-1.jpg", "--skip-git-repo-check", "-C", "/w", "-"]);
    assert.ok(args[args.indexOf("/a/screen-1.jpg") + 1]!.startsWith("--"), "the flag after the picture ends its list");
  });
});
