import { test, expect } from '@jest/globals';
import { mkdtemp, writeFile, chmod, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

test.each(['automation', 'recurring-tool'])('real helper commits an effect then exits: %s preserves unknown outcome', async (mode) => {
  const root = await mkdtemp(join(tmpdir(), 'taxi-outcome-'));
  const bridge = join(root, 'bridge');
  const effects = join(root, 'effects.txt');
  try {
    await writeFile(bridge, `#!${process.execPath}
const readline = require('node:readline');
const fs = require('node:fs');
process.stdout.write(JSON.stringify({id:'__ready__'})+'\\n');
readline.createInterface({input:process.stdin}).on('line', line => {
  const req=JSON.parse(line);
  if(req.command==='list-commands') {
    process.stdout.write(JSON.stringify({id:req.id,result:['create-reminder']})+'\\n');
  } else {
    fs.appendFileSync(process.env.TAXI_FIXTURE_EFFECTS, 'committed\\n');
    process.exit(1);
  }
});
`);
    await chmod(bridge, 0o700);
    const automation = pathToFileURL(resolve('dist/shared/automation.js')).href;
    const swift = pathToFileURL(resolve('dist/shared/swift.js')).href;
    const reminders = pathToFileURL(resolve('dist/reminders/tools.js')).href;
    const script = mode === 'recurring-tool' ? `
      import {registerReminderTools} from ${JSON.stringify(reminders)};
      import {closeSwiftBridge} from ${JSON.stringify(swift)};
      const handlers = new Map();
      registerReminderTools({registerTool:(name,config,handler)=>handlers.set(name,handler)}, {});
      try {
        const result = await handlers.get('create_recurring_reminder')({title:'fixture',recurrence:{frequency:'daily',interval:1}});
        console.log(JSON.stringify(result.structuredContent.error));
      } finally { closeSwiftBridge(); }
    ` : `
      import {runAutomation} from ${JSON.stringify(automation)};
      import {closeSwiftBridge} from ${JSON.stringify(swift)};
      let fallback=false;
      try {
        await runAutomation({swift:{command:'create-reminder'},jxa:()=>{fallback=true;return 'JSON.stringify({})';}});
        throw new Error('Expected uncertain result');
      } catch(e) {
        if(e.name!=='AutomationOutcomeUnknownError') throw e;
        console.log(JSON.stringify({outcome:'unknown',fallback,origin:e.origin}));
      } finally {closeSwiftBridge();}
    `;
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8', timeout: 15000,
      env: {...process.env, TAXI_BRIDGE_PATH:bridge, TAXI_FIXTURE_EFFECTS:effects},
    });
    if (mode === 'recurring-tool') {
      expect(JSON.parse(output)).toMatchObject({category:'upstream_error',retryable:false,cause:{origin:'swift',code:'outcome_unknown'}});
    } else {
      expect(JSON.parse(output)).toEqual({outcome:'unknown',fallback:false,origin:'swift'});
    }
    expect(await readFile(effects,'utf8')).toBe('committed\n');
  } finally { await rm(root,{recursive:true,force:true}); }
});
