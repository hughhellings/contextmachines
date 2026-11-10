import { standInApp } from "./stand-in-app.ts";

/**
 * An app with journeys in it: a first run of three steps, a list to add to, an import, and every
 * kind of thing a walk must never go through with. What's on each control is the trap: some say what
 * they do, and some ("Carry on", "Next up", "Finish up") say nothing of a card page, a sign-in
 * elsewhere or a pop-up. A flag saved to the database is what opens the last screen, as it is
 * in life, and the two servers write down everything they get, which is the test.
 */
const OWN = `
const json = (path, init = {}) => rest(path, { ...init, headers: { "content-type": "application/json", prefer: "return=representation", ...(init.headers || {}) } }).then((r) => r.json());
const menu = '<nav><a href="/home">Home</a> <a href="/trades">Trades</a> <a href="/patterns">Patterns</a> <button id="out">Log out</button></nav>';
const leaves = {
  "/oauth-start": () => location.assign("https://accounts.example/oauth/authorize?client_id=1"),
  "/pay-start": () => location.assign("https://pay.example/checkout/abc"),
  "/popup-start": () => window.open("https://elsewhere.example/page"),
  "/ways-out": () => {
    fetch("/api/save", { method: "POST", body: "{}" }).catch(() => {});
    fetch(BACKEND + "/hook", { method: "POST", body: "{}" }).catch(() => {});
    navigator.sendBeacon(BACKEND + "/beacon", "{}");
    new Image().src = BACKEND + "/pixel.png";
    try { new WebSocket(BACKEND.replace("http", "ws") + "/socket"); } catch {}
    const form = document.createElement("form");
    form.action = BACKEND + "/form";
    form.method = "post";
    document.body.appendChild(form);
    form.submit();
  },
  "/proto-start": async () => {
    const send = (name, method) => rest(name, { method, headers: { "content-type": "application/json" }, body: JSON.stringify({ polluted: "by the page", path: "/etc/hosts", method: "DELETE" }) }).catch(() => {});
    for (const name of ["__proto__", "constructor"]) for (const method of ["PATCH", "POST"]) await send(name, method);
    await fetch("/api/anything").catch(() => {});
  },
  "/mail-start": async () => fetch(BACKEND + "/functions/v1/send-invite", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
};
if (leaves[page]) {
  draw(menu + '<main><h1>One more thing</h1><p>A plain screen with one way on, and nothing to say where that goes.</p><button id="go">Next up</button></main>');
  document.getElementById("go").onclick = leaves[page];
  return;
}
if (page === "/home") {
  const profile = (await rest("profiles?select=*&id=eq." + session.user.id).then((r) => r.json()))[0];
  draw(menu + '<main><h1>' + (profile && profile.onboarded ? "Your desk" : "Welcome") + '</h1><p>Your desk, kept for you, with everything you have logged so far.</p>' +
    '<button id="add">Add trade</button> <a href="/import">Import trades</a> <button>Upgrade to Pro</button> <button>Connect a bank</button> <button>Invite teammates</button> <button id="wipe">Delete everything</button></main>');
  document.getElementById("add").onclick = () => { location.href = "/trades/new"; };
  document.getElementById("wipe").onclick = () => { if (confirm("Delete everything for good?")) window.wiped = true; };
  return;
}
if (page === "/onboarding") {
  let step = 1;
  let goal = "";
  const show = () => {
    if (step === 1) {
      draw('<main><h1>Tell us about you</h1><p>Step 1 of 3</p><form id="f"><label>Your name <input name="name" required></label><button type="submit">Continue</button></form></main>');
      document.getElementById("f").onsubmit = (e) => { e.preventDefault(); step = 2; show(); };
    } else if (step === 2) {
      draw('<main><h1>What brings you here</h1><p>Step 2 of 3</p><div class="cards"><button class="card">Keep a notebook</button><button class="card">Learn from it</button></div><button id="next" disabled>Next</button></main>');
      for (const card of document.querySelectorAll(".card")) card.onclick = () => { goal = card.textContent; document.getElementById("next").disabled = false; };
      document.getElementById("next").onclick = () => { step = 3; show(); };
    } else {
      draw('<main><h1>All set</h1><p>Step 3 of 3</p><button id="end">Finish</button></main>');
      document.getElementById("end").onclick = async () => {
        await json("profiles?id=eq." + session.user.id, { method: "PATCH", body: JSON.stringify({ onboarded: true, goal }) });
        location.href = "/home";
      };
    }
  };
  return show();
}
if (page === "/trades/new") {
  draw(menu + '<main><h1>New trade</h1><form id="f"><label>Symbol <input name="symbol" required></label><label>Notes <textarea name="notes"></textarea></label><button type="submit">Save trade</button></form></main>');
  document.getElementById("f").onsubmit = async (e) => {
    e.preventDefault();
    await json("trades", { method: "POST", body: JSON.stringify({ symbol: e.target.symbol.value, notes: e.target.notes.value }) });
    location.href = "/trades";
  };
  return;
}
if (page === "/trades") {
  const rows = await rest("trades?select=*").then((r) => r.json());
  draw(menu + '<main><h1>Trades</h1>' + (rows.length ? '<ul>' + rows.map((t) => '<li>' + t.symbol + '</li>').join("") + '</ul><p>Log 12 more trades to unlock your report.</p>' : '<p>No trades yet.</p><a href="/trades/new">Add your first trade</a>') + '</main>');
  return;
}
if (page === "/patterns") {
  draw(menu + '<main><h1>Patterns</h1><p>Part of Pro. Upgrade to Pro to see what your trades have in common.</p><button>Upgrade to Pro</button></main>');
  return;
}
if (page === "/import") {
  draw(menu + '<main><h1>Bring your trades in</h1><p>However suits you, and you can change your mind later on.</p><div><button class="way" id="file">Upload a file</button><button class="way" id="paste">Paste them in</button><button class="way">Connect a platform</button></div></main>');
  document.getElementById("file").onclick = () => { location.href = "/import/file"; };
  document.getElementById("paste").onclick = () => { location.href = "/import/paste"; };
  return;
}
if (page === "/import/file") {
  draw(menu + '<main><h1>Choose your file</h1><p>A statement from your bank, as it came. It stays on your machine until you say.</p><input type="file" id="pick" accept=".csv"></main>');
  return;
}
if (page === "/import/paste") {
  draw(menu + '<main><h1>Paste them in</h1><form id="f"><label>Rows <textarea name="rows" required></textarea></label><button type="submit">Check them</button></form></main>');
  document.getElementById("f").onsubmit = async (e) => {
    e.preventDefault();
    const report = await rest("rpc/check_rows", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rows: e.target.rows.value }) }).then((r) => r.json());
    draw(menu + "<main><h1>" + report.summary.total + " rows</h1></main>");
  };
  return;
}
if (page === "/summary") {
  draw(menu + '<main><h1>Your summary</h1><p>What your trades say, once there are enough of them to say it.</p><button id="make">Make my summary</button></main>');
  document.getElementById("make").onclick = async () => {
    const answer = await rest("rpc/make_report", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).then((r) => r.json());
    draw(answer.pages.map((p) => p.title).join());
  };
  return;
}
if (page === "/picker") {
  draw(menu + '<main><h1>Pick a folder</h1><p>Anything you have saved already can come straight in from here.</p><button id="go">Open folder</button></main>');
  document.getElementById("go").onclick = () => showDirectoryPicker();
  return;
}
if (page === "/card") {
  draw(menu + '<main><h1>Your details</h1><form><label>Card number <input name="card" autocomplete="cc-number"></label><button type="submit">Carry on</button></form></main>');
  return;
}
`;

export const journeysApp = () => standInApp({ own: OWN });
