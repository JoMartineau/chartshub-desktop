#include "vst-host.h"
#include "pluginterfaces/vst/ivstprocesscontext.h"
#include "pluginterfaces/vst/vstspeaker.h"
#include <filesystem>
using namespace Steinberg;
using namespace Steinberg::Vst;
namespace ch {
VstHost::VstHost() {
  PluginContextFactory::instance().setPluginContext(&application);
  PlugProvider::setErrorStream(&std::cerr);
  pendingParameters.reserve(512);
  controllerUpdates.reserve(512);
}
VstHost::~VstHost() {
  unload();
  PluginContextFactory::instance().setPluginContext(nullptr);
}
Json VstHost::load(const std::string &path, const std::string &classId) {
  unload();
  auto p = std::filesystem::path(wide(path));
  require(p.is_absolute() && path.rfind("\\\\", 0) != 0, "local_absolute_path_required");
  auto ext = p.extension().wstring();
  std::transform(ext.begin(), ext.end(), ext.begin(), towlower);
  require(ext == L".vst3" && std::filesystem::exists(p), "vst3_path_required");
  std::string error;
  module = VST3::Hosting::Module::create(path, error);
  require(module != nullptr, "plugin_load_failed");
  auto factory = module->getFactory();
  factory.setHostContext(&application);
  Json classes = Json::array();
  const auto infos = factory.classInfos();
  const VST3::Hosting::ClassInfo *selected = nullptr;
  for (const auto &i : infos)
    if (i.category() == kVstAudioEffectClass) {
      const auto id = i.ID().toString();
      classes.push_back(
          {{"id", id}, {"name", i.name().substr(0, 128)}, {"vendor", i.vendor().substr(0, 128)}});
      if ((classId.empty() && !selected) || classId == id)
        selected = &i;
      require(classes.size() <= 128, "too_many_plugin_classes");
    }
  require(selected != nullptr, "instrument_class_not_found");
  provider = std::make_unique<PlugProvider>(factory, *selected, true);
  require(provider->initialize(), "plugin_initialization_failed");
  component = provider->getComponentPtr();
  controller = provider->getControllerPtr();
  require(component != nullptr, "component_missing");
  require(component->queryInterface(IAudioProcessor::iid, reinterpret_cast<void **>(&processor)) ==
              kResultOk,
          "audio_processor_missing");
  require(component->getBusCount(kEvent, kInput) > 0, "plugin_has_no_midi_input");
  require(component->getBusCount(kAudio, kOutput) > 0 &&
              component->getBusCount(kAudio, kOutput) <= 32,
          "plugin_has_no_audio_output");
  for (auto direction : {kInput, kOutput}) {
    auto buses = component->getBusCount(kAudio, direction);
    require(buses >= 0 && buses <= 32, "too_many_audio_buses");
    int channels = 0;
    for (int b = 0; b < buses; b++) {
      BusInfo info{};
      require(component->getBusInfo(kAudio, direction, b, info) == kResultOk &&
                  info.channelCount >= 0 && info.channelCount <= 32,
              "unsupported_audio_bus");
      channels += info.channelCount;
    }
    require(channels <= 128, "too_many_audio_channels");
  }
  require(processor->canProcessSampleSize(kSample32) == kResultTrue,
          "float_processing_not_supported");
  if (controller)
    controller->setComponentHandler(this);
  bool hasEditor = false;
  if (controller) {
    auto candidate = owned(controller->createView(ViewType::kEditor));
    hasEditor = candidate && candidate->isPlatformTypeSupported(kPlatformTypeHWND) == kResultTrue;
  }
  return {{"name", selected->name().substr(0, 128)},
          {"vendor", selected->vendor().substr(0, 128)},
          {"classId", selected->ID().toString()},
          {"classes", classes},
          {"hasEditor", hasEditor}};
}
void VstHost::unload() {
  editor(false);
  finish();
  if (controller)
    controller->setComponentHandler(nullptr);
  processor.reset();
  controller.reset();
  component.reset();
  provider.reset();
  module.reset();
  std::lock_guard<std::mutex> lock(parameterMutex);
  pendingParameters.clear();
  controllerUpdates.clear();
}
void VstHost::prepare(int sampleRate, int maxBlock) {
  require(loaded(), "plugin_not_loaded");
  finish();
  rate = sampleRate;
  maximum = maxBlock;
  SpeakerArrangement stereo = SpeakerArr::kStereo;
  processor->setBusArrangements(nullptr, 0, &stereo, 1);
  for (int i = 0; i < component->getBusCount(kAudio, kInput); i++)
    component->activateBus(kAudio, kInput, i, false);
  for (int i = 0; i < component->getBusCount(kAudio, kOutput); i++)
    component->activateBus(kAudio, kOutput, i, i == 0);
  for (int i = 0; i < component->getBusCount(kEvent, kInput); i++)
    component->activateBus(kEvent, kInput, i, i == 0);
  ProcessSetup setup{kRealtime, kSample32, maxBlock, static_cast<double>(sampleRate)};
  require(processor->setupProcessing(setup) == kResultOk, "plugin_audio_setup_failed");
  require(data.prepare(*component, maxBlock, kSample32), "plugin_buffers_failed");
  data.inputEvents = &events;
  data.outputEvents = &outputEvents;
  data.inputParameterChanges = &inputParameters;
  data.outputParameterChanges = &outputParameters;
  require(component->setActive(true) == kResultOk, "plugin_activation_failed");
  if (processor->setProcessing(true) != kResultOk) {
    component->setActive(false);
    throw std::runtime_error("plugin_start_failed");
  }
  processing = true;
  position = 0;
  active = {};
  panicRequested = false;
  restartRequested = false;
}
void VstHost::finish() {
  if (processing) {
    panicRequested = true;
    std::array<float, 128> scratch{};
    try {
      process(std::min(maximum, 64), {}, scratch.data(), 0);
    } catch (...) {
    }
    processor->setProcessing(false);
    component->setActive(false);
  }
  processing = false;
  active = {};
  data.unprepare();
}
unsigned VstHost::latency() const {
  return processor ? processor->getLatencySamples() : 0;
}
void VstHost::panic() {
  panicRequested = true;
}
Levels VstHost::process(int frames, const std::vector<Note> &notes, float *stereo, double volume) {
  require(processing && frames > 0 && frames <= maximum, "invalid_process_state");
  require(!restartRequested.load(), "plugin_restart_required");
  events.clear();
  outputEvents.clear();
  inputParameters.clearQueue();
  outputParameters.clearQueue();
  for (int b = 0; b < data.numInputs; b++)
    for (int c = 0; c < data.inputs[b].numChannels; c++)
      std::fill_n(data.inputs[b].channelBuffers32[c], frames, 0.f);
  for (int b = 0; b < data.numOutputs; b++)
    for (int c = 0; c < data.outputs[b].numChannels; c++)
      std::fill_n(data.outputs[b].channelBuffers32[c], frames, 0.f);
  auto push = [&](int channel, int pitch, int velocity, bool on) {
    Event e{};
    e.busIndex = 0;
    e.sampleOffset = 0;
    e.flags = Event::kIsLive;
    if (on) {
      e.type = Event::kNoteOnEvent;
      e.noteOn.channel = static_cast<int16>(channel);
      e.noteOn.pitch = static_cast<int16>(pitch);
      e.noteOn.velocity = velocity / 127.f;
      e.noteOn.noteId = -1;
    } else {
      e.type = Event::kNoteOffEvent;
      e.noteOff.channel = static_cast<int16>(channel);
      e.noteOff.pitch = static_cast<int16>(pitch);
      e.noteOff.noteId = -1;
    }
    require(events.addEvent(e) == kResultOk, "event_queue_overflow");
    active[channel][pitch] = on;
  };
  if (panicRequested.exchange(false))
    for (int ch = 0; ch < 16; ch++)
      for (int n = 0; n < 128; n++)
        if (active[ch][n])
          push(ch, n, 0, false);
  for (const auto &n : notes) {
    if (n.on && active[n.channel][n.note])
      push(n.channel, n.note, 0, false);
    push(n.channel, n.note, n.velocity, n.on);
  }
  {
    std::lock_guard<std::mutex> lock(parameterMutex);
    for (const auto &p : pendingParameters) {
      int32 index = 0, point = 0;
      auto *queue = inputParameters.addParameterData(p.first, index);
      if (queue)
        queue->addPoint(0, p.second, point);
    }
    pendingParameters.clear();
  }
  ProcessContext context{};
  context.sampleRate = rate;
  context.projectTimeSamples = position;
  context.state = ProcessContext::kPlaying;
  data.processContext = &context;
  data.numSamples = frames;
  data.processMode = kRealtime;
  require(processor->process(data) == kResultOk, "plugin_processing_failed");
  position += frames;
  Levels levels;
  {
    std::lock_guard<std::mutex> lock(parameterMutex);
    for (int p = 0; p < outputParameters.getParameterCount() && controllerUpdates.size() < 512;
         p++) {
      auto *q = outputParameters.getParameterData(p);
      if (q && q->getPointCount()) {
        int32 offset = 0;
        double value = 0;
        if (q->getPoint(q->getPointCount() - 1, offset, value) == kResultOk &&
            std::isfinite(value) && value >= 0 && value <= 1)
          controllerUpdates.emplace_back(q->getParameterId(), value);
      }
    }
  }
  auto &bus = data.outputs[0];
  require(bus.numChannels >= 1, "invalid_plugin_output");
  for (int i = 0; i < frames; i++) {
    float l = bus.channelBuffers32[0][i], r = bus.channelBuffers32[bus.numChannels > 1 ? 1 : 0][i];
    l = std::isfinite(l) ? std::clamp(static_cast<float>(l * volume), -1.f, 1.f) : 0;
    r = std::isfinite(r) ? std::clamp(static_cast<float>(r * volume), -1.f, 1.f) : 0;
    stereo[i * 2] = l;
    stereo[i * 2 + 1] = r;
    levels.left = std::max(levels.left, std::abs(l));
    levels.right = std::max(levels.right, std::abs(r));
  }
  return levels;
}
void VstHost::pollController() {
  std::vector<std::pair<ParamID, double>> updates;
  {
    std::lock_guard<std::mutex> lock(parameterMutex);
    updates.swap(controllerUpdates);
    controllerUpdates.reserve(512);
  }
  if (controller)
    for (const auto &p : updates)
      controller->setParamNormalized(p.first, p.second);
}
tresult PLUGIN_API VstHost::queryInterface(const TUID interfaceId, void **obj) {
  if (!obj)
    return kInvalidArgument;
  *obj = nullptr;
  if (FUnknownPrivate::iidEqual(interfaceId, IComponentHandler::iid) ||
      FUnknownPrivate::iidEqual(interfaceId, FUnknown::iid))
    *obj = static_cast<IComponentHandler *>(this);
  else if (FUnknownPrivate::iidEqual(interfaceId, IPlugFrame::iid))
    *obj = static_cast<IPlugFrame *>(this);
  return *obj ? kResultOk : kNoInterface;
}
tresult PLUGIN_API VstHost::beginEdit(ParamID) {
  return kResultOk;
}
tresult PLUGIN_API VstHost::endEdit(ParamID) {
  return kResultOk;
}
tresult PLUGIN_API VstHost::performEdit(ParamID id, ParamValue value) {
  if (!std::isfinite(value) || value < 0 || value > 1)
    return kInvalidArgument;
  std::lock_guard<std::mutex> lock(parameterMutex);
  if (pendingParameters.size() >= 512)
    return kOutOfMemory;
  pendingParameters.emplace_back(id, value);
  return kResultOk;
}
tresult PLUGIN_API VstHost::restartComponent(int32 flags) {
  if (flags & (kReloadComponent | kIoChanged))
    restartRequested = true;
  return kResultOk;
}
LRESULT CALLBACK VstHost::windowProc(HWND hwnd, UINT msg, WPARAM w, LPARAM l) {
  if (msg == WM_CLOSE) {
    ShowWindow(hwnd, SW_HIDE);
    return 0;
  }
  return DefWindowProc(hwnd, msg, w, l);
}
void VstHost::editor(bool open) {
  if (!open) {
    if (view) {
      view->removed();
      view->setFrame(nullptr);
      view.reset();
    }
    if (editorWindow) {
      DestroyWindow(editorWindow);
      editorWindow = nullptr;
    }
    return;
  }
  require(controller != nullptr, "plugin_editor_unavailable");
  if (editorWindow) {
    ShowWindow(editorWindow, SW_SHOW);
    SetForegroundWindow(editorWindow);
    return;
  }
  view = owned(controller->createView(ViewType::kEditor));
  require(view != nullptr && view->isPlatformTypeSupported(kPlatformTypeHWND) == kResultTrue,
          "plugin_editor_unavailable");
  WNDCLASSW wc{};
  wc.lpfnWndProc = windowProc;
  wc.hInstance = GetModuleHandleW(nullptr);
  wc.lpszClassName = L"ChartsHubDrumPluginEditor";
  wc.hCursor = LoadCursor(nullptr, IDC_ARROW);
  RegisterClassW(&wc);
  ViewRect rect{};
  view->getSize(&rect);
  int width = std::clamp(rect.getWidth(), 200, 2048),
      height = std::clamp(rect.getHeight(), 120, 1600);
  RECT outer{0, 0, width, height};
  AdjustWindowRect(&outer, WS_OVERLAPPEDWINDOW, FALSE);
  editorWindow =
      CreateWindowW(wc.lpszClassName, L"ChartsHub — Drum instrument", WS_OVERLAPPEDWINDOW,
                    CW_USEDEFAULT, CW_USEDEFAULT, outer.right - outer.left,
                    outer.bottom - outer.top, nullptr, nullptr, wc.hInstance, nullptr);
  require(editorWindow != nullptr, "plugin_editor_window_failed");
  view->setFrame(this);
  if (view->attached(editorWindow, kPlatformTypeHWND) != kResultOk) {
    editor(false);
    throw std::runtime_error("plugin_editor_attach_failed");
  }
  ShowWindow(editorWindow, SW_SHOW);
}
tresult PLUGIN_API VstHost::resizeView(IPlugView *requested, ViewRect *rect) {
  if (!rect || requested != view || !editorWindow || rect->getWidth() < 100 ||
      rect->getWidth() > 2048 || rect->getHeight() < 100 || rect->getHeight() > 1600)
    return kInvalidArgument;
  RECT outer{0, 0, rect->getWidth(), rect->getHeight()};
  AdjustWindowRect(&outer, WS_OVERLAPPEDWINDOW, FALSE);
  SetWindowPos(editorWindow, nullptr, 0, 0, outer.right - outer.left, outer.bottom - outer.top,
               SWP_NOMOVE | SWP_NOZORDER);
  return view->onSize(rect);
}
} // namespace ch
