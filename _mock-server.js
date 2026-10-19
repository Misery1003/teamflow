/* =========================================================
   TeamFlow · 本地 Mock Supabase 服务
   ---------------------------------------------------------
   用途：
     在真实 Supabase 项目就绪前，用这个本地服务验证前端逻辑、
     生成截图，并作为"前端与后端接口契约"的可执行文档。

   实现范围（与真实 Supabase 接口保持一致）：
     POST /auth/v1/signup
     POST /auth/v1/token?grant_type=password
     GET  /rest/v1/{table}?select=&order=&...filters
     POST /rest/v1/{table}
     PATCH /rest/v1/{table}?...filters
     DELETE /rest/v1/{table}?...filters

   注意：这是测试替身，不做行级安全（真机安全靠 Supabase RLS）。
   ========================================================= */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.argv[2]) || 8787;
const DATA_FILE = 'F:\\teamflow\\_mock-data.json';
const APP_DIR = 'F:\\teamflow\\app';

/* ---------------- 数据层 ---------------- */

let db = {
  users: [],        // { id, email, password, user_metadata }
  sessions: {},     // token -> userId
  profiles: [],
  projects: [],
  project_members: [],
  tasks: [],
  tags: [],
  task_tags: [],
  comments: [],
  activity: []
};

function loadDb() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      Object.keys(db).forEach(k => { if (!Array.isArray(db[k]) && typeof db[k] !== 'object') db[k] = Array.isArray(db[k]) ? db[k] : []; });
    }
  } catch (e) { console.error('[mock] 读取数据失败，用空库启动', e.message); }
  Object.keys({ users: 1, profiles: 1, projects: 1, project_members: 1, tasks: 1, tags: 1, task_tags: 1, comments: 1, activity: 1 })
    .forEach(k => { if (!Array.isArray(db[k])) db[k] = []; });
  if (!db.sessions || typeof db.sessions !== 'object') db.sessions = {};
}

let saveTimer = null;
function saveDb() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2), 'utf8'); } catch (e) {}
  }, 150);
}

const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();

/* ---------------- HTTP 工具 ---------------- */

function send(res, status, body, extra) {
  const headers = Object.assign({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Content-Type': 'application/json; charset=utf-8'
  }, extra || {});
  res.writeHead(status, headers);
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    const c = [];
    req.on('data', d => c.push(d));
    req.on('end', () => {
      const raw = Buffer.concat(c).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { resolve({}); }
    });
  });
}

function tokenOf(req) {
  const h = req.headers['authorization'] || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

function currentUser(req) {
  const t = tokenOf(req);
  if (!t || !db.sessions[t]) return null;
  return db.users.find(u => u.id === db.sessions[t]) || null;
}

/* ---------------- 查询参数解析（PostgREST 风格） ---------------- */

/** 解析 select=a,b 只保留指定字段 */
function project(row, select) {
  if (!select || select === '*') return row;
  const fields = select.split(',').map(s => s.trim()).filter(Boolean);
  const out = {};
  fields.forEach(f => { out[f] = row[f]; });
  return out;
}

/** 支持 eq / neq / gt / gte / lt / lte / like / is */
function applyFilters(rows, query) {
  let out = rows.slice();
  Object.keys(query).forEach(key => {
    if (['select', 'order', 'limit', 'offset'].includes(key)) return;
    const val = query[key];
    if (!val) return;
    const m = val.match(/^([a-z]+)\.(.*)$/);
    if (!m) return;
    const [, op, raw] = m;
    const target = raw === 'null' ? null : raw;
    out = out.filter(row => {
      const v = row[key];
      switch (op) {
        case 'eq': return String(v ?? '') === String(target ?? '');
        case 'neq': return String(v ?? '') !== String(target ?? '');
        case 'gt': return v > target;
        case 'gte': return v >= target;
        case 'lt': return v < target;
        case 'lte': return v <= target;
        case 'is': return target === 'null' ? v == null : v === target;
        case 'like': {
          const re = new RegExp('^' + String(target).replace(/%/g, '.*').replace(/_/g, '.') + '$', 'i');
          return re.test(String(v ?? ''));
        }
        default: return true;
      }
    });
  });
  return out;
}

function applyOrder(rows, order) {
  if (!order) return rows;
  const parts = order.split(',').map(s => s.trim());
  const out = rows.slice();
  out.sort((a, b) => {
    for (const p of parts) {
      const [field, dirRaw] = p.split('.');
      const dir = (dirRaw || 'asc').toLowerCase() === 'desc' ? -1 : 1;
      const av = a[field], bv = b[field];
      if (av === bv) continue;
      if (av == null) return -1 * dir;
      if (bv == null) return 1 * dir;
      return (av > bv ? 1 : -1) * dir;
    }
    return 0;
  });
  return out;
}

/* ---------------- 业务表 ---------------- */

const TABLES = ['profiles', 'projects', 'project_members', 'tasks', 'tags', 'task_tags', 'comments', 'activity'];

/* ---------------- 请求处理 ---------------- */

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, '');

  const url = new URL(req.url, 'http://localhost:' + PORT);
  const pathname = url.pathname;

  // ---- 认证 ----
  if (pathname === '/auth/v1/signup' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body.email || !body.password) return send(res, 400, { message: '缺少邮箱或密码' });
    if (db.users.some(u => u.email.toLowerCase() === body.email.toLowerCase())) {
      return send(res, 400, { message: 'User already registered' });
    }
    const user = {
      id: uid(),
      email: body.email,
      password: body.password,
      user_metadata: body.data || {},
      created_at: now()
    };
    db.users.push(user);
    db.profiles.push({
      id: user.id,
      display_name: (body.data && body.data.display_name) || body.email.split('@')[0],
      avatar_color: '#3B6FF5',
      created_at: now()
    });
    const token = 'mock-' + crypto.randomBytes(16).toString('hex');
    db.sessions[token] = user.id;
    saveDb();
    return send(res, 200, {
      access_token: token,
      token_type: 'bearer',
      expires_in: 3600,
      refresh_token: 'refresh-' + token,
      user: { id: user.id, email: user.email, user_metadata: user.user_metadata }
    });
  }

  if (pathname === '/auth/v1/token' && req.method === 'POST') {
    const body = await readBody(req);
    const grant = url.searchParams.get('grant_type');
    if (grant === 'refresh_token') {
      const token = 'mock-' + crypto.randomBytes(16).toString('hex');
      const userId = Object.values(db.sessions)[0];
      const user = db.users.find(u => u.id === userId);
      if (!user) return send(res, 400, { message: 'refresh failed' });
      db.sessions[token] = user.id;
      saveDb();
      return send(res, 200, {
        access_token: token, token_type: 'bearer', expires_in: 3600,
        refresh_token: 'refresh-' + token,
        user: { id: user.id, email: user.email, user_metadata: user.user_metadata }
      });
    }
    const user = db.users.find(u => u.email.toLowerCase() === String(body.email || '').toLowerCase());
    if (!user || user.password !== body.password) {
      return send(res, 400, { message: 'Invalid login credentials' });
    }
    const token = 'mock-' + crypto.randomBytes(16).toString('hex');
    db.sessions[token] = user.id;
    saveDb();
    return send(res, 200, {
      access_token: token, token_type: 'bearer', expires_in: 3600,
      refresh_token: 'refresh-' + token,
      user: { id: user.id, email: user.email, user_metadata: user.user_metadata }
    });
  }

  if (pathname === '/auth/v1/user' && req.method === 'GET') {
    const u = currentUser(req);
    if (!u) return send(res, 401, { message: 'not authenticated' });
    return send(res, 200, { id: u.id, email: u.email, user_metadata: u.user_metadata });
  }

  // ---- 数据 ----
  if (pathname.startsWith('/rest/v1/')) {
    const table = pathname.replace('/rest/v1/', '').split('/')[0];
    if (!TABLES.includes(table)) return send(res, 404, { message: 'table not found: ' + table });

    const query = {};
    url.searchParams.forEach((v, k) => { query[k] = v; });

    if (req.method === 'GET') {
      let rows = applyFilters(db[table], query);
      rows = applyOrder(rows, query.order);
      if (query.offset) rows = rows.slice(Number(query.offset));
      if (query.limit) rows = rows.slice(0, Number(query.limit));
      return send(res, 200, rows.map(r => project(r, query.select)));
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      const rows = Array.isArray(body) ? body : [body];
      const created = rows.map(r => {
        const row = Object.assign({ id: r.id || uid(), created_at: now() }, r);
        // 新建项目时自动把创建者加为成员（等价于真实库的触发器）
        if (table === 'projects' && row.owner_id) {
          if (!db.project_members.some(m => m.project_id === row.id && m.user_id === row.owner_id)) {
            db.project_members.push({
              project_id: row.id, user_id: row.owner_id, role: 'owner', joined_at: now()
            });
          }
        }
        db[table].push(row);
        return row;
      });
      saveDb();
      return send(res, 201, created.map(r => project(r, query.select)));
    }

    if (req.method === 'PATCH') {
      const body = await readBody(req);
      const matched = applyFilters(db[table], query);
      const updated = [];
      matched.forEach(row => {
        Object.assign(row, body, { updated_at: now() });
        updated.push(row);
      });
      saveDb();
      return send(res, 200, updated.map(r => project(r, query.select)));
    }

    if (req.method === 'DELETE') {
      const matched = applyFilters(db[table], query);
      const removed = matched.map(r => r.id);
      db[table] = db[table].filter(r => !removed.includes(r.id));
      // 级联删除，模拟数据库外键
      if (table === 'projects') {
        db.project_members = db.project_members.filter(m => !removed.includes(m.project_id));
        const taskIds = db.tasks.filter(t => removed.includes(t.project_id)).map(t => t.id);
        db.tasks = db.tasks.filter(t => !removed.includes(t.project_id));
        db.comments = db.comments.filter(c => !taskIds.includes(c.task_id));
      }
      if (table === 'tasks') {
        db.comments = db.comments.filter(c => !removed.includes(c.task_id));
      }
      saveDb();
      return send(res, 200, []);
    }
  }

  // ---- 静态文件（顺便把 app 目录一起伺服，方便直接访问） ----
  let filePath = path.join(APP_DIR, pathname === '/' ? 'index.html' : pathname);
  if (!filePath.startsWith(APP_DIR)) return send(res, 403, 'forbidden');
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    return send(res, 404, 'not found');
  }
  const ext = path.extname(filePath).toLowerCase();
  const mime = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml'
  }[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': mime, 'Access-Control-Allow-Origin': '*' });
  fs.createReadStream(filePath).pipe(res);
});

loadDb();
server.listen(PORT, '127.0.0.1', () => {
  console.log('TeamFlow Mock Supabase 已启动');
  console.log('  API:  http://127.0.0.1:' + PORT);
  console.log('  页面: http://127.0.0.1:' + PORT + '/');
  console.log('  数据: ' + DATA_FILE);
  const counts = {};
  Object.keys(db).forEach(k => { if (Array.isArray(db[k])) counts[k] = db[k].length; });
  console.log('  现有数据: ' + JSON.stringify(counts));
});
