/**
 * A picture of the screen, as each AI takes one: the request shapes only (no network, no process).
 * The picture is a JPEG in memory, its secret fields already blacked out and checked so (shot.ts). It
 * is never written to disk here, never logged, and never counted as one of the run's photos. Codex is
 * the one AI that needs a file: ai.ts writes it into that ask's own temporary folder and deletes it.
 */

/** A picture as handed to an ask. */
export interface AskImage {
  mime: "image/jpeg";
  data: Buffer;
}

/** What an ask may take besides its words. Optional everywhere, so every older caller is unchanged. */
export interface AskMore {
  images?: readonly AskImage[];
}

/** Anthropic's Messages API: the pictures first, then the question, in one user turn. */
export function anthropicContent(question: string, images: readonly AskImage[] = []): string | ({ type: "image"; source: { type: "base64"; media_type: "image/jpeg"; data: string } } | { type: "text"; text: string })[] {
  if (!images.length) return question;
  return [...images.map((i) => ({ type: "image" as const, source: { type: "base64" as const, media_type: i.mime, data: i.data.toString("base64") } })), { type: "text" as const, text: question }];
}

/** The OpenAI chat format (OpenAI, Gemini, gateways, Ollama): the question, then each picture as a data address. */
export function compatibleContent(question: string, images: readonly AskImage[] = []): string | ({ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } })[] {
  if (!images.length) return question;
  return [{ type: "text" as const, text: question }, ...images.map((i) => ({ type: "image_url" as const, image_url: { url: `data:${i.mime};base64,${i.data.toString("base64")}` } }))];
}

/** A server's refusal that is about the picture (a model that takes none): asked again without it. */
export const IMAGE_REFUSED = /\b(image|images|vision|multimodal|multi-modal|image_url|content part|modalit(y|ies))\b/i;

/** Whether a refusal (status and body) is about the picture. */
export const imageRefused = (status: number, body: string) => status >= 400 && status < 500 && IMAGE_REFUSED.test(body);

/** Ollama models that take pictures, by name: only these are sent one. */
export const OLLAMA_SEES = /llava|bakllava|vision|[-_.]vl\b|vl[:-]|gemma3|minicpm-v|moondream|granite3\.2-vision|qwen2\.5vl|mistral-small3\.1|llama4/i;

/** The extra arguments Claude Code takes for a question with pictures: one user message on stdin, as stream-json. */
export const CLAUDE_STREAM_ARGS = ["--input-format", "stream-json", "--output-format", "stream-json", "--verbose"] as const;

/** Claude Code's stdin for a question with pictures: one JSON line, the pictures first. */
export function claudeStreamInput(question: string, images: readonly AskImage[]): string {
  const content = anthropicContent(question, images);
  return `${JSON.stringify({ type: "user", message: { role: "user", content: typeof content === "string" ? [{ type: "text", text: content }] : content } })}\n`;
}

/**
 * Claude Code's arguments for a question with pictures: its usual quiet ones, with the JSON output
 * swapped for stream-json in and out. Every other flag (no tools, no settings, no servers) stays.
 */
export function claudeStreamArgs(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--output-format") {
      i++;
      continue;
    }
    out.push(args[i]!);
  }
  const at = out.indexOf("-p");
  out.splice(at < 0 ? 0 : at + 1, 0, ...CLAUDE_STREAM_ARGS);
  return out;
}

/** Claude Code's reply in stream-json: its last {"type":"result"} line, read as its JSON reply is. */
export function claudeStreamReply(out: string): Record<string, unknown> {
  let last: Record<string, unknown> | undefined;
  for (const line of out.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const v = JSON.parse(t) as Record<string, unknown>;
      if (v && v.type === "result") last = v;
    } catch {
      // a line that isn't JSON: not the reply
    }
  }
  if (!last) throw new Error("Claude Code gave no result");
  return last;
}

/**
 * Codex's arguments with pictures: each attached with --image, right after `exec`, so the "-" that
 * reads the question from stdin is never taken for a picture. Built from Codex's documented flag
 * (`codex exec --help`: -i, --image <FILE>...); not tried live yet (decisions W1-D5).
 */
export function codexImageArgs(args: readonly string[], files: readonly string[]): string[] {
  if (!files.length) return [...args];
  const at = args.indexOf("exec");
  const images = files.flatMap((f) => ["--image", f]);
  return at < 0 ? [...images, ...args] : [...args.slice(0, at + 1), ...images, ...args.slice(at + 1)];
}
