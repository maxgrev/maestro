const $=id=>document.getElementById(id);
const ticket=new URLSearchParams(location.search).get('authorize');
let state, busy=false;
async function api(path,body){const r=await fetch(path,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});const v=await r.json();if(!r.ok)throw Error(v.error||'Could not complete this step.');return v;}
async function run(fn){if(busy)return;busy=true;$('error').textContent='';try{await fn();}catch(e){$('error').textContent=e.message;}finally{busy=false;}}
async function refresh(){
  state=await api('/api/setup/dot');
  $('setup').hidden=!!ticket;$('consent').hidden=!ticket;
  if(ticket){await api('/api/setup/dot/authorization?ticket='+encodeURIComponent(ticket));$('status').textContent='ChatGPT is ready to connect.';return;}
  $('status').textContent=state.connected?'Connected':state.linked?'Ask your Dot to connect.':state.enabled?'Connect Maestro in ChatGPT.':state.url?'':'Enable remote access first.';
  $('enable-form').hidden=state.enabled;$('instructions').hidden=!state.enabled||state.connected;$('connected').hidden=!state.connected;$('disconnect').hidden=!state.enabled;
  $('enable').disabled=!state.url;$('endpoint').value=state.url||'';$('instruction').value=state.instruction;
  $('remote-required-link').hidden=!!state.url;
  if(!$('name').dataset.edited)$('name').value=state.name;
}
$('name').oninput=()=>{$('name').dataset.edited='true';};
$('enable-form').onsubmit=e=>{e.preventDefault();void run(async()=>{await api('/api/setup/dot',{enabled:true,name:$('name').value.trim()});await refresh();});};
$('disconnect').onclick=()=>void run(async()=>{await api('/api/setup/dot',{enabled:false,name:state.name});await refresh();});
$('approve').onclick=()=>void run(async()=>{$('approve').disabled=true;try{const result=await api('/api/setup/dot/authorize',{ticket});location.assign(result.redirect);}catch(e){$('approve').disabled=false;throw e;}});
for(const [button,field]of [['copy-url','endpoint'],['copy-instruction','instruction']])$(button).onclick=()=>void run(async()=>{try{await navigator.clipboard.writeText($(field).value);$(button).textContent='Copied';}catch{$(field).focus();$(field).select();}});
void run(refresh);
if(!ticket)setInterval(()=>{if(!busy&&!document.hidden)void run(refresh);},4000);
