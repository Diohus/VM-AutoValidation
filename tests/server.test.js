import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

test('server serves modules and does not expose repository files', {timeout:10000}, async () => {
 const child = spawn(process.execPath, ['scripts/serve.mjs'], {cwd: new URL('../',import.meta.url), env:{...process.env, HOST:'127.0.0.1', PORT:'0'}, stdio:['ignore','pipe','pipe']});
 try {
  const url = await new Promise((resolve,reject) => {
   let output='';
   child.stdout.on('data', bytes=>{output+=bytes;const match=output.match(/http:\/\/127\.0\.0\.1:\d+/);if(match)resolve(match[0]);});
   child.once('error',reject);
   child.once('exit',code=>reject(new Error(`server exited: ${code}`)));
  });
  for(const [path,status] of [['/',200],['/src/app.js',200],['/src/rules.js',200],['/.git/config',404],['/package.json',404],['/src/%2e%2e/package.json',404]]) {
   const response=await fetch(url+path);
   assert.equal(response.status,status,path);
   if(path==='/')assert.match(await response.text(),/type="module" src="\.\/src\/app.js"/);
  }
 } finally { child.kill(); }
});
