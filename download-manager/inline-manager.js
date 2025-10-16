// Inline Download Manager for Loom (no ESM import required)
// Provides window.globalDownloadManager and a minimal compatibility layer

(function(){
  const ACCENT = '#625df5';
  // Local touch registry used to debounce/guard storage hydration from
  // removing items that were just added/updated via direct runtime messages.
  const __dmLocalTouch = new Map(); // id -> timestamp
  let __dmHydrateTimer = null;
  const __dmMissingSince = new Map();
  let __dmSnapshotTimer = null;
  const SNAPSHOT_REMOVE_GRACE_MS = 1800;
  const SNAPSHOT_THROTTLE_MS = 1500;
  let applyQueueSnapshot = () => {};
  let requestQueueSnapshot = () => {};

  class DownloadManagerState {
    constructor(config={}){ this.config=config; this.active=new Map(); this.isCollapsed=false; this.listeners=new Map(); }
    on(ev,cb){ if(!this.listeners.has(ev)) this.listeners.set(ev,new Set()); this.listeners.get(ev).add(cb); }
    emit(ev,...a){ const s=this.listeners.get(ev); if(s) s.forEach(cb=>{try{cb(...a)}catch{}}); }
    get(id){ return this.active.get(id)||null; }
    getAll(){ return new Map(this.active); }
    stats(){ const all=[...this.active.values()]; const active=all.filter(i=>!i.isCompleted&&!i.isCancelled); return { total:all.length, active:active.length, hasActive:active.length>0 }; }
    async add(id,info){ const d={ id, filename:info.filename||'Video', progress:Math.max(0,Math.min(100,info.progress||0)), status:info.status||'Downloading...', isCompleted:false, isCancelled:false, downloaded:info.downloaded||0, total:info.total||0, speed:info.speed||'', metric: info.metric || null, startTime:Date.now() }; this.active.set(id,d); this.emit('downloadAdded',id,d); this.emit('stateChanged'); return d; }
    async update(id,updates){ const e=this.active.get(id); if(!e) return null; const p=(typeof updates.progress==='number')?Math.max(e.progress||0, Math.min(100, updates.progress)):e.progress; const u={...e,...updates, ...(typeof updates.progress==='number'?{progress:p}:{})}; if(u.progress>=100&&!e.isCompleted){u.isCompleted=true;u.status='Completed';this.emit('downloadCompleted',id,u);} if(updates.isCancelled&&!e.isCancelled){u.isCancelled=true;u.status='Cancelled';this.emit('downloadCancelled',id,u);} this.active.set(id,u); this.emit('downloadUpdated',id,u,e); this.emit('stateChanged'); return u; }
    async remove(id){ const e=this.active.get(id); if(!e) return false; this.active.delete(id); this.emit('downloadRemoved',id,e); this.emit('stateChanged'); return true; }
    cancelAll(){ const ids=[]; this.active.forEach((v,id)=>{ if(!v.isCompleted&&!v.isCancelled){ this.update(id,{isCancelled:true}); ids.push(id);} }); return ids; }
    setCollapsed(c){ if(this.isCollapsed!==c){ this.isCollapsed=c; this.emit('collapseChanged',c);} }
  }

  class DownloadManagerUI {
    constructor(config={}){ this.config=config; this.panel=null; this.elements={}; }
    create(){ if(this.panel) return this.panel; const panel=document.createElement('div'); panel.id='loom-download-manager'; panel.style.cssText=this.panelStyles(); panel.innerHTML=this.panelHTML(); document.body.appendChild(panel); this.panel=panel; this.cache(); this.bind(); return panel; }
    panelStyles(){ const isSmall=innerWidth<500; const w=isSmall?Math.min(innerWidth-40,340):380; const maxH=Math.min(innerHeight-80,500); return `position:fixed;top:20px;right:20px;width:${w}px;max-height:${maxH}px;background:#1b1b1b;border:2px solid ${ACCENT};border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,0.5);z-index:2147483647;color:#fff;overflow:hidden;overflow-x:hidden;transform:translateX(100%);opacity:0;transition:all .3s cubic-bezier(.4,0,.2,1);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:13px;box-sizing:border-box;` }
    panelHTML(){ const maxH=Math.min(innerHeight-80,500)-50; return `
      <div id="loom-dm-header" style="background:linear-gradient(135deg,#333,#222);color:#fff;padding:8px 12px;display:flex;justify-content:space-between;align-items:center;flex-wrap:nowrap;gap:8px;font-weight:700;border-bottom:1px solid #444;user-select:none">
        <div id="loom-dm-title" style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">📥 Downloads (0 active)</div>
        <div style="display:flex;gap:8px;align-items:center;flex-shrink:0;white-space:nowrap">
          <button id="loom-dm-cancel-all" title="Cancel all active downloads" style="background:#d32f2f;border:none;color:#fff;padding:4px 8px;border-radius:4px;cursor:pointer;font-size:11px;display:none;white-space:nowrap">Cancel All</button>
          <button id="loom-dm-clear" title="Clear completed" style="background:${ACCENT};border:none;color:#fff;padding:4px 8px;border-radius:4px;cursor:pointer;font-size:11px;white-space:nowrap">Clear</button>
          <button id="loom-dm-collapse" title="Collapse" style="background:rgba(255,255,255,.1);border:none;color:#fff;width:20px;height:20px;border-radius:3px;cursor:pointer">−</button>
        </div>
      </div>
      <div id="loom-dm-content" style="max-height:${maxH}px;overflow-y:auto;overflow-x:hidden;scrollbar-width:thin;scrollbar-color:#666 transparent;background:#1b1b1b"></div>
      <style>
        #loom-dm-content::-webkit-scrollbar{width:6px}
        #loom-dm-content::-webkit-scrollbar-track{background:#1b1b1b}
        #loom-dm-content::-webkit-scrollbar-thumb{background:#666;border-radius:3px}
        #loom-dm-content::-webkit-scrollbar-thumb:hover{background:#888}
      </style>`; }
    cache(){ this.elements.header=this.panel.querySelector('#loom-dm-header'); this.elements.title=this.panel.querySelector('#loom-dm-title'); this.elements.content=this.panel.querySelector('#loom-dm-content'); this.elements.clearBtn=this.panel.querySelector('#loom-dm-clear'); this.elements.collapseBtn=this.panel.querySelector('#loom-dm-collapse'); this.elements.cancelAllBtn=this.panel.querySelector('#loom-dm-cancel-all'); }
    bind(){ if(this.elements.header){ this.elements.header.addEventListener('click',(e)=>{ if(e.target.tagName!=='BUTTON'){ this.toggleCollapsed(); }}); }
      if(this.elements.collapseBtn){ this.elements.collapseBtn.addEventListener('click',(e)=>{ e.stopPropagation(); this.toggleCollapsed(); }); }
      if(this.elements.clearBtn){ this.elements.clearBtn.addEventListener('click',(e)=>{ e.stopPropagation(); this.onClear && this.onClear(); }); }
      if(this.elements.cancelAllBtn){ this.elements.cancelAllBtn.addEventListener('click',(e)=>{ e.stopPropagation(); this.onCancelAll && this.onCancelAll(); }); }
      if(this.elements.content){ this.elements.content.addEventListener('click',(e)=>{ const t=e.target; if(t.classList.contains('cancel-download-btn')){ const id=t.getAttribute('data-download-id'); e.stopPropagation(); this.onCancel && this.onCancel(id); } if(t.classList.contains('remove-download-btn')){ const id=t.getAttribute('data-download-id'); e.stopPropagation(); this.onRemove && this.onRemove(id); } }); }
    }
    toggleCollapsed(){ const content=this.elements.content; if(!content) return; const collapsed=content.style.display==='none'; content.style.display=collapsed?'block':'none'; this.elements.collapseBtn.textContent=collapsed?'−':'+'; }
    showPanel(){ this.panel.style.transform='translateX(0)'; this.panel.style.opacity='1'; }
    hidePanel(){ this.panel.style.transform='translateX(100%)'; this.panel.style.opacity='0'; }
    updateHeader(stats){ this.elements.title.textContent=`📥 Downloads ${stats.active>0?`(${stats.active} active)`:'(none)'}`; this.elements.cancelAllBtn.style.display=stats.active>1?'inline-block':'none'; }
    buildSkeleton(item,downloadId){ // header row
      const header=document.createElement('div'); header.style.cssText='display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px;';
      const left=document.createElement('div'); left.style.cssText='flex:1;min-width:0;';
      const title=document.createElement('div'); title.dataset.role='title'; title.style.cssText='font-weight:500;color:#fff;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;'; left.appendChild(title);
      const action=document.createElement('button'); action.dataset.role='action'; action.setAttribute('data-download-id',downloadId); action.className='cancel-download-btn'; action.textContent='STOP'; action.style.cssText='background:#d32f2f;border:none;color:#fff;font-size:10px;cursor:pointer;padding:2px 6px;border-radius:3px;margin-left:8px;flex-shrink:0;transition:all .2s ease;font-weight:500;'; action.onmouseover=function(){this.style.background='#b71c1c'}; action.onmouseout=function(){this.style.background='#d32f2f'}; header.appendChild(left); header.appendChild(action);
      // progress
      const pw=document.createElement('div'); pw.style.cssText='margin-bottom:6px;'; const track=document.createElement('div'); track.style.cssText='background:#333;border-radius:10px;height:4px;overflow:hidden;'; const fill=document.createElement('div'); fill.dataset.role='progress-fill'; fill.style.cssText=`background:${ACCENT};height:100%;width:0%;transition:all .3s ease;`; track.appendChild(fill); pw.appendChild(track);
      // info row
      const info=document.createElement('div'); info.style.cssText='display:flex;justify-content:space-between;align-items:center;font-size:11px;color:#ccc;'; const percent=document.createElement('span'); percent.dataset.role='percent'; percent.textContent='0%'; const details=document.createElement('span'); details.dataset.role='details'; details.style.cssText='text-align:right;flex:1;margin-left:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;'; details.textContent='Starting...'; info.appendChild(percent); info.appendChild(details);
      item.appendChild(header); item.appendChild(pw); item.appendChild(info);
    }
    ensureItem(id,info){ let item=this.elements.content.querySelector(`#download-item-${id}`); const isNew=!item; if(!item){ item=document.createElement('div'); item.id=`download-item-${id}`; item.style.cssText='padding:8px 12px;border-bottom:1px solid #333;background:#1b1b1b;transition:all .3s ease;opacity:0;transform:translateY(-10px);'; this.elements.content.appendChild(item); this.buildSkeleton(item,id); requestAnimationFrame(()=>{ item.style.opacity='1'; item.style.transform='translateY(0)'; }); }
      this.updateItem(item,info);
    }
    updateItem(item,info){ const pct=Math.round(info.progress||0); const completed=pct>=100||info.isCompleted; const cancelled=info.isCancelled||(info.status||'').toLowerCase().includes('cancel'); const failed=(info.status||'').toLowerCase().includes('failed')||(info.status||'').toLowerCase().includes('error')||(info.status||'').toLowerCase().includes('interrupted'); const showRemove=completed||cancelled||failed; const filename=info.filename||'Unknown'; const downloaded=Number.isFinite(info.downloaded)?info.downloaded:0; const total=Number.isFinite(info.total)?info.total:0; const status=info.status||'Downloading...'; const metric=(info.metric||'').toLowerCase(); const isSeg=metric==='segments'||status.toLowerCase().includes('segment'); const format=(b)=>{ if(b===0) return '0 B'; const k=1024; const s=['B','KB','MB','GB']; const i=Math.floor(Math.log(b)/Math.log(k)); return parseFloat((b/Math.pow(k,i)).toFixed(2))+' '+s[i]; }; const dlB=format(downloaded); const ttB= total>0?format(total):'Unknown';
      const titleEl=item.querySelector('[data-role="title"]'); const action=item.querySelector('[data-role="action"]'); const fill=item.querySelector('[data-role="progress-fill"]'); const percent=item.querySelector('[data-role="percent"]'); const details=item.querySelector('[data-role="details"]');
      if(titleEl){ titleEl.style.color=showRemove?(failed?'#f44336':completed?'#4caf50':'#ff9800'):'#fff'; const pre=failed?'❌':completed?'✅':cancelled?'🚫':'🎬'; titleEl.textContent=`${pre} ${filename}`; }
      if(action){ action.setAttribute('data-download-id', item.id.replace('download-item-','')); if(showRemove){ action.className='remove-download-btn'; action.textContent='×'; action.title='Remove from list'; action.style.background='none'; action.style.color='#ccc'; action.style.fontSize='14px'; action.onmouseover=function(){this.style.background='#333'; this.style.color='#fff'}; action.onmouseout=function(){this.style.background='none'; this.style.color='#ccc'}; } else { action.className='cancel-download-btn'; action.textContent='STOP'; action.title='Cancel active download'; action.style.background='#d32f2f'; action.style.color='#fff'; action.style.fontSize='10px'; action.onmouseover=function(){this.style.background='#b71c1c'}; action.onmouseout=function(){this.style.background='#d32f2f'}; } }
      if(fill){ fill.style.width=`${pct}%`; fill.style.background = failed?'#f44336': cancelled?'#ff9800': completed?'#4caf50': ACCENT; }
      if(percent) percent.textContent=`${pct}%`;
      if(details){
        const safeStatus = (status && status.trim && status.trim()) ? status.trim() : status;
        if(isSeg){
          const segText = total>0? `${downloaded}/${total} segments` : (safeStatus || 'Preparing segments...');
          details.textContent = segText;
        } else if (downloaded>0 || total>0){
          details.textContent = `${dlB}${total>0?` / ${ttB}`:''}`;
        } else {
          details.textContent = safeStatus || 'Preparing download...';
        }
      }
    }
    render(stats,map){ this.updateHeader(stats); map.forEach((info,id)=>this.ensureItem(id,info)); const ids=new Set([...map.keys()].map(String)); this.elements.content.querySelectorAll('[id^="download-item-"]')?.forEach(n=>{ const id=n.id.replace('download-item-',''); if(!ids.has(id)) n.remove(); }); }
  }

  class DownloadManager { 
    constructor(config={}){ this.config=config; this.state=new DownloadManagerState(config); this.ui=new DownloadManagerUI(config); this.autoTimer=null; this._suppressedIds=new Set(); this._suppressTimers=new Map(); this.autoHideMs=(config && (config.autoHideAfterComplete||config.ui?.autoHideAfterComplete)) || 0; this.bind(); }

    _dedupeCompletedByFilename(currentId, info){
      try{
        const name=((info?.filename)||'').toString().trim().toLowerCase();
        if(!name) return;
        const all=this.state.getAll();
        const dups=[];
        all.forEach((inf,id)=>{
          const done = !!inf?.isCompleted || (Number(inf?.progress||0)>=100) || String(inf?.status||'').toLowerCase().includes('completed');
          if(!done) return;
          const n=((inf?.filename)||'').toString().trim().toLowerCase();
          if(n===name) dups.push({id:String(id), info:inf});
        });
        if(dups.length<=1) return;
        let keepId=String(currentId);
        const notPlaceholder=dups.filter(d=>!/^loom-/i.test(d.id));
        if(notPlaceholder.length>0){
          // Prefer non-placeholder ids; break ties by lastUpdate
          keepId=notPlaceholder.reduce((best,cur)=>((cur.info?.lastUpdate||0)>(best.info?.lastUpdate||0)?cur:best)).id;
        } else if(!dups.some(d=>d.id===keepId)){
          // keep the most recently updated one
          keepId=dups.reduce((best,cur)=>((cur.info?.lastUpdate||0)>(best.info?.lastUpdate||0)?cur:best)).id;
        }
        dups.forEach(d=>{ if(d.id!==keepId){ try{ this.remove(d.id); }catch{} } });
      }catch{}
    }
    initialize(){ this.ui.create(); this.updateUI(); }
    bind(){
      const u=()=>this.updateUI();
      ['downloadAdded','downloadRemoved','stateChanged','downloadCompleted','downloadCancelled'].forEach(ev=>this.state.on(ev,u));
      // Auto-remove when updates reach terminal state
      this.state.on('downloadUpdated', (id,info)=>{
        try{
          const s=String(info?.status||'').toLowerCase();
          const failed=s.includes('failed')||s.includes('error')||s.includes('interrupted');
          const isCompleted = !!info?.isCompleted || s.includes('completed') || ((info?.progress??0)>=100);
          const isCancelled = !!info?.isCancelled || s.includes('cancelled') || s.includes('canceled');
          const done=isCompleted||isCancelled||failed;
          if(!done){ u(); return; }
          // Dedupe any duplicates with the same filename at completion
          if(isCompleted){ this._dedupeCompletedByFilename(id, info); }
          const cfgDelay = Number(this.config?.completeRemovalDelayMs ?? this.config?.behavior?.completeRemovalDelayMs ?? 2500);
          const delay = isCompleted ? Math.max(0, cfgDelay) : 0;
          setTimeout(async()=>{ try{ await this.remove(id); }catch{} u(); }, delay);
        }catch{ u(); }
      });
      // Also handle terminal state right after add (e.g., hydration from storage)
      this.state.on('downloadAdded', (id, info) => {
        try{
          const s=String(info?.status||'').toLowerCase();
          const failed=s.includes('failed')||s.includes('error')||s.includes('interrupted');
          const isCompleted = !!info?.isCompleted || s.includes('completed') || ((info?.progress??0)>=100);
          const isCancelled = !!info?.isCancelled || s.includes('cancelled') || s.includes('canceled');
          const done=isCompleted||isCancelled||failed;
          if(!done){ u(); return; }
          if(isCompleted){ this._dedupeCompletedByFilename(id, info); }
          const cfgDelay = Number(this.config?.completeRemovalDelayMs ?? this.config?.behavior?.completeRemovalDelayMs ?? 2500);
          const delay = isCompleted ? Math.max(0, cfgDelay) : 0;
          setTimeout(async()=>{ try{ await this.remove(id); }catch{} u(); }, delay);
        }catch{ u(); }
      });
      this.ui.onClear=()=>this.clearCompleted();
      this.ui.onCancelAll=()=>this.cancelAll();
      this.ui.onCancel=(id)=>this.cancel(id);
      this.ui.onRemove=(id)=>this.remove(id);
    }
    show(){ if(!this.ui.panel) this.initialize(); this.ui.showPanel(); this.state.setCollapsed(false); }
    hide(){ if(!this.ui.panel) return; this.ui.hidePanel(); this.state.setCollapsed(true); }
    _suppress(id,ms=4000){ try{ const key=String(id); this._suppressedIds.add(key); const prev=this._suppressTimers.get(key); if(prev) clearTimeout(prev); const t=setTimeout(()=>{ this._suppressedIds.delete(key); this._suppressTimers.delete(key); }, Math.max(500,ms)); this._suppressTimers.set(key,t);}catch{} }
    async showDownloadProgress(id,filename,downloaded=0,total=0,progress=0,status='Downloading...',metric=null){ if(!this.ui.panel) this.initialize(); if(this.ui.panel.style.opacity==='0') this.show(); const s=String(status||'').toLowerCase(); const terminal=s.includes('cancelled')||s.includes('canceled')||s.includes('failed')||s.includes('error')||s.includes('interrupted')||s.includes('completed')||(Number(progress)>=100); if(this._suppressedIds.has(String(id))){ if(terminal){ try{ await this.remove(id,{silent:true}); }catch{} } return; } const ex=this.state.get(id); if(ex){ await this.state.update(id,{ filename, downloaded,total,progress,status, metric }); } else { if(s.includes('cancelled')||s.includes('canceled')) { this.updateUI(); return; } await this.state.add(id,{ filename, downloaded,total,progress,status, metric }); } this.updateUI(); }
    async remove(id){ await this.state.remove(id); try{ chrome.runtime.sendMessage({ action:'downloadManagerRemoveEntries', downloadIds:[String(id)] }); }catch{} this.updateUI(); }
    async cancel(id){
      try{
        const sid=String(id);
        this._suppress(sid);
        const existing=this.state.get(sid);
        // If this looks like a temporary placeholder id, just remove it locally
        if(/^loom-/i.test(sid) || !existing){
          try{ await this.remove(sid); }catch{}
          try{ chrome.runtime.sendMessage({ action:'downloadManagerRemoveEntries', downloadIds:[sid] }); }catch{}
          this.updateUI();
          return;
        }
        await this.state.update(sid,{ isCancelled:true });
        this.updateUI();
        try{ chrome.runtime.sendMessage({ action:'cancelDownload', downloadId:sid }); }catch{}
      }catch{}
    }
    async cancelAll(){ try{ chrome.runtime.sendMessage({ action:'cancelAllDownloads' }); }catch{} const ids=this.state.cancelAll(); this.updateUI(); }
    async clearCompleted(){ const ids=[]; this.state.getAll().forEach((info,id)=>{ const s=(info.status||'').toLowerCase(); if(info.isCompleted||info.isCancelled||s.includes('failed')||s.includes('error')||s.includes('interrupted')) ids.push(id); }); ids.forEach(id=>this.state.remove(id)); this.updateUI(); }
    scheduleAutoHide(stats){
      try {
        if (!this.ui || !this.ui.panel) return;
        const hasActive = !!(stats && stats.active>0);
        if (hasActive) {
          if (this.autoTimer) { clearTimeout(this.autoTimer); this.autoTimer=null; }
          return;
        }
        // Only schedule if there are items in the list
        const total = stats?.total || 0;
        if (total === 0) {
          if (this.autoTimer) { clearTimeout(this.autoTimer); this.autoTimer=null; }
          // Nothing to show; ensure hidden
          this.hide();
          return;
        }
        if (this.autoHideMs <= 0) return;
        if (this.autoTimer) return; // already scheduled
        this.autoTimer = setTimeout(async () => {
          this.autoTimer=null;
          const st = this.state.stats();
          if (!st.hasActive && st.total === 0) this.hide();
        }, this.autoHideMs);
      } catch {}
    }
    updateUI(){ const st=this.state.stats(); this.ui.render(st, this.state.getAll()); this.scheduleAutoHide(st); }
  }

  function createModularDownloadManager(){ if(window.globalDownloadManager) return window.globalDownloadManager; const mgr=new DownloadManager(); mgr.initialize(); window.globalDownloadManager=mgr; return mgr; }
  function createCompatibilityLayer(manager){ const activeDownloads=new Map(); manager.state.on('downloadAdded',(id,info)=>activeDownloads.set(id,info)); manager.state.on('downloadUpdated',(id,info)=>activeDownloads.set(id,info)); manager.state.on('downloadRemoved',(id)=>activeDownloads.delete(id)); return { activeDownloads, showDownloadManager:()=>manager.show(), hideDownloadManager:()=>manager.hide(), toggleDownloadManager:()=>{ manager.state.setCollapsed(!manager.state.isCollapsed); manager.state.isCollapsed?manager.hide():manager.show(); }, showDownloadProgress:(...a)=>manager.showDownloadProgress(...a), hideDownloadProgress:(id)=>manager.remove(id), cancelActiveDownload:(id)=>manager.cancel(id), clearCompletedDownloads:()=>manager.clearCompleted() } }

  try{ window.createModularDownloadManager=createModularDownloadManager; window.createCompatibilityLayer=createCompatibilityLayer; }catch{}

  // Ensure a manager exists for top-level pages
  try { if (!window.globalDownloadManager) window.globalDownloadManager = createModularDownloadManager(); } catch {}

  // Accept messages from background in top frame to drive the UI
  try {
    if (chrome && chrome.runtime && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener((message) => {
        try {
          if (!window.globalDownloadManager) window.globalDownloadManager = createModularDownloadManager();
          if (message && message.action === 'openDownloadManager') {
            window.globalDownloadManager && window.globalDownloadManager.show();
            try { requestQueueSnapshot('open'); } catch {}
          } else if (message && message.action === 'showDownloadProgress') {
            const { downloadId, filename, downloaded = 0, total = 0, progress = 0, status = 'Downloading...', metric = null } = message;
            const id = String(downloadId);
            window.globalDownloadManager && window.globalDownloadManager.showDownloadProgress(id, filename || 'Video', downloaded, total, progress, status, metric);
            // Mark as locally touched to protect against storage hydration race removing it
            try { __dmLocalTouch.set(id, Date.now()); } catch {}
            try { requestQueueSnapshot('progress'); } catch {}
          } else if (message && message.action === 'hideDownloadProgress') {
            const { downloadId } = message;
            if (downloadId && window.globalDownloadManager) {
              const id = String(downloadId);
              try { __dmLocalTouch.set(id, Date.now()); } catch {}
              try { window.globalDownloadManager.remove(id); } catch {}
            }
            try { requestQueueSnapshot('hide'); } catch {}
          }
        } catch {}
      });
    }
  } catch {}

    // Cross‑tab storage hydration (background is the single writer)
    try {
      const STORAGE_KEY = 'downloadManagerGlobalState';

      async function hydrateFromStorage() {
        if (!window.globalDownloadManager) window.globalDownloadManager = createModularDownloadManager();
        const dm = window.globalDownloadManager;
        if (!dm) return;
        try {
          const result = await chrome.storage.local.get([STORAGE_KEY]);
          const state = result && result[STORAGE_KEY];
          const downloads = (state && state.downloads) || {};

          const idsFromStorage = new Set(Object.keys(downloads));

          // Remove local entries that aren't in storage only if they are stale
          // to avoid flicker when runtime message arrives before storage write.
          try {
            const now = Date.now();
            const current = dm.state && dm.state.getAll ? dm.state.getAll() : new Map();
            current.forEach((info, id) => {
              const sid = String(id);
              if (idsFromStorage.has(sid)) return;
              const lastTouch = __dmLocalTouch.get(sid) || 0;
              // If we touched it recently (< 1500ms), skip removal
              if (now - lastTouch < 1500) return;
              try { dm.remove(sid); } catch {}
            });
          } catch {}

          // Upsert entries
          for (const [id, info] of Object.entries(downloads)) {
            const statusStr = String(info.status || '').toLowerCase();
            const isFailed = /(failed|error|interrupted)/i.test(statusStr);
            const isCancelled = info.isCancelled === true || /cancel/.test(statusStr);
            const isCompleted = info.isCompleted === true || Number(info.progress||0) >= 100 || /completed/.test(statusStr);
            // Do not re-add completed items from storage; rely on explicit
            // hide/remove messages to avoid re-appear flicker.
            if (isCompleted) {
              try { dm.remove(String(id)); } catch {}
              continue;
            }
            dm.showDownloadProgress(
              String(id),
              info.filename || 'Loom Video',
              Number(info.downloaded||0),
              Number(info.total||0),
              Number(info.progress||0),
              String(info.status||'Downloading...')
            );
            if (isFailed || isCancelled) {
              // Remove immediately for failed/cancelled
              try { dm.remove(String(id)); } catch {}
            }
          }
        } catch {}
      }

      applyQueueSnapshot = (snapshot) => {
        try {
          if (!window.globalDownloadManager) window.globalDownloadManager = createModularDownloadManager();
          const dm = window.globalDownloadManager;
          if (!dm) return;
          const list = Array.isArray(snapshot?.downloads)
            ? snapshot.downloads
            : Array.isArray(snapshot?.activeDownloads)
              ? snapshot.activeDownloads
              : [];
          const seen = new Set();
          const now = Date.now();
          list.forEach((info) => {
            if (!info || info.id == null) return;
            const id = String(info.id);
            seen.add(id);
            try { __dmMissingSince.delete(id); } catch {}
            try { __dmLocalTouch.set(id, now); } catch {}
            const statusStr = String(info.status || '').toLowerCase();
            try {
              dm.showDownloadProgress(
                id,
                info.filename || 'Loom Video',
                Number(info.downloaded || 0),
                Number(info.total || 0),
                Number(info.progress || 0),
                info.status || 'Downloading...'
              );
              if (info.isCancelled || /(failed|error|interrupted)/i.test(statusStr)) {
                setTimeout(() => { try { dm.remove(id); } catch {} }, 0);
              }
            } catch (error) {
              console.warn('⚠️ Failed to apply Loom snapshot entry:', error);
            }
          });
          const current = dm.state && dm.state.getAll ? dm.state.getAll() : new Map();
          current.forEach((entry, entryId) => {
            const id = String(entryId);
            if (seen.has(id)) return;
            const first = __dmMissingSince.get(id) || now;
            if (!__dmMissingSince.has(id)) __dmMissingSince.set(id, first);
            if (now - first < SNAPSHOT_REMOVE_GRACE_MS) return;
            __dmMissingSince.delete(id);
            try { dm.remove(id); } catch {}
          });
          dm.updateUI?.();
        } catch (error) {
          console.warn('⚠️ Failed to apply Loom download snapshot:', error);
        }
      };

      requestQueueSnapshot = (reason = 'manual') => {
        try {
          if (__dmSnapshotTimer) return;
          __dmSnapshotTimer = setTimeout(() => { __dmSnapshotTimer = null; }, SNAPSHOT_THROTTLE_MS);
          chrome.runtime.sendMessage({ action: 'getQueueStatus', reason }, (response) => {
            try {
              if (chrome.runtime && chrome.runtime.lastError) return;
              if (response && response.success) {
                applyQueueSnapshot(response);
              }
            } catch {}
          });
        } catch {}
      };

    // Initial hydrate and subscribe (debounced)
    try { hydrateFromStorage(); } catch {}
    try { requestQueueSnapshot('init'); } catch {}
    if (chrome && chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener((changes, area) => {
        try {
          if (area === 'local' && changes && changes[STORAGE_KEY]) {
            if (__dmHydrateTimer) clearTimeout(__dmHydrateTimer);
            __dmHydrateTimer = setTimeout(() => {
              __dmHydrateTimer = null;
              hydrateFromStorage();
              requestQueueSnapshot('storage');
            }, 150);
          }
        } catch {}
      });
    }
  } catch {}
})();
