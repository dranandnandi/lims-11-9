// Gender auto-detection from salutation + name parts.
//
// Handles the two ways Indian honorifics appear in a typed name:
//   - as a separate word  -> "PRIYANSHI BEN", "RAJU BHAI"
//   - glued to the name   -> "PRIYANSHIBEN",  "RAJUBHAI"
// The old whole-word-only check missed the glued form, which is how most
// receptionists type it.

const MALE_SALUTATIONS = ['mr', 'master', 'shri', 'shriman', 'bhai'];
const FEMALE_SALUTATIONS = ['mrs', 'ms', 'miss', 'smt', 'shrimati', 'ku', 'kumari', 'baby'];

// Honorifics that only ever appear as their own word (too short / too common
// to be safe as a glued suffix).
const MALE_WORDS = ['bhai', 'bro', 'shriman', 'lal', 'singh', 'ram', 'kumar', 'rao', 'bhau'];
const FEMALE_WORDS = ['ben', 'bhen', 'behn', 'bahen', 'bai', 'devi', 'kumari', 'shrimati', 'smt', 'sister', 'mata', 'amma', 'didi', 'tai'];

// Honorifics that are also matched when glued to the end of a name word.
// Longest match wins, so "kumari" beats "kumar" and "bahen" beats "ben".
const SUFFIXES: Array<{ suffix: string; gender: Detected }> = [
  { suffix: 'bahen', gender: 'Female' },
  { suffix: 'behn', gender: 'Female' },
  { suffix: 'bhen', gender: 'Female' },
  { suffix: 'kumari', gender: 'Female' },
  { suffix: 'devi', gender: 'Female' },
  { suffix: 'amma', gender: 'Female' },
  { suffix: 'ben', gender: 'Female' },
  { suffix: 'bai', gender: 'Female' },
  { suffix: 'tai', gender: 'Female' },
  { suffix: 'bhai', gender: 'Male' },
  { suffix: 'kumar', gender: 'Male' },
  { suffix: 'singh', gender: 'Male' },
  { suffix: 'lal', gender: 'Male' },
  { suffix: 'ram', gender: 'Male' },
  { suffix: 'rao', gender: 'Male' },
];

// Real names that end in an honorific-looking suffix but are not honorifics.
const SUFFIX_EXCEPTIONS = new Set(['reuben', 'ruben', 'esteban', 'mumbai', 'dubai']);

// A glued suffix only counts if a real name stem remains in front of it,
// otherwise short suffixes ("bai", "ram") fire on unrelated names.
const MIN_STEM_LENGTH = 3;

type Detected = 'Male' | 'Female' | '';

interface Match {
  gender: Detected;
  /** Higher wins: whole-word beats glued, and a longer glued suffix beats a shorter one. */
  score: number;
}

const normalize = (value: string) =>
  value.toLowerCase().replace(/[^a-z]/g, '');

function matchWord(word: string): Match | null {
  if (!word) return null;

  // Exact honorific as its own word — strongest signal.
  if (FEMALE_WORDS.includes(word)) return { gender: 'Female', score: 100 };
  if (MALE_WORDS.includes(word)) return { gender: 'Male', score: 100 };

  if (SUFFIX_EXCEPTIONS.has(word)) return null;

  // Glued honorific, e.g. "priyanshiben" / "rajubhai".
  let best: Match | null = null;
  for (const { suffix, gender } of SUFFIXES) {
    if (!word.endsWith(suffix)) continue;
    if (word.length - suffix.length < MIN_STEM_LENGTH) continue;
    if (!best || suffix.length > best.score) best = { gender, score: suffix.length };
  }
  return best;
}

/**
 * Detects gender from a salutation and any number of name parts.
 * Returns '' when nothing conclusive is found — callers should leave the
 * current selection untouched in that case.
 */
export function detectGenderFromName(salutation: string, ...nameParts: string[]): Detected {
  const sal = normalize(salutation);
  if (MALE_SALUTATIONS.includes(sal)) return 'Male';
  if (FEMALE_SALUTATIONS.includes(sal)) return 'Female';

  const words = nameParts
    .join(' ')
    .split(/[\s.,]+/)
    .map(normalize)
    .filter(Boolean);

  let best: Match | null = null;
  for (const word of words) {
    const match = matchWord(word);
    if (match && (!best || match.score > best.score)) best = match;
  }
  return best ? best.gender : '';
}

export default detectGenderFromName;
