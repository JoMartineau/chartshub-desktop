// ChartsHub's offline test instrument. This plugin is never installed or
// shipped to users. Its deterministic signal is rendered only to RAM by tests.
#include "pluginterfaces/vst/ivstevents.h"
#include "pluginterfaces/vst/vstspeaker.h"
#include "public.sdk/source/main/pluginfactory.h"
#include "public.sdk/source/vst/vstaudioeffect.h"
#include "public.sdk/source/vst/vsteditcontroller.h"
#include "public.sdk/source/common/pluginview.h"
#include <windows.h>
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <fstream>
using namespace Steinberg;
using namespace Steinberg::Vst;
static const FUID processorId(0x402A0DB2, 0x47B94102, 0x8B12DE41, 0xDA204315);
static const FUID controllerId(0xB913B021, 0x331A44D5, 0xB3F188A0, 0xCD2B7217);
static const FUID notImplementedId(0x402A0DB2, 0x47B94102, 0x8B12DE41, 0xDA204316);
static const FUID falseResultId(0x402A0DB2, 0x47B94102, 0x8B12DE41, 0xDA204317);
static const FUID failureId(0x402A0DB2, 0x47B94102, 0x8B12DE41, 0xDA204318);
static const FUID editorTimerId(0x402A0DB2, 0x47B94102, 0x8B12DE41, 0xDA204319);
static const FUID editorControllerId(0xB913B021, 0x331A44D5, 0xB3F188A0, 0xCD2B7218);
class TestInstrument final : public AudioEffect {
  std::array<std::array<float, 128>, 16> notes{};
  double phase = 0;
  tresult processingResult;

public:
  explicit TestInstrument(tresult result = kResultOk, bool timerEditor = false) : processingResult(result) {
    setControllerClass(timerEditor ? editorControllerId : controllerId);
  }
  static FUnknown *create(void *) {
    return static_cast<IAudioProcessor *>(new TestInstrument);
  }
  static FUnknown *createNotImplemented(void *) {
    return static_cast<IAudioProcessor *>(new TestInstrument(kNotImplemented));
  }
  static FUnknown *createFalse(void *) {
    return static_cast<IAudioProcessor *>(new TestInstrument(kResultFalse));
  }
  static FUnknown *createFailure(void *) {
    return static_cast<IAudioProcessor *>(new TestInstrument(kInternalError));
  }
  static FUnknown *createTimerEditor(void *) {
    return static_cast<IAudioProcessor *>(new TestInstrument(kResultOk, true));
  }
  tresult PLUGIN_API initialize(FUnknown *context) override {
    auto result = AudioEffect::initialize(context);
    if (result == kResultOk) {
      addAudioOutput(STR16("Stereo"), SpeakerArr::kStereo);
      addEventInput(STR16("Notes"));
    }
    return result;
  }
  tresult PLUGIN_API setActive(TBool state) override {
    notes = {};
    phase = 0;
    return AudioEffect::setActive(state);
  }
  tresult PLUGIN_API setProcessing(TBool) override {
    return processingResult;
  }
  tresult PLUGIN_API process(ProcessData &data) override {
    if (data.inputEvents)
      for (int i = 0; i < data.inputEvents->getEventCount(); i++) {
        Event e{};
        data.inputEvents->getEvent(i, e);
        if (e.type == Event::kNoteOnEvent && e.noteOn.channel >= 0 && e.noteOn.channel < 16 &&
            e.noteOn.pitch >= 0 && e.noteOn.pitch < 128)
          notes[e.noteOn.channel][e.noteOn.pitch] = e.noteOn.velocity;
        if (e.type == Event::kNoteOffEvent && e.noteOff.channel >= 0 && e.noteOff.channel < 16 &&
            e.noteOff.pitch >= 0 && e.noteOff.pitch < 128)
          notes[e.noteOff.channel][e.noteOff.pitch] = 0;
      }
    float amplitude = 0;
    for (const auto &channel : notes)
      for (float note : channel)
        amplitude += note * .1f;
    for (int b = 0; b < data.numOutputs; b++) {
      data.outputs[b].silenceFlags = amplitude == 0 ? ~uint64(0) : 0;
      for (int i = 0; i < data.numSamples; i++) {
        float v = static_cast<float>(std::sin(phase)) * amplitude;
        phase += 6.283185307179586 * 440 / processSetup.sampleRate;
        for (int c = 0; c < data.outputs[b].numChannels; c++)
          data.outputs[b].channelBuffers32[c][i] = v;
      }
    }
    return kResultOk;
  }
};
class TestController final : public EditController {
public:
  static FUnknown *create(void *) {
    return static_cast<IEditController *>(new TestController);
  }
};
// This owned, silent editor models two GUI behaviours used by real instruments:
// a clicked pad released by a window timer, and settings refreshed by timers.
// It never prepares a processor or opens an audio/input device.
class TimerView final : public CPluginView {
  HWND window = nullptr;
  UINT_PTR threadTimer = 0;
  int windowTicks = 0, threadTicks = 0, padClicks = 0, settingsRefreshes = 0;
  bool padPressed = false;
  std::string report;
  static TimerView *activeView;
  void writeState() {
    if (report.empty()) return;
    std::ofstream output(report, std::ios::trunc);
    output << "{\"windowTicks\":" << windowTicks << ",\"threadTicks\":" << threadTicks
           << ",\"padClicks\":" << padClicks << ",\"padPressed\":"
           << (padPressed ? "true" : "false") << ",\"settingsRefreshes\":"
           << settingsRefreshes << "}\n";
  }
  static LRESULT CALLBACK procedure(HWND hwnd, UINT message, WPARAM w, LPARAM l) {
    auto *self = reinterpret_cast<TimerView *>(GetWindowLongPtrW(hwnd, GWLP_USERDATA));
    if (message == WM_NCCREATE) {
      self = static_cast<TimerView *>(reinterpret_cast<CREATESTRUCTW *>(l)->lpCreateParams);
      SetWindowLongPtrW(hwnd, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(self));
    }
    if (self && message == WM_LBUTTONDOWN) {
      self->padClicks++; self->padPressed = true; self->writeState(); return 0;
    }
    if (self && message == WM_TIMER) {
      self->windowTicks++; self->settingsRefreshes++; self->padPressed = false;
      self->writeState(); return 0;
    }
    return DefWindowProcW(hwnd, message, w, l);
  }
  static void CALLBACK timerCallback(HWND, UINT, UINT_PTR id, DWORD) {
    if (activeView && activeView->threadTimer == id) {
      activeView->threadTicks++; activeView->writeState();
    }
  }
public:
  TimerView() { ViewRect size{0, 0, 320, 160}; setRect(size); }
  ~TimerView() override { removed(); }
  tresult PLUGIN_API isPlatformTypeSupported(FIDString type) override {
    return type && std::strcmp(type, kPlatformTypeHWND) == 0 ? kResultTrue : kResultFalse;
  }
  tresult PLUGIN_API attached(void *parent, FIDString type) override {
    if (!parent || isPlatformTypeSupported(type) != kResultTrue) return kResultFalse;
    char file[2048]{};
    if (GetEnvironmentVariableA("CHARTSHUB_SYNTHETIC_EDITOR_REPORT", file, sizeof(file)) > 0)
      report = file;
    WNDCLASSW wc{}; wc.lpfnWndProc = procedure; wc.hInstance = GetModuleHandleW(nullptr);
    wc.lpszClassName = L"ChartsHubSilentTimerFixture"; RegisterClassW(&wc);
    auto owner = static_cast<HWND>(parent);
    SetWindowLongPtrW(owner, GWL_EXSTYLE, GetWindowLongPtrW(owner, GWL_EXSTYLE) | WS_EX_NOACTIVATE);
    SetWindowPos(owner, nullptr, -32000, -32000, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
    window = CreateWindowW(wc.lpszClassName, L"Silent timer fixture", WS_CHILD | WS_VISIBLE,
                          0, 0, 320, 160, owner, nullptr, wc.hInstance, this);
    if (!window) return kResultFalse;
    activeView = this;
    // Deliberately use 1: a window timer must not be mistaken for the host's
    // requested thread-timer identifier, even if the numeric values coincide.
    SetTimer(window, 1, 25, nullptr);
    threadTimer = SetTimer(nullptr, 0, 35, timerCallback);
    writeState(); PostMessageW(window, WM_LBUTTONDOWN, MK_LBUTTON, 0);
    return CPluginView::attached(parent, type);
  }
  tresult PLUGIN_API removed() override {
    if (threadTimer) { KillTimer(nullptr, threadTimer); threadTimer = 0; }
    if (window) { KillTimer(window, 1); DestroyWindow(window); window = nullptr; }
    if (activeView == this) activeView = nullptr;
    return CPluginView::removed();
  }
};
TimerView *TimerView::activeView = nullptr;
class TimerController final : public EditController {
public:
  static FUnknown *create(void *) { return static_cast<IEditController *>(new TimerController); }
  IPlugView *PLUGIN_API createView(FIDString name) override {
    return name && std::strcmp(name, ViewType::kEditor) == 0 ? new TimerView : nullptr;
  }
};
BEGIN_FACTORY_DEF("ChartsHub", "https://chartshub.ca", "chartshub@hotmail.com")
DEF_CLASS2(INLINE_UID_FROM_FUID(processorId), PClassInfo::kManyInstances, kVstAudioEffectClass,
           "ChartsHub Offline Test", Vst::kDistributable, "Instrument|Drum", "0.1.0",
           kVstVersionString, TestInstrument::create)
DEF_CLASS2(INLINE_UID_FROM_FUID(controllerId), PClassInfo::kManyInstances,
           kVstComponentControllerClass, "ChartsHub Offline Test Controller", 0, "", "0.1.0",
           kVstVersionString, TestController::create)
DEF_CLASS2(INLINE_UID_FROM_FUID(notImplementedId), PClassInfo::kManyInstances, kVstAudioEffectClass,
           "ChartsHub Notification NotImplemented", Vst::kDistributable, "Instrument|Drum", "0.1.0",
           kVstVersionString, TestInstrument::createNotImplemented)
DEF_CLASS2(INLINE_UID_FROM_FUID(falseResultId), PClassInfo::kManyInstances, kVstAudioEffectClass,
           "ChartsHub Notification False", Vst::kDistributable, "Instrument|Drum", "0.1.0",
           kVstVersionString, TestInstrument::createFalse)
DEF_CLASS2(INLINE_UID_FROM_FUID(failureId), PClassInfo::kManyInstances, kVstAudioEffectClass,
           "ChartsHub Notification Failure", Vst::kDistributable, "Instrument|Drum", "0.1.0",
           kVstVersionString, TestInstrument::createFailure)
DEF_CLASS2(INLINE_UID_FROM_FUID(editorTimerId), PClassInfo::kManyInstances, kVstAudioEffectClass,
           "ChartsHub Editor Timers", Vst::kDistributable, "Instrument|Drum", "0.1.0",
           kVstVersionString, TestInstrument::createTimerEditor)
DEF_CLASS2(INLINE_UID_FROM_FUID(editorControllerId), PClassInfo::kManyInstances,
           kVstComponentControllerClass, "ChartsHub Timer Controller", 0, "", "0.1.0",
           kVstVersionString, TimerController::create)
END_FACTORY
