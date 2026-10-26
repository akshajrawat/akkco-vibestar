import type {
  CandidateSummary,
  Watch,
  WatchRevision,
  WatchScan,
  WatchSource,
  WatchCandidate,
} from "../../../backend/issue-watch/contracts";
import type { UsageRecord } from "../../../backend/execution/output/usage";
import type { Run } from "../../lib/types";

export interface SavedWatch extends Watch {
  revision: WatchRevision | null;
  active: WatchScan | null;
  latest: WatchScan | null;
  error: string | null;
}

export interface WatchDetail {
  watch: Watch;
  revision: WatchRevision;
  active: WatchScan | null;
  baseline: WatchScan | null;
  results: CandidateSummary[];
  provider_support: Record<string, { supported: boolean; reason: string; url?: string }>;
}

export interface ScanDetail {
  scan: WatchScan;
  candidates: CandidateSummary[];
  sources: (Omit<WatchSource, "text" | "references"> & {
    body_bytes: number;
    reference_count: number;
  })[];
  run: Run | null;
  usage: UsageRecord[];
}

export interface CandidateDetail {
  candidate: WatchCandidate;
  sources: WatchSource[];
}
