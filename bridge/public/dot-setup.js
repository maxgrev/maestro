const $=id=>document.getElementById(id);
const ticket=new URLSearchParams(location.search).get('authorize');
let state, busy=false;
async function api(path,body){const r=await fetch(path,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});const v=await r.json();if(!r.ok)throw Error(v.error||'Could not complete this step.');return v;}
function controls(){document.querySelectorAll('button').forEach(button=>button.disabled=busy||(button.id==='enable'&&!state?.url));}
function failure(error){$('status').textContent='';$('error').textContent=error.message;$('retry').hidden=false;}
async function run(fn){if(busy)return;busy=true;controls();$('error').textContent='';$('retry').hidden=true;try{await fn();}catch(e){failure(e);}finally{busy=false;controls();}}
async function refresh(){
  state=await api('/api/setup/dot');
  $('setup').hidden=!!ticket||(!state.url&&!state.enabled);$('consent').hidden=!ticket;
  if(ticket){await api('/api/setup/dot/authorization?ticket='+encodeURIComponent(ticket));$('status').textContent='ChatGPT is ready to connect.';return;}
  $('dot-title').textContent=state.connected?'Dot connected':'Connect Dot';
  $('status').textContent=!state.url?'Enable remote access first.':state.connected?'':state.linked?'Ask your Dot to connect.':state.enabled?'Connect Maestro in ChatGPT.':'';
  $('enable-form').hidden=state.enabled||!state.url;$('instructions').hidden=!state.enabled||state.connected||!state.url;$('connected').hidden=!state.connected;$('disconnect').hidden=!state.enabled;
  $('enable').disabled=!state.url;$('endpoint').value=state.url||'';$('instruction').value=state.instruction;
  $('remote-required-link').hidden=!!state.url;
  if(!$('name').dataset.edited)$('name').value=state.name;
}
$('name').oninput=()=>{$('name').dataset.edited='true';};
$('enable-form').onsubmit=e=>{e.preventDefault();void run(async()=>{$('enable').textContent='Setting up…';try{await api('/api/setup/dot',{enabled:true,name:$('name').value.trim()});await refresh();}finally{$('enable').textContent='Set up Dot';}});};
$('disconnect').onclick=()=>void run(async()=>{$('disconnect').textContent='Disconnecting…';try{await api('/api/setup/dot',{enabled:false,name:state.name});await refresh();}finally{$('disconnect').textContent='Disconnect Dot';}});
$('retry').onclick=()=>void run(refresh);
$('approve').onclick=()=>void run(async()=>{$('approve').disabled=true;try{const result=await api('/api/setup/dot/authorize',{ticket});location.assign(result.redirect);}catch(e){$('approve').disabled=false;throw e;}});
for(const [button,field]of [['copy-url','endpoint'],['copy-instruction','instruction']]){
  const label=$(button).textContent,accessibleLabel=$(button).getAttribute('aria-label');let reset;
  $(button).onclick=()=>void run(async()=>{try{
    await navigator.clipboard.writeText($(field).value);clearTimeout(reset);
    $(button).style.minWidth=$(button).getBoundingClientRect().width+'px';
    $(button).textContent='Copied';$(button).setAttribute('aria-label','Copied to clipboard');
    reset=setTimeout(()=>{$(button).textContent=label;if(accessibleLabel)$(button).setAttribute('aria-label',accessibleLabel);else $(button).removeAttribute('aria-label');},1600);
  }catch{$(field).focus();$(field).select();}});
}
void run(refresh);
if(!ticket)setInterval(()=>{if(!busy&&!document.hidden&&!$('error').textContent)void refresh().catch(failure);},4000);
