import { z } from "zod";

export const TOPICS = [
  "fashion",
  "shopping",
  "family",
  "doctor",
  "travel",
  "cooking",
  "weather",
  "home",
  "work",
  "free_time",
  "town",
  "food",
  "time",
] as const;
export type Topic = (typeof TOPICS)[number];

export const TOPIC_LABELS_SL: Record<Topic, string> = {
  fashion: "moda in spletno nakupovanje",
  shopping: "nakupovanje",
  family: "družina",
  doctor: "pri zdravniku",
  travel: "potovanje",
  cooking: "kuhanje",
  weather: "vreme",
  home: "dom",
  work: "služba",
  free_time: "prosti čas",
  town: "v mestu",
  food: "hrana",
  time: "čas in datumi",
};

// The mistake log groups errors by these categories, and Claude must tag every
// item with them, so the list is closed: free-form tags would fragment the log.
export const CATEGORY_LABELS_SL = {
  "grammar:to_be": "Glagol »to be« (am / is / are)",
  "grammar:present_simple": "Sedanjik (present simple)",
  "grammar:present_simple_3sg": "Končnica -s (he / she / it)",
  "grammar:questions_negatives": "Vprašanja in zanikanje (do / does)",
  "grammar:articles": "Členi (a / an / the)",
  "grammar:plurals": "Množina samostalnikov",
  "grammar:pronouns": "Osebni zaimki (I, you, he …)",
  "grammar:possessives": "Svojilni zaimki (my, your, his …)",
  "grammar:prepositions": "Predlogi (in, on, at …)",
  "grammar:there_is_are": "There is / there are",
  "grammar:have_got": "Have / has",
  "grammar:can": "Can / can't",
  "grammar:adverbs_frequency": "Prislovi pogostosti (always, often …)",
  "grammar:present_continuous": "Trajni sedanjik (I am cooking)",
  "grammar:past_simple": "Preteklik (past simple)",
  "grammar:was_were": "Was / were",
  "grammar:some_any": "Some / any",
  "grammar:much_many": "Much / many",
  "grammar:comparatives": "Primerjanje (bigger, the biggest)",
  "grammar:going_to": "Prihodnost z »going to«",
  "grammar:present_perfect": "Present perfect (I have been)",
  "grammar:modals": "Should / must / have to",
  "grammar:word_order": "Besedni red",
  "grammar:imperatives": "Velelnik (Open the window.)",
  "vocab:fashion": "Besede: moda in oblačila",
  "vocab:shopping": "Besede: nakupovanje",
  "vocab:family": "Besede: družina",
  "vocab:doctor": "Besede: pri zdravniku",
  "vocab:travel": "Besede: potovanje",
  "vocab:cooking": "Besede: kuhanje",
  "vocab:weather": "Besede: vreme",
  "vocab:home": "Besede: dom",
  "vocab:work": "Besede: služba",
  "vocab:free_time": "Besede: prosti čas",
  "vocab:town": "Besede: v mestu",
  "vocab:food": "Besede: hrana",
  "vocab:time": "Besede: čas in datumi",
  "vocab:general": "Pogoste besede",
  "reading:detail": "Branje: podrobnosti",
  "reading:main_idea": "Branje: glavna misel",
  "reading:inference": "Branje: sklepanje",
  "writing:spelling": "Črkovanje",
  "writing:sentence_structure": "Zgradba povedi",
  "writing:capitals_punctuation": "Velike začetnice in ločila",
  "writing:word_choice": "Izbira besed",
} as const;

export type Category = keyof typeof CATEGORY_LABELS_SL;
export const CATEGORIES = Object.keys(CATEGORY_LABELS_SL) as [Category, ...Category[]];
export const CategorySchema = z.enum(CATEGORIES);
export const TopicSchema = z.enum(TOPICS);

const text = (max: number) => z.string().trim().min(1).max(max);

const WordSchema = z.object({ en: text(40), sl: text(40) });

const common = {
  topic: TopicSchema,
  categories: z.array(CategorySchema).min(1).max(3),
  // Shown right after a wrong answer, so it has to exist up front: feedback
  // must be instant and never wait for Claude.
  explanation_sl: text(350),
  // Key vocabulary practised by the item; feeds the "words learned" count.
  words: z.array(WordSchema).max(6).optional(),
};

export const McSchema = z.object({
  type: z.literal("mc"),
  ...common,
  prompt_sl: text(160).optional(),
  question: text(300),
  options: z.array(text(160)).min(2).max(4),
  answer: z.number().int().min(0).max(3),
});

export const FillSchema = z.object({
  type: z.literal("fill"),
  ...common,
  sentence: text(250),
  accepted: z.array(text(60)).min(1).max(6),
  options: z.array(text(60)).min(2).max(4).optional(),
  hint_sl: text(120).optional(),
});

export const OrderSchema = z.object({
  type: z.literal("order"),
  ...common,
  // The sentence's words in the correct order; shuffled when shown.
  tokens: z.array(text(30)).min(3).max(12),
  sl: text(200).optional(),
  accepted: z.array(text(250)).max(4).optional(),
});

export const MatchSchema = z.object({
  type: z.literal("match"),
  ...common,
  pairs: z.array(z.object({ sl: text(40), en: text(40) })).min(3).max(5),
});

export const ReadingSchema = z.object({
  type: z.literal("reading"),
  ...common,
  title: text(80).optional(),
  text: text(900),
  questions: z
    .array(z.object({ question: text(200), options: z.array(text(160)).min(2).max(4), answer: z.number().int().min(0).max(3) }))
    .min(1)
    .max(3),
});

const QuestionSchema = z.object({ question: text(200), options: z.array(text(160)).min(2).max(4), answer: z.number().int().min(0).max(3) });

// Questions about a real screenshot (an online shop, a travel site). Only
// made from uploaded pictures, never invented for a session slot.
export const PictureSchema = z.object({
  type: z.literal("picture"),
  ...common,
  image: text(120),
  title: text(80).optional(),
  questions: z.array(QuestionSchema).min(1).max(4),
});

export const TranslateSchema = z.object({
  type: z.literal("translate"),
  ...common,
  sl: text(250),
  accepted: z.array(text(250)).min(1).max(8),
});

export const WriteSchema = z.object({
  type: z.literal("write"),
  ...common,
  prompt_sl: text(300),
  prompt_en: text(200).optional(),
  min_words: z.number().int().min(3).max(80),
  max_words: z.number().int().min(10).max(150),
  hint_sl: text(200).optional(),
});

export const ExerciseSchema = z.discriminatedUnion("type", [
  McSchema,
  FillSchema,
  OrderSchema,
  MatchSchema,
  ReadingSchema,
  TranslateSchema,
  WriteSchema,
  PictureSchema,
]);

export type Exercise = z.infer<typeof ExerciseSchema>;
export type ExerciseType = Exercise["type"];
export const EXERCISE_TYPES: ExerciseType[] = ["mc", "fill", "order", "match", "reading", "translate", "write", "picture"];

// Consistency rules the schema alone can't express. Used both when loading
// seed files and when validating Claude's output (so it gets a retry).
export function exerciseProblems(ex: Exercise, where = ""): string[] {
  const p: string[] = [];
  const at = where ? `${where}: ` : "";
  const unique = (arr: string[]) => new Set(arr.map((s) => s.toLowerCase())).size === arr.length;
  switch (ex.type) {
    case "mc":
      if (ex.answer >= ex.options.length) p.push(`${at}answer index out of range`);
      if (!unique(ex.options)) p.push(`${at}options must be different`);
      break;
    case "fill":
      if (ex.sentence.split("___").length !== 2) p.push(`${at}sentence must contain exactly one "___"`);
      if (ex.options && !ex.options.some((o) => o.toLowerCase() === ex.accepted[0].toLowerCase()))
        p.push(`${at}options must include accepted[0]`);
      break;
    case "order":
      if (ex.tokens.some((w) => /\s/.test(w))) p.push(`${at}each entry in tokens must be a single word`);
      break;
    case "match":
      if (!unique(ex.pairs.map((x) => x.en)) || !unique(ex.pairs.map((x) => x.sl))) p.push(`${at}pairs must be distinct`);
      break;
    case "reading":
    case "picture":
      ex.questions.forEach((q, i) => {
        if (q.answer >= q.options.length) p.push(`${at}questions[${i}].answer out of range`);
        if (!unique(q.options)) p.push(`${at}questions[${i}].options must be different`);
      });
      break;
    case "write":
      if (ex.min_words >= ex.max_words) p.push(`${at}min_words must be below max_words`);
      break;
  }
  return p;
}

export const DEFAULT_INSTRUCTIONS_SL: Record<ExerciseType, string> = {
  mc: "Izberi pravilen odgovor.",
  fill: "Dopolni poved.",
  order: "Razvrsti besede v pravilen vrstni red.",
  match: "Poveži slovenske in angleške besede.",
  reading: "Preberi besedilo in odgovori na vprašanja.",
  translate: "Prevedi v angleščino.",
  write: "Napiši nekaj povedi v angleščini.",
  picture: "Oglej si sliko in odgovori na vprašanja.",
};
