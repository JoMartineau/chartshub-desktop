using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace ChartsHub.QuickImport;

public sealed class LocalProtocol
{
    public const int MaxRequestBytes = 8192;
    private readonly byte[] token;
    private readonly ImportQueue queue;
    public LocalProtocol(string token, ImportQueue queue)
    {
        if (!ChartValidator.Digest(token)) throw new ArgumentException("A private 32-byte token is required");
        this.token = Convert.FromHexString(token); this.queue = queue;
    }
    public string Handle(ReadOnlySpan<byte> bytes)
    {
        try
        {
            if (bytes.Length is 0 or > MaxRequestBytes) throw new ImportRejection("INVALID_REQUEST");
            using var doc = JsonDocument.Parse(bytes.ToArray(), new JsonDocumentOptions { MaxDepth = 4, CommentHandling = JsonCommentHandling.Disallow });
            var value = doc.RootElement;
            if (value.ValueKind != JsonValueKind.Object) throw new ImportRejection("INVALID_REQUEST");
            var names = value.EnumerateObject().Select(p => p.Name).ToArray();
            if (names.Distinct(StringComparer.Ordinal).Count() != names.Length || value.GetProperty("schema").GetInt32() != 1) throw new ImportRejection("INVALID_REQUEST");
            string supplied = value.GetProperty("token").GetString() ?? "";
            if (!ChartValidator.Digest(supplied) || !CryptographicOperations.FixedTimeEquals(token, Convert.FromHexString(supplied))) throw new ImportRejection("UNAUTHORIZED");
            string command = value.GetProperty("command").GetString() ?? "";
            var allowed = command == "enqueue" ? new[] { "schema", "token", "command", "id", "folder", "chartFile", "chartSha256" } : command == "status" ? new[] { "schema", "token", "command", "id" } : command == "hello" ? new[] { "schema", "token", "command" } : throw new ImportRejection("UNKNOWN_COMMAND");
            if (names.Length != allowed.Length || names.Any(n => !allowed.Contains(n))) throw new ImportRejection("INVALID_REQUEST");
            object result = command switch
            {
                "hello" => new { schema = 1, importValidated = queue.ImportValidated, build = queue.Build, phase = queue.ImportValidated ? "available" : "diagnostic-only", fullScanFallback = false },
                "status" => queue.Status(value.GetProperty("id").GetGuid()),
                _ => queue.Enqueue(new(value.GetProperty("id").GetGuid(), value.GetProperty("folder").GetString() ?? "", value.GetProperty("chartFile").GetString() ?? "", value.GetProperty("chartSha256").GetString() ?? ""))
            };
            return JsonSerializer.Serialize(new { schema = 1, ok = true, result });
        }
        catch (ImportRejection error) { return JsonSerializer.Serialize(new { schema = 1, ok = false, code = error.Code }); }
        catch { return JsonSerializer.Serialize(new { schema = 1, ok = false, code = "INVALID_REQUEST" }); }
    }
}
