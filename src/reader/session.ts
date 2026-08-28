// SPDX-License-Identifier: MPL-2.0
/**
 * ReaderSession — one active session globally (T2 item 9), authoritative
 * state in storage.session (T2 item 2). Runs in the background context on
 * both browsers, consumes the TextEngine contract, and drives the marching
 * highlight via emitted events.
 *
 * Pause/resume is cancel-and-replay-from-token (T2 item 3): pause cancels
 * the current utterance and records the token position; resume re-speaks
 * from that token. A vanished owner (SW/event page killed while paused) is
 * a normal resume path — load() hydrates from storage.session.
 */
import { chunkText, chunkTokens, type ChunkSpan } from "./chunker";
import type { TextEngine, WordTimeline } from "./contract";
import { CJK_TOKEN_CHARS, isCjkLocale, MAX_TOKEN_CHARS } from "./sentences";

export type ReaderState = "stopped" | "playing" | "paused";

export interface SessionSettings {
  voiceName: string | null;
  rate: number;
  /** Engine family; null = the engine's default family. */
  engine: string | null;
}

export const MIN_RATE = 0.5;
export const MAX_RATE = 3;

export interface SessionStatus {
  sessionId: string | null;
  state: ReaderState;
  tokenPos: number;
  tokenCount: number;
  settings: SessionSettings;
  /** URL the session was started for (T16 resume store key), null when unknown. */
  url?: string | null;
  /** Transient engine failure detail (T17); null unless a drive error parked the session. */
  lastError?: string | null;
}

/** Live-session position view the background saves into the per-URL resume store. */
export interface SessionSnapshot {
  tokens: TokenText[];
  tokenPos: number;
  settings: SessionSettings;
  url: string | null;
}

export type SessionEvent =
  | { type: "state"; status: SessionStatus }
  | {
      type: "highlight";
      sessionId: string;
      from: number;
      to: number;
      /** Word-level march: char offsets relative to the chunk text. */
      word?: { begin: number; end: number };
      /** Whole-chunk word schedule (clock engines): the visible page runs
       * the march locally — see contract.WordTimeline. */
      timeline?: WordTimeline;
    }
  | { type: "clear"; sessionId: string }
  | { type: "error"; sessionId: string; message: string };

/** start() options: session-settings overrides plus the T16 resume anchors. */
export interface StartOptions extends Partial<SessionSettings> {
  url?: string;
  /** Restore playback from this token (0 = from the top); clamped into the scope. */
  resumeAt?: number;
}

export interface SessionStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

interface StoredSession {
  sessionId: string;
  state: "playing" | "paused";
  tokenPos: number;
  tokens: TokenText[];
  settings: SessionSettings;
  url: string | null;
  updatedAt: number;
}

interface StoredPrefs {
  voiceName: string | null;
  rate: number;
  engine: string | null;
}

export const SESSION_KEY = "leia:reader:session";
export const PREFS_KEY = "leia:reader:prefs";

const DEFAULT_PREFS: StoredPrefs = { voiceName: null, rate: 1, engine: null };

export class ReaderSession {
  private sessionId: string | null = null;
  private state: ReaderState = "stopped";
  private tokens: TokenText[] = [];
  private chunks: ChunkSpan[] = [];
  private tokenPos = 0;
  private settings: SessionSettings = { ...DEFAULT_PREFS };
  private prefs: StoredPrefs = { ...DEFAULT_PREFS };
  private url: string | null = null;
  private lastError: string | null = null;
  private currentChunk: ChunkSpan | null = null;
  private speakSeq = 0;
  private driveGen = 0;

  private constructor(
    private readonly engine: TextEngine,
    private readonly storage: SessionStorage,
    private readonly emit: (ev: SessionEvent) => void,
    /** Durable user-preference area (storage.local). Defaults to `storage`;
     * session-backed storage would wipe voice/engine on every restart. */
    private readonly prefsStorage: SessionStorage = storage,
  ) {}

  /** Hydrate the singleton from storage.session (owner-vanished resume). */
  static async load(
    engine: TextEngine,
    storage: SessionStorage,
    emit: (ev: SessionEvent) => void,
    prefsStorage: SessionStorage = storage,
  ): Promise<ReaderSession> {
    const session = new ReaderSession(engine, storage, emit, prefsStorage);
    const [stored, prefs] = await Promise.all([
      storage.get(SESSION_KEY),
      prefsStorage.get(PREFS_KEY),
    ]);
    session.prefs = { ...DEFAULT_PREFS, ...(prefs[PREFS_KEY] as StoredPrefs | undefined) };
    session.settings = { ...session.prefs };
    // Hub restarted with us: re-pin the stored family BEFORE any speak can
    // route to the registration-order default — even with no stored session
    // (previews and the first start() must not hit the default family).
    session.syncEngineFamily();
    const s = stored[SESSION_KEY] as StoredSession | undefined;
    if (!s) return session;
    session.sessionId = s.sessionId;
    session.tokens = s.tokens;
    session.tokenPos = s.tokenPos;
    // Legacy stored sessions may predate settings fields — merge over defaults
    // so status.settings always carries voiceName/rate/engine.
    session.settings = { ...session.prefs, ...(s.settings ?? {}) };
    session.url = s.url ?? null;
    session.syncEngineFamily();
    session.chunks = chunkTokens(s.tokens, await session.resolveChunkCap());
    session.state = "paused";
    if (s.state === "playing") {
      // Owner died mid-play: the platform audio may still be running in the
      // offscreen document (Chrome). Cancel it; resume is the normal path.
      session.engine.cancel();
    }
    session.emitState();
    return session;
  }

  status(): SessionStatus {
    return {
      sessionId: this.sessionId,
      state: this.state,
      tokenPos: this.tokenPos,
      tokenCount: this.tokens.length,
      settings: { ...this.settings },
      url: this.url,
      lastError: this.lastError,
    };
  }

  /**
   * Live position view for the per-URL resume store (T16). Null when there
   * is no active session (stopped). The background saves this on pause/stop
   * and when a new start supersedes the current session.
   */
  snapshot(): SessionSnapshot | null {
    if (this.sessionId === null) return null;
    return {
      tokens: this.tokens,
      tokenPos: this.tokenPos,
      settings: { ...this.settings },
      url: this.url,
    };
  }

  /** Start a new session; supersedes any previous one (item 9). */
  async start(tokens: TokenText[], overrides?: StartOptions): Promise<SessionStatus> {
    if (this.state !== "stopped") {
      this.engine.cancel();
      this.currentChunk = null;
    }
    this.driveGen += 1; // invalidate any older drive loop
    if (tokens.length === 0) throw new Error("empty read scope");
    // Resume anchors are start-only routing, not session settings — keep
    // them out of settings (which persists + feeds the engine options).
    const { url, resumeAt, ...rawOverrides } = overrides ?? {};
    // Drop explicit undefineds — spreading {rate: undefined} must not erase
    // prefs (live bug: undefined reached utterance.rate and Firefox threw).
    const settingsOverrides = Object.fromEntries(
      Object.entries(rawOverrides).filter(([, v]) => v !== undefined),
    );
    this.sessionId = newId();
    this.tokens = tokens;
    this.settings = { ...this.prefs, ...settingsOverrides };
    this.url = url ?? null;
    this.lastError = null;
    this.chunks = chunkTokens(tokens, await this.resolveChunkCap());
    // Fresh start after any background restart: re-pin the stored family so
    // the stored voice routes to its own engine, not the hub default.
    this.syncEngineFamily();
    this.tokenPos = Math.max(0, Math.min(resumeAt ?? 0, tokens.length - 1));
    this.state = "playing";
    await this.persist();
    this.emitState();
    void this.drive();
    return this.status();
  }

  async pause(): Promise<SessionStatus> {
    if (this.state !== "playing") return this.status();
    this.lastError = null;
    this.tokenPos = this.currentChunk?.from ?? this.tokenPos;
    this.state = "paused";
    this.driveGen += 1;
    await this.persist();
    this.emitState();
    // Cancel the current utterance; drive() sees `cancelled` and returns.
    this.engine.cancel();
    return this.status();
  }

  async resume(): Promise<SessionStatus> {
    if (this.state !== "paused" || this.sessionId === null) return this.status();
    this.lastError = null;
    this.state = "playing";
    this.driveGen += 1;
    await this.persist();
    void this.drive();
    return this.status();
  }

  /**
   * Jump playback (or the paused anchor) to a token (T7). While playing,
   * cancels the current utterance — the drive loop sees `cancelled`, leaves
   * tokenPos untouched, and re-speaks from the new position. While paused,
   * only moves the anchor + highlight; never starts playback.
   */
  async seek(token: number): Promise<SessionStatus> {
    if (this.state === "stopped" || this.tokens.length === 0) return this.status();
    const target = Math.trunc(token);
    if (!Number.isFinite(target)) return this.status();
    this.tokenPos = Math.max(0, Math.min(target, this.tokens.length - 1));
    const chunk = this.findChunkAt(this.tokenPos) ?? { from: this.tokenPos, to: this.tokenPos };
    if (this.state === "playing") {
      this.engine.cancel();
    }
    await this.persist();
    this.emitState();
    // Jump the marching highlight immediately; the drive loop re-emits the
    // same chunk highlight when it re-speaks (idempotent on the content side).
    this.emit({ type: "highlight", sessionId: this.sessionId as string, from: chunk.from, to: chunk.to });
    return this.status();
  }

  async stop(): Promise<SessionStatus> {
    if (this.state === "stopped") return this.status();
    this.engine.cancel();
    this.currentChunk = null;
    this.state = "stopped";
    this.driveGen += 1;
    const id = this.sessionId;
    this.sessionId = null;
    this.tokens = [];
    this.chunks = [];
    this.tokenPos = 0;
    await this.storage.remove(SESSION_KEY);
    this.emitState();
    if (id) this.emit({ type: "clear", sessionId: id });
    return this.status();
  }

  /** Persist user preferences (voice, speed, engine) across sessions; live for the next chunk. */
  async setPrefs(prefs: Partial<SessionSettings>): Promise<SessionStatus> {
    this.prefs = { ...this.prefs, ...prefs };
    this.settings = { ...this.settings, ...this.prefs };
    await this.prefsStorage.set({ [PREFS_KEY]: this.prefs });
    if ("engine" in prefs && prefs.engine) {
      // Family switch takes effect from the next chunk (current playback
      // keeps its engine). null = engine default — leave the current one.
      this.engine.selectFamily?.(prefs.engine);
    } else if ("voiceName" in prefs && prefs.voiceName) {
      // Voice-only change (popup omits `engine` when it believes the family
      // is already current — stale after any background restart). Re-derive
      // the family from where that voice actually lives.
      await this.syncVoiceFamily(prefs.voiceName);
    }
    if (this.state === "playing" || this.state === "paused") {
      // Live-apply to the persisted session so a resumed session keeps them.
      await this.persist();
    }
    this.emitState();
    return this.status();
  }

  /** selectFamily for settings.engine, when one is stored. */
  private syncEngineFamily(): void {
    if (this.settings.engine) this.engine.selectFamily?.(this.settings.engine);
  }

  /**
   * Route to the family that owns `voiceName`. Always re-selects — idempotent
   * for the hub, and it self-heals a hub that restarted on its default family
   * while prefs still name the right engine. Unresolvable voices (missing
   * key → empty list) are a no-op.
   */
  private async syncVoiceFamily(voiceName: string): Promise<void> {
    try {
      const voices = await this.engine.getVoices();
      const chosen = voices.find((v) => v.name === voiceName);
      if (!chosen) return;
      this.prefs.engine = chosen.family;
      this.settings.engine = chosen.family;
      await this.prefsStorage.set({ [PREFS_KEY]: this.prefs });
      this.engine.selectFamily?.(chosen.family);
    } catch {
      /* voice listing is best-effort; keep routing as-is */
    }
  }

  // --- internals ---

  private async drive(): Promise<void> {
    const gen = ++this.driveGen;
    try {
      while (this.state === "playing" && this.tokenPos < this.tokens.length) {
        if (gen !== this.driveGen) return; // superseded by start/pause/stop/resume
        const chunk = this.findChunkAt(this.tokenPos) ?? { from: this.tokenPos, to: this.tokenPos };
        this.currentChunk = chunk;
        this.emit({ type: "highlight", sessionId: this.sessionId as string, from: chunk.from, to: chunk.to });

        // Pipelining (ADR-0003): have the engine synthesize chunk N+1 while N plays.
        const nextChunk = this.findChunkAt(chunk.to + 1);
        if (nextChunk && typeof this.engine.prefetch === "function") {
          void this.engine
            .prefetch(chunkText(this.tokens, nextChunk), {
              voiceName: this.settings.voiceName,
              rate: this.settings.rate,
            })
            .catch(() => {}); // prefetch is an optimization; failures fall back to non-cached speak
        }

        const speakId = ++this.speakSeq;
        const iterable = this.engine.speak(chunkText(this.tokens, chunk), speakId, {
          voiceName: this.settings.voiceName,
          rate: this.settings.rate,
        });
        let outcome: "end" | "cancelled" | "error" = "end";
        const wordTiming = this.engine.capabilities.wordTiming;
        for await (const ev of iterable) {
          if (ev.type === "word") {
            if (wordTiming && outcome === "end") {
              this.emit({
                type: "highlight",
                sessionId: this.sessionId as string,
                from: chunk.from,
                to: chunk.to,
                word: { begin: ev.begin, end: ev.end },
              });
            }
            continue;
          }
          if (ev.type === "timeline") {
            if (wordTiming && outcome === "end") {
              this.emit({
                type: "highlight",
                sessionId: this.sessionId as string,
                from: chunk.from,
                to: chunk.to,
                timeline: { words: ev.words, anchorWall: ev.anchorWall, anchorClock: ev.anchorClock },
              });
            }
            continue;
          }
          if (ev.type === "cancelled") {
            outcome = "cancelled";
            break;
          }
          if (ev.type === "error") {
            outcome = "error";
            this.lastError = ev.message;
            break;
          }
        }
        this.currentChunk = null;
        if (this.state !== "playing" || gen !== this.driveGen) return; // paused/stopped/superseded
        if (outcome === "error") {
          // Transport/engine failure — park as paused so resume retries cleanly,
          // and surface the failure (T17) instead of failing silently. tokenPos
          // still anchors the failed chunk: resume replays from it.
          console.error("[leia-debug] drive park (error outcome):", this.lastError);
          const id = this.sessionId;
          this.state = "paused";
          await this.persist();
          this.emitState();
          if (id) this.emit({ type: "error", sessionId: id, message: this.lastError ?? "engine error" });
          return;
        }
        if (outcome === "end") this.tokenPos = chunk.to + 1;
        await this.persist();
      }
    } catch (err) {
      // Engine transport failure — park as paused so resume retries cleanly.
      console.error("[leia-debug] drive park (thrown):", err);
      this.lastError = err instanceof Error ? err.message : String(err);
      const id = this.sessionId;
      this.state = "paused";
      await this.persist();
      this.emitState();
      if (id) this.emit({ type: "error", sessionId: id, message: this.lastError });
    }
    if (this.state === "playing" && this.tokenPos >= this.tokens.length) {
      this.state = "stopped";
      const id = this.sessionId;
      this.sessionId = null;
      this.tokens = [];
      this.chunks = [];
      this.tokenPos = 0;
      await this.storage.remove(SESSION_KEY);
      this.emitState();
      if (id) this.emit({ type: "clear", sessionId: id });
    }
  }

  private findChunkAt(tokenIndex: number): ChunkSpan | null {
    return this.chunks.find((c) => tokenIndex >= c.from && tokenIndex <= c.to) ?? null;
  }

  /**
   * Selected voice's language tag, or null when no voice is selected / the
   * engine hides it. Drives the CJK chunk cap and the content-side locale
   * for word-level highlighting.
   */
  async voiceLang(): Promise<string | null> {
    try {
      const voices = await this.engine.getVoices();
      const voice = voices.find((v) => v.name === this.settings.voiceName);
      return voice?.lang ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Utterance cap: engines that synthesize whole pieces server-side (HTTP
   * MP3) declare their real capacity — honor it so a paragraph reads as one
   * seamless audio with no per-sentence request boundaries. Engines without
   * a declared cap keep the WebSpeech-safe behavior (250 Latin / 100 CJK).
   */
  private async resolveChunkCap(): Promise<number> {
    const engineCap = this.engine.capabilities.maxUtteranceChars;
    if (typeof engineCap === "number") return engineCap;
    const lang = await this.voiceLang();
    return lang && isCjkLocale(lang) ? CJK_TOKEN_CHARS : MAX_TOKEN_CHARS;
  }

  private async persist(): Promise<void> {
    if (this.sessionId === null) return;
    const record: StoredSession = {
      sessionId: this.sessionId,
      state: this.state === "playing" ? "playing" : "paused",
      tokenPos: this.tokenPos,
      tokens: this.tokens,
      settings: { ...this.settings },
      url: this.url,
      updatedAt: Date.now(),
    };
    await this.storage.set({ [SESSION_KEY]: record });
  }

  private emitState(): void {
    this.emit({ type: "state", status: this.status() });
  }
}

export interface TokenText {
  text: string;
  /** Token starts a new DOM block (paragraph, list item, table cell…): the
   * chunker never merges it into the previous utterance and the content
   * script widens the highlight wash to cover this whole block. */
  blockStart?: boolean;
  /** Token is a heading (H1–H6) — reads and highlights alone. */
  heading?: boolean;
}

function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `s${Date.now()}`;
}