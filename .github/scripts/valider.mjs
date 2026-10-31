// Robot de validation de la Bande à Paulo.
// Lit les validations envoyées par le bouton « ✓ Valider » des notifications ntfy,
// applique les propositions correspondantes à songs.json (chiffré) et prévient quand c'est en ligne.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { webcrypto as crypto } from "node:crypto";
import { inflateRawSync } from "node:zlib";

const NTFY = process.env.BAP_NTFY || "https://ntfy.sh/";
const TOPIC = "bandeapaulo-nrsu2g9s43";
const OK_TOPIC = TOPIC + "-ok", PROP_TOPIC = TOPIC + "-prop", UPD_TOPIC = TOPIC + "-maj";
const STATE = ".github/valider-fait.json";
const RESUME = (process.env.RUNNER_TEMP || "/tmp") + "/valider-resume.txt";
const PW = process.env.BAP_MOT_DE_PASSE || "";

// ntfy.sh peut refuser ponctuellement (surcharge, trop de requêtes depuis les serveurs GitHub) :
// on réessaie plusieurs fois ; si ça ne passe toujours pas, on abandonne sans erreur, le passage suivant (5 min) rattrapera.
class Reseau extends Error {}
const poll = async (topic) => {
  let last = "";
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(`${NTFY}${topic}/json?poll=1&since=12h`);
      if (r.ok) return (await r.text()).split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((m) => m && m.event === "message");
      last = String(r.status);
    } catch (e) { last = e.message; }
    await new Promise((res) => setTimeout(res, 4000 * (i + 1)));
  }
  throw new Reseau(`ntfy ${topic} injoignable (${last})`);
};
const notify = (msg) => fetch(NTFY, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.assign({ topic: TOPIC }, msg)) }).catch(() => {});

function unpack(str) {
  let b = decodeURIComponent(str).slice(1).replace(/-/g, "+").replace(/_/g, "/");
  while (b.length % 4) b += "=";
  let data = Buffer.from(b, "base64");
  if (str[0] === "1") data = inflateRawSync(data);
  return JSON.parse(data.toString("utf8"));
}

// Même dérivation que l'appli (normPw + PBKDF2-SHA256 + AES-GCM)
const normPw = (p) => p.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
async function aesKey(env) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(normPw(PW)), "PBKDF2", false, ["deriveBits"]);
  const raw = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: Buffer.from(env.salt, "base64"), iterations: env.iter || 150000 }, base, 256);
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

const canon = (v) => Array.isArray(v) ? "[" + v.map(canon).join(",") + "]"
  : v && typeof v === "object" ? "{" + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}"
  : JSON.stringify(v === undefined ? null : v);

async function main() {
  const done = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : [];
  const decisions = new Map(); // clé -> "ok" | "no" (la dernière décision compte)
  for (const m of await poll(OK_TOPIC)) {
    const [d, key] = String(m.message || "").trim().split("|");
    if ((d === "ok" || d === "no") && key && /^[a-z0-9]{6,30}$/.test(key)) decisions.set(key, d);
  }
  const todo = [...decisions].filter(([k]) => !done.includes(k));
  if (!todo.length) { console.log("Rien à valider."); return; }

  const parts = {};
  for (const m of await poll(PROP_TOPIC)) {
    const a = String(m.message || "").split("|");
    if (a.length < 4) continue;
    (parts[a[0]] ||= { n: +a[2], p: [] }).p[+a[1]] = a.slice(3).join("|");
  }

  const fileText = readFileSync("songs.json", "utf8");
  const file = JSON.parse(fileText);
  const env = file && file.enc === 1 ? file : null;
  let key = null, data;
  if (env) {
    if (!PW) { await notify({ title: "⚠ Validation impossible", message: "Le mot de passe du groupe n'est pas encore enregistré dans GitHub (secret BAP_MOT_DE_PASSE).", priority: 4, tags: ["warning"] }); throw new Error("Secret BAP_MOT_DE_PASSE manquant"); }
    key = await aesKey(env);
    try {
      const ct = Buffer.from(env.data, "base64");
      data = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: Buffer.from(env.iv, "base64") }, key, ct)));
    } catch {
      await notify({ title: "⚠ Validation impossible", message: "Le mot de passe enregistré dans GitHub (BAP_MOT_DE_PASSE) n'ouvre pas les grilles. Vérifiez-le.", priority: 4, tags: ["warning"] });
      throw new Error("Mauvais mot de passe");
    }
  } else data = file;

  const applied = [], lost = [];
  for (const [k, d] of todo) {
    done.push(k);
    if (d !== "ok") continue;
    const pr = parts[k];
    if (!pr || pr.p.filter((x) => x != null).length !== pr.n) { lost.push(k); continue; }
    let p;
    try { p = unpack(pr.p.join("")); } catch { lost.push(k); continue; }
    for (const x of p.songs || []) {
      if (!x || !x.id) continue;
      const i = data.songs.findIndex((s) => s.id === x.id);
      let ns;
      if (x._p) {
        if (i < 0) continue;
        ns = Object.assign(JSON.parse(JSON.stringify(data.songs[i])), x._p);
        (x._d || []).forEach((f) => delete ns[f]);
      } else ns = x;
      if (i >= 0) { if (canon(data.songs[i]) === canon(ns)) continue; data.songs[i] = ns; } else data.songs.push(ns);
      applied.push(`${ns.code || ""} ${ns.title || ""}`.trim() + (p.by ? ` (${p.by})` : ""));
    }
  }

  if (applied.length) {
    const plain = JSON.stringify(data, null, 1);
    let out = plain;
    if (env) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plain));
      out = JSON.stringify({ enc: 1, v: 1, alg: "AES-GCM", kdf: "PBKDF2-SHA256", iter: env.iter, salt: env.salt, iv: Buffer.from(iv).toString("base64"), data: Buffer.from(ct).toString("base64") });
    }
    writeFileSync("songs.json", out);
  }
  writeFileSync(STATE, JSON.stringify(done.slice(-400)));
  writeFileSync(process.env.GITHUB_OUTPUT || "/dev/null", `applied=${applied.length}\n`, { flag: "a" });
  writeFileSync(RESUME, applied.join("\n"));
  if (lost.length) await notify({ title: "⚠ Proposition introuvable", message: `${lost.length} validation(s) arrivée(s) trop tard (plus de 12 h) : demandez au musicien de renvoyer sa modification.`, priority: 3, tags: ["warning"] });
  console.log(`Appliqué : ${applied.length}. Perdu : ${lost.length}.`);
}

if (process.argv[2] === "annoncer") {
  const resume = existsSync(RESUME) ? readFileSync(RESUME, "utf8").trim() : "";
  await fetch(NTFY, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ topic: UPD_TOPIC, message: "maj", priority: 1 }) }).catch(() => {});
  await notify({ title: "✓ En ligne pour toutes les tablettes", message: resume || "Modification validée.", tags: ["white_check_mark"], priority: 2 });
} else {
  try { await main(); }
  catch (e) {
    if (e instanceof Reseau) { console.log(`⚠ ${e.message} : on réessaiera au prochain passage.`); writeFileSync(process.env.GITHUB_OUTPUT || "/dev/null", "applied=0\n", { flag: "a" }); }
    else throw e;
  }
}
