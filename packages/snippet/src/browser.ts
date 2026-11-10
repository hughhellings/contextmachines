/**
 * Browser entry for the CDN bundle. Exposes a minimal global and drains any
 * calls queued by the loader stub before this file arrived:
 *
 *   window.__ctx = window.__ctx || { q: [] };
 *   window.__ctx.q.push(["init", { key: "pk_live_…", endpoint: "…" }]);
 */
import { init, type Handle, type InitOptions } from "./index.ts";
import { run } from "./safe.ts";

type Call = ["init", InitOptions] | ["identify", string | undefined, string?, string?, string?] | ["shutdown"];
interface Global {
  q?: Call[];
  handle?: Handle;
  push?: (call: Call) => void;
}

run(() => {
  const w = window as unknown as { __ctx?: Global };
  const g: Global = w.__ctx ?? {};
  const dispatch = (call: Call) =>
    run(() => {
      if (call[0] === "init") g.handle = init(call[1]);
      else if (call[0] === "identify") g.handle?.identify(call[1], call[2], call[3], call[4]);
      else if (call[0] === "shutdown") g.handle?.shutdown();
    });
  const queued = g.q ?? [];
  // Calls pushed after load (window.__ctx.q.push(["identify", id]) once someone signs in) run at once.
  const live: Call[] = [];
  live.push = (...calls: Call[]) => {
    calls.forEach(dispatch);
    return 0;
  };
  g.q = live;
  g.push = dispatch;
  w.__ctx = g;
  queued.forEach(dispatch);
});
