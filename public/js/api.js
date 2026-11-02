// Small fetch wrapper. Errors are shown gently; the server never blocks on Claude.
export async function api(path, body) {
  const res = await fetch(`/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Napaka ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "html") el.innerHTML = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c === undefined || c === null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

// A warm English phrase; hovering (or tapping) shows the Slovenian. Used only
// for encouragement and the daily thought – never for exercises.
export function warm(phrase, tag = "span", attrs = {}) {
  if (!phrase) return null;
  if (typeof phrase === "string") return h(tag, attrs, phrase);
  const el = h(tag, { ...attrs, class: `warm ${attrs.class ?? ""}`.trim(), lang: "en", tabindex: "0", "data-sl": phrase.sl, "aria-description": phrase.sl }, phrase.en);
  el.addEventListener("click", () => el.classList.toggle("show"));
  return el;
}

export function toast(text) {
  const el = h("div", { class: "toast", role: "status" }, text);
  document.body.append(el);
  setTimeout(() => el.remove(), 3500);
}
