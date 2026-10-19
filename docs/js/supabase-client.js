/* =========================================================
   TeamFlow · Supabase 轻量客户端
   ---------------------------------------------------------
   为什么不用 @supabase/supabase-js：
     本项目要求零构建、零依赖（直接放 GitHub Pages 就能跑），
     而 CDN 在部分网络环境下不可达。Supabase 的后端就是
     标准 REST（GoTrue 认证 + PostgREST 数据），用 fetch 直接调即可。

   覆盖能力：
     · 认证：注册 / 登录 / 登出 / 恢复会话
     · 数据：查询、插入、更新、删除、upsert
     · 实时：轮询式"准实时"（足够看板场景，且对网络容错好）
   ========================================================= */
(function () {
  'use strict';

  var CFG = window.TEAMFLOW_CONFIG || {};
  var BASE = (CFG.supabaseUrl || '').replace(/\/+$/, '');
  var KEY  = CFG.supabaseAnonKey || '';
  var SESSION_KEY = 'teamflow.session';

  var session = null;

  /** 读取本地会话 */
  function loadSession() {
    try {
      var raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      var s = JSON.parse(raw);
      if (s && s.expires_at && s.expires_at * 1000 < Date.now()) {
        // 已过期：留着 refresh_token，尝试刷新
        return s;
      }
      return s;
    } catch (e) { return null; }
  }

  function saveSession(s) {
    session = s;
    if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else localStorage.removeItem(SESSION_KEY);
  }

  function isConfigured() {
    return !!(BASE && KEY && BASE.indexOf('YOUR-') === -1 && KEY.indexOf('YOUR-') === -1);
  }

  /**
   * 新版密钥（sb_publishable_…）与旧版 anon JWT（eyJ…）的用法不同：
   *   · 旧版 anon key 本身就是 JWT，匿名请求时可以直接当 Bearer 用；
   *   · 新版 publishable key 不是 JWT，只能放在 apikey 头里，
   *     带 Authorization 时必须是用户的 access_token。
   * 这里统一处理，避免换密钥格式就要改一堆调用点。
   */
  function isLegacyJwtKey() {
    return KEY.indexOf('eyJ') === 0;
  }

  function accessToken() {
    if (session && session.access_token) return session.access_token;
    return isLegacyJwtKey() ? KEY : null;
  }

  function authHeaders() {
    var h = {
      'apikey': KEY,
      'Content-Type': 'application/json'
    };
    var t = accessToken();
    if (t) h['Authorization'] = 'Bearer ' + t;
    return h;
  }

  /** 认证接口只带 apikey，不带用户 Bearer */
  function keyOnlyHeaders() {
    return { 'apikey': KEY, 'Content-Type': 'application/json' };
  }

  /** 统一请求封装：把 HTTP 错误转成带可读信息的中文错误 */
  function request(url, opts) {
    opts = opts || {};
    return fetch(url, opts).then(function (res) {
      var ct = res.headers.get('content-type') || '';
      var parse = ct.indexOf('json') >= 0 ? res.json() : res.text();
      return parse.then(function (body) {
        if (!res.ok) {
          var msg = (body && (body.message || body.error_description || body.error || body.msg)) || ('HTTP ' + res.status);
          if (body && body.hint) msg += '（' + body.hint + '）';
          var err = new Error(msg);
          err.status = res.status;
          err.body = body;
          throw err;
        }
        return body;
      });
    });
  }

  /* ---------------- 认证 ---------------- */

  function signUp(email, password, displayName) {
    return request(BASE + '/auth/v1/signup', {
      method: 'POST',
      headers: keyOnlyHeaders(),
      body: JSON.stringify({
        email: email,
        password: password,
        data: { display_name: displayName || email.split('@')[0] }
      })
    }).then(function (res) {
      // 开了邮箱验证时不会返回 session，需要提示用户去收邮件
      if (res && res.access_token) {
        saveSession(res);
        return { needsConfirm: false, session: res };
      }
      return { needsConfirm: true, session: null };
    });
  }

  function signIn(email, password) {
    return request(BASE + '/auth/v1/token?grant_type=password', {
      method: 'POST',
      headers: keyOnlyHeaders(),
      body: JSON.stringify({ email: email, password: password })
    }).then(function (res) {
      res.expires_at = Math.floor(Date.now() / 1000) + (res.expires_in || 3600);
      saveSession(res);
      return res;
    });
  }

  function refresh() {
    if (!session || !session.refresh_token) return Promise.resolve(null);
    return request(BASE + '/auth/v1/token?grant_type=refresh_token', {
      method: 'POST',
      headers: keyOnlyHeaders(),
      body: JSON.stringify({ refresh_token: session.refresh_token })
    }).then(function (res) {
      res.expires_at = Math.floor(Date.now() / 1000) + (res.expires_in || 3600);
      saveSession(res);
      return res;
    }).catch(function () { saveSession(null); return null; });
  }

  function signOut() {
    saveSession(null);
    return Promise.resolve();
  }

  function currentUser() {
    if (!session || !session.user) return null;
    return session.user;
  }

  /** 恢复会话：过期则刷新 */
  function restoreSession() {
    session = loadSession();
    if (!session) return Promise.resolve(null);
    var exp = session.expires_at ? session.expires_at * 1000 : 0;
    if (exp && exp < Date.now() + 30000) {
      return refresh();
    }
    return Promise.resolve(session);
  }

  /* ---------------- 数据（PostgREST） ---------------- */

  /**
   * 查询
   * @param {string} table
   * @param {object} q  { select, order, limit, filters:[[col,op,val]], single }
   */
  function select(table, q) {
    q = q || {};
    var params = [];
    params.push('select=' + encodeURIComponent(q.select || '*'));
    if (q.order) params.push('order=' + encodeURIComponent(q.order));
    if (q.limit) params.push('limit=' + q.limit);
    if (q.offset) params.push('offset=' + q.offset);
    (q.filters || []).forEach(function (f) {
      params.push(encodeURIComponent(f[0]) + '=' + f[1] + '.' + encodeURIComponent(f[2]));
    });
    return request(BASE + '/rest/v1/' + table + '?' + params.join('&'), {
      method: 'GET', headers: authHeaders()
    });
  }

  function insert(table, rows, opts) {
    opts = opts || {};
    var headers = authHeaders();
    headers['Prefer'] = 'return=representation';
    if (opts.upsert) headers['Prefer'] += ',resolution=merge-duplicates';
    return request(BASE + '/rest/v1/' + table, {
      method: 'POST', headers: headers,
      body: JSON.stringify(Array.isArray(rows) ? rows : [rows])
    });
  }

  function update(table, filters, patch) {
    var params = (filters || []).map(function (f) {
      return encodeURIComponent(f[0]) + '=' + f[1] + '.' + encodeURIComponent(f[2]);
    });
    var headers = authHeaders();
    headers['Prefer'] = 'return=representation';
    return request(BASE + '/rest/v1/' + table + '?' + params.join('&'), {
      method: 'PATCH', headers: headers, body: JSON.stringify(patch)
    });
  }

  function remove(table, filters) {
    var params = (filters || []).map(function (f) {
      return encodeURIComponent(f[0]) + '=' + f[1] + '.' + encodeURIComponent(f[2]);
    });
    var headers = authHeaders();
    headers['Prefer'] = 'return=representation';
    return request(BASE + '/rest/v1/' + table + '?' + params.join('&'), {
      method: 'DELETE', headers: headers
    });
  }

  window.SB = {
    isConfigured: isConfigured,
    base: BASE,
    signUp: signUp,
    signIn: signIn,
    signOut: signOut,
    refresh: refresh,
    restoreSession: restoreSession,
    currentUser: currentUser,
    select: select,
    insert: insert,
    update: update,
    remove: remove
  };
})();
