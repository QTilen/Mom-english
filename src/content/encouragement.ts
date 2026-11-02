import { getSetting } from "../db";
import { localHour } from "../util/dates";

// Warm thoughts for the day, in simple English (so they double as a little
// reading practice) with a Slovenian translation underneath.
export const QUOTES: { en: string; sl: string }[] = [
  { en: "It's never too late to learn something new.", sl: "Nikoli ni prepozno, da se naučiš nekaj novega." },
  { en: "Little by little, a little becomes a lot.", sl: "Malo po malo iz malega nastane veliko." },
  { en: "Every day is a new beginning.", sl: "Vsak dan je nov začetek." },
  { en: "Mistakes help us learn.", sl: "Napake nam pomagajo pri učenju." },
  { en: "Slow progress is still progress.", sl: "Tudi počasen napredek je napredek." },
  { en: "One step at a time.", sl: "Korak za korakom." },
  { en: "Practice makes perfect.", sl: "Vaja dela mojstra." },
  { en: "Learning keeps the mind young.", sl: "Učenje ohranja duha mladega." },
  { en: "A new language opens new doors.", sl: "Nov jezik odpira nova vrata." },
  { en: "Believe in yourself.", sl: "Verjemi vase." },
  { en: "The best time to start is now.", sl: "Najboljši čas za začetek je zdaj." },
  { en: "Be proud of how far you have come.", sl: "Bodi ponosna, kako daleč si že prišla." },
  { en: "Every word you learn is yours forever.", sl: "Vsaka beseda, ki se jo naučiš, je za vedno tvoja." },
  { en: "Don't be afraid to make mistakes.", sl: "Ne boj se delati napak." },
  { en: "Today is a good day to learn.", sl: "Danes je dober dan za učenje." },
  { en: "Your family is proud of you.", sl: "Tvoja družina je ponosna nate." },
  { en: "Keep going – you get better every day.", sl: "Kar tako naprej – vsak dan si boljša." },
  { en: "Learning is a gift you give yourself.", sl: "Učenje je darilo, ki ga podariš sebi." },
  { en: "It's not about being perfect. It's about trying.", sl: "Ne gre za to, da si popolna. Gre za to, da poskusiš." },
  { en: "Every long journey begins with one small step.", sl: "Vsaka dolga pot se začne z enim majhnim korakom." },
  { en: "Your brain loves new things.", sl: "Tvoji možgani imajo radi nove stvari." },
  { en: "Good things take time.", sl: "Dobre stvari potrebujejo čas." },
  { en: "You can do it!", sl: "Zmoreš!" },
  { en: "Every expert was once a beginner.", sl: "Vsak mojster je bil nekoč začetnik." },
  { en: "When you learn something new, the world gets bigger.", sl: "Ko se naučiš nekaj novega, svet postane večji." },
  { en: "Enjoy the small successes.", sl: "Uživaj v majhnih uspehih." },
  { en: "Five minutes a day makes a big difference.", sl: "Pet minut na dan naredi veliko razliko." },
  { en: "You are stronger than you think.", sl: "Močnejša si, kot misliš." },
  { en: "A smile and a new word – a perfect day.", sl: "Nasmeh in nova beseda – popoln dan." },
  { en: "We learn at every age.", sl: "Učimo se v vsakem letu življenja." },
];

// Same thought all day, a different one tomorrow.
export function quoteForDay(date: string): { en: string; sl: string } {
  const n = [...date].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 17);
  return QUOTES[n % QUOTES.length];
}

export function learnerName(): string {
  return getSetting("learner_name") ?? "Franja";
}

export function greeting(): string {
  const hour = localHour();
  const hello = hour >= 5 && hour < 10 ? "Dobro jutro" : hour >= 10 && hour < 18 ? "Dober dan" : "Dober večer";
  return `${hello}, ${learnerName()}!`;
}
