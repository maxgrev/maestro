const text=document.getElementById('routine'),status=document.getElementById('guide-status'),copy=document.getElementById('copy'),retry=document.getElementById('retry');
async function load(){
  copy.disabled=true;retry.hidden=true;status.textContent='Loading the instruction for this Mac…';
  try{const response=await fetch('/api/setup/grok-guide');if(!response.ok)throw Error();text.value=(await response.json()).instruction;if(!text.value)throw Error();copy.disabled=false;status.textContent='';}
  catch{status.textContent='Could not load the instruction. Keep Maestro open and try again.';retry.hidden=false;}
}
retry.onclick=()=>void load();
void load();
document.getElementById('copy').onclick=async()=>{try{await navigator.clipboard.writeText(text.value);status.textContent='Copied. Paste this into the Grok Bot routine.';}catch{text.focus();text.select();status.textContent='Select and copy the instruction above.';}};
