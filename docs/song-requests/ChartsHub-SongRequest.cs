// Paste into Streamer.bot > Core > C# > Execute C# Code.
// Setup and platform-specific arguments: ../SONG-REQUESTS.md.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.RegularExpressions;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

public class CPHInline
{
    private static readonly HttpClient Client = new HttpClient(new HttpClientHandler
    {
        UseProxy = false,
        AllowAutoRedirect = false
    }) { Timeout = TimeSpan.FromSeconds(5), MaxResponseContentBufferSize = 32768 };

    private string Argument(string name)
    {
        object value;
        if (!CPH.TryGetArg<object>(name, out value) || value == null) return "";
        // A floating-point TikTok ID may already have lost precision. Fail closed.
        if (value is double || value is float) return "";
        return Convert.ToString(value, CultureInfo.InvariantCulture) ?? "";
    }

    private static bool Identity(string value)
    {
        return Regex.IsMatch(value ?? "", @"\A[\x21-\x7e]{1,256}\z");
    }

    private static List<string> ChatParts(string reply)
    {
        var parts = new List<string>();
        string current = "";
        foreach (string original in reply.Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries))
        {
            // Library IDs are 64 characters and therefore stay intact across parts.
            string word = original.Length > 180 ? original.Substring(0, 177) + "…" : original;
            if (current.Length + word.Length + 1 > 190)
            {
                parts.Add(current);
                if (parts.Count == 4) return parts;
                current = "";
            }
            current += (current == "" ? "" : " ") + word;
        }
        if (current != "") parts.Add(current);
        return parts;
    }

    public bool Execute()
    {
        try
        {
            string platform = Argument("chartshubPlatform");
            if (platform == "") platform = Argument("commandSource").ToLowerInvariant();
            if (platform != "twitch" && platform != "youtube" && platform != "tiktok") return false;
            string command = platform == "tiktok" ? Argument("chartshubCommand") : Argument("command");
            command = command.Trim().ToLowerInvariant();
            if (command != "!sr" && command != "!vote" && command != "!queue" && command != "!song") return false;
            string parameters = platform == "tiktok" ? Argument("commandParams") : Argument("rawInput");
            // TikFinity versions may supply the whole comment instead of just its parameters.
            parameters = parameters.Trim();
            if (parameters.Equals(command, StringComparison.OrdinalIgnoreCase)) parameters = "";
            else if (parameters.StartsWith(command + " ", StringComparison.OrdinalIgnoreCase)) parameters = parameters.Substring(command.Length).Trim();
            if ((command == "!queue" || command == "!song") && parameters != "") return false;
            if ((command == "!sr" || command == "!vote") && parameters == "") return false;
            string message = command + (parameters == "" ? "" : " " + parameters);
            if (message.Length > 200 || Regex.IsMatch(message, @"[\x00-\x1f\x7f]")) return false;

            string viewerId = Argument("userId");
            string viewerName = Argument(platform == "tiktok" ? "nickname" : "userName");
            if (viewerName == "") viewerName = Argument(platform == "tiktok" ? "username" : "user");
            if (!Identity(viewerId) || string.IsNullOrWhiteSpace(viewerName) || viewerName.Length > 256) return false;
            string eventId = Argument("msgId");
            if (platform == "youtube" && eventId == "") eventId = Argument("messageId");
            // TikFinity's documented action arguments have no stable platform message ID.
            // This GUID identifies this invocation only. There are no automatic HTTP retries.
            if (platform == "tiktok") eventId = "bridge:" + Guid.NewGuid().ToString("N");
            if (!Identity(eventId)) return false;

            string configuredUrl = CPH.GetGlobalVar<string>("chartshubSongRequestUrl", true);
            string token = CPH.GetGlobalVar<string>("chartshubSongRequestToken", true);
            Uri url;
            if (!Uri.TryCreate(configuredUrl, UriKind.Absolute, out url) || url.Scheme != "http" || url.Host != "127.0.0.1"
                || url.Port < 1024 || url.Port > 65535 || url.AbsolutePath != "/song-requests" || url.Query != ""
                || url.Fragment != "" || url.UserInfo != "" || !Regex.IsMatch(token ?? "", @"\A[0-9a-fA-F]{64}\z"))
            {
                CPH.LogWarn("ChartsHub Song Request: check the local URL/token configuration.");
                return false;
            }
            var payload = new { platform, eventId, viewerId, viewerName, message };
            using (var request = new HttpRequestMessage(HttpMethod.Post, url))
            {
                request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
                request.Content = new StringContent(JsonConvert.SerializeObject(payload), Encoding.UTF8, "application/json");
                using (var response = Client.SendAsync(request).GetAwaiter().GetResult())
                {
                    if (response.Content.Headers.ContentType == null || response.Content.Headers.ContentType.MediaType != "application/json") return false;
                    string body = response.Content.ReadAsStringAsync().GetAwaiter().GetResult();
                    if (body.Length > 32768) return false;
                    var result = JObject.Parse(body);
                    if (result["ok"] == null || result["ok"].Type != JTokenType.Boolean || result["reply"] == null || result["reply"].Type != JTokenType.String) return false;
                    string reply = (string)result["reply"];
                    if (string.IsNullOrWhiteSpace(reply) || reply.Length > 2000 || Regex.IsMatch(reply, @"[\x00-\x1f\x7f]")) return false;
                    // Short, bounded chat messages; never echo raw JSON/errors/secrets.
                    string broadcastId = Argument("broadcastId");
                    if (platform == "youtube" && broadcastId == "") broadcastId = CPH.GetGlobalVar<string>("chartshubYouTubeBroadcastId", true) ?? "";
                    if (platform == "youtube" && !Identity(broadcastId))
                    {
                        CPH.LogWarn("ChartsHub: request processed; set chartshubYouTubeBroadcastId for chat replies when broadcastId is unavailable.");
                        return true;
                    }
                    foreach (string part in ChatParts(reply))
                    {
                        if (platform == "twitch") CPH.SendMessage(part, true, true);
                        else if (platform == "youtube") CPH.SendYouTubeMessage(part, true, true, broadcastId);
                        else CPH.WebsocketBroadcastJson(JsonConvert.SerializeObject(new { action = "sendChatbotMessage", args = new { message = part } }));
                    }
                    return true;
                }
            }
        }
        catch (Exception)
        {
            // Do not print exception objects: they can contain a URL or local configuration.
            CPH.LogWarn("ChartsHub Song Request: local bridge unavailable or response invalid. No automatic retry.");
            return false;
        }
    }
}
