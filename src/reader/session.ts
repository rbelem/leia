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
import type { TextEngine } from "./contract";
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
    }
  | { type: "clear"; sessionId: string };

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
  private currentChunk: ChunkSpan | null = null;
  private speakSeq = 0;
  private driveGen = 0;

  private constructor(
    private readonly engine: TextEngine,
    private readonly storage: SessionStorage,
    private readonly emit: (ev: SessionEvent) => void,
  ) {}

  /** Hydrate the singleton from storage.session (owner-vanished resume). */
  static async load(
    engine: TextEngine,
    storage: SessionStorage,
    emit: (ev: SessionEvent) => void,
  ): Promise<ReaderSession> {
    const session = new ReaderSession(engine, storage, emit);
    const [stored, prefs] = await Promise.all([storage.get(SESSION_KEY), storage.get(PREFS_KEY)]);
    session.prefs = { ...DEFAULT_PREFS, ...(prefs[PREFS_KEY] as StoredPrefs | undefined) };
    session.settings = { ...session.prefs };
    const s = stored[SESSION_KEY] as StoredSession | undefined;
    if (!s) return session;
    session.sessionId = s.sessionId;
    session.tokens = s.tokens;
    session.tokenPos = s.tokenPos;
    session.settings = { ...s.settings };
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
    };
  }

  /** Start a new session; supersedes any previous one (item 9). */
  async start(tokens: TokenText[], overrides?: Partial<SessionSettings>): Promise<SessionStatus> {
    if (this.state !== "stopped") {
      this.engine.cancel();
      this.currentChunk = null;
    }
    this.driveGen += 1; // invalidate any older drive loop
    if (tokens.length === 0) throw new Error("empty read scope");
    this.sessionId = newId();
    this.tokens = tokens;
    this.settings = { ...this.prefs, ...overrides };
    this.chunks = chunkTokens(tokens, await this.resolveChunkCap());
    this.tokenPos = 0;
    this.state = "playing";
    await this.persist();
    this.emitState();
    void this.drive();
    return this.status();
  }

  async pause(): Promise<SessionStatus> {
    if (this.state !== "playing") return this.status();
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
    await this.storage.set({ [PREFS_KEY]: this.prefs });
    if ("engine" in prefs && prefs.engine) {
      // Family switch takes effect from the next chunk (current playback
      // keeps its engine). null = engine default — leave the current one.
      this.engine.selectFamily?.(prefs.engine);
    }
    if (this.state === "playing" || this.state === "paused") {
      // Live-apply to the persisted session so a resumed session keeps them.
      await this.persist();
    }
    this.emitState();
    return this.status();
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
          if (ev.type === "cancelled") {
            outcome = "cancelled";
            break;
          }
          if (ev.type === "error") {
            outcome = "error";
            break;
          }
        }
        this.currentChunk = null;
        if (this.state !== "playing" || gen !== this.driveGen) return; // paused/stopped/superseded
        if (outcome === "error") {
          // Transport/engine failure — park as paused so resume retries cleanly.
          this.state = "paused";
          await this.persist();
          this.emitState();
          return;
        }
        if (outcome === "end") this.tokenPos = chunk.to + 1;
        await this.persist();
      }
    } catch {
      // Engine transport failure — park as paused so resume retries cleanly.
      this.state = "paused";
      await this.persist();
      this.emitState();
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
   * CJK voices (voice lang signals the scope's script) speak shorter
   * utterances: cap chunks at CJK_TOKEN_CHARS instead of the Latin 250.
   */
  private async resolveChunkCap(): Promise<number> {
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
}

function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `s${Date.now()}`;
}