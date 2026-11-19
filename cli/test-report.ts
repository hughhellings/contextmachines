/**
 * report.html for one `contextmachines test` run: the goal, the verdict, and each step with what was
 * done in it, how long it took, the photo at its end and a button that jumps the video to where the
 * step began. It works offline: the video (run.webm) and the photos sit beside it, nothing loads from the web.
 * Light and dark follow the reader's system. Every word from the site or the AI is escaped.
 */
import { a11yGroups, a11yNotes, a11ySummary, type A11yResult } from "../packages/scanner/src/tester/a11y.ts";
import { BLOCKED_BY_WALL } from "../packages/scanner/src/tester/botwall.ts";
import { publicUrl } from "./report.ts";
import { expected } from "../packages/scanner/src/tester/check.ts";
import { fillLine } from "../packages/scanner/src/tester/fill.ts";
import type { StepResult, TestResult } from "../packages/scanner/src/tester/types.ts";

export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

/** "0:12": a place in the video; "0:12.4" in a video under a minute, where seconds apart matter. */
export const videoClock = (s: number, fine = false) =>
  fine ? `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}` : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

const VERDICT_WORDS: Record<TestResult["verdict"], string> = { pass: "PASS", fail: "FAIL", blocked: "BLOCKED", not_sure: "NOT SURE" };
const STEP_WORDS: Record<StepResult["verdict"], string> = { passed: "passed", failed: "failed", blocked: "blocked", not_sure: "not sure", skipped: "not run" };
const MARK: Record<StepResult["verdict"], string> = { passed: "✓", failed: "✗", blocked: "■", not_sure: "?", skipped: "–" };

export interface ReportExtras {
  /** The run's folder. */
  dir: string;
  /** Who answered, as the terminal said it: "your Claude Code sign-in". */
  via?: string;
  tokens?: string;
}

/** The photo at a step's end, beside the page; or, when nothing changed since an earlier step, a word saying so. */
function photo(step: StepResult): string {
  if (step.sameShotAs) return `<p class="same">The page looked the same as at the end of step ${step.sameShotAs}.</p>`;
  return step.screenshot ? `<img class="shot" alt="The page at the end of this step" loading="lazy" src="${esc(step.screenshot)}">` : "";
}

function stepRow(step: StepResult, video: boolean, fine: boolean): string {
  const time = step.verdict === "skipped" ? "" : `${(step.ms / 1000).toFixed(1)}s`;
  // A sub-action's own go-to only where it lands somewhere else than its step's.
  const go = (at: number) => (video && Math.abs(at - step.at) >= 0.5 ? ` <button class="go" data-at="${at.toFixed(2)}">${videoClock(at, fine)}</button>` : "");
  const subs = step.actions.length
    ? `<ol class="subs">${step.actions.map((a) => `<li${a.blocked ? ' class="stopped"' : a.error ? ' class="err"' : ""}>${esc(a.label)}${a.error ? ` <span class="why">(${esc(a.error)})</span>` : ""}${a.blocked ? "" : go(a.at)}</li>`).join("")}</ol>`
    : "";
  const evidence = step.evidence ? `<dl class="evidence"><dt>Expected</dt><dd>${esc(step.evidence.expected)}</dd><dt>Found</dt><dd>${esc(step.evidence.found)}</dd></dl>` : "";
  const reason = step.reason && !step.evidence ? `<p class="reason">${esc(step.reason)}</p>` : step.reason && / \(.+\)$/.test(step.reason) ? `<p class="note">${esc(step.reason.slice(step.reason.indexOf(" (") + 1))}</p>` : "";
  const weak = step.weak ? `<p class="note">Note: ${esc(step.weak)}.</p>` : "";
  const filled = step.fill && step.verdict !== "skipped" ? `<p class="note">${esc(fillLine(step.fill).replace(/^f/, "F"))}.</p>` : "";
  const healed = step.healed?.finished
    ? `<p class="healed"><strong>Finished by the AI:</strong> the saved actions stopped short of what the step says (${step.healed.from.map(esc).join("; ")}); the AI did <span class="new">${step.healed.to.map(esc).join(" → ")}</span> to finish it, and the saved test now does that.</p>`
    : step.healed
    ? `<p class="healed"><strong>Healed:</strong> <span class="old">${step.healed.from.map(esc).join(" → ")}</span> no longer worked; the AI did <span class="new">${step.healed.to.map(esc).join(" → ") || "nothing more, as nothing more was needed"}</span> instead, and the saved test now does that.</p>`
    : "";
  // A step an AI judged, not the browser: a badge on its line, the judge's reason, and any check it overruled.
  const judgedBy = step.judged && step.verdict === "passed" ? step.judged : undefined;
  const badge = judgedBy ? `<span class="judged-badge" title="An AI that saw only the final screen judged this step; the browser didn't measure it">Judged by AI</span>` : "";
  const judged = judgedBy
    ? `<p class="judged"><strong>Judged by AI${judgedBy.by === "second opinion" ? " (a second opinion)" : ""}, not measured:</strong> ${esc(judgedBy.reason)}${judgedBy.image ? " (it was sent a picture of the screen, secret fields blacked out)" : ""}</p>${judgedBy.overruled ? `<p class="note">Overruled: ${esc(judgedBy.overruled)}.</p>` : ""}`
    : "";
  const jump = video && step.verdict !== "skipped" ? `<button class="go big" data-at="${step.at.toFixed(2)}">Go to ${videoClock(step.at, fine)}</button>` : "";
  return `<li class="step ${step.verdict}${judgedBy ? " judged-step" : ""}">
  <div class="head"><span class="mark">${MARK[step.verdict]}</span><span class="n">${step.n}</span><span class="title">${esc(step.title)}</span>${badge}<span class="state">${STEP_WORDS[step.verdict]}${step.replayed ? " · replayed" : ""}</span><span class="time">${time}</span>${jump}</div>
  <div class="body">
    <p class="intent">${esc(step.intent)}</p>
    <p class="check">Check: ${esc(expected(step.check))}</p>
    ${subs}${reason}${evidence}${judged}${weak}${filled}${healed}
    ${photo(step)}
  </div>
</li>`;
}

/**
 * "Where a new user might get stuck": what the run met on its way, as the browser measured it. Facts,
 * not advice: each line says what happened and in which step, and the reader decides.
 */
function frictionSection(result: TestResult): string {
  const notes = result.friction ?? [];
  if (!notes.length) return "";
  const title = (n: number) => result.steps.find((s) => s.n === n)?.title ?? "";
  return `<section class="friction">
<h2>Where a new user might get stuck</h2>
<p class="note">What this run met on its way, as the browser measured it: no AI opinion.</p>
<ul>${notes.map((f) => `<li><span class="where">Step ${f.step}${title(f.step) ? ` · ${esc(title(f.step))}` : ""}</span> ${esc(f.says)}</li>`).join("")}</ul>
</section>`;
}

/**
 * "Accessibility": the scan of each same-site page the run reached (a11y.ts), measured by the browser
 * with no AI. Grouped by kind, each with its WCAG reference and why it matters; the capped rest counted.
 */
export function a11ySection(r: A11yResult | undefined, scope = "this run"): string {
  if (!r?.pages) return "";
  const groups = a11yGroups(r);
  const total = groups.reduce((n, g) => n + g.items.length + g.more.reduce((m, x) => m + x.n, 0), 0);
  return `<details class="a11y"${total && total <= 12 ? " open" : ""}>
<summary><h2>Accessibility</h2> <span class="lead">${esc(a11ySummary(r))}</span></summary>
<p class="note">Each page on the site ${esc(scope)} reached, checked once against 8 rules by the browser: no AI opinion, and not a full audit.</p>
${groups.map((g) => `<h3>${esc(g.title)} <span class="wcag">${esc(g.wcag)}</span></h3>
<p class="note">${esc(g.why)}</p>
<ul>${g.items.map((f) => `<li>${esc(f.what)} <span class="where">on ${esc(f.page)}</span></li>`).join("")}${g.more.map((m) => `<li class="more">and ${m.n} more on ${esc(m.page)}</li>`).join("")}</ul>`).join("\n")}
${a11yNotes(r).map((n) => `<p class="note">${esc(n)}</p>`).join("")}
</details>`;
}

/** The CSS for a11ySection, shared by the run's report and the site page. */
export const A11Y_CSS = `.a11y { border: 1px solid var(--line); border-left: 3px solid var(--accent); border-radius: 8px; padding: 10px 14px; margin: 16px 0; }
.a11y summary { cursor: pointer; }
.a11y summary h2 { display: inline; font-size: 16px; margin: 0 8px 0 0; }
.a11y .lead { color: var(--muted); font-size: 14px; }
.a11y h3 { font-size: 14px; margin: 12px 0 0; }
.a11y .wcag { color: var(--muted); font-weight: 400; font-size: 12px; margin-left: 6px; }
.a11y ul { margin: 4px 0 0; padding-left: 18px; }
.a11y li { margin: 2px 0; overflow-wrap: anywhere; font-size: 14px; }
.a11y li.more, .a11y .where { color: var(--muted); font-size: 13px; }`;

export function testReportPage(result: TestResult, extras: ReportExtras): string {
  const video = Boolean(result.video);
  const fine = result.ms < 60_000;
  // The video opens on the first step's photo, not on the blank page it starts with.
  const poster = result.steps.find((s) => s.screenshot)?.screenshot;
  const host = (() => {
    try {
      return new URL(result.url).host;
    } catch {
      return result.url;
    }
  })();
  // Runs from before A1 only (a run then could pause for a person): what a person did mid-run is said, never
  // left as a bare PASS. A code typed is said as a code, not as a bot check. No run waits for a person now.
  const byHand = (result.handovers ?? []).filter((h) => h.outcome === "resumed");
  const codes = byHand.filter((h) => h.request.reason === "sign_in_code").length;
  const checks = byHand.length - codes;
  const handWhen = byHand.map((h) => `${h.request.host}, ${new Date(h.endedAt).toLocaleTimeString("en-GB")}`).join("; ");
  const handWords = byHand.length ? `${[checks ? `a person passed ${checks === 1 ? "a bot check" : `${checks} bot checks`} by hand` : "", codes ? `a person typed ${codes === 1 ? "a sign-in code" : `${codes} sign-in codes`}` : ""].filter(Boolean).join(" and ")} (${handWhen})` : "";
  const meta = [`${result.passed}/${result.steps.length} steps`, result.judged ? `${result.judged} step${result.judged === 1 ? "" : "s"} judged by AI, not measured` : "", handWords, `${(result.ms / 1000).toFixed(1)}s`, `${result.actions} action${result.actions === 1 ? "" : "s"}`, result.replay ? "replayed from the saved test" : "", extras.tokens ?? "", extras.via ? `AI: ${extras.via}` : "", new Date(result.startedAt).toLocaleString("en-GB")].filter(Boolean);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Test ${esc(VERDICT_WORDS[result.verdict])}: ${esc(result.goal)}</title>
<style>
:root { --bg: #ffffff; --fg: #17181c; --muted: #5d6270; --line: #e3e5ea; --card: #f6f7f9; --pass: #16794a; --fail: #c62828; --warn: #a15c00; --accent: #2b59c3; }
@media (prefers-color-scheme: dark) { :root { --bg: #111317; --fg: #e8e9ec; --muted: #9aa0ac; --line: #2a2d34; --card: #181b20; --pass: #4cc38a; --fail: #ff6b6b; --warn: #f0a640; --accent: #7aa2ff; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 980px; margin: 0 auto; padding: 24px 16px 64px; }
h1 { font-size: 22px; margin: 0 0 4px; overflow-wrap: anywhere; }
.verdict { display: inline-block; font-weight: 700; padding: 2px 10px; border-radius: 6px; color: #fff; margin-right: 8px; }
.verdict.pass { background: var(--pass); } .verdict.fail { background: var(--fail); } .verdict.blocked, .verdict.not_sure { background: var(--warn); }
.meta { color: var(--muted); margin: 0 0 16px; }
.stopped { color: var(--warn); }
.wall { color: var(--warn); border: 1px solid var(--line); border-left: 3px solid var(--warn); border-radius: 8px; padding: 10px 14px; margin: 0 0 16px; overflow-wrap: anywhere; }
video { width: 100%; border-radius: 8px; border: 1px solid var(--line); background: #000; margin-bottom: 16px; position: sticky; top: 0; z-index: 1; max-height: 45vh; }
.signinvideo { margin: 0 0 16px; font-size: 14px; }
.signinvideo video { position: static; margin: 8px 0 0; }
ol.steps { list-style: none; padding: 0; margin: 0; }
.step { border: 1px solid var(--line); border-radius: 8px; margin-bottom: 10px; background: var(--card); }
.head { display: flex; gap: 10px; align-items: center; padding: 10px 12px; flex-wrap: wrap; }
.mark { font-weight: 700; width: 1em; }
.passed .mark { color: var(--pass); } .failed .mark { color: var(--fail); } .blocked .mark, .not_sure .mark { color: var(--warn); } .skipped { opacity: .6; }
.n { color: var(--muted); }
.title { font-weight: 600; flex: 1; min-width: 12em; overflow-wrap: anywhere; }
.state, .time { color: var(--muted); font-size: 13px; }
.body { padding: 0 12px 12px 40px; }
.intent { margin: 0 0 4px; } .check { margin: 0 0 8px; color: var(--muted); font-size: 13px; }
.subs { margin: 0 0 8px; padding-left: 18px; color: var(--muted); font-size: 14px; }
.subs li.err { color: var(--warn); }
.subs li.stopped { color: var(--warn); font-weight: 600; }
.note, .same { color: var(--muted); font-size: 13px; margin: 6px 0; }
.why { font-size: 12px; }
.reason { color: var(--warn); margin: 6px 0; }
.failed .reason { color: var(--fail); }
.evidence { display: grid; grid-template-columns: max-content 1fr; gap: 2px 12px; margin: 8px 0; font-size: 14px; }
.evidence dt { font-weight: 600; } .evidence dd { margin: 0; overflow-wrap: anywhere; }
.healed { border-left: 3px solid var(--warn); padding-left: 8px; font-size: 14px; }
.judged { border-left: 3px solid var(--warn); padding-left: 8px; font-size: 14px; }
.judged-badge { font-size: 12px; font-weight: 600; color: var(--warn); border: 1px solid var(--warn); border-radius: 4px; padding: 0 6px; }
.passed.judged-step .mark { color: var(--warn); }
.healed .old { text-decoration: line-through; color: var(--muted); }
.shot { max-width: 100%; border: 1px solid var(--line); border-radius: 6px; margin-top: 6px; }
button.go { font: inherit; font-size: 12px; color: var(--accent); background: none; border: 1px solid var(--line); border-radius: 4px; padding: 0 6px; cursor: pointer; }
button.go.big { font-size: 13px; padding: 2px 8px; }
button.go:hover { border-color: var(--accent); }
.friction { border: 1px solid var(--line); border-left: 3px solid var(--warn); border-radius: 8px; padding: 10px 14px; margin: 16px 0; }
.friction h2 { font-size: 16px; margin: 0 0 2px; }
.friction ul { margin: 6px 0 0; padding-left: 18px; }
.friction li { margin: 2px 0; overflow-wrap: anywhere; }
.friction .where { color: var(--muted); font-size: 13px; margin-right: 6px; }
${A11Y_CSS}
</style>
</head>
<body>
<main>
<h1><span class="verdict ${result.verdict}">${VERDICT_WORDS[result.verdict]}</span>${esc(result.goal)}</h1>
<p class="meta">${esc(host)} · ${meta.map(esc).join(" · ")}</p>
${result.endUrl ? `<p class="meta addresses">Started at <code>${esc(publicUrl(result.url))}</code> · ended at <code>${esc(publicUrl(result.endUrl))}</code></p>` : ""}
${result.replanned ? `<p class="stopped">${esc(result.replanned)}</p>` : ""}
${result.startWarning ? `<p class="stopped">${esc(publicUrl(result.startWarning))}: is this the address you meant?</p>` : ""}
${result.stopped ? `<p class="stopped">Stopped early: ${esc(result.stopped)}.</p>` : ""}
${result.botWall ? `<p class="wall"><b>${esc(BLOCKED_BY_WALL)}</b> (${esc(result.botWall)}): the site didn't let the test browser in. Context Machines doesn't get past bot checks: try a site you own, its staging address, or ask the owner to let the tester through.</p>` : ""}
${video ? `<video id="video" src="${esc(result.video)}"${poster ? ` poster="${esc(poster)}"` : ""} controls preload="metadata" playsinline></video>` : ""}
${video && result.videoNote ? `<p class="meta videonote">${esc(result.videoNote)}</p>` : ""}
${video && result.signInVideo ? `<details class="signinvideo"><summary>The sign-in, in its own video (its boxes show dots)</summary><video src="${esc(result.signInVideo)}" controls preload="none" playsinline></video></details>` : ""}
<ol class="steps">
${result.steps.map((s) => stepRow(s, video, fine)).join("\n")}
</ol>
${frictionSection(result)}
${a11ySection(result.accessibility)}
</main>
<script>
document.addEventListener("click", function (e) {
  var b = e.target.closest && e.target.closest("button.go");
  var v = document.getElementById("video");
  if (!b || !v) return;
  v.currentTime = Number(b.getAttribute("data-at")) || 0;
  v.play().catch(function () {});
  v.scrollIntoView({ block: "nearest" });
});
</script>
</body>
</html>
`;
}
