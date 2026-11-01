#pragma once
#include "json.hpp"
#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <deque>
#include <functional>
#include <iostream>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>
#include <windows.h>
#include <wrl/client.h>
namespace ch {
using Json = nlohmann::json;
using Clock = std::chrono::steady_clock;
using Microsoft::WRL::ComPtr;
inline void require(bool ok, const char *message) {
  if (!ok)
    throw std::runtime_error(message);
}
inline void hr(HRESULT value, const char *message) {
  if (FAILED(value))
    throw std::runtime_error(message);
}
inline std::wstring wide(const std::string &text) {
  int n = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(),
                              static_cast<int>(text.size()), nullptr, 0);
  require(n > 0, "invalid_utf8");
  std::wstring result(n, 0);
  MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()),
                      result.data(), n);
  return result;
}
inline std::string utf8(const std::wstring &text) {
  if (text.empty())
    return {};
  int n = WideCharToMultiByte(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), nullptr, 0,
                              nullptr, nullptr);
  std::string result(n, 0);
  WideCharToMultiByte(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), result.data(), n,
                      nullptr, nullptr);
  return result;
}
inline void keys(const Json &j, std::initializer_list<const char *> allowed) {
  require(j.is_object(), "object_required");
  for (auto it = j.begin(); it != j.end(); ++it) {
    bool found = false;
    for (auto key : allowed)
      if (it.key() == key)
        found = true;
    require(found, "unknown_field");
  }
}
inline int integer(const Json &j, const char *key, int lo, int hi) {
  require(j.contains(key) && j[key].is_number_integer(), "integer_required");
  auto n = j[key].get<int64_t>();
  require(n >= lo && n <= hi, "integer_out_of_range");
  return static_cast<int>(n);
}
inline double number(const Json &j, const char *key, double lo, double hi) {
  require(j.contains(key) && j[key].is_number(), "number_required");
  double n = j[key].get<double>();
  require(std::isfinite(n) && n >= lo && n <= hi, "number_out_of_range");
  return n;
}
inline std::string string(const Json &j, const char *key, size_t max) {
  require(j.contains(key) && j[key].is_string(), "string_required");
  auto s = j[key].get<std::string>();
  require(!s.empty() && s.size() <= max && s.find('\0') == std::string::npos,
          "string_out_of_range");
  wide(s);
  return s;
}
struct Pad {
  std::string id;
  int note = 36, channel = 9, velocity = 100, index = 0, direction = 1;
  std::string kind = "none";
};
struct Settings {
  std::string source = "manual", audioId = "default";
  int midiId = -1, xinputIndex = 0, rate = 48000, block = 128;
  double volume = .7;
  std::vector<Pad> pads;
};
inline Settings settings(const Json &j) {
  keys(j, {"version", "audioDeviceId", "midiDeviceId", "source", "xinputIndex", "sampleRate",
           "blockSize", "volume", "pads"});
  require(integer(j, "version", 1, 1) == 1, "unsupported_settings_version");
  Settings s;
  s.audioId = string(j, "audioDeviceId", 256);
  s.source = string(j, "source", 12);
  require(s.source == "manual" || s.source == "midi" || s.source == "xinput", "invalid_source");
  require(s.audioId == "default" ||
              std::all_of(s.audioId.begin(), s.audioId.end(),
                          [](char c) { return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'); }),
          "invalid_audio_id");
  s.midiId = integer(j, "midiDeviceId", -1, 65535);
  s.xinputIndex = integer(j, "xinputIndex", 0, 3);
  s.rate = integer(j, "sampleRate", 44100, 96000);
  require(s.rate == 44100 || s.rate == 48000 || s.rate == 96000, "invalid_sample_rate");
  s.block = integer(j, "blockSize", 64, 512);
  require(s.block == 64 || s.block == 128 || s.block == 256 || s.block == 512,
          "invalid_block_size");
  s.volume = number(j, "volume", 0, 1);
  require(j.contains("pads") && j["pads"].is_array() && j["pads"].size() >= 1 &&
              j["pads"].size() <= 32,
          "invalid_pads");
  for (const auto &p : j["pads"]) {
    keys(p, {"id", "note", "channel", "velocity", "binding"});
    Pad pad;
    pad.id = string(p, "id", 32);
    require(std::all_of(pad.id.begin(), pad.id.end(),
                        [](char c) {
                          return (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-';
                        }),
            "invalid_pad_id");
    require(
        std::none_of(s.pads.begin(), s.pads.end(), [&](const Pad &v) { return v.id == pad.id; }),
        "duplicate_pad");
    pad.note = integer(p, "note", 0, 127);
    pad.channel = integer(p, "channel", 0, 15);
    pad.velocity = integer(p, "velocity", 1, 127);
    require(p.contains("binding"), "missing_binding");
    auto b = p["binding"];
    keys(b, {"kind", "index", "direction"});
    pad.kind = string(b, "kind", 8);
    require(pad.kind == "none" || pad.kind == "button" || pad.kind == "axis", "invalid_binding");
    if (pad.kind != "none")
      pad.index = integer(b, "index", 0, pad.kind == "axis" ? 3 : 16);
    if (b.contains("direction")) {
      pad.direction = integer(b, "direction", -1, 1);
      require(pad.direction != 0, "invalid_direction");
    }
    s.pads.push_back(pad);
  }
  return s;
}
struct Note {
  int note = 0, channel = 0, velocity = 0;
  bool on = false;
  Clock::time_point at = Clock::now();
};
struct Levels {
  float left = 0, right = 0;
};
} // namespace ch
