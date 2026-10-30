'use strict';
// Public GitHub release metadata only. Never uses ChartsHub cookies or credentials.
const REPOSITORY='JoMartineau/chartshub-desktop',REPOSITORY_ID=1389298876;
const API='https://api.github.com/repos/'+REPOSITORY,WEB='https://github.com/'+REPOSITORY;
const ASSETS=['ChartsHub-win32-x64.zip','ChartsHub-linux-x64.tar.gz','ChartsHub-darwin-arm64.zip','ChartsHub-darwin-x64.zip'];
const MAX_ARCHIVE=512*1024*1024,MAX_SUMS=65536;
const fail=code=>Object.assign(Error(code),{code:'UPDATE_'+code});
const record=x=>!!x&&typeof x==='object'&&!Array.isArray(x);
const SHA=/^[a-f0-9]{40}$/,DIGEST=/^sha256:([a-f0-9]{64})$/;
function version(input){if(typeof input!=='string'||! /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.test(input))throw fail('VERSION_INVALID');return input.split('.').map(Number);}
function compareVersions(a,b){const x=version(a),y=version(b);for(let n=0;n<3;n++)if(x[n]!==y[n])return x[n]>y[n]?1:-1;return 0;}
function validateRelease(value){
 if(!record(value)||typeof value.tag_name!=='string'||!value.tag_name.startsWith('v'))throw fail('RELEASE_INVALID');
 const releaseVersion=value.tag_name.slice(1);version(releaseVersion);
 if(value.draft!==false||value.prerelease!==false||typeof value.target_commitish!=='string'||!SHA.test(value.target_commitish)||!Number.isSafeInteger(value.id)||value.id<1||value.html_url!==WEB+'/releases/tag/'+value.tag_name||typeof value.published_at!=='string'||!Number.isFinite(Date.parse(value.published_at)))throw fail('RELEASE_INVALID');
 if(value.body!==null&&value.body!==undefined&&(typeof value.body!=='string'||value.body.length>40000||/[\u0000\u202a-\u202e\u2066-\u2069]/.test(value.body)))throw fail('RELEASE_NOTES_INVALID');
 const names=[...ASSETS,'SHA256SUMS.txt'];
 if(!Array.isArray(value.assets)||value.assets.length!==5||new Set(value.assets.map(x=>x?.name)).size!==5)throw fail('ASSETS_INVALID');
 const assets=names.map(name=>{
  const asset=value.assets.find(x=>x?.name===name);
  if(!record(asset)||!Number.isSafeInteger(asset.id)||asset.id<1||asset.state!=='uploaded'||!Number.isSafeInteger(asset.size)||asset.size<1||asset.size>(name==='SHA256SUMS.txt'?MAX_SUMS:MAX_ARCHIVE)||typeof asset.digest!=='string'||!DIGEST.test(asset.digest)||asset.browser_download_url!==WEB+'/releases/download/'+value.tag_name+'/'+name)throw fail('ASSETS_INVALID');
  return {name,id:asset.id,size:asset.size,sha256:asset.digest.slice(7),url:asset.browser_download_url};
 });
 return {id:value.id,version:releaseVersion,tag:value.tag_name,commit:value.target_commitish,url:value.html_url,notes:value.body||'',publishedAt:value.published_at,assets};
}
function parseChecksums(bytes,release){
 if(!Buffer.isBuffer(bytes)||bytes.length>MAX_SUMS)throw fail('CHECKSUMS_INVALID');
 const lines=bytes.toString('utf8').trim().split(/\r?\n/),map=new Map();
 if(lines.length!==4)throw fail('CHECKSUMS_INVALID');
 for(const line of lines){const match=/^([a-f0-9]{64})  (ChartsHub-[A-Za-z0-9.-]+)$/.exec(line);if(!match||!ASSETS.includes(match[2])||map.has(match[2]))throw fail('CHECKSUMS_INVALID');map.set(match[2],match[1]);}
 if(ASSETS.some(name=>map.get(name)!==release.assets.find(a=>a.name===name)?.sha256))throw fail('CHECKSUMS_MISMATCH');
 return Object.fromEntries(map);
}
async function boundedBytes(response,limit,signal){
 if(!response?.ok||!response.body)throw fail(response?.status===403||response?.status===429?'RATE_LIMITED':'NETWORK');
 const declared=response.headers?.get('content-length');if(declared&&(!/^\d+$/.test(declared)||Number(declared)>limit))throw fail('RESPONSE_TOO_LARGE');
 const chunks=[];let count=0;
 for await(const part of response.body){signal?.throwIfAborted();const b=Buffer.from(part);count+=b.length;if(count>limit)throw fail('RESPONSE_TOO_LARGE');chunks.push(b);}
 return Buffer.concat(chunks);
}
async function requestJSON(fetcher,url,signal){
 const response=await fetcher(url,{headers:{Accept:'application/vnd.github+json','User-Agent':'ChartsHub-Desktop-Updater','X-GitHub-Api-Version':'2022-11-28'},credentials:'omit',redirect:'error',cache:'no-store',signal});
 const bytes=await boundedBytes(response,1024*1024,signal);try{return JSON.parse(bytes.toString('utf8'));}catch{throw fail('RESPONSE_INVALID');}
}
const positiveId=value=>Number.isSafeInteger(value)&&value>0;
function hasPublishedStep(steps){
 if(!Array.isArray(steps)||!steps.length)return false;
 const publication=steps.filter(step=>step?.name==='Publish tested release');
 return publication.length===1&&publication[0].status==='completed'&&publication[0].conclusion==='success';
}
async function verifyPublication(fetcher,publication,run,release,signal){
 // A populated step list is authoritative. Never replace a failed, pending or
 // missing Publish step with a successful job/check projection.
 if(Array.isArray(publication.steps)&&publication.steps.length){if(!hasPublishedStep(publication.steps))throw fail('BUILD_UNVERIFIED');return;}
 if(publication.steps!==undefined&&!Array.isArray(publication.steps))throw fail('BUILD_UNVERIFIED');
 const jobURL=API+'/actions/jobs/'+publication.id,runURL=API+'/actions/runs/'+run.id;
 const detailsURL=WEB+'/actions/runs/'+run.id+'/job/'+publication.id;
 const job=await requestJSON(fetcher,jobURL,signal);
 if(job?.id!==publication.id||job.run_id!==run.id||job.head_sha!==release.commit||job.name!=='release'||job.status!=='completed'||job.conclusion!=='success'||job.url!==jobURL||job.run_url!==runURL||job.html_url!==detailsURL)throw fail('BUILD_UNVERIFIED');
 if(job.steps!==undefined&&(!Array.isArray(job.steps)||(job.steps.length&&!hasPublishedStep(job.steps))))throw fail('BUILD_UNVERIFIED');
 const checkPrefix=API+'/check-runs/',checkIdText=typeof job.check_run_url==='string'&&job.check_run_url.startsWith(checkPrefix)?job.check_run_url.slice(checkPrefix.length):'';
 const checkId=Number(checkIdText);
 if(!/^[1-9]\d*$/.test(checkIdText)||!positiveId(checkId)||String(checkId)!==checkIdText||!positiveId(run.check_suite_id))throw fail('BUILD_UNVERIFIED');
 // Reconstruct the allowlisted URL; never fetch a URL supplied by a response.
 const checkURL=checkPrefix+checkId,check=await requestJSON(fetcher,checkURL,signal);
 if(check?.id!==checkId||check.url!==checkURL||check.name!=='release'||check.head_sha!==release.commit||check.status!=='completed'||check.conclusion!=='success'||check.details_url!==detailsURL||check.html_url!==detailsURL||check.check_suite?.id!==run.check_suite_id||check.app?.id!==15368||check.app.slug!=='github-actions'||check.app.html_url!=='https://github.com/apps/github-actions'||check.app.owner?.id!==9919||check.app.owner.login!=='github'||check.app.owner.type!=='Organization')throw fail('BUILD_UNVERIFIED');
}
async function verifySource(fetcher,release,signal){
 const [ref,commit,pkg,runs]=await Promise.all([
  requestJSON(fetcher,API+'/git/ref/tags/'+release.tag,signal),
  requestJSON(fetcher,API+'/git/commits/'+release.commit,signal),
  requestJSON(fetcher,API+'/contents/package.json?ref='+release.commit,signal),
  requestJSON(fetcher,API+'/actions/runs?head_sha='+release.commit+'&event=push&status=success&per_page=30',signal)
 ]);
 if(ref?.ref!=='refs/tags/'+release.tag||ref.object?.type!=='commit'||ref.object.sha!==release.commit||commit?.sha!==release.commit||!SHA.test(commit.tree?.sha))throw fail('SOURCE_MISMATCH');
 if(pkg?.type!=='file'||pkg.path!=='package.json'||pkg.encoding!=='base64'||typeof pkg.content!=='string'||pkg.content.length>100000)throw fail('SOURCE_MISMATCH');
 let sourcePackage;try{sourcePackage=JSON.parse(Buffer.from(pkg.content.replace(/\n/g,''),'base64').toString('utf8'));}catch{throw fail('SOURCE_MISMATCH');}
 if(sourcePackage?.name!=='chartshub-desktop'||sourcePackage.version!==release.version)throw fail('SOURCE_MISMATCH');
 const matching=Array.isArray(runs?.workflow_runs)?runs.workflow_runs.filter(r=>r.path==='.github/workflows/release.yml'&&r.event==='push'&&r.head_branch==='main'&&r.head_sha===release.commit&&r.status==='completed'&&r.conclusion==='success'&&r.repository?.id===REPOSITORY_ID&&r.head_repository?.id===REPOSITORY_ID&&r.head_commit?.tree_id===commit.tree.sha):[];
 if(!matching.length)throw fail('BUILD_UNVERIFIED');
 const run=matching.sort((a,b)=>b.id-a.id)[0];if(!Number.isSafeInteger(run.id)||run.id<1)throw fail('BUILD_UNVERIFIED');
 const result=await requestJSON(fetcher,API+'/actions/runs/'+run.id+'/jobs?per_page=100',signal);
 const names=['Build darwin-arm64','Build win32-x64','Build linux-x64','Build darwin-x64','release'];
 if(result?.total_count!==5||!Array.isArray(result.jobs)||result.jobs.length!==5||new Set(result.jobs.map(j=>j.name)).size!==5||new Set(result.jobs.map(j=>j.id)).size!==5||result.jobs.some(j=>!positiveId(j.id)||j.head_sha!==release.commit)||names.some(name=>!result.jobs.some(j=>j.name===name&&j.run_id===run.id&&j.status==='completed'&&j.conclusion==='success')))throw fail('BUILD_UNVERIFIED');
 await verifyPublication(fetcher,result.jobs.find(j=>j.name==='release'),run,release,signal);
 return {...release,tree:commit.tree.sha,runId:run.id};
}
async function discoverRelease(fetcher,signal){return verifySource(fetcher,validateRelease(await requestJSON(fetcher,API+'/releases/latest',signal)),signal);}
async function revalidateRelease(fetcher,release,signal){
 const current=await verifySource(fetcher,validateRelease(await requestJSON(fetcher,API+'/releases/tags/'+release.tag,signal)),signal);
 if(current.id!==release.id||current.commit!==release.commit||current.tree!==release.tree||JSON.stringify(current.assets)!==JSON.stringify(release.assets))throw fail('RELEASE_CHANGED');return current;
}
module.exports={REPOSITORY,REPOSITORY_ID,API,WEB,ASSETS,MAX_ARCHIVE,MAX_SUMS,fail,version,compareVersions,validateRelease,parseChecksums,boundedBytes,requestJSON,verifySource,discoverRelease,revalidateRelease};
