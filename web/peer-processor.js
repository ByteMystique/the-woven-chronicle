import { CreateMLCEngine } from "https://esm.run/@mlc-ai/web-llm";

const MODEL_ID = "Llama-3.2-1B-Instruct-q4f16_1-MLC"; // tiny & quick

export function startPeerWeaver(sb, controlsGetter, onStatus=()=>{}) {
  let running = false;
  let engine = null;
  const volunteerId = localStorage.getItem("peer-id") || crypto.randomUUID();
  localStorage.setItem("peer-id", volunteerId);

  async function ensureEngine() {
    if (engine) return engine;
    if (!("gpu" in navigator)) throw new Error("WebGPU not available");
    onStatus("loading model…");
    engine = await CreateMLCEngine(MODEL_ID, {
      initProgressCallback: p => onStatus(`loading ${Math.round(p.progress*100)}%`)
    });
    onStatus("model ready (warming up)");
    await engine.chat.completions.create({
      messages: [{ role:"user", content:"ok" }], max_tokens: 4, temperature: 0.1
    });
    onStatus("ready to weave");
    return engine;
  }

  function sysPrompt(style) {
    return `Write a self-contained micro-chapter in EXACTLY 1–2 short sentences.
You MUST incorporate the audience phrase, either verbatim or by clearly referencing its meaning.
Conclude this micro-chapter clearly. Output ONLY the sentences.
Style: ${style || "freeform surreal"}`;
  }

  function userPrompt(suggestion, tinyCtx = "") {
    if (suggestion === "[TWIST]") {
      return `${tinyCtx ? `Previous (optional): ${tinyCtx}\n` : ""}Hard-cut to a wildly different scene.
Do NOT print the word "twist". Exactly 1–2 sentences. End cleanly.`;
    }
    const clean = String(suggestion).trim().replace(/\s+/g," ");
    return `${tinyCtx ? `Previous (optional): ${tinyCtx}\n` : ""}Audience phrase: "${clean}"
Exactly 1–2 sentences that clearly reflect this phrase. End cleanly. No prefaces.`;
  }

  let tinyCtx = ""; // we keep beats independent; feel free to keep last sentence instead

  async function generate(style, temp, suggestion) {
    const eng = await ensureEngine();
    const out = await eng.chat.completions.create({
      messages: [
        { role:"system", content: sysPrompt(style) },
        { role:"user",   content: userPrompt(suggestion, tinyCtx) }
      ],
      temperature: Math.max(0.75, Math.min(temp || 1.0, 1.0)),
      top_p: 0.9,
      max_tokens: 60
    });
    const text = (out.choices?.[0]?.message?.content || "").trim();
    // cap 2 sentences
    return text.split(/(?<=[.!?])\s+/).slice(0,2).join(" ") + "\n";
  }

  async function loop() {
    onStatus("idle");
    while (running) {
      // free stale jobs just in case
      await sb.rpc("release_stale_jobs", { max_age_seconds: 120 }).catch(()=>{});
      // claim a job
      const { data, error } = await sb.rpc("claim_job_peer", { volunteer: volunteerId });
      if (error) { onStatus("claim error"); await sleep(1200); continue; }
      const job = (data && data[0]) || null;
      if (!job) { await sleep(800); continue; }

      const controls = controlsGetter?.() || { style:"", temp:1.0 };
      const style = job.style || controls.style || "";
      const temp  = (job.temp ?? controls.temp ?? 1.0) * 1;

      onStatus(`weaving #${job.id}…`);
      try {
        const text = await generate(style, temp, job.prompt);
        await sb.from("segments").insert({ text, author: "ai" });
        await sb.from("queue").update({ status:"done" }).eq("id", job.id);
        onStatus(`done #${job.id}`);
        tinyCtx = ""; // micro-chapter independence
      } catch (e) {
        onStatus(`gen error: ${e.message || e}`);
        await sb.from("queue").update({ status:"error" }).eq("id", job.id);
        await sleep(1200);
      }
    }
    onStatus("stopped");
  }

  function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

  return {
    async start(){
      if (running) return;
      running = true;
      try {
        await ensureEngine();
        loop();
      } catch (e) {
        onStatus(e.message || String(e));
        running = false;
      }
    },
    stop(){ running = false; }
  };
}
