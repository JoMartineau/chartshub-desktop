// ChartsHub's offline test instrument. This plugin is never installed or
// shipped to users. Its deterministic signal is rendered only to RAM by tests.
#include "pluginterfaces/vst/ivstevents.h"
#include "pluginterfaces/vst/vstspeaker.h"
#include "public.sdk/source/main/pluginfactory.h"
#include "public.sdk/source/vst/vstaudioeffect.h"
#include "public.sdk/source/vst/vsteditcontroller.h"
#include <algorithm>
#include <array>
#include <cmath>
using namespace Steinberg;
using namespace Steinberg::Vst;
static const FUID processorId(0x402A0DB2, 0x47B94102, 0x8B12DE41, 0xDA204315);
static const FUID controllerId(0xB913B021, 0x331A44D5, 0xB3F188A0, 0xCD2B7217);
static const FUID notImplementedId(0x402A0DB2, 0x47B94102, 0x8B12DE41, 0xDA204316);
static const FUID falseResultId(0x402A0DB2, 0x47B94102, 0x8B12DE41, 0xDA204317);
static const FUID failureId(0x402A0DB2, 0x47B94102, 0x8B12DE41, 0xDA204318);
class TestInstrument final : public AudioEffect {
  std::array<std::array<float, 128>, 16> notes{};
  double phase = 0;
  tresult processingResult;

public:
  explicit TestInstrument(tresult result = kResultOk) : processingResult(result) {
    setControllerClass(controllerId);
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
END_FACTORY
