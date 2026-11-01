#pragma once
#include "vst-host.h"
#include <audioclient.h>
#include <mmdeviceapi.h>
#include <mmsystem.h>
#include <xinput.h>
namespace ch {
Json devices();
// Capabilities are only queried by devices(). GetState is used only after an
// explicit start with source=xinput. No hooks, keyboard listeners or drivers.
class Engine {
public:
  explicit Engine(VstHost &host) : host(host) {}
  ~Engine() {
    stop();
  }
  Json start(const Settings &);
  void stop();
  void panic();
  void note(const std::string &, int);
  bool running() const {
    return active.load();
  }
  Levels levels() const {
    return {left.load(), right.load()};
  }
  std::string takeError();

private:
  VstHost &host;
  Settings config;
  ComPtr<IAudioClient> client;
  ComPtr<IAudioRenderClient> render;
  WAVEFORMATEX *format = nullptr;
  UINT32 capacity = 0;
  int block = 128, rate = 48000;
  bool floatFormat = true;
  int bits = 32;
  HANDLE ready = nullptr, exitEvent = nullptr;
  HMIDIIN midi = nullptr;
  std::thread worker;
  std::atomic<bool> active{false}, acceptMidi{false};
  std::atomic<float> left{0}, right{0};
  std::mutex mutex;
  std::deque<Note> pending;
  std::vector<std::pair<Clock::time_point, Note>> releases;
  std::string error;
  std::array<bool, 32> previous{};
  bool havePrevious = false;
  void loop();
  void enqueue(Note);
  void captureXInput();
  static void CALLBACK midiCallback(HMIDIIN, UINT, DWORD_PTR, DWORD_PTR, DWORD_PTR);
};
} // namespace ch
