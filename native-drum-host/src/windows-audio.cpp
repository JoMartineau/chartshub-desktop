#include "windows-audio.h"
#include <functiondiscoverykeys_devpkey.h>
#include <iomanip>
#include <mmreg.h>
#include <sstream>
namespace ch {
namespace {
struct XInput {
  using Cap = DWORD(WINAPI *)(DWORD, DWORD, XINPUT_CAPABILITIES *);
  using State = DWORD(WINAPI *)(DWORD, XINPUT_STATE *);
  HMODULE library = nullptr;
  Cap capabilities = nullptr;
  State state = nullptr;
  XInput() {
    for (auto name : {L"xinput1_4.dll", L"xinput1_3.dll", L"xinput9_1_0.dll"})
      if ((library = LoadLibraryExW(name, nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32))) {
        capabilities = reinterpret_cast<Cap>(GetProcAddress(library, "XInputGetCapabilities"));
        state = reinterpret_cast<State>(GetProcAddress(library, "XInputGetState"));
        if (capabilities && state)
          break;
        FreeLibrary(library);
        library = nullptr;
      }
  }
  ~XInput() {
    if (library)
      FreeLibrary(library);
  }
};
std::string idFor(const std::wstring &id) {
  uint64_t h = 14695981039346656037ull;
  for (auto c : id) {
    h ^= static_cast<uint16_t>(c);
    h *= 1099511628211ull;
  }
  std::ostringstream s;
  s << std::hex << std::setfill('0') << std::setw(16) << h;
  return s.str();
}
ComPtr<IMMDeviceEnumerator> enumerator() {
  ComPtr<IMMDeviceEnumerator> e;
  hr(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&e)),
     "audio_enumeration_failed");
  return e;
}
std::wstring deviceId(IMMDevice *d) {
  LPWSTR value = nullptr;
  hr(d->GetId(&value), "audio_identity_failed");
  std::wstring id = value;
  CoTaskMemFree(value);
  return id;
}
ComPtr<IMMDevice> findDevice(const std::string &id) {
  auto e = enumerator();
  ComPtr<IMMDevice> d;
  if (id == "default") {
    hr(e->GetDefaultAudioEndpoint(eRender, eConsole, &d), "no_default_audio_device");
    return d;
  }
  ComPtr<IMMDeviceCollection> list;
  hr(e->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, &list), "audio_enumeration_failed");
  UINT n = 0;
  list->GetCount(&n);
  for (UINT i = 0; i < n && i < 256; i++) {
    list->Item(i, &d);
    if (idFor(deviceId(d.Get())) == id)
      return d;
    d.Reset();
  }
  throw std::runtime_error("audio_device_disconnected");
}
ComPtr<IAudioClient> audioClient(IMMDevice *device) {
  ComPtr<IAudioClient> c;
  hr(device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr,
                      reinterpret_cast<void **>(c.GetAddressOf())),
     "audio_device_unavailable");
  return c;
}
bool isFloat(const WAVEFORMATEX *f) {
  return f->wFormatTag == WAVE_FORMAT_IEEE_FLOAT ||
         (f->wFormatTag == WAVE_FORMAT_EXTENSIBLE &&
          reinterpret_cast<const WAVEFORMATEXTENSIBLE *>(f)->SubFormat ==
              KSDATAFORMAT_SUBTYPE_IEEE_FLOAT);
}
float axis(SHORT n, bool invert = false) {
  float v = n < 0 ? n / 32768.f : n / 32767.f;
  return invert ? -v : v;
}
bool bindingDown(const Pad &p, const XINPUT_GAMEPAD &g, bool was) {
  constexpr WORD masks[] = {XINPUT_GAMEPAD_A,
                            XINPUT_GAMEPAD_B,
                            XINPUT_GAMEPAD_X,
                            XINPUT_GAMEPAD_Y,
                            XINPUT_GAMEPAD_LEFT_SHOULDER,
                            XINPUT_GAMEPAD_RIGHT_SHOULDER,
                            0,
                            0,
                            XINPUT_GAMEPAD_BACK,
                            XINPUT_GAMEPAD_START,
                            XINPUT_GAMEPAD_LEFT_THUMB,
                            XINPUT_GAMEPAD_RIGHT_THUMB,
                            XINPUT_GAMEPAD_DPAD_UP,
                            XINPUT_GAMEPAD_DPAD_DOWN,
                            XINPUT_GAMEPAD_DPAD_LEFT,
                            XINPUT_GAMEPAD_DPAD_RIGHT,
                            0};
  if (p.kind == "none")
    return false;
  if (p.kind == "button") {
    if (p.index == 6)
      return g.bLeftTrigger > (was ? 65 : 100);
    if (p.index == 7)
      return g.bRightTrigger > (was ? 65 : 100);
    return (g.wButtons & masks[p.index]) != 0;
  }
  float axes[] = {axis(g.sThumbLX), axis(g.sThumbLY, true), axis(g.sThumbRX),
                  axis(g.sThumbRY, true)};
  return axes[p.index] * p.direction > (was ? .35f : .55f);
}
} // namespace
Json devices() {
  Json audio = Json::array(), midi = Json::array(), xinput = Json::array();
  auto e = enumerator();
  ComPtr<IMMDevice> def;
  std::wstring defaultId;
  if (SUCCEEDED(e->GetDefaultAudioEndpoint(eRender, eConsole, &def)))
    defaultId = deviceId(def.Get());
  ComPtr<IMMDeviceCollection> collection;
  hr(e->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, &collection), "audio_enumeration_failed");
  UINT count = 0;
  collection->GetCount(&count);
  for (UINT i = 0; i < count && i < 256; i++) {
    ComPtr<IMMDevice> device;
    collection->Item(i, &device);
    auto id = deviceId(device.Get());
    std::string name = "Audio output";
    ComPtr<IPropertyStore> properties;
    if (SUCCEEDED(device->OpenPropertyStore(STGM_READ, &properties))) {
      PROPVARIANT value;
      PropVariantInit(&value);
      if (SUCCEEDED(properties->GetValue(PKEY_Device_FriendlyName, &value)) &&
          value.vt == VT_LPWSTR)
        name = utf8(value.pwszVal).substr(0, 256);
      PropVariantClear(&value);
    }
    Json item = {{"id", idFor(id)},     {"name", name},      {"isDefault", id == defaultId},
                 {"sampleRate", 48000}, {"minBlockSize", 0}, {"defaultBlockSize", 0}};
    try {
      auto client = audioClient(device.Get());
      WAVEFORMATEX *f = nullptr;
      if (SUCCEEDED(client->GetMixFormat(&f))) {
        item["sampleRate"] = f->nSamplesPerSec;
        ComPtr<IAudioClient3> c3;
        if (SUCCEEDED(client.As(&c3))) {
          UINT32 normal = 0, fundamental = 0, min = 0, max = 0;
          if (SUCCEEDED(c3->GetSharedModeEnginePeriod(f, &normal, &fundamental, &min, &max))) {
            item["minBlockSize"] = min;
            item["defaultBlockSize"] = normal;
          }
        }
        CoTaskMemFree(f);
      }
    } catch (const std::exception &) {
    }
    audio.push_back(item);
  }
  for (UINT i = 0; i < midiInGetNumDevs() && i < 256; i++) {
    MIDIINCAPSW caps{};
    if (midiInGetDevCapsW(i, &caps, sizeof caps) == MMSYSERR_NOERROR)
      midi.push_back({{"id", i}, {"name", utf8(caps.szPname)}});
  }
  XInput api;
  if (api.capabilities)
    for (DWORD i = 0; i < 4; i++) {
      XINPUT_CAPABILITIES caps{};
      if (api.capabilities(i, 0, &caps) == ERROR_SUCCESS)
        xinput.push_back(
            {{"id", i}, {"index", i}, {"name", "Windows controller " + std::to_string(i + 1)}});
    }
  return {{"audio", audio}, {"midi", midi}, {"xinput", xinput}};
}
Json Engine::start(const Settings &settings) {
  stop();
  require(host.loaded(), "plugin_not_loaded");
  config = settings;
  try {
    auto device = findDevice(config.audioId);
    client = audioClient(device.Get());
    hr(client->GetMixFormat(&format), "audio_format_unavailable");
    require(format->nChannels >= 1 && format->nChannels <= 32 && format->nSamplesPerSec >= 8000 &&
                format->nSamplesPerSec <= 192000,
            "unsupported_audio_format");
    // Prefer the requested rate when the shared endpoint accepts it. Otherwise
    // report its actual mix format; silently lying about 128/48000 is unsafe.
    WAVEFORMATEXTENSIBLE preferred{};
    preferred.Format.wFormatTag = WAVE_FORMAT_EXTENSIBLE;
    preferred.Format.nChannels = format->nChannels;
    preferred.Format.nSamplesPerSec = config.rate;
    preferred.Format.wBitsPerSample = 32;
    preferred.Format.nBlockAlign = preferred.Format.nChannels * 4;
    preferred.Format.nAvgBytesPerSec = config.rate * preferred.Format.nBlockAlign;
    preferred.Format.cbSize = 22;
    preferred.Samples.wValidBitsPerSample = 32;
    preferred.dwChannelMask = format->nChannels == 2 ? 3 : 0;
    preferred.SubFormat = KSDATAFORMAT_SUBTYPE_IEEE_FLOAT;
    WAVEFORMATEX *closest = nullptr;
    HRESULT supported =
        client->IsFormatSupported(AUDCLNT_SHAREMODE_SHARED, &preferred.Format, &closest);
    if (closest)
      CoTaskMemFree(closest);
    if (supported == S_OK) {
      CoTaskMemFree(format);
      format = static_cast<WAVEFORMATEX *>(CoTaskMemAlloc(sizeof preferred));
      require(format != nullptr, "out_of_memory");
      memcpy(format, &preferred, sizeof preferred);
    }
    rate = static_cast<int>(format->nSamplesPerSec);
    bits = format->wBitsPerSample;
    floatFormat = isFloat(format);
    require((floatFormat && (bits == 32 || bits == 64)) ||
                (!floatFormat && (bits == 16 || bits == 24 || bits == 32)),
            "unsupported_audio_format");
    ready = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    exitEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    require(ready && exitEvent, "audio_event_failed");
    ComPtr<IAudioClient3> c3;
    HRESULT initialized = E_NOINTERFACE;
    if (SUCCEEDED(client.As(&c3))) {
      UINT32 normal = 0, fundamental = 0, min = 0, max = 0;
      if (SUCCEEDED(c3->GetSharedModeEnginePeriod(format, &normal, &fundamental, &min, &max)) &&
          fundamental) {
        UINT32 desired = std::clamp(static_cast<UINT32>(config.block), min, max);
        desired = ((desired + fundamental - 1) / fundamental) * fundamental;
        desired = std::min(desired, max);
        initialized = c3->InitializeSharedAudioStream(AUDCLNT_STREAMFLAGS_EVENTCALLBACK, desired,
                                                      format, nullptr);
        block = static_cast<int>(desired);
      }
    }
    if (FAILED(initialized)) {
      // A locked shared period/format can be negotiated by the legacy shared
      // initializer. It remains shared, never seizes Clone Hero's endpoint.
      client.Reset();
      client = audioClient(device.Get());
      CoTaskMemFree(format);
      format = nullptr;
      hr(client->GetMixFormat(&format), "audio_format_unavailable");
      rate = static_cast<int>(format->nSamplesPerSec);
      bits = format->wBitsPerSample;
      floatFormat = isFloat(format);
      hr(client->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_EVENTCALLBACK, 0, 0,
                            format, nullptr),
         "shared_audio_start_failed");
      REFERENCE_TIME normal = 0;
      client->GetDevicePeriod(&normal, nullptr);
      block = static_cast<int>((normal * rate + 9999999) / 10000000);
    }
    require(format->nChannels >= 1 && format->nChannels <= 32 && rate >= 8000 && rate <= 192000 &&
                ((floatFormat && (bits == 32 || bits == 64)) ||
                 (!floatFormat && (bits == 16 || bits == 24 || bits == 32))),
            "unsupported_audio_format");
    hr(client->GetBufferSize(&capacity), "audio_buffer_failed");
    require(capacity > 0 && capacity <= 16384, "unsupported_audio_buffer");
    hr(client->SetEventHandle(ready), "audio_event_failed");
    hr(client->GetService(IID_PPV_ARGS(&render)), "audio_render_failed");
    host.prepare(rate, static_cast<int>(capacity));
    previous = {};
    havePrevious = false;
    left = 0;
    right = 0;
    if (config.source == "midi") {
      require(config.midiId >= 0 && static_cast<UINT>(config.midiId) < midiInGetNumDevs(),
              "midi_device_unavailable");
      require(midiInOpen(&midi, static_cast<UINT>(config.midiId),
                         reinterpret_cast<DWORD_PTR>(&midiCallback),
                         reinterpret_cast<DWORD_PTR>(this),
                         CALLBACK_FUNCTION | MIDI_IO_STATUS) == MMSYSERR_NOERROR,
              "midi_device_busy");
      acceptMidi = true;
      require(midiInStart(midi) == MMSYSERR_NOERROR, "midi_start_failed");
    }
    if (config.source == "xinput") {
      XInput api;
      require(api.capabilities && api.state, "xinput_unavailable");
      XINPUT_CAPABILITIES caps{};
      require(api.capabilities(config.xinputIndex, 0, &caps) == ERROR_SUCCESS,
              "controller_disconnected");
    }
    active = true;
    worker = std::thread([this] { loop(); });
    hr(client->Start(), "audio_start_failed");
    REFERENCE_TIME latency = 0;
    client->GetStreamLatency(&latency);
    return {{"running", true},
            {"source", config.source},
            {"audio",
             {{"sampleRate", rate},
              {"blockSize", block},
              {"latencyMs", latency / 10000.0 + host.latency() * 1000.0 / rate},
              {"latencyKind", "reported"},
              {"exclusive", false}}}};
  } catch (...) {
    stop();
    throw;
  }
}
void Engine::stop() {
  acceptMidi = false;
  if (midi) {
    midiInStop(midi);
    midiInReset(midi);
    midiInClose(midi);
    midi = nullptr;
  }
  active = false;
  if (exitEvent)
    SetEvent(exitEvent);
  if (worker.joinable())
    worker.join();
  if (client)
    client->Stop();
  host.finish();
  render.Reset();
  client.Reset();
  if (format) {
    CoTaskMemFree(format);
    format = nullptr;
  }
  if (ready) {
    CloseHandle(ready);
    ready = nullptr;
  }
  if (exitEvent) {
    CloseHandle(exitEvent);
    exitEvent = nullptr;
  }
  std::lock_guard<std::mutex> lock(mutex);
  pending.clear();
  releases.clear();
  previous = {};
  havePrevious = false;
  left = 0;
  right = 0;
}
void Engine::panic() {
  std::lock_guard<std::mutex> lock(mutex);
  pending.clear();
  releases.clear();
  host.panic();
}
void Engine::enqueue(Note note) {
  std::lock_guard<std::mutex> lock(mutex);
  if (pending.size() >= 1024) {
    pending.clear();
    releases.clear();
    host.panic();
    return;
  }
  pending.push_back(note);
}
void Engine::note(const std::string &id, int velocity) {
  require(running(), "audio_not_running");
  auto pad = std::find_if(config.pads.begin(), config.pads.end(),
                          [&](const Pad &p) { return p.id == id; });
  require(pad != config.pads.end(), "unknown_pad");
  Note n{pad->note, pad->channel, velocity, true};
  std::lock_guard<std::mutex> lock(mutex);
  require(pending.size() < 1024 && releases.size() < 1024, "note_queue_full");
  pending.push_back(n);
  n.on = false;
  n.velocity = 0;
  releases.push_back({Clock::now() + std::chrono::milliseconds(100), n});
}
void CALLBACK Engine::midiCallback(HMIDIIN, UINT message, DWORD_PTR owner, DWORD_PTR packed,
                                   DWORD_PTR) {
  auto *self = reinterpret_cast<Engine *>(owner);
  if (!self->acceptMidi.load())
    return;
  if (message == MIM_CLOSE) {
    std::lock_guard<std::mutex> lock(self->mutex);
    self->error = "midi_device_disconnected";
    self->active = false;
    return;
  }
  if (message != MIM_DATA && message != MIM_MOREDATA)
    return;
  unsigned status = static_cast<unsigned>(packed) & 255u, kind = status & 240u,
           note = (static_cast<unsigned>(packed) >> 8) & 127u,
           velocity = (static_cast<unsigned>(packed) >> 16) & 127u;
  if (kind == 0x90 || kind == 0x80)
    self->enqueue({static_cast<int>(note), static_cast<int>(status & 15u),
                   static_cast<int>(velocity), kind == 0x90 && velocity > 0});
  else if (kind == 0xb0 && (note == 120 || note == 123))
    self->panic();
}
void Engine::captureXInput() {
  static XInput api;
  XINPUT_STATE state{};
  if (!api.state || api.state(config.xinputIndex, &state) != ERROR_SUCCESS)
    throw std::runtime_error("controller_disconnected");
  for (size_t i = 0; i < config.pads.size(); i++) {
    const auto &p = config.pads[i];
    bool down = bindingDown(p, state.Gamepad, previous[i]);
    if (havePrevious && down && !previous[i])
      note(p.id, p.velocity);
    previous[i] = down;
  }
  havePrevious = true;
}
void Engine::loop() {
  HRESULT com = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  std::vector<float> samples(capacity * 2);
  std::vector<Note> notes;
  notes.reserve(2048);
  HANDLE waits[] = {exitEvent, ready};
  try {
    while (active.load()) {
      DWORD wait = WaitForMultipleObjects(2, waits, FALSE, 20);
      if (wait == WAIT_OBJECT_0)
        break;
      require(wait != WAIT_FAILED, "audio_wait_failed");
      if (config.source == "xinput")
        captureXInput();
      if (wait == WAIT_TIMEOUT)
        continue;
      UINT32 padding = 0;
      hr(client->GetCurrentPadding(&padding), "audio_device_disconnected");
      require(padding <= capacity, "invalid_audio_padding");
      UINT32 frames = capacity - padding;
      if (!frames)
        continue;
      notes.clear();
      {
        std::lock_guard<std::mutex> lock(mutex);
        auto now = Clock::now();
        for (auto i = releases.begin(); i != releases.end();)
          if (i->first <= now) {
            pending.push_back(i->second);
            i = releases.erase(i);
          } else
            ++i;
        while (!pending.empty() && notes.size() < 2048) {
          notes.push_back(pending.front());
          pending.pop_front();
        }
      }
      auto level = host.process(static_cast<int>(frames), notes, samples.data(), config.volume);
      left = level.left;
      right = level.right;
      BYTE *output = nullptr;
      hr(render->GetBuffer(frames, &output), "audio_render_failed");
      for (UINT32 i = 0; i < frames; i++)
        for (WORD c = 0; c < format->nChannels; c++) {
          float value = c < 2 ? samples[i * 2 + c] : 0;
          BYTE *dest = output + i * format->nBlockAlign + c * (bits / 8);
          if (floatFormat && bits == 32)
            memcpy(dest, &value, 4);
          else if (floatFormat && bits == 64) {
            double v = value;
            memcpy(dest, &v, 8);
          } else if (bits == 16) {
            int16_t v = static_cast<int16_t>(value * 32767);
            memcpy(dest, &v, 2);
          } else {
            int32_t v = static_cast<int32_t>(value * 2147483647.0);
            if (bits == 24) {
              dest[0] = static_cast<BYTE>(v >> 8);
              dest[1] = static_cast<BYTE>(v >> 16);
              dest[2] = static_cast<BYTE>(v >> 24);
            } else
              memcpy(dest, &v, 4);
          }
        }
      hr(render->ReleaseBuffer(frames, 0), "audio_release_failed");
    }
  } catch (const std::exception &e) {
    std::lock_guard<std::mutex> lock(mutex);
    error = e.what();
    active = false;
    host.panic();
  }
  left = 0;
  right = 0;
  if (SUCCEEDED(com))
    CoUninitialize();
}
std::string Engine::takeError() {
  std::lock_guard<std::mutex> lock(mutex);
  std::string result;
  result.swap(error);
  return result;
}
} // namespace ch
