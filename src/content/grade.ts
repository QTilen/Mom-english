import type { Exercise } from "./schema";

// Instant, local grading. Only free writing and translations that don't match
// any accepted answer are left "pending" for Claude to look at in the background.

export type Outcome = "correct" | "almost" | "partial" | "incorrect" | "pending";

export interface GradeResult {
  outcome: Outcome;
  score: number | null; // 0..1, null while pending
  correct: boolean | null;
  // What the right answer looks like, ready to show her.
  correctDisplay: string[];
  wrongCategories: string[];
  // Shown with "almost": what was off (e.g. a typo).
  note_sl?: string;
}

// Options are shuffled when shown, so choices come back as the option text.
export type Answer =
  | { option: string }
  | { text: string }
  | { words: string[] }
  | { matches: string[] }
  | { options: string[] };

const CONTRACTIONS: Record<string, string> = {
  "i'm": "i am",
  "you're": "you are",
  "he's": "he is",
  "she's": "she is",
  "it's": "it is",
  "we're": "we are",
  "they're": "they are",
  "that's": "that is",
  "what's": "what is",
  "there's": "there is",
  "where's": "where is",
  "isn't": "is not",
  "aren't": "are not",
  "wasn't": "was not",
  "weren't": "were not",
  "don't": "do not",
  "doesn't": "does not",
  "didn't": "did not",
  "can't": "cannot",
  "can not": "cannot",
  "couldn't": "could not",
  "won't": "will not",
  "shouldn't": "should not",
  "mustn't": "must not",
  "haven't": "have not",
  "hasn't": "has not",
  "i've": "i have",
  "you've": "you have",
  "we've": "we have",
  "they've": "they have",
  "i'll": "i will",
  "you'll": "you will",
  "he'll": "he will",
  "she'll": "she will",
  "we'll": "we will",
  "they'll": "they will",
  "i'd": "i would",
  "let's": "let us",
};
const CONTRACTION_RE = new RegExp(`\\b(${Object.keys(CONTRACTIONS).join("|")})\\b`, "g");

export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’ʼ`´]/g, "'")
    .replace(/[“”"]/g, "")
    .replace(/[.,!?;:()…]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(CONTRACTION_RE, (m) => CONTRACTIONS[m]);
}

// For single-word vocabulary answers, "to cook" = "cook" and "an apple" = "apple".
function stripLeadingParticle(s: string): string {
  return s.replace(/^(to|a|an|the) /, "");
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

// A single-letter slip in one longer word counts as "almost" (spelling),
// but never when the slip is a grammar point: a/an, is/as, apple/apples.
export function isTypo(given: string, expected: string): boolean {
  const g = given.split(" ");
  const e = expected.split(" ");
  if (g.length !== e.length) return false;
  const diffs = e.map((w, i) => [g[i], w] as const).filter(([gw, ew]) => gw !== ew);
  if (diffs.length !== 1) return false;
  const [gw, ew] = diffs[0];
  if (ew.length < 4 || levenshtein(gw, ew) !== 1) return false;
  if (gw + "s" === ew || ew + "s" === gw || gw + "es" === ew || ew + "es" === gw) return false;
  return true;
}

type TextMatch = "exact" | "typo" | "none";

function matchText(given: string, accepted: string[], loose: boolean): TextMatch {
  const prep = (s: string) => (loose ? stripLeadingParticle(normalize(s)) : normalize(s));
  const g = prep(given);
  if (!g) return "none";
  const targets = accepted.map(prep);
  if (targets.includes(g)) return "exact";
  if (targets.some((t) => isTypo(g, t))) return "typo";
  return "none";
}

const TYPO_NOTE = "Skoraj! Samo pazi na črkovanje.";

export function grade(ex: Exercise, answer: Answer, skill: string): GradeResult {
  const wrong = (correctDisplay: string[], score = 0): GradeResult => ({
    outcome: score > 0 ? "partial" : "incorrect",
    score,
    correct: false,
    correctDisplay,
    wrongCategories: ex.categories,
  });
  const right = (correctDisplay: string[], outcome: Outcome = "correct"): GradeResult => ({
    outcome,
    score: 1,
    correct: true,
    correctDisplay,
    wrongCategories: [],
    note_sl: outcome === "almost" ? TYPO_NOTE : undefined,
  });

  switch (ex.type) {
    case "mc": {
      const display = [ex.options[ex.answer]];
      return "option" in answer && answer.option === ex.options[ex.answer] ? right(display) : wrong(display);
    }
    case "fill": {
      const display = [ex.sentence.replace("___", ex.accepted[0])];
      const given = "text" in answer ? answer.text : "";
      const m = matchText(given, ex.accepted, false);
      return m === "none" ? wrong(display) : right(display, m === "typo" ? "almost" : "correct");
    }
    case "order": {
      const sentence = ex.words.join(" ");
      const given = "words" in answer ? answer.words.join(" ") : "";
      const ok = [sentence, ...(ex.accepted ?? [])].some((s) => normalize(s) === normalize(given));
      return ok ? right([sentence]) : wrong([sentence]);
    }
    case "match": {
      const given = "matches" in answer ? answer.matches : [];
      const hits = ex.pairs.filter((p, i) => normalize(given[i] ?? "") === normalize(p.en)).length;
      const display = ex.pairs.map((p) => `${p.sl} = ${p.en}`);
      return hits === ex.pairs.length ? right(display) : wrong(display, hits / ex.pairs.length);
    }
    case "reading": {
      const given = "options" in answer ? answer.options : [];
      const hits = ex.questions.filter((q, i) => given[i] === q.options[q.answer]).length;
      const display = ex.questions.map((q) => `${q.question} → ${q.options[q.answer]}`);
      return hits === ex.questions.length ? right(display) : wrong(display, hits / ex.questions.length);
    }
    case "translate": {
      const given = "text" in answer ? answer.text : "";
      const m = matchText(given, ex.accepted, skill === "vocabulary");
      if (m !== "none") return right([ex.accepted[0]], m === "typo" ? "almost" : "correct");
      // Sentences can be translated many valid ways; a word-for-word list of
      // accepted answers can't cover them all, so let Claude judge later.
      if (skill !== "vocabulary" && normalize(given).split(" ").length >= 2) {
        return { outcome: "pending", score: null, correct: null, correctDisplay: [ex.accepted[0]], wrongCategories: [] };
      }
      return wrong([ex.accepted[0]]);
    }
    case "write":
      return { outcome: "pending", score: null, correct: null, correctDisplay: [], wrongCategories: [] };
  }
}
