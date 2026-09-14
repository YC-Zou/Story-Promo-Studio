/* Existing business events select one companion pose; animation never drives work. */
(()=>{
 const reduced=matchMedia('(prefers-reduced-motion: reduce)'),toggle=document.querySelector('#motionToggle');
 let paused=reduced.matches;const seen=new Set();
 function motion(){document.documentElement.classList.toggle('motion-paused',paused);toggle.textContent=paused?'播放动画':'暂停动画';toggle.setAttribute('aria-pressed',String(paused));}
 toggle.onclick=()=>{paused=!paused;motion()};reduced.addEventListener('change',e=>{paused=e.matches;motion()});motion();
 function pose(id,mode){const el=document.getElementById(id);if(!el)return;el.dataset.kanshan=mode;el.querySelector('img').src=`./assets/design-preview/kanshan/${mode}-hd.png`;window.dispatchEvent(new Event('kanshan-state'));}
 window.addEventListener('story-state',({detail:{page,task}})=>{
   if(page==='input')pose('inputCompanion',document.querySelector('#inputError').textContent?'failure':'empty');
   if(!task)return;
   const failed=['failed','partially_failed'].includes(task.status),done=task.status==='succeeded';
   const material=task.subtasks?.find(s=>s.id==='material'),context=task.subtasks?.find(s=>s.id==='visual_context');
   let mode=failed?'failure':done?'success':task.status==='canceled'?'brand':material?.status==='succeeded'?'music':context?.status==='succeeded'?'drawing':'storyboard';
   pose(page==='result'?'resultCompanion':'taskCompanion',mode);
 });
 window.addEventListener('story-complete',({detail})=>{if(seen.has(detail.key+detail.type))return;seen.add(detail.key+detail.type);pose(detail.type==='hook-done'?'hookCompanion':'resultCompanion',detail.type);});
 import('./assets/design-preview/kanshan-motion.js');
})();
