// ==========================================================================
// Fray: quote bank
// QUOTE_BANK holds the 40 lines from daily_quotes.txt (no authors given, so
// author is ""). It's the offline copy: when Supabase is connected, app.js
// reads public.quotes (read-only for regular users) and passes it in as `bank`.
// ==========================================================================

export const QUOTE_BANK = [
  { quote: "Sweat more in peace. Bleed less in war.", author: "" },
  { quote: "Depression cannot hit a moving target.", author: "" },
  { quote: "You are exactly where you're supposed to be.", author: "" },
  { quote: "Tire yourself out.", author: "" },
  { quote: "Hate the process? You're supposed to.", author: "" },
  { quote: "How you do anything is how you do everything.", author: "" },
  { quote: "Museum of failures or gallery of trying?", author: "" },
  { quote: "I am nothing if not (in)consistent.", author: "" },
  { quote: "The odds of success far outweigh the odds of failure.", author: "" },
  { quote: "You can never get anything wrong. You only find another way.", author: "" },
  { quote: "Life is a series of ridiculous attempts to feel alive.", author: "" },
  { quote: "You don't need permission to be you.", author: "" },
  { quote: "Make something of yourself, then make something else.", author: "" },
  { quote: "The attempt is the whole point.", author: "" },
  { quote: "You can be a complete mess and still be onto something.", author: "" },
  { quote: "If they can't see the vision, build it where they can.", author: "" },
  { quote: "Be delusional enough to start. Be disciplined enough to finish.", author: "" },
  { quote: "You weren't born to fit neatly into someone else's imagination.", author: "" },
  { quote: "Have the audacity. Match your ability.", author: "" },
  { quote: "Don't shrink the dream to fit the room.", author: "" },
  { quote: "You can waste your life trying not to waste it.", author: "" },
  { quote: "The universe owes you nothing. You get to make something anyway.", author: "" },
  { quote: "Nobody knows what they're doing. Some people just commit harder.", author: "" },
  { quote: "You are a biological accident with a to-do list.", author: "" },
  { quote: "There is no arriving. There is only being here.", author: "" },
  { quote: "Life is mostly maintenance interrupted by miracles.", author: "" },
  { quote: "You don't have to make every experience mean something.", author: "" },
  { quote: "Nobody remembers the almosts.", author: "" },
  { quote: "A mediocre attempt beats immaculate intention.", author: "" },
  { quote: "You can restart without making an announcement.", author: "" },
  { quote: "Your life is made of things you did on unremarkable days.", author: "" },
  { quote: "Do the work before you decide you're the kind of person who can't.", author: "" },
  { quote: "You don't need to win the day. Just don't abandon it.", author: "" },
  { quote: "You are allowed to want an unreasonable amount from life.", author: "" },
  { quote: "Make peace with being misunderstood. Make sure the work is worth it.", author: "" },
  { quote: "You can be grateful for the life you have and impatient with the one you're building.", author: "" },
  { quote: "One day, you'll wish you could return to a day you thought was ordinary.", author: "" },
  { quote: "Be here, now.", author: "" },
  { quote: "The boring days stack up.", author: "" },
  { quote: "It's all in your head. Get out of it.", author: "" },
];

// Small, fast seeded PRNG (mulberry32): same seed, same sequence.
function mulberry32(seed) {
  let t = seed >>> 0;
  return function () {
    t = (t + 0x6D2B79F5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

// Local calendar date as YYYYMMDD, so the quote flips at the user's midnight.
export function dateSeed(date = new Date()) {
  return date.getFullYear() * 10000 + (date.getMonth() + 1) * 100 + date.getDate();
}

// Fisher-Yates shuffle driven by the date seed. Every device that opens Fray
// on the same calendar day gets the same order.
export function getDailyOrder(bank = QUOTE_BANK, date = new Date()) {
  const rand = mulberry32(dateSeed(date));
  const order = bank.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

// Today's quote: the first entry of today's shuffled order.
export function getDailyQuote(bank = QUOTE_BANK, date = new Date()) {
  if (!bank.length) return { quote: "Write your own quote today.", author: "Fray" };
  return bank[getDailyOrder(bank, date)[0]];
}

// Manual 🎲 shuffle. Walks through today's order one step at a time, so every
// quote shows once before any repeats, and wraps back to today's quote.
export function createQuoteShuffler(bank = QUOTE_BANK, date = new Date()) {
  let order = getDailyOrder(bank, date);
  let position = 0;
  return {
    current() {
      return bank.length ? bank[order[position]] : getDailyQuote(bank, date);
    },
    next() {
      if (!bank.length) return this.current();
      position = (position + 1) % order.length;
      return bank[order[position]];
    },
    reset() {
      position = 0;
      return this.current();
    },
    get isToday() { return position === 0; },
    get position() { return position; },
    get total() { return order.length; },
  };
}
