import type { AgentProvider, AgentRunRequest } from "../../backend/execution/providers/contracts";
import { CodexProvider } from "../../backend/execution/providers/codex";

// Only injected from tests. Production has no fixture provider selection.
export class RepairFixtureProvider implements AgentProvider {
  private readonly adapter = new CodexProvider();

  constructor(
    readonly name: "codex" | "antigravity",
    private readonly options: {
      blocked?: boolean;
      missingItem?: boolean;
      wait?: boolean;
      readonlyProbe?: boolean;
    } = {},
  ) {}

  detect = async () => ({
    provider: "test-fixture",
    installed: true,
    version: "TEST ONLY",
    connected: true,
    models: [{ id: "repair-model", supportedEfforts: ["high", "xhigh"] }],
    efforts: ["high", "xhigh"],
    capabilities: ["test-fixture"],
    error: null,
  });

  normalize = this.adapter.normalize;

  result = this.adapter.result;

  conversationId = this.adapter.conversationId;

  invocation = (request: AgentRunRequest) => {
    const context = request.prompt.match(/context directory ([^\n]+?)\. It contains/)?.[1];
    const implementation = request.stage === 3;
    const testFile = `const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const {selectors,hasDraft}=require('./utilities.cjs');test('selectors live in utilities',()=>assert.deepEqual(selectors,['draft','publish']));test('original exploration is retained',async()=>assert.ok((await fs.readFile('spec.ts','utf8')).includes(require('./legacy-puppeteer.cjs').exploration)));test('draft assertion rejects an empty list',()=>{assert.equal(hasDraft([]),false);assert.equal(hasDraft(['draft']),true)});`;

    const action = implementation
      ? `await fs.writeFile('utilities.cjs',"exports.selectors=['draft','publish'];exports.hasDraft=(items)=>items.includes('draft');\\n");await fs.writeFile('spec.ts',"// Selectors/assertions moved to utilities.cjs; original-exploration retained.\\n");await fs.writeFile('repair.test.cjs',${JSON.stringify(testFile)});`
      : "";

    return {
      program: process.execPath,
      input: "",
      args: [
        "-e",
        `(async()=>{
      const fs=require('node:fs/promises');const cp=require('node:child_process');const util=require('node:util');
      const context=JSON.parse(await fs.readFile(${JSON.stringify(context)}+'/review.json','utf8'));
      if(!context.snapshot.discussion[0].body.includes('test for the draft'))throw Error('Full review context missing');
      console.log(JSON.stringify({type:'thread.started',thread_id:'repair-fixture-session'}));
      ${action}
      ${this.options.readonlyProbe ? "try{await fs.writeFile('forbidden-review-edit','blocked');throw Error('Reviewer was writable');}catch(e){if(!['EROFS','EACCES'].includes(e.code))throw e;}" : ""}
      ${this.options.wait ? "await new Promise(resolve=>setTimeout(resolve,60000));" : ""}
      const command='node --test repair.test.cjs';
      console.log(JSON.stringify({type:'item.started',item:{id:'test-call',type:'command_execution',command,status:'running'}}));
      const output=await util.promisify(cp.execFile)(process.execPath,['--test','repair.test.cjs']);
      console.log(JSON.stringify({type:'item.completed',item:{id:'test-call',type:'command_execution',command,status:'completed',exit_code:0,stdout:output.stdout,stderr:output.stderr}}));
      const items=context.selectedActions${this.options.missingItem ? ".slice(1)" : ""}.map(a=>({actionId:a.id,status:${JSON.stringify(implementation ? "implemented" : this.options.blocked ? "unverified" : "accepted")},files:['utilities.cjs','spec.ts','repair.test.cjs'],explanation:a.classification==='question'?'Original exploration retained and explained locally':'Review concern addressed and tested'${implementation ? ",tests:[{command,status:'passed',evidence:'Observed fixture test command'}]" : ""}}));
      const result=${implementation ? "{summary:'Moved selectors, retained exploration and strengthened draft assertion',items,tests:[{command,status:'passed',evidence:'Observed test command'}],risks:[]}" : `{overall:${JSON.stringify(this.options.blocked ? "blocked" : "approved")},summary:'Independent read-only review',items,tests:[{command,status:'passed',evidence:'Independent test execution'},{command:'browser integration',status:'blocked',evidence:'Browser dependency unavailable in fixture'}],risks:[]}`};
      console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(result)}}));
      console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:40,output_tokens:20}}));
    })().catch(e=>{console.error(e);process.exit(1)});`,
      ],
    };
  };
}
