import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON
);

const el = {
  story: document.getElementById("story"),
  prompt: document.getElementById("prompt"),
  name: document.getElementById("name"),
  send: document.getElementById("send"),
  twist: document.getElementById("twist"),
  style: document.getElementById("style"),
  temp: document.getElementById("temp"),
};

function autoscroll(){ el.story.scrollTop = el.story.scrollHeight; }

async function loadInitial(){
  const { data } = await sb.from("segments").select("*").order("id", { ascending: true }).limit(1000);
  el.story.textContent = (data||[]).map(s=>s.text).join("");
  autoscroll();
}
loadInitial();

sb.channel("realtime:segments")
  .on("postgres_changes", { event:"INSERT", schema:"public", table:"segments" }, (payload)=>{
    el.story.textContent += payload.new.text;
    autoscroll();
  })
  .subscribe();

el.send.onclick = async () => {
  const author = el.name.value.trim() || "anon";
  const prompt = el.prompt.value.trim();
  if (!prompt || prompt.length > 280) { alert("enter 1–280 chars"); return; }
  el.send.disabled = true; setTimeout(()=>el.send.disabled=false, 2000); // tiny rate limit
  await sb.from("queue").insert({ author, prompt });
  el.prompt.value = "";
};

el.twist.onclick = async () => {
  await sb.from("queue").insert({ author:"system", prompt:"[TWIST]" });
};

// Download transcript button
const dl = document.createElement("button");
dl.textContent = "Download .txt";
dl.style.marginTop = "10px";
dl.onclick = () => {
  const blob = new Blob([el.story.textContent], {type:"text/plain"});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "the-woven-chronicle.txt";
  a.click();
};
document.body.appendChild(dl);

// expose controls for the admin processor via window.opener
window.__getControls = () => ({ style: el.style.value, temp: parseFloat(el.temp.value) });
