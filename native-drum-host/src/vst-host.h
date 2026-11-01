#pragma once
#include "common.h"
#include "pluginterfaces/gui/iplugview.h"
#include "pluginterfaces/vst/ivsteditcontroller.h"
#include "public.sdk/source/vst/hosting/eventlist.h"
#include "public.sdk/source/vst/hosting/hostclasses.h"
#include "public.sdk/source/vst/hosting/module.h"
#include "public.sdk/source/vst/hosting/parameterchanges.h"
#include "public.sdk/source/vst/hosting/plugprovider.h"
#include "public.sdk/source/vst/hosting/processdata.h"
namespace ch {
class VstHost : public Steinberg::Vst::IComponentHandler, public Steinberg::IPlugFrame {
public:
  VstHost();
  ~VstHost();
  Json load(const std::string &path, const std::string &classId = {});
  void unload();
  bool loaded() const {
    return component != nullptr;
  }
  void prepare(int rate, int maximumBlock);
  void finish();
  Levels process(int frames, const std::vector<Note> &notes, float *stereo, double volume);
  void pollController();
  void editor(bool open);
  void panic();
  unsigned latency() const;
  Steinberg::tresult PLUGIN_API queryInterface(const Steinberg::TUID iid, void **obj) override;
  Steinberg::uint32 PLUGIN_API addRef() override {
    return 1;
  }
  Steinberg::uint32 PLUGIN_API release() override {
    return 1;
  }
  Steinberg::tresult PLUGIN_API beginEdit(Steinberg::Vst::ParamID) override;
  Steinberg::tresult PLUGIN_API performEdit(Steinberg::Vst::ParamID,
                                            Steinberg::Vst::ParamValue) override;
  Steinberg::tresult PLUGIN_API endEdit(Steinberg::Vst::ParamID) override;
  Steinberg::tresult PLUGIN_API restartComponent(Steinberg::int32) override;
  Steinberg::tresult PLUGIN_API resizeView(Steinberg::IPlugView *, Steinberg::ViewRect *) override;

private:
  Steinberg::Vst::HostApplication application;
  VST3::Hosting::Module::Ptr module;
  std::unique_ptr<Steinberg::Vst::PlugProvider> provider;
  Steinberg::IPtr<Steinberg::Vst::IComponent> component;
  Steinberg::IPtr<Steinberg::Vst::IEditController> controller;
  Steinberg::IPtr<Steinberg::Vst::IAudioProcessor> processor;
  Steinberg::IPtr<Steinberg::IPlugView> view;
  Steinberg::Vst::HostProcessData data;
  Steinberg::Vst::EventList events{4096}, outputEvents{4096};
  Steinberg::Vst::ParameterChanges inputParameters{512}, outputParameters{512};
  std::mutex parameterMutex;
  std::vector<std::pair<Steinberg::Vst::ParamID, double>> pendingParameters;
  std::vector<std::pair<Steinberg::Vst::ParamID, double>> controllerUpdates;
  std::array<std::array<bool, 128>, 16> active{};
  bool processing = false;
  int maximum = 0;
  int rate = 48000;
  int64_t position = 0;
  HWND editorWindow = nullptr;
  std::atomic<bool> panicRequested{false}, restartRequested{false};
  static LRESULT CALLBACK windowProc(HWND, UINT, WPARAM, LPARAM);
};
} // namespace ch
