/**
 * Popup (toolbar action): Web Speech voice + speed (persisted), session
 * status line, and the toolbar-action fallback for reading the active tab's
 * selection (T2 items 6 & 8). Full settings UI is T14.
 */
import browser from "webextension-polyfill";
import type { RouterMessage, RouterReply } from "../background/router";
import type { SessionStatus } from "../reader/session";
import type { VoiceInfo } from "../reader/contract";

const SPEED_OPTIONS = [0.5, 0.75, 1, 1.5, 2, 2.5, 3];

const statusEl = document.getElementById("status") as HTMLDivElement;
const voiceSelect = document.getElementById("voice") as HTMLSelectElement;
const speedSelect = document.getElementById("speed") as HTMLSelectElement;

const send = (msg: RouterMessage): Promise<unknown> => browser.runtime.sendMessage(msg).catch((err) => ({ error: String(err) }));

let currentStatus: SessionStatus | null = null;
let voicesByFamily = new Map<string, VoiceInfo[]>();

async function refresh(): Promise<void> {
  const [statusReply, voicesReply] = await Promise.all([
    send({ type: "leia:reader:status" }),
    send({ type: "leia:reader:voices" }),
  ]);
  const status = (statusReply as RouterReply | undefined)?.data as SessionStatus | undefined;
  currentStatus = status ?? null;
  if (status) {
    statusEl.textContent =
      status.state === "stopped"
        ? "no active session"
        : `${status.state} · sentence ${Math.min(status.tokenPos + 1, status.tokenCount)}/${status.tokenCount}`;
    speedSelect.value = String(status.settings.rate);
  }

  const voices = ((voicesReply as RouterReply | undefined)?.data as VoiceInfo[] | undefined) ?? [];
  voicesByFamily = new Map<string, VoiceInfo[]>();
  for (const v of voices) {
    const list = voicesByFamily.get(v.family) ?? [];
    list.push(v);
    voicesByFamily.set(v.family, list);
  }
  voiceSelect.innerHTML = '<option value="">(default voice)</option>';
  for (const [family, list] of voicesByFamily) {
    const group = document.createElement("optgroup");
    group.label = family;
    for (const v of list) {
      const opt = document.createElement("option");
      opt.value = v.name;
      opt.textContent = `${v.name} (${v.lang})`;
      group.appendChild(opt);
    }
    voiceSelect.appendChild(group);
  }
  voiceSelect.value = status?.settings.voiceName ?? "";
}

document.getElementById("read-selection")!.addEventListener("click", async () => {
  const reply = (await send({ type: "leia:reader:start" })) as RouterReply | undefined;
  statusEl.textContent = reply?.ok
    ? `reading — ${String((reply.data as SessionStatus | undefined)?.tokenCount ?? "?")} sentences`
    : `failed: ${String(reply?.error ?? "unknown")}`;
});

voiceSelect.addEventListener("change", () => {
  const voiceName = voiceSelect.value || null;
  const prefs: { voiceName: string | null; engine?: string | null } = { voiceName };
  if (voiceName) {
    // Switching families requires routing prefs: send the voice's family
    // when it differs from the session's current engine setting.
    const chosen = [...voicesByFamily.values()].flat().find((v) => v.name === voiceName);
    if (chosen && chosen.family !== currentStatus?.settings.engine) prefs.engine = chosen.family;
  }
  void send({ type: "leia:reader:prefs", ...prefs });
});

speedSelect.addEventListener("change", () => {
  void send({ type: "leia:reader:prefs", rate: Number(speedSelect.value) });
});

for (const v of SPEED_OPTIONS) {
  const opt = document.createElement("option");
  opt.value = String(v);
  opt.textContent = `${v}×`;
  speedSelect.appendChild(opt);
}

void refresh();