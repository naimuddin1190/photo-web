/* ============================================================
   Passport Photo Studio · script.js
   ============================================================ */
"use strict";

/* ---------- settings you can change ---------- */
const CONFIG={
  // Where the Gemini button takes people. No API key is used anywhere.
  GEMINI_URL:'https://gemini.google.com/app'
};

/* The prompt is fixed. It goes to Gemini with every photo and cannot be changed from the page. */
const GEMINI_PROMPT=`Edit this photo for an official passport/ID photo. Remove ONLY the background.

Strict rules:
- Keep the person 100% unchanged: same face, identity, facial features, face shape, eyes, nose, lips, skin tone, skin texture, expression, hair and hairline, ears, neck, shoulders, body shape, posture, clothing, and accessories.
- Do not beautify, retouch, slim, reshape, smooth skin, change age, change makeup, or redraw any part of the person.
- Keep the exact same framing, camera angle, crop, position and scale of the person. Do not zoom, rotate, move or re-pose.
- Keep every strand of hair at the edges; do not cut into the hair or the shoulders.
- Replace everything behind the person with a perfectly flat, uniform pure white background (#FFFFFF), with no shadows, gradients, vignette, texture, objects or other people.
- Keep natural, even lighting on the person and keep the photo sharp, clear and true to colour.
- Output a single photorealistic image only, with no text, borders or watermarks.`;

const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
const clamp=(v,a,b)=>v<a?a:v>b?b:v;
const mk=(w,h)=>{const c=document.createElement('canvas');c.width=w;c.height=h;return c};

/* ---------- data ---------- */
// [label, width mm, height mm, head height as share of photo height]
const SIZES=[
  ["35 × 45 mm · Passport, most countries",35,45,.74],
  ["2 × 2 in · USA, India",50.8,50.8,.6],
  ["33 × 48 mm · China visa",33,48,.64],
  ["40 × 50 mm · Visa",40,50,.7],
  ["45 × 55 mm · Visa",45,55,.7],
  ["30 × 40 mm",30,40,.7],
  ["25 × 35 mm · Small",25,35,.7],
  ["20 × 25 mm · Stamp",20,25,.7]];
const PAPER=[["A4 · 210 × 297 mm",210,297],["4 × 6 in · photo",101.6,152.4],["5 × 7 in · photo",127,177.8],["Letter · 8.5 × 11 in",215.9,279.4],["A5 · 148 × 210 mm",148,210],["3R · 89 × 127 mm",89,127]];
$('#size').innerHTML=SIZES.map((s,i)=>`<option value="${i}">${s[0]}</option>`).join('')+'<option value="c">Custom size…</option>';
$('#paper').innerHTML=PAPER.map((s,i)=>`<option value="${i}">${s[0]}</option>`).join('');

const S={w:35,h:45,hr:.74};
const G={look:'none',bg:'#ffffff',guide:true,tool:'move',brush:40,hard:.55,compare:false,hover:null,dpr:1,exported:false};
let photos=[],cur=-1;
const P=()=>photos[cur];
const ed=$('#ed'),ec=ed.getContext('2d'),sh=$('#sheet');

/* ---------- toasts + prefs ---------- */
function toast(msg,ms=2600){const t=document.createElement('div');t.className='toast';t.textContent=msg;$('#toasts').appendChild(t);setTimeout(()=>{t.classList.add('out');setTimeout(()=>t.remove(),320)},ms)}
const PREF_KEYS=['size','cw','ch','paper','gap','margin','cut','border','bg','land'];
function savePrefs(){try{const o={};PREF_KEYS.forEach(k=>{const e=$('#'+k);o[k]=e.type==='checkbox'||e.type==='radio'?e.checked:e.value});localStorage.setItem('pps-prefs',JSON.stringify(o))}catch(e){}}
function loadPrefs(){try{const o=JSON.parse(localStorage.getItem('pps-prefs')||'null');if(!o)return;PREF_KEYS.forEach(k=>{const e=$('#'+k);if(!e||o[k]===undefined)return;if(e.type==='checkbox'||e.type==='radio')e.checked=o[k];else e.value=o[k]});if(o.land)$('#land').checked=true;G.bg=$('#bg').value;markSwatch()}catch(e){}}

/* ---------- geometry + drawing ---------- */
function geo(p,W,H,orig){
  const im=orig?(p.orig||p.img):p.cutOn&&p.cut?p.cut:p.img,iw=im.width,ih=im.height,odd=p.q%2,dw=odd?ih:iw,dh=odd?iw:ih;
  return{im,iw,ih,k:Math.max(W/dw,H/dh)*p.zoom,cx:W/2+p.ox*W,cy:H/2+p.oy*H,th:(p.q*90+p.ang)*Math.PI/180,fx:p.flip?-1:1};
}
function filt(p){
  let f=`brightness(${p.br}%) contrast(${p.co}%) saturate(${p.sa}%)`;
  if(p.wa>0)f+=` sepia(${p.wa*.6}%)`;
  if(p.wa<0)f+=` hue-rotate(${p.wa*.35}deg) saturate(${100+p.wa}%)`;
  return f;
}
function drawPhoto(p,c,W,H,o={}){
  const g=geo(p,W,H,o.orig);
  c.save();
  if(!o.transparent){c.fillStyle=G.bg;c.fillRect(0,0,W,H)}
  if(!o.orig)c.filter=filt(p);
  c.translate(g.cx,g.cy);c.rotate(g.th);c.scale(g.k*g.fx,g.k);
  if(o.ghost&&g.im!==p.img){c.globalAlpha=.3;c.drawImage(p.img,-g.iw/2,-g.ih/2,g.iw,g.ih);c.globalAlpha=1}
  c.drawImage(g.im,-g.iw/2,-g.ih/2,g.iw,g.ih);
  c.restore();
  if(p.label&&!o.noLabel)drawLabel(c,W,H,p.label);
}
function drawLabel(c,W,H,text){
  const bh=Math.round(H*.12);c.save();c.fillStyle='#ffffff';c.fillRect(0,H-bh,W,bh);
  let fs=bh*.58;c.fillStyle='#111111';c.textAlign='center';c.textBaseline='middle';
  do{c.font=`600 ${fs}px Figtree, Arial, sans-serif`;fs*=.92}while(c.measureText(text).width>W*.92&&fs>4);
  c.fillText(text,W/2,H-bh/2+bh*.04);c.restore();
}
function guideBox(W,H){const hr=S.hr,top=(1-hr)*.42*H,ry=hr*H/2;return{top,ry,rx:ry/1.38,cy:top+ry}}

function sizeEditor(){
  const st=$('#stage'),avail=Math.max(120,st.clientWidth-40),maxH=Math.min(540,Math.max(240,innerHeight*.56));
  const k=Math.min(avail/S.w,maxH/S.h),cw=S.w*k,chh=S.h*k,dpr=Math.min(2.5,window.devicePixelRatio||1);
  ed.style.width=cw+'px';ed.style.height=chh+'px';ed.width=Math.round(cw*dpr);ed.height=Math.round(chh*dpr);G.dpr=dpr;
}
function css(v){return getComputedStyle(document.documentElement).getPropertyValue(v).trim()}
function drawEditor(){
  const W=ed.width,H=ed.height,p=P();
  ec.setTransform(1,0,0,1,0,0);ec.filter='none';
  if(!p){
    ec.fillStyle=G.bg;ec.fillRect(0,0,W,H);
    ec.fillStyle='#c9d3df';const b=guideBox(W,H);
    ec.beginPath();ec.ellipse(W/2,b.cy,b.rx*.9,b.ry*.9,0,0,Math.PI*2);ec.fill();
    ec.beginPath();ec.ellipse(W/2,H*1.08,W*.46,H*.28,0,0,Math.PI*2);ec.fill();
    ec.fillStyle='#5a6779';ec.font=`600 ${Math.round(W/15)}px Figtree, sans-serif`;ec.textAlign='center';ec.fillText('Add a photo to begin',W/2,H*.08+W/15);
    return;
  }
  drawPhoto(p,ec,W,H,{orig:G.compare,ghost:!G.compare&&G.tool==='restore'});
  if(G.compare){ec.fillStyle='rgba(10,16,28,.7)';ec.fillRect(10,10,W*.36,W*.08);ec.fillStyle='#fff';ec.font=`600 ${W*.045}px Figtree, sans-serif`;ec.textAlign='left';ec.fillText('Original',18,10+W*.058)}
  if(G.guide&&!G.compare){
    const b=guideBox(W,H);ec.save();ec.lineWidth=Math.max(1.5,G.dpr);ec.setLineDash([8*G.dpr,7*G.dpr]);
    ec.strokeStyle='rgba(255,255,255,.95)';ec.shadowColor='rgba(0,0,0,.65)';ec.shadowBlur=3;
    ec.beginPath();ec.ellipse(W/2,b.cy,b.rx,b.ry,0,0,Math.PI*2);ec.stroke();
    ec.setLineDash([3*G.dpr,5*G.dpr]);ec.strokeStyle='rgba(255,200,80,.95)';
    [[b.top,'crown'],[b.top+2*b.ry,'chin']].forEach(([y,t])=>{ec.beginPath();ec.moveTo(W*.06,y);ec.lineTo(W*.94,y);ec.stroke();ec.shadowBlur=2;ec.fillStyle='rgba(255,210,110,1)';ec.font=`600 ${Math.max(10,W*.03)}px JetBrains Mono, monospace`;ec.textAlign='left';ec.fillText(t,W*.06,y-4*G.dpr)});
    ec.beginPath();ec.setLineDash([2*G.dpr,6*G.dpr]);ec.strokeStyle='rgba(255,255,255,.5)';ec.moveTo(W/2,0);ec.lineTo(W/2,H);ec.stroke();
    ec.restore();
  }
  if(G.tool!=='move'&&G.hover&&p.cut){
    const r=G.brush/2*G.dpr;ec.save();ec.lineWidth=1.5*G.dpr;
    ec.strokeStyle='rgba(0,0,0,.6)';ec.beginPath();ec.arc(G.hover.x,G.hover.y,r+1,0,Math.PI*2);ec.stroke();
    ec.strokeStyle=G.tool==='erase'?'#ff7686':'#43d193';ec.beginPath();ec.arc(G.hover.x,G.hover.y,r,0,Math.PI*2);ec.stroke();
    ec.setLineDash([3,3]);ec.strokeStyle='rgba(255,255,255,.8)';ec.beginPath();ec.arc(G.hover.x,G.hover.y,r*G.hard,0,Math.PI*2);ec.stroke();ec.restore();
  }
}

/* ---------- print sheet ---------- */
function paper(){let [,W,H]=PAPER[$('#paper').value]||PAPER[0];if($('#land').checked)[W,H]=[H,W];return{W,H}}
function grid(){const {W,H}=paper(),g=+$('#gap').value,m=+$('#margin').value;
  return{W,H,g,m,cols:Math.max(0,Math.floor((W-2*m+g)/(S.w+g))),rows:Math.max(0,Math.floor((H-2*m+g)/(S.h+g)))}}
function drawSheet(cv,ppm){
  const Gd=grid(),c=cv.getContext('2d');cv.width=Math.round(Gd.W*ppm);cv.height=Math.round(Gd.H*ppm);
  c.fillStyle='#ffffff';c.fillRect(0,0,cv.width,cv.height);
  const tw=Math.round(S.w*ppm),th=Math.round(S.h*ppm),cache=new Map();
  const list=photos.flatMap(p=>Array(p.copies).fill(p)).slice(0,Gd.cols*Gd.rows);
  const x0=(Gd.W-(Gd.cols*S.w+(Gd.cols-1)*Gd.g))/2,rowsUsed=Math.ceil(list.length/Math.max(1,Gd.cols));
  const y0=Gd.m;
  list.forEach((p,i)=>{
    if(!cache.has(p)){const t=mk(tw,th);drawPhoto(p,t.getContext('2d'),tw,th);cache.set(p,t)}
    const x=Math.round((x0+(i%Gd.cols)*(S.w+Gd.g))*ppm),y=Math.round((y0+Math.floor(i/Gd.cols)*(S.h+Gd.g))*ppm);
    c.drawImage(cache.get(p),x,y);
    if($('#border').checked){c.strokeStyle='#000000';c.lineWidth=Math.max(1,ppm*.2);const o=c.lineWidth/2;c.strokeRect(x+o,y+o,tw-2*o,th-2*o)}
    if($('#cut').checked){c.strokeStyle='#a3abb5';c.lineWidth=Math.max(1,ppm/7);c.setLineDash([ppm*1.2,ppm*.8]);c.strokeRect(x-.5,y-.5,tw+1,th+1);c.setLineDash([])}
  });
  return{G:Gd,placed:list.length,rowsUsed};
}
function updateSheet(){
  const ppm=Math.min(6,Math.max(3,(sh.parentElement.clientWidth||600)*1.6/paper().W));
  const {G:Gd,placed}=drawSheet(sh,ppm),want=photos.reduce((a,p)=>a+p.copies,0),cap=Gd.cols*Gd.rows;
  $('#info').innerHTML=`<span>Fits <b>${Gd.cols} × ${Gd.rows}</b> = <b>${cap}</b></span><span>Placed <b>${placed}</b></span>`+(want>cap?`<span class="warnt">${want-cap} copies do not fit</span>`:'')+(cap===0?'<span class="warnt">Photo is larger than the paper</span>':'');
}
let raf=0,sheetT=0;
function redraw(){cancelAnimationFrame(raf);raf=requestAnimationFrame(()=>{drawEditor();updateChecks()});clearTimeout(sheetT);sheetT=setTimeout(updateSheet,140)}
function refreshAll(){sizeEditor();redraw();$('#sizeNote').textContent=`${S.w} × ${S.h} mm · ${Math.round(S.w/25.4*300)} × ${Math.round(S.h/25.4*300)} px at 300 dpi. Head about ${Math.round(S.hr*S.h)} mm from crown to chin.`;$('#dims').textContent=`${S.w} × ${S.h} mm`}

/* ---------- checks + steps ---------- */
function updateChecks(){
  const p=P(),L=[];
  if(!p){L.push(['idle','Add a photo','Checks appear here once a photo is loaded.']);}
  else{
    const g=geo(p,ed.width,ed.height),srcPx=ed.width/g.k,dpi=Math.round(srcPx/(S.w/25.4));
    L.push(dpi>=300?['ok','Sharp print',`${dpi} dpi from your photo`]:dpi>=200?['warn','Print may look soft',`${dpi} dpi. Zoom out a little or use a larger photo.`]:['bad','Too low resolution',`${dpi} dpi. Use a larger photo or zoom out.`]);
    L.push(p.cutOn?['ok','Plain background','Cutout on a solid colour']:['warn','Original background','Make sure the wall is plain, or remove it']);
    if(p.headPx){const mm=p.headPx*(g.iw/p.work.width)*g.k/ed.height*S.h,t=S.hr*S.h,ok=Math.abs(mm-t)<=t*.07;
      L.push([ok?'ok':Math.abs(mm-t)<=t*.15?'warn':'bad','Head size',`About ${mm.toFixed(1)} mm, target ${(t*.93).toFixed(0)}–${(t*1.07).toFixed(0)} mm`]);}
    else L.push(['idle','Head size','Press Auto-fit face to measure']);
    L.push(Math.abs(p.ang)<=2?['ok','Level',p.ang?`Straightened ${p.ang}°`:'No tilt applied']:['warn','Check tilt',`Rotated ${p.ang}°. Eyes should be level.`]);
  }
  $('#checks').innerHTML=L.map(([s,b,t])=>`<li class="${s}"><span class="dot">${s==='ok'?'✓':s==='idle'?'·':'!'}</span><div><b>${b}</b><span>${t}</span></div></li>`).join('');
  const st={add:photos.length>0,frame:!!(p&&(p.touched||p.headPx)),bg:!!(p&&p.cutOn),print:G.exported};
  $$('#steps li').forEach(li=>li.classList.toggle('done',!!st[li.dataset.s]));
  $('#bgMode').textContent=p&&p.cutOn?({gemini:'Gemini',hd:'HD AI',fast:'Fast AI',wall:'Plain wall'}[p.mode]||'Cutout'):'Original';
}

/* ---------- photos ---------- */
function addFiles(files){
  const list=[...files].filter(f=>f.type.startsWith('image/'));
  if(!list.length){toast('That file is not an image.');return}
  list.forEach(f=>{
    const url=URL.createObjectURL(f),img=new Image();
    img.onload=()=>{photos.push({img,url,name:f.name||'Photo',q:0,ang:0,zoom:1,ox:0,oy:0,br:100,co:100,sa:100,wa:0,flip:false,label:'',copies:photos.length?0:6,
      cut:null,cutOn:false,work:null,base:null,ra:null,edit:null,editSnap:null,mode:null,smooth:3,shift:0,soft:6,defringe:true,headPx:0,touched:false});
      select(photos.length-1);toast('Photo added. Press Auto-fit face to frame it.')};
    img.onerror=()=>{URL.revokeObjectURL(url);toast('Could not open that image. Try a JPG or PNG.')};
    img.src=url;
  });
}
function thumbs(){
  $('#list').innerHTML=photos.map((p,i)=>`<div class="th ${i==cur?'on':''}" data-i="${i}"><img src="${p.url}" alt="Photo ${i+1}">${p.cutOn?'<span class="badge">CUT</span>':''}<button class="x" data-x="${i}" aria-label="Remove photo">✕</button><div class="cp"><button data-d="${i}" data-v="-1" aria-label="Fewer copies">−</button><span>${p.copies}<small>copies</small></span><button data-d="${i}" data-v="1" aria-label="More copies">+</button></div></div>`).join('');
  $('#photoCount').textContent=`${photos.length} added`;
}
const SL=['zoom','ang','br','co','sa','wa','smooth','shift','soft'];
function sync(){
  const p=P();
  if(p){SL.forEach(k=>{$('#'+k).value=p[k]});$('#cutOn').checked=!!p.cutOn;$('#defringe').checked=p.defringe;$('#label').value=p.label;}
  $('#refineBox').open=!!(p&&p.cut);
  $('#tolRow').hidden=!(p&&['wall','gemini'].includes(p.mode));
  outs();
}
function outs(){$$('input[type=range]').forEach(i=>{
  const pct=(i.value-i.min)/(i.max-i.min)*100;i.style.setProperty('--p',pct+'%');
  const o=i.nextElementSibling;if(!o||o.tagName!=='OUTPUT')return;const v=+i.value;
  o.textContent=i.id=='zoom'?v.toFixed(2)+'×':i.id=='ang'?v+'°':['gap','margin'].includes(i.id)?v+' mm':i.id=='shift'?(v>0?'+':'')+v:['smooth','soft','tol'].includes(i.id)?v:i.id=='wa'?(v>0?'+':'')+v:v+'%'})}
function select(i){cur=i;sync();thumbs();refreshAll();Hs.last=P()?snap(P()):null;updUndo()}
$('#list').addEventListener('click',e=>{
  const x=e.target.closest('[data-x]'),d=e.target.closest('[data-d]');
  if(x){const i=+x.dataset.x;URL.revokeObjectURL(photos[i].url);photos.splice(i,1);if(cur>=photos.length)cur=photos.length-1;Hs.u=[];Hs.r=[];select(cur);return}
  if(d){const p=photos[+d.dataset.d];p.copies=clamp(p.copies+ +d.dataset.v,0,99);thumbs();updateSheet();return}
  const t=e.target.closest('.th');if(t&&+t.dataset.i!==cur)select(+t.dataset.i);
});
$('#drop').onclick=()=>$('#file').click();
$('#drop').onkeydown=e=>{if(e.key=='Enter'||e.key==' '){e.preventDefault();$('#file').click()}};
$('#file').onchange=e=>{addFiles(e.target.files);e.target.value=''};
['dragover','dragenter'].forEach(n=>document.addEventListener(n,e=>{if(e.dataTransfer&&[...e.dataTransfer.types].includes('Files')){e.preventDefault();$('#drop').classList.add('over')}}));
['dragleave','drop'].forEach(n=>document.addEventListener(n,e=>{if(n==='drop')e.preventDefault();if(n==='drop'||!e.relatedTarget)$('#drop').classList.remove('over')}));
document.addEventListener('drop',e=>{if(!e.dataTransfer||!e.dataTransfer.files.length)return;if(e.target.closest&&e.target.closest('#gem')&&P())applyGemini(e.dataTransfer.files[0]);else addFiles(e.dataTransfer.files)});
document.addEventListener('paste',e=>{const f=[...(e.clipboardData?.files||[])].filter(x=>x.type.startsWith('image/'));if(!f.length)return;if(G.waitGemini&&photos.includes(G.waitGemini))applyGemini(f[0]);else addFiles(f)});

/* ---------- history ---------- */
const HK=['q','ang','zoom','ox','oy','br','co','sa','wa','flip','cutOn','smooth','shift','soft','defringe','label','headPx'];
const Hs={u:[],r:[],last:null};
function snap(p){const o={i:photos.indexOf(p),edit:p.editSnap};HK.forEach(k=>o[k]=p[k]);return o}
function same(a,b){return a&&b&&a.i===b.i&&a.edit===b.edit&&HK.every(k=>a[k]===b[k])}
function commit(){const p=P();if(!p)return;const s=snap(p);if(same(Hs.last,s))return;if(Hs.last){Hs.u.push(Hs.last);if(Hs.u.length>40)Hs.u.shift()}Hs.r=[];Hs.last=s;updUndo()}
function restore(s){
  const p=photos[s.i];if(!p)return;if(s.i!==cur){cur=s.i;thumbs()}
  const needRefine=p.base&&(p.smooth!==s.smooth||p.shift!==s.shift||p.soft!==s.soft);
  HK.forEach(k=>p[k]=s[k]);
  if(p.edit){if(s.edit)p.edit.set(s.edit);else p.edit.fill(0);p.editSnap=s.edit}
  if(needRefine)refine(p);else if(p.ra)compose(p);
  Hs.last=s;sync();thumbs();redraw();updUndo();
}
function undo(){if(!Hs.u.length)return;Hs.r.push(Hs.last);restore(Hs.u.pop())}
function redo(){if(!Hs.r.length)return;Hs.u.push(Hs.last);restore(Hs.r.pop())}
function updUndo(){$('#undo').disabled=!Hs.u.length;$('#redo').disabled=!Hs.r.length}
$('#undo').onclick=undo;$('#redo').onclick=redo;

/* ---------- controls ---------- */
SL.slice(0,6).forEach(k=>{const el=$('#'+k);
  el.addEventListener('input',()=>{const p=P();if(p){p[k]=+el.value;p.touched=true}outs();redraw()});
  el.addEventListener('change',commit)});
['smooth','shift','soft'].forEach(k=>{const el=$('#'+k);
  el.addEventListener('input',()=>{const p=P();outs();if(!p)return;p[k]=+el.value;if(p.base){clearTimeout(refine.t);refine.t=setTimeout(()=>{refine(p);redraw()},110)}});
  el.addEventListener('change',commit)});
$('#tol').addEventListener('input',()=>{outs();const p=P();if(!p||!['wall','gemini'].includes(p.mode))return;clearTimeout(refine.t);refine.t=setTimeout(()=>{p.base=wallAlpha(p,+$('#tol').value);refine(p);redraw()},140)});
$('#defringe').onchange=()=>{const p=P();if(p){p.defringe=$('#defringe').checked;if(p.ra)compose(p);redraw();commit()}};
$('#label').addEventListener('input',()=>{const p=P();if(p){p.label=$('#label').value.trim();redraw()}});
$('#label').addEventListener('change',commit);
$('#guide').onchange=()=>{G.guide=$('#guide').checked;redraw()};
['cut','border','paper','gap','margin'].forEach(k=>$('#'+k).addEventListener('input',()=>{outs();updateSheet();savePrefs()}));
$$('input[name=orient]').forEach(r=>r.addEventListener('change',()=>{updateSheet();savePrefs()}));
function setBg(c){G.bg=c;$('#bg').value=c;markSwatch();redraw();savePrefs()}
function markSwatch(){$$('.swatch[data-c]').forEach(s=>s.classList.toggle('on',s.dataset.c.toLowerCase()===G.bg.toLowerCase()));$('.swatch.custom').classList.toggle('on',!$$('.swatch[data-c]').some(s=>s.dataset.c.toLowerCase()===G.bg.toLowerCase()))}
$('#swatches').addEventListener('click',e=>{const s=e.target.closest('[data-c]');if(s)setBg(s.dataset.c)});
$('#bg').addEventListener('input',e=>setBg(e.target.value));
const act=f=>()=>{const p=P();if(!p)return;f(p);p.touched=true;sync();redraw();commit()};
$('#rotL').onclick=act(p=>p.q=(p.q+3)%4);
$('#rotR').onclick=act(p=>p.q=(p.q+1)%4);
$('#flip').onclick=act(p=>p.flip=!p.flip);
$('#reset').onclick=act(p=>Object.assign(p,{q:0,ang:0,zoom:1,ox:0,oy:0,br:100,co:100,sa:100,wa:0,flip:false,headPx:0}));
$('#zIn').onclick=()=>zoomAt(1.12);$('#zOut').onclick=()=>zoomAt(1/1.12);
function zoomAt(f,mx,my){const p=P();if(!p)return;const W=ed.width,H=ed.height;if(mx===undefined){mx=W/2;my=H/2}
  const nz=clamp(p.zoom*f,.3,4),r=nz/p.zoom,cx=W/2+p.ox*W,cy=H/2+p.oy*H;
  p.ox=(mx+(cx-mx)*r-W/2)/W;p.oy=(my+(cy-my)*r-H/2)/H;p.zoom=nz;p.touched=true;sync();redraw();clearTimeout(zoomAt.t);zoomAt.t=setTimeout(commit,350)}
const cmp=$('#compare');
cmp.addEventListener('pointerdown',()=>{G.compare=true;redraw()});
['pointerup','pointerleave','pointercancel'].forEach(n=>cmp.addEventListener(n,()=>{if(G.compare){G.compare=false;redraw()}}));
$('#auto').onclick=act(p=>{prepare(p);const w=p.work.width,h=p.work.height,g=p.gray;let s=0,s2=0,n=0;
  for(let y=Math.round(h*.15);y<h*.85;y+=2)for(let x=Math.round(w*.2);x<w*.8;x+=2){const v=g[y*w+x];s+=v;s2+=v*v;n++}
  const m=s/n,sd=Math.sqrt(Math.max(1e-4,s2/n-m*m));p.br=Math.round(clamp(100*.56/m,75,150));p.co=Math.round(clamp(100*.22/sd,90,135));p.sa=Math.max(p.sa,104);toast('Light balanced')});

/* tools */
function setTool(t){G.tool=t;$('#t'+t[0].toUpperCase()+t.slice(1)).checked=true;ed.classList.toggle('brush',t!=='move');$('#brushRow').hidden=t==='move';
  $('#edStatus').textContent={move:'Move',erase:'Erase brush',restore:'Restore brush'}[t];
  $('#toolHint').innerHTML=t==='move'?'Drag to move. Scroll or pinch to zoom. Arrow keys nudge, <kbd>E</kbd> erase, <kbd>R</kbd> restore, <kbd>V</kbd> move.':t==='erase'?'Paint over leftover background to remove it. <kbd>[</kbd> <kbd>]</kbd> change brush size.':'Paint to bring back hair or shoulders. The faint image shows what was removed.';
  const p=P();if(t!=='move'&&p&&!p.cut)toast('Remove the background first, then touch it up with the brush.');
  if(t!=='move'&&p&&p.cut&&!p.cutOn){p.cutOn=true;sync();commit()}
  redraw()}
$$('input[name=tool]').forEach(r=>r.addEventListener('change',()=>setTool(r.value)));
$('#bsize').oninput=e=>{G.brush=+e.target.value;outs();redraw()};
$('#bhard').oninput=e=>{G.hard=+e.target.value/100;outs();redraw()};
$$('input[name=eng]').forEach(r=>r.addEventListener('change',engNote));
function eng(){return $('input[name=eng]:checked').value}
function engNote(){$('#engNote').textContent={hd:'Best edges and hair. Downloads about 40 MB the first time, then runs offline.',fast:'Quick person detection. Good on phones and slow connections.',wall:'No download. Works when you stand in front of a plain wall.'}[eng()]}

/* ---------- editor pointer ---------- */
const pts=new Map();let drag=null,pinch=null,stroke=null;
function evPos(e){const r=ed.getBoundingClientRect();return{x:(e.clientX-r.left)*ed.width/r.width,y:(e.clientY-r.top)*ed.height/r.height}}
ed.addEventListener('pointerdown',e=>{
  const p=P();if(!p)return;ed.setPointerCapture(e.pointerId);ed.focus({preventScroll:true});
  pts.set(e.pointerId,evPos(e));
  if(pts.size===2){stroke=null;drag=null;const [a,b]=[...pts.values()];pinch={d:Math.hypot(a.x-b.x,a.y-b.y),z:p.zoom,m:{x:(a.x+b.x)/2,y:(a.y+b.y)/2},ox:p.ox,oy:p.oy};return}
  const pos=evPos(e);
  if(G.tool!=='move'&&p.cut){p.cutOn=true;stroke={last:pos};paintAt(p,pos);return}
  drag={x:pos.x,y:pos.y,ox:p.ox,oy:p.oy};
});
ed.addEventListener('pointermove',e=>{
  const p=P();const pos=evPos(e);G.hover=pos;
  if(pts.has(e.pointerId))pts.set(e.pointerId,pos);
  if(!p){return}
  if(pinch&&pts.size===2){const [a,b]=[...pts.values()],d=Math.hypot(a.x-b.x,a.y-b.y),m={x:(a.x+b.x)/2,y:(a.y+b.y)/2},W=ed.width,H=ed.height;
    const nz=clamp(pinch.z*d/pinch.d,.3,4),r=nz/pinch.z,cx=W/2+pinch.ox*W,cy=H/2+pinch.oy*H;
    p.zoom=nz;p.ox=(m.x+(cx-pinch.m.x)*r-W/2)/W;p.oy=(m.y+(cy-pinch.m.y)*r-H/2)/H;p.touched=true;sync();redraw();return}
  if(stroke){const l=stroke.last,dist=Math.hypot(pos.x-l.x,pos.y-l.y),stepPx=Math.max(1.5,G.brush*G.dpr*.18),n=Math.ceil(dist/stepPx);
    for(let i=1;i<=n;i++)paintAt(p,{x:l.x+(pos.x-l.x)*i/n,y:l.y+(pos.y-l.y)*i/n});stroke.last=pos;return}
  if(drag){p.ox=drag.ox+(pos.x-drag.x)/ed.width;p.oy=drag.oy+(pos.y-drag.y)/ed.height;p.touched=true;redraw();return}
  if(G.tool!=='move')redraw();
});
function endPtr(e){pts.delete(e.pointerId);if(pts.size<2)pinch=null;
  const p=P();if(stroke&&p){stroke=null;p.editSnap=p.edit.slice();thumbs();commit()}
  if(drag){drag=null;commit()}}
ed.addEventListener('pointerup',endPtr);ed.addEventListener('pointercancel',endPtr);
ed.addEventListener('pointerleave',()=>{G.hover=null;if(G.tool!=='move')redraw()});
ed.addEventListener('wheel',e=>{if(!P())return;e.preventDefault();const pos=evPos(e);zoomAt(Math.exp(-e.deltaY*.0015),pos.x,pos.y)},{passive:false});
ed.addEventListener('keydown',e=>{const p=P();if(!p)return;const s=e.shiftKey?.02:.004;let used=true;
  if(e.key==='ArrowLeft')p.ox-=s;else if(e.key==='ArrowRight')p.ox+=s;else if(e.key==='ArrowUp')p.oy-=s;else if(e.key==='ArrowDown')p.oy+=s;
  else if(e.key==='+'||e.key==='=')return zoomAt(1.05),e.preventDefault();else if(e.key==='-')return zoomAt(1/1.05),e.preventDefault();else used=false;
  if(used){e.preventDefault();p.touched=true;redraw();clearTimeout(zoomAt.t);zoomAt.t=setTimeout(commit,400)}});
document.addEventListener('keydown',e=>{
  const tag=(e.target.tagName||'').toLowerCase();if(tag==='input'&&['text','number'].includes(e.target.type)||tag==='select')return;
  if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'){e.preventDefault();e.shiftKey?redo():undo();return}
  if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='y'){e.preventDefault();redo();return}
  if(e.ctrlKey||e.metaKey||e.altKey)return;
  const k=e.key.toLowerCase();
  if(k==='e')setTool('erase');else if(k==='r')setTool('restore');else if(k==='v')setTool('move');
  else if(k==='['){G.brush=clamp(G.brush-6,6,160);$('#bsize').value=G.brush;outs();redraw()}
  else if(k===']'){G.brush=clamp(G.brush+6,6,160);$('#bsize').value=G.brush;outs();redraw()}
});

/* ---------- background removal: data prep ---------- */
function prepare(p){
  if(p.work)return;
  const iw=p.img.naturalWidth,ih=p.img.naturalHeight,k=Math.min(1,2000/Math.max(iw,ih)),w=Math.round(iw*k),h=Math.round(ih*k);
  const c=mk(w,h),x=c.getContext('2d',{willReadFrequently:true});x.drawImage(p.img,0,0,w,h);
  p.work=c;p.rgb=x.getImageData(0,0,w,h).data;const n=w*h;p.gray=new Float32Array(n);
  for(let i=0,j=0;i<n;i++,j+=4)p.gray[i]=(p.rgb[j]*.299+p.rgb[j+1]*.587+p.rgb[j+2]*.114)/255;
  const r=[],g=[],b=[],m=Math.max(2,Math.round(Math.min(w,h)*.02)),add=(xx,yy)=>{const i=(yy*w+xx)*4;r.push(p.rgb[i]);g.push(p.rgb[i+1]);b.push(p.rgb[i+2])};
  for(let xx=0;xx<w;xx+=3)for(let kk=0;kk<m;kk++){add(xx,kk)}
  for(let yy=0;yy<h;yy+=3)for(let kk=0;kk<m;kk++){add(kk,yy);add(w-1-kk,yy)}
  const med=a=>a.slice().sort((u,v)=>u-v)[a.length>>1];p.bgc=[med(r),med(g),med(b)];
  let vs=0;for(let i=0;i<r.length;i++){const dr=r[i]-p.bgc[0],dg=g[i]-p.bgc[1],db=b[i]-p.bgc[2];vs+=dr*dr+dg*dg+db*db}
  p.bgSpread=Math.sqrt(vs/r.length);
  p.edit=new Int16Array(n);p.cut=null;
}
function alphaFrom(src,w,h,useAlpha){
  const c=mk(w,h),x=c.getContext('2d',{willReadFrequently:true});x.drawImage(src,0,0,w,h);
  const d=x.getImageData(0,0,w,h).data,n=w*h,a=new Uint8Array(n);let mn=255;
  for(let i=0;i<n;i++){a[i]=d[i*4+3];if(a[i]<mn)mn=a[i]}
  if(!useAlpha||mn>=250)for(let i=0;i<n;i++)a[i]=d[i*4];
  return a;
}
const share=a=>{let n=0,t=0;for(let i=0;i<a.length;i+=7){t++;if(a[i]>128)n++}return n/t};

/* engines */
const IMGLY='https://cdn.jsdelivr.net/npm/@imgly/background-removal@1.4.5/+esm';
const MP='https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation@0.1.1675465747/';
let imglyMod=null,mpSeg=null;
const timeout=(pr,ms,msg)=>Promise.race([pr,new Promise((_,r)=>setTimeout(()=>r(new Error(msg||'timeout')),ms))]);
const loadScript=u=>new Promise((ok,no)=>{const e=document.createElement('script');e.src=u;e.crossOrigin='anonymous';e.onload=ok;e.onerror=()=>no(new Error('load'));document.head.appendChild(e)});
async function segHD(p){
  if(!imglyMod)imglyMod=import(IMGLY).catch(e=>{imglyMod=null;throw e});
  const m=await imglyMod,fn=m.removeBackground||m.default;
  const blob=await new Promise(r=>p.work.toBlob(r,'image/png'));
  const out=await fn(blob,{output:{format:'image/png'},progress:(key,c,t)=>{if(t&&String(key).includes('fetch'))setProg(c/t,`Downloading HD model · ${Math.round(c/t*100)}%`);else if(String(key).includes('compute'))setProg(-1,'Finding the edges…')}});
  const bmp=await createImageBitmap(out);
  return alphaFrom(bmp,p.work.width,p.work.height,true);
}
async function segFast(p){
  if(!mpSeg){await loadScript(MP+'selfie_segmentation.js');mpSeg=new SelfieSegmentation({locateFile:f=>MP+f});mpSeg.setOptions({modelSelection:0})}
  const mask=await new Promise((ok,no)=>{mpSeg.onResults(r=>ok(r.segmentationMask));mpSeg.send({image:p.work}).catch(no)});
  return alphaFrom(mask,p.work.width,p.work.height,true);
}
function wallAlpha(p,t){
  const w=p.work.width,h=p.work.height,d=p.rgb,[R,G2,B]=p.bgc,T=(t*2.2)**2,n=w*h;
  // flood from the edges: a pixel joins the wall if it is close to the wall colour AND
  // there is no sharp colour step from its neighbour (stops at the outline of the person)
  const TN=Math.max(14,t*.75)**2,bg=new Uint8Array(n),st=new Int32Array(n);let sp=0;
  const push=(i,f)=>{if(bg[i])return;const j=i*4,x=d[j]-R,y=d[j+1]-G2,z=d[j+2]-B;if(x*x+y*y+z*z>T)return;
    if(f>=0){const k=f*4,u=d[j]-d[k],v=d[j+1]-d[k+1],q=d[j+2]-d[k+2];if(u*u+v*v+q*q>TN)return}bg[i]=1;st[sp++]=i};
  for(let x=0;x<w;x++){push(x,-1);push((h-1)*w+x,-1)}for(let y=0;y<h;y++){push(y*w,-1);push(y*w+w-1,-1)}
  while(sp){const i=st[--sp],x=i%w;if(x>0)push(i-1,i);if(x<w-1)push(i+1,i);if(i>=w)push(i-w,i);if(i<n-w)push(i+w,i)}
  const a=new Uint8Array(n);for(let i=0;i<n;i++)a[i]=bg[i]?0:255;
  return a;
}

/* ---------- refinement: morphology + guided filter + curve ---------- */
function boxMean(src,w,h,r){
  const tmp=new Float32Array(w*h),out=new Float32Array(w*h);
  for(let y=0;y<h;y++){const o=y*w;let s=0,c=0;for(let x=0;x<=Math.min(r,w-1);x++){s+=src[o+x];c++}
    for(let x=0;x<w;x++){tmp[o+x]=s/c;const ad=x+r+1,rm=x-r;if(ad<w){s+=src[o+ad];c++}if(rm>=0){s-=src[o+rm];c--}}}
  for(let x=0;x<w;x++){let s=0,c=0;for(let y=0;y<=Math.min(r,h-1);y++){s+=tmp[y*w+x];c++}
    for(let y=0;y<h;y++){out[y*w+x]=s/c;const ad=y+r+1,rm=y-r;if(ad<h){s+=tmp[ad*w+x];c++}if(rm>=0){s-=tmp[rm*w+x];c--}}}
  return out;
}
function guided(I,Pm,w,h,r,eps){
  const n=w*h,II=new Float32Array(n),IP=new Float32Array(n);
  for(let i=0;i<n;i++){II[i]=I[i]*I[i];IP[i]=I[i]*Pm[i]}
  const mI=boxMean(I,w,h,r),mP=boxMean(Pm,w,h,r),mII=boxMean(II,w,h,r),mIP=boxMean(IP,w,h,r);
  const A=II,B=IP;for(let i=0;i<n;i++){const v=mII[i]-mI[i]*mI[i],c=mIP[i]-mI[i]*mP[i],a=c/(v+eps);A[i]=a;B[i]=mP[i]-a*mI[i]}
  const mA=boxMean(A,w,h,r),mB=boxMean(B,w,h,r),q=mA;for(let i=0;i<n;i++)q[i]=mA[i]*I[i]+mB[i];
  return q;
}
function morph(a,w,h,r,grow){
  const f=grow?Math.max:Math.min,tmp=new Float32Array(w*h),out=new Float32Array(w*h);
  for(let y=0;y<h;y++){const o=y*w;for(let x=0;x<w;x++){let v=a[o+x];for(let k=1;k<=r;k++){if(x-k>=0)v=f(v,a[o+x-k]);if(x+k<w)v=f(v,a[o+x+k])}tmp[o+x]=v}}
  for(let x=0;x<w;x++)for(let y=0;y<h;y++){let v=tmp[y*w+x];for(let k=1;k<=r;k++){if(y-k>=0)v=f(v,tmp[(y-k)*w+x]);if(y+k<h)v=f(v,tmp[(y+k)*w+x])}out[y*w+x]=v}
  return out;
}
function refine(p){
  const w=p.work.width,h=p.work.height,n=w*h,sc=Math.max(1,Math.round(Math.max(w,h)/700));
  let a=new Float32Array(n);for(let i=0;i<n;i++)a[i]=p.base[i]/255;
  if(p.mode!=='hd')a=boxMean(a,w,h,1);
  if(p.shift)a=morph(a,w,h,Math.abs(p.shift)*sc,p.shift>0);
  if(p.smooth>0)a=guided(p.gray,a,w,h,Math.max(1,Math.round(p.smooth*sc*1.3)),.0006+p.smooth*.0004);
  const wd=.03+p.soft*.047,lo=.5-wd,hi=.5+wd,ra=new Uint8Array(n);
  for(let i=0;i<n;i++){let t=(a[i]-lo)/(hi-lo);t=t<0?0:t>1?1:t;ra[i]=Math.round(t*t*(3-2*t)*255)}
  p.ra=ra;compose(p);
}
function compose(p,x0=0,y0=0,x1=p.work.width,y1=p.work.height){
  const w=p.work.width,h=p.work.height;
  if(!p.cut){p.cut=mk(w,h);p.cutCtx=p.cut.getContext('2d');p.cutData=p.cutCtx.createImageData(w,h)}
  const d=p.cutData.data,s=p.rgb,ra=p.ra,e=p.edit,[R,Gc,B]=p.bgc,df=p.defringe,mix=p.bgSpread<40?.85:p.bgSpread<70?.5:.25;
  x0=Math.max(0,x0|0);y0=Math.max(0,y0|0);x1=Math.min(w,Math.ceil(x1));y1=Math.min(h,Math.ceil(y1));
  for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){
    const i=y*w+x,j=i*4;let a=ra[i]+e[i];a=a<0?0:a>255?255:a;
    let r=s[j],g=s[j+1],b=s[j+2];
    if(df&&a>4&&a<248){const f=a/255,iv=1-f;
      const r2=clamp((r-iv*R)/f,0,255),g2=clamp((g-iv*Gc)/f,0,255),b2=clamp((b-iv*B)/f,0,255);
      r+=(r2-r)*mix;g+=(g2-g)*mix;b+=(b2-b)*mix}
    d[j]=r;d[j+1]=g;d[j+2]=b;d[j+3]=a;
  }
  if(x1>x0&&y1>y0)p.cutCtx.putImageData(p.cutData,0,0,x0,y0,x1-x0,y1-y0);
}
function paintAt(p,pos){
  const W=ed.width,H=ed.height,g=geo(p,W,H);
  let dx=pos.x-g.cx,dy=pos.y-g.cy;const c=Math.cos(-g.th),s=Math.sin(-g.th);
  const ix=(dx*c-dy*s)/(g.k*g.fx)+g.iw/2,iy=(dx*s+dy*c)/g.k+g.ih/2,R=G.brush/2*G.dpr/g.k;
  const w=p.work.width,h=p.work.height,hd=G.hard,ra=p.ra,e=p.edit,er=G.tool==='erase';
  const x0=Math.max(0,Math.floor(ix-R)),x1=Math.min(w-1,Math.ceil(ix+R)),y0=Math.max(0,Math.floor(iy-R)),y1=Math.min(h-1,Math.ceil(iy+R));
  if(x0>x1||y0>y1)return;
  for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){
    const d=Math.hypot(x-ix,y-iy)/R;if(d>1)continue;let t=d<=hd?1:1-(d-hd)/(1-hd);t=t*t*(3-2*t);const i=y*w+x;
    if(er){const v=-Math.round(t*ra[i]);if(v<e[i])e[i]=v}else{const v=Math.round(t*(255-ra[i]));if(v>e[i])e[i]=v}
  }
  compose(p,x0,y0,x1+1,y1+1);redraw();
}

/* ---------- remove background (UI) ---------- */
const DONE_MSG={gemini:'Done with Gemini. Only the background was cut; the person is as Gemini returned them.',hd:'Done with HD AI. Use Refine edges or the brush for any misses.',fast:'Done with fast AI. Edge snap helps hair look natural.',wall:'Done with wall matching. Adjust Wall match if parts are missing.'};
function finishCut(p,a,used,silent,refit){
  p.base=a;p.mode=used;p.smooth=used==='hd'?1:used==='gemini'?2:used==='fast'?4:3;p.shift=0;p.soft=used==='hd'?7:5;p.edit.fill(0);p.editSnap=null;
  refine(p);p.cutOn=true;sync();thumbs();
  if((refit||!p.touched)&&!silent)autoFit(p,true);
  redraw();commit();busy(false);
  $('#bgStatus').textContent=DONE_MSG[used]||'Done.';
  if(!silent&&!refit)toast('Background removed');
}
function setProg(v,msg){const pr=$('#prog');pr.hidden=false;pr.classList.toggle('indet',v<0);if(v>=0)pr.firstElementChild.style.width=Math.round(v*100)+'%';if(msg){$('#bgStatus').textContent=msg;$('#veilText').textContent=msg}}
function busy(on,msg){$('#veil').hidden=!on;$('#rmbg').classList.toggle('busy',on);$('#autofit').disabled=on;if(!on)$('#prog').hidden=true;if(msg)setProg(-1,msg)}
async function removeBg(silent){
  const p=P();if(!p){toast('Add a photo first.');return false}
  busy(true,'Preparing photo…');await new Promise(r=>setTimeout(r,40));
  try{
    prepare(p);
    const order={hd:['hd','fast','wall'],fast:['fast','wall'],wall:['wall']}[eng()];let a=null,used=null;
    for(const m of order){
      try{
        if(m==='hd'){setProg(-1,'Loading HD model…');a=await timeout(segHD(p),180000,'slow')}
        else if(m==='fast'){setProg(-1,'Loading fast AI…');a=await timeout(segFast(p),30000)}
        else{setProg(-1,'Matching the wall colour…');await new Promise(r=>setTimeout(r,30));a=wallAlpha(p,+$('#tol').value)}
        const f=share(a);if(f<.03||f>.97)throw new Error('mask');used=m;break;
      }catch(err){a=null;if(m==='fast')mpSeg=null;
        if(m!==order[order.length-1])toast(m==='hd'?'HD model unavailable, trying fast AI…':'Fast AI unavailable, trying plain wall…')}
    }
    if(!a)throw new Error('none');
    setProg(-1,'Refining edges…');await new Promise(r=>setTimeout(r,20));
    finishCut(p,a,used,silent);
    return true;
  }catch(e){busy(false);$('#bgStatus').textContent='Could not separate the person from the background. Try Plain wall mode with a higher Wall match, or another photo.';toast('Background removal failed');return false}
}
$('#rmbg').onclick=()=>removeBg();
$('#cutOn').onchange=()=>{const p=P();if(!p)return;if(!p.cut){$('#cutOn').checked=false;toast('Remove the background first.');return}p.cutOn=$('#cutOn').checked;thumbs();redraw();commit()};

/* ---------- Gemini handoff (no API key) ---------- */
const isPhone=()=>matchMedia('(pointer:coarse)').matches&&/Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
function gemState(st,msg){$('#gem').dataset.state=st;if(msg)$('#gemStatus').textContent=msg}
function photoForGemini(p){const im=p.orig||p.img,iw=im.naturalWidth,ih=im.naturalHeight,k=Math.min(1,2048/Math.max(iw,ih)),c=mk(Math.round(iw*k),Math.round(ih*k));c.getContext('2d').drawImage(im,0,0,c.width,c.height);return c}
const blobOf=(c,t,q)=>new Promise(r=>c.toBlob(r,t,q));
async function copyText(t){try{await navigator.clipboard.writeText(t);return true}catch(e){const a=document.createElement('textarea');a.value=t;a.style.position='fixed';a.style.opacity='0';document.body.appendChild(a);a.select();let ok=false;try{ok=document.execCommand('copy')}catch(e2){}a.remove();return ok}}
function openGemini(){const w=window.open(CONFIG.GEMINI_URL,'_blank');if(w){try{w.opener=null}catch(e){}}else toast('Pop-up blocked. Use the “Open Gemini” link in the box.',4000)}
async function sendToGemini(){
  const p=P();if(!p){toast('Add a photo first.');return}
  G.waitGemini=p;const c=photoForGemini(p);
  if(isPhone()&&navigator.canShare){
    const jpg=await blobOf(c,'image/jpeg',.93),file=new File([jpg],'photo.jpg',{type:'image/jpeg'});
    if(navigator.canShare({files:[file]})){
      await copyText(buildPrompt());
      try{await navigator.share({files:[file],text:buildPrompt()});gemState('wait','Shared. In Gemini press send, save the cleaned photo, then tap “Bring the result back”. The prompt is also copied in case Gemini did not fill it in.');return}
      catch(e){if(e.name==='AbortError'){gemState('ready','');return}}
    }
  }
  let copied=false;
  if(navigator.clipboard&&window.ClipboardItem){
    const png=blobOf(c,'image/png');
    try{await navigator.clipboard.write([new ClipboardItem({'image/png':png,'text/plain':new Blob([buildPrompt()],{type:'text/plain'})})]);copied=true}
    catch(e){try{await navigator.clipboard.write([new ClipboardItem({'image/png':png})]);copied=true}catch(e2){}}
  }
  if(!copied){const jpg=await blobOf(c,'image/jpeg',.93),a=document.createElement('a');a.href=URL.createObjectURL(jpg);a.download='photo-for-gemini.jpg';document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),4000);await copyText(buildPrompt())}
  openGemini();
  gemState('wait',copied?'Photo copied. In Gemini press Ctrl V (⌘ V on Mac) to paste it, then send. If the prompt is missing, press “Copy prompt” and paste again. Download the cleaned photo and bring it back here.':'The photo was downloaded and the prompt copied. In Gemini, attach the photo, paste the prompt and send. Then bring the result back here.');
}
async function applyGemini(file){
  const p=G.waitGemini&&photos.includes(G.waitGemini)?G.waitGemini:P();if(!p){addFiles([file]);return}
  if(!file||!file.type.startsWith('image/')){toast('That file is not an image.');return}
  if(photos.indexOf(p)!==cur)select(photos.indexOf(p));
  busy(true,'Reading the Gemini photo…');
  try{
    const url=URL.createObjectURL(file),img=new Image();
    await new Promise((ok,no)=>{img.onload=ok;img.onerror=no;img.src=url});
    if(!p.orig){p.orig=p.img;p.origUrl=p.url}else if(p.url!==p.origUrl)URL.revokeObjectURL(p.url);
    p.img=img;p.url=url;p.work=null;prepare(p);
    setProg(-1,'Cutting out the person…');await new Promise(r=>setTimeout(r,30));
    let a=wallAlpha(p,+$('#tol').value),used='gemini';const f=share(a);
    if(f<.03||f>.97){try{setProg(-1,'Background is not plain, using HD AI…');a=await timeout(segHD(p),180000);used='hd'}catch(e){a=wallAlpha(p,60)}}
    finishCut(p,a,used,false,true);G.waitGemini=null;
    gemState('done','Gemini photo added. Pick a background colour, then print.');toast('Gemini result added');
  }catch(e){busy(false);toast('Could not read that image. Save it from Gemini as PNG or JPG and try again.')}
}

/* ---------- dress looks (fixed prompts) ---------- */
// Each look adds one fixed clothing line to the prompt. Add or edit looks here.
const LOOKS={
  none:     {g:'all',  label:'My clothes',     c:['#9aa4b2','#9aa4b2','#9aa4b2'], text:null},
  m_suit:   {g:'men',  label:'Navy suit & tie', c:['#1f2d4d','#ffffff','#8a1c2b'], text:'a well-fitted dark navy business suit jacket, a crisp plain white dress shirt with a buttoned collar, and a plain dark red tie with a neat knot'},
  m_black:  {g:'men',  label:'Black suit & tie',c:['#141518','#ffffff','#141518'], text:'a well-fitted black business suit jacket, a crisp plain white dress shirt with a buttoned collar, and a plain black tie with a neat knot'},
  m_grey:   {g:'men',  label:'Grey suit & tie', c:['#55595f','#ffffff','#1f2d4d'], text:'a well-fitted charcoal grey business suit jacket, a crisp plain white dress shirt with a buttoned collar, and a plain navy blue tie with a neat knot'},
  m_blazer: {g:'men',  label:'Blazer, no tie',  c:['#2b2f36','#ffffff','#ffffff'], text:'a well-fitted dark charcoal blazer over a plain white dress shirt with the top button open and no tie'},
  m_shirt:  {g:'men',  label:'Shirt & tie',     c:['#cfe0f5','#cfe0f5','#1f2d4d'], text:'a plain light blue formal dress shirt with a buttoned collar and a plain navy blue tie with a neat knot, no jacket'},
  w_black:  {g:'women',label:'Black blazer',    c:['#141518','#ffffff','#141518'], text:'a tailored black formal blazer over a plain white blouse with a modest, high neckline'},
  w_navy:   {g:'women',label:'Navy blazer',     c:['#1f2d4d','#eef2f7','#1f2d4d'], text:'a tailored navy blue formal blazer over a plain light blouse with a modest, high neckline'},
  w_blouse: {g:'women',label:'Formal blouse',   c:['#2a2f3a','#2a2f3a','#2a2f3a'], text:'a plain, modest formal blouse in a solid dark charcoal colour with a high neckline and long sleeves'},
  w_saree:  {g:'women',label:'Formal saree',    c:['#7a1f3d','#d9b26a','#7a1f3d'], text:'an elegant plain solid maroon formal saree with a thin gold border and a matching blouse, draped neatly over one shoulder'},
  w_salwar: {g:'women',label:'Salwar kameez',   c:['#23456b','#23456b','#e9edf2'], text:'a plain, modest formal salwar kameez top in a solid dark blue colour with a neat round neckline and a light dupatta resting neatly on the shoulders'}
};
function buildPrompt(){
  const L=LOOKS[G.look]||LOOKS.none;
  if(!L.text)return GEMINI_PROMPT;
  return `Edit this photo for an official passport/ID photo. Change ONLY the clothing and the background.

Clothing:
- Dress the person in ${L.text}.
- Fit the new clothes naturally to the person's existing neck, shoulders, posture and body size, with realistic fabric and lighting that matches the face.
- If the person wears a hijab, headscarf, turban, cap worn for religious reasons, or glasses, keep them exactly as they are.

Strict rules:
- Keep the face and head 100% unchanged: same identity, facial features, face shape, eyes, nose, lips, skin tone, skin texture, expression, hair, hairline and ears.
- Do not beautify, retouch, slim, reshape, smooth skin, change age or change makeup.
- Keep the exact same framing, camera angle, crop, position and scale of the person. Do not zoom, rotate, move or re-pose.
- Replace everything behind the person with a perfectly flat, uniform pure white background (#FFFFFF), with no shadows, gradients, vignette, texture, objects or other people.
- Keep the photo sharp, clear and true to colour.
- Output a single photorealistic image only, with no text, borders or watermarks.`;
}
function renderLooks(){
  const g=$('input[name=gender]:checked').value;
  $('#looks').innerHTML=Object.entries(LOOKS).filter(([,L])=>L.g==='all'||L.g===g).map(([k,L])=>
    `<button class="chip${G.look===k?' on':''}" data-look="${k}" aria-pressed="${G.look===k}"><i style="--a:${L.c[0]};--b:${L.c[1]};--t:${L.c[2]}"></i>${L.label}</button>`).join('');
  $('#gemText').textContent=buildPrompt();
  $('#gemSend').lastChild.textContent=G.look==='none'?'Send photo to Gemini':`Send with ${LOOKS[G.look].label.toLowerCase()}`;
}
function setLook(k){G.look=LOOKS[k]?k:'none';try{localStorage.setItem('pps-look',G.look)}catch(e){}renderLooks()}
$('#looks').addEventListener('click',e=>{const b=e.target.closest('[data-look]');if(b)setLook(b.dataset.look)});
$$('input[name=gender]').forEach(r=>r.addEventListener('change',()=>{try{localStorage.setItem('pps-gender',r.value)}catch(e){}
  if(LOOKS[G.look].g!=='all'&&LOOKS[G.look].g!==r.value)G.look='none';renderLooks()}));
try{const g=localStorage.getItem('pps-gender');if(g)$(`input[name=gender][value=${g}]`).checked=true;G.look=localStorage.getItem('pps-look')||'none';if(!LOOKS[G.look])G.look='none'}catch(e){G.look='none'}

$('#gemSend').onclick=sendToGemini;
$('#gemPrompt').onclick=async()=>{toast(await copyText(buildPrompt())?'Prompt copied. Paste it in Gemini.':'Copy failed. Open “See the prompt” and copy it by hand.')};
$('#gemBack').onclick=()=>{if(!P()){toast('Add a photo first.');return}if(!G.waitGemini)G.waitGemini=P();$('#gemFile').click()};
$('#gemFile').onchange=e=>{const f=e.target.files[0];e.target.value='';if(f)applyGemini(f)};
renderLooks();
if(isPhone())$('#gemHow').textContent='Tap Send, choose Gemini in the share menu, and send. Save the cleaned photo, then tap Bring the result back.';

/* ---------- auto-fit face ---------- */
function autoFit(p,quiet){
  const im=p.cut,odd=p.q%2,dw=odd?im.height:im.width,dh=odd?im.width:im.height,s=Math.min(1,320/Math.max(dw,dh));
  const cw=Math.round(dw*s),chh=Math.round(dh*s),c=mk(cw,chh),x=c.getContext('2d',{willReadFrequently:true});
  x.translate(cw/2,chh/2);x.rotate(p.q*Math.PI/2);x.scale(s*(p.flip?-1:1),s);x.drawImage(im,-im.width/2,-im.height/2);
  const d=x.getImageData(0,0,cw,chh).data,minX=new Int32Array(chh).fill(-1),maxX=new Int32Array(chh).fill(-1),wid=new Float32Array(chh);
  for(let y=0;y<chh;y++){let a=-1,b=-1;for(let xx=0;xx<cw;xx++)if(d[(y*cw+xx)*4+3]>128){if(a<0)a=xx;b=xx}minX[y]=a;maxX[y]=b;wid[y]=a<0?0:b-a+1}
  let top=-1;for(let y=0;y<chh;y++)if(wid[y]>cw*.03){top=y;break}
  if(top<0){if(!quiet)toast('Could not find a person in this photo.');return false}
  let maxW=0,y=top,cxs=0,cn=0;
  for(;y<chh;y++){if(wid[y]>maxW)maxW=wid[y];if(y-top>maxW*1.0&&maxW>0)break;if(wid[y]>0){cxs+=(minX[y]+maxX[y])/2;cn++}}
  let headH=maxW*1.36;
  let neckY=-1,neckW=1e9;for(let yy=Math.round(top+maxW*1.05);yy<Math.min(chh,top+maxW*2.1);yy++){if(wid[yy]>0&&wid[yy]<neckW){neckW=wid[yy];neckY=yy}}
  if(neckY>0&&neckW<maxW*.85){const h2=(neckY-top)*.92;if(Math.abs(h2/headH-1)<.3)headH=(headH+h2)/2}
  const ax=(cn?cxs/cn:cw/2)-cw/2,ay=top+headH/2-chh/2;
  const W=1,H=S.h/S.w,b=guideBox(W,H),k=(2*b.ry)/(headH/s);
  const base=Math.max(W/dw,H/dh),zoom=clamp(k/base,.3,4),kk=zoom*base;
  const ang=p.ang*Math.PI/180,vx=(ax/s)*kk,vy=(ay/s)*kk,rx=vx*Math.cos(ang)-vy*Math.sin(ang),ry=vx*Math.sin(ang)+vy*Math.cos(ang);
  p.zoom=zoom;p.ox=(W/2-rx-W/2)/W;p.oy=(b.cy-ry-H/2)/H;p.headPx=headH/s;p.touched=true;
  sync();redraw();if(!quiet)toast('Face framed to the guide');else toast('Background removed and face framed');
  return true;
}
$('#autofit').onclick=async()=>{const p=P();if(!p){toast('Add a photo first.');return}
  if(!p.cut){const ok=await removeBg(true);if(!ok)return}
  if(autoFit(p))commit()};

/* ---------- page fill + export ---------- */
function capN(){const g=grid();return g.cols*g.rows}
$('#fill').onclick=()=>{const p=P();if(!p){toast('Add a photo first.');return}const others=photos.reduce((a,q)=>a+(q===p?0:q.copies),0);p.copies=Math.max(0,capN()-others);thumbs();updateSheet();toast(`${p.copies} copies on the page`)};
$('#split').onclick=()=>{if(!photos.length)return;const n=photos.length,c=capN();photos.forEach((p,i)=>p.copies=Math.floor(c/n)+(i<c%n?1:0));thumbs();updateSheet()};
function done(){G.exported=true;updateChecks()}
function save(cv,name,type){cv.toBlob(b=>{if(!b){toast('Export failed.');return}const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),4000);done()},type,.95)}
function full(){const c=mk(1,1);drawSheet(c,300/25.4);return c}
function needPhotos(){if(!photos.some(p=>p.copies>0)){toast('Set at least one copy, or press Fill page.');return false}return true}
$('#dlPng').onclick=()=>{if(needPhotos())save(full(),'passport-sheet.png','image/png')};
$('#dlJpg').onclick=()=>{if(needPhotos())save(full(),'passport-sheet.jpg','image/jpeg')};
$('#dlOne').onclick=()=>{const p=P();if(!p)return toast('Add a photo first.');const c=mk(Math.round(S.w/25.4*300),Math.round(S.h/25.4*300));drawPhoto(p,c.getContext('2d'),c.width,c.height);save(c,`passport-${S.w}x${S.h}mm.jpg`,'image/jpeg')};
$('#dlCut').onclick=()=>{const p=P();if(!p||!p.cut)return toast('Remove the background first.');const c=mk(Math.round(S.w/25.4*300),Math.round(S.h/25.4*300)),was=p.cutOn;p.cutOn=true;drawPhoto(p,c.getContext('2d'),c.width,c.height,{transparent:true,noLabel:true});p.cutOn=was;save(c,`passport-cutout-${S.w}x${S.h}mm.png`,'image/png')};
let jspdfP=null;
$('#dlPdf').onclick=async()=>{
  if(!needPhotos())return;const btn=$('#dlPdf');btn.classList.add('busy');
  try{
    if(!window.jspdf){jspdfP=jspdfP||loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js');await jspdfP}
    const {W,H}=paper(),c=full(),doc=new window.jspdf.jsPDF({unit:'mm',format:[W,H],orientation:W>H?'landscape':'portrait',compress:true});
    doc.addImage(c.toDataURL('image/jpeg',.95),'JPEG',0,0,W,H);doc.save('passport-sheet.pdf');done();toast('PDF saved. Print at 100% scale.');
  }catch(e){jspdfP=null;toast('PDF export needs an internet connection the first time. Try PNG instead.')}
  btn.classList.remove('busy');
};
$('#print').onclick=()=>{if(!needPhotos())return;const {W,H}=paper();let st=$('#pst');if(!st){st=document.createElement('style');st.id='pst';document.head.appendChild(st)}
  st.textContent=`@page{size:${W}mm ${H}mm;margin:0}@media print{#printArea{width:${W}mm;height:${H}mm}}`;
  const img=$('#printArea img');img.onload=()=>{setTimeout(()=>window.print(),60);done()};img.src=full().toDataURL('image/png')};

/* ---------- size ---------- */
function setSize(){
  const v=$('#size').value;$('#custom').hidden=v!=='c';
  if(v==='c'){S.w=clamp(+$('#cw').value||35,10,200);S.h=clamp(+$('#ch').value||45,10,200);S.hr=.7}else{const s=SIZES[v]||SIZES[0];S.w=s[1];S.h=s[2];S.hr=s[3]}
  refreshAll();savePrefs();
  const p=P();if(p&&p.headPx&&p.cut){autoFit(p,true);commit()}
}
['size','cw','ch'].forEach(k=>$('#'+k).addEventListener('input',setSize));

/* ---------- nav ---------- */
function go(id){document.getElementById(id).scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'start'})}
$$('[data-go]').forEach(b=>b.addEventListener('click',()=>go(b.dataset.go)));
if('IntersectionObserver' in window){const io=new IntersectionObserver(es=>{es.forEach(e=>{if(e.isIntersecting)$$('.mnav button').forEach(b=>b.classList.toggle('on',b.dataset.go===e.target.id))})},{rootMargin:'-45% 0px -50% 0px'});['secPhotos','secFrame','secBg','secPrint'].forEach(id=>io.observe(document.getElementById(id)))}

let rzT=0;window.addEventListener('resize',()=>{clearTimeout(rzT);rzT=setTimeout(()=>{sizeEditor();redraw()},80)});
if(document.fonts&&document.fonts.ready)document.fonts.ready.then(()=>redraw());
{const y=document.getElementById('yr');if(y)y.textContent=new Date().getFullYear()}
loadPrefs();engNote();setSize();outs();thumbs();