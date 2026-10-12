/* ============================================================
   灶间手账 app.js —— 数据都在本机 localStorage
   ============================================================ */
'use strict';

const $ = (sel) => document.querySelector(sel);
const LS_KEY = 'recipeBook.v1';
const TEMPLATE = `## 材料
- 主料：
- 辅料：
- 调料：盐、生抽

## 步骤
1. 备菜：
2. 
3. 出锅：

## 心得
- 成功的关键：
- 下次改进：`;

/* ---------- 工具 ---------- */
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const todayLocal = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const fmtDate = (iso) => {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(iso || '');
  return m ? `${+m[2]}月${+m[3]}日` : '';
};
const starsHtml = (n) =>
  '★'.repeat(n) + `<span class="dim">${'★'.repeat(5 - n)}</span>`;

function toast(msg, ms = 2200) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, ms);
}

function download(filename, text, type = 'text/markdown') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

/* ---------- frontmatter 解析 / 序列化 ---------- */
function parseRecipe(md) {
  const r = { name: '未命名', tags: [], level: '简单', time: '', date: '', stars: 3, body: md };
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return r;
  const fm = {};
  m[1].split(/\r?\n/).forEach((line) => {
    const i = line.indexOf(':');
    if (i > 0) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  });
  r.name = fm['名称'] || fm['菜名'] || fm['name'] || r.name;
  r.tags = (fm['标签'] || fm['tags'] || '').split(/[,，、;；]/).map((s) => s.trim()).filter(Boolean);
  r.level = fm['难度'] || r.level;
  r.time = fm['用时'] || fm['时间'] || '';
  r.date = fm['日期'] || '';
  const st = parseInt(fm['成功指数'] || fm['评分'], 10);
  r.stars = Number.isFinite(st) ? Math.min(5, Math.max(1, st)) : 3;
  r.id = fm['id'] || '';
  r.updatedTs = Date.parse(fm['更新时间'] || '') || 0;
  r.body = md.slice(m[0].length);
  return r;
}

function serializeRecipe(f, body, extra = {}) {
  const lines = ['---', `名称: ${f.name}`];
  if (extra.id) lines.push(`id: ${extra.id}`);
  if (f.tags.length) lines.push(`标签: ${f.tags.join(', ')}`);
  lines.push(`难度: ${f.level}`);
  if (f.time) lines.push(`用时: ${f.time}`);
  if (f.date) lines.push(`日期: ${f.date}`);
  lines.push(`成功指数: ${f.stars}`);
  if (extra.updatedTs) lines.push(`更新时间: ${new Date(extra.updatedTs).toISOString()}`);
  lines.push('---', '', body.trim(), '');
  return lines.join('\n');
}

/* 补全 id / 更新时间（同步到 GitHub 前调用，老数据会就地规范化） */
function withMeta(r) {
  const p = parseRecipe(r.markdown);
  if (p.id === r.id && p.updatedTs === r.updated) return r.markdown;
  const md = serializeRecipe(
    { name: p.name, tags: p.tags, level: p.level, time: p.time, date: p.date, stars: p.stars },
    p.body,
    { id: r.id, updatedTs: r.updated },
  );
  r.markdown = md;
  return md;
}

/* ---------- markdown 渲染 + 清洗 ---------- */
if (typeof marked === 'undefined') {
  window.marked = { parse: (md) => `<pre>${esc(md)}</pre>` };
} else {
  marked.setOptions({ gfm: true, breaks: true });
}

function sanitize(root) {
  root.querySelectorAll('script,iframe,style,object,embed,link,meta').forEach((el) => el.remove());
  root.querySelectorAll('*').forEach((el) => {
    [...el.attributes].forEach((attr) => {
      const n = attr.name.toLowerCase();
      if (n.startsWith('on') || ((n === 'href' || n === 'src') && /^\s*javascript:/i.test(attr.value))) {
        el.removeAttribute(attr.name);
      }
    });
  });
}

function renderMd(md) {
  const box = document.createElement('div');
  box.innerHTML = marked.parse(md);
  sanitize(box);
  return box;
}

/* 正文里第一个能当摘要的普通句子 */
function previewOf(body) {
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^#{1,6}\s/.test(line)) continue;
    if (!line || /^[-*]\s*\[?\]?\s*$/.test(line)) continue;
    return line.replace(/[*_`>#\[\]]/g, '').replace(/^\d+[.、)]\s*/, '').replace(/^[-*]\s*/, '');
  }
  return '';
}

/* ---------- 存储 ---------- */
function load() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const db = JSON.parse(raw);
      if (Array.isArray(db.recipes)) return { recipes: db.recipes, checks: db.checks || {} };
    }
  } catch (e) { /* 坏数据就重来 */ }
  return { recipes: [], checks: {}, seeded: false };
}

let db = load();
const save = () => localStorage.setItem(LS_KEY, JSON.stringify(db));
save();

const SEED_DIR = 'recipes';

/* 首次打开：从仓库 recipes/ 静态文件加载示例菜谱（清单见 recipes/index.json） */
async function seedFromStatic() {
  if (db.seeded || db.recipes.length) return;
  let manifest;
  try {
    const res = await fetch(`${SEED_DIR}/index.json`, { cache: 'no-cache' });
    if (!res.ok) return;
    manifest = await res.json();
  } catch (e) { return; } /* file:// 下浏览器禁止本地 fetch：没有示例菜，不影响手动录入 */
  if (!Array.isArray(manifest) || !manifest.length) return;
  db.seeded = true;
  save();
  const items = await Promise.all(manifest.map(async (name) => {
    try {
      const res = await fetch(`${SEED_DIR}/${encodeURIComponent(name)}`, { cache: 'no-cache' });
      if (!res.ok) return null;
      const text = await res.text();
      const p = parseRecipe(text);
      const ts = p.updatedTs || Date.parse(p.date) || Date.now();
      return { id: p.id || uid(), markdown: text, created: ts, updated: ts };
    } catch (e) { return null; }
  }));
  const have = new Set(db.recipes.map((r) => r.id));
  const toAdd = items.filter(Boolean).filter((r) => !have.has(r.id));
  if (!toAdd.length) return;
  db.recipes.push(...toAdd);
  save();
  renderTags();
  renderList();
}

/* ---------- 列表 ---------- */
const state = { q: '', tags: new Set() };

function sortedRecipes() {
  return [...db.recipes].sort((a, b) => {
    const pa = parseRecipe(a.markdown), pb = parseRecipe(b.markdown);
    return (pb.date || '').localeCompare(a.date || '') || (b.updated - a.updated);
  });
}

function allTags() {
  const freq = new Map();
  db.recipes.forEach((r) => parseRecipe(r.markdown).tags.forEach((t) => freq.set(t, (freq.get(t) || 0) + 1)));
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
}

function renderTags() {
  const row = $('#tagRow');
  row.innerHTML = '';
  allTags().forEach((t) => {
    const b = document.createElement('button');
    b.className = 'tag-chip' + (state.tags.has(t) ? ' is-on' : '');
    b.textContent = t;
    b.onclick = () => {
      state.tags.has(t) ? state.tags.delete(t) : state.tags.add(t);
      renderTags();
      renderList();
    };
    row.append(b);
  });
}

function renderStats() {
  const n = db.recipes.length;
  if (!n) { $('#mastStats').textContent = '空空如也，等第一道成功的菜'; return; }
  const dates = db.recipes.map((r) => parseRecipe(r.markdown).date).filter(Boolean).sort();
  const last = dates.length ? fmtDate(dates[dates.length - 1]) : '';
  $('#mastStats').textContent = `已收录 ${n} 道菜` + (last ? ` · 最近一次成功 ${last}` : '');
}

function renderList() {
  const grid = $('#cardGrid');
  grid.innerHTML = '';
  const q = state.q.trim().toLowerCase();
  const list = sortedRecipes().filter((r) => {
    const p = parseRecipe(r.markdown);
    if (state.tags.size && !p.tags.some((t) => state.tags.has(t))) return false;
    if (q && !(p.name + p.tags.join(' ') + p.body).toLowerCase().includes(q)) return false;
    return true;
  });
  $('#emptyHint').hidden = list.length > 0;
  if (!list.length && q) $('#emptyHint').textContent = '没有匹配的菜，换个关键词试试。';
  else if (!list.length && state.tags.size) $('#emptyHint').textContent = '这个标签下还没有菜。';
  else $('#emptyHint').textContent = '还没有记录。点右上角「记一道新菜」，照着模板填材料与步骤即可。';

  list.forEach((r) => {
    const p = parseRecipe(r.markdown);
    const card = document.createElement('button');
    card.className = 'card';
    card.type = 'button';
    card.innerHTML = `
      <span class="stamp-corner" aria-hidden="true">成功</span>
      <span class="card-name">${esc(p.name)}</span>
      <span class="card-tags">${p.tags.map((t) => `<span class="card-tag">${esc(t)}</span>`).join('')}</span>
      <span class="card-preview">${esc(previewOf(p.body))}</span>
      <span class="card-foot">
        <span class="card-stars">${starsHtml(p.stars)}</span>
        ${esc(p.level)}${p.time ? ' · ' + esc(p.time) : ''}
        <span style="margin-left:auto">${esc(fmtDate(p.date) || p.date)}</span>
      </span>`;
    card.onclick = () => openDetail(r.id);
    grid.append(card);
  });
  renderStats();
}

/* ---------- 详情 ---------- */
let currentId = null;

function buildDetail(p) {
  const root = renderMd(p.body);
  const kids = [...root.children];
  const wrap = document.createElement('div');

  const ingStart = kids.findIndex((el) => /^H[23]$/.test(el.tagName) && /材料|食材|准备/.test(el.textContent));
  if (ingStart === -1) {
    styleSection(wrap, root);
    wrap.classList.add('detail-body');
    return wrap;
  }
  let ingEnd = ingStart + 1;
  while (ingEnd < kids.length && !/^H[23]$/.test(kids[ingEnd].tagName)) ingEnd++;

  const cols = document.createElement('div');
  cols.className = 'detail-cols';
  const left = document.createElement('div');
  const right = document.createElement('div');
  kids.slice(ingStart, ingEnd).forEach((el) => left.append(el));
  [...kids.slice(0, ingStart), ...kids.slice(ingEnd)].forEach((el) => right.append(el));
  styleIngredients(left, p);
  styleSection(right);
  cols.append(left, right);
  wrap.classList.add('detail-body');
  wrap.append(cols);
  return wrap;
}

/* 「材料」清单变成可勾选的采购/备菜清单 */
function styleIngredients(left, p) {
  left.querySelectorAll('h1,h2,h3,h4').forEach((h) => h.classList.add('detail-h'));
  left.querySelectorAll('ul').forEach((ul) => {
    ul.classList.add('ing-list');
    const saved = db.checks[currentId] || {};
    [...ul.children].forEach((li, i) => {
      const text = li.textContent;
      li.innerHTML = '';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!saved[i];
      const span = document.createElement('span');
      span.textContent = text;
      cb.addEventListener('change', () => {
        li.classList.toggle('done', cb.checked);
        const c = db.checks[currentId] || (db.checks[currentId] = {});
        cb.checked ? (c[i] = 1) : delete c[i];
        save();
      });
      li.classList.toggle('done', cb.checked);
      li.append(cb, span);
      li.onclick = (e) => { if (e.target !== cb) { cb.checked = !cb.checked; cb.dispatchEvent(new Event('change')); } };
    });
  });
}

function styleSection(root) {
  let nextListIsStep = false;
  [...root.children].forEach((el) => {
    if (/^H[23]$/.test(el.tagName)) {
      el.classList.add('detail-h');
      nextListIsStep = /步骤|做法/.test(el.textContent);
      return;
    }
    if (el.tagName === 'OL' && nextListIsStep) {
      el.classList.add('step-list');
    } else if (el.tagName === 'UL') {
      el.classList.add('plain-list');
    }
  });
}

function openDetail(id) {
  const r = db.recipes.find((x) => x.id === id);
  if (!r) return;
  currentId = id;
  const p = parseRecipe(r.markdown);
  $('#dEyebrow').textContent = p.tags.length ? p.tags.join(' · ') : '我的拿手菜';
  $('#dTitle').textContent = p.name;
  $('#dMeta').innerHTML = `
    <span class="chip">难度 <b>${esc(p.level)}</b></span>
    ${p.time ? `<span class="chip">用时 <b>${esc(p.time)}</b></span>` : ''}
    ${p.date ? `<span class="chip">成功于 <b>${esc(fmtDate(p.date) || p.date)}</b></span>` : ''}
    <span class="chip chip-stars">${starsHtml(p.stars)}</span>`;
  const bodyEl = $('#detailBody');
  bodyEl.innerHTML = '';
  bodyEl.append(buildDetail(p));
  $('#detailOverlay').hidden = false;
  document.body.style.overflow = 'hidden';
  history.replaceState(null, '', `#r=${id}`);
}

function closeDetail() {
  $('#detailOverlay').hidden = true;
  currentId = null;
  document.body.style.overflow = '';
  history.replaceState(null, '', location.pathname + location.search);
}

/* ---------- 编辑器 ---------- */
let editingId = null;
let editorReturnId = null;

const splitTags = (s) => s.split(/[,，、;；]/).map((t) => t.trim()).filter(Boolean);

function openEditor(recipe) {
  editingId = recipe ? recipe.id : null;
  $('#eTitleText').textContent = recipe ? '修改菜谱' : '记一道新菜';
  const p = recipe ? parseRecipe(recipe.markdown) : null;
  $('#fName').value = p ? p.name : '';
  $('#fTags').value = p ? p.tags.join(', ') : '';
  $('#fLevel').value = p ? p.level : '简单';
  $('#fTime').value = p ? p.time : '';
  $('#fDate').value = p ? p.date : todayLocal();
  $('#fStars').value = p ? String(p.stars) : '5';
  $('#fBody').value = p ? p.body : TEMPLATE;
  switchTab('write');
  $('#editorOverlay').hidden = false;
  document.body.style.overflow = 'hidden';
  $('#fName').focus();
}

function closeEditor() {
  $('#editorOverlay').hidden = true;
  document.body.style.overflow = '';
  editingId = null;
}

function switchTab(which) {
  const writing = which === 'write';
  $('#tabWrite').classList.toggle('is-active', writing);
  $('#tabPreview').classList.toggle('is-active', !writing);
  $('#tabWrite').setAttribute('aria-selected', String(writing));
  $('#tabPreview').setAttribute('aria-selected', String(!writing));
  $('#fBody').hidden = !writing;
  const prev = $('#mdPreview');
  prev.hidden = writing;
  if (!writing) {
    prev.innerHTML = '';
    const html = renderMd($('#fBody').value || '_（空的，写点东西吧）_');
    [...html.children].forEach((el) => prev.append(el));
    styleSection(prev);
  }
}

$('#editorForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('#fName').value.trim();
  if (!name) { $('#fName').focus(); return toast('先给菜起个名字'); }
  const fields = {
    name,
    tags: splitTags($('#fTags').value),
    level: $('#fLevel').value,
    time: $('#fTime').value.trim(),
    date: $('#fDate').value,
    stars: +$('#fStars').value,
  };
  const now = Date.now();
  const id = editingId || uid();
  const md = serializeRecipe(fields, $('#fBody').value, { id, updatedTs: now });
  if (editingId) {
    const r = db.recipes.find((x) => x.id === id);
    r.markdown = md;
    r.updated = now;
  } else {
    db.recipes.push({ id, markdown: md, created: now, updated: now });
  }
  save();
  GH.poke(id);
  const isNew = !editingId;
  closeEditor();
  editorReturnId = null;
  renderTags();
  renderList();
  toast(isNew ? '盖上「成功」章，收录！🎉' : '已更新');
  openDetail(id);
});

/* ---------- 烹饪模式 ---------- */
const cook = { steps: [], idx: 0, name: '' };

function extractSteps(body) {
  const steps = [];
  let inSteps = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^#{1,6}\s*.*步骤/.test(line)) { inSteps = true; continue; }
    if (inSteps && /^#{1,6}\s/.test(line)) break;
    if (inSteps) {
      const m = line.match(/^\s*(?:\d+[.、)．]|[-*+])\s+(.*)/);
      if (m && m[1].trim()) steps.push(m[1].replace(/\*\*?([^*]+)\*\*?/g, '$1').replace(/`([^`]+)`/g, '$1').trim());
    }
  }
  return steps;
}

function openCook() {
  const r = db.recipes.find((x) => x.id === currentId);
  if (!r) return;
  const p = parseRecipe(r.markdown);
  cook.steps = extractSteps(p.body);
  if (!cook.steps.length) return toast('没找到「## 步骤」小节，先在正文里补上');
  cook.idx = 0;
  cook.name = p.name;
  $('#cookDishName').textContent = p.name;
  $('#cookOverlay').hidden = false;
  document.body.style.overflow = 'hidden';
  renderCook();
}

function renderCook() {
  $('#cookStepNo').textContent = `第 ${cook.idx + 1} 步 · 共 ${cook.steps.length} 步`;
  $('#cookStepText').textContent = cook.steps[cook.idx];
  const bar = $('#cookProgress');
  bar.innerHTML = cook.steps.map((_, i) =>
    `<span class="cook-dot ${i < cook.idx ? 'is-past' : ''} ${i === cook.idx ? 'is-now' : ''}"></span>`).join('');
  $('#cookPrev').style.visibility = cook.idx === 0 ? 'hidden' : 'visible';
  $('#cookNext').textContent = cook.idx === cook.steps.length - 1 ? '✓' : '›';
}

function cookMove(d) {
  const next = cook.idx + d;
  if (next < 0) return;
  if (next >= cook.steps.length) { closeCook(); toast('出锅，开吃！🍚'); return; }
  cook.idx = next;
  renderCook();
}

function closeCook() {
  $('#cookOverlay').hidden = true;
  document.body.style.overflow = '';
}

/* ---------- 模板文档 ---------- */
function showTplDoc() {
  const ov = document.createElement('div');
  ov.className = 'overlay overlay-temp';
  ov.innerHTML = `
    <article class="sheet tpl-doc" role="dialog" aria-modal="true">
      <button class="sheet-close" aria-label="关闭">×</button>
      <h2 class="dish-name">录入模板</h2>
      <p>每道菜就是一段 Markdown：头部 <b>frontmatter</b> 记基本信息，正文分「材料 / 步骤 / 心得」三节。点「记一道新菜」会自动带上模板，照着填就行。</p>
      <pre>---
名称: 番茄炒蛋
标签: 家常菜, 快手菜
难度: 简单
用时: 15 分钟
日期: 2026-10-12
成功指数: 5
---

## 材料
- 鸡蛋 3 个
- 番茄 2 个

## 步骤
1. ……
2. ……

## 心得
- 成功的关键：……</pre>
      <p>字段说明：<b>标签</b>用逗号分隔可写多个；<b>成功指数</b> 1–5；「材料」一节会自动变成可勾选的备菜清单，「步骤」一节配合「开始做」进入大字烹饪模式。</p>
      <div class="form-foot">
        <button class="btn btn-primary" data-copy>复制模板</button>
      </div>
    </article>`;
  ov.querySelector('.sheet-close').onclick = () => ov.remove();
  ov.querySelector('[data-copy]').onclick = async () => {
    (await copyText(TEMPLATE)) ? toast('模板已复制') : toast('复制失败，手动选中复制吧');
  };
  ov.addEventListener('click', (e) => { if (e.target === ov) ov.remove(); });
  document.body.append(ov);
}

/* ---------- 导入 / 导出 ---------- */
function exportJson() {
  download(`recipe-book-backup-${todayLocal()}.json`,
    JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), ...db }, null, 2),
    'application/json');
  toast('备份已下载');
}

function importJson(text) {
  try {
    const data = JSON.parse(text);
    const incoming = (data.recipes || []).filter((r) => r && r.markdown);
    if (!incoming.length) return toast('这个文件里没有菜谱');
    const known = new Set(db.recipes.map((r) => r.id));
    let added = 0;
    incoming.forEach((r) => {
      if (!known.has(r.id)) {
        db.recipes.push({ id: r.id || uid(), markdown: r.markdown, created: r.created || Date.now(), updated: r.updated || Date.now() });
        added++;
      }
    });
    save();
    renderTags();
    renderList();
    toast(`导入 ${added} 道（重复已跳过）`);
  } catch (e) {
    toast('JSON 解析失败，确认是备份文件');
  }
}

function importMdText(text, fallbackName) {
  const p = parseRecipe(text);
  if (p.name === '未命名' && fallbackName) p.name = fallbackName.replace(/\.(md|markdown|txt)$/i, '');
  const now = Date.now();
  const id = uid();
  db.recipes.push({ id, markdown: text, created: now, updated: now });
  return id;
}

function handleFiles(files) {
  const list = [...files];
  if (!list.length) return;
  if (list.length === 1 && /\.json$/i.test(list[0].name)) {
    list[0].text().then(importJson);
    return;
  }
  const mds = list.filter((f) => /\.(md|markdown|txt)$/i.test(f.name));
  if (!mds.length) return toast('只认 .md 或 .json 文件');
  Promise.all(mds.map((f) => f.text().then((t) => importMdText(t, f.name)))).then((ids) => {
    save();
    ids.forEach((id) => GH.poke(id));
    renderTags();
    renderList();
    toast(`导入 ${mds.length} 道`);
  });
}

/* ---------- 事件绑定 ---------- */
$('#searchInput').addEventListener('input', (e) => { state.q = e.target.value; renderList(); });

$('#btnNew').onclick = () => openEditor(null);
$('#btnData').onclick = (e) => { e.stopPropagation(); $('#dataMenu').hidden = !$('#dataMenu').hidden; };
document.addEventListener('click', (e) => {
  if (!$('#dataMenu').hidden && !e.target.closest('#dataMenu')) $('#dataMenu').hidden = true;
  if (!$('#ghMenu').hidden && !e.target.closest('#ghMenu')) $('#ghMenu').hidden = true;
});
$('#btnExportJson').onclick = () => { $('#dataMenu').hidden = true; exportJson(); };
$('#btnImportJson').onclick = () => { $('#dataMenu').hidden = true; fileInput.click(); };
$('#btnImportMd').onclick = () => { $('#dataMenu').hidden = true; fileInput.click(); };
$('#btnImportPaste').onclick = () => { $('#dataMenu').hidden = true; $('#pasteOverlay').hidden = false; $('#pasteArea').focus(); };

const fileInput = $('#fileInput');
fileInput.addEventListener('change', () => { handleFiles(fileInput.files); fileInput.value = ''; });

$('#btnDoPaste').onclick = () => {
  const t = $('#pasteArea').value.trim();
  if (!t) return toast('先粘贴内容');
  const id = importMdText(t, '');
  save();
  GH.poke(id);
  $('#pasteArea').value = '';
  $('#pasteOverlay').hidden = true;
  renderTags();
  renderList();
  toast('导入成功');
};
$('#btnCancelPaste').onclick = $('#btnClosePaste').onclick = () => { $('#pasteOverlay').hidden = true; };

$('#btnCloseDetail').onclick = closeDetail;
$('#detailOverlay').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeDetail(); });
$('#btnEdit').onclick = () => {
  const r = db.recipes.find((x) => x.id === currentId);
  if (!r) return;
  editorReturnId = currentId;
  closeDetail();
  openEditor(r);
};
$('#btnCopyMd').onclick = async () => {
  const r = db.recipes.find((x) => x.id === currentId);
  if (r && await copyText(r.markdown)) toast('Markdown 已复制');
};
$('#btnDownloadMd').onclick = () => {
  const r = db.recipes.find((x) => x.id === currentId);
  if (!r) return;
  download(`${parseRecipe(r.markdown).name}.md`, r.markdown);
};
$('#btnDelete').onclick = () => {
  const r = db.recipes.find((x) => x.id === currentId);
  if (!r) return;
  const name = parseRecipe(r.markdown).name;
  if (!confirm(`确定删除「${name}」？删了就找不回来了。`)) return;
  GH.noteDeleted(currentId, name);
  db.recipes = db.recipes.filter((x) => x.id !== currentId);
  delete db.checks[currentId];
  save();
  closeDetail();
  renderTags();
  renderList();
  toast('已删除');
};
$('#btnCook').onclick = openCook;

$('#tabWrite').onclick = () => switchTab('write');
$('#tabPreview').onclick = () => switchTab('preview');
$('#btnResetTpl').onclick = () => { $('#fBody').value = TEMPLATE; switchTab('write'); toast('已重置为模板'); };
$('#btnCancelEditor').onclick = closeEditor;
$('#btnCloseEditor').onclick = () => {
  closeEditor();
  if (editorReturnId) { const id = editorReturnId; editorReturnId = null; openDetail(id); }
};

$('#cookPrev').onclick = () => cookMove(-1);
$('#cookNext').onclick = () => cookMove(1);
$('#cookExit').onclick = closeCook;
$('#cookOverlay').addEventListener('click', (e) => {
  if (e.target.closest('.cook-nav') || e.target.closest('.cook-exit')) return;
  cookMove(1);
});
document.addEventListener('keydown', (e) => {
  if (!$('#cookOverlay').hidden) {
    if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') { e.preventDefault(); cookMove(1); }
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); cookMove(-1); }
    else if (e.key === 'Escape') closeCook();
    return;
  }
  if (e.key !== 'Escape') return;
  if (!$('#cookOverlay').hidden) { closeCook(); return; }
  if (!$('#pasteOverlay').hidden) $('#pasteOverlay').hidden = true;
  else if (!$('#editorOverlay').hidden) $('#btnCloseEditor').click();
  else if (!$('#detailOverlay').hidden) closeDetail();
  else if (!$('#ghOverlay').hidden) $('#ghOverlay').hidden = true;
  document.querySelectorAll('.overlay-temp').forEach((ov) => ov.remove());
  $('#ghMenu').hidden = true;
  $('#dataMenu').hidden = true;
});

$('#btnTemplateDoc').onclick = showTplDoc;

/* ---------- GitHub 同步 ---------- */
function updateGhBadge() {
  const info = GH.stateInfo();
  $('#ghDot').className = 'gh-dot ' + info.state;
  $('#ghMenuNote').textContent = info.note;
}

GH.initBridge({
  all: () => db.recipes,
  find: (id) => db.recipes.find((x) => x.id === id),
  adopt: (id, markdown, ts) => {
    const ex = db.recipes.find((x) => x.id === id);
    if (ex) { ex.markdown = markdown; ex.updated = ts || ex.updated; }
    else db.recipes.push({ id, markdown, created: ts || Date.now(), updated: ts || Date.now() });
  },
  remove: (id) => {
    db.recipes = db.recipes.filter((x) => x.id !== id);
    delete db.checks[id];
  },
  commit: () => { save(); renderTags(); renderList(); },
  parse: parseRecipe,
  withMeta,
});
GH.onChange(updateGhBadge);

$('#btnGh').onclick = (e) => { e.stopPropagation(); updateGhBadge(); $('#ghMenu').hidden = !$('#ghMenu').hidden; };

function syncDoneToast(r) {
  toast(`同步完成：拉取 ${r.pulled} · 推送 ${r.pushed}` + (r.removed ? ` · 移除 ${r.removed}` : '') + (r.conflicts ? ` · 冲突 ${r.conflicts}` : ''));
}
$('#btnSyncNow').onclick = async () => {
  $('#ghMenu').hidden = true;
  if (!GH.cfg) return openGhSettings();
  toast('同步中…');
  try { syncDoneToast(await GH.runSync()); }
  catch (e) { toast('同步失败：' + e.message); }
};
$('#btnGhSettings').onclick = () => { $('#ghMenu').hidden = true; openGhSettings(); };
$('#btnGhOpen').onclick = () => { $('#ghMenu').hidden = true; window.open(GH.webUrl(), '_blank'); };

function openGhSettings() {
  const c = GH.cfg || {};
  $('#ghRepo').value = c.repo || '';
  $('#ghDir').value = c.dir || 'recipes';
  $('#ghBranch').value = c.branch || 'main';
  $('#ghToken').value = c.token || '';
  $('#ghStatus').textContent = '';
  $('#ghDisconnect').hidden = !GH.cfg;
  $('#ghOverlay').hidden = false;
}
const ghFormVals = () => ({
  repo: $('#ghRepo').value,
  dir: $('#ghDir').value,
  branch: $('#ghBranch').value,
  token: $('#ghToken').value,
});
$('#btnCloseGh').onclick = () => { $('#ghOverlay').hidden = true; };
$('#ghOverlay').addEventListener('click', (e) => { if (e.target === e.currentTarget) $('#ghOverlay').hidden = true; });
$('#ghTest').onclick = async () => {
  $('#ghStatus').textContent = '测试中…';
  try { $('#ghStatus').textContent = '✓ ' + await GH.testConn(ghFormVals()); }
  catch (e) { $('#ghStatus').textContent = '✗ ' + e.message; }
};
$('#ghSave').onclick = async () => {
  try { GH.saveCfg(ghFormVals()); }
  catch (e) { return $('#ghStatus').textContent = '✗ ' + e.message; }
  $('#ghOverlay').hidden = true;
  updateGhBadge();
  toast('已连接，开始同步…');
  try { syncDoneToast(await GH.runSync()); }
  catch (e) { toast('同步失败：' + e.message); }
};
$('#ghDisconnect').onclick = () => {
  if (!confirm('断开后本地数据保留，只是不再和 GitHub 同步。确定断开？')) return;
  GH.disconnect();
  $('#ghOverlay').hidden = true;
  updateGhBadge();
  toast('已断开 GitHub 同步');
};

window.addEventListener('hashchange', () => {
  const m = location.hash.match(/^#r=(.+)$/);
  if (m && !$('#detailOverlay').hidden) return;
  if (m) openDetail(m[1]);
});

/* ---------- 启动 ---------- */
renderTags();
renderList();
updateGhBadge();
seedFromStatic();
(function initHash() {
  const m = location.hash.match(/^#r=(.+)$/);
  if (m) openDetail(decodeURIComponent(m[1]));
})();
if (GH.cfg) GH.runSync().catch(() => {});
