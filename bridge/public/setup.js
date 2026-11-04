const $ = id => document.getElementById(id);
let state, remoteState, busy = false, port = '', lastPorts = '', lastWifi = '';
async function api(path, body) {
  const response = await fetch(path, body ? {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)} : {});
  const value = await response.json(); if(!response.ok) throw new Error(value.error || 'Could not complete this step.'); return value;
}
function show(step, focus = true) {
  if(!['device','wifi','agents','ready'].includes(step))return;
  document.querySelectorAll('[data-panel]').forEach(p=>p.hidden=p.dataset.panel!==step);
  document.querySelectorAll('[data-step]').forEach(b=>b.dataset.step===step?b.setAttribute('aria-current','step'):b.removeAttribute('aria-current'));
  $('setup-error').textContent='';
  if(!busy)$('setup-message').textContent='';
  history.replaceState(null,'','#'+step);
  const panel=document.querySelector(`[data-panel="${step}"]`);
  if(focus){panel.querySelector('h2')?.focus({preventScroll:true});window.scrollTo({top:0,behavior:'auto'});}
  if(focus&&!matchMedia('(prefers-reduced-motion: reduce)').matches){
    const animations=panel.getAnimations(),style=getComputedStyle(panel);
    const start=animations.length?{transform:style.transform,opacity:style.opacity}:{transform:'translateY(5px)',opacity:.85};
    animations.forEach(animation=>animation.cancel());
    panel.animate([start,{transform:'translateY(0)',opacity:1}],{duration:220,easing:'cubic-bezier(.22,.8,.24,1)'});
  }
  if(step==='wifi')void checkRemote();
}
function lock(on) {
  busy=on;
  document.querySelector('.setup-workspace').setAttribute('aria-busy',String(on));
  document.querySelectorAll('.setup-workspace button,.setup-workspace input,.setup-workspace select').forEach(e=>e.disabled=on);
  if(!on)render();
}
function render() {
  if(!state){
    for(const id of ['port','inspect','install','device-next','sync-device','verify','open-agents','check-pair','wifi-submit'])$(id).disabled=true;
    document.querySelectorAll('#voice-form button').forEach(button=>button.disabled=true);
    return;
  }
  const signature=JSON.stringify(state.ports);
  if(signature!==lastPorts){
    lastPorts=signature; $('port').replaceChildren();
    const empty=new Option(state.ports.length?'Choose your USB device':'No USB device found','');$('port').add(empty);
    state.ports.forEach(p=>$('port').add(new Option(p.name+' ('+(p.serial||p.port.split('/').pop())+')',p.port)));
    if(state.ports.some(p=>p.port===port))$('port').value=port;
    else if(state.ports.length===1){port=state.ports[0].port;$('port').value=port;}
  }
  const d=state.device?.port===port ? state.device : null;
  $('port').disabled=busy||!state.ports.length;
  $('device-state').textContent=d?(d.maestro.version>=2?'Maestro installed':'Firmware update required'):'';
  $('device-state').classList.toggle('verified',!!d&&d.maestro.version>=2);
  $('usb-help').hidden=!!port;
  $('preview-device-name').textContent=d?.name||'M5Stack StopWatch';
  $('preview-device-state').textContent=d?'USB connected':port?'Not checked':'Not connected';
  document.querySelector('[data-step="device"]').dataset.complete=String(!!d&&d.maestro.version>=2);
  document.querySelector('[data-step="wifi"]').dataset.complete=String(d?.wifi.state==='connected');
  $('device-next').disabled=busy||!d||d.maestro.version<2;
  $('wifi-submit').disabled=busy||!d||d.maestro.version<2;
  $('install-area').hidden=!port||!state.firmware;
  $('firmware-missing').hidden=state.firmware;
  $('install').disabled=busy||!$('confirm-model').checked;
  $('inspect').disabled=busy||!port;
  $('wifi-state').textContent=d?.wifi.state==='connected'?'Connected to '+d.wifi.ssid:d?'Not connected':'Connect over USB to check Wi-Fi.';
  $('wifi-state').classList.toggle('verified',d?.wifi.state==='connected');
  $('keep-wifi').hidden=d?.wifi.state!=='connected';
  const wifiSignature=JSON.stringify([port,d?.wifi.state,d?.wifi.ssid]);
  if(wifiSignature!==lastWifi){lastWifi=wifiSignature;$('wifi-change').open=d?.wifi.state!=='connected';}
  $('wifi-change-label').textContent=d?.wifi.state==='connected'?'Change network':'Choose a Wi-Fi network';
  $('wifi-submit').classList.toggle('secondary',d?.wifi.state==='connected');
  $('muse-state').textContent=d?.link.paired?'Paired':state.muse?'Token saved':'Add token';
  $('muse-device').textContent=d?.name||'your StopWatch';
  $('muse-form').querySelector('button').textContent=state.muse?'Replace token':'Save token';
  $('grok-state').textContent=state.grok?'Routine saved':'Connect routine';
  if(!$('voice').options.length)(state.voices||[]).forEach(v=>$('voice').add(new Option(v.name,v.id)));
  if(!$('voice').dataset.edited)$('voice').value=state.voice;
  $('voice-state').textContent=(state.voices||[]).find(v=>v.id===state.voice)?.name||'Local speech';
  $('sync-device').disabled=busy||!d||d.maestro.version<2;
  $('sync-device').title=state.remote?'Saves the remote connection and Muse token to the StopWatch.':'Saves the local connection and Muse token to the StopWatch.';
  $('check-pair').disabled=busy||!port;
  $('verify').disabled=busy||!port;
  $('open-agents').disabled=busy||!d?.maestro.bridge;
  if(!$('project-path').value&&state.projects[0]){$('project-path').value=state.projects[0].path;$('project-name').value=state.projects[0].name;$('project-trusted').checked=state.projects[0].trusted===true;}
  $('ready-checks').replaceChildren();
  for(const [name,value] of [['Device',d?'Connected over USB':'Connect USB to check'],['Wi-Fi',!d?'Not checked':d.wifi.state==='connected'?d.wifi.ssid:'Not connected'],['Mac bridge',!d?'Not checked':d.maestro.bridge?'Connected':'Not connected'],['Muse',!d?'Not checked':d.link.paired?'Paired':'Not paired'],['On the screen',d?.maestro.name||'Not checked']]){
    const row=document.createElement('p'),label=document.createElement('strong'),text=document.createElement('span');label.textContent=name;text.textContent=value;row.append(label,text);$('ready-checks').append(row);
  }
  renderRemote();
}
function renderRemote(){
  if(!remoteState)return;
  $('remote-state').textContent=remoteState.message;
  $('remote-install').hidden=remoteState.installed;
  $('remote-enable').hidden=!remoteState.installed;
  $('remote-enable').disabled=busy||!remoteState.connected;
  $('remote-enable').textContent=remoteState.enabled&&remoteState.available?'Verify remote access':'Enable remote access';
  $('remote-disable').hidden=!remoteState.enabled&&!remoteState.available;
  $('remote-approve').hidden=!remoteState.approvalUrl;
  if(remoteState.approvalUrl)$('remote-approve').href=remoteState.approvalUrl;
  $('remote-address').hidden=!remoteState.url;
  $('remote-address').textContent=remoteState.url||'';
}
async function checkRemote(){try{remoteState=await api('/api/setup/remote');renderRemote();}catch{$('remote-state').textContent='Could not check remote access. Try again.';}}
$('remote-check').onclick=()=>run(checkRemote);
for(const action of ['enable','disable'])$('remote-'+action).onclick=()=>run(async()=>{
  $('remote-state').textContent=action==='enable'?'Checking the secure connection…':'Turning off remote access…';
  remoteState=await api('/api/setup/remote',{action});await refresh();renderRemote();
});
async function refresh(){
  try{state=await api('/api/setup');render();}
  catch(error){
    if(!state){$('port').replaceChildren(new Option('Could not check USB devices',''));$('device-state').textContent='Refresh to try again.';$('usb-help').hidden=true;}
    throw error;
  }
}
async function run(fn,errorId='setup-error'){
  if(busy)return;
  const focused=document.activeElement;
  const errorNode=$(errorId);
  lock(true);$('setup-error').textContent='';errorNode.textContent='';
  if(errorId!=='setup-error')errorNode.classList.remove('error');
  try{await fn();}catch(e){errorNode.textContent=e.message;errorNode.classList.add('error');errorNode.scrollIntoView({block:'nearest'});}
  finally{
    lock(false);
    if(document.activeElement===document.body&&focused?.isConnected&&!focused.disabled&&focused.getClientRects().length)focused.focus({preventScroll:true});
  }
}
async function operation(action,fields={}){
  if(!port)throw new Error('Connect and choose your StopWatch first.');
  const job=await api('/api/setup/device',{action,port,...fields});
  $('setup-message').textContent=job.message;
  for(;;){
    await new Promise(resolve=>setTimeout(resolve,900));await refresh();
    const current=state.job;
    if(!current||current.id!==job.id)throw new Error('The app restarted. Check the device before trying again.');
    $('setup-message').textContent=current.message;
    if(current.state==='failed'){$('setup-message').textContent='';throw new Error(current.message);}
    if(current.state==='done')return current.result;
  }
}
document.querySelectorAll('[data-step]').forEach(b=>b.onclick=()=>show(b.dataset.step));
document.querySelectorAll('[data-back]').forEach(b=>b.onclick=()=>show(b.dataset.back));
$('port').onchange=()=>{port=$('port').value;render();};
$('confirm-model').onchange=render;
$('scan').onclick=()=>run(refresh);
$('inspect').onclick=()=>run(async()=>{await operation('inspect');});
$('install').onclick=()=>run(async()=>{await operation('install',{confirmStopWatch:$('confirm-model').checked});$('setup-message').textContent='Installed. Waiting for the device to restart…';await new Promise(r=>setTimeout(r,6000));await operation('inspect');});
$('device-next').onclick=()=>show('wifi');
$('keep-wifi').onclick=()=>show('agents');
$('wifi-form').onsubmit=e=>{e.preventDefault();void run(async()=>{await operation('wifi',{ssid:$('ssid').value,password:$('wifi-password').value});$('wifi-password').value='';show('agents');});};
$('muse-form').onsubmit=e=>{e.preventDefault();void run(async()=>{await api('/api/setup/agents',{muse:$('muse-token').value.trim()});$('muse-token').value='';await refresh();$('setup-message').textContent='Muse token saved. Choose Save and restart to apply it.';});};
$('grok-form').onsubmit=e=>{e.preventDefault();void run(async()=>{await api('/api/setup/agents',{grok:{webhook:$('grok-url').value.trim(),key:$('grok-key').value.trim()}});$('grok-key').value='';$('grok-url').value='';await refresh();$('setup-message').textContent='Grok Bot saved.';});};
$('project-form').onsubmit=e=>{e.preventDefault();void run(async()=>{await api('/api/setup/agents',{project:{name:$('project-name').value.trim(),path:$('project-path').value.trim(),trusted:$('project-trusted').checked}});await refresh();$('setup-message').textContent='Project saved.';});};
$('project-path').oninput=()=>{$('project-trusted').checked=false;};
$('voice').onchange=()=>{$('voice').dataset.edited='true';};
$('voice-form').onsubmit=e=>{e.preventDefault();void run(async()=>{await api('/api/setup/agents',{voice:$('voice').value});delete $('voice').dataset.edited;await refresh();$('voice-message').textContent='Voice saved.';},'voice-message');};
let previewUrl;
$('voice-preview').onclick=()=>run(async()=>{
  const audio=$('voice-audio');audio.pause();$('voice-message').textContent='Preparing voice…';
  const response=await fetch('/api/speech',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:'This is a preview of the selected voice.',format:'mp3',voice:$('voice').value})});
  if(!response.ok)throw new Error('Voice preview is unavailable. Please try again.');
  const blob=await response.blob();if(previewUrl)URL.revokeObjectURL(previewUrl);
  previewUrl=URL.createObjectURL(blob);audio.src=previewUrl;audio.hidden=false;await audio.play();$('voice-message').textContent='Previewing '+$('voice').selectedOptions[0].textContent;
},'voice-message');
$('check-pair').onclick=()=>run(async()=>{await operation('inspect');$('setup-message').textContent=state.device?.link.paired?'Muse is paired.':'Pair your StopWatch in the Muse phone app, then check again.';});
$('sync-device').onclick=()=>run(async()=>{await operation('configure');show('ready');$('setup-message').textContent='Saved. Waiting for Wi-Fi and the Mac connection…';await new Promise(r=>setTimeout(r,15000));await operation('inspect');});
$('verify').onclick=()=>run(async()=>{await operation('inspect');});
$('open-agents').onclick=()=>run(async()=>{await operation('agents');});
if(window.webkit?.messageHandlers?.chooseFolder){$('choose-folder').hidden=false;$('choose-folder').onclick=()=>window.webkit.messageHandlers.chooseFolder.postMessage({});window.maestroFolder=path=>{$('project-path').value=path;$('project-trusted').checked=false;if(!$('project-name').value)$('project-name').value=path.split('/').pop();};}
function codingJob(job){
  $('agent-progress').hidden=!job;
  if(!job)return;
  $('agent-message').textContent=job.message;$('agent-cancel').hidden=job.state!=='working';$('agent-cancel').disabled=false;
  $('agent-login').hidden=!job.url;if(job.url)$('agent-login').href=job.url;
  $('agent-code').textContent=job.code?'Enter code: '+job.code:'';
}
async function setupAgent(kind,action){await run(async()=>{
  codingJob(await api('/api/setup/coding',{kind,action}));
  for(;;){await new Promise(r=>setTimeout(r,1500));const current=await api('/api/setup/coding');codingJob(current.job);if(current.job?.state!=='working')break;}
  await coding();
});}
$('agent-cancel').onclick=()=>api('/api/setup/coding/cancel',{}).catch(e=>$('setup-error').textContent=e.message);
$('pi-form').onsubmit=e=>{e.preventDefault();void run(async()=>{await api('/api/setup/coding/pi',{provider:$('pi-provider').value,key:$('pi-key').value.trim()});$('pi-key').value='';$('setup-message').textContent='Pi key saved. Start a new Pi session to use it.';await coding();});};
async function coding(){try{
  const data=await api('/api/setup/coding');const names={codex:'Codex',claude:'Claude Code',pi:'Pi'};let count=0;$('coding-agents').replaceChildren();
  for(const agent of data.agents){const row=document.createElement('li'),label=document.createElement('span');label.textContent=names[agent.kind]+': '+(!agent.installed?'Not installed':agent.signedIn?(agent.kind==='pi'?'Saved account':'Signed in'):'Sign in needed');row.append(label);if(agent.installed)count++;
    if(!agent.installed||agent.kind!=='pi'){const b=document.createElement('button');b.className='secondary';b.textContent=agent.installed?'Sign in':'Install';b.disabled=busy;b.setAttribute('aria-label',(agent.installed?'Sign in to ':'Install ')+names[agent.kind]);b.onclick=()=>setupAgent(agent.kind,agent.installed?'login':'install');row.append(b);}
    $('coding-agents').append(row);
  }$('coding-state').textContent=count+' installed';codingJob(data.job);
}catch{$('coding-state').textContent='Could not check';}}
show(location.hash.slice(1)||'device',false);
void run(async()=>{await refresh();if(state.job?.state==='working')$('setup-message').textContent='A device step is already running. Wait, then refresh to check it.';});
void coding();
