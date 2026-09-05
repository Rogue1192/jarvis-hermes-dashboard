/* JARVIS Live HUD — drives Hermes Agent, streams telemetry.

   The brain is your own `hermes` CLI/profile, so configured Hermes tools,
   browser automation, skills, memory, MCP servers and third-party connectors are live. */
const $ = s => document.querySelector(s);
const RT = {tts:false, stt:false, browserStt:false, browserTts:false};
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const speechSynth = window.speechSynthesis;
const API_TOKEN = document.querySelector('meta[name="jarvis-token"]')?.content || '';
const apiHeaders = extra => ({'x-jarvis-token': API_TOKEN, ...(extra || {})});

// ── reactor ticks ──
(() => {
  const g = $('#ticks480');
  for (let i = 0; i < 128; i++){
    const a = (i/128) * Math.PI*2, maj = i % 8 === 0;
    const r0 = maj ? 246 : 250, r1 = 260;
    const l = document.createElementNS('http://www.w3.org/2000/svg','line');
    l.setAttribute('x1', 260+Math.cos(a)*r0); l.setAttribute('y1', 260+Math.sin(a)*r0);
    l.setAttribute('x2', 260+Math.cos(a)*r1); l.setAttribute('y2', 260+Math.sin(a)*r1);
    if (maj) l.setAttribute('class','maj');
    g.appendChild(l);
  }
})();

const now = () => new Date().toLocaleTimeString('en-GB', {hour12:false});
const rid = () => 'run_' + (crypto.randomUUID ? crypto.randomUUID().replace(/-/g,'').slice(0,24)
                                              : Math.random().toString(16).slice(2,14));
const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));

// ── reactor state ──
function setState(cls, word, sub){
  document.body.className = cls;
  if (word) $('#stword').textContent = word;
  if (sub != null) $('#strun').textContent = sub;
}
function setTag(cls, text){ const t=$('#rtag'); t.className='rtag '+cls; t.textContent=text; }

// ── action log ──
function log(kind, label, msg, jsonHtml){
  const e = document.createElement('div');
  e.className = 'entry k-' + kind;
  e.innerHTML = `<div class="top"><span class="ts">${now()}</span>`
    + `<span class="kind">${esc(label)}</span></div>`
    + (msg ? `<div class="msg">${esc(msg)}</div>` : '')
    + (jsonHtml ? `<div class="jsonblk">${jsonHtml}</div>` : '');
  const box = $('#log');
  box.insertBefore(e, box.firstChild);
  while (box.children.length > 40) box.removeChild(box.lastChild);
}
function usageBlock(u){
  const row = (k,v) => `  <span class="k">"${k}"</span>: <span class="v">${v}</span>`;
  return `{\n  <span class="k">"usage"</span>: {\n`
    + [row('input_tokens', u.input_tokens), row('output_tokens', u.output_tokens),
       row('total_tokens', u.total_tokens)].join(',\n')
    + `\n  }\n}`;
}

// ── the run ──
let running = false, answer = '', firstDelta = false, speakThisRun = true;
let speakDone = Promise.resolve(), activeController = null;

// ── streaming speech ────────────────────────────────────────────────────
// Waiting for the whole answer before speaking cost ~5s of dead air on every
// question: generate fully → synthesize fully → play. Instead we hand each
// finished sentence to TTS as it streams in, so JARVIS starts talking while the
// rest of the answer is still being written and the tail is never heard as a gap.
// Chunks are played through one promise chain so they can never overlap.
const SPEECH_MIN_CHUNK = 60;    // don't fire a request for a three-word fragment
const SPEECH_BUDGET    = 700;   // same ceiling the old single-shot speak() used
let spokenUpTo = 0, spokenChars = 0, speakPrev = '', speakChain = Promise.resolve();

// When the previous utterance actually FINISHED playing -- not when it was
// queued. The event log shows queue time, which is why "One second, checking on
// it, sir." and "Still on it, sir." looked 4s apart but ran together: the first
// spent that time in ElevenLabs, and the second was already waiting behind it.
let lastSpeechEnd = 0;
const SAY_MIN_GAP = 1600;   // ms of real silence before a second filler

function speakTracked(text, prev){
  return speak(text, prev).then(() => { lastSpeechEnd = Date.now(); });
}

// Fillers exist to break silence. If there is no silence -- because the previous
// line only just stopped -- wait for some before adding another, or it reads as
// one run-on sentence and defeats the point.
function speakFiller(text, prev){
  return speakChain = speakChain.then(async () => {
    const wait = SAY_MIN_GAP - (Date.now() - lastSpeechEnd);
    if (lastSpeechEnd && wait > 0) await new Promise(r => setTimeout(r, wait));
    return speakTracked(text, prev);
  }).catch(() => {});
}

function resetSpeechStream(){
  spokenUpTo = 0; spokenChars = 0; speakPrev = '';
  lastSpeechEnd = 0;              // first filler of a run never waits
  speakChain = Promise.resolve(); speakDone = speakChain;
}

// Complete sentences waiting at the tail of `answer`, or '' if none yet.
// `final` takes whatever is left regardless of punctuation.
function takeSpeakable(final){
  const tail = answer.slice(spokenUpTo);
  if (!tail.trim()) return '';
  if (final){ spokenUpTo = answer.length; return tail; }
  const m = /^[\s\S]*[.!?…](?=[\s"')\]]|$)/.exec(tail);
  if (!m) return '';
  const chunk = m[0];
  if (chunk.trim().length < SPEECH_MIN_CHUNK) return '';   // let it grow
  spokenUpTo += chunk.length;
  return chunk;
}

function enqueueSpeech(final){
  if (!speakThisRun || muted) return;
  if (spokenChars >= SPEECH_BUDGET) return;               // long answer: read it on screen
  const chunk = takeSpeakable(final);
  if (!chunk.trim()) return;
  spokenChars += chunk.length;
  const prev = speakPrev;
  speakPrev = chunk;
  speakChain = speakChain.then(() => speakTracked(chunk, prev)).catch(() => {});
  speakDone = speakChain;
}

async function transmit(message, options = {}){
  if (!message.trim()) return;
  if (running){
    // don't silently swallow it — say so, so it never looks like nothing happened
    log('note','BUSY',`still working — "${message.slice(0,40)}" not sent. Wait, or press Esc to cancel.`);
    return;
  }
  running = true; answer = ''; firstDelta = false; speakThisRun = options.speak !== false;
  resetSpeechStream();

  const fresh = /^\/new\b/.test(message.trim());
  const id = rid();
  setState('running', 'RUNNING', id.slice(0,20) + '…');
  setTag('run', 'RUNNING');
  $('#response').innerHTML = '<span class="cur"></span>';
  log('run', 'RUN', `started ${id}; uplink cleared`);

  // visible elapsed counter — a slow answer should never look like a dead screen
  const t0 = performance.now();
  const tick = setInterval(() => {
    if (!running) return;
    const s = ((performance.now()-t0)/1000).toFixed(1);
    if (!answer) $('#strun').textContent = `thinking… ${s}s`;
  }, 200);

  try {
    activeController = new AbortController();
    const res = await fetch('/api/run', {
      method:'POST', headers:apiHeaders({'content-type':'application/json'}),
      body: JSON.stringify({message, fresh}), signal:activeController.signal
    });
    if (!res.ok) throw new Error(`backend returned HTTP ${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true){
      const {value, done} = await reader.read();
      if (done) break;
      buf += dec.decode(value, {stream:true});
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0){
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) handle(JSON.parse(line));
      }
    }
  } catch (e){
    if (e?.name === 'AbortError'){
      log('note', 'CANCEL', 'run cancelled');
      setState('', 'STANDBY', 'cancelled');
      setTag('', 'IDLE');
    } else {
      log('error', 'ERROR', String(e).slice(0,200));
      setState('error', 'FAULT', 'stream dropped');
      setTag('err', 'ERROR');
    }
  }
  activeController = null;
  running = false;
  clearInterval(tick);
  await speakDone;                 // don't return until Jarvis has finished talking
}

function handle(ev){
  switch (ev.t){
    case 'status':
      if (ev.session_id) sys('session', ev.session_id.slice(0,8));
        const msg = `core online · Hermes tools=${ev.tools ?? 0} profile=${ev.profile||'default'} permission=${ev.permission||'normal'}`;
      log('status', 'STATUS', msg);
      break;
    case 'latency':
      log('latency', 'LATENCY', `first token after ${ev.ms}ms`);
      break;
    case 'tool':
      if (ev.phase === 'use')
        log('tool', 'TOOL', `→ ${ev.name}(${ev.input || ''})`);
      else
        log('tool', 'TOOL', `✓ ${ev.ok===false?'error':'ok'}`);
      break;
    case 'say':
      // Spoken immediately, bypassing the sentence buffer. Used for "let me look
      // that up" while a tool call runs -- it is only useful if it lands BEFORE
      // the answer, and it is far too short to survive SPEECH_MIN_CHUNK.
      answer += ev.text;
      renderAnswer();
      log('voice', 'SAY', ev.text.trim());
      if (speakThisRun && !muted){
        spokenUpTo = answer.length;        // already handled; never speak it twice
        spokenChars += ev.text.length;
        const prevSaid = speakPrev;
        speakPrev = ev.text;
        speakDone = speakFiller(ev.text, prevSaid);
      }
      break;
    case 'delta':
      answer += ev.text;
      renderAnswer();
      if (!firstDelta){
        firstDelta = true;
        log('reason', 'REASONING', answer.slice(0, 220));
      }
      enqueueSpeech(false);
      break;
    case 'usage':
      log('status', 'COMPLETE', 'run completed', usageBlock(ev));
      break;
    case 'complete':
      setState('done', 'COMPLETE', (ev.ms!=null?`${ev.ms}ms`:'') );
      setTag('done', 'COMPLETE');
      log('complete', 'COMPLETE', ev.ms!=null?`run completed in ${ev.ms}ms`:'run completed');
      renderAnswer(true);
      enqueueSpeech(true);            // speak whatever is left; earlier sentences are already out
      break;
    case 'error':
      setState('error', 'FAULT', ev.message?.slice(0,40) || 'error');
      setTag('err', 'ERROR');
      log('error', 'ERROR', ev.message || 'unknown');
      // show it in the panel too, so a failure isn't a silent empty box
      if (!answer) $('#response').innerHTML =
        `<span style="color:var(--red)">⚠ ${esc(ev.message || 'Run failed.')}</span>`;
      else renderAnswer(true);
      break;
    case 'note':
      log('note', 'NOTE', ev.message || '');
      break;
  }
}

function renderAnswer(finaldone){
  const el = $('#response');
  el.innerHTML = esc(answer) + (finaldone ? '' : '<span class="cur"></span>');
  el.scrollTop = el.scrollHeight;
}

function cleanForSpeech(text){
  return String(text || '')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !/^(session_id:|session:|duration:|messages:|query:|initializing agent|resume this session|hermes --resume|[-─=]{3,})/i.test(line))
    .join(' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_#>`]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/* ══════════ continuous voice conversation ══════════
   Click VOICE once. From then on: listen → you stop → transcribe → Jarvis
   answers and speaks → it listens again, automatically. No re-clicking between
   turns. Click VOICE again (or press Esc) to end the conversation.

   The mic is deliberately DEAF while Jarvis is thinking or speaking (`suppress`)
   — otherwise it transcribes his own voice through the speakers and talks to
   itself forever. That's why re-arming happens only after he finishes. */
// Spoken commands that end the conversation immediately. Matched on the
// transcript BEFORE the agent ever sees it, so sleeping never waits on Hermes
// and never depends on the model choosing to cooperate. The follow-up window
// stays 8s for natural pauses -- this is the deliberate way out of it.
// Two classes, because the cost of getting this wrong is lopsided: a missed
// sleep leaves Casey shouting at a machine that will not stop, while a false
// sleep costs him saying "Hey JARVIS" once. Bias hard toward sleeping.
//
// HARD - matched ANYWHERE in the utterance. Nobody says "go to sleep" to an
// assistant except as an order, so it does not need to be the whole sentence.
// This is the case that failed him: the phrase arrived mid-rant, buried in
// other words, and a whole-utterance match ignored it.
const SLEEP_HARD = /\b(?:go\s+(?:back\s+)?to\s+sleep|goto\s+sleep|stand\s+down|stop\s+listening|shut\s+up|be\s+quiet|dismissed|good\s*night)\b/i;

// SOFT - these DO occur in ordinary speech ("never mind that, what about..."),
// so they must be the whole utterance or its final sentence.
const SLEEP_SOFT = /^\s*(?:(?:ok(?:ay)?|alright|all\s+right|right|well|and|so|yeah|yep|yes|no|cool|great|perfect|awesome|thanks?|thank\s+you|got\s+it|sounds\s+good)[.,!?;:\s]+)*(?:hey\s+)?(?:jarvis[.,!?;:\s]*)?(?:please\s+)?(?:that(?:'|’)?s\s+all|that\s+is\s+all|never\s*mind|we(?:'|’)?re\s+done|nothing\s+else)\s*[.!,?]*\s*$/i;

// A question ABOUT sleeping is not an order to sleep.
const SLEEP_QUESTION = /\b(?:what|when|why|how|did|do|does|were|was|will|would|should)\b[^.!?]*\b(?:go\s+to\s+sleep|sleeping)\b|\?\s*$/i;

function isSleepCommand(text){
  const t = String(text || '');
  if (SLEEP_HARD.test(t) && !SLEEP_QUESTION.test(t)) return true;
  if (SLEEP_SOFT.test(t)) return true;
  const parts = t.split(/(?<=[.!?])\s+/).filter(p => p.trim());
  const last = parts[parts.length - 1];
  return !!last && SLEEP_SOFT.test(last);
}

let convo = false, suppress = false;
// Wake word. The detector lives in the Python server (browsers suspend audio in
// background tabs), so the browser's only jobs are: poll for a trigger, and mute
// the detector while a conversation is live so JARVIS never wakes on his own voice.
let wakeAvailable = false, idleTurns = 0, oneShot = false;
const IDLE_TURNS_BEFORE_SLEEP = 2;

function setWakeMute(on){
  if (!wakeAvailable) return;
  fetch('/api/wake', {method:'POST', headers:apiHeaders({'content-type':'application/json'}),
                      body: JSON.stringify({mute: !!on})}).catch(()=>{});
}

// A short two-tone chirp, generated locally. A wake word you cannot hear
// respond is indistinguishable from one that did not fire.
// chirp() rises (awake); chirp(true) falls (going to sleep) so the two are
// tellable apart without looking at the screen.
function chirp(down){
  try {
    const ctx = new (window.AudioContext||window.webkitAudioContext)();
    const now = ctx.currentTime;
    (down ? [[1320, 0], [880, .09]] : [[880, 0], [1320, .09]]).forEach(([hz, at]) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = hz;
      g.gain.setValueAtTime(0.0001, now+at);
      g.gain.exponentialRampToValueAtTime(0.18, now+at+.015);
      g.gain.exponentialRampToValueAtTime(0.0001, now+at+.10);
      o.connect(g); g.connect(ctx.destination);
      o.start(now+at); o.stop(now+at+.12);
    });
    setTimeout(() => ctx.close().catch(()=>{}), 600);
  } catch(_){}
}
let recognition = null;
let micStream=null, recorder=null, chunks=[], actx=null, analyser=null, vdata=null;
let vad=null, spoke=false, loudAt=0, turnStart=0;
let floorSum=0, floorN=0, threshold=0.02, peak=0, calibrating=true;
// How long a pause ends your turn. 900ms cut people off mid-sentence whenever
// they spelled something out, read a number, or simply thought for a moment --
// the gaps between spoken letters are longer than that. Tunable via
// JARVIS_SILENCE_MS in .env.
let SILENCE = 1400;
const MIN_TURN_MS=350, MAX_TURN_MS=18000, NO_SPEECH_MS=10000;
// After JARVIS answers he keeps listening this long for a follow-up, then sleeps.
// Long enough to carry on a conversation, short enough that the mic is not live
// in the room all day.
const FOLLOWUP_MS = 8000;
let noSpeechWindow = NO_SPEECH_MS;

// ── voice out ──
let muted = false, player = null;
function speak(text, previous){
  return new Promise(resolve => {
    text = cleanForSpeech(text);
    if (muted || !text) return resolve();
    suppress = true;
    const spoken = text.length > 700 ? text.slice(0, 680).replace(/\s+\S*$/,'') + '…' : text;
    if (!RT.tts && RT.browserTts && speechSynth){
      try{
        speechSynth.cancel();
        const u = new SpeechSynthesisUtterance(spoken);
        u.rate = 0.95; u.pitch = 0.82; u.volume = 1;
        document.body.classList.add('speaking');
        u.onend = u.onerror = () => { document.body.classList.remove('speaking'); resolve(); };
        speechSynth.speak(u);
        return;
      }catch(_){ return resolve(); }
    }
    if (!RT.tts) return resolve();
    fetch('/api/speak', {method:'POST', headers:apiHeaders({'content-type':'application/json'}),
                         body: JSON.stringify({text:spoken, previous:previous||''})})
      .then(r => r.ok ? r.blob() : Promise.reject())
      .then(blob => {
        const url = URL.createObjectURL(blob);
        if (player) player.pause();
        player = new Audio(url);
        document.body.classList.add('speaking');
        const done = () => { document.body.classList.remove('speaking');
          URL.revokeObjectURL(url); resolve(); };
        player.onended = done; player.onerror = done;
        return player.play();
      })
      .catch(() => resolve());
  });
}

// ── start / stop the whole conversation ──
async function micToggle(){
  if (convo){ stopConvo(); return; }
  // Prefer ElevenLabs server-side STT when configured. Browser STT is unreliable
  // across Chrome profiles and often fails silently; ElevenLabs receives the
  // actual microphone recording from MediaRecorder and is much more consistent.
  if (RT.stt){
    try {
      micStream = await navigator.mediaDevices.getUserMedia(
        {audio:{echoCancellation:true, noiseSuppression:true, autoGainControl:true}});
    } catch(e){ log('error','VOICE','mic blocked — allow it in the address bar'); return; }
    actx = new (window.AudioContext||window.webkitAudioContext)();
    await actx.resume();
    analyser = actx.createAnalyser(); analyser.fftSize = 1024;
    actx.createMediaStreamSource(micStream).connect(analyser);
    vdata = new Uint8Array(analyser.fftSize);
    convo = true; suppress = false; idleTurns = 0;
    setWakeMute(true);
    $('#mic').classList.add('on'); $('#mic').textContent = '● ElevenLabs Live';
    log('voice','VOICE','ElevenLabs voice conversation open · listening');
    beginTurn();
    return;
  }
  if (SpeechRecognition){
    convo = true; suppress = false; idleTurns = 0;
    setWakeMute(true);
    $('#mic').classList.add('on'); $('#mic').textContent = '● Browser Live';
    log('voice','VOICE','browser speech recognition open · listening');
    setState('listening','LISTENING','browser speech online');
    startBrowserRecognition();
    return;
  }
  log('error','VOICE','no speech recognition available — add ElevenLabs key or use Chrome browser STT');
}

function stopConvo(){
  convo = false; suppress = false; idleTurns = 0; oneShot = false;
  noSpeechWindow = NO_SPEECH_MS;
  // Wait before re-arming. Unmuting the instant playback ends lets the tail of
  // his own voice, still coming out of the speakers, score as a wake word.
  setTimeout(() => { if (!convo) setWakeMute(false); }, 1500);
  if (recognition){ try{ recognition.onend = null; recognition.stop(); }catch(_){} recognition=null; }
  if (vad){ clearInterval(vad); vad=null; }
  if (recorder && recorder.state==='recording'){ recorder._cancel=true; try{recorder.stop();}catch(_){} }
  recorder = null;
  if (player){ try{player.pause();}catch(_){} }
  if (micStream){ micStream.getTracks().forEach(t=>t.stop()); micStream=null; }
  if (actx){ actx.close().catch(()=>{}); actx=null; analyser=null; }
  document.body.classList.remove('speaking');
  $('#mic').classList.remove('on'); $('#mic').textContent = '◉ VOICE';
  log('voice','VOICE','conversation closed');
  setState('', 'STANDBY', 'awaiting uplink');
}

// ── browser speech turn ──
function startBrowserRecognition(){
  if (!convo || suppress || !SpeechRecognition) return;
  recognition = new SpeechRecognition();
  recognition.lang = 'en-US';
  recognition.interimResults = true;
  recognition.continuous = false;
  let finalText = '';
  recognition.onresult = e => {
    let interim = '';
    for (let i=e.resultIndex; i<e.results.length; i++){
      const txt = e.results[i][0].transcript;
      if (e.results[i].isFinal) finalText += txt;
      else interim += txt;
    }
    const shown = (finalText || interim || '').trim();
    if (shown) $('#strun').textContent = 'HEARD: ' + shown.slice(0,42);
  };
  recognition.onerror = e => log('error','VOICE',`browser speech: ${e.error || 'error'}`);
  recognition.onend = async () => {
    const text = finalText.trim();
    if (!convo) return;
    if (!text){ if (!suppress) setTimeout(startBrowserRecognition, 250); return; }
    log('voice','VOICE',`browser transcribed: "${text}"`);
    const armed = $('#input').dataset.cmd || '';
    const full = (armed ? armed + ' ' : '') + text;
    $('#input').value = ''; disarm();
    log('send','SEND',`auto-sent voice: ${full}`);
    await transmit(full);
    suppress = false;
    if (convo) setTimeout(startBrowserRecognition, 350);
  };
  setState('listening','LISTENING','browser speech online');
  try{ recognition.start(); }catch(e){ log('error','VOICE','speech recognition failed to start'); }
}

// ── one server-side ElevenLabs listening turn ──
function beginTurn(){
  if (!convo || suppress || !micStream) return;
  chunks = []; spoke = false; peak = 0;
  floorSum = 0; floorN = 0; calibrating = true; threshold = 0.02;
  recorder = new MediaRecorder(micStream, pickMime());
  recorder.ondataavailable = e => { if (e.data?.size) chunks.push(e.data); };
  recorder.onstop = ship;
  recorder.start(250);                          // timeslice → data flows reliably
  turnStart = loudAt = performance.now();
  setState('listening','LISTENING','listening…');
  if (!vad) vad = setInterval(vtick, 40);
}

function meter(rms){
  // live input bar in the reactor subtitle, so you can SEE it hearing you
  const n = Math.max(0, Math.min(14, Math.round(rms * 90)));
  $('#strun').textContent = 'IN ' + '▮'.repeat(n) + '▯'.repeat(14 - n);
}

function endTurn(reason){
  log('voice','VOICE',`${reason} · peak ${peak.toFixed(3)} · thr ${threshold.toFixed(3)}`);
  try { recorder.stop(); } catch(_){}           // → ship()
}

function pickMime(){
  for (const m of ['audio/webm;codecs=opus','audio/webm','audio/mp4'])
    if (window.MediaRecorder?.isTypeSupported?.(m)) return {mimeType:m};
  return undefined;
}

function vtick(){
  if (!analyser || suppress || !recorder || recorder.state!=='recording') return;
  analyser.getByteTimeDomainData(vdata);
  let s=0; for (let i=0;i<vdata.length;i++){ const v=(vdata[i]-128)/128; s+=v*v; }
  const rms = Math.sqrt(s/vdata.length);
  const t = performance.now();
  peak = Math.max(peak, rms);
  meter(rms);

  // first 300ms: measure the room's noise floor, set a threshold just above it
  if (calibrating){
    floorSum += rms; floorN++;
    if (t - turnStart > 300){
      const floor = floorSum / Math.max(1, floorN);
      threshold = Math.max(0.006, floor * 1.6 + 0.003);
      calibrating = false;
    }
    return;
  }

  if (rms > threshold){
    loudAt = t;
    if (!spoke){ spoke = true; log('voice','VOICE','speech detected'); }
  } else if (spoke && t - loudAt > SILENCE){
    return endTurn('silence');
  }

  // failsafes so it can never hang: cap the length, re-listen if no speech at all
  if (t - turnStart > MAX_TURN_MS) return endTurn('max-length');
  if (!spoke && t - turnStart > noSpeechWindow) return endTurn('no-speech');
}

async function ship(){
  const cancel = recorder?._cancel;
  const blob = new Blob(chunks, {type: recorder?.mimeType || 'audio/webm'}); chunks=[];
  if (cancel){ return; }
  // no speech heard, too short, or too small — just listen again, don't ship ambient noise
  if (!spoke || blob.size < 1400 || performance.now()-turnStart < MIN_TURN_MS){
    // Nothing said. After a couple of these, close the conversation and hand the
    // floor back to the wake word rather than holding the mic open forever.
    if ((oneShot || ++idleTurns >= IDLE_TURNS_BEFORE_SLEEP) && wakeAvailable){
      log('voice','VOICE','nothing said - back to standby, say "Hey JARVIS"');
      stopConvo();
      return;
    }
    if (convo && !suppress) beginTurn();
    return;
  }
  setState('running','TRANSCRIBING','…');
  log('voice','VOICE',`uploading ${Math.round(blob.size/1024)}KB to server STT`);
  const t0 = performance.now();
  try {
    const r = await fetch('/api/listen', {method:'POST',
      headers:apiHeaders({'content-type':blob.type||'audio/webm'}), body:blob}).then(r=>r.json());
    const text = (r.text||'').trim();
    const ms = Math.round(performance.now() - t0);
    // Scribe labels non-speech as audio events -- "(silence)", "(laughter)",
    // "[BLANK_AUDIO]". Those are not things you said and must never become a
    // prompt; sending one is how JARVIS ends up answering the empty room.
    const speech = text.replace(/[([][^)\]]{0,40}[)\]]/g, ' ').replace(/\s{2,}/g,' ').trim();
    if (!speech || !/[a-z0-9]/i.test(speech)){
      log('voice','VOICE', text ? `ignored non-speech: "${text}"` : 'nothing transcribed');
      if (convo) beginTurn(); else setState('','STANDBY','nothing heard');
      return;
    }
    if (isSleepCommand(speech)){
      log('voice','VOICE',`sleep command: "${speech}"`);
      chirp(true);
      stopConvo();
      return;
    }
    idleTurns = 0;
    log('voice','VOICE',`transcribed by ElevenLabs in ${ms}ms: "${speech}"`);
    const armed = $('#input').dataset.cmd || '';
    const full = (armed ? armed + ' ' : '') + speech;
    $('#input').value = ''; disarm();
    log('send','SEND',`auto-sent voice: ${full}`);
    await transmit(full);                       // runs, then speaks; both with mic deaf
    suppress = false;
    if (oneShot){
      // Answered. Stay open briefly for a follow-up so you can just keep talking,
      // but pause first: re-arming the instant playback ends lets the tail of his
      // own voice out of the speakers land in the next recording.
      noSpeechWindow = FOLLOWUP_MS;
      log('voice','VOICE',`listening for a follow-up (${FOLLOWUP_MS/1000}s)`);
      setTimeout(() => { if (convo && !suppress) beginTurn(); }, 700);
      return;
    }
    if (convo) beginTurn();
  } catch(e){
    log('error','VOICE','transcription failed');
    suppress = false;
    if (convo) beginTurn(); else setState('error','FAULT','transcription failed');
  }
}

// ══════════ command matrix ══════════
function disarm(){
  document.querySelectorAll('.cmd').forEach(c=>c.classList.remove('armed'));
  $('#input').dataset.cmd = '';
}
const PAYLOAD_COMMANDS = new Set(['/goal','/browser','/background','/mission','/personality']);
$('#cmds').addEventListener('click', e => {
  const b = e.target.closest('.cmd'); if (!b) return;
  const cmd = b.dataset.cmd;
  if (running){
    log('note','BUSY',`${cmd} not sent — JARVIS is still working.`);
    return;
  }

  // Every matrix button executes its base command immediately. Commands that
  // accept an argument remain armed afterwards so the next typed or spoken
  // payload is sent as `/command payload`.
  disarm();
  if (PAYLOAD_COMMANDS.has(cmd)){
    b.classList.add('armed');
    $('#input').dataset.cmd = cmd;
    $('#input').focus();
    $('#tip').textContent = `${TIPS[cmd] || cmd} The command is live and remains armed for your next payload.`;
  } else {
    $('#tip').textContent = defaultTip;
  }
  log('command', 'COMMAND', `executing ${cmd} on Hermes backend`);
  transmit(cmd, {speak: !['/tools','/commands'].includes(cmd)});
});
const TIPS = {
  '/new':'Fresh thread — clears the Hermes conversation and starts clean.',
  '/goal':'Say your standing objective, e.g. “ship the dashboard and verify tool access”.',
  '/tools':'Shows Hermes tool status from the active profile.',
  '/toolsets':'Asks Hermes to list enabled toolsets and connected tools.',
  '/browser':'Say a Chrome/browser mission, e.g. “inspect the current tab”.',
  '/background':'Say a mission, e.g. “research competitors and save a report”.',
  '/mission':'Add or read mission queue items.',
  '/personality':'Set the persona, e.g. “calm, laconic, Stark tower operator”.',
  '/kanban':'Ask about the work queue, e.g. “what’s on my board today?”.',
  '/commands':'Show all dashboard slash commands.'
};
let defaultTip = '';

// ══════════ controls ══════════
function sendFromInput(){
  const armed = $('#input').dataset.cmd || '';
  const raw = $('#input').value.trim();
  if (!raw && !armed) return;
  const full = (armed && !raw.startsWith('/')) ? `${armed} ${raw}` : (raw || armed);
  $('#input').value = ''; disarm(); $('#tip').textContent = defaultTip;
  log('send','SEND',`transmit: ${full}`);
  transmit(full);
}
$('#run').onclick = sendFromInput;
$('#mic').onclick = micToggle;
$('#showCommands').onclick = () => transmit('/commands', {speak:false});
$('#missionBtn').onclick = () => transmit('/mission');
$('#clearBtn').onclick = () => { answer=''; $('#response').innerHTML='<span class="rplaceholder">Display cleared. Standing by.</span>'; log('note','CLEAR','response panel cleared'); };
document.querySelectorAll('[data-quick]').forEach(b => b.onclick = () =>
  transmit(b.dataset.quick, {speak:false}));
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (running && activeController){
    fetch('/api/cancel', {method:'POST', headers:apiHeaders({'content-type':'application/json'}), body:'{}'}).catch(()=>{});
    activeController.abort();
    return;
  }
  if (convo) stopConvo();
});
$('#mute').onclick = () => {
  muted = !muted; const b=$('#mute');
  b.textContent = muted?'🔇':'🔊'; b.classList.toggle('on',!muted); b.classList.toggle('off',muted);
  if (muted && player) player.pause();
};
$('#input').addEventListener('keydown', e => {
  // Enter sends. Shift+Enter makes a new line. Requiring Ctrl+Enter to send is
  // the opposite of what every chat box does and reads as "the app is broken".
  if (e.key === 'Enter' && !e.shiftKey){ e.preventDefault(); sendFromInput(); }
});

// ══════════ system panel ══════════
function sys(id, val, cls){
  const el = $('#sy-' + id); if (!el) return;
  el.textContent = val; if (cls != null) el.className = cls;
}
// live clock in the system panel
setInterval(() => sys('clock', now()), 1000);

// poll for finished /background missions and report them when they land
setInterval(async () => {
  try {
    const j = await fetch('/api/jobs', {headers:apiHeaders()}).then(r => r.json());
    for (const d of (j.done || [])){
      log('complete','MISSION', `${d.mission} → ${(d.result||'').slice(0,200)}`);
      if (!running) speak(`Mission complete. ${(d.result||'').slice(0,300)}`);
    }
  } catch(_){}
}, 4000);

// poll for a wake word trigger. 500ms is well inside the pause a person leaves
// after saying "Hey JARVIS", and it is one tiny local request.
setInterval(async () => {
  if (!wakeAvailable || convo || running) return;
  try {
    const w = await fetch('/api/wake', {headers:apiHeaders()}).then(r => r.json());
    if (!w.triggered) return;
    log('voice','WAKE',`wake word detected (${(w.score||0).toFixed(2)})`);
    chirp();
    setState('listening','LISTENING','wake word - go ahead');
    oneShot = true;
    noSpeechWindow = NO_SPEECH_MS;
    micToggle();
  } catch(_){}
}, 500);

// ══════════ boot ══════════
(async () => {
  defaultTip = $('#tip').textContent;
  try {
    const s = await fetch('/api/status').then(r=>r.json());
    RT.tts = s.tts==='elevenlabs'; RT.stt = s.stt==='elevenlabs';
    RT.browserStt = !!SpeechRecognition; RT.browserTts = !!speechSynth;
    if (s.silence_ms) SILENCE = s.silence_ms;

    const port = location.port || '8730';
    sys('gw', `online · :${port}`, 'ok');
    sys('brain', s.runtime === 'hermes' ? 'Hermes Agent' : 'Hermes offline', s.runtime === 'hermes' ? 'ok' : 'warn');
    sys('voice', `${RT.stt?'ElevenLabs STT':'Browser STT'} / ${RT.tts?'ElevenLabs TTS':'Browser TTS'}`, (RT.browserStt||RT.stt) ? '' : 'warn');
    sys('profile', s.profile || 'default');
    sys('runtime', s.runtime || '—', s.runtime === 'hermes' ? 'ok' : 'warn');
    sys('clock', now());
    $('#top-gw').textContent = `Gateway: online ${location.origin}`;
    $('#top-profile').textContent = 'Profile: ' + (s.profile || 'default');
    $('#top-voice').textContent = 'Voice: ' + (RT.stt ? 'ElevenLabs STT' : (RT.browserStt ? 'browser STT' : s.stt)) + ' / ' + (RT.tts ? 'ElevenLabs TTS' : 'browser TTS');
    const tools = (s.tools || []).slice(0, 12);
    $('#toolsList').innerHTML = tools.length ? tools.map(t => `<span class="chip">${esc(t)}</span>`).join('') : '<span class="chip ghost">Hermes tool list unavailable — set HERMES_CMD if needed</span>';

    log('status', 'BOOT',
        `gateway online · ${s.runtime} core · profile=${s.profile || 'default'} · permission=${s.permission}`);
    log('voice', 'VOICE', `channel ready — ${RT.stt ? 'ElevenLabs STT' : (RT.browserStt ? 'browser STT' : s.stt)} / ${RT.tts ? 'ElevenLabs TTS' : 'browser TTS'}`);
    wakeAvailable = !!(s.wake && s.wake.running);
    if (wakeAvailable){
      setWakeMute(false);
      log('voice', 'WAKE', `standby — say "Hey JARVIS" (threshold ${s.wake.threshold})`);
      $('#top-voice').textContent += ' · wake: Hey JARVIS';
    } else if (s.wake && s.wake.enabled){
      log('error', 'WAKE', `wake word off — ${s.wake.error || 'not running'}`);
    }
    $('#mic').textContent = RT.stt ? '◉ ElevenLabs' : '◉ Voice';
    setState('', 'STANDBY', 'awaiting uplink');
  } catch(e){
    sys('gw','offline','warn');
    log('error','STATUS','server unreachable');
  }
})();


/* ── Drawer and tabs ───────────────────────────────────────────────────────
   The Action Log and Command Matrix used to be two permanent columns eating
   width the whole time. They are one drawer now: Action Log is the default
   tab, Command Matrix is a click away, and neither costs screen space while
   closed.

   The drawer opens itself when something needs eyes -- an error, or a card
   landing in needs-approval -- because a panel nobody opened is a panel that
   reports nothing. */
(function drawer(){
  const el      = document.getElementById('drawer');
  const toggle  = document.getElementById('drawerToggle');
  const closeBt = document.getElementById('drawerClose');
  if (!el || !toggle) return;

  const scrim = document.createElement('div');
  scrim.className = 'drawer-scrim';
  document.body.appendChild(scrim);

  function setOpen(open){
    document.body.classList.toggle('drawer-open', open);
    el.setAttribute('aria-hidden', String(!open));
    toggle.setAttribute('aria-expanded', String(open));
  }
  window.jarvisDrawer = { open: () => setOpen(true), close: () => setOpen(false) };

  toggle.onclick  = () => setOpen(!document.body.classList.contains('drawer-open'));
  closeBt.onclick = () => setOpen(false);
  scrim.onclick   = () => setOpen(false);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') setOpen(false);
  });

  const tabs  = [...el.querySelectorAll('.dtab')];
  const panes = [...el.querySelectorAll('.pane')];
  function show(id){
    tabs.forEach(t => {
      const on = t.dataset.panel === id;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', String(on));
    });
    panes.forEach(p => p.classList.toggle('active', p.id === id));
    // The edge tab names whatever is showing, so it is obvious what opens.
    const label = tabs.find(t => t.dataset.panel === id);
    const dt = toggle.querySelector('.dt-label');
    if (label && dt) dt.textContent = label.textContent;
  }
  tabs.forEach(t => t.onclick = () => show(t.dataset.panel));
  show('pane-log');

  /* Opening the drawer to reach the command grid and having to close it again
     is a click nobody wants. Firing a command closes it. */
  el.querySelectorAll('.cmd, .miniBtns button').forEach(b => {
    b.addEventListener('click', () => setOpen(false));
  });
})();

/* ── Mission board ─────────────────────────────────────────────────────────
   Reads hermes/kanban.db through /api/board. Three verdicts, and a preview
   that opens IN the board.

   The rule the whole thing hangs on, from Casey: you cannot approve what you
   cannot see. OpenMontage's failures are silent -- black video, muted audio,
   lost subject, every one reported as success. A board where somebody clicks
   Approve without opening the file is worse than no board, because it launders
   a broken output as reviewed. So a card with nothing to show says so, and its
   Approve button is disabled rather than defaulted. */
(function board(){
  const cols = ['todo','in_process','needs_approval','final_review','complete'];
  const src  = document.getElementById('boardSource');
  if (!src) return;

  const box = document.createElement('div');
  box.className = 'lightbox';
  box.innerHTML = '<div class="lb-inner"><button class="lb-close" title="Close">✕</button>'
                + '<div class="lb-title"></div><div class="lb-stage"></div>'
                + '<div class="lb-verdict"></div></div>';
  document.body.appendChild(box);
  const stage = box.querySelector('.lb-stage');
  const title = box.querySelector('.lb-title');
  const verdictRow = box.querySelector('.lb-verdict');

  function shut(){
    box.classList.remove('open');
    stage.innerHTML = '';          // stop any video that is still playing
    verdictRow.innerHTML = '';
    dropBlobs();
  }
  box.querySelector('.lb-close').onclick = shut;
  box.addEventListener('click', e => { if (e.target === box) shut(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') shut(); });

  /* The attachment route wants the token as a header, and an <img> tag cannot
     send one. Putting the token in the URL instead would leak it into history,
     logs and any screen share -- so the bytes are fetched and handed to the
     element as a blob. Revoked on close so a long session does not hold every
     video it has ever previewed in memory. */
  let blobUrls = [];
  function dropBlobs(){ blobUrls.forEach(URL.revokeObjectURL); blobUrls = []; }

  async function attachmentUrl(id){
    const r = await fetch('/api/board/attachment/' + encodeURIComponent(id), {headers: apiHeaders()});
    if (!r.ok) throw new Error('attachment unavailable');
    const u = URL.createObjectURL(await r.blob());
    blobUrls.push(u);
    return u;
  }

  async function renderPreview(p){
    if (!p || p.kind === 'none'){
      return `<div class="lb-blocked">${esc(p && p.blocked || 'Nothing to review on this card.')}</div>`;
    }
    if (p.kind === 'image' || p.kind === 'video'){
      try {
        const u = await attachmentUrl(p.attachment_id);
        return p.kind === 'image'
          ? `<img src="${u}" alt="${esc(p.label||'')}">`
          : `<video src="${u}" controls autoplay></video>`;
      } catch(e){
        // A preview that fails to load is not a preview. Say so plainly rather
        // than showing a broken frame next to an Approve button.
        return `<div class="lb-blocked">The file on this card could not be loaded, so there is nothing to review. Approving it would sign off on something nobody has seen.</div>`;
      }
    }
    if (p.kind === 'url')   return `<div class="lb-url"><a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.label||p.url)} ↗</a>`
                                 + `<iframe src="${esc(p.url)}" sandbox="allow-scripts allow-same-origin"></iframe></div>`;
    if (p.kind === 'text')  return `<div class="lb-copy">${esc(p.text)}</div>`;
    return '';
  }

  async function decide(taskId, verdict, note){
    const r = await fetch('/api/board/decide', {
      method:'POST', headers: apiHeaders({'content-type':'application/json'}),
      body: JSON.stringify({task_id: taskId, verdict, note: note || null})
    });
    const b = await r.json().catch(()=>({}));
    if (!r.ok || !b.ok){ alert(b.error || 'could not record that'); return false; }
    log('complete','BOARD', `${verdict.replace(/_/g,' ')} — ${taskId}`);
    shut(); load();
    return true;
  }

  async function openCard(card){
    title.textContent = card.title;
    stage.innerHTML = '<div class="lb-blocked">loading…</div>';
    box.classList.add('open');
    stage.innerHTML = await renderPreview(card.preview);
    // Blocked covers both "no output at all" and "the output would not load".
    const blocked = !!stage.querySelector('.lb-blocked');

    verdictRow.innerHTML =
        `<input class="lb-note" id="lbNote" placeholder="What needs changing? (required to reject with changes)">`
      + `<div class="lb-btns">`
      + `<button class="vb ok" ${blocked ? 'disabled title="Nothing to look at — approving this would sign off on something nobody has seen"' : ''}>Approve</button>`
      + `<button class="vb warn">Reject with changes</button>`
      + `<button class="vb bad">Reject</button>`
      + `</div>`;

    const note = () => (document.getElementById('lbNote').value || '').trim();
    const [ok, chg, bad] = verdictRow.querySelectorAll('.vb');
    ok.onclick  = () => { if (!blocked) decide(card.id, 'approve', note()); };
    chg.onclick = () => {
      if (!note()){ document.getElementById('lbNote').focus(); return; }
      decide(card.id, 'reject_with_changes', note());
    };
    bad.onclick = () => decide(card.id, 'reject', note());
  }

  function cardHtml(c, pickable){
    const meta = [];
    if (c.agent)  meta.push(`<span class="kind">${esc(c.agent)}</span>`);
    if (c.client) meta.push(`<span class="client">${esc(c.client)}</span>`);
    const k = c.preview && c.preview.kind;
    if (k === 'image') meta.push('<span>image</span>');
    if (k === 'video') meta.push('<span>video</span>');
    if (k === 'url')   meta.push('<span>staging</span>');
    if (k === 'none')  meta.push('<span class="nope">nothing to view</span>');
    const title = pickable
      ? `<div class="pick"><input type="checkbox" class="cpick" data-id="${esc(c.id)}"><div class="ct">${esc(c.title)}</div></div>`
      : `<div class="ct">${esc(c.title)}</div>`;
    return `<div class="card" data-id="${esc(c.id)}">${title}`
         + (meta.length ? `<div class="cm">${meta.join('')}</div>` : '') + `</div>`;
  }

  let cache = {};
  async function load(){
    try {
      const r = await fetch('/api/board', {headers: apiHeaders()});
      const b = await r.json();
      if (!b.ok){ src.textContent = b.error || 'board unavailable'; return; }
      cache = {};
      let total = 0;
      for (const col of cols){
        const items = b.columns[col] || [];
        items.forEach(c => cache[c.id] = c);
        total += items.length;
        document.getElementById('col-' + col).innerHTML =
          items.map(c => cardHtml(c, col === 'complete')).join('');
        document.getElementById('c-' + col).textContent = items.length;
      }
      src.textContent = total ? `kanban.db · ${total} card${total===1?'':'s'}` : 'kanban.db · empty';
      document.querySelectorAll('.bcol-body .card').forEach(el => {
        el.onclick = e => {
          // The checkbox is for selecting, not for opening. Let it be itself.
          if (e.target.classList.contains('cpick')) return;
          const c = cache[el.dataset.id]; if (c) openCard(c);
        };
      });
      wirePicks();
      const n = b.archived || 0;
      archCount.textContent = n ? `(${n})` : '';
    } catch(e){
      src.textContent = 'board unreachable';
    }
  }

  /* ── Archive ────────────────────────────────────────────────────────────
     Complete fills up and stops being readable, but deleting the record of
     what was approved would throw away the only evidence of what shipped and
     why. So archiving is a status change: the card keeps its comments,
     attachments and history, and comes back if it is needed. */
  const archiveBtn = document.getElementById('archiveBtn');
  const selAll     = document.getElementById('selAllComplete');
  const archCount  = document.getElementById('archiveCount');
  const viewArch   = document.getElementById('viewArchive');

  function picked(){
    return [...document.querySelectorAll('#col-complete .cpick:checked')].map(i => i.dataset.id);
  }
  function syncPickUi(){
    const boxes = [...document.querySelectorAll('#col-complete .cpick')];
    const on = picked();
    archiveBtn.disabled = on.length === 0;
    archiveBtn.textContent = on.length ? `Archive ${on.length}` : 'Archive';
    selAll.checked = boxes.length > 0 && on.length === boxes.length;
    boxes.forEach(b => b.closest('.card').classList.toggle('picked', b.checked));
  }
  function wirePicks(){
    document.querySelectorAll('#col-complete .cpick').forEach(b => {
      b.onchange = syncPickUi;
    });
    syncPickUi();
  }
  selAll.onchange = () => {
    document.querySelectorAll('#col-complete .cpick').forEach(b => b.checked = selAll.checked);
    syncPickUi();
  };
  archiveBtn.onclick = async () => {
    const ids = picked();
    if (!ids.length) return;
    const r = await fetch('/api/board/archive', {
      method:'POST', headers: apiHeaders({'content-type':'application/json'}),
      body: JSON.stringify({task_ids: ids})
    });
    const b = await r.json().catch(()=>({}));
    if (!r.ok || !b.ok){ alert(b.error || 'could not archive'); return; }
    log('complete','BOARD', `archived ${b.archived.length} card${b.archived.length===1?'':'s'}`);
    if ((b.refused || []).length) alert(b.refused.map(x => `${x.id}: ${x.why}`).join('\n'));
    selAll.checked = false;
    load();
  };

  viewArch.onclick = async () => {
    title.textContent = 'Archive';
    stage.innerHTML = '<div class="lb-blocked">loading…</div>';
    verdictRow.innerHTML = '';
    box.classList.add('open');
    const r = await fetch('/api/board/archive', {headers: apiHeaders()});
    const b = await r.json().catch(()=>({}));
    if (!b.ok){ stage.innerHTML = `<div class="lb-blocked">${esc(b.error||'archive unavailable')}</div>`; return; }
    if (!b.cards.length){ stage.innerHTML = '<div class="arch-empty">Nothing archived yet.</div>'; return; }
    stage.innerHTML = '<div class="arch-list">' + b.cards.map(c =>
      `<div class="arch-row"><div class="at">${esc(c.title)}</div>`
      + `<div class="am">${esc(c.client || '')}</div>`
      + `<button class="ctl aux" data-restore="${esc(c.id)}">Restore</button></div>`).join('') + '</div>';
    stage.querySelectorAll('[data-restore]').forEach(btn => {
      btn.onclick = async () => {
        await fetch('/api/board/unarchive', {
          method:'POST', headers: apiHeaders({'content-type':'application/json'}),
          body: JSON.stringify({task_ids:[btn.dataset.restore]})
        });
        log('status','BOARD', `restored ${btn.dataset.restore}`);
        btn.closest('.arch-row').remove();
        load();
      };
    });
  };

  load();
  setInterval(load, 15000);
  window.jarvisBoard = { reload: load };
})();
