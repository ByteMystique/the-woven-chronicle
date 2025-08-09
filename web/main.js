import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON
);

let peerCtrl = null;

const statusEl = document.getElementById("peer-status");
function setStatus(s){ if(statusEl) statusEl.textContent = s; }

const toggle = document.getElementById("peer-toggle");
toggle.addEventListener("change", async (e)=>{
  if (e.target.checked) {
    if (!peerCtrl) {
      const mod = await import("./peer-processor.js");
      peerCtrl = mod.startPeerWeaver(
        sb,
        () => ({ style: el.style.value, temp: parseFloat(el.temp.value || "1.0") }),
        setStatus
      );
    }
    peerCtrl.start();
  } else {
    peerCtrl?.stop();
    setStatus("");
  }
});

// Optional: remember the user’s choice
toggle.checked = JSON.parse(localStorage.getItem("peer-on") || "false");
toggle.onchange = (e)=> localStorage.setItem("peer-on", String(e.target.checked));
if (toggle.checked) toggle.dispatchEvent(new Event("change"));

const el = {
  story:  document.getElementById("story"),
  prompt: document.getElementById("prompt"),
  name:   document.getElementById("name"),
  send:   document.getElementById("send"),
  twist:  document.getElementById("twist"),
  style:  document.getElementById("style"),
  temp:   document.getElementById("temp"),
};

function autoscroll(){ el.story.scrollTop = el.story.scrollHeight; }

// ---------------- UI sugar: typewriter + tiny blip sound ----------------
const audio = {
  ctx: null,
  muted: JSON.parse(localStorage.getItem("muted") || "false"),
  blip(){
    if (this.muted) return;
    this.ctx ??= new (window.AudioContext||window.webkitAudioContext)();
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = "sine"; o.frequency.value = 880;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.02, t+0.01);
    g.gain.exponentialRampToValueAtTime(0.00001, t+0.15);
    o.connect(g).connect(this.ctx.destination); o.start(t); o.stop(t+0.16);
  }
};

function revealAppend(target, text){
  // fast typewriter: 3 chars per frame
  let i = 0;
  (function tick(){
    const slice = text.slice(i, i+3);
    if (slice) {
      target.textContent += slice;
      i += 3;
      audio.blip();
      autoscroll();
      requestAnimationFrame(tick);
    }
  })();
  // pulse ring (if you added .pulse CSS)
  target.classList.remove("pulse"); void target.offsetWidth; target.classList.add("pulse");
}

// ---------------- Add dice + mute controls (no HTML changes needed) -----
(function addExtras(){
  // 🎲 button
  const dice = document.createElement("button");
  dice.id = "dice"; dice.textContent = "🎲";
  dice.title = "random prompt";
  const seeds = [
    "the bus grows legs", "time glitches for 6 seconds", "a cat made of steam",
    "an elf with a calculator", "gravity misbehaves", "the moon forgets its name"
  ];
  dice.onclick = ()=>{ el.prompt.value = seeds[Math.floor(Math.random()*seeds.length)]; el.prompt.focus(); };

  // mute toggle
  const muteWrap = document.createElement("label");
  muteWrap.style.display = "flex"; muteWrap.style.alignItems = "center"; muteWrap.style.gap = "6px";
  const mute = document.createElement("input"); mute.type = "checkbox"; mute.id = "mute"; mute.checked = audio.muted;
  mute.onchange = (e)=>{ audio.muted = e.target.checked; localStorage.setItem("muted", String(audio.muted)); };
  muteWrap.appendChild(mute);
  muteWrap.appendChild(document.createTextNode("mute"));

  // drop them right after Send
  el.send.parentNode?.insertBefore(dice, el.send.nextSibling);
  el.send.parentNode?.insertBefore(muteWrap, dice.nextSibling);
})();

// ---------------- Persist style & temp per viewer -----------------------
el.style.value = localStorage.getItem("style") || "";        // start EMPTY by default
el.temp.value  = localStorage.getItem("temp")  || "1.0";
el.style.addEventListener("input", ()=> localStorage.setItem("style", el.style.value));
el.temp.addEventListener("input",  ()=> localStorage.setItem("temp",  el.temp.value));

// ---------------- Initial story load ------------------------------------
async function loadInitial(){
  const { data } = await sb.from("segments").select("*").order("id", { ascending: true }).limit(1000);
  el.story.textContent = (data||[]).map(s=>s.text).join("");
  autoscroll();
}
loadInitial();

// ---------------- Realtime updates (typewriter reveal) ------------------
sb.channel("realtime:segments")
  .on("postgres_changes", { event:"INSERT", schema:"public", table:"segments" }, (payload)=>{
    revealAppend(el.story, payload.new.text);
  })
  .subscribe();

// ---------------- Send + Twist (include style/temp per submission) ------
el.send.onclick = async () => {
  const author = el.name.value.trim() || "anon";
  const prompt = el.prompt.value.trim();
  if (!prompt || prompt.length > 280) { alert("enter 1–280 chars"); return; }
  el.send.disabled = true; setTimeout(()=>el.send.disabled=false, 1200); // tiny rate limit

  await sb.from("queue").insert({
    author,
    prompt,
    style: el.style.value.trim() || null,
    temp:  parseFloat(el.temp.value || "1.0")
  });
  el.prompt.value = "";
};

el.twist.onclick = async () => {
  await sb.from("queue").insert({
    author: "system",
    prompt: "[TWIST]",
    style: el.style.value.trim() || null,
    temp:  parseFloat(el.temp.value || "1.0")
  });
};

// ---------------- Download transcript button ----------------------------
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

// ---------------- Expose controls for legacy admin (optional) ----------
window.__getControls = () => ({
  style: el.style.value,
  temp:  parseFloat(el.temp.value || "1.0")
});
