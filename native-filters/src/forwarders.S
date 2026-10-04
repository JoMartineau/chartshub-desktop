.text
.extern ResolveForward

.globl Proxy_ApplyCompatResolutionQuirking
.seh_proc Proxy_ApplyCompatResolutionQuirking
Proxy_ApplyCompatResolutionQuirking:
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
  movl $0, %ecx
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

.globl Proxy_CompatString
.seh_proc Proxy_CompatString
Proxy_CompatString:
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
  movl $1, %ecx
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

.globl Proxy_CompatValue
.seh_proc Proxy_CompatValue
Proxy_CompatValue:
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
  movl $2, %ecx
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

.globl Proxy_CreateDXGIFactory
.seh_proc Proxy_CreateDXGIFactory
Proxy_CreateDXGIFactory:
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
  movl $3, %ecx
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

.globl Proxy_CreateDXGIFactory1
.seh_proc Proxy_CreateDXGIFactory1
Proxy_CreateDXGIFactory1:
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
  movl $4, %ecx
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

.globl Proxy_CreateDXGIFactory2
.seh_proc Proxy_CreateDXGIFactory2
Proxy_CreateDXGIFactory2:
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
  movl $5, %ecx
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

.globl Proxy_DXGID3D10CreateDevice
.seh_proc Proxy_DXGID3D10CreateDevice
Proxy_DXGID3D10CreateDevice:
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
  movl $6, %ecx
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

.globl Proxy_DXGID3D10CreateLayeredDevice
.seh_proc Proxy_DXGID3D10CreateLayeredDevice
Proxy_DXGID3D10CreateLayeredDevice:
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
  movl $7, %ecx
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

.globl Proxy_DXGID3D10GetLayeredDeviceSize
.seh_proc Proxy_DXGID3D10GetLayeredDeviceSize
Proxy_DXGID3D10GetLayeredDeviceSize:
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
  movl $8, %ecx
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

.globl Proxy_DXGID3D10RegisterLayers
.seh_proc Proxy_DXGID3D10RegisterLayers
Proxy_DXGID3D10RegisterLayers:
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
  movl $9, %ecx
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

.globl Proxy_DXGIDeclareAdapterRemovalSupport
.seh_proc Proxy_DXGIDeclareAdapterRemovalSupport
Proxy_DXGIDeclareAdapterRemovalSupport:
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
  movl $10, %ecx
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

.globl Proxy_DXGIDisableVBlankVirtualization
.seh_proc Proxy_DXGIDisableVBlankVirtualization
Proxy_DXGIDisableVBlankVirtualization:
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
  movl $11, %ecx
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

.globl Proxy_DXGIDumpJournal
.seh_proc Proxy_DXGIDumpJournal
Proxy_DXGIDumpJournal:
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
  movl $12, %ecx
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

.globl Proxy_DXGIGetDebugInterface1
.seh_proc Proxy_DXGIGetDebugInterface1
Proxy_DXGIGetDebugInterface1:
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
  movl $13, %ecx
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

.globl Proxy_DXGIReportAdapterConfiguration
.seh_proc Proxy_DXGIReportAdapterConfiguration
Proxy_DXGIReportAdapterConfiguration:
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
  movl $14, %ecx
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

.globl Proxy_PIXBeginCapture
.seh_proc Proxy_PIXBeginCapture
Proxy_PIXBeginCapture:
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
  movl $15, %ecx
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

.globl Proxy_PIXEndCapture
.seh_proc Proxy_PIXEndCapture
Proxy_PIXEndCapture:
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
  movl $16, %ecx
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

.globl Proxy_PIXGetCaptureState
.seh_proc Proxy_PIXGetCaptureState
Proxy_PIXGetCaptureState:
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
  movl $17, %ecx
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

.globl Proxy_SetAppCompatStringPointer
.seh_proc Proxy_SetAppCompatStringPointer
Proxy_SetAppCompatStringPointer:
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
  movl $18, %ecx
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

.globl Proxy_UpdateHMDEmulationStatus
.seh_proc Proxy_UpdateHMDEmulationStatus
Proxy_UpdateHMDEmulationStatus:
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
  movl $19, %ecx
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
