import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
const dll=fs.readFileSync(path.join(process.env.SystemRoot ?? 'C:/Windows','System32','dxgi.dll'));
const pe=dll.readUInt32LE(0x3c), sections=dll.readUInt16LE(pe+6), opt=pe+24, optSize=dll.readUInt16LE(pe+20);
if(dll.readUInt16LE(opt)!==0x20b)throw new Error('Expected x64 DXGI');
const table=opt+optSize;
function offset(rva){for(let i=0;i<sections;i++){const s=table+i*40,v=dll.readUInt32LE(s+12),size=Math.max(dll.readUInt32LE(s+8),dll.readUInt32LE(s+16));if(rva>=v&&rva<v+size)return dll.readUInt32LE(s+20)+rva-v;}throw new Error('Bad RVA');}
const exp=offset(dll.readUInt32LE(opt+112)),base=dll.readUInt32LE(exp+16),count=dll.readUInt32LE(exp+24),names=offset(dll.readUInt32LE(exp+32)),ordinals=offset(dll.readUInt32LE(exp+36));
const entries=[];
for(let i=0;i<count;i++){const n=offset(dll.readUInt32LE(names+4*i));const name=dll.toString('ascii',n,dll.indexOf(0,n));if(!/^[A-Za-z0-9_]+$/.test(name))throw new Error('Unexpected export');entries.push({name,ordinal:base+dll.readUInt16LE(ordinals+2*i)});}
fs.writeFileSync(path.join(root,'src/forward_names.h'),`// Generated from Windows System32 DXGI export names; no executable code copied.\n#define FORWARD_COUNT ${entries.length}\nstatic const char* forwardNames[FORWARD_COUNT]={${entries.map(e=>JSON.stringify(e.name)).join(',')}};\n`);
fs.writeFileSync(path.join(root,'src/dxgi.def'),'LIBRARY dxgi\nEXPORTS\n'+entries.map(e=>` ${e.name}=Proxy_${e.name} @${e.ordinal}`).join('\n')+'\n');
let asm='.text\n.extern ResolveForward\n';
entries.forEach((e,i)=>{asm+=`
.globl Proxy_${e.name}
.seh_proc Proxy_${e.name}
Proxy_${e.name}:
  subq $168, %rsp
  .seh_stackalloc 168
  .seh_endprologue
  movq %rcx, 32(%rsp)
  movq %rdx, 40(%rsp)
  movq %r8, 48(%rsp)
  movq %r9, 56(%rsp)
  movaps %xmm0, 64(%rsp)
  movaps %xmm1, 80(%rsp)
  movaps %xmm2, 96(%rsp)
  movaps %xmm3, 112(%rsp)
  movl $${i}, %ecx
  call ResolveForward
  movq 32(%rsp), %rcx
  movq 40(%rsp), %rdx
  movq 48(%rsp), %r8
  movq 56(%rsp), %r9
  movaps 64(%rsp), %xmm0
  movaps 80(%rsp), %xmm1
  movaps 96(%rsp), %xmm2
  movaps 112(%rsp), %xmm3
  addq $168, %rsp
  jmp *%rax
.seh_endproc
`;});
fs.writeFileSync(path.join(root,'src/forwarders.S'),asm);
console.log(`Generated ${entries.length} ABI-preserving DXGI exports.`);
