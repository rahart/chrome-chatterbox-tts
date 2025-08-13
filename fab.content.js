// fab.content.js
(function(){
    if (window.__chatterbox_fab__) return;
    window.__chatterbox_fab__ = true;
  
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;top:96px;left:12px;z-index:2147483647;width:64px;pointer-events:none';
    document.documentElement.appendChild(host);
    const root = host.attachShadow({mode:'open'});
  
    const style = document.createElement('style');
    style.textContent = `
      .pill{pointer-events:auto;display:flex;flex-direction:column;align-items:center;gap:12px;
        padding:10px;border-radius:999px;backdrop-filter:blur(8px);
        background:radial-gradient(120% 120% at 0% 0%, rgba(255,200,80,.25), rgba(30,30,35,.6) 50%, rgba(15,15,20,.7) 100%);
        border:1px solid rgba(255,255,255,.12);box-shadow:0 8px 24px rgba(0,0,0,.35), inset 0 1px 0 rgba(255,255,255,.06);}
      .btn{width:44px;height:44px;border-radius:50%;display:grid;place-items:center;cursor:pointer;
        border:1px solid rgba(255,255,255,.12);background:rgba(30,30,35,.65);transition:transform .12s ease}
      .btn:hover{transform:translateY(-1px)}
      .primary{background:rgba(70,90,255,.9)}
      .timer{font:600 12px system-ui;color:#CDE;background:rgba(25,25,30,.7);padding:6px 10px;border-radius:12px;border:1px solid rgba(255,255,255,.12);min-width:44px;text-align:center}
      .badge{font:600 11px system-ui;color:#FFC;background:linear-gradient(180deg,#A36F00,#6A4700);border:1px solid rgba(255,255,255,.18);padding:3px 8px;border-radius:999px}
    `;
    root.appendChild(style);
  
    const pill = document.createElement('div'); pill.className='pill';
    const badge = document.createElement('div'); badge.className='badge'; badge.textContent='Update';
    const timer = document.createElement('div'); timer.className='timer'; timer.textContent='0:00';
    const play = document.createElement('button'); play.className='btn primary'; play.innerHTML='►';
    const readSel = document.createElement('button'); readSel.className='btn'; readSel.title='Read selection'; readSel.textContent='⟲';
    const queuePg = document.createElement('button'); queuePg.className='btn'; queuePg.title='Queue page'; queuePg.textContent='★';
    const ga = document.createElement('button'); ga.className='btn'; ga.title='Global Auto'; ga.textContent='GA';
  
    pill.append(badge,timer,play,readSel,queuePg,ga); root.appendChild(pill);
  
    // Helper: ensure extension context
    function extAlive(){ return !!(chrome.runtime && chrome.runtime.id); }
  
    // Dragging + snap
    let dragging=false, sx=0, sy=0, sl=0, st=0;
    pill.addEventListener('pointerdown', (e)=>{dragging=true;sx=e.clientX;sy=e.clientY;const r=host.getBoundingClientRect();sl=r.left;st=r.top;});
    window.addEventListener('pointermove', (e)=>{ if(!dragging) return; host.style.left=(sl+e.clientX-sx)+'px'; host.style.top=(st+e.clientY-sy)+'px';});
    window.addEventListener('pointerup', ()=>{ if(!dragging)return; dragging=false;
      const vw=innerWidth, r=host.getBoundingClientRect(); host.style.left = (r.left < vw/2) ? '12px' : (vw - r.width - 12)+'px';
      try { if (extAlive()) chrome.storage.sync.set({fabPos:{left:host.style.left, top:host.style.top}}); } catch(_) {}
    });
  
    // Restore position
    try {
      if (extAlive()) chrome.storage.sync.get('fabPos', ({fabPos})=>{
        if (fabPos) { host.style.left=fabPos.left; host.style.top=fabPos.top; }
      });
    } catch(_) {}
  
    // Wire controls
    play.addEventListener('click', async ()=>{
      if (!extAlive()) return;
      try {
        const resp = await chrome.runtime.sendMessage({type:'tts:toggle'});
        play.textContent = (resp && resp.playing) ? '❚❚' : '►';
      } catch(_) {}
    });
  
    readSel.addEventListener('click', async ()=>{
      const text = getSelection()?.toString().trim();
      if (!text || !extAlive()) return;
      try { await chrome.runtime.sendMessage({type:'tts:enqueue', text}); } catch(_) {}
    });
  
    queuePg.addEventListener('click', async ()=>{
      const text = extractArticle();
      if (!text || !extAlive()) return;
      try { await chrome.runtime.sendMessage({type:'tts:enqueue', text}); } catch(_) {}
    });
  
    // Listen for state updates and read-page requests
    try {
      chrome.runtime.onMessage.addListener((msg)=>{
        if (!msg) return;
        if (msg.type === 'tts:state') play.textContent = msg.playing ? '❚❚' : '►';
        if (msg.type === 'tts:elapsed') timer.textContent = formatTime(msg.elapsedMs || 0);
        if (msg.type === 'tts:enqueuePage') {
          const text = extractArticle();
          if (text && extAlive()) chrome.runtime.sendMessage({ type: 'tts:enqueue', text }).catch(()=>{});
        }
      });
    } catch(_) {}
  
    // helpers
    const formatTime = ms => `${Math.floor(ms/1000/60)}:${String(Math.floor(ms/1000)%60).padStart(2,'0')}`;
    function extractArticle() {
      // simple readable text fallback
      const root = document.querySelector('article') || document.body;
      let out=''; const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) out += walker.currentNode.nodeValue.replace(/\s+/g,' ').trim() + ' ';
      return out.trim();
    }
  })();