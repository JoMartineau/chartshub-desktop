#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <d3d11_1.h>
#include <dxgi1_2.h>
#include <d3dcompiler.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <wchar.h>
#include "MinHook.h"
#include "forward_names.h"

// Native ChartsHub filter protocol 1. No ReShade APIs, shaders, or runtime.
static HMODULE selfModule;
static wchar_t iniPath[MAX_PATH], statusPath[MAX_PATH];
static SRWLOCK settingsLock = SRWLOCK_INIT, renderLock = SRWLOCK_INIT;
struct Settings { bool enabled=false; float saturation=1,contrast=1,gamma=1,exposure=0,sharpness=0,vignette=0; };
static Settings settings;
static volatile LONG64 frames=0;
static volatile LONG ready=0;
static const char* lastError="";
static const GUID engineGuid={0x30384cb2,0xe610,0x45fc,{0xa5,0x4c,0x3b,0x71,0x18,0x6a,0xb1,0x1f}};
template<class T> static void release(T*& p) { if(p){p->Release();p=nullptr;} }
static void error(const char* value){AcquireSRWLockExclusive(&settingsLock);lastError=value;ReleaseSRWLockExclusive(&settingsLock);if(value[0])InterlockedExchange(&ready,0);}

extern "C" void* forwardAddresses[FORWARD_COUNT]={};
static INIT_ONCE realOnce=INIT_ONCE_STATIC_INIT;
static BOOL CALLBACK loadReal(PINIT_ONCE,void*,void**){
    wchar_t file[MAX_PATH]; UINT n=GetSystemDirectoryW(file,MAX_PATH);
    if(!n || n+10>=MAX_PATH)return TRUE;
    wcscat_s(file,L"\\dxgi.dll");
    HMODULE real=LoadLibraryExW(file,nullptr,LOAD_LIBRARY_SEARCH_SYSTEM32);
    if(real)for(unsigned i=0;i<FORWARD_COUNT;i++)forwardAddresses[i]=(void*)GetProcAddress(real,forwardNames[i]);
    return TRUE;
}
static HRESULT WINAPI missingForward(){return E_NOTIMPL;}
extern "C" void* ResolveForward(unsigned i){
    InitOnceExecuteOnce(&realOnce,loadReal,nullptr,nullptr);
    return i<FORWARD_COUNT && forwardAddresses[i]?forwardAddresses[i]:(void*)&missingForward;
}

static const char shaderSource[]=R"HLSL(
Texture2D source : register(t0);
SamplerState linearClamp : register(s0);
cbuffer Controls : register(b0) { float4 grade; float4 detail; }
struct Fragment { float4 position:SV_Position; float2 uv:TEXCOORD0; };
Fragment VS(uint id:SV_VertexID) {
    Fragment o; float2 uv=float2((id<<1)&2,id&2);
    o.position=float4(uv*float2(2,-2)+float2(-1,1),0,1); o.uv=uv; return o;
}
float4 PS(Fragment p):SV_Target {
    float4 original=source.SampleLevel(linearClamp,p.uv,0);
    float3 color=original.rgb;
    if(detail.x>0) {
        float2 t=detail.zw;
        float3 blur=(source.SampleLevel(linearClamp,p.uv+float2(t.x,0),0).rgb+
                     source.SampleLevel(linearClamp,p.uv-float2(t.x,0),0).rgb+
                     source.SampleLevel(linearClamp,p.uv+float2(0,t.y),0).rgb+
                     source.SampleLevel(linearClamp,p.uv-float2(0,t.y),0).rgb)*0.25;
        color += detail.x*(color-blur);
    }
    color *= exp2(grade.w);
    float luma=dot(color,float3(0.2126,0.7152,0.0722));
    color=lerp(luma.xxx,color,grade.x);
    color=(color-0.5)*grade.y+0.5;
    color=pow(saturate(color),1.0/grade.z);
    float2 edge=p.uv*2-1;
    color*=1-detail.y*smoothstep(0.2,1.5,dot(edge,edge));
    return float4(saturate(color),original.a);
}
)HLSL";
typedef HRESULT (WINAPI *CompileFn)(LPCVOID,SIZE_T,LPCSTR,const D3D_SHADER_MACRO*,ID3DInclude*,LPCSTR,LPCSTR,UINT,UINT,ID3DBlob**,ID3DBlob**);
static CompileFn compileShader;
static ID3DBlob *vertexCode=nullptr,*pixelCode=nullptr;

class Engine final:public IUnknown {
    LONG refs=1;
public:
    ID3D11Device1* device=nullptr;
    ID3D11DeviceContext1* context=nullptr;
    ID3DDeviceContextState* state=nullptr;
    ID3D11VertexShader* vertex=nullptr;
    ID3D11PixelShader* pixel=nullptr;
    ID3D11Buffer* constants=nullptr;
    ID3D11SamplerState* sampler=nullptr;
    ID3D11RasterizerState* raster=nullptr;
    ID3D11Texture2D* copy=nullptr;
    ID3D11ShaderResourceView* source=nullptr;
    UINT width=0,height=0; DXGI_FORMAT format=DXGI_FORMAT_UNKNOWN;
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid,void** result) override {if(!result)return E_POINTER;*result=nullptr;if(iid==__uuidof(IUnknown)){*result=this;AddRef();return S_OK;}return E_NOINTERFACE;}
    ULONG STDMETHODCALLTYPE AddRef()override{return InterlockedIncrement(&refs);}
    ULONG STDMETHODCALLTYPE Release()override{ULONG n=InterlockedDecrement(&refs);if(!n)delete this;return n;}
    ~Engine(){release(source);release(copy);release(raster);release(sampler);release(constants);release(pixel);release(vertex);release(state);release(context);release(device);}
    bool initialize(IDXGISwapChain* swap){
        ID3D11Device* base=nullptr; ID3D11DeviceContext* baseContext=nullptr;
        if(FAILED(swap->GetDevice(__uuidof(ID3D11Device),(void**)&base))){error("unsupported_graphics_api");return false;}
        HRESULT hr=base->QueryInterface(__uuidof(ID3D11Device1),(void**)&device);
        base->GetImmediateContext(&baseContext);
        if(SUCCEEDED(hr))hr=baseContext->QueryInterface(__uuidof(ID3D11DeviceContext1),(void**)&context);
        const D3D_FEATURE_LEVEL levels[]={base->GetFeatureLevel()};
        UINT flags=(base->GetCreationFlags()&D3D11_CREATE_DEVICE_SINGLETHREADED)?D3D11_1_CREATE_DEVICE_CONTEXT_STATE_SINGLETHREADED:0;
        release(baseContext);release(base);
        if(FAILED(hr)){error("d3d11_1_state_isolation_required");return false;}
        hr=device->CreateDeviceContextState(flags,levels,1,D3D11_SDK_VERSION,__uuidof(ID3D11Device),nullptr,&state);
        if(FAILED(hr)){error("context_state_creation_failed");return false;}
        if(!vertexCode || !pixelCode){error("shader_unavailable");return false;}
        if(FAILED(device->CreateVertexShader(vertexCode->GetBufferPointer(),vertexCode->GetBufferSize(),nullptr,&vertex)) ||
           FAILED(device->CreatePixelShader(pixelCode->GetBufferPointer(),pixelCode->GetBufferSize(),nullptr,&pixel))){error("shader_creation_failed");return false;}
        D3D11_BUFFER_DESC cb={};cb.ByteWidth=32;cb.Usage=D3D11_USAGE_DEFAULT;cb.BindFlags=D3D11_BIND_CONSTANT_BUFFER;
        if(FAILED(device->CreateBuffer(&cb,nullptr,&constants))){error("constant_buffer_failed");return false;}
        D3D11_SAMPLER_DESC sd={};sd.Filter=D3D11_FILTER_MIN_MAG_MIP_LINEAR;sd.AddressU=sd.AddressV=sd.AddressW=D3D11_TEXTURE_ADDRESS_CLAMP;sd.MaxLOD=D3D11_FLOAT32_MAX;
        D3D11_RASTERIZER_DESC rd={};rd.FillMode=D3D11_FILL_SOLID;rd.CullMode=D3D11_CULL_NONE;rd.DepthClipEnable=TRUE;
        if(FAILED(device->CreateSamplerState(&sd,&sampler))||FAILED(device->CreateRasterizerState(&rd,&raster))){error("render_state_failed");return false;}
        return true;
    }
    bool render(IDXGISwapChain* swap,const Settings& s){
        ID3D11Texture2D* back=nullptr; ID3D11RenderTargetView* target=nullptr;
        if(FAILED(swap->GetBuffer(0,__uuidof(ID3D11Texture2D),(void**)&back))){error("backbuffer_unavailable");return false;}
        D3D11_TEXTURE2D_DESC desc;back->GetDesc(&desc);
        bool supported=desc.Format==DXGI_FORMAT_R8G8B8A8_UNORM || desc.Format==DXGI_FORMAT_B8G8R8A8_UNORM;
        if(!supported || desc.SampleDesc.Count!=1 || desc.ArraySize!=1 || !desc.Width || !desc.Height){release(back);error("unsupported_backbuffer_format_or_msaa");return false;}
        if(width!=desc.Width || height!=desc.Height || format!=desc.Format || !source){
            release(source);release(copy);width=desc.Width;height=desc.Height;format=desc.Format;
            D3D11_TEXTURE2D_DESC cd=desc;cd.Usage=D3D11_USAGE_DEFAULT;cd.BindFlags=D3D11_BIND_SHADER_RESOURCE;cd.CPUAccessFlags=0;cd.MiscFlags=0;cd.MipLevels=1;
            if(FAILED(device->CreateTexture2D(&cd,nullptr,&copy)) || FAILED(device->CreateShaderResourceView(copy,nullptr,&source))){release(back);error("frame_copy_creation_failed");return false;}
        }
        if(FAILED(device->CreateRenderTargetView(back,nullptr,&target))){release(back);error("backbuffer_view_failed");return false;}
        // SwapDeviceContextState preserves every graphics/compute stage, resource,
        // UAV, stream output, blend, viewport and rasterizer state as one unit.
        ID3DDeviceContextState* previous=nullptr;
        context->SwapDeviceContextState(state,&previous);
        if(!previous){release(target);release(back);error("state_capture_failed");return false;}
        context->ClearState();
        context->CopyResource(copy,back);
        float values[8]={s.saturation,s.contrast,s.gamma,s.exposure,s.sharpness,s.vignette,1.0f/width,1.0f/height};
        context->UpdateSubresource(constants,0,nullptr,values,0,0);
        context->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
        context->VSSetShader(vertex,nullptr,0);context->PSSetShader(pixel,nullptr,0);
        context->PSSetConstantBuffers(0,1,&constants);context->PSSetShaderResources(0,1,&source);context->PSSetSamplers(0,1,&sampler);
        context->RSSetState(raster);
        D3D11_VIEWPORT viewport={0,0,(FLOAT)width,(FLOAT)height,0,1};context->RSSetViewports(1,&viewport);
        context->OMSetRenderTargets(1,&target,nullptr);context->Draw(3,0);
        // Drop ALL references to the swapchain buffer before restoring the game.
        // No buffer reference survives Present, so ResizeBuffers and fullscreen work.
        context->ClearState();context->SwapDeviceContextState(previous,nullptr);release(previous);
        release(target);release(back);
        if(FAILED(device->GetDeviceRemovedReason())){error("device_removed");return false;}
        InterlockedIncrement64(&frames);InterlockedExchange(&ready,1);error("");return true;
    }
};

typedef HRESULT (STDMETHODCALLTYPE *PresentFn)(IDXGISwapChain*,UINT,UINT);
typedef HRESULT (STDMETHODCALLTYPE *Present1Fn)(IDXGISwapChain1*,UINT,UINT,const DXGI_PRESENT_PARAMETERS*);
static PresentFn originalPresent;
static Present1Fn originalPresent1;
static thread_local bool insidePresent=false;
static bool processFrame(IDXGISwapChain* swap,UINT flags){
    // A nonblocking Present may reject the image; grading that same buffer again
    // on retry would compound the effect. Such presents remain untouched.
    if(flags&(DXGI_PRESENT_TEST|DXGI_PRESENT_DO_NOT_WAIT))return false;
    AcquireSRWLockShared(&settingsLock);Settings s=settings;ReleaseSRWLockShared(&settingsLock);
    if(!s.enabled)return false;
    AcquireSRWLockExclusive(&renderLock);
    Engine* engine=nullptr;UINT bytes=sizeof(engine);
    if(FAILED(swap->GetPrivateData(engineGuid,&bytes,&engine)) || !engine){
        engine=new Engine;
        if(!engine->initialize(swap)){engine->Release();ReleaseSRWLockExclusive(&renderLock);return false;}
        if(FAILED(swap->SetPrivateDataInterface(engineGuid,engine))){engine->Release();ReleaseSRWLockExclusive(&renderLock);error("swapchain_storage_failed");return false;}
    }
    bool rendered=engine->render(swap,s);engine->Release();
    ReleaseSRWLockExclusive(&renderLock);
    return rendered;
}
static HRESULT STDMETHODCALLTYPE hookedPresent(IDXGISwapChain* swap,UINT sync,UINT flags){
    bool outer=!insidePresent; if(outer){insidePresent=true;processFrame(swap,flags);}
    HRESULT hr=originalPresent(swap,sync,flags);if(outer)insidePresent=false;return hr;
}
static HRESULT STDMETHODCALLTYPE hookedPresent1(IDXGISwapChain1* swap,UINT sync,UINT flags,const DXGI_PRESENT_PARAMETERS* params){
    bool outer=!insidePresent,rendered=false;if(outer){insidePresent=true;rendered=processFrame(swap,flags);}
    // A whole-frame effect invalidates dirty rectangles. Preserve original params
    // whenever disabled; use full-frame presentation only when filters are active.
    DXGI_PRESENT_PARAMETERS full={};
    HRESULT hr=originalPresent1(swap,sync,flags,rendered?&full:params);if(outer)insidePresent=false;return hr;
}
static float readValue(const wchar_t* key,float fallback,float low,float high){
    wchar_t buf[64],*end=nullptr;GetPrivateProfileStringW(L"Filters",key,L"",buf,64,iniPath);
    if(!buf[0])return fallback;float v=(float)wcstod(buf,&end);
    while(end && (*end==L' '||*end==L'\t'))end++;
    if(end==buf || (end && *end) || !isfinite(v))return fallback;
    return v<low?low:v>high?high:v;
}
static void pollSettings(){
    Settings next;next.enabled=readValue(L"enabled",0,0,1)==1;
    next.saturation=readValue(L"saturation",1,0,2);next.contrast=readValue(L"contrast",1,.5f,2);next.gamma=readValue(L"gamma",1,.5f,2.5f);
    next.exposure=readValue(L"exposure",0,-2,2);next.sharpness=readValue(L"sharpness",0,0,1);next.vignette=readValue(L"vignette",0,0,1);
    AcquireSRWLockExclusive(&settingsLock);settings=next;ReleaseSRWLockExclusive(&settingsLock);
}
static void writeStatus(){
    AcquireSRWLockShared(&settingsLock);bool enabled=settings.enabled;const char* err=lastError;ReleaseSRWLockShared(&settingsLock);
    char data[512];int count=snprintf(data,sizeof(data),"[Status]\r\nprotocol=1\r\npid=%lu\r\nready=%ld\r\nenabled=%d\r\nframes=%lld\r\nerror=%s\r\n",GetCurrentProcessId(),InterlockedCompareExchange(&ready,0,0),enabled?1:0,(long long)InterlockedCompareExchange64(&frames,0,0),err);
    HANDLE out=CreateFileW(statusPath,GENERIC_WRITE,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,nullptr,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,nullptr);
    if(out!=INVALID_HANDLE_VALUE){DWORD written;WriteFile(out,data,count,&written,nullptr);CloseHandle(out);}
}
static bool prepareShaders(){
    HMODULE compiler=LoadLibraryExW(L"d3dcompiler_47.dll",nullptr,LOAD_LIBRARY_SEARCH_SYSTEM32);
    if(!compiler){error("d3dcompiler_47_missing");return false;}
    compileShader=(CompileFn)GetProcAddress(compiler,"D3DCompile");if(!compileShader){error("shader_compiler_unavailable");return false;}
    ID3DBlob* messages=nullptr;
    HRESULT a=compileShader(shaderSource,sizeof(shaderSource)-1,"ChartsHubFilters",nullptr,nullptr,"VS","vs_4_0",D3DCOMPILE_ENABLE_STRICTNESS|D3DCOMPILE_OPTIMIZATION_LEVEL3,0,&vertexCode,&messages);release(messages);
    HRESULT b=compileShader(shaderSource,sizeof(shaderSource)-1,"ChartsHubFilters",nullptr,nullptr,"PS","ps_4_0",D3DCOMPILE_ENABLE_STRICTNESS|D3DCOMPILE_OPTIMIZATION_LEVEL3,0,&pixelCode,&messages);release(messages);
    if(FAILED(a)||FAILED(b)){error("shader_compile_failed");return false;}return true;
}
static bool installHooks(){
    HMODULE d3d=LoadLibraryExW(L"d3d11.dll",nullptr,LOAD_LIBRARY_SEARCH_SYSTEM32);if(!d3d){error("d3d11_missing");return false;}
    auto create=(decltype(&D3D11CreateDeviceAndSwapChain))GetProcAddress(d3d,"D3D11CreateDeviceAndSwapChain");if(!create)return false;
    WNDCLASSW klass={};klass.lpfnWndProc=DefWindowProcW;klass.hInstance=selfModule;klass.lpszClassName=L"ChartsHubFilterProbe";RegisterClassW(&klass);
    HWND window=CreateWindowExW(0,klass.lpszClassName,L"",WS_POPUP,0,0,2,2,nullptr,nullptr,selfModule,nullptr);
    if(!window){error("probe_window_failed");return false;}
    DXGI_SWAP_CHAIN_DESC desc={};desc.BufferDesc.Width=2;desc.BufferDesc.Height=2;desc.BufferDesc.Format=DXGI_FORMAT_R8G8B8A8_UNORM;desc.SampleDesc.Count=1;desc.BufferUsage=DXGI_USAGE_RENDER_TARGET_OUTPUT;desc.BufferCount=1;desc.OutputWindow=window;desc.Windowed=TRUE;desc.SwapEffect=DXGI_SWAP_EFFECT_DISCARD;
    IDXGISwapChain* swap=nullptr;ID3D11Device* device=nullptr;ID3D11DeviceContext* context=nullptr;
    HRESULT hr=create(nullptr,D3D_DRIVER_TYPE_HARDWARE,nullptr,0,nullptr,0,D3D11_SDK_VERSION,&desc,&swap,&device,nullptr,&context);
    if(FAILED(hr))hr=create(nullptr,D3D_DRIVER_TYPE_WARP,nullptr,0,nullptr,0,D3D11_SDK_VERSION,&desc,&swap,&device,nullptr,&context);
    bool success=false;
    if(SUCCEEDED(hr)){
        void** table=*(void***)swap;
        if(MH_Initialize()==MH_OK && MH_CreateHook(table[8],(void*)&hookedPresent,(void**)&originalPresent)==MH_OK){
            IDXGISwapChain1* swap1=nullptr;
            if(SUCCEEDED(swap->QueryInterface(__uuidof(IDXGISwapChain1),(void**)&swap1))){
                void** table1=*(void***)swap1;
                if(table1[22]!=table[8])MH_CreateHook(table1[22],(void*)&hookedPresent1,(void**)&originalPresent1);
                release(swap1);
            }
            success=MH_EnableHook(MH_ALL_HOOKS)==MH_OK;
        }
    }
    release(context);release(device);release(swap);DestroyWindow(window);UnregisterClassW(klass.lpszClassName,selfModule);
    error(success?"":"present_hook_failed");return success;
}
static DWORD WINAPI worker(void*){
    HMODULE pinned;GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS|GET_MODULE_HANDLE_EX_FLAG_PIN,(LPCWSTR)&worker,&pinned);
    GetModuleFileNameW(selfModule,iniPath,MAX_PATH);wchar_t* slash=wcsrchr(iniPath,L'\\');if(!slash)return 0;slash[1]=0;
    wcscpy_s(statusPath,iniPath);wcscat_s(iniPath,L"ChartsHubFilters.ini");wcscat_s(statusPath,L"ChartsHubFilters.status.ini");
    pollSettings();writeStatus();
    if(prepareShaders())installHooks();
    unsigned ticks=0;
    for(;;){pollSettings();if(ticks++%5==0)writeStatus();Sleep(200);}
}
BOOL WINAPI DllMain(HINSTANCE module,DWORD reason,LPVOID){
    if(reason==DLL_PROCESS_ATTACH){
        selfModule=module;DisableThreadLibraryCalls(module);
        wchar_t exe[MAX_PATH];GetModuleFileNameW(nullptr,exe,MAX_PATH);const wchar_t* name=wcsrchr(exe,L'\\');name=name?name+1:exe;
        if(!_wcsicmp(name,L"Clone Hero.exe") || !_wcsicmp(name,L"chartshub-filter-test.exe")){
            HANDLE thread=CreateThread(nullptr,0,worker,nullptr,0,nullptr);if(thread)CloseHandle(thread);
        }
    }
    return TRUE;
}
