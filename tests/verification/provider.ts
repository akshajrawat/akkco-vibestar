import { FixtureProvider } from "../fixtures";
import type { AgentRunRequest } from "../../backend/execution/providers/contracts";

// The failed installation is a task-sandbox /tmp fixture executable. It never
// invokes npm, downloads a dependency or spends provider allowance.
export class ValidationBlockerProvider extends FixtureProvider {
  constructor(
    private readonly failAssertion = false,
    private readonly environment: "interrupted" | "dns_socket" = "interrupted",
  ) {
    super();
  }
  invocation = (request: AgentRunRequest) =>
    request.stage !== 3
      ? new FixtureProvider().invocation(request)
      : {
          program: process.execPath,
          input: "",
          args: [
            "-e",
            `
          (async () => {
            const fs = require('node:fs/promises');
            const { promisify } = require('node:util');
            const execFile = promisify(require('node:child_process').execFile);
            const path = require('node:path');
            const tools = await fs.mkdtemp('/tmp/vibestar-validation-tools-');
            const installer = path.join(tools, 'npm');
            await fs.writeFile(installer, '#!/bin/sh\\necho "${this.environment === "dns_socket" ? "getaddrinfo EAI_AGAIN registry.npmjs.org" : "Fixture: Playwright setup interrupted; no network used"}" >&2\\nexit ${this.environment === "dns_socket" ? 1 : 130}\\n', { mode: 0o700 });
            await fs.writeFile('index.html', '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="style.css"></head><body><main><h1>Multiplication table of 2</h1><table><caption>Multipliers 1 through 10</caption><thead><tr><th scope="col">Expression</th><th scope="col">Result</th></tr></thead><tbody id="table"></tbody></table></main><script src="script.js"></script></body></html>\\n');
            await fs.writeFile('style.css', 'body { font-family: system-ui; margin: 24px; } table { width: 100%; max-width: 480px; border-collapse: collapse; } th, td { padding: 8px; text-align: left; border-bottom: 1px solid #aaa; }\\n');
            await fs.writeFile('script.js', 'const multiply = (n) => Array.from({ length: 10 }, (_, i) => ${this.failAssertion ? "0" : "n * (i + 1)"});\\nif (typeof document !== "undefined") { const target = document.getElementById("table"); multiply(2).forEach((value, index) => { const row = document.createElement("tr"); ["2 × " + (index + 1), String(value)].forEach((text) => { const cell = document.createElement("td"); cell.textContent = text; row.appendChild(cell); }); target.appendChild(row); }); }\\n');
            const emit = (value) => console.log(JSON.stringify(value));
            const execute = async (id, argv) => {
              const command = JSON.stringify(argv);
              emit({ type: 'item.started', item: { id, type: 'command_execution', command, status: 'in_progress' } });
              let output = '', exit = 0;
              try {
                const result = await execFile(argv[0], argv.slice(1));
                output = result.stdout + result.stderr;
              } catch (error) {
                output = (error.stdout || '') + (error.stderr || '');
                exit = error.code;
              }
              emit({ type: 'item.completed', item: { id, type: 'command_execution', command, status: exit === 0 ? 'completed' : 'failed', aggregated_output: output, exit_code: exit } });
              return command;
            };
            const syntax = await execute('syntax', [process.execPath, '--check', 'script.js']);
            const table = await execute('table', [process.execPath, '-e', "const fs=require('node:fs/promises');fs.readFile('script.js','utf8').then(s=>{const result=require('node:vm').runInNewContext(s+'multiply(7)');require('node:assert/strict').equal(JSON.stringify(result),JSON.stringify([7,14,21,28,35,42,49,56,63,70]));console.log('Generated table verified');})"]);
            const source = await execute('structure', [process.execPath, '-e', "require('node:fs/promises').readFile('index.html','utf8').then(s=>{require('node:assert/strict').ok(s.includes('lang=')&&s.includes('<main>')&&s.includes('script.js'));console.log('Source structure verified');})"]);
            const setup = ${request.prompt.includes("One Codex iteration is authorized") ? "JSON.stringify([installer, 'install', '--no-save', 'playwright'])" : "await execute('setup', [installer, 'install', '--no-save', 'playwright'])"};
            ${this.environment === "dns_socket" ? `const socket = await execute('socket', [process.execPath, '-e', "process.stderr.write('listen EPERM 127.0.0.1:8000');process.exit(1)"]);` : ""}
            const check = (name, command, kind, outcome, detail, prerequisite = null) => ({ name, command, kind, outcome, required: true, detail, prerequisite, scope: 'repository' });
            const result = {
              summary: 'Implemented a multiplication table. Deterministic checks were executed; browser verification remains incomplete because ${this.environment === "dns_socket" ? "registry DNS and loopback sockets are unavailable" : "Playwright setup was interrupted"}.',
              filesChanged: ['index.html', 'script.js', 'style.css'],
              testsPassed: ['JavaScript syntax', 'Generated table', 'Source structure'],
              testsFailed: [], testsSkipped: ['Browser rendering and accessibility'],
              remainingRisks: ['Browser rendering and accessibility remain unverified.'],
              verification: [
                check('JavaScript syntax', syntax, 'check', 'passed', 'JavaScript syntax check succeeded.'),
                check('Generated table', table, 'check', 'passed', 'Generated 7 times table matches all ten expected rows.'),
                check('Source structure', source, 'check', 'passed', 'Source structure check succeeded.'),
                check('Playwright installation', setup, 'setup', '${this.environment === "dns_socket" ? "blocked" : "interrupted"}', '${this.environment === "dns_socket" ? "EAI_AGAIN resolving registry.npmjs.org. Playwright installation unavailable." : "Playwright installation was interrupted with exit 130."}'),
                check('Browser rendering and accessibility', 'npx playwright test', 'check', 'blocked', 'Browser checks did not run because ${this.environment === "dns_socket" ? "registry DNS is unavailable" : "Playwright setup was interrupted"}.', 'Playwright installation'),
                ${
                  this.environment === "dns_socket"
                    ? `check('Loopback server setup', socket, 'setup', 'blocked', 'listen EPERM 127.0.0.1:8000'),
                check('HTTP launch verification', null, 'check', 'blocked', 'HTTP verification requires a listening socket.', 'Loopback server setup'),`
                    : ""
                }
              ],
            };
            emit({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(result) } });
            emit({ type: 'turn.completed' });
          })().catch(error => { console.error(error); process.exitCode = 1; });
        `,
          ],
        };
}

export class IndependentReviewProvider extends ValidationBlockerProvider {
  invocation = (request: AgentRunRequest) => {
    if (request.stage !== 5)
      return new ValidationBlockerProvider(false, "dns_socket").invocation(
        request,
      );
    const packet = request.prompt.split("COMPLETE REVIEW EVIDENCE: ").at(-1)!;
    return {
      program: process.execPath,
      input: "",
      args: [
        "-e",
        `(async () => {
        const fs = require('node:fs/promises');
        const evidence = JSON.parse(await fs.readFile(${JSON.stringify(packet)}, 'utf8'));
        require('node:assert/strict').ok(evidence.verification.checks.some(c => c.name === 'Browser rendering and accessibility' && c.outcome === 'blocked'));
        let refused = false;
        try { await fs.writeFile('script.js', 'unauthorized'); } catch { refused = true; }
        require('node:assert/strict').ok(refused, 'Reviewer must be read-only');
        const argv = ['node', '--check', 'script.js'];
        await require('node:util').promisify(require('node:child_process').execFile)(argv[0], argv.slice(1));
        const emit = (item) => console.log(JSON.stringify({type:'item.completed',item}));
        emit({id:'independent-syntax',type:'command_execution',command:JSON.stringify(argv),status:'completed',exit_code:0});
        emit({type:'agent_message',text:JSON.stringify({approval:'approved',summary:'Code inspected independently; browser checks remain unavailable.',findings:[],testsRun:['node --check script.js'],testsNotRun:['Browser rendering and accessibility','Independent mobile viewport'],verification:[{name:'Independent mobile viewport',command:'npx playwright test --project=mobile',kind:'check',outcome:'blocked',required:true,detail:'Mobile viewport was not executed because browser tooling is unavailable.',prerequisite:'Playwright installation'}],environmentLimitations:['Playwright unavailable'],implementationConcerns:[],recommendedNextActions:['Run browser checks in a supported environment']})});
        console.log(JSON.stringify({type:'turn.completed'}));
      })().catch(error => {console.error(error);process.exitCode=1;});`,
      ],
    };
  };
}
