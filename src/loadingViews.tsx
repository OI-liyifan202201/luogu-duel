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
