'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const api=require('../desktop/update-release.cjs');
const {fixture}=require('./update-fixture.cjs');
function omitted(){
 const f=fixture(),publication=f.jobs.jobs.find(j=>j.name==='release');publication.steps=[];f.run.check_suite_id=701;
 const jobURL=api.API+'/actions/jobs/'+publication.id,checkURL=api.API+'/check-runs/801';
 const detailsURL=api.WEB+'/actions/runs/'+f.run.id+'/job/'+publication.id;
 const job={...publication,steps:[],url:jobURL,run_url:api.API+'/actions/runs/'+f.run.id,html_url:detailsURL,check_run_url:checkURL};
 const check={id:801,url:checkURL,name:'release',head_sha:f.commit,status:'completed',conclusion:'success',details_url:detailsURL,html_url:detailsURL,check_suite:{id:701},app:{id:15368,slug:'github-actions',html_url:'https://github.com/apps/github-actions',owner:{id:9919,login:'github',type:'Organization'}}};
 f.responses.set(jobURL,job);f.responses.set(checkURL,check);return {...f,publication,job,check,jobURL,checkURL};
}
test('omitted publication steps require both the canonical job and its official Actions check',async()=>{
 for(const missing of [false,true]){const f=omitted();if(missing){delete f.publication.steps;delete f.job.steps;}const release=await api.discoverRelease(f.fetcher);assert.equal(release.runId,501);assert.deepEqual(f.requests.slice(-2).map(r=>r.url),[f.jobURL,f.checkURL]);assert.equal(f.requests.length,8);for(const r of f.requests){assert.equal(r.options.credentials,'omit');assert.equal(r.options.redirect,'error');assert.equal(r.options.cache,'no-store');}}
});
test('a populated successful Publish step keeps the ordinary request path',async()=>{
 const f=fixture();await api.discoverRelease(f.fetcher);assert.equal(f.requests.length,6);
});
const rejected=[
 ['job belongs to another run',f=>f.job.run_id++],
 ['job has another ID',f=>f.job.id++],
 ['job has another source',f=>f.job.head_sha='c'.repeat(40)],
 ['job has another name',f=>f.job.name='build'],
 ['job did not succeed',f=>f.job.conclusion='failure'],
 ['job is still running',f=>f.job.status='in_progress'],
 ['job URL belongs to another repository',f=>f.job.url=f.job.url.replace('chartshub-desktop','other')],
 ['job run URL does not bind this run',f=>f.job.run_url+='/other'],
 ['job display URL does not bind this run',f=>f.job.html_url+='/other'],
 ['missing associated check',f=>delete f.job.check_run_url],
 ['check URL belongs to another repository',f=>f.job.check_run_url=f.checkURL.replace('chartshub-desktop','other')],
 ['check URL contains credentials',f=>f.job.check_run_url=f.checkURL.replace('https://','https://user:secret@')],
 ['check URL has an alternate host',f=>f.job.check_run_url=f.checkURL.replace('api.github.com','example.invalid')],
 ['check URL has a query',f=>f.job.check_run_url+='?other=1'],
 ['check URL has a noncanonical numeric ID',f=>f.job.check_run_url=api.API+'/check-runs/0801'],
 ['check URL has an unsafe numeric ID',f=>f.job.check_run_url=api.API+'/check-runs/9007199254740992'],
 ['check has another ID',f=>f.check.id++],
 ['check URL does not match its response',f=>f.check.url+='/other'],
 ['check source is different',f=>f.check.head_sha='c'.repeat(40)],
 ['check did not succeed',f=>f.check.conclusion='failure'],
 ['check is stale',f=>f.check.conclusion='stale'],
 ['check is still running',f=>f.check.status='in_progress'],
 ['check belongs to another run',f=>f.check.details_url=f.check.details_url.replace('/501/','/502/')],
 ['check display URL belongs to another job',f=>f.check.html_url+='/other'],
 ['check suite does not bind the run',f=>f.check.check_suite.id++],
 ['run has no bound check suite',f=>delete f.run.check_suite_id],
 ['check has another name',f=>f.check.name='build'],
 ['check app is not GitHub Actions',f=>f.check.app.id++],
 ['check app slug is not GitHub Actions',f=>f.check.app.slug='other'],
 ['check app origin differs',f=>f.check.app.html_url='https://example.invalid'],
 ['check app owner differs',f=>f.check.app.owner.id++],
 ['check app owner login differs',f=>f.check.app.owner.login='other'],
 ['another native job source differs',f=>f.jobs.jobs[0].head_sha='c'.repeat(40)],
 ['native jobs have duplicate IDs',f=>f.jobs.jobs[0].id=f.jobs.jobs[1].id]
];
for(const [name,mutate]of rejected)test('projection refuses '+name,async()=>{const f=omitted();mutate(f);await assert.rejects(()=>api.discoverRelease(f.fetcher),{code:'UPDATE_BUILD_UNVERIFIED'});assert(f.requests.length<=8);assert(f.requests.every(r=>r.url.startsWith(api.API+'/')));});
test('populated step lists never fall back around missing, failed, pending or duplicated Publish',async()=>{
 const bad=[null,[{name:'Other',status:'completed',conclusion:'success'}],[{name:'Publish tested release',status:'completed',conclusion:'failure'}],[{name:'Publish tested release',status:'in_progress',conclusion:'success'}],[{name:'Publish tested release',status:'completed',conclusion:'success'},{name:'Publish tested release',status:'completed',conclusion:'failure'}]];
 for(const target of ['publication','job'])for(const steps of bad){const f=omitted();f[target].steps=steps;await assert.rejects(()=>api.discoverRelease(f.fetcher),{code:'UPDATE_BUILD_UNVERIFIED'});assert(!f.requests.some(r=>r.url===f.checkURL));if(target==='publication')assert(!f.requests.some(r=>r.url===f.jobURL));}
});
test('fallback retains cancellation, rate limiting and bounded response guards',async()=>{
 const f=omitted(),controller=new AbortController();
 await assert.rejects(()=>api.discoverRelease(async(url,options)=>{if(url===f.jobURL)controller.abort(Error('cancelled by caller'));return f.fetcher(url,options);},controller.signal),/cancelled by caller/);
 for(const response of [new Response('limited',{status:429}),new Response('x',{headers:{'Content-Length':'2000000'}})]){const f=omitted();await assert.rejects(()=>api.discoverRelease((url,options)=>url===f.checkURL?response:f.fetcher(url,options)),e=>['UPDATE_RATE_LIMITED','UPDATE_RESPONSE_TOO_LARGE'].includes(e.code));}
});
