/* =========================================================
   TeamFlow · 应用逻辑
   ---------------------------------------------------------
   结构：
     1. 工具函数（DOM / 提示 / 时间格式化）
     2. 状态与常量
     3. 启动引导（配置检查 → 会话恢复 → 登录页 or 主界面）
     4. 认证流程
     5. 项目（列表 / 新建 / 切换）
     6. 看板（加载 / 渲染 / 拖拽）
     7. 任务（新建 / 编辑 / 删除）
     8. 评论
     9. 筛选与统计
    10. 准实时同步（轮询）
   ========================================================= */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  /* =========================================================
     1. 工具
     ========================================================= */

  var toastTimer = null;
  function toast(msg, isErr) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.toggle('toast--err', !!isErr);
    t.classList.add('is-show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('is-show'); }, 2600);
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /** 取名字首字做头像（中文取第一个字，英文取首字母） */
  function initial(name) {
    var s = String(name || '?').trim();
    if (!s) return '?';
    return s.charAt(0).toUpperCase();
  }

  /** 由字符串稳定生成一个颜色，保证同一用户每次颜色一致 */
  var PALETTE = ['#3B6FF5', '#8B5CF6', '#0EA5A4', '#E08A00', '#D93B36', '#1F9D63', '#DB2777', '#2563EB'];
  function colorOf(key) {
    var h = 0;
    var s = String(key || '');
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 100000;
    return PALETTE[h % PALETTE.length];
  }

  function fmtDate(d) {
    if (!d) return '';
    var dt = new Date(d + 'T00:00:00');
    if (isNaN(dt.getTime())) return d;
    return (dt.getMonth() + 1) + '月' + dt.getDate() + '日';
  }

  function fmtTime(iso) {
    if (!iso) return '';
    var dt = new Date(iso);
    if (isNaN(dt.getTime())) return '';
    var now = new Date();
    var diff = (now - dt) / 1000;
    if (diff < 60) return '刚刚';
    if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
    if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前';
    return (dt.getMonth() + 1) + '月' + dt.getDate() + '日';
  }

  function todayStr() {
    var d = new Date();
    var p = function (n) { return n < 10 ? '0' + n : '' + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  /* =========================================================
     2. 状态与常量
     ========================================================= */

  var COLUMNS = [
    { key: 'todo',   label: '待办',    color: '#7C879C' },
    { key: 'doing',  label: '进行中',  color: '#3B6FF5' },
    { key: 'review', label: '待评审',  color: '#B5730E' },
    { key: 'done',   label: '已完成',  color: '#1F9D63' }
  ];

  var PRIORITY = {
    urgent: { label: '紧急', rank: 3 },
    high:   { label: '高',   rank: 2 },
    medium: { label: '中',   rank: 1 },
    low:    { label: '低',   rank: 0 }
  };

  var state = {
    user: null,
    profile: null,
    projects: [],
    project: null,
    members: [],
    profiles: {},        // user_id -> profile
    tasks: [],
    comments: [],        // 当前编辑任务的评论
    editing: null,       // 正在编辑的任务（null 表示新建）
    filters: { q: '', assignee: '', priority: '' },
    pendingDrop: null,
    pollTimer: null,
    loading: false
  };

  /* =========================================================
     3. 启动引导
     ========================================================= */

  function showOnly(id) {
    ['boot', 'setup', 'auth', 'app'].forEach(function (k) {
      var el = $(k);
      if (el) el.hidden = (k !== id);
    });
  }

  function boot() {
    if (!window.SB.isConfigured()) {
      showOnly('setup');
      return;
    }
    window.SB.restoreSession().then(function (s) {
      if (s && s.user) {
        state.user = s.user;
        enterApp();
      } else {
        showOnly('auth');
        $('inpEmail').focus();
      }
    }).catch(function () {
      showOnly('auth');
    });
  }

  /* =========================================================
     4. 认证
     ========================================================= */

  var authMode = 'login';

  function setAuthMode(mode) {
    authMode = mode;
    var isLogin = mode === 'login';
    $('tabLogin').classList.toggle('is-active', isLogin);
    $('tabRegister').classList.toggle('is-active', !isLogin);
    $('fieldName').hidden = isLogin;
    $('btnAuth').textContent = isLogin ? '登录' : '注册';
    $('inpPassword').setAttribute('autocomplete', isLogin ? 'current-password' : 'new-password');
    $('authError').hidden = true;
  }

  function showAuthError(msg) {
    var el = $('authError');
    el.textContent = msg;
    el.hidden = false;
  }

  function handleAuthSubmit(e) {
    e.preventDefault();
    var email = $('inpEmail').value.trim();
    var password = $('inpPassword').value;
    var name = $('inpName').value.trim();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { showAuthError('请输入有效的邮箱地址'); return; }
    if (password.length < 6) { showAuthError('密码至少 6 位'); return; }
    if (authMode === 'register' && name.length < 1) { showAuthError('请填写昵称'); return; }

    var btn = $('btnAuth');
    btn.disabled = true;
    btn.textContent = authMode === 'login' ? '登录中…' : '注册中…';
    $('authError').hidden = true;

    var p = authMode === 'login'
      ? window.SB.signIn(email, password)
      : window.SB.signUp(email, password, name);

    p.then(function (res) {
      if (authMode === 'register' && res.needsConfirm) {
        showAuthError('注册成功，但需要先验证邮箱：请到邮箱点确认链接，然后回来登录。');
        setAuthMode('login');
        return;
      }
      var s = res.session || res;
      state.user = s.user;
      enterApp();
    }).catch(function (err) {
      var msg = err.message || '操作失败';
      if (/Invalid login credentials/i.test(msg)) msg = '邮箱或密码不正确';
      else if (/already registered|already exists/i.test(msg)) msg = '该邮箱已注册，请直接登录';
      else if (/Email not confirmed/i.test(msg)) msg = '邮箱尚未验证，请先到邮箱点确认链接';
      showAuthError(msg);
    }).finally(function () {
      btn.disabled = false;
      btn.textContent = authMode === 'login' ? '登录' : '注册';
    });
  }

  /* =========================================================
     5. 进入应用
     ========================================================= */

  function enterApp() {
    showOnly('app');
    renderMe();
    loadMyProfile();
    loadProjects().then(function () {
      if (state.projects.length) selectProject(state.projects[0].id);
      else setEmpty(true);
    });
    startPolling();
  }

  function renderMe() {
    var email = (state.user && state.user.email) || '';
    var meta = (state.user && state.user.user_metadata) || {};
    // 优先用 profiles 表里的昵称（后台创建的账号在 auth metadata 里可能没有昵称）
    var name = (state.profile && state.profile.display_name)
      || meta.display_name
      || email.split('@')[0] || '我';
    $('meName').textContent = name;
    var av = $('meAvatar');
    av.textContent = initial(name);
    av.style.background = colorOf(state.user && state.user.id || email);
  }

  /** 拉取自己的资料，用于侧栏显示真实昵称 */
  function loadMyProfile() {
    if (!state.user) return Promise.resolve();
    return window.SB.select('profiles', {
      select: 'id,display_name,avatar_color',
      filters: [['id', 'eq', state.user.id]]
    }).then(function (rows) {
      if (rows && rows[0]) {
        state.profile = rows[0];
        renderMe();
      }
    }).catch(function () {});
  }

  /* =========================================================
     6. 项目
     ========================================================= */

  function loadProjects() {
    return window.SB.select('projects', { order: 'created_at.asc' }).then(function (rows) {
      state.projects = rows || [];
      return Promise.all(state.projects.map(function (p) {
        return window.SB.select('tasks', { select: 'id', filters: [['project_id', 'eq', p.id]] })
          .then(function (ts) { return ts.length; })
          .catch(function () { return 0; });
      }));
    }).then(function (counts) {
      state.projects.forEach(function (p, i) { p._count = counts[i] || 0; });
      renderProjectList();
      return state.projects;
    }).catch(function (err) {
      toast('加载项目失败：' + err.message, true);
      return [];
    });
  }

  /**
   * 显示 / 隐藏"还没有项目"空状态。
   * 空状态节点是 #board 的**兄弟**节点，不在被 renderBoard() 重写的范围内，
   * 所以这里可以安全地反复调用（以前放在 board 内部，切项目时会连同节点一起被删掉，
   * 再访问就抛 null 的空指针异常）。
   */
  function setEmpty(visible) {
    var el = $('boardEmpty');
    if (el) el.hidden = !visible;
    var board = $('board');
    if (board) board.hidden = !!visible;
  }

  function renderProjectList() {
    var html = '';
    state.projects.forEach(function (p) {
      var active = state.project && state.project.id === p.id;
      html += '<button class="project' + (active ? ' is-active' : '') + '" type="button" data-id="' + esc(p.id) + '">'
        + '<span class="project__key">' + esc(p.key || '—') + '</span>'
        + '<span class="project__name">' + esc(p.name) + '</span>'
        + '<span class="project__count">' + (p._count || 0) + '</span>'
        + '</button>';
    });
    $('projectList').innerHTML = html;
  }

  function selectProject(id) {
    var p = null;
    for (var i = 0; i < state.projects.length; i++) {
      if (state.projects[i].id === id) { p = state.projects[i]; break; }
    }
    if (!p) return;
    state.project = p;
    renderProjectList();
    $('projectName').textContent = p.name;
    var k = $('projectKey');
    k.textContent = p.key || '';
    k.hidden = !p.key;
    setEmpty(false);

    loadMembers().then(function () {
      return loadTasks();
    }).then(function () {
      renderBoard();
      renderStats();
      renderAssigneeFilter();
    });
    stopPolling();
    startPolling();
  }

  function createProject() {
    var name = $('projName').value.trim();
    var key = $('projKey').value.trim().toUpperCase();
    var desc = $('projDesc').value.trim();
    if (!name) { toast('请填写项目名称', true); return; }
    if (!/^[A-Z]{2,6}$/.test(key)) { toast('短标识需 2-6 个大写字母', true); return; }

    var btn = $('btnProjSave');
    btn.disabled = true;
    window.SB.insert('projects', {
      name: name, key: key, description: desc, owner_id: state.user.id
    }).then(function (rows) {
      closeProjectModal();
      toast('项目已创建');
      return loadProjects();
    }).then(function () {
      var created = state.projects[state.projects.length - 1];
      if (created) selectProject(created.id);
    }).catch(function (err) {
      toast('创建失败：' + err.message, true);
    }).finally(function () { btn.disabled = false; });
  }

  /* =========================================================
     7. 成员
     ========================================================= */

  function loadMembers() {
    if (!state.project) return Promise.resolve([]);
    return window.SB.select('project_members', {
      select: 'user_id,role',
      filters: [['project_id', 'eq', state.project.id]]
    }).then(function (rows) {
      state.members = rows || [];
      return Promise.all(state.members.map(function (m) {
        return window.SB.select('profiles', {
          select: 'id,display_name,avatar_color',
          filters: [['id', 'eq', m.user_id]]
        }).then(function (ps) {
          if (ps && ps[0]) state.profiles[m.user_id] = ps[0];
        }).catch(function () {});
      }));
    }).catch(function () { state.members = []; });
  }

  function nameOfUser(id) {
    if (!id) return '未指派';
    var p = state.profiles[id];
    if (p) return p.display_name || '成员';
    if (state.user && state.user.id === id) {
      return (state.user.user_metadata && state.user.user_metadata.display_name) || '我';
    }
    return '成员';
  }

  function renderAssigneeFilter() {
    var seen = {};
    var html = '<option value="">全部负责人</option>';
    var add = function (id) {
      if (!id || seen[id]) return;
      seen[id] = 1;
      html += '<option value="' + esc(id) + '">' + esc(nameOfUser(id)) + '</option>';
    };
    if (state.user) add(state.user.id);
    state.members.forEach(function (m) { add(m.user_id); });
    state.tasks.forEach(function (t) { add(t.assignee_id); });
    $('selAssignee').innerHTML = html;
    $('taskAssignee').innerHTML = '<option value="">未指派</option>' + html.replace('<option value="">全部负责人</option>', '');
  }

  /* =========================================================
     8. 任务
     ========================================================= */

  function loadTasks() {
    if (!state.project) return Promise.resolve([]);
    return window.SB.select('tasks', {
      order: 'position.asc,created_at.asc',
      filters: [['project_id', 'eq', state.project.id]]
    }).then(function (rows) {
      state.tasks = rows || [];
      return state.tasks;
    }).catch(function (err) {
      toast('加载任务失败：' + err.message, true);
      return [];
    });
  }

  /** 应用筛选条件 */
  function visibleTasks(status) {
    var f = state.filters;
    var q = f.q.trim().toLowerCase();
    return state.tasks.filter(function (t) {
      if (t.status !== status) return false;
      if (f.priority && t.priority !== f.priority) return false;
      if (f.assignee && t.assignee_id !== f.assignee) return false;
      if (q) {
        var hay = (t.title + ' ' + (t.description || '')).toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });
  }

  function cardHtml(t) {
    var pr = PRIORITY[t.priority] || PRIORITY.medium;
    var overdue = t.due_date && t.status !== 'done' && t.due_date < todayStr();
    var assigneeName = t.assignee_id ? nameOfUser(t.assignee_id) : '';
    var html = '<article class="card card--' + esc(t.priority) + '" draggable="true" data-id="' + esc(t.id) + '">'
      + '<div class="card__title">' + esc(t.title) + '</div>';
    if (t.description) html += '<div class="card__desc">' + esc(t.description) + '</div>';
    html += '<div class="card__meta">'
      + '<span class="card__tag card__tag--' + esc(t.priority) + '">' + pr.label + '</span>';
    if (t.due_date) {
      html += '<span class="card__due' + (overdue ? ' is-overdue' : '') + '">'
        + (overdue ? '逾期 · ' : '') + fmtDate(t.due_date) + '</span>';
    }
    if (assigneeName) {
      html += '<span class="card__avatar" title="' + esc(assigneeName) + '" style="background:'
        + colorOf(t.assignee_id) + '">' + esc(initial(assigneeName)) + '</span>';
    }
    html += '</div></article>';
    return html;
  }

  function renderBoard() {
    var board = $('board');
    if (!state.project) {
      board.innerHTML = '';
      setEmpty(true);
      return;
    }
    var html = '';
    COLUMNS.forEach(function (col) {
      var list = visibleTasks(col.key);
      html += '<section class="column" data-status="' + col.key + '">'
        + '<div class="column__head">'
        + '<span class="column__dot" style="background:' + col.color + '"></span>'
        + '<span class="column__title">' + col.label + '</span>'
        + '<span class="column__count">' + list.length + '</span>'
        + '</div>'
        + '<div class="column__body" data-drop="' + col.key + '">';
      if (!list.length) {
        html += '<div class="column__empty">暂无任务</div>';
      } else {
        list.forEach(function (t) { html += cardHtml(t); });
      }
      html += '</div></section>';
    });
    board.innerHTML = html;
    bindBoardEvents();
  }

  /* =========================================================
     9. 拖拽
     ========================================================= */

  function bindBoardEvents() {
    var board = $('board');

    board.addEventListener('dragstart', function (e) {
      var card = e.target.closest('.card');
      if (!card) return;
      card.classList.add('is-dragging');
      state.pendingDrop = card.getAttribute('data-id');
      try { e.dataTransfer.setData('text/plain', state.pendingDrop); } catch (err) {}
      e.dataTransfer.effectAllowed = 'move';
    });

    board.addEventListener('dragend', function (e) {
      var card = e.target.closest('.card');
      if (card) card.classList.remove('is-dragging');
      var overs = board.querySelectorAll('.column.is-over');
      for (var i = 0; i < overs.length; i++) overs[i].classList.remove('is-over');
      state.pendingDrop = null;
    });

    board.addEventListener('dragover', function (e) {
      var col = e.target.closest('.column');
      if (!col || !state.pendingDrop) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      col.classList.add('is-over');
    });

    board.addEventListener('dragleave', function (e) {
      var col = e.target.closest('.column');
      if (col && !col.contains(e.relatedTarget)) col.classList.remove('is-over');
    });

    board.addEventListener('drop', function (e) {
      var col = e.target.closest('.column');
      if (!col || !state.pendingDrop) return;
      e.preventDefault();
      col.classList.remove('is-over');
      var id = state.pendingDrop;
      var status = col.getAttribute('data-status');
      moveTask(id, status);
    });

    // 点击卡片打开详情
    board.addEventListener('click', function (e) {
      var card = e.target.closest('.card');
      if (!card) return;
      openTask(card.getAttribute('data-id'));
    });
  }

  function moveTask(id, status) {
    var task = null;
    for (var i = 0; i < state.tasks.length; i++) {
      if (state.tasks[i].id === id) { task = state.tasks[i]; break; }
    }
    if (!task || task.status === status) return;

    var prev = task.status;
    task.status = status;               // 乐观更新，先动界面
    renderBoard();
    renderStats();

    window.SB.update('tasks', [['id', 'eq', id]], { status: status })
      .then(function () {
        toast('已移到「' + labelOf(status) + '」');
        logActivity(task.id, '移动任务', labelOf(prev) + ' → ' + labelOf(status));
      })
      .catch(function (err) {
        task.status = prev;             // 失败回滚
        renderBoard();
        renderStats();
        toast('移动失败：' + err.message, true);
      });
  }

  function labelOf(status) {
    for (var i = 0; i < COLUMNS.length; i++) if (COLUMNS[i].key === status) return COLUMNS[i].label;
    return status;
  }

  /* =========================================================
     10. 统计
     ========================================================= */

  function renderStats() {
    var t = state.tasks;
    var done = 0, doing = 0, urgent = 0, overdue = 0;
    var today = todayStr();
    t.forEach(function (x) {
      if (x.status === 'done') done++;
      if (x.status === 'doing') doing++;
      if (x.priority === 'high' || x.priority === 'urgent') urgent++;
      if (x.due_date && x.status !== 'done' && x.due_date < today) overdue++;
    });
    $('statTotal').textContent = t.length;
    $('statDoing').textContent = doing;
    $('statDone').textContent = done;
    $('statUrgent').textContent = urgent;
    $('statOverdue').textContent = overdue;
    var rate = t.length ? Math.round(done / t.length * 100) : 0;
    $('statRate').textContent = rate + '%';
    $('progressFill').style.width = rate + '%';
  }

  /* =========================================================
     11. 任务弹窗
     ========================================================= */

  function openTask(id) {
    var task = null;
    for (var i = 0; i < state.tasks.length; i++) {
      if (state.tasks[i].id === id) { task = state.tasks[i]; break; }
    }
    if (!task) return;
    state.editing = task;
    $('modalTitle').textContent = '编辑任务';
    $('taskTitle').value = task.title || '';
    $('taskDesc').value = task.description || '';
    $('taskStatus').value = task.status || 'todo';
    $('taskPriority').value = task.priority || 'medium';
    $('taskAssignee').value = task.assignee_id || '';
    $('taskDue').value = task.due_date || '';
    $('btnDeleteTask').hidden = false;
    $('commentsWrap').hidden = false;
    renderAssigneeFilter();
    $('taskAssignee').value = task.assignee_id || '';
    loadComments(task.id);
    openModal('modalMask');
  }

  function openNewTask(status) {
    state.editing = null;
    $('modalTitle').textContent = '新建任务';
    $('taskTitle').value = '';
    $('taskDesc').value = '';
    $('taskStatus').value = status || 'todo';
    $('taskPriority').value = 'medium';
    $('taskAssignee').value = '';
    $('taskDue').value = '';
    $('btnDeleteTask').hidden = true;
    $('commentsWrap').hidden = true;
    renderAssigneeFilter();
    openModal('modalMask');
    setTimeout(function () { $('taskTitle').focus(); }, 60);
  }

  function saveTask() {
    if (!state.project) { toast('请先选择项目', true); return; }
    var title = $('taskTitle').value.trim();
    if (!title) { toast('请填写任务标题', true); return; }

    var payload = {
      title: title,
      description: $('taskDesc').value.trim(),
      status: $('taskStatus').value,
      priority: $('taskPriority').value,
      assignee_id: $('taskAssignee').value || null,
      due_date: $('taskDue').value || null
    };

    var btn = $('btnSave');
    btn.disabled = true;

    var op = state.editing
      ? window.SB.update('tasks', [['id', 'eq', state.editing.id]], payload)
      : window.SB.insert('tasks', Object.assign({
          project_id: state.project.id,
          created_by: state.user.id,
          position: state.tasks.length
        }, payload));

    op.then(function () {
      toast(state.editing ? '任务已更新' : '任务已创建');
      logActivity(state.editing ? state.editing.id : null,
        state.editing ? '更新任务' : '创建任务', title);
      closeModal('modalMask');
      return loadTasks();
    }).then(function () {
      renderBoard();
      renderStats();
      renderAssigneeFilter();
    }).catch(function (err) {
      toast('保存失败：' + err.message, true);
    }).finally(function () { btn.disabled = false; });
  }

  function deleteTask() {
    if (!state.editing) return;
    var id = state.editing.id;
    var title = state.editing.title;
    if (!confirm('确定删除任务「' + title + '」？此操作不可撤销。')) return;

    window.SB.remove('tasks', [['id', 'eq', id]]).then(function () {
      toast('任务已删除');
      closeModal('modalMask');
      return loadTasks();
    }).then(function () {
      renderBoard();
      renderStats();
    }).catch(function (err) {
      toast('删除失败：' + err.message, true);
    });
  }

  /* =========================================================
     12. 评论
     ========================================================= */

  function loadComments(taskId) {
    return window.SB.select('comments', {
      order: 'created_at.asc',
      filters: [['task_id', 'eq', taskId]]
    }).then(function (rows) {
      state.comments = rows || [];
      // 补全评论者昵称
      var ids = {};
      state.comments.forEach(function (c) { if (!state.profiles[c.user_id]) ids[c.user_id] = 1; });
      var keys = Object.keys(ids);
      if (!keys.length) return null;
      return Promise.all(keys.map(function (uid) {
        return window.SB.select('profiles', { filters: [['id', 'eq', uid]] })
          .then(function (ps) { if (ps && ps[0]) state.profiles[uid] = ps[0]; })
          .catch(function () {});
      }));
    }).then(function () {
      renderComments();
    }).catch(function () {
      state.comments = [];
      renderComments();
    });
  }

  function renderComments() {
    var list = $('commentsList');
    $('commentsCount').textContent = state.comments.length;
    if (!state.comments.length) {
      list.innerHTML = '<div class="comment__empty">还没有评论，说点什么吧。</div>';
      return;
    }
    var html = '';
    state.comments.forEach(function (c) {
      var name = nameOfUser(c.user_id);
      html += '<div class="comment">'
        + '<span class="comment__avatar" style="background:' + colorOf(c.user_id) + '">' + esc(initial(name)) + '</span>'
        + '<div class="comment__body">'
        + '<div><span class="comment__who">' + esc(name) + '</span>'
        + '<span class="comment__time">' + fmtTime(c.created_at) + '</span></div>'
        + '<div class="comment__text">' + esc(c.body) + '</div>'
        + '</div></div>';
    });
    list.innerHTML = html;
    list.scrollTop = list.scrollHeight;
  }

  function addComment() {
    if (!state.editing) return;
    var inp = $('inpComment');
    var body = inp.value.trim();
    if (!body) return;
    inp.disabled = true;
    window.SB.insert('comments', {
      task_id: state.editing.id,
      user_id: state.user.id,
      body: body
    }).then(function () {
      inp.value = '';
      return loadComments(state.editing.id);
    }).catch(function (err) {
      toast('评论失败：' + err.message, true);
    }).finally(function () { inp.disabled = false; inp.focus(); });
  }

  /* =========================================================
     13. 活动日志（失败不影响主流程）
     ========================================================= */

  function logActivity(taskId, action, detail) {
    if (!state.project || !state.user) return;
    window.SB.insert('activity', {
      project_id: state.project.id,
      task_id: taskId,
      user_id: state.user.id,
      action: action,
      detail: detail || ''
    }).catch(function () {});
  }

  /* =========================================================
     14. 弹窗控制
     ========================================================= */

  function openModal(id) { $(id).classList.add('is-open'); }
  function closeModal(id) { $(id).classList.remove('is-open'); }
  function closeProjectModal() { closeModal('projMask'); }

  /* =========================================================
     15. 轮询同步
     ========================================================= */

  function startPolling() {
    stopPolling();
    state.pollTimer = setInterval(function () {
      if (!state.project || document.hidden) return;
      // 正在编辑任务时不刷新看板，避免打断输入
      if ($('modalMask').classList.contains('is-open')) return;
      loadTasks().then(function () {
        renderBoard();
        renderStats();
      });
    }, 8000);
  }

  function stopPolling() {
    if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
  }

  /* =========================================================
     16. 事件绑定
     ========================================================= */

  function bindEvents() {
    // 认证
    $('tabLogin').addEventListener('click', function () { setAuthMode('login'); });
    $('tabRegister').addEventListener('click', function () { setAuthMode('register'); });
    $('authForm').addEventListener('submit', handleAuthSubmit);
    $('btnSignOut').addEventListener('click', function () {
      window.SB.signOut().then(function () {
        state.user = null;
        stopPolling();
        showOnly('auth');
        setAuthMode('login');
        $('inpPassword').value = '';
      });
    });

    // 项目
    $('projectList').addEventListener('click', function (e) {
      var b = e.target.closest('.project');
      if (b) selectProject(b.getAttribute('data-id'));
    });
    $('btnNewProject').addEventListener('click', function () {
      $('projName').value = '';
      $('projKey').value = '';
      $('projDesc').value = '';
      openModal('projMask');
      setTimeout(function () { $('projName').focus(); }, 60);
    });
    $('btnProjSave').addEventListener('click', createProject);
    $('btnProjClose').addEventListener('click', closeProjectModal);
    $('btnProjCancel').addEventListener('click', closeProjectModal);

    // 任务
    $('btnNewTask').addEventListener('click', function () { openNewTask('todo'); });
    $('btnSave').addEventListener('click', saveTask);
    $('btnCancel').addEventListener('click', function () { closeModal('modalMask'); });
    $('btnModalClose').addEventListener('click', function () { closeModal('modalMask'); });
    $('btnDeleteTask').addEventListener('click', deleteTask);
    $('btnComment').addEventListener('click', addComment);
    $('inpComment').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); addComment(); }
    });

    // 筛选
    $('inpSearch').addEventListener('input', function () {
      state.filters.q = this.value;
      renderBoard();
    });
    $('selAssignee').addEventListener('change', function () {
      state.filters.assignee = this.value;
      renderBoard();
    });
    $('selPriority').addEventListener('change', function () {
      state.filters.priority = this.value;
      renderBoard();
    });

    // 侧栏收起
    $('btnToggleSidebar').addEventListener('click', function () {
      var app = $('app');
      if (window.innerWidth <= 1000) app.classList.toggle('is-open-sidebar');
      else app.classList.toggle('is-collapsed');
    });

    // 弹窗：点遮罩关闭 / Esc 关闭
    ['modalMask', 'projMask'].forEach(function (id) {
      $(id).addEventListener('mousedown', function (e) {
        if (e.target === this) closeModal(id);
      });
    });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if ($('modalMask').classList.contains('is-open')) closeModal('modalMask');
      else if ($('projMask').classList.contains('is-open')) closeProjectModal();
    });

    // 新建任务快捷键
    document.addEventListener('keydown', function (e) {
      if (e.key === 'n' && (e.ctrlKey || e.metaKey) && state.user) {
        e.preventDefault();
        openNewTask('todo');
      }
    });
  }

  /* =========================================================
     17. 启动
     ========================================================= */

  function init() {
    bindEvents();
    setAuthMode('login');
    boot();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  // 供调试/测试使用
  window.TeamFlow = {
    state: state,
    openNewTask: openNewTask,
    openTask: openTask,
    renderBoard: renderBoard,
    renderStats: renderStats
  };
})();
