const $ = id => document.getElementById(id);
let state, busy = false, port = '', lastPorts = '';
async function api(path, body) {
  const response = await fetch(path, body ? {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)} : {});
  const value = await response.json(); if(!response.ok) throw new Error(value.error || 'Could not complete this step.'); return value;
}
function show(step) {
  document.querySelectorAll('[data-panel]').forEach(p=>p.hidden=p.dataset.panel!==step);
  document.querySelectorAll('[data-step]').forEach(b=>b.dataset.step===step?b.setAttribute('aria-current','step'):b.removeAttribute('aria-current'));
  $('setup-error').textContent='';
}
function lock(on) { busy=on; document.querySelectorAll('button,input,select').forEach(e=>e.disabled=on); if(!on) render(); }
function render() {
  if(!state)return;
  const signature=JSON.stringify(state.ports);
  if(signature!==lastPorts){
    lastPorts=signature; $('port').replaceChildren();
    const empty=new Option(state.ports.length?'Choose your USB device':'No USB device found','');$('port').add(empty);
    state.ports.forEach(p=>$('port').add(new Option(p.name+' ('+(p.serial||p.port.split('/').pop())+')',p.port)));
    if(state.ports.some(p=>p.port===port))$('port').value=port;
    else if(state.ports.length===1){port=state.ports[0].port;$('port').value=port;}
  }
  const d=state.device?.port===port ? state.device : null;
  $('device-state').textContent=d?'StopWatch found. '+(d.maestro.version>=2?'Maestro is installed.':'A firmware update is needed.'):'Connect to check your device.';
  $('device-next').disabled=busy||!d||d.maestro.version<2;
  $('install-area').hidden=!port||!state.firmware;
  $('install').disabled=busy||!$('confirm-model').checked;
  $('inspect').disabled=busy||!port;
  $('wifi-state').textContent=d?.wifi.state==='connected'?'Connected to '+d.wifi.ssid: 'Wi-Fi has not been checked yet.';
  $('keep-wifi').hidden=d?.wifi.state!=='connected';
  $('muse-state').textContent=d?.link.paired?'Paired':state.muse?'Token saved':'Add token';
  $('muse-device').textContent=d?.name||'your StopWatch';
  $('muse-form').querySelector('button').textContent=state.muse?'Replace token':'Save token';
  $('grok-state').textContent=state.grok?'Routine saved':'Connect routine';
  $('sync-device').disabled=busy||!d||d.maestro.version<2;
  $('check-pair').disabled=busy||!port;
  $('verify').disabled=busy||!port;
  $('open-agents').disabled=busy||!d?.maestro.bridge;
  if(!$('project-path').value&&state.projects[0]){$('project-path').value=state.projects[0].path;$('project-name').value=state.projects[0].name;$('project-trusted').checked=state.projects[0].trusted===true;}
  $('ready-checks').replaceChildren();
  for(const [name,value] of [['Device',d?'Connected over USB':'Connect USB to check'],['Wi-Fi',!d?'Not checked':d.wifi.state==='connected'?d.wifi.ssid:'Not connected'],['Mac bridge',!d?'Not checked':d.maestro.bridge?'Connected':'Not connected'],['Muse',!d?'Not checked':d.link.paired?'Paired':'Not paired'],['On the screen',d?.maestro.name||'Not checked']]){
    const row=document.createElement('p'),label=document.createElement('strong'),text=document.createElement('span');label.textContent=name;text.textContent=value;row.append(label,text);$('ready-checks').append(row);
  }
}
async function refresh(){state=await api('/api/setup');render();}
async function run(fn){if(busy)return;lock(true);$('setup-error').textContent='';try{await fn();}catch(e){$('setup-error').textContent=e.message;}finally{lock(false);}}
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
$('port').onchange=()=>{port=$('port').value;render();};
$('confirm-model').onchange=render;
$('scan').onclick=()=>run(refresh);
$('inspect').onclick=()=>run(async()=>{await operation('inspect');});
$('install').onclick=()=>run(async()=>{await operation('install',{confirmStopWatch:$('confirm-model').checked});$('setup-message').textContent='Installed. Waiting for the device to restart…';await new Promise(r=>setTimeout(r,6000));await operation('inspect');});
$('device-next').onclick=()=>show('wifi');
$('keep-wifi').onclick=()=>show('agents');
$('wifi-form').onsubmit=e=>{e.preventDefault();void run(async()=>{await operation('wifi',{ssid:$('ssid').value,password:$('wifi-password').value});$('wifi-password').value='';show('agents');});};
$('muse-form').onsubmit=e=>{e.preventDefault();void run(async()=>{await api('/api/setup/agents',{muse:$('muse-token').value.trim()});$('muse-token').value='';await refresh();$('setup-message').textContent='Muse token saved. Choose Save to StopWatch below to apply it.';});};
$('grok-form').onsubmit=e=>{e.preventDefault();void run(async()=>{await api('/api/setup/agents',{grok:{webhook:$('grok-url').value.trim(),key:$('grok-key').value.trim()}});$('grok-key').value='';$('grok-url').value='';await refresh();$('setup-message').textContent='Grok routine saved. Send a short message from Conversations to check its reply.';});};
$('project-form').onsubmit=e=>{e.preventDefault();void run(async()=>{await api('/api/setup/agents',{project:{name:$('project-name').value.trim(),path:$('project-path').value.trim(),trusted:$('project-trusted').checked}});await refresh();$('setup-message').textContent='Project saved. New coding sessions will use this folder.';});};
$('project-path').oninput=()=>{$('project-trusted').checked=false;};
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
    if(!agent.installed||agent.kind!=='pi'){const b=document.createElement('button');b.className='secondary';b.textContent=agent.installed?'Sign in':'Install';b.onclick=()=>setupAgent(agent.kind,agent.installed?'login':'install');row.append(b);}
    $('coding-agents').append(row);
  }$('coding-state').textContent=count+' installed';codingJob(data.job);
}catch{$('coding-state').textContent='Could not check';}}
void run(async()=>{await refresh();if(state.job?.state==='working')$('setup-message').textContent='A device step is already running. Wait, then refresh to check it.';await coding();});
