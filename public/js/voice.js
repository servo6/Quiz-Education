// Chat vocal du duel en direct : audio pair-à-pair (WebRTC), signalisation relayée par Socket.IO.
// Chaque joueur entend toujours l'autre ; le micro s'active et se coupe d'un bouton (coupé par défaut).
import { h, toast } from "./lib.js";

let sock = null, pc = null, stream = null, track = null, iceServers = null;
let polite = false, making = false, ignoreOffer = false, micOn = false, active = false;
let audio = null, btn = null, onState = () => {};

export const voiceSupported = () => !!(navigator.mediaDevices?.getUserMedia && window.RTCPeerConnection);
const send = (m) => sock?.emit("voice:signal", m, () => {});

async function ensurePc() {
  if (pc) return pc;
  if (!iceServers) iceServers = await new Promise((res) => sock.emit("voice:config", {}, (r) => res(r?.iceServers ?? [{ urls: "stun:stun.l.google.com:19302" }])));
  pc = new RTCPeerConnection({ iceServers });
  pc.onicecandidate = ({ candidate }) => { if (candidate) send({ candidate }); };
  pc.ontrack = (e) => { audio.srcObject = e.streams[0] ?? new MediaStream([e.track]); audio.play().catch(() => {}); };
  pc.onnegotiationneeded = async () => {
    try { making = true; await pc.setLocalDescription(); send({ description: pc.localDescription }); }
    catch (e) { console.error(e); } finally { making = false; }
  };
  pc.onconnectionstatechange = () => { if (pc?.connectionState === "failed") { toast("Connexion vocale impossible sur ce réseau", "bad"); } };
  // Toujours prêt à recevoir l'audio de l'autre, même micro coupé.
  pc.addTransceiver("audio", { direction: "recvonly" });
  return pc;
}

async function onSignal({ description, candidate, bye }) {
  if (!active) return;
  if (bye) { closePc(); return; }
  try {
    const p = await ensurePc();
    if (description) {
      const collision = description.type === "offer" && (making || p.signalingState !== "stable");
      ignoreOffer = !polite && collision;
      if (ignoreOffer) return;
      await p.setRemoteDescription(description);
      if (description.type === "offer") {
        // Si l'autre parle et pas moi, ma partie reste en réception seule.
        await p.setLocalDescription();
        send({ description: p.localDescription });
      }
    } else if (candidate) {
      try { await p.addIceCandidate(candidate); } catch (e) { if (!ignoreOffer) throw e; }
    }
  } catch (e) { console.error(e); }
}

function closePc() { try { pc?.close(); } catch { /* déjà fermé */ } pc = null; if (audio) audio.srcObject = null; }

async function setMic(on) {
  if (on) {
    if (!voiceSupported()) return toast("Ton navigateur ne gère pas le micro", "bad");
    if (!window.isSecureContext) return toast("Le micro demande une connexion sécurisée (https)", "bad");
    try {
      if (!stream) {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
        track = stream.getAudioTracks()[0];
      }
    } catch (e) {
      return toast(e?.name === "NotAllowedError" ? "Micro refusé : autorise-le dans les réglages du navigateur" : "Micro introuvable", "bad");
    }
    track.enabled = true;
    const p = await ensurePc();
    const tr = p.getTransceivers().find((t) => t.receiver.track.kind === "audio");
    if (tr && tr.sender && !tr.sender.track) { await tr.sender.replaceTrack(track); tr.direction = "sendrecv"; }
    micOn = true;
  } else {
    if (track) track.enabled = false;
    micOn = false;
  }
  paint();
}

function paint() {
  if (!btn) return;
  btn.hidden = !active;
  btn.classList.toggle("on", micOn);
  btn.textContent = micOn ? "🎙️" : "🔇";
  btn.setAttribute("aria-pressed", String(micOn));
  btn.title = btn.ariaLabel = micOn ? "Couper mon micro" : "Activer mon micro";
}

/** À appeler une fois avec la socket. */
export function initVoice(socket) {
  sock = socket;
  audio = h("audio", { autoplay: true, playsinline: true, hidden: true });
  btn = h("button.voice-btn", { type: "button", hidden: true, onclick: () => setMic(!micOn) });
  document.body.append(audio, btn);
  socket.on("voice:signal", onSignal);
  paint();
}

/** Appelé à chaque rendu du duel : `game` = partie en cours (ou null). */
export function voiceSync(game, myId) {
  const now = !!game && game.phase !== "DONE";
  if (now && !active) { active = true; polite = String(myId) < String(game.opponent?.id ?? ""); }
  if (!now && active) stopVoice();
  paint();
}

export function stopVoice() {
  if (active && sock) send({ bye: true });
  active = false; micOn = false;
  stream?.getTracks().forEach((t) => t.stop()); stream = null; track = null;
  closePc(); iceServers = null; paint();
}
