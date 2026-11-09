// Fake CLIs and installer only: real first-run UI, update, guided sign-in and first-boton default.
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { existsSync, mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { startServer, freePort } from '../server/test/helpers.ts';
const home=mkdtempSync(join(tmpdir(),'botons-brain-update-'));
process.env.CODEX_HOME=join(home,'codex');process.env.CLAUDE_CONFIG_DIR=join(home,'claude');
const runtime=join(home,'node/bin/node');mkdirSync(dirname(runtime),{recursive:true});symlinkSync(process.execPath,runtime);
const signed=join(home,'signed-in'), approve=join(home,'approve');
const old=join(home,'system-codex');writeFileSync(old,'#!/bin/sh\necho "codex-cli 0.160.0"\n',{mode:0o700});
const s=await startServer({home,env:{BOTONS_CODEX_BIN:old,BOTONS_ENABLE_MOCK:'0'},configure:cfg=>{cfg.webDist=resolve('web/dist');cfg.hostname='myhost';},appOptions:{cliInstaller:{root:join(home,'botons-prefix'),node:runtime,run:async(_cmd,args)=>{
  const bin=join(args[args.indexOf('--prefix')+1],'bin/codex');mkdirSync(dirname(bin),{recursive:true});
  writeFileSync(bin,`#!${runtime}\nconst fs=require('node:fs');\nif(process.argv[2]==='--version')console.log('codex-cli 0.167.0');\nelse if(process.argv[2]==='sandbox')console.log('BOTONS_WORKSPACE_PROBE_OK');\nelse if(process.argv.includes('model_provider="preflight"'))console.log(JSON.stringify({type:'thread.started'}));\nelse if(process.argv[3]==='--device-auth'){console.log('https://auth.openai.com/codex/device\\nABCD-EFGHJ');const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(approve)})){fs.writeFileSync(${JSON.stringify(signed)},'yes');clearInterval(t);}},10);}\nelse {const ok=fs.existsSync(${JSON.stringify(signed)});console.log(ok?'Logged in using ChatGPT':'Not logged in');process.exitCode=ok?0:1;}\n`,{mode:0o700});
}}}});
s.app.store.updateSettings({ownerName:'Sam'});
// A fresh CLI checker starts at 1; make the old card's generation larger first.
for(let i=0;i<4;i++)await s.app.providers.infos({recheck:true});
const chrome=process.env.CHROME_BIN || ['/opt/google/chrome/chrome','/usr/bin/google-chrome','/usr/bin/chromium'].find(existsSync);
const browser=await chromium.launch({executablePath:chrome,args:['--no-sandbox']});
try{
  const page=await browser.newPage({viewport:{width:1280,height:900}});
  await page.addInitScript(token=>localStorage.setItem('botons.deviceToken',token),s.token);await page.goto(s.base);
  await page.getByRole('button',{name:'Continue',exact:true}).click();await page.getByRole('button',{name:'Continue',exact:true}).click();
  await page.getByRole('button',{name:'Use my Claude or ChatGPT subscription'}).click();await page.getByText('Needs update',{exact:true}).waitFor();
  // No ready brain: the first-boton form must offer recovery instead of native empty-select validation.
  await page.getByRole('button',{name:'Continue',exact:true}).click();await page.getByRole('button',{name:'go back to Brains',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Create',exact:true}).isDisabled(),true);
  await page.getByRole('button',{name:'go back to Brains',exact:true}).click();await page.getByRole('button',{name:'Use my Claude or ChatGPT subscription'}).click();
  await page.getByRole('button',{name:'Update now',exact:true}).click();await page.getByRole('button',{name:'Install and use this copy',exact:true}).click();
  await page.getByText('✓ CLI installed and selected. Continue with sign-in if needed.',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Update now',exact:true}).count(),0);
  await page.getByRole('button',{name:'Sign in to ChatGPT',exact:true}).click();await page.getByText('ABCD-EFGHJ',{exact:true}).waitFor();writeFileSync(approve,'owner approved fake login');
  await page.getByText('Ready ✓',{exact:true}).waitFor();
  assert.equal((await s.call('GET','/api/providers')).data.find((p: any) => p.id === 'codex-cli').workspaceProblem, null, 'the updated fixture supports the Workspace preflight');
  assert.equal(await page.getByText('Needs update',{exact:true}).count(),0);
  await page.getByRole('button',{name:'Continue',exact:true}).click();await page.getByRole('heading',{name:'Your first Boton',exact:true}).waitFor();
  const select=page.getByRole('combobox');await page.getByRole('button',{name:'Check again',exact:true}).waitFor();
  await page.waitForFunction(()=>document.querySelector<HTMLSelectElement>('select')?.value==='codex-cli');
  assert.equal(await select.inputValue(),'codex-cli');await page.getByLabel('Name',{exact:true}).fill('Kevin');
  await page.getByRole('button',{name:'Create',exact:true}).click();await page.getByRole('heading',{name:'Fresh out of the fryer',exact:true}).waitFor();
  const bots=(await s.call('GET','/api/bots')).data;assert.equal(bots[0].provider,'codex-cli');
  const out=process.env.BOTONS_PROOF_DIR;if(out){mkdirSync(out,{recursive:true});await page.screenshot({path:join(out,'first-boton-created.png'),fullPage:true});}
  // Keep the chosen API brain stale until the first-boton entry refresh completes.
  const models=createServer((_req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:'claude-fake-kevin',display_name:'Kevin',type:'model'}],has_more:false}));});
  const port=await freePort();await new Promise<void>(r=>models.listen(port,'127.0.0.1',r));
  const apiServer=await startServer({appOptions:{apiKeys:{testEndpoints:{anthropic:`http://127.0.0.1:${port}`}}},configure:cfg=>{cfg.webDist=resolve('web/dist');cfg.hostname='myhost';}});
  try {
    apiServer.app.store.updateSettings({ownerName:'Sam'});
    const apiPage=await browser.newPage();await apiPage.addInitScript(token=>localStorage.setItem('botons.deviceToken',token),apiServer.token);
    let entering=false;let releaseEntry!:()=>void;const entry=new Promise<void>(r=>{releaseEntry=r;});
    await apiPage.route('**/api/providers*',async route=>{
      const response=await route.fetch();const data=await response.json();
      if(entering)await entry;
      else {const p=data.find((p:any)=>p.id==='anthropic-api');p.available=false;p.readiness.state='signed-out';p.readiness.problem='signed-out';}
      await route.fulfill({response,json:data});
    });
    await apiPage.goto(apiServer.base);await apiPage.getByRole('button',{name:'Continue',exact:true}).click();await apiPage.getByRole('button',{name:'Continue',exact:true}).click();
    await apiPage.getByRole('button',{name:'Use an API key'}).click();
    await apiPage.getByLabel('API key',{exact:true}).fill('sk-ant-fake.kevin.check');await apiPage.getByRole('button',{name:'Save key',exact:true}).click();
    await apiPage.getByRole('button',{name:'Test key',exact:true}).click();await apiPage.getByText(/The key works/).waitFor();
    await apiPage.getByLabel('Model',{exact:true}).fill('claude-fake-kevin');await apiPage.getByLabel('Daily cap (USD, optional)',{exact:true}).fill('2');
    entering=true;await apiPage.getByRole('button',{name:'Continue',exact:true}).click();await apiPage.getByRole('button',{name:'Checking brains…',exact:true}).waitFor();
    releaseEntry();await apiPage.getByRole('button',{name:'Check again',exact:true}).waitFor();
    assert.equal(await apiPage.getByRole('combobox').inputValue(),'anthropic-api');
    await apiPage.getByLabel('Name',{exact:true}).fill('Stuart');await apiPage.getByRole('button',{name:'Create',exact:true}).click();await apiPage.getByRole('heading',{name:'Fresh out of the fryer',exact:true}).waitFor();
    const made=(await apiServer.call('GET','/api/bots')).data[0];assert.equal(made.provider,'anthropic-api');assert.equal(made.model,'claude-fake-kevin');
    assert.equal((await apiServer.call('GET',`/api/bots/${made.id}/spending`)).data.dailyCapUsd,2);
    console.log('PASS: immediately continuing after Test key preserves the chosen API provider, model and daily cap through a delayed entry refresh');
  }finally{await apiServer.stop();await new Promise<void>(r=>models.close(()=>r()));}
  console.log('PASS: stale incompatible CLI → managed update → guided sign-in → ready default → first Boton created; empty-brain recovery works');
}finally{await browser.close();await s.stop();rmSync(home,{recursive:true,force:true});}
