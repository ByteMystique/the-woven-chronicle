// --- imports ---
import { createClient } from "@supabase/supabase-js";
import { CreateMLCEngine } from "https://esm.run/@mlc-ai/web-llm";

// --- simple logger ---
const logEl = document.getElementById("log");
const log = (m)=>{ logEl.textContent += m+"\n"; logEl.scrollTop = logEl.scrollHeight; console.log(m); };

// --- supabase client ---
const sb = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_ANON);

// --- tiny rolling context (last 1–2 sentences only) ---
let tinyCtx = ""; // we keep this in memory (fast)
function clipToTwoSentences(s) {
  const parts = s.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s+/);
  return parts.slice(-2).join(" ");
}

// --- db helpers ---
async function appendSegment(text, author="ai"){
  const { error } = await sb.from("segments").insert({ text, author });
  if (error) log("supabase error(appendSegment): " + error.message);
}
async function claimJob(){
  const { data, error } = await sb.rpc("claim_job");
  if (error) { log("supabase error(claim_job): " + error.message); return null; }
  return (data && data[0]) || null;
}
async function markDone(id, status){
  const { error } = await sb.from("queue").update({ status }).eq("id", id);
  if (error) log("supabase error(markDone): " + error.message);
}

// --- prompt builders (tight & obedient) ---
function sysPrompt(style) {
  return `You write an endless story in EXACTLY 1–2 short sentences per turn.
You MUST incorporate the audience phrase, either verbatim or by clearly referencing its meaning.
Do conclude the story. Avoid generic openings like "Once upon a time". Output ONLY the new sentences.
Style: ${style}`;
}
function userPrompt(suggestion) {
  const isTwist = suggestion === "[TWIST]";
  const ctxLine = tinyCtx ? `Previous: ${tinyCtx}\n` : "";

  if (isTwist) {
    // Control message: force a scene jump; never print the word 'twist'
    return `${ctxLine}Hard-cut to a wildly different scene or mood immediately. 
Introduce a surprising location, character, or image. 
Do NOT use or mention the word "twist". 
Write EXACTLY 1–2 short sentences.`;
  }

  const clean = String(suggestion).trim().replace(/\s+/g, " ");
  return `${ctxLine}Audience phrase: "${clean}"
Continue the story now with 1–2 sentences that clearly use this phrase or its main idea.`;
}

function phraseKeyTokens(suggestion){
  return suggestion.toLowerCase().match(/[a-z]{4,}/g)?.slice(0,4) || [];
}
function cleanMatch(textLower, suggestion){
  const s = suggestion.toLowerCase().replace(/\s+/g, " ").trim();
  return s && textLower.includes(s);
}
function suggestionSatisfied(text, suggestion){
  const t = text.toLowerCase();
  const keys = phraseKeyTokens(suggestion);
  if (cleanMatch(t, suggestion)) return true;
  return keys.some(k => t.includes(k));
}

// --- webllm engine manager (auto-recreate on device loss) ---
const MODEL_ID = "Llama-3.2-1B-Instruct-q4f16_1-MLC"; // tiny & fast
let engine = null, loading = false;

function isDeviceLostError(e){
  const s = String(e?.message || e);
  return s.includes("Instance reference no longer exists")
      || s.includes("Module has already been disposed")
      || s.includes("popErrorScope");
}

async function ensureEngine(){
  if (engine || loading) return engine;
  loading = true;
  if (!("gpu" in navigator)) { log("WebGPU not available in this browser."); loading = false; return null; }
  log(`Loading model (${MODEL_ID})…`);
  try {
    engine = await CreateMLCEngine(MODEL_ID, {
      initProgressCallback: p => log(`Model: ${Math.round(p.progress*100)}%`)
    });
    log("Model ready.");
    // warm-up so first real call is snappy
    await engine.chat.completions.create({
      messages: [{ role: "user", content: "ok" }],
      max_tokens: 4, temperature: 0.1
    });
    log("Warm-up done.");
    return engine;
  } catch (e) {
    log("Model load failed: " + (e?.message || e));
    engine = null;
    return null;
  } finally { loading = false; }
}

// --- generator that enforces the phrase ---
async function generate(style, temp, suggestion){
  await ensureEngine();
  if (!engine) throw new Error("engine not ready");

  // Attempt #1
  let out = await engine.chat.completions.create({
    messages: [
      { role: "system", content: sysPrompt(style) },
      { role: "user",   content: userPrompt(suggestion) }
    ],
    temperature: Math.max(0.7, Math.min(temp, 1.0)), // rein it in a bit
    top_p: 0.9,
    max_tokens: 60
  });
  let text = (out.choices?.[0]?.message?.content || "").trim();

  // If it ignored the phrase, escalate once
  if (!suggestionSatisfied(text, suggestion)) {
    const hard = `MUST INCLUDE the exact phrase: "${String(suggestion).trim()}" (or an unmistakable rephrasing). No prefaces. 1–2 sentences only.`;
    out = await engine.chat.completions.create({
      messages: [
        { role: "system", content: sysPrompt(style) },
        { role: "user",   content: userPrompt(suggestion) + "\n" + hard }
      ],
      temperature: 0.7,
      top_p: 0.85,
      max_tokens: 60
    });
    text = (out.choices?.[0]?.message?.content || "").trim();
  }

  // keep to max 2 sentences
  const parts = text.split(/(?<=[.!?])\s+/).slice(0,2);
  return parts.join(" ") + "\n";
}

// --- main loop ---
(async function main(){
  log("booting processor.js");
  await ensureEngine();
  while (true) {
    const job = await claimJob();
    if (!job) { await new Promise(r=>setTimeout(r, 800)); continue; }

    const controls = window.opener?.__getControls?.() || { style: "cozy sci-fi mystery on a bus at night", temp: 1.0 };
    log(`Job #${job.id} by ${job.author}: ${job.prompt}`);

    try {
      let text;
      try {
        text = await generate(controls.style, controls.temp, job.prompt);
      } catch (e) {
        if (isDeviceLostError(e)) {
          log("engine lost → rebuilding…");
          engine = null;
          await ensureEngine();
          text = await generate(controls.style, controls.temp, job.prompt);
        } else {
          throw e;
        }
      }

      await appendSegment(text, "ai");
      tinyCtx = clipToTwoSentences((tinyCtx + " " + text).trim()); // update tiny context
      await markDone(job.id, "done");
      log("…appended.");

      // quick anti-loop: auto-twist if it's repeating
      if (/(.\b\w+\s+\w+\s+\w+\s+\w+\b.*)\1/i.test(text.toLowerCase())) {
        await sb.from("queue").insert({ author: "system", prompt: "[TWIST]" });
      }
    } catch (e) {
      log("final gen error: " + (e?.message || e));
      await markDone(job.id, "error");
      await new Promise(r=>setTimeout(r, 1000));
    }
  }
})();
