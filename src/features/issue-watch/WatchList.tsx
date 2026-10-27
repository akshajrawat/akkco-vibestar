import { useState } from "react";
import { Bookmark, ChevronRight, Search } from "lucide-react";

import type { SavedWatch } from "./types";
import { Button } from "../../components/ui/button";
import { EmptyState } from "../../components/ui/PageHeader";

export const WatchList = ({
  watches,
  archived,
  setArchived,
  open,
  create,
  more,
  loadMore,
}: {
  watches: SavedWatch[];
  archived: boolean;
  setArchived: (value: boolean) => void;
  open: (id: string) => void;
  create: () => void;
  more: boolean;
  loadMore: () => void;
}) => {
  const [query, setQuery] = useState("");

  const visible = watches.filter((watch) =>
    `${watch.name} ${watch.repository.full_name}`.toLowerCase().includes(query.toLowerCase()),
  );

  return (
    <main className="watch-overview">
      <div className="list-filters">
        <label className="search-field">
          <Search size={15} />
          <input
            type="search"
            aria-label="Search watches"
            placeholder="Search watches…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={archived}
            onChange={(event) => setArchived(event.target.checked)}
          />
          Archived
        </label>
      </div>
      <div className="list-caption">
        <span>
          {visible.length} saved {visible.length === 1 ? "watch" : "watches"}
        </span>
        <span>Scans run when you request them</span>
      </div>
      <div className="watch-topic-list" aria-label="Saved watches">
        {visible.map((watch) => (
          <button className="watch-topic" key={watch.id} onClick={() => open(watch.id)}>
            <Bookmark size={19} />
            <div className="watch-topic-title">
              <strong>{watch.name}</strong>
              <span>{watch.repository.full_name}</span>
            </div>
            <div className="watch-topic-status">
              <span className={watch.active ? "watch-running" : ""}>
                {watch.active
                  ? watch.active.phase
                  : watch.latest?.status === "completed"
                    ? "Scan complete"
                    : watch.latest?.status === "partial"
                      ? "Partial results"
                      : watch.latest?.status === "cancelled"
                        ? "Scan cancelled"
                        : watch.latest?.status === "failed" || watch.error
                          ? "Needs attention"
                          : watch.latest?.status || "Ready to scan"}
              </span>
              {watch.latest?.ended_at && (
                <time dateTime={watch.latest.ended_at}>
                  {new Date(watch.latest.ended_at).toLocaleDateString()}
                </time>
              )}
            </div>
            <ChevronRight size={16} />
          </button>
        ))}
      </div>
      {!visible.length && (
        <EmptyState
          icon={<Search size={24} />}
          title={
            query
              ? "No watches found"
              : archived
                ? "No archived watches"
                : "Find your next contribution"
          }
          description={
            query
              ? "Try another name or repository."
              : "Save a topic and repository, then scan for issues when you’re ready."
          }
          action={
            !query && !archived ? (
              <Button variant="default" onClick={create}>
                Create a watch
              </Button>
            ) : undefined
          }
        />
      )}
      {more && (
        <Button variant="ghost" onClick={loadMore}>
          Load more watches
        </Button>
      )}
    </main>
  );
};
