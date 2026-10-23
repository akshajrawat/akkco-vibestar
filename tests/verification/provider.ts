import { FixtureProvider } from "../fixtures";
import type { AgentRunRequest } from "../../backend/execution/providers/contracts";

// The failed installation is a task-sandbox /tmp fixture executable. It never
// invokes npm, downloads a dependency or spends provider allowance.
export class ValidationBlockerProvider extends FixtureProvider {
  constructor(private readonly failAssertion = false) {
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
            await fs.writeFile(installer, '#!/bin/sh\\necho "Fixture: Playwright setup interrupted; no network used" >&2\\nexit 130\\n', { mode: 0o700 });
            await fs.writeFile('index.html', '<!doctype html><html lang="en"><head><link rel="stylesheet" href="style.css"></head><body><main><h1>Multiplication table</h1><div id="table"></div></main><script src="script.js"></script></body></html>\\n');
            await fs.writeFile('style.css', 'body { font-family: system-ui; }\\n');
            await fs.writeFile('script.js', 'const multiply = (n) => Array.from({ length: 10 }, (_, i) => n * (i + 1));\\n');
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
            const table = await execute('table', [process.execPath, '-e', "const fs=require('node:fs/promises');fs.readFile('script.js','utf8').then(s=>{const result=require('node:vm').runInNewContext(s+'multiply(7)');require('node:assert/strict').equal(JSON.stringify(result),JSON.stringify(${this.failAssertion ? "[0]" : "[7,14,21,28,35,42,49,56,63,70]"}));console.log('Generated table verified');})"]);
            const source = await execute('structure', [process.execPath, '-e', "require('node:fs/promises').readFile('index.html','utf8').then(s=>{require('node:assert/strict').ok(s.includes('lang=')&&s.includes('<main>')&&s.includes('script.js'));console.log('Source structure verified');})"]);
            const setup = await execute('setup', [installer, 'install', '--no-save', 'playwright']);
            const check = (name, command, kind, outcome, detail, prerequisite = null) => ({ name, command, kind, outcome, required: true, detail, prerequisite });
            const result = {
              summary: 'Implemented a multiplication table. Code checks passed; browser verification could not run because Playwright installation was interrupted.',
              filesChanged: ['index.html', 'script.js', 'style.css'],
              testsPassed: ['JavaScript syntax', 'Generated table', 'Source structure'],
              testsFailed: [], testsSkipped: ['Browser rendering and accessibility'],
              remainingRisks: ['Browser rendering and accessibility remain unverified.'],
              verification: [
                check('JavaScript syntax', syntax, 'check', 'passed', 'JavaScript syntax check succeeded.'),
                check('Generated table', table, 'check', 'passed', 'Generated 7 times table matches all ten expected rows.'),
                check('Source structure', source, 'check', 'passed', 'Source structure check succeeded.'),
                check('Playwright installation', setup, 'setup', 'interrupted', 'Playwright installation was interrupted with exit 130.'),
                check('Browser rendering and accessibility', 'npx playwright test', 'check', 'blocked', 'Browser checks did not run because Playwright setup was interrupted.', 'Playwright installation'),
              ],
            };
            emit({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(result) } });
            emit({ type: 'turn.completed' });
          })().catch(error => { console.error(error); process.exitCode = 1; });
        `,
          ],
        };
}
