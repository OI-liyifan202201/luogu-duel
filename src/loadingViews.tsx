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

export const BootScreen = ({ leaving }: { leaving: boolean }) => (
  <main class={`boot-screen${leaving ? " leaving" : ""}`} aria-label="正在载入">
    <section class="auth-card boot-auth-skeleton" aria-hidden="true">
      <div class="auth-intro"><i /><small /><strong /><span /></div>
      <div class="paste-login"><strong /><div class="boot-auth-tabs"><i /><i /></div><span /><div class="boot-auth-lines"><i /><i /></div><footer><i /><b /></footer></div>
    </section>
  </main>
);

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
