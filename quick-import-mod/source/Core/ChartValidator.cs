using System.Security.Cryptography;

namespace ChartsHub.QuickImport;

public sealed record ImportRequest(Guid Id, string Folder, string ChartFile, string ChartSha256);
public sealed record FileStamp(string Name, long Length, long ModifiedUtcTicks);
public sealed record PreparedChart(ImportRequest Request, string CanonicalFolder, string Identity, string MetadataSha256, FileStamp[] Files);
public sealed class ImportRejection : Exception
{
    public string Code { get; }
    public ImportRejection(string code) : base(code) => Code = code;
}

// Reads one explicitly supplied chart directory. There is no recursive scanner,
// cache writer, song-list replacement, game launch or loader installation here.
public sealed class ChartValidator
{
    private readonly string root;
    private readonly StringComparison comparison = OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
    public ChartValidator(string songsRoot)
    {
        root = Canonical(songsRoot).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        if (!Directory.Exists(root)) throw new ImportRejection("SONGS_ROOT_MISSING");
        NoLinks(root);
    }
    public PreparedChart Prepare(ImportRequest request)
    {
        if (request.Id == Guid.Empty || !new[] { "notes.chart", "notes.mid" }.Contains(request.ChartFile) || !Digest(request.ChartSha256)) throw new ImportRejection("INVALID_REQUEST");
        var folder = Canonical(request.Folder);
        if (!folder.StartsWith(root + Path.DirectorySeparatorChar, comparison)) throw new ImportRejection("OUTSIDE_SONGS_ROOT");
        if (!Directory.Exists(folder)) throw new ImportRejection("CHART_FOLDER_MISSING");
        NoLinks(folder);
        var files = new List<FileStamp>();
        bool hasAudio = false; int entries = 0;
        foreach (var item in Directory.EnumerateFileSystemEntries(folder))
        {
            if (++entries > 256) throw new ImportRejection("TOO_MANY_CHART_FILES");
            NoLinks(item);
            if (Directory.Exists(item)) continue; // Never visit descendants.
            var info = new FileInfo(item);
            if (!info.Exists || info.Length < 0) throw new ImportRejection("CHART_CHANGED");
            if (new[] { ".part", ".partial", ".tmp", ".download", ".crdownload" }.Contains(info.Extension.ToLowerInvariant())) throw new ImportRejection("DOWNLOAD_INCOMPLETE");
            hasAudio |= info.Length > 0 && new[] { ".ogg", ".opus", ".wav", ".mp3" }.Contains(info.Extension.ToLowerInvariant());
            files.Add(new(info.Name, info.Length, info.LastWriteTimeUtc.Ticks));
        }
        if (!hasAudio) throw new ImportRejection("AUDIO_MISSING");
        if (!files.Any(f => f.Name == "song.ini" && f.Length is > 0 and <= 262144)) throw new ImportRejection("METADATA_MISSING");
        var chart = files.SingleOrDefault(f => f.Name == request.ChartFile);
        if (chart is null || chart.Length is <= 0 or > 134217728) throw new ImportRejection("CHART_MISSING_OR_TOO_LARGE");
        string actual;
        actual = FileHash(Path.Combine(folder, request.ChartFile));
        if (!CryptographicOperations.FixedTimeEquals(Convert.FromHexString(actual), Convert.FromHexString(request.ChartSha256))) throw new ImportRejection("CHART_DIGEST_CHANGED");
        var metadata = FileHash(Path.Combine(folder, "song.ini"));
        var prepared = new PreparedChart(request, folder, folder + "\n" + request.ChartFile + "\n" + actual + "\n" + metadata, metadata, files.OrderBy(f => f.Name, StringComparer.Ordinal).ToArray());
        RequireUnchanged(prepared);
        return prepared;
    }
    public void RequireUnchanged(PreparedChart chart)
    {
        NoLinks(chart.CanonicalFolder);
        foreach (var stamp in chart.Files)
        {
            var file = Path.Combine(chart.CanonicalFolder, stamp.Name); NoLinks(file);
            var info = new FileInfo(file);
            if (!info.Exists || info.Length != stamp.Length || info.LastWriteTimeUtc.Ticks != stamp.ModifiedUtcTicks) throw new ImportRejection("CHART_CHANGED");
        }
        // A late partial download must not be accepted between enqueue and menu.
        var names = Directory.EnumerateFiles(chart.CanonicalFolder).Select(Path.GetFileName).OrderBy(n => n, StringComparer.Ordinal).ToArray();
        if (!names.SequenceEqual(chart.Files.Select(f => f.Name))) throw new ImportRejection("CHART_CHANGED");
        if (FileHash(Path.Combine(chart.CanonicalFolder, chart.Request.ChartFile)) != chart.Request.ChartSha256 || FileHash(Path.Combine(chart.CanonicalFolder, "song.ini")) != chart.MetadataSha256) throw new ImportRejection("CHART_CHANGED");
    }
    private static string Canonical(string value)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Length > 230 || value.Any(char.IsControl) || !Path.IsPathFullyQualified(value) || value.StartsWith("\\\\") || value.StartsWith("//")) throw new ImportRejection("INVALID_PATH");
        return Path.GetFullPath(value);
    }
    public static void NoLinks(string value)
    {
        for (string? at = Path.GetFullPath(value); at is not null; at = Path.GetDirectoryName(at))
        {
            if ((File.GetAttributes(at) & FileAttributes.ReparsePoint) != 0) throw new ImportRejection("LINKED_PATH");
        }
    }
    public static bool Digest(string value) => value?.Length == 64 && value.All(c => c is >= '0' and <= '9' or >= 'a' and <= 'f');
    private static string FileHash(string path) { using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read); using var algorithm = SHA256.Create(); return Convert.ToHexString(algorithm.ComputeHash(stream)).ToLowerInvariant(); }
}
