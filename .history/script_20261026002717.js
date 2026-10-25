/* ============================================================
   Passport Photo Studio · script.js
   ============================================================ */
"use strict";

/* ---------- settings you can change ---------- */
const CONFIG={
  // Leave empty so each visitor pastes their own key (saved in their browser).
  // If you put a key here, anyone who opens the page can read it.
  GEMINI_API_KEY:'',
  // Optional: your own server that forwards requests to Gemini and adds the key.
  // When set, the page posts to `${PROXY_URL}/${model}:generateContent` and sends no key.
  PROXY_URL:'',
  // Free models find the person's outline and keep every original pixel.
  // Paid image models (names with "banana" or "image") redraw the background instead.
  DEFAULT_MODEL:'gemini-3.8-flash',
  API_BASES:['https://generativelanguage.googleapis.com/v1','https://generativelanguage.googleapis.com/v1beta'],
  TIMEOUT_MS:120000
};

/* Fixed prompt for the FREE models: ask for the person's outline only. */
const MASK_PROMPT=`Give the segmentation mask for the main person in this photo.
Include the whole visible person: all of the hair including loose strands, the face, ears, neck, shoulders, body, clothing and anything they wear.
Do not include the background, walls, furniture, shadows or any other people.
Output a JSON list of segmentation masks where each entry contains the 2D bounding box in the key "box_2d", the segmentation mask in key "mask", and the text label in the key "label". Use the label "person".
Trace the outline very precisely with many points, closely following the edge of the hair, ears and shoulders.`;

/* Fixed prompt for the PAID image models. It is sent with every photo and cannot be changed from the page. */
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
const G={bg:'#ffffff',guide:true,tool:'move',brush:40,hard:.55,compare:false,hover:null,dpr:1,exported:false};
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
  $('#bgMode').textContent=p&&p.cutOn?({gmask:'Gemini',gemini:'Gemini',hd:'HD AI',fast:'Fast AI',wall:'Plain wall'}[p.mode]||'Cutout'):'Original';
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
document.addEventListener('drop',e=>{if(e.dataTransfer&&e.dataTransfer.files.length)addFiles(e.dataTransfer.files)});
document.addEventListener('paste',e=>{const f=[...(e.clipboardData?.files||[])];if(f.length){addFiles(f)}});

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
function engNote(){$('#keyBox').hidden=eng()!=='gemini'||!!CONFIG.PROXY_URL;$('#engNote').textContent={gemini:'Most accurate. Gemini finds the exact outline of the person and the page cuts it from your original photo, so the face and body are never changed. Free key, needs internet.',hd:'Best edges and hair. Downloads about 40 MB the first time, then runs offline.',fast:'Quick person detection. Good on phones and slow connections.',wall:'No download. Works when you stand in front of a plain wall.'}[eng()]}

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
/* ---------- Gemini ---------- */
function getKey(){if(CONFIG.GEMINI_API_KEY)return CONFIG.GEMINI_API_KEY;try{return localStorage.getItem('pps-gemini-key')||''}catch(e){return $('#gkey').value.trim()}}
function getModel(){return $('#gmodel').value||CONFIG.DEFAULT_MODEL}
const RATIOS=[['1:1',1],['2:3',2/3],['3:2',1.5],['3:4',.75],['4:3',4/3],['4:5',.8],['5:4',1.25],['9:16',9/16],['16:9',16/9]];
function nearestRatio(r){let b=RATIOS[0],d=1e9;RATIOS.forEach(x=>{const e=Math.abs(Math.log(r/x[1]));if(e<d){d=e;b=x}});return b[0]}
function srcForGemini(p){const im=p.orig||p.img,iw=im.naturalWidth,ih=im.naturalHeight,k=Math.min(1,2048/Math.max(iw,ih)),c=mk(Math.round(iw*k),Math.round(ih*k));c.getContext('2d').drawImage(im,0,0,c.width,c.height);return c}
async function callGemini(body,model){
  const key=getKey(),urls=CONFIG.PROXY_URL?[`${CONFIG.PROXY_URL.replace(/\/$/,'')}/${model}:generateContent`]:CONFIG.API_BASES.map(b=>`${b}/models/${model}:generateContent`);
  let last;
  for(const u of urls){
    const ctl=new AbortController(),t=setTimeout(()=>ctl.abort(),CONFIG.TIMEOUT_MS);
    try{
      const h={'Content-Type':'application/json'};if(!CONFIG.PROXY_URL)h['x-goog-api-key']=key;
      const r=await fetch(u,{method:'POST',headers:h,body:JSON.stringify(body),signal:ctl.signal});
      const j=await r.json().catch(()=>({}));
      if(r.ok)return j;
      last=new Error(r.status===429?'Free limit reached for now. Wait a minute and try again.':r.status===403||r.status===401?'The API key was not accepted. Check it and save again.':(j.error?.message||('HTTP '+r.status)));last.status=r.status;
      if(r.status!==404)throw last;
    }catch(e){if(e.name==='AbortError'){const x=new Error('Gemini took too long. Try again.');x.status=408;throw x}throw e}
    finally{clearTimeout(t)}
  }
  throw last;
}
async function segGemini(p){
  if(!getKey()&&!CONFIG.PROXY_URL){const e=new Error('Add your Gemini API key first.');e.nokey=true;throw e}
  const src=srcForGemini(p),b64=src.toDataURL('image/jpeg',.93).split(',')[1],model=getModel();
  const make=size=>({contents:[{role:'user',parts:[{text:GEMINI_PROMPT},{inline_data:{mime_type:'image/jpeg',data:b64}}]}],
    generationConfig:{responseModalities:['TEXT','IMAGE'],temperature:0.2,imageConfig:Object.assign({aspectRatio:nearestRatio(src.width/src.height)},size?{imageSize:size}:{})}});
  setProg(-1,'Gemini is cleaning the background…');
  let j;
  try{j=await callGemini(make(model.includes('lite')?null:'2K'),model)}
  catch(e){if(e.status===400&&!e.nokey)j=await callGemini(make(null),model);else throw e}
  const cand=j.candidates&&j.candidates[0],parts=(cand&&cand.content&&cand.content.parts)||[];
  const img=parts.find(x=>!x.thought&&(x.inlineData||x.inline_data));
  if(!img){const why=cand&&cand.finishReason&&cand.finishReason!=='STOP'?` (${cand.finishReason})`:j.promptFeedback?.blockReason?` (${j.promptFeedback.blockReason})`:'';throw new Error('Gemini did not return an image'+why+'. Try another photo.')}
  const d=img.inlineData||img.inline_data,mime=d.mimeType||d.mime_type||'image/png';
  const out=new Image();await new Promise((ok,no)=>{out.onload=ok;out.onerror=()=>no(new Error('Could not read the Gemini image.'));out.src=`data:${mime};base64,${d.data}`});
  if(!p.orig)p.orig=p.img;
  p.img=out;p.work=null;prepare(p);
  setProg(-1,'Building the cutout…');await new Promise(r=>setTimeout(r,20));
  return wallAlpha(p,+$('#tol').value);
}

const isPaidModel=m=>/banana|image/.test(m);
function parseItems(t){
  t=String(t||'').replace(/```json|```/g,'').trim();
  let j=null;try{j=JSON.parse(t)}catch(e){const a=t.indexOf('['),b=t.lastIndexOf(']');if(a>=0&&b>a){try{j=JSON.parse(t.slice(a,b+1))}catch(e2){}}}
  if(!j)return[];if(!Array.isArray(j))j=j.boxes||j.masks||j.items||j.segmentation_masks||[j];
  return j.filter(x=>x&&x.box_2d);
}
function polys(mask){ // returns list of point lists
  if(!Array.isArray(mask)||!mask.length)return[];
  if(Array.isArray(mask[0])&&Array.isArray(mask[0][0]))return mask.filter(a=>a.length>=3);
  if(Array.isArray(mask[0]))return mask.length>=3?[mask]:[];
  if(typeof mask[0]==='number'){const o=[];for(let i=0;i+1<mask.length;i+=2)o.push([mask[i],mask[i+1]]);return o.length>=3?[o]:[]}
  if(typeof mask[0]==='object'&&'x' in mask[0])return[mask.map(q=>[q.x,q.y])];
  return[];
}
function fitPoints(list,box){ // pick the reading of the points that best matches the box
  const [y0,x0,y1,x1]=box,bw=x1-x0,bh=y1-y0,all=list.flat();
  const ways=[q=>[q[0],q[1]],q=>[q[1],q[0]],q=>[x0+q[0]/1000*bw,y0+q[1]/1000*bh],q=>[x0+q[1]/1000*bw,y0+q[0]/1000*bh]];
  let best=ways[0],bs=-1;
  ways.forEach(f=>{let a=1e9,b=1e9,c=-1e9,d=-1e9;all.forEach(q=>{const [x,y]=f(q);a=Math.min(a,x);b=Math.min(b,y);c=Math.max(c,x);d=Math.max(d,y)});
    const ix=Math.max(0,Math.min(c,x1)-Math.max(a,x0)),iy=Math.max(0,Math.min(d,y1)-Math.max(b,y0)),I=ix*iy,U=(c-a)*(d-b)+bw*bh-I,sc=U>0?I/U:0;if(sc>bs){bs=sc;best=f}});
  return list.map(l=>l.map(best));
}
async function maskFromItem(it,w,h){
  const c=mk(w,h),x=c.getContext('2d',{willReadFrequently:true}),[y0,x0,y1,x1]=it.box_2d.map(Number);
  x.fillStyle='#fff';
  if(typeof it.mask==='string'&&it.mask.startsWith('data:image')){
    const im=new Image();await new Promise((ok,no)=>{im.onload=ok;im.onerror=no;im.src=it.mask});
    x.drawImage(im,x0/1000*w,y0/1000*h,(x1-x0)/1000*w,(y1-y0)/1000*h);
    const d=x.getImageData(0,0,w,h).data,a=new Uint8Array(w*h);for(let i=0;i<a.length;i++)a[i]=d[i*4]>127?255:0;return a;
  }
  const ps=polys(it.mask);if(!ps.length)return null;
  x.beginPath();fitPoints(ps,[y0,x0,y1,x1]).forEach(l=>{l.forEach(([px,py],i)=>{const X=px/1000*w,Y=py/1000*h;i?x.lineTo(X,Y):x.moveTo(X,Y)});x.closePath()});x.fill('nonzero');
  const d=x.getImageData(0,0,w,h).data,a=new Uint8Array(w*h);for(let i=0;i<a.length;i++)a[i]=d[i*4+3]>127?255:0;return a;
}
function bandMorph(a,w,h,r,grow){ // fast min/max on a quarter-size grid
  const k=4,sw=Math.ceil(w/k),shh=Math.ceil(h/k),sm=new Float32Array(sw*shh);
  for(let y=0;y<shh;y++)for(let x=0;x<sw;x++)sm[y*sw+x]=a[Math.min(h-1,y*k+1)*w+Math.min(w-1,x*k+1)]/255;
  const m=morph(sm,sw,shh,Math.max(1,Math.round(r/k)),grow),o=new Uint8Array(w*h);
  for(let y=0;y<h;y++){const ro=(y/k|0)*sw;for(let x=0;x<w;x++)o[y*w+x]=m[ro+(x/k|0)]>.5?1:0}
  return o;
}
async function segGeminiMask(p){
  if(!getKey()&&!CONFIG.PROXY_URL){const e=new Error('Add your free Gemini API key first.');e.nokey=true;throw e}
  const w=p.work.width,h=p.work.height,k=Math.min(1,1536/Math.max(w,h)),s=mk(Math.round(w*k),Math.round(h*k));
  s.getContext('2d').drawImage(p.work,0,0,s.width,s.height);
  const data=s.toDataURL('image/jpeg',.92).split(',')[1],model=getModel();
  const make=think=>({contents:[{role:'user',parts:[{inline_data:{mime_type:'image/jpeg',data}},{text:MASK_PROMPT}]}],
    generationConfig:Object.assign({temperature:0.1,responseMimeType:'application/json'},think?{thinkingConfig:{thinkingLevel:'minimal'}}:{})});
  setProg(-1,'Gemini is finding the person…');
  let j;try{j=await callGemini(make(true),model)}catch(e){if(e.status===400)j=await callGemini(make(false),model);else throw e}
  const parts=(j.candidates?.[0]?.content?.parts||[]).filter(x=>x.text&&!x.thought),items=parseItems(parts.map(x=>x.text).join(''));
  if(!items.length)throw new Error('Gemini did not find a person in this photo.');
  let best=null,bn=0;
  for(const it of items){if(it.label&&/background|wall/i.test(it.label))continue;const a=await maskFromItem(it,w,h).catch(()=>null);if(!a)continue;let n=0;for(let i=0;i<a.length;i+=5)if(a[i])n++;if(n>bn){bn=n;best=a}}
  if(!best)throw new Error('Gemini returned an outline the page could not read. Try again.');
  p._gfine=false;
  if($('#fine').checked){
    try{
      setProg(-1,'Adding fine hair detail…');
      const hd=await timeout(segHD(p),180000,'slow'),r=Math.round(Math.max(w,h)*.025);
      const inner=bandMorph(best,w,h,r,false),outer=bandMorph(best,w,h,r,true),o=new Uint8Array(w*h);
      for(let i=0;i<o.length;i++)o[i]=inner[i]?Math.max(hd[i],235):outer[i]?hd[i]:0;
      p._gfine=true;return o;
    }catch(e){/* keep Gemini outline only */}
  }
  return best;
}

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
  if(p.mode!=='hd'&&!(p.mode==='gmask'&&p._gfine))a=boxMean(a,w,h,1);
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
function setProg(v,msg){const pr=$('#prog');pr.hidden=false;pr.classList.toggle('indet',v<0);if(v>=0)pr.firstElementChild.style.width=Math.round(v*100)+'%';if(msg){$('#bgStatus').textContent=msg;$('#veilText').textContent=msg}}
function busy(on,msg){$('#veil').hidden=!on;$('#rmbg').classList.toggle('busy',on);$('#autofit').disabled=on;if(!on)$('#prog').hidden=true;if(msg)setProg(-1,msg)}
async function removeBg(silent){
  const p=P();if(!p){toast('Add a photo first.');return false}
  busy(true,'Preparing photo…');await new Promise(r=>setTimeout(r,40));
  try{
    prepare(p);
    const order={gemini:['gemini','hd','fast','wall'],hd:['hd','fast','wall'],fast:['fast','wall'],wall:['wall']}[eng()];let a=null,used=null;
    for(const m of order){
      try{
        if(m==='gemini'){a=isPaidModel(getModel())?await segGemini(p):await segGeminiMask(p)}
        else if(m==='hd'){setProg(-1,'Loading HD model…');a=await timeout(segHD(p),180000,'slow')}
        else if(m==='fast'){setProg(-1,'Loading fast AI…');a=await timeout(segFast(p),30000)}
        else{setProg(-1,'Matching the wall colour…');await new Promise(r=>setTimeout(r,30));a=wallAlpha(p,+$('#tol').value)}
        const f=share(a);if(f<.03||f>.97)throw new Error('mask');used=m==='gemini'&&!isPaidModel(getModel())?'gmask':m;break;
      }catch(err){a=null;if(m==='fast')mpSeg=null;
        if(m==='gemini'){if(err.nokey){busy(false);$('#bgStatus').textContent=err.message;toast(err.message);$('#gkey').focus();return false}
          $('#bgStatus').textContent='Gemini: '+err.message;toast('Gemini failed: '+err.message.slice(0,90)+' Using HD AI instead.',4200);continue}
        if(m!==order[order.length-1])toast(m==='hd'?'HD model unavailable, trying fast AI…':'Fast AI unavailable, trying plain wall…')}
    }
    if(!a)throw new Error('none');
    setProg(-1,'Refining edges…');await new Promise(r=>setTimeout(r,20));
    p.base=a;p.mode=used;p.smooth=used==='hd'?1:used==='gmask'?(p._gfine?1:4):used==='gemini'?2:used==='fast'?4:3;p.shift=0;p.soft=used==='hd'||(used==='gmask'&&p._gfine)?7:used==='gmask'?4:5;p.edit.fill(0);p.editSnap=null;
    refine(p);p.cutOn=true;sync();thumbs();
    if(!p.touched&&!silent)autoFit(p,true);
    redraw();commit();busy(false);
    $('#bgStatus').textContent=used==='gmask'?(p._gfine?'Done with Gemini and HD hair detail. Your original pixels are untouched.':'Done with Gemini. Your original pixels are untouched. Use Refine edges or the brush for any misses.'):used==='gemini'?'Done with Gemini. The face and body are untouched; only the background changed.':used==='hd'?'Done with HD AI. Use Refine edges or the brush for any misses.':used==='fast'?'Done with fast AI. Edge snap helps hair look natural.':'Done with wall matching. Adjust Wall match if parts are missing.';
    if(!silent)toast('Background removed');
    return true;
  }catch(e){busy(false);$('#bgStatus').textContent='Could not separate the person from the background. Try Plain wall mode with a higher Wall match, or another photo.';toast('Background removal failed');return false}
}
$('#rmbg').onclick=()=>removeBg();
$('#cutOn').onchange=()=>{const p=P();if(!p)return;if(!p.cut){$('#cutOn').checked=false;toast('Remove the background first.');return}p.cutOn=$('#cutOn').checked;thumbs();redraw();commit()};

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
function keyUI(){const k=getKey();$('#keyBox').classList.toggle('saved',!!k);if(k&&!$('#gkey').value)$('#gkey').value=k;
  if(CONFIG.GEMINI_API_KEY){$('#gkey').disabled=true;$('#gsave').disabled=true;$('#keyNote').textContent='A key is set by the site owner.'}}
$('#gsave').onclick=()=>{const v=$('#gkey').value.trim();try{v?localStorage.setItem('pps-gemini-key',v):localStorage.removeItem('pps-gemini-key')}catch(e){}keyUI();toast(v?'Gemini key saved in this browser':'Gemini key removed')};
$('#gkey').addEventListener('keydown',e=>{if(e.key==='Enter')$('#gsave').click()});
$('#gmodel').addEventListener('change',()=>{try{localStorage.setItem('pps-gemini-model',$('#gmodel').value)}catch(e){}});
try{const m=localStorage.getItem('pps-gemini-model');if(m&&[...$('#gmodel').options].some(o=>o.value===m))$('#gmodel').value=m;else $('#gmodel').value=CONFIG.DEFAULT_MODEL}catch(e){}
keyUI();loadPrefs();engNote();setSize();outs();thumbs();