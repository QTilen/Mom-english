#!/usr/bin/env node
// Stand-in for the Claude CLI that answers each kind of prompt the app sends
// with valid, schema-shaped JSON. Used by the job handler integration tests.
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  if (process.argv.includes("--version")) return console.log("9.9.9 (fake)");
  let reply;
  if (input.includes("Write exercises for these slots")) {
    const slots = [...input.matchAll(/^\d+\. type: (\w+), skill: (\w+), level: [^,]+, topic: (\w+)/gm)];
    reply = { recap: input.includes("Her last session") ? [{ sl: "Člen »a« pred soglasnikom", en: "a nurse" }] : [], items: slots.map(([, type, , topic], i) => item(type, topic, i)) };
  } else if (input.includes("Her text:")) {
    reply = { corrected_text: "My name is Marija.", explanation_sl: "Lepo napisano.", praise_sl: "Bravo!", score: 80, cefr: "A1.2", mistakes: [] };
  } else if (input.includes("translate this Slovenian sentence")) {
    reply = { correct: false, corrected_text: "I like coffee.", explanation_sl: "Glagol »like«.", mistakes: [{ category: "grammar:present_simple", detail: "likes → like" }] };
  } else {
    reply = { reply: "pong" };
  }
  process.stdout.write(JSON.stringify({ type: "result", is_error: false, result: JSON.stringify(reply) }));
});

function item(type, topic, i) {
  const base = { topic, categories: ["grammar:articles"], explanation_sl: "Razlaga." };
  switch (type) {
    case "mc": return { ...base, type, question: `Question ${i}?`, options: ["a", "an", "the"], answer: 0 };
    case "fill": return { ...base, type, sentence: `She is ___ nurse ${i}.`, accepted: ["a"] };
    case "order": return { ...base, type, tokens: ["I", "like", `tea${i}.`], sl: "Rada imam čaj." };
    case "match": return { ...base, type, categories: ["vocab:food"], pairs: [{ sl: "kruh", en: "bread" }, { sl: "sir", en: "cheese" }, { sl: `mleko${i}`, en: "milk" }], words: [{ en: "bread", sl: "kruh" }] };
    case "reading": return { ...base, type, categories: ["reading:detail"], text: `Ana has a cat ${i}.`, questions: [{ question: "Kaj ima Ana?", options: ["mačko", "psa"], answer: 0 }] };
    case "translate": return { ...base, type, sl: `Rada imam kavo ${i}.`, accepted: ["I like coffee."] };
    case "write": return { ...base, type, prompt_sl: "Napiši nekaj o sebi.", min_words: 5, max_words: 40 };
  }
}
