// Real UI on a throwaway server; only the provider preflight result is injected.
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { startServer } from '../server/test/helpers.ts';
const browser = await chromium.launch({executablePath: process.env.CHROME_BIN || ['/opt/google/chrome/chrome','/usr/bin/google-chrome','/usr/bin/chromium'].find(existsSync), args:['--no-sandbox']});
const out = process.env.BOTONS_PROOF_DIR || '/tmp/botons-workspace-proof'; mkdirSync(out,{recursive:true});
try {
 for (const failing of [true, false]) {
  const s = await startServer({configure: c => { c.webDist = resolve('web/dist'); c.hostname = 'myhost'; }});
  s.app.store.updateSettings({ownerName:'Sam'});
  const page = await browser.newPage({viewport:{width:1280,height:900}});
  await page.addInitScript(token=>localStorage.setItem('botons.deviceToken',token),s.token);
  await page.route('**/api/brain-homes', route=>route.fulfill({json:{codex:true,claude:false}}));
  await page.route('**/api/providers*',async route=>{
   const response=await route.fetch(); const data=await response.json();
   const mock=data.find((p: any)=>p.id==='mock');
   for(const p of data) if(p.id==='mock' || p.id==='codex-cli') {
    if(p.id==='codex-cli') Object.assign(p,{...mock,id:'codex-cli',label:'Codex',kind:'cli',installed:true,loggedIn:true,version:'0.167.0'});
    p.workspaceProblem=failing?'Not available on this server: it hides part of /proc, which the sandbox needs.':null;
   }
   await route.fulfill({response,json:data});
  });
  {
   await page.goto(s.base);
   await page.getByRole('button',{name:'Continue',exact:true}).click();
   await page.getByRole('button',{name:'Continue',exact:true}).click();
   await page.getByRole('button',{name:/Use my Claude or ChatGPT subscription/}).click();
   await page.getByText('Ready ✓',{exact:true}).waitFor();
   await page.getByText('✓ Signed in',{exact:true}).waitFor();
   assert.equal(await page.getByText(/Not available on this server/).count(),0);
   await page.getByText('Awake: a brain is ready, so your Botons can think.',{exact:true}).waitFor();
   await page.getByText('Botons can use your existing Codex sign-in, or you can sign in just for Botons.',{exact:true}).waitFor();
   const migration=page.getByRole('region',{name:'Botons sign-in'});
   assert.equal(await migration.getByText(/This choice is recorded in the audit log/).isVisible(),false);
   await migration.getByText('Details',{exact:true}).click();
   assert.equal(await migration.getByText(/This choice is recorded in the audit log/).isVisible(),true);
   await migration.getByText('Details',{exact:true}).click();
   await page.screenshot({path:join(out,`brains-${failing?'unavailable':'available'}-desktop.png`),fullPage:true});
   await page.setViewportSize({width:390,height:844});
   await page.screenshot({path:join(out,`brains-${failing?'unavailable':'available'}-phone.png`),fullPage:true});
   await page.setViewportSize({width:1280,height:900});
   await page.getByRole('button',{name:'Continue',exact:true}).click();
   await page.getByRole('heading',{name:'Your first Boton',exact:true}).waitFor();
   await page.getByRole('radio',{name:/Full computer/}).waitFor();
   assert.equal(await page.getByRole('radio',{name:/Workspace/}).isDisabled(),failing);
   assert.equal(await page.getByRole('radio',{name:/Full computer/}).getAttribute('aria-checked'),String(failing));
   await page.getByLabel('Name',{exact:true}).fill('Kevin');
   await page.screenshot({path:join(out,`setup-${failing?'unavailable':'available'}-desktop.png`),fullPage:true});
   await page.setViewportSize({width:390,height:844}); await page.screenshot({path:join(out,`setup-${failing?'unavailable':'available'}-phone.png`),fullPage:true});
   await page.getByRole('button',{name:'Create',exact:true}).click();
   await page.getByRole('heading',{name:'Fresh out of the fryer',exact:true}).waitFor();
   await page.getByRole('button',{name:/Open.*Kevin|Meet.*Kevin|Start chatting|Let.s go/}).click();
  }
  await page.setViewportSize({width:1280,height:900});
  await page.getByRole('button',{name:'Boton settings',exact:true}).click();
  assert.equal(await page.getByRole('radio',{name:/Workspace/}).isDisabled(),failing);
  await page.screenshot({path:join(out,`settings-${failing?'unavailable':'available'}.png`),fullPage:true});
  await page.getByRole('button',{name:'Close panel',exact:true}).click();
  await page.getByRole('button',{name:'New Boton',exact:true}).click();
  const workspace=page.getByRole('radio',{name:/Workspace/}); await workspace.waitFor();
  assert.equal(await workspace.isDisabled(),failing);
  assert.equal(await page.getByText(/Full computer is selected because/).count(),0);
  if(failing) assert.equal(await page.getByRole('radio',{name:/Full computer/}).getAttribute('aria-checked'),'true');
  await page.getByRole('button',{name:'Blank',exact:true}).click();
  await page.getByRole('button',{name:'Blank',exact:true}).click();
  assert.equal(await workspace.isDisabled(),failing);
  assert.equal(await page.getByRole('radio',{name:/Full computer/}).getAttribute('aria-checked'),String(failing));
  await page.screenshot({path:join(out,`new-boton-${failing?'unavailable':'available'}.png`),fullPage:true});
  await page.keyboard.press('Escape');
  await page.close();
  if (failing) {
   const bot=(await s.call('GET','/api/bots')).data[0];
   await s.call('PATCH',`/api/bots/${bot.id}`,{access:'workspace'});
   const chat=await browser.newPage();
   await chat.addInitScript(token=>localStorage.setItem('botons.deviceToken',token),s.token);
   await chat.route('**/api/providers*',async route=>{const response=await route.fetch();const data=await response.json();for(const p of data)if(p.id==='mock'||p.id==='codex-cli')p.workspaceProblem='Not available on this server: the sandbox could not start.';await route.fulfill({response,json:data});});
   await chat.goto(s.base);await chat.getByText("Can't run sandboxed on this server",{exact:true}).waitFor();
   await chat.getByRole('button',{name:'Switch to Full computer',exact:true}).click();
   await chat.getByText("Can't run sandboxed on this server",{exact:true}).waitFor({state:'detached'});
   assert.equal((await s.call('GET','/api/bots')).data[0].access,'host');
   const audit=(await s.call('GET','/api/audit')).data;
   assert.ok(audit.some((e: any)=>e.action==='boton.access_changed' && e.details?.from==='workspace' && e.details?.to==='host'));
   await chat.close();
  }
  await s.stop();
 }
 console.log('Workspace access browser checks passed');
} finally { await browser.close(); }
