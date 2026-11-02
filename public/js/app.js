import { api, h, toast } from "./api.js";
import { renderExercise, renderFeedback } from "./exercises.js";

const app = document.getElementById("app");

function show(...nodes) {
  app.replaceChildren(...nodes);
  window.scrollTo({ top: 0 });
}

function loading() {
  show(h("div", { class: "spinner", "aria-label": "Nalagam" }));
}

function errorScreen(err) {
  show(
    h("div", { class: "card center" },
      h("h1", {}, "Ups, nekaj se je zataknilo"),
      h("p", { class: "muted" }, "Ni tvoja krivda. Poskusi znova čez trenutek."),
      h("p", { class: "muted", style: "font-size:16px" }, err?.message ?? ""),
      h("div", { class: "actions", style: "justify-content:center" }, h("button", { class: "btn", onclick: route }, "Poskusi znova"))),
  );
}

const pick = (xs) => xs[Math.floor(Math.random() * xs.length)];

// Slovenian has singular, dual and plural forms: 1 dan, 2 dneva, 3 dnevi, 5 dni.
function plural(n, one, two, few, many) {
  const m = Math.abs(n) % 100;
  return m === 1 ? one : m === 2 ? two : m === 3 || m === 4 ? few : many;
}
const daysWord = (n) => plural(n, "dan", "dneva", "dnevi", "dni");

// --- One exercise card ---------------------------------------------------------

// Shared by the placement test (no feedback, plus "Ne vem") and daily practice
// (gentle feedback after each answer).
function exerciseCard({ item, progress, heading, placement, submit, next }) {
  const started = Date.now();
  const feedbackSlot = h("div");
  const check = h("button", { class: "btn", type: "button", disabled: true, onclick: onCheck }, placement ? "Naprej" : "Preveri");
  const skip = placement
    ? h("button", { class: "btn secondary", type: "button", onclick: () => send({ skip: true }) }, item.view.type === "write" ? "Preskoči" : "Ne vem")
    : null;
  const nextBtn = h("button", { class: "btn", type: "button", hidden: true, onclick: next }, "Naprej →");
  const ex = renderExercise(item.view, {
    skill: item.skill,
    onChange: () => (check.disabled = !ex.ready()),
    onEnter: () => ex.ready() && onCheck(),
  });

  let busy = false;
  async function send(answer) {
    if (busy) return;
    busy = true;
    check.disabled = true;
    if (skip) skip.disabled = true;
    try {
      const fb = await submit(answer, Date.now() - started);
      if (placement) return;
      showFeedback(fb);
    } catch (err) {
      busy = false;
      check.disabled = !ex.ready();
      if (skip) skip.disabled = false;
      toast("Odgovora ni bilo mogoče shraniti. Poskusi še enkrat.");
    }
  }
  function onCheck() {
    if (!ex.ready()) return;
    send(ex.answer());
  }
  function showFeedback(fb) {
    ex.lock(fb);
    feedbackSlot.replaceChildren(renderFeedback(fb));
    check.hidden = true;
    nextBtn.hidden = false;
    nextBtn.focus();
  }

  const card = h("div", { class: "card" },
    progress
      ? h("div", {},
          h("div", { class: "progress", role: "progressbar", "aria-valuenow": Math.round(progress.frac * 100), "aria-valuemin": "0", "aria-valuemax": "100" },
            h("div", { style: `width:${Math.round(progress.frac * 100)}%` })),
          h("div", { class: "progress-label" }, progress.label))
      : null,
    heading ? h("h2", { style: "margin-top:12px" }, heading) : null,
    h("p", { class: "instruction" }, item.view.instruction_sl),
    ex.el,
    feedbackSlot,
    h("div", { class: "actions" }, skip, h("div", { class: "spacer" }), check, nextBtn));

  if (item.feedback) {
    // Already answered earlier (page was reloaded): show it as answered.
    showFeedback(item.feedback);
  } else {
    setTimeout(() => ex.focus(), 50);
  }
  return card;
}

// --- Placement -----------------------------------------------------------------

async function placementFlow() {
  const q = await api("/placement");
  if (q.done) return placementResult(q.result);
  if (q.progress.done === 0) {
    show(
      h("div", { class: "card" },
        h("h1", {}, "Dobrodošla! 🌷"),
        h("p", { class: "lead" }, "Najprej bomo naredili kratek preizkus, da vidimo, kje začeti."),
        h("p", {}, "To ni izpit – ni dobrih ali slabih rezultatov. Vprašanja bodo postajala lažja ali težja, glede na tvoje odgovore."),
        h("p", {}, "Če česa ne veš, preprosto klikni »Ne vem«. Traja približno 10 minut."),
        h("div", { class: "actions" }, h("button", { class: "btn", onclick: () => placementQuestion(q) }, "Začnimo"))),
    );
  } else {
    placementQuestion(q);
  }
}

function placementQuestion(q) {
  if (q.done) return placementResult(q.result);
  const isWriting = q.view.type === "write";
  const card = exerciseCard({
    item: { view: q.view, skill: isWriting ? "writing" : undefined },
    progress: { frac: q.progress.done / q.progress.total, label: `Vprašanje ${q.progress.done + 1} od ${q.progress.total}` },
    heading: isWriting && q.key === "w0" ? "Še malo pisanja ✍️" : undefined,
    placement: true,
    submit: async (answer, ms) => {
      const next = await api("/placement/answer", { attemptId: q.attemptId, key: q.key, answer, ms });
      placementQuestion(next);
    },
  });
  show(card);
}

function placementResult(result) {
  const skills = result?.skills ?? [];
  show(
    h("div", { class: "card celebrate" },
      confetti(),
      h("div", { class: "flame" }, "🔥"),
      h("div", { class: "streak-number" }, "1"),
      h("div", { class: "streak-caption" }, "dan v nizu"),
      h("h1", {}, "Odlično opravljeno!"),
      h("p", { class: "lead" }, "Prvi dan je za tabo. Zdaj vem, kje začeti.")),
    h("div", { class: "card" },
      h("h2", { style: "margin-top:0" }, "Tvoja izhodiščna raven"),
      skills.map((s) => skillRow(s, s.skill === "writing" && result.writingPending ? "še pregledujemo ✍️" : null)),
      result?.writingPending ? h("p", { class: "muted" }, "Tvoje pisanje si bomo še natančno ogledali – raven pisanja se bo morda še popravila.") : null,
      h("p", {}, "Jutri te čaka prva prava vaja – samo 5 minut. Se vidimo!"),
      h("div", { class: "actions" }, h("a", { class: "btn", href: "#/napredek" }, "Moj napredek"))),
  );
}

// --- Daily session -------------------------------------------------------------

async function todayFlow() {
  const state = await api("/today");
  if (state.screen === "placement") return placementFlow();
  if (state.screen === "done") return doneScreen(state);
  const recapItems = state.items.filter((i) => i.phase === "recap");
  const mainItems = state.items.filter((i) => i.phase === "main");
  const startedMain = mainItems.some((i) => i.feedback);
  const hasRecap = state.recap.points.length || state.recap.feedback.length || recapItems.length || state.recap.intro_sl;
  if (!startedMain && hasRecap) recapScreen(state, recapItems, mainItems);
  else mainScreen(state, mainItems, 0);
}

function recapScreen(state, recapItems, mainItems) {
  const { recap } = state;
  if (recap.feedback.length) api("/recap/seen", { ids: recap.feedback.map((f) => f.id) }).catch(() => {});
  const reviewSlot = h("div");
  const goOn = h("button", { class: "btn", onclick: () => mainScreen(state, mainItems, 0) }, "Na današnje vaje →");

  const nodes = [
    h("h1", {}, recap.title),
    state.dropBack
      ? h("div", { class: "card" },
          h("p", { style: "margin:0" }, `Lepo, da si spet tu! 🌷 Danes bo vaja malo krajša (${state.dropBack.to} minut), da spet prideš v ritem.`))
      : null,
    recap.intro_sl ? h("p", { class: "lead" }, recap.intro_sl) : null,
    recap.points.length
      ? h("div", { class: "card" },
          h("ul", { class: "points" }, recap.points.map((p) => h("li", {}, p.sl, h("span", { class: "en", lang: "en" }, p.en)))))
      : null,
    recap.feedback.map(writingFeedbackCard),
    reviewSlot,
    h("div", { class: "actions" }, goOn),
  ];
  show(...nodes.flat().filter(Boolean));

  // Quick review questions, one after another, before today's exercises.
  const pending = recapItems.filter((i) => !i.feedback);
  if (pending.length) {
    goOn.hidden = true;
    let k = 0;
    const runNext = () => {
      if (k >= pending.length) {
        reviewSlot.replaceChildren();
        goOn.hidden = false;
        goOn.focus();
        return;
      }
      const item = pending[k++];
      reviewSlot.replaceChildren(
        exerciseCard({
          item,
          heading: "Hitra ponovitev",
          submit: (answer, ms) => api(`/session/${state.session.id}/answer`, { itemId: item.id, answer, ms }),
          next: runNext,
        }),
      );
    };
    runNext();
  }
}

function writingFeedbackCard(f) {
  const title = f.kind === "write" ? "Tvoje pisanje ✍️" : "Tvoj prevod";
  const right = f.kind === "translate" && f.correct;
  return h("div", { class: "card writing-feedback" },
    h("h2", { style: "margin-top:0" }, title),
    f.prompt_sl ? h("p", { class: "muted" }, f.prompt_sl) : null,
    h("p", { class: "original", lang: "en" }, `»${f.text}«`),
    right ? h("p", {}, "Prav si prevedla! 🎉") : h("div", {}, h("div", { class: "muted" }, "Popravljeno:"), h("div", { class: "corrected", lang: "en" }, f.corrected)),
    f.praise_sl ? h("p", {}, f.praise_sl) : null,
    f.explanation_sl ? h("p", { class: "explain" }, f.explanation_sl) : null);
}

function mainScreen(state, items, startAt) {
  const firstOpen = items.findIndex((i) => !i.feedback);
  const index = Math.max(startAt, firstOpen === -1 ? items.length : firstOpen);
  if (index >= items.length) return finish(state);
  const item = items[index];
  show(
    exerciseCard({
      item,
      progress: { frac: index / items.length, label: `Vaja ${index + 1} od ${items.length}` },
      submit: async (answer, ms) => {
        const fb = await api(`/session/${state.session.id}/answer`, { itemId: item.id, answer, ms });
        item.feedback = fb;
        return fb;
      },
      next: () => mainScreen(state, items, index + 1),
    }),
  );
}

async function finish(state) {
  loading();
  try {
    const summary = await api(`/session/${state.session.id}/complete`, {});
    completionScreen(summary);
  } catch (err) {
    errorScreen(err);
  }
}

function confetti() {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return null;
  const colors = ["#e46f22", "#2f6b5f", "#f2c14e", "#d96c8a", "#5b8bd9"];
  const box = h("div", { class: "confetti", "aria-hidden": "true" });
  for (let i = 0; i < 36; i++) {
    box.append(
      h("i", {
        style: `left:${Math.random() * 100}%;background:${colors[i % colors.length]};animation-delay:${Math.random() * 0.8}s;transform:rotate(${Math.random() * 180}deg)`,
      }),
    );
  }
  return box;
}

function summaryDetails(summary) {
  return [
    h("div", { class: "stats" },
      stat(`${summary.correct} od ${summary.total}`, "pravilnih odgovorov"),
      stat(`${summary.minutes} min`, "vadila danes"),
      stat(summary.wordsLearned, "naučenih besed")),
    summary.levelChanges?.filter((c) => c.to > c.from).map((c) =>
      h("div", { class: "card" }, h("p", { style: "margin:0;font-size:23px" }, `🎉 Napredovala si! ${c.label_sl}: ${c.fromLabel} → ${c.toLabel}`))),
    summary.stepUp
      ? h("div", { class: "card" },
          h("p", { style: "margin:0" }, `Cel teden si vadila – izjemno! Od zdaj bodo vaje dolge približno ${summary.stepUp.to} minut.`))
      : null,
    summary.learned?.length
      ? h("div", { class: "card" },
          h("h2", { style: "margin-top:0" }, "Danes si vadila"),
          h("ul", { class: "points" }, summary.learned.map((l) => h("li", {}, l.label_sl, l.example_en ? h("span", { class: "en", lang: "en" }, l.example_en) : null))))
      : null,
    summary.newWords?.length
      ? h("div", { class: "card" },
          h("h2", { style: "margin-top:0" }, "Nove besede"),
          h("div", { class: "word-list" }, summary.newWords.map((w) => h("span", {}, h("b", { lang: "en" }, w.en), ` – ${w.sl}`))))
      : null,
    summary.pendingReviews
      ? h("p", { class: "muted" }, "Pri nekaterih odgovorih ti bomo popravke in nasvete pokazali ob naslednji vaji.")
      : null,
  ];
}

function completionScreen(summary) {
  const messages = [
    "Čudovito! Današnja vaja je opravljena.",
    "Bravo! Vsak dan malo – in angleščina raste.",
    "Super ti gre! Še en dan v nizu.",
    "Odlično! Lahko si ponosna nase.",
  ];
  show(
    h("div", { class: "card celebrate" },
      confetti(),
      h("div", { class: "flame" }, "🔥"),
      h("div", { class: "streak-number" }, summary.streak),
      h("div", { class: "streak-caption" }, `${daysWord(summary.streak)} v nizu`),
      h("h1", {}, pick(messages)),
      summary.freezesLeft > 0
        ? h("p", { class: "muted" }, `❄️ Ta teden imaš še ${summary.freezesLeft} ${plural(summary.freezesLeft, "zamrznitev", "zamrznitvi", "zamrznitve", "zamrznitev")}: če kakšen dan izpustiš, niz ostane.`)
        : null),
    ...summaryDetails(summary).flat().filter(Boolean),
    h("div", { class: "actions" }, h("a", { class: "btn", href: "#/napredek" }, "Moj napredek")),
  );
}

function doneScreen(state) {
  show(
    h("div", { class: "card celebrate" },
      h("div", { class: "flame" }, "🔥"),
      h("div", { class: "streak-number" }, state.streak),
      h("div", { class: "streak-caption" }, `${daysWord(state.streak)} v nizu`),
      h("h1", {}, "Danes si že vadila 🌷"),
      h("p", { class: "lead" }, "Bravo! Nova vaja te čaka jutri. Se vidimo!")),
    ...(state.summary ? summaryDetails(state.summary).flat().filter(Boolean) : []),
  );
}

// --- Progress ------------------------------------------------------------------

function stat(num, label) {
  return h("div", { class: "stat" }, h("div", { class: "num" }, num), h("div", { class: "lbl" }, label));
}

function skillRow(s, override) {
  return h("div", { class: "skill-row" },
    h("div", { class: "name" }, s.label_sl),
    h("div", { class: "ladder", "aria-hidden": "true" }, [0, 1, 2, 3, 4, 5].map((i) => h("span", { class: i <= s.level ? "on" : "" }))),
    h("div", { class: "lvl" }, override ?? s.levelLabel));
}

const DAY_NAMES = ["ned", "pon", "tor", "sre", "čet", "pet", "sob"];

async function progressFlow() {
  const p = await api("/progress");
  show(
    h("h1", {}, "Moj napredek"),
    h("div", { class: "stats" },
      stat(`🔥 ${p.streak}`, `${daysWord(p.streak)} v nizu`),
      stat(p.wordsLearned, "naučenih besed"),
      stat(p.sessions, "opravljenih vaj"),
      stat(`${p.minutesPractised} min`, "skupaj vadila")),
    h("div", { class: "card" },
      h("h2", { style: "margin-top:0" }, "Moja raven"),
      p.skills.map((s) => skillRow(s)),
      h("p", { class: "muted", style: "margin-top:14px;font-size:17px" }, "Ravni gredo od Pre-A1 (začetnik) do A2.2. Vsak stolpec je en korak naprej.")),
    h("div", { class: "card" },
      h("h2", { style: "margin-top:0" }, "Zadnja dva tedna"),
      h("div", { class: "days" },
        p.last14.map((d) => {
          const icon = d.status === "completed" ? "🔥" : d.status === "frozen" ? "❄️" : "";
          const date = new Date(`${d.date}T12:00:00`);
          return h("div", { class: `day ${d.status}`, title: d.date }, h("div", { class: "dot" }, icon), DAY_NAMES[date.getDay()]);
        })),
      h("p", { class: "muted", style: "margin-top:14px;font-size:17px" },
        `🔥 vadila · ❄️ zamrznitev (ta teden še ${p.freezesLeft}) · Najdaljši niz: ${p.bestStreak} ${daysWord(p.bestStreak)} · Dnevna vaja: ${p.targetMinutes} min`)),
    p.recentWords.length
      ? h("div", { class: "card" },
          h("h2", { style: "margin-top:0" }, "Besede, ki jih že znaš"),
          h("div", { class: "word-list" }, p.recentWords.map((w) => h("span", {}, h("b", { lang: "en" }, w.en), ` – ${w.sl}`))))
      : null,
  );
}

// --- Router ----------------------------------------------------------------------

async function route() {
  const isProgress = location.hash.startsWith("#/napredek");
  document.querySelectorAll(".nav a").forEach((a) => {
    if (a.dataset.route === (isProgress ? "progress" : "today")) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  loading();
  try {
    await (isProgress ? progressFlow() : todayFlow());
  } catch (err) {
    errorScreen(err);
  }
}

window.addEventListener("hashchange", route);
route();
