/**
 * Marching-highlight theme layer (T15). Themes are palette-defined data —
 * the future picker UI renders straight from THEMES — and a pure WCAG
 * contrast engine picks the right variant for the page background the
 * highlight is sitting on.
 *
 * Each theme ships a light-band and a dark-band variant: translucent wash +
 * deliberate ink color, inverted on dark pages (deep tinted ground, luminous
 * text). Contrast is judged honestly: the variant's translucent background is
 * alpha-composited over the sampled page background, and the ink must clear
 * WCAG AA 4.5:1 against that composite. When no variant of a theme clears AA
 * (mid-luminance pages), pickVariant falls back to paper's underline variant
 * — no background, no color override, always safe.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface Rgba extends Rgb {
  a: number;
}

export interface Variant {
  /** Which background-luminance band this variant targets. */
  band: "light" | "dark" | "any";
  /** Translucent wash (rgba() CSS). Absent on the underline fallback. */
  background?: string;
  /** Ink color forced inside the highlight. Absent → page text color. */
  color?: string;
  textDecoration?: string;
}

export interface Theme {
  id: ThemeId;
  /** Human label for the picker UI. */
  label: string;
  variants: Variant[];
}

export type ThemeId = "sun" | "ocean" | "mint" | "berry" | "paper";

export const THEME_IDS: ThemeId[] = ["sun", "ocean", "mint", "berry", "paper"];

export const THEMES: Record<ThemeId, Theme> = {
  sun: {
    id: "sun",
    label: "Sun",
    variants: [
      // Warm amber wash, roasted-umber ink.
      { band: "light", background: "rgba(251, 191, 36, 0.42)", color: "#573a00" },
      // Deep amber ground, warm cream ink — the dark inversion.
      { band: "dark", background: "rgba(146, 94, 6, 0.55)", color: "#ffd98c" },
    ],
  },
  ocean: {
    id: "ocean",
    label: "Ocean",
    variants: [
      // Cyan wash, abyssal navy ink.
      { band: "light", background: "rgba(56, 189, 248, 0.38)", color: "#083c56" },
      // Deep sea ground, ice-cyan ink.
      { band: "dark", background: "rgba(7, 89, 133, 0.55)", color: "#aee6ff" },
    ],
  },
  mint: {
    id: "mint",
    label: "Mint",
    variants: [
      // Soft green wash, forest ink.
      { band: "light", background: "rgba(52, 211, 153, 0.36)", color: "#053f2e" },
      // Pine ground, pale mint ink.
      { band: "dark", background: "rgba(6, 95, 70, 0.55)", color: "#b5f4dc" },
    ],
  },
  berry: {
    id: "berry",
    label: "Berry",
    variants: [
      // Pink wash, crushed-raspberry ink.
      { band: "light", background: "rgba(244, 114, 182, 0.34)", color: "#6d0f38" },
      // Mulberry ground, blossom ink.
      { band: "dark", background: "rgba(157, 23, 77, 0.5)", color: "#ffd3e6" },
    ],
  },
  paper: {
    id: "paper",
    label: "Paper",
    variants: [
      // Graphite wash, near-black ink.
      { band: "light", background: "rgba(17, 24, 39, 0.12)", color: "#1a1a1a" },
      // Paper-frost ground, near-white ink.
      { band: "dark", background: "rgba(229, 231, 235, 0.22)", color: "#f3f4f6" },
      // The always-safe fallback: underline only, page text untouched.
      { band: "any", textDecoration: "underline" },
    ],
  },
};

export const ACTIVE_THEME: ThemeId = "sun";

/** WCAG 2.x relative luminance of an sRGB color (0..1). */
export function relativeLuminance({ r, g, b }: Rgb): number {
  const f = (c: number): number => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** WCAG contrast ratio between two opaque colors (1..21). */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Alpha-composite a translucent foreground over an opaque background. */
export function composite(fg: Rgba, bg: Rgb): Rgb {
  const mix = (f: number, b: number): number => Math.round(fg.a * f + (1 - fg.a) * b);
  return { r: mix(fg.r, bg.r), g: mix(fg.g, bg.g), b: mix(fg.b, bg.b) };
}

/** Parse #rgb / #rrggbb / rgb() / rgba() into Rgba. Returns null otherwise. */
export function parseColor(input: string): Rgba | null {
  const s = input.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(s);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
      a: 1,
    };
  }
  const fn = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(s);
  if (fn) {
    return { r: +fn[1], g: +fn[2], b: +fn[3], a: fn[4] === undefined ? 1 : +fn[4] };
  }
  return null;
}

const AA_RATIO = 4.5;
const WHITE: Rgb = { r: 255, g: 255, b: 255 };

/** paper's underline-only variant — safe on any background. */
export function fallbackVariant(): Variant {
  const v = THEMES.paper.variants.find((x) => x.textDecoration && !x.background);
  if (!v) throw new Error("paper theme is missing its underline fallback variant");
  return v;
}

/**
 * The variant of `theme` whose ink has the highest contrast against the page
 * background (variant wash composited over it), requiring ≥ AA 4.5:1.
 * Falls back to paper's underline variant when nothing clears AA.
 */
export function pickVariant(theme: Theme, backgroundColor: Rgb | string): Variant {
  const parsed = typeof backgroundColor === "string" ? parseColor(backgroundColor) : backgroundColor;
  const page = parsed ? composite({ a: 1, ...parsed }, WHITE) : WHITE;
  let best: Variant | null = null;
  let bestRatio = 0;
  for (const v of theme.variants) {
    if (!v.color) continue; // the underline fallback is never "picked"
    const ink = parseColor(v.color);
    if (!ink) continue;
    const wash = v.background ? parseColor(v.background) : null;
    const ground = wash ? composite(wash, page) : page;
    const ratio = contrastRatio(ink, ground);
    if (ratio >= AA_RATIO && ratio > bestRatio) {
      best = v;
      bestRatio = ratio;
    }
  }
  return best ?? fallbackVariant();
}
