#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <d3d11.h>
#include <dxgi.h>
#include <stdio.h>
#include <string.h>
template<class T>void drop(T*& p){if(p){p->Release();p=nullptr;}}
static LONG WINAPI crashTrace(EXCEPTION_POINTERS* exception){
  if(exception->ExceptionRecord->ExceptionCode==EXCEPTION_STACK_OVERFLOW||exception->ExceptionRecord->ExceptionCode==EXCEPTION_ACCESS_VIOLATION){
    void* stack[30]={};USHORT n=CaptureStackBackTrace(0,30,stack,nullptr);char line[512];DWORD written;
    for(unsigned i=0;i<n;i++){HMODULE module=nullptr;GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS|GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,(LPCWSTR)stack[i],&module);char name[MAX_PATH]={};GetModuleFileNameA(module,name,MAX_PATH);int bytes=snprintf(line,sizeof(line),"STACK %s + 0x%llx\n",name,(unsigned long long)((char*)stack[i]-(char*)module));WriteFile(GetStdHandle(STD_ERROR_HANDLE),line,bytes,&written,nullptr);}
  }return EXCEPTION_CONTINUE_SEARCH;
}
int main(){
  SetErrorMode(SEM_FAILCRITICALERRORS|SEM_NOGPFAULTERRORBOX);setvbuf(stdout,nullptr,_IONBF,0);
  ULONG guarantee=65536;SetThreadStackGuarantee(&guarantee);AddVectoredExceptionHandler(1,crashTrace);
  IDXGIFactory1* factory=nullptr;if(FAILED(CreateDXGIFactory1(__uuidof(IDXGIFactory1),(void**)&factory)))return 4;drop(factory);
  WNDCLASSW wc={};wc.lpfnWndProc=DefWindowProcW;wc.hInstance=GetModuleHandleW(nullptr);wc.lpszClassName=L"ChartsHubReShadeTest";RegisterClassW(&wc);
  HWND window=CreateWindowExW(0,wc.lpszClassName,L"ChartsHub ReShade isolated validation",WS_POPUP,0,0,192,128,nullptr,nullptr,wc.hInstance,nullptr);
  DXGI_SWAP_CHAIN_DESC desc={};desc.BufferDesc.Width=192;desc.BufferDesc.Height=128;desc.BufferDesc.Format=DXGI_FORMAT_R8G8B8A8_UNORM;desc.SampleDesc.Count=1;desc.BufferUsage=DXGI_USAGE_RENDER_TARGET_OUTPUT;desc.BufferCount=1;desc.OutputWindow=window;desc.Windowed=TRUE;desc.SwapEffect=DXGI_SWAP_EFFECT_SEQUENTIAL;
  IDXGISwapChain* swap=nullptr;ID3D11Device* device=nullptr;ID3D11DeviceContext* context=nullptr;
  HRESULT hr=D3D11CreateDeviceAndSwapChain(nullptr,D3D_DRIVER_TYPE_HARDWARE,nullptr,0,nullptr,0,D3D11_SDK_VERSION,&desc,&swap,&device,nullptr,&context);
  if(FAILED(hr)){printf("{\"error\":\"device_failed\",\"hr\":%ld}\n",hr);return 1;}
  ID3D11Texture2D *back=nullptr,*staging=nullptr;ID3D11RenderTargetView* view=nullptr;
  if(FAILED(swap->GetBuffer(0,__uuidof(ID3D11Texture2D),(void**)&back))||FAILED(device->CreateRenderTargetView(back,nullptr,&view)))return 2;
  D3D11_TEXTURE2D_DESC td;back->GetDesc(&td);td.BindFlags=0;td.MiscFlags=0;td.Usage=D3D11_USAGE_STAGING;td.CPUAccessFlags=D3D11_CPU_ACCESS_READ;if(FAILED(device->CreateTexture2D(&td,nullptr,&staging)))return 3;
  printf("{\"pid\":%lu,\"started\":true}\n",GetCurrentProcessId());ULONGLONG start=GetTickCount64();unsigned frame=0;
  while(GetTickCount64()-start<120000){
    MSG msg;while(PeekMessageW(&msg,nullptr,0,0,PM_REMOVE)){TranslateMessage(&msg);DispatchMessageW(&msg);}
    float color[4]={.25f,.5f,.75f,1};context->ClearRenderTargetView(view,color);swap->Present(0,0);frame++;
    if(frame%6==0){context->CopyResource(staging,back);D3D11_MAPPED_SUBRESOURCE mapped={};if(SUCCEEDED(context->Map(staging,0,D3D11_MAP_READ,0,&mapped))){unsigned char* p=(unsigned char*)mapped.pData+64*mapped.RowPitch+96*4;printf("{\"frame\":%u,\"pixel\":[%u,%u,%u,%u]}\n",frame,p[0],p[1],p[2],p[3]);context->Unmap(staging,0);}}
    Sleep(16);
  }
  context->ClearState();drop(staging);drop(view);drop(back);drop(swap);drop(context);drop(device);DestroyWindow(window);return 0;
}
