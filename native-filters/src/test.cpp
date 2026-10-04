#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <d3d11_1.h>
#include <dxgi1_2.h>
#include <stdio.h>
#include <stdlib.h>
#include <math.h>
#include <wchar.h>

static wchar_t ini[MAX_PATH],status[MAX_PATH];
static unsigned checks=0;
static void require(bool ok,const char* what){if(!ok){fprintf(stderr,"FAIL: %s\n",what);exit(1);}checks++;printf("PASS: %s\n",what);}
template<class T>static void drop(T*& value){if(value){value->Release();value=nullptr;}}
static void config(const char* value){
    wchar_t temporary[MAX_PATH];wcscpy_s(temporary,ini);wcscat_s(temporary,L".tmp");
    HANDLE f=CreateFileW(temporary,GENERIC_WRITE,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,nullptr,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,nullptr);
    require(f!=INVALID_HANDLE_VALUE,"test configuration writable");DWORD wrote;WriteFile(f,value,(DWORD)strlen(value),&wrote,nullptr);CloseHandle(f);
    require(MoveFileExW(temporary,ini,MOVEFILE_REPLACE_EXISTING|MOVEFILE_WRITE_THROUGH)!=0,"configuration replaced atomically without Win32 INI cache flush");
    Sleep(450);
}
static unsigned long long frameCount(){wchar_t buf[64];GetPrivateProfileStringW(L"Status",L"frames",L"0",buf,64,status);return _wcstoui64(buf,nullptr,10);}
static void pixel(ID3D11Device* device,ID3D11DeviceContext* context,IDXGISwapChain* swap,unsigned x,unsigned y,unsigned char out[4]){
    ID3D11Texture2D *back=nullptr,*staging=nullptr;require(SUCCEEDED(swap->GetBuffer(0,__uuidof(ID3D11Texture2D),(void**)&back)),"readback buffer available");
    D3D11_TEXTURE2D_DESC d;back->GetDesc(&d);d.Usage=D3D11_USAGE_STAGING;d.BindFlags=0;d.CPUAccessFlags=D3D11_CPU_ACCESS_READ;d.MiscFlags=0;
    require(SUCCEEDED(device->CreateTexture2D(&d,nullptr,&staging)),"GPU readback texture created");context->CopyResource(staging,back);
    D3D11_MAPPED_SUBRESOURCE mapped;require(SUCCEEDED(context->Map(staging,0,D3D11_MAP_READ,0,&mapped)),"GPU readback completed");
    memcpy(out,(char*)mapped.pData+y*mapped.RowPitch+x*4,4);context->Unmap(staging,0);drop(staging);drop(back);
}
static void clear(ID3D11Device* device,ID3D11DeviceContext* context,IDXGISwapChain* swap,const float rgba[4]){
    ID3D11Texture2D* back=nullptr;ID3D11RenderTargetView* view=nullptr;
    require(SUCCEEDED(swap->GetBuffer(0,__uuidof(ID3D11Texture2D),(void**)&back)),"render buffer available");require(SUCCEEDED(device->CreateRenderTargetView(back,nullptr,&view)),"render target created");
    context->ClearRenderTargetView(view,rgba);drop(view);drop(back);
}
int main(){
    SetErrorMode(SEM_FAILCRITICALERRORS|SEM_NOGPFAULTERRORBOX);
    GetModuleFileNameW(nullptr,ini,MAX_PATH);wchar_t* slash=wcsrchr(ini,L'\\');slash[1]=0;wcscpy_s(status,ini);wcscat_s(ini,L"ChartsHubFilters.ini");wcscat_s(status,L"ChartsHubFilters.status.ini");
    config("[Filters]\r\nenabled=0\r\n");
    HMODULE proxy=GetModuleHandleW(L"dxgi.dll");require(proxy!=nullptr,"DXGI loaded through ordinary imports");
    wchar_t loaded[MAX_PATH];GetModuleFileNameW(proxy,loaded,MAX_PATH);wchar_t executable[MAX_PATH];GetModuleFileNameW(nullptr,executable,MAX_PATH);*wcsrchr(executable,L'\\')=0;
    require(_wcsnicmp(loaded,executable,wcslen(executable))==0,"local ChartsHub DXGI proxy selected");
    IDXGIFactory1* factory=nullptr;require(SUCCEEDED(CreateDXGIFactory1(__uuidof(IDXGIFactory1),(void**)&factory)),"CreateDXGIFactory1 forwarded to System32");drop(factory);
    WNDCLASSW wc={};wc.lpfnWndProc=DefWindowProcW;wc.hInstance=GetModuleHandleW(nullptr);wc.lpszClassName=L"ChartsHubFilterTest";RegisterClassW(&wc);
    HWND window=CreateWindowExW(0,wc.lpszClassName,L"ChartsHub Filter Tests",WS_POPUP,0,0,64,64,nullptr,nullptr,wc.hInstance,nullptr);
    require(window!=nullptr,"isolated hidden test window created");
    DXGI_SWAP_CHAIN_DESC desc={};desc.BufferDesc.Width=64;desc.BufferDesc.Height=64;desc.BufferDesc.Format=DXGI_FORMAT_R8G8B8A8_UNORM;desc.SampleDesc.Count=1;desc.BufferUsage=DXGI_USAGE_RENDER_TARGET_OUTPUT;desc.BufferCount=1;desc.OutputWindow=window;desc.Windowed=TRUE;desc.SwapEffect=DXGI_SWAP_EFFECT_SEQUENTIAL;
    IDXGISwapChain* swap=nullptr;ID3D11Device* device=nullptr;ID3D11DeviceContext* context=nullptr;
    require(SUCCEEDED(D3D11CreateDeviceAndSwapChain(nullptr,D3D_DRIVER_TYPE_HARDWARE,nullptr,0,nullptr,0,D3D11_SDK_VERSION,&desc,&swap,&device,nullptr,&context)),"hardware D3D11 swapchain created");
    Sleep(1200);
    wchar_t startupError[128];GetPrivateProfileStringW(L"Status",L"error",L"missing",startupError,128,status);require(startupError[0]==0,"disabled startup reports no failure");require(GetPrivateProfileIntW(L"Status",L"ready",1,status)==0,"disabled startup does not claim shader readiness");
    unsigned char p[4];const float color[]={0.8f,0.2f,0.1f,1};
    clear(device,context,swap,color);swap->Present(0,0);pixel(device,context,swap,32,32,p);
    printf("Disabled pixel: %u %u %u %u\n",p[0],p[1],p[2],p[3]);require(abs((int)p[0]-204)<=1&&abs((int)p[1]-51)<=1&&abs((int)p[2]-26)<=1,"disabled filters preserve original pixels");
    config("[Filters]\r\nenabled=1\r\nsaturation=0\r\ncontrast=1\r\ngamma=1\r\nexposure=0\r\nsharpness=0\r\nvignette=0\r\n");
    // Validate a state that partial implementations often lose: a UAV at OM slot 2.
    ID3D11Buffer* buffer=nullptr;D3D11_BUFFER_DESC bd={};bd.ByteWidth=16;bd.Usage=D3D11_USAGE_DEFAULT;bd.BindFlags=D3D11_BIND_UNORDERED_ACCESS;bd.MiscFlags=D3D11_RESOURCE_MISC_BUFFER_STRUCTURED;bd.StructureByteStride=4;
    ID3D11UnorderedAccessView* uav=nullptr;require(SUCCEEDED(device->CreateBuffer(&bd,nullptr,&buffer)),"state probe buffer created");require(SUCCEEDED(device->CreateUnorderedAccessView(buffer,nullptr,&uav)),"state probe UAV created");
    context->OMSetRenderTargetsAndUnorderedAccessViews(0,nullptr,nullptr,2,1,&uav,nullptr);
    D3D11_VIEWPORT viewport={3,5,21,25,.2f,.8f};context->RSSetViewports(1,&viewport);context->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_LINESTRIP);
    clear(device,context,swap,color);swap->Present(0,0);pixel(device,context,swap,32,32,p);
    printf("Grayscale pixel: %u %u %u %u\n",p[0],p[1],p[2],p[3]);require(abs((int)p[0]-82)<=2&&abs((int)p[0]-p[1])<=1&&abs((int)p[1]-p[2])<=1,"actual Present applies grayscale GPU shader");
    D3D11_VIEWPORT after={};UINT count=1;context->RSGetViewports(&count,&after);require(count==1&&memcmp(&viewport,&after,sizeof(viewport))==0,"viewport completely restored");
    D3D11_PRIMITIVE_TOPOLOGY topology;context->IAGetPrimitiveTopology(&topology);require(topology==D3D11_PRIMITIVE_TOPOLOGY_LINESTRIP,"input assembly topology restored");
    ID3D11UnorderedAccessView* afterUav=nullptr;context->OMGetRenderTargetsAndUnorderedAccessViews(0,nullptr,nullptr,2,1,&afterUav);require(afterUav==uav,"output merger UAV binding preserved");drop(afterUav);context->ClearState();drop(uav);drop(buffer);
    Sleep(1200);require(GetPrivateProfileIntW(L"Status",L"ready",0,status)==1,"ready reported after successful rendering");require(frameCount()>0,"status reports rendered frames");require(GetPrivateProfileIntW(L"Status",L"pid",0,status)==GetCurrentProcessId(),"status identifies correct process");
    wchar_t err[128];GetPrivateProfileStringW(L"Status",L"error",L"missing",err,128,status);require(err[0]==0,"successful status has no error");
    config("[Filters]\r\nenabled=1\r\nsaturation=1\r\ncontrast=1\r\ngamma=1\r\nexposure=1\r\nsharpness=0\r\nvignette=0\r\n");
    const float middle[]={.2f,.3f,.4f,1};clear(device,context,swap,middle);swap->Present(0,0);pixel(device,context,swap,32,32,p);require(abs((int)p[0]-102)<=2&&abs((int)p[1]-154)<=2&&abs((int)p[2]-204)<=2,"settings reload changes exposure without restart");
    require(SUCCEEDED(swap->ResizeBuffers(1,96,48,DXGI_FORMAT_R8G8B8A8_UNORM,0)),"resize succeeds with no retained backbuffer references");
    clear(device,context,swap,middle);swap->Present(0,0);pixel(device,context,swap,48,24,p);require(abs((int)p[0]-102)<=2,"filter resources recreated after resize");
    config("[Filters]\r\nenabled=1\r\nsaturation=1\r\ncontrast=1\r\ngamma=2\r\nexposure=0\r\nsharpness=0\r\nvignette=0\r\n");
    clear(device,context,swap,middle);swap->Present(0,0);pixel(device,context,swap,48,24,p);require(abs((int)p[0]-114)<=2&&abs((int)p[1]-140)<=2,"gamma shader matches expected result");
    config("[Filters]\r\nenabled=1\r\nsaturation=1\r\ncontrast=2\r\ngamma=1\r\nexposure=0\r\nsharpness=0\r\nvignette=0\r\n");
    clear(device,context,swap,middle);swap->Present(0,0);pixel(device,context,swap,48,24,p);require(p[0]<=1&&abs((int)p[1]-26)<=2&&abs((int)p[2]-77)<=2,"contrast shader matches expected result");
    config("[Filters]\r\nenabled=1\r\nsaturation=1\r\ncontrast=1\r\ngamma=1\r\nexposure=0\r\nsharpness=1\r\nvignette=0\r\n");
    ID3D11Texture2D* patterned=nullptr;require(SUCCEEDED(swap->GetBuffer(0,__uuidof(ID3D11Texture2D),(void**)&patterned)),"sharpness test buffer available");
    unsigned char pixels[96*48*4];memset(pixels,64,sizeof(pixels));for(unsigned i=0;i<96*48;i++)pixels[4*i+3]=255;for(unsigned channel=0;channel<3;channel++)pixels[(24*96+48)*4+channel]=128;
    context->UpdateSubresource(patterned,0,nullptr,pixels,96*4,0);drop(patterned);swap->Present(0,0);pixel(device,context,swap,48,24,p);require(abs((int)p[0]-192)<=2&&p[0]==p[1]&&p[1]==p[2],"sharpness uses neighboring GPU texture pixels");
    config("[Filters]\r\nenabled=1\r\nexposure=1\r\n");
    IDXGISwapChain1* swap1=nullptr;require(SUCCEEDED(swap->QueryInterface(__uuidof(IDXGISwapChain1),(void**)&swap1)),"Present1 interface available");
    clear(device,context,swap,middle);DXGI_PRESENT_PARAMETERS presentParams={};swap1->Present1(0,0,&presentParams);drop(swap1);pixel(device,context,swap,48,24,p);require(abs((int)p[0]-102)<=2&&abs((int)p[1]-154)<=2&&abs((int)p[2]-204)<=2,"Present1 receives exactly one non-idempotent exposure pass");
    config("[Filters]\r\nenabled=1\r\nsaturation=1\r\ncontrast=1\r\ngamma=1\r\nexposure=0\r\nsharpness=0\r\nvignette=1\r\n");
    clear(device,context,swap,middle);swap->Present(0,0);pixel(device,context,swap,0,0,p);require(p[0]<4&&p[1]<4&&p[2]<4,"vignette darkens image corners");
    config("[Filters]\r\nenabled=1\r\nsaturation=nan\r\ncontrast=garbage\r\ngamma=0\r\nexposure=999\r\nsharpness=-99\r\nvignette=-99\r\n");
    clear(device,context,swap,middle);swap->Present(0,0);pixel(device,context,swap,48,24,p);require(abs((int)p[0]-163)<=3&&p[1]>=253&&p[2]>=253,"malformed controls fall back and numeric ranges clamp");
    config("[Filters]\r\nenabled=0\r\n");clear(device,context,swap,middle);swap->Present(0,0);pixel(device,context,swap,48,24,p);require(abs((int)p[0]-51)<=1,"live disable restores passthrough");
    config("[Filters]\r\nenabled=1\r\nsaturation=0\r\n");
    clear(device,context,swap,color);swap->Present(0,DXGI_PRESENT_TEST);pixel(device,context,swap,48,24,p);require(abs((int)p[0]-204)<=1,"DXGI_PRESENT_TEST does not alter the frame");
    clear(device,context,swap,color);swap->Present(0,DXGI_PRESENT_DO_NOT_WAIT);pixel(device,context,swap,48,24,p);require(abs((int)p[0]-204)<=1,"nonblocking presents do not risk repeated filter application");
    require(SUCCEEDED(swap->ResizeBuffers(1,64,64,DXGI_FORMAT_R10G10B10A2_UNORM,0)),"HDR format swapchain created for fail-safe check");
    clear(device,context,swap,color);swap->Present(0,0);Sleep(1200);GetPrivateProfileStringW(L"Status",L"error",L"",err,128,status);require(wcscmp(err,L"unsupported_backbuffer_format_or_msaa")==0,"unsupported HDR format explicitly bypassed");require(GetPrivateProfileIntW(L"Status",L"ready",1,status)==0,"unsupported frame cannot report ready");
    require(SUCCEEDED(swap->ResizeBuffers(1,64,64,DXGI_FORMAT_R8G8B8A8_UNORM,0)),"SDR restored after unsupported HDR");clear(device,context,swap,color);swap->Present(0,0);pixel(device,context,swap,32,32,p);require(abs((int)p[0]-82)<=2,"filter recovers when SDR becomes available again");
    context->ClearState();drop(swap);drop(context);drop(device);DestroyWindow(window);
    printf("SUCCESS: %u checks; independent D3D11 GPU validation completed.\n",checks);return 0;
}
