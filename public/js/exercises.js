import { h } from "./api.js";

// Renders one exercise. Every renderer returns the same small interface:
//   el          – the DOM node
//   ready()     – whether there is something to submit
//   answer()    – the answer payload for the server
//   lock(fb)    – freeze the inputs and mark right/wrong using server feedback
//   focus()     – put the cursor somewhere sensible
// `onChange` is called whenever ready() may have changed; `onEnter` on Return.

export function renderExercise(view, { onChange = () => {}, onEnter = () => {}, skill } = {}) {
  const renderers = { mc, fill, order, match, reading, translate, write };
  return renderers[view.type](view, { onChange, onEnter, skill });
}

function optionList(options, onPick) {
  let selected = null;
  const buttons = options.map((text) =>
    h("button", {
      class: "option",
      type: "button",
      onclick: () => {
        selected = text;
        buttons.forEach((b) => b.classList.toggle("selected", b.textContent === text));
        onPick(text);
      },
    }, text),
  );
  return {
    el: h("div", { class: "options", role: "group" }, buttons),
    get selected() { return selected; },
    lock(correctText) {
      for (const b of buttons) {
        b.disabled = true;
        if (correctText !== undefined && b.textContent === correctText) b.classList.add("is-correct");
        else if (b.textContent === selected) b.classList.add("is-wrong");
      }
    },
  };
}

function mc(view, { onChange }) {
  const list = optionList(view.options, onChange);
  return {
    el: h("div", {}, h("p", { class: "question", lang: "en" }, view.question), list.el),
    ready: () => list.selected !== null,
    answer: () => ({ option: list.selected }),
    lock: (fb) => list.lock(fb?.correctDisplay?.[0]),
    focus: () => {},
  };
}

function fill(view, { onChange, onEnter }) {
  const [before, after] = view.sentence.split("___");
  if (view.options) {
    let value = null;
    const blank = h("span", { class: "blank" }, " ");
    const chips = view.options.map((o) =>
      h("button", {
        class: "chip",
        type: "button",
        onclick: () => {
          value = o;
          blank.textContent = o;
          chips.forEach((c) => c.classList.toggle("selected", c.textContent === o));
          onChange();
        },
      }, o),
    );
    return {
      el: h("div", {},
        h("p", { class: "sentence", lang: "en" }, before, blank, after),
        h("div", { class: "chips" }, chips),
        view.hint_sl ? h("p", { class: "hint" }, view.hint_sl) : null),
      ready: () => value !== null,
      answer: () => ({ text: value }),
      lock: () => chips.forEach((c) => (c.disabled = true)),
      focus: () => {},
    };
  }
  const input = h("input", {
    class: "text-input blank-input",
    type: "text",
    autocomplete: "off",
    autocapitalize: "off",
    spellcheck: "false",
    lang: "en",
    "aria-label": "Manjkajoča beseda",
    oninput: () => onChange(),
    onkeydown: (e) => e.key === "Enter" && onEnter(),
  });
  return {
    el: h("div", {},
      h("p", { class: "sentence", lang: "en" }, before, input, after),
      view.hint_sl ? h("p", { class: "hint" }, view.hint_sl) : null),
    ready: () => input.value.trim().length > 0,
    answer: () => ({ text: input.value }),
    lock: () => (input.disabled = true),
    focus: () => input.focus(),
  };
}

function order(view, { onChange }) {
  const line = h("div", { class: "answer-line", "data-placeholder": "Klikni besede v pravilnem vrstnem redu …" });
  const placed = [];
  let locked = false;
  const bankChips = view.words.map((w, i) => {
    const chip = h("button", {
      class: "chip",
      type: "button",
      onclick: () => {
        if (locked || chip.classList.contains("used")) return;
        chip.classList.add("used");
        const moved = h("button", {
          class: "chip",
          type: "button",
          onclick: () => {
            if (locked) return;
            moved.remove();
            placed.splice(placed.findIndex((p) => p.i === i), 1);
            chip.classList.remove("used");
            onChange();
          },
        }, w);
        placed.push({ i, w });
        line.append(moved);
        onChange();
      },
    }, w);
    return chip;
  });
  return {
    el: h("div", {},
      view.sl ? h("p", { class: "sl-source" }, view.sl) : null,
      line,
      h("div", { class: "chips", lang: "en" }, bankChips)),
    ready: () => placed.length === view.words.length,
    answer: () => ({ words: placed.map((p) => p.w) }),
    lock: () => {
      locked = true;
      line.querySelectorAll("button").forEach((b) => (b.disabled = true));
    },
    focus: () => {},
  };
}

function match(view, { onChange }) {
  const values = view.left.map(() => null);
  let active = 0;
  let locked = false;
  const slots = view.left.map((_, i) =>
    h("button", {
      class: "match-slot",
      type: "button",
      "aria-label": `Prevod za ${view.left[i]}`,
      onclick: () => {
        if (locked) return;
        if (values[i] !== null) {
          const chip = chips.find((c) => c.textContent === values[i]);
          chip?.classList.remove("used");
          values[i] = null;
          slots[i].textContent = "";
          slots[i].classList.remove("filled");
          onChange();
        }
        active = i;
        paint();
      },
    }),
  );
  const chips = view.right.map((w) =>
    h("button", {
      class: "chip",
      type: "button",
      onclick: () => {
        if (locked) return;
        let target = values[active] === null ? active : values.findIndex((v) => v === null);
        if (target === -1) return;
        values[target] = w;
        slots[target].textContent = w;
        slots[target].classList.add("filled");
        chips.find((c) => c.textContent === w).classList.add("used");
        const next = values.findIndex((v) => v === null);
        active = next === -1 ? target : next;
        paint();
        onChange();
      },
    }, w),
  );
  function paint() {
    slots.forEach((s, i) => s.classList.toggle("active", i === active && values[i] === null));
  }
  paint();
  return {
    el: h("div", {},
      h("div", { class: "match-rows" },
        view.left.map((l, i) => h("div", { class: "match-row" }, h("div", { class: "match-left" }, l), h("div", { class: "arrow muted" }, "→"), slots[i]))),
      h("div", { class: "chips", lang: "en" }, chips)),
    ready: () => values.every((v) => v !== null),
    answer: () => ({ matches: values }),
    lock: () => {
      locked = true;
      slots.forEach((s) => (s.disabled = true));
    },
    focus: () => {},
  };
}

function reading(view, { onChange }) {
  const lists = view.questions.map((q) => optionList(q.options, onChange));
  return {
    el: h("div", {},
      h("div", { class: "reading-text", lang: "en" }, view.title ? h("span", { class: "reading-title" }, view.title) : null, view.text),
      view.questions.map((q, i) => h("div", { class: "reading-q" }, h("p", { class: "q" }, q.question), lists[i].el))),
    ready: () => lists.every((l) => l.selected !== null),
    answer: () => ({ options: lists.map((l) => l.selected) }),
    lock: (fb) => {
      lists.forEach((l, i) => {
        const line = fb?.correctDisplay?.[i] ?? "";
        const idx = line.lastIndexOf(" → ");
        l.lock(idx >= 0 ? line.slice(idx + 3) : undefined);
      });
    },
    focus: () => {},
  };
}

function translate(view, { onChange, onEnter, skill }) {
  const single = skill === "vocabulary";
  const input = single
    ? h("input", { class: "text-input", type: "text", autocomplete: "off", autocapitalize: "off", spellcheck: "false", lang: "en", "aria-label": "Prevod", oninput: () => onChange(), onkeydown: (e) => e.key === "Enter" && onEnter() })
    : h("textarea", { class: "text-input", rows: "3", style: "min-height: 110px", spellcheck: "false", lang: "en", "aria-label": "Prevod", oninput: () => onChange() });
  return {
    el: h("div", {}, h("p", { class: "sl-source" }, view.sl), input),
    ready: () => input.value.trim().length > 0,
    answer: () => ({ text: input.value }),
    lock: () => (input.disabled = true),
    focus: () => input.focus(),
  };
}

function countWords(s) {
  return s.trim() ? s.trim().split(/\s+/).length : 0;
}

function write(view, { onChange }) {
  const counter = h("p", { class: "word-count" });
  const area = h("textarea", {
    class: "text-input",
    spellcheck: "false",
    lang: "en",
    "aria-label": "Tvoje besedilo",
    oninput: () => {
      update();
      onChange();
    },
  });
  function update() {
    const n = countWords(area.value);
    counter.textContent = n < view.min_words ? `${n} besed (priporočeno vsaj ${view.min_words})` : `${n} besed – lepo!`;
  }
  update();
  return {
    el: h("div", {},
      view.prompt_en ? h("p", { class: "question", lang: "en" }, view.prompt_en) : null,
      view.hint_sl ? h("p", { class: "hint", style: "margin-bottom: 14px" }, view.hint_sl) : null,
      area,
      counter),
    ready: () => countWords(area.value) > 0,
    answer: () => ({ text: area.value }),
    lock: () => (area.disabled = true),
    focus: () => area.focus(),
  };
}

export function renderFeedback(fb) {
  if (!fb) return null;
  const showAnswer = fb.correctDisplay && fb.correctDisplay.length && fb.outcome !== "correct";
  return h("div", { class: `feedback ${fb.outcome}`, role: "status" },
    h("div", { class: "msg" }, fb.message_sl),
    fb.note_sl ? h("p", {}, fb.note_sl) : null,
    showAnswer
      ? h("div", {},
          fb.outcome !== "pending" ? h("div", { class: "muted" }, fb.correctDisplay.length > 1 ? "Pravilno je:" : "Pravilno:") : null,
          fb.correctDisplay.map((line) => h("div", { class: "right-answer", lang: "en" }, h("b", {}, line))))
      : null,
    fb.explanation_sl ? h("p", { class: "explain" }, fb.explanation_sl) : null);
}
