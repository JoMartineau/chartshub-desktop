#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <sddl.h>
#include <reshade.hpp>
#include <nlohmann/json.hpp>
#include <atomic>
#include <cmath>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

using json=nlohmann::json;
using namespace reshade::api;
extern "C" __declspec(dllexport) const char* NAME="ChartsHub ReShade Bridge";
extern "C" __declspec(dllexport) const char* DESCRIPTION="Local ChartsHub controls for existing ReShade effects (0.11.0).";
static constexpr size_t maxRequest=65536,maxResponse=4*1024*1024,maxEntries=4096,maxUniforms=1024;
static HMODULE moduleHandle;
static std::recursive_mutex runtimeMutex;
static std::mutex queueMutex,snapshotMutex;
static effect_runtime* activeRuntime=nullptr;
static uint64_t generation=1,nextId=1;
static std::string executablePath;
static json snapshot;
static std::atomic<bool> workerStarted{false};
struct Binding{std::string effect,name,kind;};
static std::map<std::string,Binding> bindings;
static std::map<std::string,std::string> identities;
struct Job{
    json request,response;HANDLE completed=CreateEventW(nullptr,TRUE,FALSE,nullptr);
    std::atomic<int> state{0}; // 0 queued, 1 executing, 2 done, 3 cancelled
    ULONGLONG deadline=GetTickCount64()+2000;
    uint64_t expectedGeneration=0;
    ~Job(){if(completed)CloseHandle(completed);}
};
static std::shared_ptr<Job> pending;
static json failure(const json& id,const char* code,const char* message){return {{"id",id},{"ok",false},{"error",{{"code",code},{"message",message}}}};}
static json success(const json& id,json data){return {{"id",id},{"ok",true},{"data",std::move(data)}};}
static std::string basename(const std::string& value){size_t p=value.find_last_of("/\\");return p==std::string::npos?value:value.substr(p+1);}
static json currentStatus(effect_runtime* runtime){
    char preset[4096]={};if(runtime)runtime->get_current_preset_path(preset);
    return {{"protocol",1},{"addonVersion","0.11.0"},{"pid",GetCurrentProcessId()},{"generation",generation},{"runtimeReady",runtime!=nullptr},{"effectsEnabled",runtime?runtime->get_effects_state():false},{"presetName",basename(preset)},{"executablePath",executablePath}};
}
static void publishStatus(effect_runtime* runtime){std::unique_lock<std::mutex> lock(snapshotMutex,std::try_to_lock);if(lock.owns_lock())snapshot=currentStatus(runtime);}
static void publishDisconnected(){std::lock_guard<std::mutex> lock(snapshotMutex);snapshot=currentStatus(nullptr);}
static void cancelPending(){
    std::shared_ptr<Job> job;{std::lock_guard<std::mutex> lock(queueMutex);job=std::move(pending);}
    if(job){int expected=0;if(job->state.compare_exchange_strong(expected,1)){job->response=failure(job->request["id"],"runtime_changed","The ReShade runtime changed; refresh before trying again.");job->state.store(2);SetEvent(job->completed);}}
}
static void invalidate(){generation++;nextId=1;bindings.clear();identities.clear();}
static std::string bindId(const char* kind,const std::string& effect,const std::string& name){
    const std::string key=std::string(kind)+"\n"+effect+"\n"+name;
    auto found=identities.find(key);if(found!=identities.end())return found->second;
    const std::string id=std::to_string(generation)+":"+kind+":"+std::to_string(nextId++);
    bindings.emplace(id,Binding{effect,name,kind});identities.emplace(key,id);return id;
}
static std::string annotation(effect_runtime* runtime,effect_uniform_variable u,const char* key){
    char buffer[4096]={};size_t size=sizeof(buffer);if(!runtime->get_annotation_string_from_uniform_variable(u,key,buffer,&size))return {};
    return std::string(buffer,strnlen(buffer,sizeof(buffer)-1));
}
static json annotationNumbers(effect_runtime* runtime,effect_uniform_variable u,const char* key,unsigned count){
    // Match ReShade's editor: ui_min/ui_max/ui_step are scalar annotations
    // broadcast to all vector components (runtime_gui.cpp, v6.8.0).
    float value=0;if(!runtime->get_annotation_float_from_uniform_variable(u,key,&value,1)||!std::isfinite(value))return nullptr;
    json result=json::array();for(unsigned i=0;i<count;i++)result.push_back(value);
    return result;
}
static json uniformInfo(effect_runtime* runtime,effect_uniform_variable u){
    char name[1024]={},effect[1024]={};runtime->get_uniform_variable_name(u,name);runtime->get_uniform_variable_effect_name(u,effect);
    format base=format::unknown;uint32_t rows=0,columns=0,length=0;runtime->get_uniform_variable_type(u,&base,&rows,&columns,&length);
    const uint64_t total=uint64_t(rows)*columns*(length?length:1);const unsigned components=(unsigned)std::min<uint64_t>(total,16);
    std::string type="float";bool unsupported=false;
    switch(base){case format::r32_float:case format::r16_float:break;case format::r32_sint:case format::r16_sint:type="int";break;case format::r32_uint:case format::r16_uint:type="uint";break;case format::r32_typeless:type="bool";break;default:unsupported=true;}
    std::string label=annotation(runtime,u,"ui_label"),uiType=annotation(runtime,u,"ui_type");
    bool hidden=false,noedit=false;runtime->get_annotation_bool_from_uniform_variable(u,"hidden",&hidden,1);runtime->get_annotation_bool_from_uniform_variable(u,"noedit",&noedit,1);
    bool readOnly=unsupported||!total||total>16||columns>1||length>1||hidden||noedit||uiType=="hidden"||!annotation(runtime,u,"source").empty();
    json value=json::array();if(!unsupported&&total<=16){
        float floats[16]={};int32_t ints[16]={};uint32_t uints[16]={};bool bools[16]={};
        if(type=="float")runtime->get_uniform_value_float(u,floats,components);
        else if(type=="int")runtime->get_uniform_value_int(u,ints,components);
        else if(type=="uint")runtime->get_uniform_value_uint(u,uints,components);
        else runtime->get_uniform_value_bool(u,bools,components);
        for(unsigned i=0;i<components;i++){if(type=="float"){if(!std::isfinite(floats[i])){readOnly=true;floats[i]=0;}value.push_back(floats[i]);}else if(type=="int")value.push_back(ints[i]);else if(type=="uint")value.push_back(uints[i]);else value.push_back(bools[i]);}
    }
    char itemData[8192]={};size_t itemSize=sizeof(itemData);json items=json::array();
    if(runtime->get_annotation_string_from_uniform_variable(u,"ui_items",itemData,&itemSize)){
        const size_t end=std::min(itemSize,sizeof(itemData));size_t at=0;
        while(at<end&&itemData[at]&&items.size()<256){size_t n=strnlen(itemData+at,end-at);items.push_back(std::string(itemData+at,n));at+=n+1;}
    }
    return {{"id",bindId("u",effect,name)},{"name",name},{"label",label.empty()?name:label},{"effect",effect},{"type",type},{"components",components},{"rows",rows},{"columns",columns},{"arrayLength",length},{"value",value},{"uiType",uiType},{"min",annotationNumbers(runtime,u,"ui_min",components)},{"max",annotationNumbers(runtime,u,"ui_max",components)},{"step",annotationNumbers(runtime,u,"ui_step",components)},{"items",items},{"tooltip",annotation(runtime,u,"ui_tooltip")},{"readOnly",readOnly}};
}
static bool stringField(const json& r,const char* name,size_t maximum=1024){return r.contains(name)&&r[name].is_string()&&!r[name].get_ref<const std::string&>().empty()&&r[name].get_ref<const std::string&>().size()<=maximum&&r[name].get_ref<const std::string&>().find('\0')==std::string::npos;}
static bool anyTechnique(effect_runtime* runtime){bool any=false;runtime->enumerate_techniques(nullptr,[&](effect_runtime*,effect_technique){any=true;});return any;}
// Use callback enumeration to avoid C++ aggregate-return ABI differences between
// this GNU-target build and the MSVC-built runtime's find_* virtual methods.
// Returned handles are used only inside the same serialized render callback.
static effect_technique resolveTechnique(effect_runtime* runtime,const Binding& binding){
    effect_technique found={0};runtime->enumerate_techniques(binding.effect.c_str(),[&](effect_runtime* r,effect_technique handle){char name[1024]={};r->get_technique_name(handle,name);if(binding.name==name)found=handle;});return found;
}
static effect_uniform_variable resolveUniform(effect_runtime* runtime,const Binding& binding){
    effect_uniform_variable found={0};runtime->enumerate_uniform_variables(binding.effect.c_str(),[&](effect_runtime* r,effect_uniform_variable handle){char name[1024]={};r->get_uniform_variable_name(handle,name);if(binding.name==name)found=handle;});return found;
}
static json execute(effect_runtime* runtime,const json& request){
    const json id=request["id"];const std::string action=request["action"];
    if(!runtime)return failure(id,"no_runtime","No ReShade effect runtime is available.");
    json data=currentStatus(runtime);
    if(action=="status")return success(id,data);
    if(action=="catalog"){
        json list=json::array();bool overflow=false;
        runtime->enumerate_techniques(nullptr,[&](effect_runtime* r,effect_technique t){
            if(list.size()>=maxEntries){overflow=true;return;}char name[1024]={},effect[1024]={},label[2048]={};r->get_technique_name(t,name);r->get_technique_effect_name(t,effect);r->get_annotation_string_from_technique(t,"ui_label",label);
            list.push_back({{"id",bindId("t",effect,name)},{"name",name},{"label",label[0]?label:name},{"effect",effect},{"enabled",r->get_technique_state(t)}});
        });
        if(overflow)return failure(id,"catalog_limit","Too many techniques to expose safely.");data["techniques"]=std::move(list);return success(id,data);
    }
    if(action=="uniforms"){
        if(!stringField(request,"effect"))return failure(id,"invalid_request","An effect from the catalog is required.");
        const std::string effect=request["effect"];bool known=false;for(const auto& [key,b]:bindings)if(b.kind=="t"&&b.effect==effect){known=true;break;}
        if(!known)return failure(id,"unknown_effect","Refresh the effect catalog first.");
        json list=json::array();bool overflow=false;runtime->enumerate_uniform_variables(effect.c_str(),[&](effect_runtime* r,effect_uniform_variable u){if(list.size()>=maxUniforms){overflow=true;return;}list.push_back(uniformInfo(r,u));});
        if(overflow)return failure(id,"uniform_limit","Too many parameters in this effect.");data["effect"]=effect;data["uniforms"]=std::move(list);return success(id,data);
    }
    if(action=="setEnabled"){
        if(!request.contains("enabled")||!request["enabled"].is_boolean())return failure(id,"invalid_request","enabled must be boolean.");runtime->set_effects_state(request["enabled"].get<bool>());return success(id,currentStatus(runtime));
    }
    if(action=="setTechnique"){
        if(!stringField(request,"techniqueId",128)||!request.contains("enabled")||!request["enabled"].is_boolean())return failure(id,"invalid_request","A technique ID and boolean enabled are required.");
        auto b=bindings.find(request["techniqueId"].get<std::string>());if(b==bindings.end()||b->second.kind!="t")return failure(id,"stale_id","Refresh the effect catalog after reload.");
        auto t=resolveTechnique(runtime,b->second);if(!t.handle)return failure(id,"effects_loading","The technique is unavailable or effects are reloading.");
        runtime->set_technique_state(t,request["enabled"].get<bool>());return success(id,currentStatus(runtime));
    }
    if(action=="setUniform"){
        if(!stringField(request,"uniformId",128)||!request.contains("value")||!request["value"].is_array()||request["value"].size()>16)return failure(id,"invalid_request","A uniform ID and bounded value array are required.");
        auto b=bindings.find(request["uniformId"].get<std::string>());if(b==bindings.end()||b->second.kind!="u")return failure(id,"stale_id","Refresh parameters after effect reload.");
        auto u=resolveUniform(runtime,b->second);if(!u.handle)return failure(id,"effects_loading","The parameter is unavailable or effects are reloading.");
        json info=uniformInfo(runtime,u);if(info["readOnly"].get<bool>())return failure(id,"read_only","This parameter is controlled by the shader or has an unsupported shape.");
        unsigned count=info["components"];if(request["value"].size()!=count)return failure(id,"invalid_value","The parameter component count does not match.");
        const std::string type=info["type"];float f[16]={};int32_t i[16]={};uint32_t u32[16]={};bool flags[16]={};
        for(unsigned n=0;n<count;n++){
            const auto& value=request["value"][n];if(type=="bool"){if(!value.is_boolean())return failure(id,"invalid_value","Boolean parameter values are required.");flags[n]=value.get<bool>();continue;}
            if(!value.is_number())return failure(id,"invalid_value","Numeric parameter values are required.");double number=value.get<double>();
            if(!std::isfinite(number)||fabs(number)>3.402823466e38)return failure(id,"invalid_value","Parameter values must be finite.");
            if(type=="int"&&(floor(number)!=number||number<INT32_MIN||number>INT32_MAX))return failure(id,"invalid_value","Signed integer value is out of range.");
            if(type=="uint"&&(floor(number)!=number||number<0||number>UINT32_MAX))return failure(id,"invalid_value","Unsigned integer value is out of range.");
            for(const char* limit:{"min","max"})if(info[limit].is_array()&&n<info[limit].size()&&info[limit][n].is_number()){
                const double bound=info[limit][n].get<double>();if((limit[1]=='i'&&number<bound-1e-6)||(limit[1]=='a'&&number>bound+1e-6))return failure(id,"invalid_value","Parameter value is outside its annotated bounds.");
            }
            f[n]=(float)number;if(type=="int")i[n]=(int32_t)number;if(type=="uint")u32[n]=(uint32_t)number;
        }
        if(type=="float")runtime->set_uniform_value_float(u,f,count);else if(type=="int")runtime->set_uniform_value_int(u,i,count);else if(type=="uint")runtime->set_uniform_value_uint(u,u32,count);else runtime->set_uniform_value_bool(u,flags,count);
        return success(id,currentStatus(runtime));
    }
    if(action=="savePreset"){
        if(data["presetName"].get<std::string>().empty())return failure(id,"no_preset","No existing preset is selected in ReShade.");
        if(!anyTechnique(runtime))return failure(id,"effects_loading","Cannot save while effects are loading or no techniques are available.");
        runtime->save_current_preset();return success(id,currentStatus(runtime));
    }
    return failure(id,"unknown_action","This action is not supported.");
}
static void onInit(effect_runtime* runtime){std::lock_guard<std::recursive_mutex> lock(runtimeMutex);if(!activeRuntime){activeRuntime=runtime;invalidate();publishStatus(runtime);}}
static void onDestroy(effect_runtime* runtime){std::lock_guard<std::recursive_mutex> lock(runtimeMutex);if(activeRuntime==runtime){activeRuntime=nullptr;invalidate();cancelPending();publishDisconnected();}}
static void onReload(effect_runtime* runtime){std::lock_guard<std::recursive_mutex> lock(runtimeMutex);if(runtime==activeRuntime){invalidate();publishStatus(runtime);}}
static void onPresent(effect_runtime* runtime){
    std::unique_lock<std::recursive_mutex> guard(runtimeMutex,std::try_to_lock);if(!guard.owns_lock()||runtime!=activeRuntime)return;
    static ULONGLONG lastSnapshot=0;if(GetTickCount64()-lastSnapshot>250){publishStatus(runtime);lastSnapshot=GetTickCount64();}
    std::shared_ptr<Job> job;{std::unique_lock<std::mutex> lock(queueMutex,std::try_to_lock);if(!lock.owns_lock())return;job=std::move(pending);}
    if(!job)return;int state=0;if(GetTickCount64()>job->deadline||!job->state.compare_exchange_strong(state,1)){job->state.store(3);SetEvent(job->completed);return;}
    try{job->response=job->expectedGeneration!=generation?failure(job->request["id"],"stale_id","Effects reloaded before this command; refresh the catalog."):execute(runtime,job->request);}catch(...){job->response=failure(job->request["id"],"internal_error","The bridge could not process this request.");}
    publishStatus(runtime);job->state.store(2);SetEvent(job->completed);
}
static json dispatch(const std::string& line){
    // Bound nesting before parsing untrusted JSON. Strings may contain braces.
    unsigned depth=0;bool quoted=false,escape=false;
    for(char c:line){if(quoted){if(escape)escape=false;else if(c=='\\')escape=true;else if(c=='"')quoted=false;}else if(c=='"')quoted=true;else if(c=='{'||c=='['){if(++depth>8)return failure(nullptr,"invalid_request","JSON nesting is too deep.");}else if((c=='}'||c==']')&&depth)depth--;}
    json request=json::parse(line,nullptr,false);if(request.is_discarded()||!request.is_object()||!request.contains("id")||!request["id"].is_number_integer()||!stringField(request,"action",32))return failure(nullptr,"invalid_request","Expected an integer id and supported action.");
    const std::string action=request["action"];if(action=="status"){std::lock_guard<std::mutex> lock(snapshotMutex);return success(request["id"],snapshot);}
    if(action!="catalog"&&action!="uniforms"&&action!="setTechnique"&&action!="setUniform"&&action!="setEnabled"&&action!="savePreset")return failure(request["id"],"unknown_action","This action is not supported.");
    auto job=std::make_shared<Job>();job->request=std::move(request);if(!job->completed)return failure(job->request["id"],"resource_error","Unable to queue a request.");
    {std::lock_guard<std::mutex> lock(snapshotMutex);job->expectedGeneration=snapshot.value("generation",uint64_t(0));}
    {std::lock_guard<std::mutex> lock(queueMutex);if(pending)return failure(job->request["id"],"busy","Another request is pending.");pending=job;}
    WaitForSingleObject(job->completed,2500);
    if(job->state.load()==2)return job->response;
    int queued=0;job->state.compare_exchange_strong(queued,3);
    if(queued==2)return job->response;
    if(queued==1){ // An API call began within the deadline. Allow it to finish.
        if(WaitForSingleObject(job->completed,1000)==WAIT_OBJECT_0&&job->state.load()==2)return job->response;
        return failure(job->request["id"],"result_pending","The operation started; refresh its state before retrying.");
    }
    {std::lock_guard<std::mutex> lock(queueMutex);if(pending==job)pending.reset();}
    return failure(job->request["id"],"runtime_timeout","No game frame was available; the queued operation was cancelled.");
}
static bool pipeIo(HANDLE pipe,bool writing,void* data,DWORD length,DWORD& transferred,DWORD timeout=5000){
    OVERLAPPED ov={};ov.hEvent=CreateEventW(nullptr,TRUE,FALSE,nullptr);if(!ov.hEvent)return false;
    BOOL ok=writing?WriteFile(pipe,data,length,&transferred,&ov):ReadFile(pipe,data,length,&transferred,&ov);
    if(!ok&&GetLastError()==ERROR_IO_PENDING){if(WaitForSingleObject(ov.hEvent,timeout)==WAIT_OBJECT_0)ok=GetOverlappedResult(pipe,&ov,&transferred,FALSE);else{CancelIoEx(pipe,&ov);GetOverlappedResult(pipe,&ov,&transferred,TRUE);ok=FALSE;}}
    CloseHandle(ov.hEvent);return ok!=FALSE;
}
static DWORD WINAPI server(void*){
    // Add-on installation/removal requires restarting the game. Pinning prevents
    // any worker from executing code after an attempted live FreeLibrary.
    HANDLE token=nullptr;if(!OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY,&token))return 0;DWORD bytes=0;GetTokenInformation(token,TokenUser,nullptr,0,&bytes);std::vector<char> info(bytes);
    if(!GetTokenInformation(token,TokenUser,info.data(),bytes,&bytes)){CloseHandle(token);return 0;}CloseHandle(token);
    LPWSTR sid=nullptr;if(!ConvertSidToStringSidW(((TOKEN_USER*)info.data())->User.Sid,&sid))return 0;
    std::wstring sddl=L"D:P(A;;GA;;;";sddl+=sid;sddl+=L")";LocalFree(sid);PSECURITY_DESCRIPTOR descriptor=nullptr;
    if(!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(),SDDL_REVISION_1,&descriptor,nullptr))return 0;
    SECURITY_ATTRIBUTES sa={sizeof(sa),descriptor,FALSE};wchar_t name[128];swprintf_s(name,L"\\\\.\\pipe\\ChartsHub-ReShade-%lu",GetCurrentProcessId());
    HANDLE pipe=CreateNamedPipeW(name,PIPE_ACCESS_DUPLEX|FILE_FLAG_OVERLAPPED|FILE_FLAG_FIRST_PIPE_INSTANCE,PIPE_TYPE_BYTE|PIPE_READMODE_BYTE|PIPE_WAIT|PIPE_REJECT_REMOTE_CLIENTS,1,65536,65536,5000,&sa);LocalFree(descriptor);if(pipe==INVALID_HANDLE_VALUE)return 0;
    for(;;){
        OVERLAPPED connection={};connection.hEvent=CreateEventW(nullptr,TRUE,FALSE,nullptr);BOOL connected=ConnectNamedPipe(pipe,&connection);DWORD code=GetLastError();
        if(!connected&&code==ERROR_PIPE_CONNECTED)connected=TRUE;else if(!connected&&code==ERROR_IO_PENDING){WaitForSingleObject(connection.hEvent,INFINITE);DWORD count;connected=GetOverlappedResult(pipe,&connection,&count,FALSE);}CloseHandle(connection.hEvent);
        if(connected){
            std::string input;char chunk[4096];bool active=true;
            while(active){DWORD received=0;if(!pipeIo(pipe,false,chunk,sizeof(chunk),received)||!received)break;input.append(chunk,received);if(input.size()>maxRequest){active=false;break;}
                size_t newline;while((newline=input.find('\n'))!=std::string::npos){
                    std::string line=input.substr(0,newline);input.erase(0,newline+1);std::string output;
                    try{json answer=dispatch(line);output=answer.dump(-1,' ',false,json::error_handler_t::replace);if(output.size()>maxResponse)output=failure(answer["id"],"response_limit","The response exceeds the safe size limit.").dump();output+='\n';}
                    catch(...){output=failure(nullptr,"internal_error","The bridge could not serialize this request.").dump()+"\n";}
                    size_t sent=0;while(sent<output.size()){DWORD written=0;if(!pipeIo(pipe,true,output.data()+sent,(DWORD)(output.size()-sent),written)||!written){active=false;break;}sent+=written;}
                    if(!active)break;
                }
            }
        }
        CancelIoEx(pipe,nullptr);DisconnectNamedPipe(pipe);
    }
}
extern "C" __declspec(dllexport) bool AddonInit(HMODULE module,HMODULE reshadeModule){
        std::lock_guard<std::recursive_mutex> guard(runtimeMutex);
        wchar_t exe[32768]={};GetModuleFileNameW(nullptr,exe,32768);const wchar_t* name=wcsrchr(exe,L'\\');name=name?name+1:exe;
        if(_wcsicmp(name,L"Clone Hero.exe")&&_wcsicmp(name,L"chartshub-reshade-test.exe"))return FALSE;
        int count=WideCharToMultiByte(CP_UTF8,0,exe,-1,nullptr,0,nullptr,nullptr);std::vector<char> text(count);WideCharToMultiByte(CP_UTF8,0,exe,-1,text.data(),count,nullptr,nullptr);executablePath=text.data();
        moduleHandle=module;if(!reshade::register_addon(module,reshadeModule))return false;
        activeRuntime=nullptr;invalidate();publishDisconnected();reshade::register_event<reshade::addon_event::init_effect_runtime>(onInit);reshade::register_event<reshade::addon_event::destroy_effect_runtime>(onDestroy);reshade::register_event<reshade::addon_event::reshade_reloaded_effects>(onReload);reshade::register_event<reshade::addon_event::reshade_present>(onPresent);
        HMODULE pinned;if(!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS|GET_MODULE_HANDLE_EX_FLAG_PIN,(LPCWSTR)&server,&pinned)){reshade::unregister_addon(module,reshadeModule);return false;}
        if(!workerStarted.exchange(true)){HANDLE thread=CreateThread(nullptr,0,server,nullptr,0,nullptr);if(!thread){workerStarted.store(false);reshade::unregister_addon(module,reshadeModule);return false;}CloseHandle(thread);}
        return true;
}
extern "C" __declspec(dllexport) void AddonUninit(HMODULE module,HMODULE reshadeModule){std::lock_guard<std::recursive_mutex> guard(runtimeMutex);activeRuntime=nullptr;invalidate();cancelPending();publishDisconnected();reshade::unregister_addon(module,reshadeModule);}
BOOL WINAPI DllMain(HINSTANCE module,DWORD reason,LPVOID){if(reason==DLL_PROCESS_ATTACH)DisableThreadLibraryCalls(module);return TRUE;}
