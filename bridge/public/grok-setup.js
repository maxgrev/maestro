const text=document.getElementById('routine'),status=document.getElementById('guide-status');
try{const response=await fetch('/api/setup/grok-guide');if(!response.ok)throw Error();text.value=(await response.json()).instruction;}catch{status.textContent='Could not load the instruction. Keep Maestro open and reload.';}
document.getElementById('copy').onclick=async()=>{try{await navigator.clipboard.writeText(text.value);status.textContent='Copied. Paste this into the Grok Bot routine.';}catch{text.focus();text.select();status.textContent='Select and copy the instruction above.';}};
