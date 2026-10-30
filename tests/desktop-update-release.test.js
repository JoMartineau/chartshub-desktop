'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const api=require('../desktop/update-release.cjs');
const {assetResponse}=require('../desktop/update-service.cjs');
const {fixture}=require('./update-fixture.cjs');
test('release requires published immutable source, five exact assets and their digests',()=>{
 const f=fixture(),release=api.validateRelease(f.metadata);assert.equal(release.version,f.version);assert.equal(release.assets.length,5);
 for(const change of [m=>m.draft=true,m=>m.prerelease=true,m=>m.target_commitish='main',m=>m.assets.pop(),m=>m.assets.push({...m.assets[0]}),m=>m.assets[0].digest=null,m=>m.assets[0].browser_download_url='https://invalid.example/archive.zip',m=>m.assets[0].state='new',m=>m.assets[0].size=0,m=>m.tag_name='v00.14.99']){const bad=structuredClone(f.metadata);change(bad);assert.throws(()=>api.validateRelease(bad));}
});
test('version comparison is numeric, rejects ambiguous prerelease and never calls equal/older newer',()=>{
 assert.equal(api.compareVersions('0.14.27','0.14.26'),1);assert.equal(api.compareVersions('0.14.9','0.14.26'),-1);assert.equal(api.compareVersions('1.0.0','1.0.0'),0);
 for(const value of ['1.0','v1.2.3','01.2.3','1.2.3-beta',1,null,'1.2.3\n'])assert.throws(()=>api.version(value));
});
test('checksum manifest binds all four platforms, rejects duplicate/missing/changed/extra lines',()=>{
 const f=fixture(),release=api.validateRelease(f.metadata),sums=f.bytes.get('SHA256SUMS.txt');assert.equal(Object.keys(api.parseChecksums(sums,release)).length,4);
 for(const bytes of [Buffer.from(sums.toString().replace(/^./,'0')),Buffer.from(sums.toString().split('\n').slice(1).join('\n')),Buffer.concat([sums,Buffer.from('extra')]),Buffer.from(sums.toString().replace('ChartsHub-linux-x64.tar.gz','ChartsHub-win32-x64.zip'))])assert.throws(()=>api.parseChecksums(bytes,release));
});
test('real discovery verifies tag, Git source package, tree and all native release jobs without credentials',async()=>{
 const f=fixture(),r=await api.discoverRelease(f.fetcher);assert.equal(r.commit,f.commit);assert.equal(r.tree,f.tree);assert.equal(r.runId,501);assert.equal(f.requests.length,6);
 for(const {url,options} of f.requests){assert(url.startsWith(api.API+'/'));assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');assert(!Object.keys(options.headers).some(x=>/authorization|cookie/i.test(x)));}
});
test('source verification refuses a moved tag, other package version, other repository or unsuccessful build',async()=>{
 const mutators=[f=>f.responses.get(api.API+'/git/ref/tags/v'+f.version).object.sha='c'.repeat(40),f=>f.responses.get(api.API+'/contents/package.json?ref='+f.commit).content=Buffer.from('{"name":"other","version":"0.14.99"}').toString('base64'),f=>f.run.repository.id=1,f=>f.jobs.jobs[1].conclusion='failure',f=>f.jobs.jobs.pop(),f=>f.jobs.jobs.find(j=>j.name==='release').steps=[{name:'Publish tested release',status:'completed',conclusion:'failure'}]];
 for(const mutate of mutators){const f=fixture();mutate(f);await assert.rejects(()=>api.discoverRelease(f.fetcher),e=>/^UPDATE_(SOURCE_MISMATCH|BUILD_UNVERIFIED)$/.test(e.code));}
});
test('published metadata cannot silently change between check and download/install',async()=>{
 const f=fixture(),initial=await api.discoverRelease(f.fetcher);f.metadata.assets[0].digest='sha256:'+'e'.repeat(64);await assert.rejects(()=>api.revalidateRelease(f.fetcher,initial),{code:'UPDATE_RELEASE_CHANGED'});
});
test('bounded API parser refuses oversized data and rate limits',async()=>{
 await assert.rejects(()=>api.requestJSON(async()=>new Response(' ',{status:429}),api.API+'/releases/latest'),{code:'UPDATE_RATE_LIMITED'});
 await assert.rejects(()=>api.requestJSON(async()=>new Response('x',{headers:{'Content-Length':'2000000'}}),api.API+'/releases/latest'),{code:'UPDATE_RESPONSE_TOO_LARGE'});
});
test('archive redirect follows only official HTTPS asset hosts and never forwards credentials',async()=>{
 const calls=[];const final=new Response('fixture');const fetcher=async(url,options)=>{calls.push({url,options});return calls.length===1?new Response(null,{status:302,headers:{Location:'https://release-assets.githubusercontent.com/fixture'}}):final;};
 assert.equal(await assetResponse(fetcher,{url:'https://github.com/JoMartineau/chartshub-desktop/releases/download/v1.0.0/file.zip'}),final);assert(calls.every(c=>c.options.credentials==='omit'));
 for(const location of ['http://release-assets.githubusercontent.com/file','https://invalid.example/file','https://user:pass@github.com/file'])await assert.rejects(()=>assetResponse(async()=>new Response(null,{status:302,headers:{Location:location}}),{url:'https://github.com/file'}),{code:'UPDATE_DOWNLOAD_ORIGIN'});
});
