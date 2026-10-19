# TeamFlow · 团队协作任务板

一个**全栈**团队协作任务板：多用户登录、项目看板、任务分配、评论与统计。

> 综合项目（比电子阅读器复杂）。前端零依赖、无构建，后端与数据库使用 Supabase。

**在线地址**：https://misery1003.github.io/teamflow/
**仓库地址**：https://github.com/Misery1003/teamflow

---

## 一、这个项目复杂在哪

| 维度 | 电子阅读器（前一个项目） | TeamFlow |
| --- | --- | --- |
| 用户 | 单用户、本地 | **多用户注册登录** |
| 数据 | 本地文件 | **云端 PostgreSQL + 八张关联表** |
| 权限 | 无 | **数据库行级安全策略（RLS）** |
| 交互 | 阅读、翻页 | **看板拖拽、增删改、筛选、评论** |
| 架构 | 单进程桌面应用 | **前端 + 后端 + 数据库三层** |

---

## 二、技术栈

| 层 | 选型 | 说明 |
| --- | --- | --- |
| 前端 | 原生 HTML / CSS / JS | 零依赖、无构建，直接静态托管 |
| 数据客户端 | 自写轻量 REST 客户端（`js/supabase-client.js`） | 不引 CDN，直接调 GoTrue 认证与 PostgREST |
| 后端 | Supabase（托管 PostgreSQL） | 认证、数据接口、行级安全策略 |
| 数据库 | PostgreSQL 15 | 8 张表 + 1 个统计视图 + 3 个触发器函数 |
| 前端托管 | GitHub Pages | 静态文件，自动 HTTPS |
| 测试替身 | 本地 Mock 服务（`_mock-server.js`） | 模拟 Supabase 接口，便于前端独立开发与截图 |

---

## 三、功能

### 认证
- 邮箱注册 / 登录 / 登出
- 会话持久化与自动续期
- 注册时自动创建用户资料（数据库触发器）

### 项目
- 创建项目（名称 + 短标识 + 描述）
- 项目列表显示任务数
- 创建者自动成为项目 owner（数据库触发器）

### 看板
- 四列：待办 / 进行中 / 待评审 / 已完成
- **拖拽改状态**，乐观更新 + 失败回滚
- 卡片显示：优先级色条、描述摘要、截止日期（逾期标红）、负责人头像

### 任务
- 新建 / 编辑 / 删除
- 字段：标题、描述、状态、优先级、负责人、截止日期
- 搜索（标题 + 描述模糊匹配）
- 按负责人、优先级筛选

### 协作
- 任务评论（实时显示评论者与时间）
- 活动日志（创建 / 移动 / 更新）

### 统计
- 总任务、进行中、已完成、高优任务、逾期数量
- 完成度进度条
- 由数据库视图 `project_stats` 聚合

---

## 四、数据库设计

```
profiles          用户资料（关联 auth.users）
projects          项目
project_members   项目成员（多对多）
tasks             任务（status + position 支持看板排序）
tags              标签
task_tags         任务-标签关联
comments          评论
activity          活动日志
```

**权限模型**：所有表启用 RLS，默认拒绝；通过 `is_member(project_id)` 函数判断当前用户是否为项目成员。
即使拿到前端的匿名密钥，直接查询数据库也只会返回空数组。

---

## 五、快速开始

### 1. 建库

在 Supabase 控制台 → **SQL Editor** 里整段执行 `sql/schema.sql`。

### 2. 配置

编辑 `app/js/config.js`：

```js
window.TEAMFLOW_CONFIG = {
  supabaseUrl: 'https://你的项目.supabase.co',
  supabaseAnonKey: '你的 anon key'
};
```

> `anon key` 是公开密钥，放前端是正常用法；真正的安全边界是数据库的 RLS。

### 3. 本地预览

```powershell
# 方式一：连真实 Supabase
# 直接用任意静态服务器托管 app/ 目录，例如：
python -m http.server 8080 --directory app

# 方式二：不连云端，用本地 Mock（数据存 _mock-data.json）
node _mock-server.js 8787
# 然后访问 http://127.0.0.1:8787/
```

### 4. 部署

前端是纯静态，推到 GitHub 后在仓库 Settings → Pages 选择分支与目录即可。

---

## 六、目录结构

```
teamflow/
├── app/                      前端（部署这一个目录即可）
│   ├── index.html
│   ├── css/style.css
│   └── js/
│       ├── config.js         Supabase 地址与密钥
│       ├── supabase-client.js 自写 REST 客户端
│       └── app.js            业务逻辑
├── sql/schema.sql            建表 + RLS + 触发器 + 视图
├── _mock-server.js           本地 Mock 后端（开发/截图用）
├── screenshots/              界面截图
└── README.md
```

---

## 七、验收记录

| 项目 | 结果 |
| --- | --- |
| 登录 / 注册 / 登出 | 通过 |
| 项目创建与切换 | 通过 |
| 看板四列渲染 | 通过 |
| 拖拽改状态 + 统计联动 | 通过 |
| 任务增删改 | 通过 |
| 评论发布与显示 | 通过 |
| 搜索与筛选 | 通过 |
| 浏览器控制台异常 | 0 |
| 移动端适配 | 通过 |

---

## 八、开发中修掉的问题

| # | 问题 | 根因 | 修复 |
| --- | --- | --- | --- |
| 1 | 切到第二个项目必现脚本异常 | 重绘看板时用 `innerHTML` 覆盖，把空状态节点一起删掉，之后访问成空指针 | 把空状态移到看板容器外，并加空值保护 |
| 2 | 迁移到云端的部署路径下资源 404 | 用了绝对路径 | 全部改为相对路径 |
| 3 | 加载提示一直不消失 | `hidden` 属性被 `.loading{display:flex}` 覆盖 | 全局补 `[hidden]{display:none!important}` |
