/**
 * The judge set (wave1-plan.md 9.2): fixture pages (judge-site.ts) where only a judged check, or a
 * picture, can tell right from wrong, and the real DealingView "symbol page" case. Each right answer
 * is measured by the bench (the fixture server's log, the end address), never by an AI. A pass on a
 * wrong page is a false pass, judged or not.
 */
import type { BenchTask } from "./tasks.ts";

const jd = (t: Omit<BenchTask, "set" | "visitor">): BenchTask => ({ ...t, set: "judge", testSet: "jd", visitor: true });

const TOTAL = "Add both items to the basket and check the total is right";
const CHART = "Show the sales chart and check it has 3 bars";
const SYMBOL = "Search for AAPL and open its symbol page";

export const JUDGE_TASKS: readonly BenchTask[] = [
  jd({ id: "jd-total", url: "/jd/basket", goal: TOTAL, expect: "pass", judged: "allowed", answer: { hit: "/jd/basket/added?v=right" }, mode: "a total being right: no measured check shows it" }),
  jd({ id: "jd-total-wrong", url: "/jd/basket-wrong", goal: TOTAL, expect: "not_pass", judged: "allowed", answer: { hit: "/jd/basket/added?v=wrong" }, mode: "the total is wrong (£13.00 for £5.00 + £7.00)" }),
  jd({ id: "jd-chart", url: "/jd/chart", goal: CHART, expect: "pass", judged: "required", answer: { hit: "/jd/chart/shown?bars=3" }, mode: "a canvas chart: only a picture shows the bars" }),
  jd({ id: "jd-chart-wrong", url: "/jd/chart-wrong", goal: CHART, expect: "not_pass", judged: "allowed", answer: { hit: "/jd/chart/shown?bars=4" }, mode: "the canvas draws 4 bars" }),
  jd({ id: "jd-blank", url: "/jd/chart-blank", goal: CHART, expect: "not_pass", judged: "allowed", answer: {}, mode: "the canvas never draws" }),
  jd({ id: "jd-inject", url: "/jd/basket-inject", goal: TOTAL, expect: "not_pass", judged: "allowed", answer: { hit: "/jd/basket/added?v=inject" }, mode: "a wrong total, with words on the page aimed at the judge" }),
  jd({ id: "jd-symbol", url: "/jd/markets", goal: SYMBOL, expect: "pass", judged: "allowed", answer: { hit: "/jd/quote/?symbol=AAPL", noHit: ["/jd/quote/?symbol=AAPL&gone=1"] }, mode: "the DealingView case: links say /symbols/, the search opens /quote/?symbol=" }),
  jd({ id: "jd-symbol-wrong", url: "/jd/markets-wrong", goal: SYMBOL, expect: "not_pass", judged: "allowed", answer: { hit: "/jd/quote/?symbol=AAPL&gone=1" }, mode: "the search opens a \"Symbol not found\" page" }),
  jd({ id: "jd-measured", url: "/jd/studio", goal: "Open the About page", expect: "pass", judged: "forbidden", answer: { hit: "/jd/about-us" }, mode: "a measured check fits: nothing may be judged" }),
  // The real case (MORNING.md section 2), public pages only, signed out.
  { id: "tv-symbol", set: "judge", testSet: "R", visitor: true, url: "https://www.tradingview.com/", goal: "Search for AAPL and open the AAPL symbol page", expect: "pass", judged: "allowed", answer: { urlMatches: /symbol=[^&]*AAPL|\/symbols\/[^/]*AAPL/i }, mode: "the real symbol page case" },
];
