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
  <div class="room-list-skeleton" aria-hidden="true">
    {Array.from({ length: 6 }, (_, index) => (
      <div key={index}>
        <code />
        <span class="sk-line"><b /><i /></span>
        <span class="sk-diff"><b /><em /></span>
        <em />
      </div>
    ))}
  </div>
);

export const RankingSkeleton = () => <div class="ranking-skeleton" aria-hidden="true">{Array.from({ length: 7 }, (_, index) => <div key={index}><i /><span /><b /><code /><em /></div>)}</div>;

export const ChatSkeleton = () => <div class="chat-skeleton" aria-hidden="true">{Array.from({ length: 5 }, (_, index) => <div class={index % 3 === 1 ? "mine" : ""} key={index}><i /><span><b /><em /></span></div>)}</div>;

export const AdminPlayersSkeleton = () => <div class="admin-players-skeleton" aria-hidden="true">{Array.from({ length: 7 }, (_, index) => <div key={index}><i /><span><b /><em /></span><label /><button /><strong /></div>)}</div>;

export const AdminRoomsSkeleton = () => <div class="admin-rooms-skeleton" aria-hidden="true">{Array.from({ length: 4 }, (_, index) => <div key={index}><code /><span><b /><em /></span><button /></div>)}</div>;

export const BootScreen = ({ leaving }: { leaving: boolean }) => (
  <main class={`boot-screen${leaving ? " leaving" : ""}`} aria-label="正在载入">
    <div class="boot-skeleton" aria-hidden="true">
      <header><i /><span /><b /></header>
      <section class="boot-skeleton-grid">
        <div class="boot-skeleton-primary"><i /><strong /><span /><span /><b /></div>
        <div><i /><strong /><SkeletonRows count={4} compact /></div>
        <div><i /><strong /><SkeletonRows count={5} compact /></div>
      </section>
    </div>
  </main>
);
