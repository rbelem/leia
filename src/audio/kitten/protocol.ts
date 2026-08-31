// SPDX-License-Identifier: MPL-2.0
/**
 * Message protocol between KittenEngine (offscreen doc / event page) and the
 * kitten synthesis worker (worker.ts). Kept dependency-free so both sides
 * (and the tests) can import it without pulling ORT or the DOM audio host.
 */

export interface KittenInitRequest {
  type: "init";
}

export interface KittenReadyReply {
  type: "ready";
  inputNames: readonly string[];
}

export interface KittenSynthRequest {
  type: "synth";
  reqId: number;
  text: string;
  voice: string;
  /** Playback rate multiplier (0.5–2; maps onto the model's speed input). */
  speed: number;
}

export interface KittenAudioReply {
  type: "audio";
  reqId: number;
  /** Float32 mono PCM @ 24 kHz (transferred buffer). */
  audio: ArrayBuffer;
}

export interface KittenErrorReply {
  type: "error";
  /** reqId present = a synth request failed; absent = init failure. */
  reqId?: number;
  message: string;
}

export type KittenWorkerRequest = KittenInitRequest | KittenSynthRequest;
export type KittenWorkerReply = KittenReadyReply | KittenAudioReply | KittenErrorReply;
