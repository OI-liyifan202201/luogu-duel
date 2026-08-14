import type { ComponentChildren } from "preact";

type SkeletonRowsProps = {
  count?: number;
  compact?: boolean;
};

export const SkeletonRows = ({ count = 5, compact = false }: SkeletonRowsProps) => (
  <div class={`skeleton-rows${compact ? " compact" : ""}`} aria-hidden="true">
    {Array.from({ length: count }, (_, index) => (
      <div class="skeleton-row" key={index}>
        <i />
        <span />
        <b />
      </div>
    ))}
  </div>
);

export const RoomListSkeleton = () => (
  <div class="duel-table room-list-skeleton" aria-hidden="true">
    {Array.from({ length: 6 }, (_, index) => (
      <div class="duel-row skeleton-item" key={index}>
        <code />
        <span class="sk-line"><b /><i /></span>
        <span class="sk-diff"><b /><em /></span>
        <em />
      </div>
    ))}
  </div>
);

export const RankingSkeleton = () => <div class="ranking-list ranking-skeleton" aria-hidden="true">{Array.from({ length: 7 }, (_, index) => <div class="ranking-row skeleton-item" key={index}><i /><span /><b /><code /><em /></div>)}</div>;

export const ChatSkeleton = () => <div class="chat-skeleton" aria-hidden="true">{Array.from({ length: 5 }, (_, index) => <div class={`chat-line bubble skeleton-item ${index % 3 === 1 ? "mine" : "theirs"}`} key={index}><i class="chat-avatar" /><span><b /><em /></span></div>)}</div>;

export const AdminPlayersSkeleton = () => <div class="admin-players-skeleton" aria-hidden="true">{Array.from({ length: 7 }, (_, index) => <div class="admin-player skeleton-item" key={index}><i /><span><b /><em /></span><label /><button /><strong /></div>)}</div>;

export const AdminRoomsSkeleton = () => <div class="admin-rooms-skeleton" aria-hidden="true">{Array.from({ length: 4 }, (_, index) => <div class="admin-room skeleton-item" key={index}><code /><span><b /><em /></span><button /></div>)}</div>;

// 个人主页加载骨架：与真实个人主页布局一致，避免看起来像登陆页骨架
export const ProfileSkeleton = () => (
  <main class="profile-page">
    <div class="profile-card profile-loading-skeleton" aria-hidden="true">
      <header class="profile-hero">
        <i class="profile-avatar skeleton-shape" />
        <div class="profile-identity"><small class="skeleton-shape" /><b class="skeleton-shape" /><span class="skeleton-shape" /></div>
        <div class="profile-rating-summary"><em class="skeleton-shape" /><strong class="skeleton-shape" /></div>
      </header>
      <nav class="profile-tabs"><i class="skeleton-shape" /><i class="skeleton-shape" /><i class="skeleton-shape" /></nav>
      <div class="profile-home-layout">
        <section class="profile-home-main">
          <div class="profile-content-head"><b class="skeleton-shape" /><i class="skeleton-shape" /></div>
          <div class="profile-home-scroll profile-skeleton-copy"><i class="skeleton-shape" /><i class="skeleton-shape" /><i class="skeleton-shape" /><i class="skeleton-shape" /></div>
        </section>
        <aside class="profile-sidebar">
          <section class="rating-curve-card profile-skeleton-chart"><div><i class="skeleton-shape" /><strong class="skeleton-shape" /></div><span class="skeleton-shape" /></section>
          <div class="profile-stats"><i class="skeleton-shape" /><strong class="skeleton-shape" /><small class="skeleton-shape" /></div>
        </aside>
      </div>
    </div>
  </main>
);

// ===== 整页加载骨架：顶栏 + 与目标页面一致的内容骨架 =====

// 顶栏骨架：与 Shell 的 topbar 布局一致（品牌区 / 状态胶囊 / 会话区），
// 避免加载完成后顶栏突然出现造成的布局跳动。
export const TopBarSkeleton = () => (
  <header class="topbar skeleton-topbar" aria-hidden="true">
    <span class="brand"><i class="skeleton-shape sk-logo" /><b class="skeleton-shape" /><em class="skeleton-shape" /></span>
    <span class="status-pill"><i class="skeleton-shape" /></span>
    <span class="session"><i class="skeleton-shape sk-icon-btn" /><b class="skeleton-shape sk-user" /></span>
  </header>
);

// 页面骨架外壳：顶栏骨架 + 页面骨架，结构对齐真实 Shell。
export const SkeletonShell = ({ children }: { children?: ComponentChildren }) => (
  <div class="app-shell skeleton-shell">
    <TopBarSkeleton />
    {children}
  </div>
);

// 房间加载骨架：与 Room 的 room-grid 布局一致（灵动岛 + 三栏面板）。
export const RoomSkeleton = () => (
  <main class="room-grid room-loading" aria-hidden="true">
    <div class="skeleton-match-island"><i /><span /><b /></div>
    <div class="panel skeleton-panel"><div class="sk-panel-head"><i /><b /></div><SkeletonRows count={4} compact /></div>
    <div class="panel skeleton-panel"><div class="sk-panel-head"><i /><b /></div><SkeletonRows count={5} compact /></div>
    <div class="panel skeleton-panel"><div class="sk-panel-head"><i /><b /></div><SkeletonRows count={6} compact /></div>
  </main>
);

// 主页骨架：与 Home 的 home-grid 布局一致（创建面板 + 房间列表 + 聊天）。
export const HomeSkeleton = () => (
  <main class="home-grid home-skeleton" aria-hidden="true">
    <section class="command-panel">
      <div class="section-head"><i class="skeleton-shape sk-icon" /><div><b class="skeleton-shape sk-title" /><span class="skeleton-shape sk-sub" /></div></div>
      <div class="home-announcement"><b class="skeleton-shape" /><span class="skeleton-shape" /><span class="skeleton-shape" /><span class="skeleton-shape" /></div>
    </section>
    <section class="panel home-room-panel">
      <div class="section-head"><i class="skeleton-shape sk-icon" /><div><b class="skeleton-shape sk-h2" /></div><span class="skeleton-shape sk-btn" /></div>
      <div class="home-tabs"><i class="skeleton-shape" /><i class="skeleton-shape" /></div>
      <RoomListSkeleton />
    </section>
    <section class="panel home-chat-panel">
      <ChatSkeleton />
    </section>
  </main>
);

// 管理页骨架：与 AdminPage 布局一致（页头 + 玩家管理 + 房间管理）。
export const AdminSkeleton = () => (
  <main class="admin-page admin-skeleton" aria-hidden="true">
    <header class="admin-page-head">
      <div><i class="skeleton-shape sk-icon" /><span><b class="skeleton-shape sk-title" /><em class="skeleton-shape sk-sub" /></span></div>
      <div class="admin-stats"><strong class="skeleton-shape" /><span class="skeleton-shape" /><strong class="skeleton-shape" /><span class="skeleton-shape" /></div>
      <i class="skeleton-shape sk-btn" />
    </header>
    <section class="panel admin-section">
      <div class="admin-section-head"><div><b class="skeleton-shape sk-h2" /><em class="skeleton-shape sk-sub" /></div></div>
      <AdminPlayersSkeleton />
    </section>
    <section class="panel admin-section">
      <div class="admin-section-head"><div><b class="skeleton-shape sk-h2" /></div></div>
      <AdminRoomsSkeleton />
    </section>
  </main>
);
