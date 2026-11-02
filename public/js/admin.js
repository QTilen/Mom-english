import { api, h, toast } from "./api.js";

const app = document.getElementById("app");
const LEVELS = ["Pre-A1", "A1.1", "A1.2", "A1.3", "A2.1", "A2.2"];
const SKILL_SL = { vocabulary: "Besedišče", grammar: "Slovnica", reading: "Branje", writing: "Pisanje" };
const REASON_SL = { placement: "preizkus", placement_writing: "preizkus (pisanje)", auto_up: "napredovala", auto_down: "nazaj" };
const STATUS_SL = { ready: "pripravljena", in_progress: "v teku", completed: "opravljena" };

const fmt = (iso) => (iso ? new Date(iso).toLocaleString("sl-SI", { dateStyle: "short", timeStyle: "short" }) : "–");

function table(headers, rows) {
  return h("div", { class: "table-wrap" },
    h("table", {}, h("thead", {}, h("tr", {}, headers.map((x) => h("th", {}, x)))), h("tbody", {}, rows.map((r) => h("tr", {}, r.map((c) => h("td", {}, c)))))));
}

function loginScreen(message) {
  const input = h("input", { class: "text-input", type: "password", inputmode: "numeric", autocomplete: "current-password", "aria-label": "PIN", style: "max-width:240px" });
  const submit = async (e) => {
    e.preventDefault();
    try {
      await api("/admin/login", { pin: input.value });
      load();
    } catch (err) {
      loginScreen(err.message);
    }
  };
  app.replaceChildren(
    h("form", { class: "card", onsubmit: submit, style: "max-width:460px" },
      h("h1", { style: "margin-top:0" }, "Vstop za skrbnika"),
      message ? h("p", { class: "muted" }, message) : null,
      input,
      h("div", { class: "actions" }, h("button", { class: "btn", type: "submit" }, "Vstopi"))),
  );
  input.focus();
}

function accuracyChart(sessions) {
  const done = sessions.filter((s) => s.status === "completed" && s.graded > 0).reverse();
  if (done.length < 2) return h("p", { class: "small" }, "Graf se pokaže po vsaj dveh opravljenih vajah.");
  const W = 600, H = 160, P = 28;
  const x = (i) => P + (i * (W - 2 * P)) / (done.length - 1);
  const y = (v) => H - P - v * (H - 2 * P);
  const pts = done.map((s, i) => [x(i), y(s.correct / s.graded)]);
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("class", "chart");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Uspešnost po vajah");
  const el = (tag, attrs, text, parent = svg) => {
    const n = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (text) n.textContent = text;
    parent.append(n);
    return n;
  };
  for (const v of [0, 0.5, 0.85, 1]) {
    el("line", { class: "grid", x1: P, x2: W - P, y1: y(v), y2: y(v) });
    el("text", { x: 2, y: y(v) + 4 }, `${Math.round(v * 100)}%`);
  }
  el("polyline", { class: "line", points: pts.map((p) => p.join(",")).join(" ") });
  pts.forEach((p, i) => {
    const dot = el("circle", { class: "dot", cx: p[0], cy: p[1], r: 4 });
    el("title", {}, `${done[i].local_date}: ${done[i].correct}/${done[i].graded}`, dot);
  });
  return svg;
}

function rewardsCard(d) {
  const nameInput = h("input", { type: "text", value: d.settings.learnerName, style: "width:200px" });
  const textInput = h("input", { type: "text", value: d.settings.rewardText, style: "width:100%", maxlength: "200" });
  const everyInput = h("input", { type: "number", min: "3", max: "100", value: d.settings.rewardEveryDays });
  const save = async (e) => {
    e.preventDefault();
    try {
      await api("/admin/settings", { learnerName: nameInput.value, rewardText: textInput.value, rewardEveryDays: Number(everyInput.value) });
      toast("Shranjeno.");
      load();
    } catch (err) {
      toast(err.message);
    }
  };
  const given = (id) => async () => {
    await api(`/admin/rewards/${id}/given`, {});
    load();
  };
  return h("form", { class: "card", onsubmit: save },
    h("h2", {}, "Nagrade in osebno"),
    h("div", { class: "form-row" }, h("label", {}, "Ime učenke"), nameInput),
    h("div", { class: "form-row" }, h("label", {}, "Nagrada vsakih (dni zapored)"), everyInput),
    h("div", { class: "form-row", style: "flex-wrap:wrap" }, h("label", {}, "Naslednja nagrada"), textInput),
    h("p", { class: "small" }, `Trenutno: ⭐ ${d.stars} zvezdic · do nagrade še ${d.reward.daysLeft} dni (${d.reward.current}/${d.reward.every}). Besedilo nagrade se zabeleži ob odklepu.`),
    h("div", { class: "actions" }, h("button", { class: "btn", type: "submit" }, "Shrani")),
    d.rewards.length
      ? table(["Odklenjeno", "Niz", "Nagrada", ""],
          d.rewards.map((r) => [r.unlocked_on, r.streak, r.reward_text,
            r.given_at ? h("span", { class: "pill ok" }, `podeljena ${fmt(r.given_at)}`) : h("button", { class: "btn secondary", type: "button", onclick: given(r.id) }, "Označi kot podeljeno")]))
      : h("p", { class: "small" }, "Nobena nagrada še ni odklenjena."));
}

function settingsCard(settings) {
  const fields = [
    ["targetMinutes", "Trenutna dolžina vaje (min)"],
    ["capMinutes", "Največja dolžina (min)"],
    ["stepMinutes", "Korak povečanja (min)"],
    ["freezesPerWeek", "Zamrznitve na teden"],
  ];
  const inputs = Object.fromEntries(fields.map(([k]) => [k, h("input", { type: "number", min: "0", max: "60", value: settings[k] })]));
  const save = async (e) => {
    e.preventDefault();
    const body = {};
    for (const [k] of fields) if (Number(inputs[k].value) !== settings[k]) body[k] = Number(inputs[k].value);
    if (!Object.keys(body).length) return toast("Ni sprememb.");
    try {
      await api("/admin/settings", body);
      toast("Shranjeno.");
      load();
    } catch (err) {
      toast(err.message);
    }
  };
  return h("form", { class: "card", onsubmit: save },
    h("h2", {}, "Dolžina vaj"),
    fields.map(([k, label]) => h("div", { class: "form-row" }, h("label", {}, label), inputs[k])),
    h("p", { class: "small" }, "Dolžina se sama poveča po 7 vajah v 8 dneh in zmanjša po 3+ dneh odsotnosti."),
    h("div", { class: "actions" }, h("button", { class: "btn", type: "submit" }, "Shrani")));
}

function claudeCard(c) {
  const status = c.apiKeyPresent
    ? h("span", { class: "pill bad" }, "ANTHROPIC_API_KEY je nastavljen – Claude izklopljen")
    : !c.installed
      ? h("span", { class: "pill bad" }, "CLI ni nameščen")
      : c.lastError && (!c.lastOk || c.lastError.at > c.lastOk)
        ? h("span", { class: "pill bad" }, `Zadnji klic ni uspel (${c.lastError.kind})`)
        : h("span", { class: "pill ok" }, "Deluje");
  const testOut = h("p", { class: "small" });
  const test = async () => {
    testOut.textContent = "Kličem Claude … (lahko traja do minute)";
    const r = await api("/admin/claude-test", {});
    testOut.textContent = r.ok ? `Uspelo: »${r.reply}«` : `Napaka: ${r.error}`;
  };
  return h("div", { class: "card" },
    h("h2", {}, "Claude CLI"),
    h("p", {}, status),
    h("p", { class: "small" }, `Različica: ${c.version ?? "–"} · zadnji uspeh: ${fmt(c.lastOk)} · zadnjih 24 h: ${c.last24h.ok} ok / ${c.last24h.failed} napak`),
    c.lastError ? h("p", { class: "mono" }, `${fmt(c.lastError.at)} ${c.lastError.kind}: ${c.lastError.message}`) : null,
    h("div", { class: "actions" }, h("button", { class: "btn secondary", onclick: test }, "Preizkusi Claude")),
    testOut);
}

function actionsCard(data) {
  const run = (path, body, msg) => async () => {
    try {
      await api(path, body ?? {});
      toast(msg);
      setTimeout(load, 600);
    } catch (err) {
      toast(err.message);
    }
  };
  const levelSelect = h("select", { class: "text-input", style: "width:auto;font-size:16px;padding:6px 10px" }, LEVELS.map((l, i) => h("option", { value: i }, l)));
  return h("div", { class: "card" },
    h("h2", {}, "Dejanja"),
    h("p", { class: "small" },
      data.readySession
        ? `Pripravljena naslednja vaja: #${data.readySession.id} (${data.readySession.generated_by === "claude" ? "Claude" : "iz banke"}, ${fmt(data.readySession.created_at)})`
        : "Naslednja vaja še ni pripravljena (pripravi se ob odprtju iz banke)."),
    h("div", { class: "actions", style: "margin-top:8px" },
      h("button", { class: "btn", onclick: run("/admin/regenerate", {}, "Priprava jutrišnje vaje se je začela v ozadju.") }, "Ponovno pripravi jutrišnjo vajo"),
      h("button", { class: "btn secondary", onclick: run("/admin/retry-failed", {}, "Neuspela opravila so znova v vrsti.") }, "Ponovi neuspela opravila")),
    h("div", { class: "actions" },
      levelSelect,
      h("button", { class: "btn secondary", onclick: () => run("/admin/refill", { level: Number(levelSelect.value) }, "Dopolnjevanje banke se je začelo.")() }, "Dopolni banko vaj"),
      h("div", { class: "spacer" }),
      h("button", {
        class: "btn secondary",
        onclick: () => confirm("Ponastavim uvodni preizkus? Ob naslednjem obisku ga bo ponovno reševala.") && run("/admin/reset-placement", {}, "Preizkus ponastavljen.")(),
      }, "Ponastavi uvodni preizkus")));
}

async function load() {
  let d;
  try {
    d = await api("/admin/overview");
  } catch (err) {
    if (err.status === 401) return loginScreen();
    app.replaceChildren(h("p", {}, err.message));
    return;
  }
  const bankBy = {};
  for (const b of d.bank) (bankBy[b.level] ??= {})[b.skill] = b.n;

  app.replaceChildren(
    h("h1", {}, "Pregled"),
    h("div", { class: "stats" },
      h("div", { class: "stat" }, h("div", { class: "num" }, `🔥 ${d.streak}`), h("div", { class: "lbl" }, `niz (najdaljši ${d.bestStreak}), zamrznitve ta teden: ${d.freezesLeft}`)),
      h("div", { class: "stat" }, h("div", { class: "num" }, d.wordsLearned), h("div", { class: "lbl" }, "naučenih besed")),
      h("div", { class: "stat" }, h("div", { class: "num" }, d.sessions.filter((s) => s.status === "completed").length), h("div", { class: "lbl" }, "opravljenih vaj (zadnjih 60)")),
      h("div", { class: "stat" }, h("div", { class: "num" }, `${d.settings.targetMinutes} min`), h("div", { class: "lbl" }, `dnevna vaja (največ ${d.settings.capMinutes})`))),
    h("div", { class: "grid2" },
      h("div", { class: "card" },
        h("h2", {}, "Ravni"),
        table(["Veščina", "Raven"], d.levels.map((l) => [l.label_sl, h("b", {}, l.levelLabel)])),
        h("h2", { style: "margin-top:18px" }, "Zgodovina ravni"),
        table(["Kdaj", "Veščina", "Sprememba", "Razlog"],
          d.levelHistory.slice().reverse().slice(0, 20).map((x) => [fmt(x.created_at), SKILL_SL[x.skill], `${x.from_level === null ? "–" : LEVELS[x.from_level]} → ${LEVELS[x.to_level]}`, REASON_SL[x.reason] ?? x.reason]))),
      h("div", {}, claudeCard(d.claude), settingsCard(d.settings))),
    rewardsCard(d),
    actionsCard(d),
    h("div", { class: "card" }, h("h2", {}, "Uspešnost po vajah"), accuracyChart(d.sessions)),
    h("div", { class: "card" },
      h("h2", {}, "Zgodovina vaj"),
      table(["#", "Datum", "Stanje", "Vir", "Dolžina", "Pravilno", "Čas"],
        d.sessions.map((s) => [
          s.id,
          s.local_date ?? fmt(s.created_at),
          STATUS_SL[s.status] ?? s.status,
          s.generated_by === "claude" ? "Claude" : "banka",
          `${s.target_minutes} min`,
          s.graded ? `${s.correct ?? 0}/${s.graded}` : "–",
          s.ms ? `${Math.round(s.ms / 60000)} min` : "–",
        ]))),
    h("div", { class: "grid2" },
      h("div", { class: "card" },
        h("h2", {}, "Napake po kategorijah"),
        table(["Kategorija", "30 dni", "Skupaj"], d.mistakeCounts.map((m) => [m.label_sl, m.recent, m.total]))),
      h("div", { class: "card" },
        h("h2", {}, "Zadnje napake"),
        table(["Kdaj", "Kategorija", "Njen odgovor"], d.recentMistakes.map((m) => [fmt(m.created_at), m.category, m.detail ?? ""])))),
    h("div", { class: "card" },
      h("h2", {}, "Pisanje in prevodi"),
      table(["Kdaj", "Vrsta", "Stanje", "Besedilo", "Popravek"],
        d.reviews.map((r) => {
          const res = r.result_json ? JSON.parse(r.result_json) : null;
          return [fmt(r.created_at), r.kind === "write" ? "pisanje" : "prevod", r.status, h("span", { class: "mono" }, r.text), res ? h("span", { class: "mono" }, `${res.corrected_text}${res.score !== undefined ? ` (${res.score})` : ""}`) : "–"];
        }))),
    h("div", { class: "grid2" },
      h("div", { class: "card" },
        h("h2", {}, "Opravila v ozadju"),
        table(["#", "Vrsta", "Stanje", "Poskusi", "Napaka"], d.jobs.map((j) => [j.id, j.type, j.status, j.tries, h("span", { class: "mono" }, j.last_error ?? "")]))),
      h("div", { class: "card" },
        h("h2", {}, "Banka vaj"),
        table(["Raven", "Besedišče", "Slovnica", "Branje", "Pisanje"],
          LEVELS.map((l, i) => [l, bankBy[i]?.vocabulary ?? 0, bankBy[i]?.grammar ?? 0, bankBy[i]?.reading ?? 0, bankBy[i]?.writing ?? 0])))),
    h("div", { class: "actions" }, h("button", { class: "btn secondary", onclick: async () => { await api("/admin/logout", {}); loginScreen(); } }, "Odjava")),
  );
}

load();
