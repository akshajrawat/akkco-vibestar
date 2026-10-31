import { useEffect, useState } from "react";
import { Search } from "lucide-react";

import type { CandidateSummary, WatchScan } from "../../../backend/issue-watch/contracts";
import { Select } from "../../components/ui/Select";
import { IssueGitHubLink } from "./IssueGitHubLink";
import { availabilityState, claimLabel } from "./availability";

const sortOptions = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "updated", label: "Recently updated" },
];

export const ScanResults = ({
  candidates,
  discoveryOrder,
  selected,
  onSelect,
  provisional,
  showDismissed,
  status,
  onError,
}: {
  candidates: CandidateSummary[];
  discoveryOrder?: "newest" | "oldest";
  selected: string;
  onSelect: (id: string) => void;
  provisional: boolean;
  showDismissed: boolean;
  status?: WatchScan["status"];
  onError: (error: string) => void;
}) => {
  const [filter, setFilter] = useState("matches");
  const [query, setQuery] = useState("");

  const [sort, setSort] = useState(() => {
    if (discoveryOrder) return discoveryOrder;
    const saved = localStorage.getItem("vibestar.issueWatch.sort");
    return sortOptions.some((option) => option.value === saved) ? saved! : "newest";
  });

  useEffect(() => {
    if (discoveryOrder) setSort(discoveryOrder);
  }, [discoveryOrder]);

  const visible = candidates
    .filter((candidate) => {
      if (
        !`${candidate.issue.title} #${candidate.issue.number} ${candidate.issue.labels.join(" ")}`
          .toLowerCase()
          .includes(query.toLowerCase())
      )
        return false;
      if (filter === "dismissed") return !!candidate.dismissed_at;
      if (!showDismissed && candidate.dismissed_at) return false;
      if (filter === "matches") return candidate.eligible;
      if (filter === "new")
        return ["new_issue", "newly_matching", "reentered", "criteria_changed"].includes(
          candidate.classification,
        );
      const claim = availabilityState(candidate, provisional);
      if (filter === "available")
        return candidate.eligible && claim === "candidate_for_claim_request";
      if (filter === "review") return candidate.eligible && claim !== "candidate_for_claim_request";
      if (filter === "seen")
        return ["existing_match", "not_rechecked"].includes(candidate.classification);
      return true;
    })
    .sort((a, b) => {
      const field = sort === "updated" ? "updated_at" : "created_at";
      const order = sort === "oldest" ? 1 : -1;
      return (
        order *
        (Date.parse(a.issue[field]) - Date.parse(b.issue[field]) ||
          a.issue.number - b.issue.number ||
          a.issue.id.localeCompare(b.issue.id))
      );
    });

  return (
    <>
      <div className="watch-results-controls">
        <label className="search-field">
          <Search size={14} />
          <input
            type="search"
            aria-label="Search issues"
            placeholder="Search issues…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <Select
          label="Filter results"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "matches", label: "Matching issues" },
            { value: "all", label: "All results" },
            { value: "new", label: "New since last completed scan" },
            { value: "available", label: "Available to request" },
            { value: "review", label: "Needs review" },
            { value: "seen", label: "Previously seen" },
            { value: "dismissed", label: "Dismissed" },
          ]}
        />
        <Select
          label="Sort issues"
          value={sort}
          options={sortOptions}
          onChange={(value) => {
            setSort(value);
            localStorage.setItem("vibestar.issueWatch.sort", value);
          }}
        />
      </div>
      <div className="watch-results-caption">
        <span>
          {visible.length} {visible.length === 1 ? "issue" : "issues"}
        </span>
        <span>
          {provisional
            ? "Incomplete scan · availability needs rechecking"
            : "Availability reflects the last check"}
        </span>
      </div>
      <div
        className="watch-results-list"
        role="list"
        aria-label="Discovery results"
        onKeyDown={(event) => {
          if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;

          const rows = [
            ...event.currentTarget.querySelectorAll<HTMLButtonElement>(".watch-result-select"),
          ];

          const index = rows.indexOf(event.target as HTMLButtonElement);
          if (index < 0) return;

          const next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? rows.length - 1
                : Math.max(
                    0,
                    Math.min(rows.length - 1, index + (event.key === "ArrowUp" ? -1 : 1)),
                  );

          if (rows[next]) {
            event.preventDefault();
            rows[next].focus();
            rows[next].click();
          }
        }}
      >
        {visible.map((candidate) => {
          const claim = availabilityState(candidate, provisional);
          return (
            <article
              role="listitem"
              key={candidate.issue.id}
              className={`watch-result ${candidate.issue.id === selected ? "selected" : ""}`}
            >
              <button
                id={`watch-result-${candidate.issue.id}`}
                aria-label={`Select #${candidate.issue.number}: ${candidate.issue.title}`}
                aria-pressed={candidate.issue.id === selected}
                className="watch-result-select"
                onClick={() => onSelect(candidate.issue.id)}
              >
                <div className="watch-result-heading">
                  <span className="watch-issue-number">#{candidate.issue.number}</span>
                  <strong>{candidate.issue.title}</strong>
                  {candidate.dismissed_at && <small>Dismissed</small>}
                </div>
                <div className="watch-result-meta">
                  <span className={`watch-claim ${claim}`}>{claimLabel(claim)}</span>
                  <time
                    dateTime={candidate.issue.created_at}
                    title={`Created ${new Date(candidate.issue.created_at).toLocaleString()}`}
                  >
                    Opened {new Date(candidate.issue.created_at).toLocaleDateString()}
                  </time>
                  <span title={new Date(candidate.checked_at).toLocaleString()}>
                    Checked {new Date(candidate.checked_at).toLocaleDateString()}
                  </span>
                </div>
              </button>
              <IssueGitHubLink issue={candidate.issue} onError={onError} />
            </article>
          );
        })}
        {!visible.length && (
          <div className="watch-empty">
            <h3>
              {!["all", "matches"].includes(filter) || query
                ? "No issues match this filter"
                : !status
                  ? "Ready for your first scan"
                  : ["running", "cancelling", "reserved"].includes(status)
                    ? "Scan in progress"
                    : status === "completed"
                      ? "No matching issues in this scan"
                      : `${status[0].toUpperCase()}${status.slice(1)} scan`}
            </h3>
            <p>
              {!status
                ? "Scan when you’re ready. The first completed scan establishes your baseline."
                : status === "completed"
                  ? "Try adjusting your criteria. Coverage details show what was checked."
                  : "Results appear as evidence becomes available. Previous complete results are preserved."}
            </p>
          </div>
        )}
      </div>
    </>
  );
};
