'use strict';
const crypto=require('node:crypto');
const release=require('../desktop/update-release.cjs');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function fixture(){
 const commit='a'.repeat(40),tree='b'.repeat(40),version='0.14.99',archive=Buffer.from('synthetic archive bytes only');
 const bytes=new Map(release.ASSETS.map(name=>[name,Buffer.from(archive)]));
 const sums=Buffer.from(release.ASSETS.map(name=>hash(bytes.get(name))+'  '+name).join('\n')+'\n');bytes.set('SHA256SUMS.txt',sums);
 const metadata={id:901,tag_name:'v'+version,target_commitish:commit,html_url:release.WEB+'/releases/tag/v'+version,draft:false,prerelease:false,published_at:'2026-10-24T00:00:00Z',body:'Fixture release\n<img src=x onerror=unsafe()>',assets:[...bytes].map(([name,body],i)=>({id:100+i,name,state:'uploaded',size:body.length,digest:'sha256:'+hash(body),browser_download_url:release.WEB+'/releases/download/v'+version+'/'+name}))};
 const run={id:501,path:'.github/workflows/release.yml',event:'push',head_branch:'main',head_sha:commit,status:'completed',conclusion:'success',repository:{id:release.REPOSITORY_ID},head_repository:{id:release.REPOSITORY_ID},head_commit:{tree_id:tree}};
 const jobs={total_count:5,jobs:['Build darwin-arm64','Build win32-x64','Build linux-x64','Build darwin-x64','release'].map((name,index)=>({id:601+index,name,head_sha:commit,run_id:501,status:'completed',conclusion:'success',steps:[{name:name==='release'?'Publish tested release':'Compile TypeScript and run tests',status:'completed',conclusion:'success'}]}))};
 const responses=new Map([
  [release.API+'/releases/latest',metadata],
  [release.API+'/releases/tags/v'+version,metadata],
  [release.API+'/git/ref/tags/v'+version,{ref:'refs/tags/v'+version,object:{type:'commit',sha:commit}}],
  [release.API+'/git/commits/'+commit,{sha:commit,tree:{sha:tree}}],
  [release.API+'/contents/package.json?ref='+commit,{type:'file',path:'package.json',encoding:'base64',content:Buffer.from(JSON.stringify({name:'chartshub-desktop',version})).toString('base64')}],
  [release.API+'/actions/runs?head_sha='+commit+'&event=push&status=success&per_page=30',{workflow_runs:[run]}],
  [release.API+'/actions/runs/501/jobs?per_page=100',jobs]
 ]);
 const requests=[];
 const fetcher=async(url,options)=>{requests.push({url,options});if(options?.signal?.aborted)throw options.signal.reason;if(responses.has(url))return new Response(JSON.stringify(responses.get(url)),{headers:{'Content-Type':'application/json'}});const name=metadata.assets.find(x=>x.browser_download_url===url)?.name;if(name)return new Response(bytes.get(name));throw Error('Unexpected fixture URL');};
 return {metadata,bytes,responses,fetcher,requests,commit,tree,version,jobs,run};
}
module.exports={fixture,hash};
