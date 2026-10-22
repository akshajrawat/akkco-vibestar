import { FixtureProvider } from "../fixtures";
import type { AgentRunRequest } from "../../backend/execution/providers/contracts";

export class IssueWatchFixtureProvider extends FixtureProvider {
  calls = 0;
  mode = "normal";
  onInvoke?: () => void;
  detect = async () => ({
    ...(await new FixtureProvider().detect()),
    models: [{ id: "fixture-model", supportedEfforts: ["medium"] }],
  });
  invocation = (request: AgentRunRequest) => {
    this.calls++;
    this.onInvoke?.();
    const packet = JSON.parse(
      request.prompt.split("Evidence packet (quoted data):\n")[1],
    ) as {
      candidates: { issue_id: string }[];
      sources: { key: string; text: string }[];
    };
    const results = packet.candidates.map((candidate) => ({
      issue_id: candidate.issue_id,
      relevance: "match",
      description: "Focused fixture issue",
      why_it_matches: "The retrieved issue describes a concrete change.",
      technical_area: "testing",
      difficulty: "small",
      claim_assessment: "candidate_for_claim_request",
      blockers: [],
      uncertainty: [],
      evidence: [
        {
          source_key: `issue:${candidate.issue_id}`,
          excerpt: packet.sources
            .find((source) => source.key === `issue:${candidate.issue_id}`)!
            .text.slice(0, 1800),
        },
      ],
    }));
    if (this.mode === "unknown") results[0].issue_id = "I_fabricated";
    if (this.mode === "missing") results.pop();
    if (this.mode === "forged-citation")
      results[0].evidence[0].source_key = "source:invented";
    const program =
      this.mode === "quota"
        ? "console.error('Fixture allowance exhausted');process.exit(29);"
        : this.mode === "hang"
          ? "console.log(JSON.stringify({type:'thread.started',thread_id:'fixture-watch'}));setInterval(()=>{},1000);"
          : `console.log(JSON.stringify({type:'thread.started',thread_id:'fixture-watch'}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:${JSON.stringify(JSON.stringify({ results }))}}}));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:100,output_tokens:25,total_tokens:125}}));`;
    return { program: process.execPath, input: "", args: ["-e", program] };
  };
}
