/* ============================================================
   gh.js —— GitHub 同步
   远端仓库是正式存档：一道菜 = recipes/ 下一个 .md 文件。
   本地 localStorage 是工作副本，双向同步，单用户语义：
   两边都改了 → 更新时间新的赢；远端删了且本地没改 → 跟着删。
   浏览器直连 api.github.com（官方支持 CORS），Token 只存本机。
   ============================================================ */
'use strict';

const GH = (() => {
  const LS = 'recipeBook.gh.v1';
  const DEFAULT_REPO_URL = 'https://github.com/vhxubo/recipe-book';
  const DEFAULTS = { cfg: null, shas: {}, dirty: [], tombstones: [], lastSync: 0 };
  let st = load();
  let bridge = null;
  let syncing = null;
  let syncTimer = null;
  const listeners = [];

  function load() {
    try {
      const raw = localStorage.getItem(LS);
      if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
    } catch (e) { /* 坏数据当未配置 */ }
    return { ...DEFAULTS };
  }
  const persist = () => localStorage.setItem(LS, JSON.stringify(st));
  const emit = () => listeners.forEach((f) => { try { f(stateInfo()); } catch (e) {} });

  /* ---------- 低层 API ---------- */
  const dir = () => (st.cfg.dir || 'recipes').replace(/^\/+|\/+$/g, '') || 'recipes';
  const branch = () => st.cfg.branch || 'main';
  const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');

  async function api(cfg, path, opts = {}) {
    const headers = { Accept: 'application/vnd.github+json', ...(opts.headers || {}) };
    if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;
    let res;
    try {
      res = await fetch(`https://api.github.com${path}`, { ...opts, headers });
    } catch (e) {
      throw new Error('网络不通，连不上 api.github.com');
    }
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { msg = (await res.json()).message || msg; } catch (e) { /* 保留状态码信息 */ }
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    return res.status === 204 ? null : res.json();
  }

  const decodeB64 = (b64) =>
    new TextDecoder().decode(Uint8Array.from(atob((b64 || '').replace(/\n/g, '')), (c) => c.charCodeAt(0)));
  const encodeB64 = (s) => {
    const bytes = new TextEncoder().encode(s);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  };

  async function listMd(cfg) {
    const d = (cfg.dir || 'recipes').replace(/^\/+|\/+$/g, '') || 'recipes';
    const b = cfg.branch || 'main';
    let items;
    try {
      items = await api(cfg, `/repos/${cfg.repo}/contents/${encPath(d)}?ref=${encodeURIComponent(b)}`);
    } catch (e) {
      if (e.status === 404) return [];   // 目录还不存在 = 首次同步
      throw e;
    }
    if (!Array.isArray(items)) return [];
    return items
      .filter((i) => i.type === 'file' && /\.(md|markdown)$/i.test(i.name))
      .map((i) => ({ name: i.name, path: i.path, sha: i.sha }));
  }

  async function getFile(cfg, path) {
    const b = cfg.branch || 'main';
    const j = await api(cfg, `/repos/${cfg.repo}/contents/${encPath(path)}?ref=${encodeURIComponent(b)}`);
    return { text: decodeB64(j.content), sha: j.sha };
  }

  async function putFile(cfg, path, text, sha, message) {
    const body = { message, content: encodeB64(text), branch: cfg.branch || 'main' };
    if (sha) body.sha = sha;
    return api(cfg, `/repos/${cfg.repo}/contents/${encPath(path)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async function deleteFile(cfg, path, sha, message) {
    return api(cfg, `/repos/${cfg.repo}/contents/${encPath(path)}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, sha, branch: cfg.branch || 'main' }),
    });
  }

  /* ---------- 文件名 ---------- */
  const fileSafe = (n) =>
    String(n || '').replace(/[\\/:*?"<>|#&%{}$!@+`^~'=;]/g, '').replace(/\s+/g, '-').replace(/[.\s]+$/, '').slice(0, 80) || 'untitled';

  /* ---------- 推送一道菜 ---------- */
  async function pushOne(cfg, r) {
    const md = bridge.withMeta(r);
    const p = bridge.parse(md);
    let path = `${dir()}/${fileSafe(p.name)}.md`;
    const owner = Object.entries(st.shas).find(([, v]) => v.path === path);
    if (owner && owner[0] !== r.id) path = `${dir()}/${fileSafe(p.name)}-2.md`;   // 避免顶掉别的菜
    const prev = st.shas[r.id];
    const sha = prev && prev.path === path ? prev.sha : undefined;

    try {
      const j = await putFile(cfg, path, md, sha, `记录：${p.name}`);
      if (prev && prev.path !== path && prev.sha) {
        try { await deleteFile(cfg, prev.path, prev.sha, `改名：${p.name}`); } catch (e) { /* 旧文件留着不致命 */ }
      }
      st.shas[r.id] = { path, sha: j.content.sha };
    } catch (e) {
      if (e.status === 409 || e.status === 422) {
        // 远端被别的端改过：取最新 sha 再试一次（内容以本地为准，单用户语义）
        let fresh = null;
        try { fresh = await getFile(cfg, path); } catch (e2) { /* 远端可能不存在 */ }
        const j = await putFile(cfg, path, md, fresh ? fresh.sha : undefined, `记录：${p.name}`);
        st.shas[r.id] = { path, sha: j.content.sha };
      } else {
        throw e;
      }
    }
    st.dirty = st.dirty.filter((x) => x !== r.id);
  }

  /* ---------- 全量同步 ---------- */
  async function runSync() {
    if (!st.cfg) throw new Error('还没配置 GitHub 仓库');
    if (syncing) return syncing;
    const cfg = st.cfg;
    setState('syncing');
    syncing = (async () => {
      let pulled = 0, pushed = 0, removed = 0, conflicts = 0;
      try {
        /* 1. 拉目录 */
        const files = await listMd(cfg);
        const remote = new Map();   // id -> {text, p, path, sha}
        for (const f of files) {
          try {
            const { text, sha } = await getFile(cfg, f.path);
            const p = bridge.parse(text);
            remote.set(p.id || f.name.replace(/\.(md|markdown)$/i, ''), { text, p, path: f.path, sha });
          } catch (e) { /* 单个文件坏了不影响整体 */ }
        }

        /* 2. 远端 → 本地 */
        for (const [id, rv] of remote) {
          if (st.tombstones.some((t) => t.id === id)) continue;   // 本地刚删过
          const lr = bridge.find(id);
          const known = st.shas[id];
          const remoteChanged = !known || known.sha !== rv.sha;
          if (!lr) {
            bridge.adopt(id, rv.text, rv.p.updatedTs || Date.now());
            st.shas[id] = { path: rv.path, sha: rv.sha };
            pulled++;
          } else if (remoteChanged) {
            if (!st.dirty.includes(id)) {
              bridge.adopt(id, rv.text, rv.p.updatedTs || Date.now());
              st.shas[id] = { path: rv.path, sha: rv.sha };
              pulled++;
            } else {
              const lu = bridge.parse(lr.markdown).updatedTs || 0;
              const ru = rv.p.updatedTs || 0;
              if (ru > lu) {   // 远端更新 → 用远端
                bridge.adopt(id, rv.text, rv.p.updatedTs || Date.now());
                st.shas[id] = { path: rv.path, sha: rv.sha };
                st.dirty = st.dirty.filter((x) => x !== id);
                conflicts++;
              } else {         // 本地更新 → 推上去
                await pushOne(cfg, bridge.find(id));
                conflicts++;
                pushed++;
              }
            }
          } else {
            st.shas[id] = { path: rv.path, sha: rv.sha };
          }
        }

        /* 3. 远端删了、本地没改 → 跟着删 */
        for (const id of Object.keys(st.shas)) {
          if (remote.has(id) || st.dirty.includes(id)) continue;
          bridge.remove(id);
          delete st.shas[id];
          removed++;
        }

        /* 4. 本地新增 / 待推送 → 推上去 */
        for (const r of bridge.all()) {
          if (!st.shas[r.id] || st.dirty.includes(r.id)) {
            await pushOne(cfg, r);
            pushed++;
          }
        }

        /* 5. 处理本地删除 */
        for (const t of [...st.tombstones]) {
          if (t.path && t.sha) {
            try { await deleteFile(cfg, t.path, t.sha, `删除：${t.name || t.id}`); }
            catch (e) { if (e.status !== 404) throw e; }
          }
          delete st.shas[t.id];
          st.tombstones = st.tombstones.filter((x) => x !== t);
        }

        st.lastSync = Date.now();
        setState('idle');
        bridge.commit();
        return { pulled, pushed, removed, conflicts };
      } catch (e) {
        setState('error', e.message);
        throw e;
      } finally {
        syncing = null;
      }
    })();
    return syncing;
  }

  /* ---------- 对外接口 ---------- */
  function setState(s, error = '') {
    st.state = s;
    st.error = error || '';
    persist();
    emit();
  }

  function stateInfo() {
    const c = st.cfg;
    let state = st.state;
    if (!c) state = 'off';
    else if (state === 'off') state = 'idle';
    const t = st.lastSync ? new Date(st.lastSync) : null;
    const note = !c
      ? '未配置 —— 配置后数据会存成 GitHub 仓库里的 Markdown 文件'
      : `${c.repo} / ${dir()} · ${st.lastSync ? '上次同步 ' + t.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '还没同步过'}` +
        (st.dirty.length || st.tombstones.length ? ` · 待推送 ${st.dirty.length + st.tombstones.length}` : '') +
        (st.state === 'error' ? ` · 上次出错：${st.error}` : '');
    return { state, note, cfg: c };
  }

  function schedule() {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => { runSync().catch(() => {}); }, 12000);
  }

  return {
    get cfg() { return st.cfg; },
    stateInfo,
    onChange(f) { listeners.push(f); },
    initBridge(b) { bridge = b; },

    poke(id) {
      if (!st.cfg) return;
      if (!st.dirty.includes(id)) st.dirty.push(id);
      persist();
      schedule();
    },
    noteDeleted(id, name) {
      if (!st.cfg) return;
      const s = st.shas[id];
      st.tombstones.push({ id, name, path: s ? s.path : '', sha: s ? s.sha : '' });
      delete st.shas[id];
      persist();
      schedule();
    },

    saveCfg({ repo, dir: d, branch: b, token }) {
      const next = {
        repo: (repo || '').trim(),
        dir: (d || 'recipes').trim() || 'recipes',
        branch: (b || 'main').trim() || 'main',
        token: (token || '').trim(),
      };
      if (!/^[\w.-]+\/[\w.-]+$/.test(next.repo)) throw new Error('仓库要写成 owner/repo 的样子');
      if (st.cfg && st.cfg.repo !== next.repo) { st.shas = {}; st.tombstones = []; }   // 换仓库从头同步
      st.cfg = next;
      setState('idle');
    },

    async testConn({ repo, dir: d, branch: b, token }) {
      const cfg = { repo: (repo || '').trim(), dir: (d || 'recipes').trim() || 'recipes', branch: (b || 'main').trim() || 'main', token: (token || '').trim() };
      if (!/^[\w.-]+\/[\w.-]+$/.test(cfg.repo)) throw new Error('仓库要写成 owner/repo 的样子');
      const out = [];
      try {
        const r = await api(cfg, `/repos/${cfg.repo}`);
        out.push(`仓库 OK（${r.private ? '私有' : '公开'}）`);
      } catch (e) {
        if (e.status === 401) throw new Error('Token 无效或过期');
        if (e.status === 404) throw new Error('仓库不存在，或 Token 没有它的权限');
        throw e;
      }
      if (cfg.token) {
        const files = await listMd(cfg);
        out.push(files.length ? `目录 ${cfg.dir}/ 里有 ${files.length} 个 .md` : `目录 ${cfg.dir}/ 还不存在，首次同步会创建`);
      } else {
        out.push('没填 Token：公开仓库可只读拉取，不能推送');
      }
      return out.join('；');
    },

    disconnect() {
      st.cfg = null;
      st.shas = {};
      st.dirty = [];
      st.tombstones = [];
      setState('off');
    },

    webUrl() {
      if (!st.cfg) return DEFAULT_REPO_URL;
      return `https://github.com/${st.cfg.repo}/tree/${branch()}/${dir()}`;
    },

    runSync,
    _internal: { fileSafe, decodeB64, encodeB64 },
  };
})();
