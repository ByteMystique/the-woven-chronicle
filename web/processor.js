import { createClient } from "@supabase/supabase-js";
import { CreateMLCEngine } from "webllm";

const log = (t)=>{ const el=document.getElementById("log"); el.textContent += t+"\n"; el.scrollTop=el.scrollHeight; };

const sb = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON
);

// Load a small model. First load ~30–60s, then cached.
log("Loading model (Phi-3 mini)… first load can take a minute over the network.");
const engine = await CreateMLCEngine("Phi-3-mini-4k-instruct-q4f16_1-MLC", {
  initProgressCallback: (p) => log(`Model: ${Math.round(p.progress*100)}%`)
});
log("Model ready.");

async function lastContext(chars=1500){
  const { data } = await sb.from("segments").select("text").order("id", { ascending:false }).limit(60);
  const text = (data||[]).reverse().map(s=>s.text).join("");
  return text.slice(-chars);
}

async function appendSegment(text, author="ai"){
  await sb.from("segments").insert({ text, author });
}

function sysPrompt(style){
  return `You are an endless storyteller. Output 2–4 whimsical sentences per turn.
Never conclude. Avoid repeating phrases. Vary pacing, settings, and characters.
Keep loose continuity. Style: ${style}`;
}
function userPrompt(ctx, suggestion){
  const sug = suggestion==="[TWIST]" ? "Introduce a surprising location or character. No resolution."
                                     : `Weave in: "${suggestion}"`;
  return `Previous story (excerpt):\n${ctx}\n\n${sug}\nContinue the story now (no summary, no ending).`;
}

async function generate(style, temp, suggestion){
  const ctx = await lastContext();
  const messages = [
    { role:"system", content: sysPrompt(style) },
    { role:"user",   content: userPrompt(ctx, suggestion) }
  ];
  const out = await engine.chat.completions.create({
    messages, temperature: temp, max_tokens: 180
  });
  return (out.choices?.[0]?.message?.content || "").trim() + "\n";
}

async function claimJob(){
  const { data, error } = await sb.rpc("claim_job");
  if (error) { log("claim error: "+error.message); return null; }
  return (data && data[0]) || null;
}
async function markDone(id, status){ await sb.from("queue").update({ status }).eq("id", id); }

async function loop(){
  while(true){
    const job = await claimJob();
    if(!job){ await new Promise(r=>setTimeout(r,1000)); continue; }

    const controls = window.opener?.__getControls?.() || { style:"cozy sci-fi mystery on a bus at night", temp:1.05 };
    log(`Job #${job.id} by ${job.author}: ${job.prompt}`);

    try{
      const text = await generate(controls.style, controls.temp, job.prompt);
      await appendSegment(text, "ai");
      await markDone(job.id, "done");
      log("…appended.");
      // quick anti-loop: if obvious repetition, schedule a twist
      if (/(.\b\w+\s+\w+\s+\w+\s+\w+\b.*)\1/i.test(text.toLowerCase())){
        await sb.from("queue").insert({ author:"system", prompt:"[TWIST]" });
      }
    }catch(e){
      log("gen error: "+e.message);
      await markDone(job.id, "error");
    }
  }
}
loop();
