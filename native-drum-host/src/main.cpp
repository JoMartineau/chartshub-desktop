#include "windows-audio.h"
#include <condition_variable>
#include <fcntl.h>
#include <io.h>
namespace ch {
constexpr UINT commandMessage = WM_APP + 41, eofMessage = WM_APP + 42;
static void output(const Json &value) {
  const auto line = value.dump(-1, ' ', false, Json::error_handler_t::replace);
  require(line.size() <= 32768, "response_too_large");
  std::cout << line << '\n' << std::flush;
}
static bool preservesAudioAfterError(const std::string &command, const std::string &error) {
  // An optional editor is independent of the audio processor. All malformed
  // commands and all other plug-in/engine failures keep the fail-closed path.
  return command == "editor" && error == "plugin_editor_unavailable";
}
static Json defaultTestSettings() {
  return {
      {"version", 1},
      {"audioDeviceId", "default"},
      {"midiDeviceId", -1},
      {"source", "manual"},
      {"xinputIndex", 0},
      {"sampleRate", 48000},
      {"blockSize", 128},
      {"volume", .5},
      {"pads", Json::array({{{"id", "kick"},
                             {"note", 36},
                             {"channel", 9},
                             {"velocity", 100},
                             {"binding", {{"kind", "none"}, {"index", 0}, {"direction", 1}}}}})}};
}
static int selfTest(const std::string &plugin) {
  Json checks = Json::array();
  auto check = [&](bool ok, const char *name) {
    require(ok, name);
    checks.push_back(name);
  };
  auto s = settings(defaultTestSettings());
  check(s.source == "manual" && s.pads[0].note == 36, "settings_validated");
  auto invalid = defaultTestSettings();
  invalid["volume"] = 2;
  bool rejected = false;
  try {
    settings(invalid);
  } catch (...) {
    rejected = true;
  }
  check(rejected, "settings_out_of_range_rejected");
  invalid = defaultTestSettings();
  invalid["unexpected"] = true;
  rejected = false;
  try {
    settings(invalid);
  } catch (...) {
    rejected = true;
  }
  check(rejected, "unknown_settings_rejected");
  VstHost host;
  auto metadata = host.load(plugin);
  check(metadata["name"] == "ChartsHub Offline Test", "actual_vst3_module_loaded");
  host.prepare(48000, 512);
  std::array<float, 1024> audio{};
  auto silent = host.process(128, {}, audio.data(), 1);
  check(silent.left == 0 && silent.right == 0, "initial_silence");
  auto quiet = host.process(512, {{36, 9, 32, true}}, audio.data(), 1);
  check(quiet.left > 0 && quiet.left < .03f, "midi_velocity32_rendered");
  host.panic();
  auto panicked = host.process(128, {}, audio.data(), 1);
  check(panicked.left == 0, "panic_releases_notes");
  auto loud = host.process(512, {{36, 9, 127, true}}, audio.data(), 1);
  check(loud.left > .09f && loud.left > quiet.left * 3.5f, "midi_velocity_preserved");
  auto released = host.process(128, {{36, 9, 0, false}}, audio.data(), 1);
  check(released.left == 0, "note_off_silences_instrument");
  for (int i = 0; i < 100; i++)
    host.process(128, {}, audio.data(), 1);
  check(true, "continuous_offline_blocks");
  bool optionalEditorRejected = false;
  try {
    host.editor(true);
  } catch (const std::exception &error) {
    optionalEditorRejected = preservesAudioAfterError("editor", error.what());
    if (!optionalEditorRejected)
      host.finish();
  }
  check(optionalEditorRejected &&
            !preservesAudioAfterError("start", "plugin_editor_unavailable") &&
            !preservesAudioAfterError("editor", "invalid_request") &&
            host.process(512, {{36, 9, 100, true}}, audio.data(), 1).left > .07f,
        "optional_editor_failure_preserves_processing");
  host.finish();
  host.prepare(44100, 512);
  check(host.process(128, {}, audio.data(), 1).left == 0, "stop_restart_clears_notes");
  host.finish();
  host.unload();
  check(!host.loaded(), "module_lifecycle_unloaded");
  auto classId = [&](const std::string &name) {
    for (const auto &item : metadata["classes"])
      if (item["name"] == name)
        return item["id"].get<std::string>();
    throw std::runtime_error("synthetic_notification_class_missing");
  };
  host.load(plugin, classId("ChartsHub Notification NotImplemented"));
  host.prepare(48000, 512);
  check(host.process(512, {{36, 9, 100, true}}, audio.data(), 1).left > .07f,
        "not_implemented_notification_still_renders");
  host.finish();
  host.unload();
  int failures = 0;
  for (const auto &name : {"ChartsHub Notification False", "ChartsHub Notification Failure"}) {
    host.load(plugin, classId(name));
    try {
      host.prepare(48000, 512);
    } catch (const std::exception &error) {
      if (std::string(error.what()) == "plugin_start_failed")
        ++failures;
    }
    host.unload();
  }
  check(failures == 2, "real_processing_notification_failures_rejected");
  output({{"schema", 1},
          {"ok", true},
          {"mode", "offline-self-test"},
          {"checks", checks},
          {"audioDeviceOpened", false},
          {"midiDeviceOpened", false},
          {"xinputStateRead", false},
          {"gameRead", false},
          {"profileRead", false}});
  return 0;
}
int run() {
  VstHost host;
  Engine engine(host);
  DWORD mainThread = GetCurrentThreadId();
  MSG msg{};
  PeekMessage(&msg, nullptr, WM_USER, WM_USER, PM_NOREMOVE);
  const UINT_PTR hostTimer = SetTimer(nullptr, 0, 100, nullptr);
  require(hostTimer != 0, "host_timer_failed");
  std::mutex queueMutex;
  std::deque<std::string> queue;
  std::atomic<bool> read{true};
  std::thread reader([&] {
    std::string line;
    line.reserve(32768);
    bool tooLong = false;
    char c;
    while (read && std::cin.get(c)) {
      if (c == '\n') {
        if (tooLong) {
          PostThreadMessage(mainThread, eofMessage, 0, 0);
          break;
        }
        if (!line.empty() && line.back() == '\r')
          line.pop_back();
        if (!line.empty()) {
          std::lock_guard<std::mutex> lock(queueMutex);
          if (queue.size() >= 64) {
            PostThreadMessage(mainThread, eofMessage, 0, 0);
            break;
          }
          queue.push_back(std::move(line));
          PostThreadMessage(mainThread, commandMessage, 0, 0);
        }
        line.clear();
        line.reserve(32768);
      } else if (line.size() < 32768)
        line.push_back(c);
      else
        tooLong = true;
    }
    PostThreadMessage(mainThread, eofMessage, 0, 0);
  });
  output({{"schema", 1}, {"event", "status"}, {"phase", "stopped"}});
  bool quitting = false;
  while (!quitting && GetMessage(&msg, nullptr, 0, 0) > 0) {
    if (msg.message == commandMessage) {
      std::string line;
      {
        std::lock_guard<std::mutex> lock(queueMutex);
        if (queue.empty())
          continue;
        line = std::move(queue.front());
        queue.pop_front();
      }
      int id = 0;
      std::string command;
      try {
        auto request = Json::parse(line, [](int depth, Json::parse_event_t, Json &) {
          require(depth <= 16, "json_too_deep");
          return true;
        });
        keys(request, {"schema", "id", "command", "payload"});
        require(integer(request, "schema", 1, 1) == 1, "unsupported_schema");
        id = integer(request, "id", 1, 2147483647);
        command = string(request, "command", 16);
        require(request.contains("payload"), "missing_payload");
        const auto &p = request["payload"];
        Json result = Json::object();
        if (command == "devices") {
          keys(p, {});
          result = devices();
        } else if (command == "load") {
          keys(p, {"path", "classId"});
          require(!engine.running(), "stop_before_loading");
          auto path = string(p, "path", 2048);
          std::string cid = p.contains("classId") ? string(p, "classId", 32) : "";
          if (!cid.empty())
            require(cid.size() == 32 &&
                        std::all_of(
                            cid.begin(), cid.end(),
                            [](char c) { return std::isxdigit(static_cast<unsigned char>(c)); }),
                    "invalid_class_id");
          result = host.load(path, cid);
        } else if (command == "start") {
          result = engine.start(settings(p));
        } else if (command == "stop") {
          keys(p, {});
          engine.stop();
          result = {{"running", false}};
        } else if (command == "panic") {
          keys(p, {});
          engine.panic();
          result = {{"released", true}};
        } else if (command == "note") {
          keys(p, {"padId", "velocity"});
          auto pad = string(p, "padId", 32);
          int velocity = integer(p, "velocity", 1, 127);
          engine.note(pad, velocity);
        } else if (command == "editor") {
          keys(p, {"open"});
          require(p.contains("open") && p["open"].is_boolean(), "boolean_required");
          host.editor(p["open"].get<bool>());
        } else if (command == "quit") {
          keys(p, {});
          engine.stop();
          quitting = true;
        } else
          throw std::runtime_error("unknown_command");
        output({{"schema", 1}, {"id", id}, {"ok", true}, {"result", result}});
      } catch (const std::exception &e) {
        const bool preserveAudio = preservesAudioAfterError(command, e.what());
        if (!preserveAudio)
          engine.stop();
        if (id) {
          // A failed command may have stopped a running engine. Notify main
          // before its rejected promise can publish a stale running snapshot.
          if (!preserveAudio)
            output({{"schema", 1},
                    {"event", "status"},
                    {"phase", "error"},
                    {"error", std::string(e.what()).substr(0, 160)}});
          output({{"schema", 1},
                  {"id", id},
                  {"ok", false},
                  {"error", std::string(e.what()).substr(0, 160)}});
        } else {
          output({{"schema", 1},
                  {"event", "status"},
                  {"phase", "error"},
                  {"error", "invalid_request"}});
          quitting = true;
        }
      }
    } else if (msg.message == eofMessage) {
      quitting = true;
    } else if (msg.message == WM_TIMER && msg.hwnd == nullptr && msg.wParam == hostTimer) {
      // Consume only our thread timer. Plug-in HWND timers and unrelated
      // TimerProc callbacks must reach DispatchMessage to keep editor controls,
      // pad-release animations and settings windows responsive.
      host.pollController();
      auto error = engine.takeError();
      if (!error.empty()) {
        engine.stop();
        output({{"schema", 1},
                {"event", "status"},
                {"phase", "error"},
                {"error", error.substr(0, 160)}});
      } else if (engine.running()) {
        auto l = engine.levels();
        output({{"schema", 1}, {"event", "meter"}, {"left", l.left}, {"right", l.right}});
      }
    } else {
      TranslateMessage(&msg);
      DispatchMessage(&msg);
    }
  }
  KillTimer(nullptr, hostTimer);
  engine.stop();
  read = false;
  CancelSynchronousIo(reader.native_handle());
  if (reader.joinable())
    reader.join();
  return 0;
}
} // namespace ch
int wmain(int argc, wchar_t **argv) {
  SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX);
  _setmode(_fileno(stdin), _O_BINARY);
  _setmode(_fileno(stdout), _O_BINARY);
  auto com = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  if (FAILED(com))
    return 2;
  int exitCode = 0;
  try {
    if (argc == 3 && std::wstring(argv[1]) == L"--self-test")
      exitCode = ch::selfTest(ch::utf8(argv[2]));
    else if (argc == 2 && std::wstring(argv[1]) == L"--json")
      exitCode = ch::run();
    else
      throw std::runtime_error("expected_json_or_self_test");
  } catch (const std::exception &e) {
    std::cerr << e.what() << '\n';
    exitCode = 1;
  }
  CoUninitialize();
  return exitCode;
}
