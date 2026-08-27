/**
 * Locale-parameterized sentence + word tokenization (pure text).
 *
 * Sentences use Intl.Segmenter (locale-aware; CJK text splits at 。！？) —
 * strictly better than the old char-set splitter: handles abbreviations
 * ("Mrs."), quote runs, and per-script rules. One sentence token stays
 * ≤ MAX_TOKEN_CHARS (Latin) / CJK_TOKEN_CHARS (CJK scripts): a long
 * sentence is split at the last space within the cap, else hard-cut —
 * never emitted longer than the cap, so chunker output can never approach
 * the 300-char ceiling the Chrome silent-stop bug demands.
 *
 * Words use Intl.Segmenter granularity "word": CJK scripts produce real
 * word tokens (你好 / 世界), not bigrams. Punctuation merges into the
 * preceding word ("world." / "世界。"), whitespace runs are dropped, so
 * word tokens never carry inter-word whitespace.
 *
 * `splitTokens` keeps the working sentence contract (English default —
 * its segmentation already splits CJK 。！？ correctly); locale-aware
 * callers use `sentenceSpans` / `wordSpans` directly.
 */

export const MAX_TOKEN_CHARS = 250;
/** CJK chunk/sentence ceiling — short utterances age better in TTS. */
export const CJK_TOKEN_CHARS = 100;

export interface TokenSpan {
  text: string;
  start: number;
  end: number;
}

const segmenters = new Map<string, Intl.Segmenter>();

function segmenter(locale: string, granularity: "word" | "sentence"): Intl.Segmenter {
  const key = `${locale}|${granularity}`;
  let s = segmenters.get(key);
  if (!s) {
    s = makeSegmenter(locale, granularity);
    segmenters.set(key, s);
  }
  return s;
}

/**
 * Intl.Segmenter throws RangeError on a malformed locale tag (a voice with
 * lang "" or a stray non-BCP47 string crashes every subsequent speak —
 * found live on Firefox: invalid tag → hard error-park). Segmenters are
 * locale-suggestion inputs for the unicode rules; falling back to "en"
 * keeps segmentation working for any input.
 */
function makeSegmenter(locale: string, granularity: "word" | "sentence"): Intl.Segmenter {
  try {
    return new Intl.Segmenter(locale, { granularity });
  } catch {
    console.error(`[leia] invalid segmenter locale "${locale}" — falling back to "en"`);
    return new Intl.Segmenter("en", { granularity });
  }
}

/** zh / ja / ko / yue — scripts where Intl word segmentation is the correct granularity. */
export function isCjkLocale(locale: string): boolean {
  return /^(zh|ja|ko|yue)(-|$)/i.test(locale);
}

/**
 * Sentence spans over `text` for `locale`. Whitespace-only spans are
 * dropped (blank lines between paragraphs); trailing whitespace attaches
 * to the preceding sentence, exactly as Intl.Segmenter emits it.
 */
export function sentenceSpans(text: string, locale: string, cap: number = MAX_TOKEN_CHARS): TokenSpan[] {
  const seg = segmenter(locale, "sentence");
  const out: TokenSpan[] = [];
  const push = (start: number, end: number): void => {
    if (end <= start) return;
    while (end - start > cap) {
      // Long sentence: split at the last space within the cap, else hard-cut.
      const limit = start + cap;
      let cut = text.lastIndexOf(" ", limit);
      if (cut <= start || text[cut - 1] === "\n") cut = text.lastIndexOf("\n", limit);
      if (cut <= start) cut = limit; // CJK / unbroken run: hard cut
      const t = text.slice(start, cut);
      if (t.trim().length > 0) out.push({ text: t, start, end: cut });
      start = cut;
    }
    const t = text.slice(start, end);
    if (t.trim().length > 0) out.push({ text: t, start, end });
  };
  for (const { segment, index } of seg.segment(text)) {
    if (segment.trim().length === 0) continue; // blank-line separator — drop
    push(index, index + segment.length);
  }
  return out;
}

/** Sentence tokens, English default — the working reader contract. */
export function splitTokens(text: string): TokenSpan[] {
  return sentenceSpans(text, "en");
}

/**
 * Word spans over `text` for `locale`. Every character of the input is
 * covered exactly once (round-trip safe); whitespace never appears inside
 * a word token. Segments are exactly Intl.Segmenter's dictionary words
 * (zh "今天" + "好" + "吗" stay separate — adjacent wordlike segments
 * never merge, so ja particles don't glue whole sentences together);
 * punctuation merges into the preceding word (a bare punctuation run
 * stands alone when nothing precedes it).
 */
export function wordSpans(text: string, locale: string): TokenSpan[] {
  const seg = segmenter(locale, "word");
  const out: TokenSpan[] = [];
  let buf = "";
  let bufStart = 0;
  const flush = (): void => {
    if (buf.length > 0) {
      out.push({ text: buf, start: bufStart, end: bufStart + buf.length });
      buf = "";
    }
  };
  for (const { segment, index, isWordLike } of seg.segment(text)) {
    if (isWordLike) {
      flush(); // each dictionary word stands alone
      bufStart = index;
      buf = segment;
    } else if (segment.trim().length === 0) {
      flush(); // whitespace run
    } else {
      buf += segment; // punctuation: merges into the trailing word or stands alone
    }
  }
  flush();
  return out;
}

/** Word token i → sentence token index (parent), plus words-per-sentence counts. */
export interface WordParentIndex {
  parent: Int32Array;
  counts: Int32Array;
}

export function wordParentIndex(
  sentences: Array<{ start: number; end: number }>,
  words: Array<{ start: number; end: number }>,
): WordParentIndex {
  const parent = new Int32Array(words.length);
  const counts = new Int32Array(sentences.length);
  let s = 0;
  for (let w = 0; w < words.length; w += 1) {
    while (s + 1 < sentences.length && sentences[s + 1].start <= words[w].start) s += 1;
    parent[w] = s;
    counts[s] += 1;
  }
  return { parent, counts };
}