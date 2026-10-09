const $ = id => document.getElementById(id);
let targets = [], turns = [], selected = '', sending = false, lastTurns = '', lastTargets = '', playing, playingUrl, refreshBusy = false;
let followRequest;
let speechController, playingTurn = '', playback = 0;
const labels = { queued:'Queued',transcribing:'Transcribing',dispatching:'Sending',working:'Working',done:'Ready',needs_attention:'Needs you',uncertain:'Check delivery',failed:'Failed' };
function el(tag, text, cls) { const node = document.createElement(tag); if(text !== undefined) node.textContent = text; if(cls) node.className = cls; return node; }
async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'Content-Type':'application/json', ...options.headers } });
  if(!response.ok) { const body = await response.json().catch(()=>({})); const error = new Error(body.error || 'Request failed ('+response.status+').'); error.status=response.status; throw error; }
  return response.json();
}
function choose(id) {
  selected = id; renderTargets();
  const target = targets.find(t=>t.id===id);
  $('watch-character').className='companion '+(target?.character||'codex');
  $('watch-agent').textContent = target?.name || 'Maestro';
  $('watch-caption').textContent = !target ? 'Select an agent to begin.' : target.available ? 'Hold to speak.\nRelease to send.' : 'Check this agent on your Mac before sending.';
  $('recipient').textContent = target ? 'To '+target.name : 'Select a conversation';
  $('send').disabled = !target?.available || sending;
  renderWatch();
}
function renderTargets() {
  const signature=JSON.stringify([targets,selected]); if(signature===lastTargets)return;lastTargets=signature;
  const focused=document.activeElement?.dataset.target;
  const list=$('agents'); list.replaceChildren();
  if(!targets.length) {
    const note=el('div',undefined,'setup-note');
    note.append(el('strong','No bridge conversations yet'),el('span','Start a Herdr session or connect a Grok Bot routine. Muse connects on the StopWatch.'));
    list.append(note); return;
  }
  for(const target of targets) {
    const row=el('button',undefined,'agent'+(selected===target.id?' selected':'')); row.type='button';
    row.dataset.target=target.id;
    row.setAttribute('aria-pressed',String(selected===target.id));
    const character=el('span',undefined,'companion '+(target.character||'pi'));character.setAttribute('aria-hidden','true');character.append(el('i'),el('i'),el('b'));row.append(character);
    const meta=el('span',undefined,'agent-meta'); meta.append(el('span',target.name,'agent-name'),el('span',target.detail||'Existing session','agent-detail'));
    row.append(meta,el('span',target.status==='new'?'New session':labels[target.status]||target.status,'agent-status'));
    row.addEventListener('click',()=>choose(target.id)); list.append(row);
  }
  if(focused) [...list.children].find(row=>row.dataset.target===focused)?.focus();
}
function pcmWav(pcm) {
  const bytes=new Uint8Array(44+pcm.byteLength), view=new DataView(bytes.buffer);
  const str=(offset,s)=>{for(let i=0;i<s.length;i++)bytes[offset+i]=s.charCodeAt(i);};
  str(0,'RIFF');view.setUint32(4,36+pcm.byteLength,true);str(8,'WAVEfmt ');
  view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);
  view.setUint32(24,16000,true);view.setUint32(28,32000,true);view.setUint16(32,2,true);view.setUint16(34,16,true);
  str(36,'data');view.setUint32(40,pcm.byteLength,true);bytes.set(new Uint8Array(pcm),44);return bytes;
}
function stopSpeech() {
  playback++;speechController?.abort();speechController=null;
  if(playing){playing.pause();playing=null;}if(playingUrl){URL.revokeObjectURL(playingUrl);playingUrl=null;}
  document.querySelectorAll('[data-voice]').forEach(b=>{b.textContent='Listen';});playingTurn='';
}
async function listen(text, button, turnId) {
  const stop=playingTurn===turnId;stopSpeech();if(stop)return;
  playingTurn=turnId;const generation=playback;speechController=new AbortController();button.textContent='Cancel voice';
  try {
    const response=await fetch('/api/speech',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text,format:'pcm'}),signal:speechController.signal});
    if(!response.ok) throw new Error('Speech is unavailable. Your text reply is still here.');
    const pcm=await response.arrayBuffer();if(generation!==playback)return;
    const url=URL.createObjectURL(new Blob([pcmWav(pcm)],{type:'audio/wav'}));
    playingUrl=url;playing=new Audio(url);playing.onended=()=>{if(generation===playback)stopSpeech();};
    playing.onerror=()=>{if(generation===playback){$('error').textContent='Playback stopped. Your text reply is still here.';stopSpeech();}};
    document.querySelectorAll('[data-voice]').forEach(b=>{if(b.dataset.voice===turnId)b.textContent='Stop';});
    await playing.play();
  } catch(e) { if(generation===playback){if(e.name!=='AbortError')$('error').textContent=e.message;stopSpeech();} }
}
function renderTurns() {
  const signature=JSON.stringify(turns); if(signature===lastTurns)return;lastTurns=signature;
  const list=$('activity');list.replaceChildren();$('activity-count').textContent=turns.length?String(turns.length):'';
  if(!turns.length)list.append(el('p','Your requests and replies will appear here.','empty'));
  for(const turn of turns) {
    const card=el('article',undefined,'turn'),head=el('div',undefined,'turn-heading');
    head.append(el('strong',turn.target.name),el('span',labels[turn.state]||turn.state,'state-'+turn.state));card.append(head);
    card.append(el('p',turn.text||'Voice message'));
    if(turn.reply){card.append(el('p',turn.reply,'reply'));const b=el('button',playingTurn===turn.id?(playing?'Stop':'Cancel voice'):'Listen','listen');b.dataset.voice=turn.id;b.onclick=()=>listen(turn.reply,b,turn.id);card.append(b);}
    if(turn.output){const d=el('details'),summary=el('summary','Latest terminal output');d.append(summary,el('pre',turn.output));card.append(d);}
    if(turn.error)card.append(el('p',turn.error,'error'));
    list.append(card);
  }
  renderWatch();
}
function renderWatch() {
  const target=targets.find(t=>t.id===selected);
  const current=turns.find(t=>t.target.id===selected);
  $('watch-state').textContent=(target&&!target.available?(labels[target.status]||target.status):current?(labels[current.state]||current.state):'READY').toUpperCase();
}
async function refresh() {
  if(refreshBusy)return;refreshBusy=true;
  try {
    const [agents,activity]=await Promise.all([api('/api/targets'),api('/api/turns')]);
    targets=agents.targets;turns=activity.turns;
    if(followRequest&&selected===followRequest.target){
      const created=turns.find(t=>t.id===followRequest.id);
      if(created&&created.target.id!==selected&&targets.some(t=>t.id===created.target.id)){
        choose(created.target.id);followRequest=null;
      }
    }
    renderTargets();
    if(selected&&!targets.some(t=>t.id===selected))choose('');
    if(selected) choose(selected);
    $('send').disabled=sending||!targets.find(t=>t.id===selected)?.available;
    $('warnings').replaceChildren(...agents.warnings.map(w=>el('p',w)));
    renderTurns();renderWatch();$('connection').textContent='Bridge connected';
  }catch(e){$('connection').textContent='Bridge offline';$('error').textContent=e.message;}
  finally{refreshBusy=false;}
}
$('composer').addEventListener('submit',async event=>{
  event.preventDefault();if(sending||!selected)return;
  const text=$('message').value.trim();if(!text)return;
  const target=selected,id=crypto.randomUUID();sending=true;$('send').disabled=true;$('error').textContent='';
  followRequest=target.startsWith('new:')?{id,target}:null;
  try{
    await api('/api/turns',{method:'POST',body:JSON.stringify({id,target,text})});
    $('message').value='';await refresh();
  }catch(e){
    if(e.status>=400&&e.status<500){$('error').textContent=e.message;return;}
    // A failed connection may hide a successful submission. Query the receipt, never replay.
    try{const receipt=await api('/api/turns/'+id);if(receipt){$('message').value='';await refresh();}}
    catch{$('error').textContent=e.message+' Delivery may be unclear. Check recent activity before sending again.';}
  }finally{sending=false;$('send').disabled=!targets.find(t=>t.id===selected)?.available;}
});
$('refresh').addEventListener('click',refresh);
void refresh();setInterval(refresh,3000);
