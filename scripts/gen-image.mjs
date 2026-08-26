#!/usr/bin/env node
/**
 * Leia image generation for impeccable comp-first work (and anything else).
 * Lane 1: alibaba-token-plan wan2.7-image-pro (chat-completions image_object).
 * Lane 2: minimax image-01 (image_generation). Both direct, no gateway.
 * Usage: node scripts/gen-image.mjs --prompt "..." --out /tmp/x.png [--model wan2.7-image|wan2.7-image-pro|minimax/image-01]
 */
const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, arr) =>
    a.startsWith("--") ? [a.slice(2), arr[i + 1] ?? true] : null
  ).filter(Boolean)
);

const prompt = args.prompt;
const out = args.out;
if (!prompt || !out) {
  console.error("usage: gen-image.mjs --prompt <text> --out <file.png> [--model wan2.7-image-pro]");
  process.exit(2);
}
let model = args.model ?? "wan2.7-image-pro";

async function wanImage() {
  const key = process.env.ALIBABA_TOKEN_PLAN_API_KEY;
  if (!key) throw new Error("ALIBABA_TOKEN_PLAN_API_KEY not set");
  const r = await fetch("https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
      response_format: { type: "image_object" },
      max_tokens: 2000,
    }),
  });
  const d = await r.json();
  const img = d?.output?.choices?.[0]?.message?.content?.find?.((c) => c.type === "image")?.image;
  if (!img) throw new Error(`wan2.7-image failed: ${JSON.stringify(d).slice(0, 300)}`);
  return img;
}

async function minimaxImage() {
  const key = process.env.MINIMAX_API_KEY;
  if (!key) throw new Error("MINIMAX_API_KEY not set");
  const r = await fetch("https://api.minimax.io/v1/image_generation", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "image-01", prompt, aspect_ratio: "1:1" }),
  });
  const d = await r.json();
  const url = d?.data?.image_urls?.[0];
  if (!url) throw new Error(`image-01 failed: ${JSON.stringify(d).slice(0, 300)}`);
  return url;
}

const url = model.startsWith("minimax") ? await minimaxImage() : await wanImage();
const img = await (await fetch(url)).arrayBuffer();
const { writeFileSync } = await import("node:fs");
writeFileSync(out, Buffer.from(img));
console.log(`wrote ${out} (${Buffer.from(img).length} bytes) from ${model}`);