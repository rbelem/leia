// SPDX-License-Identifier: MPL-2.0
/**
 * Ming-3.0-TTS built-in voice catalog.
 *
 * The Ming checkpoints carry 55 built-in speakers (50 Chinese, 5 English)
 * that live inside the weights — the server cannot enumerate them, so
 * vLLM-Omni's `/v1/audio/voices` answers with a synthetic "default" only.
 * The built-in profile therefore declares the catalog here and leia's probe
 * merges it over the server's answer.
 *
 * Source of truth: the upstream cookbooks list
 * (inclusionAI/Ming-3.0-tts `cookbooks/instruction_en.md`, "Built-in premium
 * voices") and vLLM-Omni's IP catalog
 * (`vllm_omni/model_executor/models/ming_flash_omni/data/ip_voices.json`).
 * Emotion variants (`<voice>_<emotion>`, e.g. `灵小柔_高兴`) are valid IP
 * captions upstream but are left out of the picker to keep it readable.
 *
 * The names are the model's `IP` captions verbatim — case matters, the
 * server matches them against the checkpoint's own catalog.
 */
import type { LocalVoice } from "./local-profiles";

/** The model's own default speaker (upstream `DEFAULT_IP_VOICE`). */
export const MING_DEFAULT_VOICE = "灵小柔";

export const MING_VOICES: LocalVoice[] = [
  { id: "灵小柔", lang: "zh", name: "灵小柔" },
  { id: "US_James", lang: "en", name: "US_James" },
  { id: "US_Stella", lang: "en", name: "US_Stella" },
  { id: "灵楷", lang: "zh", name: "灵楷" },
  { id: "US_Emma", lang: "en", name: "US_Emma" },
  { id: "UK_George", lang: "en", name: "UK_George" },
  { id: "UK_Charlotte", lang: "en", name: "UK_Charlotte" },
  { id: "灵小安", lang: "zh", name: "灵小安" },
  { id: "灵语汐", lang: "zh", name: "灵语汐" },
  { id: "灵小萌", lang: "zh", name: "灵小萌" },
  { id: "灵小雅", lang: "zh", name: "灵小雅" },
  { id: "花小呗", lang: "zh", name: "花小呗" },
  { id: "灵韵", lang: "zh", name: "灵韵" },
  { id: "妩媚妲己", lang: "zh", name: "妩媚妲己" },
  { id: "灵婉", lang: "zh", name: "灵婉" },
  { id: "灵小月", lang: "zh", name: "灵小月" },
  { id: "灵朵儿", lang: "zh", name: "灵朵儿" },
  { id: "灵岩", lang: "zh", name: "灵岩" },
  { id: "灵小锋", lang: "zh", name: "灵小锋" },
  { id: "灵小川", lang: "zh", name: "灵小川" },
  { id: "灵小甄", lang: "zh", name: "灵小甄" },
  { id: "灵小知", lang: "zh", name: "灵小知" },
  { id: "灵小惠", lang: "zh", name: "灵小惠" },
  { id: "灵小晴", lang: "zh", name: "灵小晴" },
  { id: "灵小琪", lang: "zh", name: "灵小琪" },
  { id: "灵梦", lang: "zh", name: "灵梦" },
  { id: "灵恬", lang: "zh", name: "灵恬" },
  { id: "灵小汐", lang: "zh", name: "灵小汐" },
  { id: "灵小棠", lang: "zh", name: "灵小棠" },
  { id: "灵小梨", lang: "zh", name: "灵小梨" },
  { id: "灵舒", lang: "zh", name: "灵舒" },
  { id: "灵娇", lang: "zh", name: "灵娇" },
  { id: "灵小芸", lang: "zh", name: "灵小芸" },
  { id: "灵锐", lang: "zh", name: "灵锐" },
  { id: "灵空", lang: "zh", name: "灵空" },
  { id: "灵宇", lang: "zh", name: "灵宇" },
  { id: "灵朗", lang: "zh", name: "灵朗" },
  { id: "灵旭", lang: "zh", name: "灵旭" },
  { id: "灵骁", lang: "zh", name: "灵骁" },
  { id: "灵江", lang: "zh", name: "灵江" },
  { id: "悲伤女声", lang: "zh", name: "悲伤女声" },
  { id: "皮六", lang: "zh", name: "皮六" },
  { id: "说唱小哥", lang: "zh", name: "说唱小哥" },
  { id: "蜡笔小新", lang: "zh", name: "蜡笔小新" },
  { id: "悟空", lang: "zh", name: "悟空" },
  { id: "蜡笔小新_野原新之助 (小新)", lang: "zh", name: "蜡笔小新_野原新之助 (小新)" },
  { id: "蜡笔小新_野原美伢 (美伢)", lang: "zh", name: "蜡笔小新_野原美伢 (美伢)" },
  { id: "小猪佩奇_佩奇", lang: "zh", name: "小猪佩奇_佩奇" },
  { id: "康熙王朝_康熙", lang: "zh", name: "康熙王朝_康熙" },
  { id: "西游记_唐僧", lang: "zh", name: "西游记_唐僧" },
  { id: "甄嬛传_四郎", lang: "zh", name: "甄嬛传_四郎" },
  { id: "潜伏_余则成", lang: "zh", name: "潜伏_余则成" },
  { id: "水浒传_武松", lang: "zh", name: "水浒传_武松" },
  { id: "水浒传_潘金莲", lang: "zh", name: "水浒传_潘金莲" },
  { id: "雍正王朝_雍正", lang: "zh", name: "雍正王朝_雍正" },];
