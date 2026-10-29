import type { RepairSession } from "../../../../backend/review/repair/contracts";
import type { AgentEvent, Message, Run, TestRun } from "../../../lib/types";
import type { UsageRecord } from "../../../../backend/execution/output/usage";

export interface RepairDetail {
  session: RepairSession;
  active: boolean;
  terminal_open?: boolean;
  runs: Run[];
  events: AgentEvent[];
  messages: Message[];
  tests: TestRun[];
  usage: UsageRecord[];
  activity: { id: number; kind: string; data: string; timestamp: string }[];
  publications: { id: string; status: string; data: string }[];
}
