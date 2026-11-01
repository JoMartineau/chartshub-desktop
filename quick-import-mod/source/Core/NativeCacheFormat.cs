using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;

namespace ChartsHub.QuickImport;

public sealed record NativeCacheMergeResult(byte[] Bytes, string OriginalSha256, string MergedSha256,
    int OriginalCount, int MergedCount, string PreservedRecordsSha256, string AppendedRecordSha256);

// Exact 1.1.0.6142 cache format. This module only handles supplied bytes: it has
// no filesystem, game, profile, scanner or native-call dependency. The adapter
// must also fence its master-list stamp and the on-disk cache before committing.
public static class NativeCacheFormat
{
    public const int MaxCacheBytes = 268435456;
    public const int MaxRecords = 500000;
    private const int PrologueBytes = 20, TableKinds = 7, MaxStringBytes = 1048576;
    private const int Magic = 0x0135257b;
    private static readonly UTF8Encoding StrictUtf8 = new(false, true);
    private sealed record Entry(int Start, int End, string Folder, string ChartFile, int ChecksumOffset);
    private sealed record Cache(byte[] Bytes, List<string>[] Tables, int CountOffset, int RecordsOffset, Entry[] Entries);

    public static NativeCacheMergeResult Append(byte[] originalBytes, byte[] singletonBytes,
        string expectedOriginalSha256, int expectedOriginalCount, string expectedNewFolder,
        string expectedNewChartFile, string expectedNewChecksum)
    {
        if (!ChartValidator.Digest(expectedOriginalSha256) || expectedOriginalCount is < 0 or >= MaxRecords)
            throw Reject("CACHE_PROVENANCE_MISMATCH");
        ValidateIdentity(expectedNewFolder, expectedNewChartFile, expectedNewChecksum);
        var original = Parse(originalBytes); var singleton = Parse(singletonBytes);
        var originalHash = Hash(original.Bytes);
        if (originalHash != expectedOriginalSha256 || original.Entries.Length != expectedOriginalCount)
            throw Reject("CACHE_PROVENANCE_MISMATCH");
        if (singleton.Entries.Length != 1) throw Reject("CACHE_SINGLE_ENTRY_REQUIRED");
        if (!original.Bytes.AsSpan(0, PrologueBytes).SequenceEqual(singleton.Bytes.AsSpan(0, PrologueBytes)))
            throw Reject("CACHE_FORMAT_IDENTITY_MISMATCH");
        for (int kind = 0; kind < TableKinds; kind++)
        {
            var prior = original.Tables[kind]; var next = singleton.Tables[kind];
            if (next.Count < prior.Count) throw Reject("CACHE_METADATA_PREFIX_CHANGED");
            for (int index = 0; index < prior.Count; index++)
                if (!string.Equals(prior[index], next[index], StringComparison.Ordinal))
                    throw Reject("CACHE_METADATA_PREFIX_CHANGED");
        }
        var appended = singleton.Entries[0];
        RequireEntry(singleton, appended, expectedNewFolder, expectedNewChartFile, expectedNewChecksum);
        if (original.Entries.Any(entry => SameFolder(entry.Folder, expectedNewFolder)))
            throw Reject("CACHE_ENTRY_ALREADY_PRESENT");
        int oldLength = original.Bytes.Length - original.RecordsOffset;
        int newLength = appended.End - appended.Start;
        long mergedLength = (long)singleton.RecordsOffset + oldLength + newLength;
        if (mergedLength > MaxCacheBytes) throw Reject("CACHE_TOO_LARGE");
        var merged = new byte[(int)mergedLength];
        // Only the new native metadata header is used. Every old record,
        // including dates, flags, scores and otherwise opaque fields, is copied.
        singleton.Bytes.AsSpan(0, singleton.RecordsOffset).CopyTo(merged);
        BinaryPrimitives.WriteInt32LittleEndian(merged.AsSpan(singleton.CountOffset, 4), expectedOriginalCount + 1);
        original.Bytes.AsSpan(original.RecordsOffset, oldLength).CopyTo(merged.AsSpan(singleton.RecordsOffset));
        singleton.Bytes.AsSpan(appended.Start, newLength).CopyTo(merged.AsSpan(singleton.RecordsOffset + oldLength));
        var verification = Parse(merged);
        if (verification.Entries.Length != expectedOriginalCount + 1 ||
            !merged.AsSpan(verification.RecordsOffset, oldLength).SequenceEqual(original.Bytes.AsSpan(original.RecordsOffset)) ||
            Hash(original.Bytes) != originalHash)
            throw Reject("CACHE_PROVENANCE_MISMATCH");
        return new(merged, originalHash, Hash(merged), expectedOriginalCount, expectedOriginalCount + 1,
            Hash(original.Bytes.AsSpan(original.RecordsOffset)), Hash(singleton.Bytes.AsSpan(appended.Start, newLength)));
    }

    public static bool ValidateExisting(byte[] bytes, int expectedCount, string expectedFolder,
        string expectedChartFile, string expectedChecksum)
    {
        ValidateIdentity(expectedFolder, expectedChartFile, expectedChecksum);
        if (expectedCount is < 0 or > MaxRecords) throw Reject("CACHE_PROVENANCE_MISMATCH");
        var cache = Parse(bytes);
        if (cache.Entries.Length != expectedCount) throw Reject("CACHE_PROVENANCE_MISMATCH");
        var entry = cache.Entries.SingleOrDefault(item => SameFolder(item.Folder, expectedFolder));
        if (entry is null) throw Reject("CACHE_ENTRY_NOT_PERSISTED");
        RequireEntry(cache, entry, expectedFolder, expectedChartFile, expectedChecksum);
        return true;
    }

    private static void ValidateIdentity(string folder, string chartFile, string checksum)
    {
        if (string.IsNullOrWhiteSpace(folder) || folder.Length > 32768 || folder.Any(char.IsControl) ||
            chartFile is not ("notes.chart" or "notes.mid") || checksum is null || checksum.Length != 32 ||
            !checksum.All(c => c is >= '0' and <= '9' or >= 'a' and <= 'f' or >= 'A' and <= 'F'))
            throw Reject("CACHE_ENTRY_IDENTITY_INVALID");
    }

    private static void RequireEntry(Cache cache, Entry entry, string folder, string chartFile, string checksum)
    {
        // The native scanner can cache an absolute chartName, while the
        // targeted constructor uses its explicit basename. Both must resolve
        // to this exact supplied folder/file, never a substring elsewhere.
        bool sameChart = string.Equals(entry.ChartFile, chartFile, StringComparison.Ordinal) ||
            SameFolder(entry.ChartFile, FolderKey(folder) + "\\" + chartFile);
        if (!SameFolder(entry.Folder, folder) || !sameChart ||
            !string.Equals(Convert.ToHexString(cache.Bytes.AsSpan(entry.ChecksumOffset, 16)), checksum, StringComparison.OrdinalIgnoreCase))
            throw Reject("CACHE_ENTRY_IDENTITY_MISMATCH");
    }

    private static bool SameFolder(string left, string right) => string.Equals(FolderKey(left), FolderKey(right), StringComparison.OrdinalIgnoreCase);
    private static string FolderKey(string value) => value.Replace('/', '\\').TrimEnd('\\');
    private static string Hash(ReadOnlySpan<byte> value) => Convert.ToHexString(SHA256.HashData(value)).ToLowerInvariant();
    private static ImportRejection Reject(string code) => new(code);

    private static Cache Parse(byte[] bytes)
    {
        if (bytes is null || bytes.Length < PrologueBytes + TableKinds * 5 + 4) throw Reject("CACHE_FORMAT_INVALID");
        if (bytes.Length > MaxCacheBytes) throw Reject("CACHE_TOO_LARGE");
        var reader = new Reader(bytes);
        if (reader.Int32() != Magic) throw Reject("CACHE_FORMAT_INVALID");
        reader.Skip(16);
        var tables = new List<string>[TableKinds];
        for (int kind = 0; kind < TableKinds; kind++)
        {
            if (reader.Byte() != kind) throw Reject("CACHE_FORMAT_INVALID");
            int count = reader.Int32();
            if (count is < 0 or > MaxRecords || count > reader.Remaining) throw Reject("CACHE_FORMAT_INVALID");
            var table = tables[kind] = new(count);
            for (int index = 0; index < count; index++) table.Add(reader.String());
        }
        int countOffset = reader.Position, records = reader.Int32(), recordsOffset = reader.Position;
        // Each record has at least 111 fixed bytes plus three string prefixes.
        if (records is < 0 or > MaxRecords || records > reader.Remaining / 112) throw Reject("CACHE_FORMAT_INVALID");
        var entries = new Entry[records]; var folders = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        for (int index = 0; index < records; index++)
        {
            int start = reader.Position; string folder = reader.String();
            if (folder.Length == 0 || folder.Length > 32768 || folder.Any(char.IsControl) || !folders.Add(FolderKey(folder)))
                throw Reject("CACHE_FORMAT_INVALID");
            reader.Skip(16); // Native ini/chart timestamps, kept opaque.
            string chart = reader.String();
            if (chart.Length == 0 || chart.Length > 32768 || chart.Any(char.IsControl))
                throw Reject("CACHE_FORMAT_INVALID");
            reader.Skip(2);
            for (int kind = 0; kind < TableKinds; kind++)
            {
                int metadataIndex = reader.Int32();
                if (metadataIndex < 0 || metadataIndex >= tables[kind].Count) throw Reject("CACHE_METADATA_INDEX_INVALID");
            }
            reader.Skip(8 + 1 + 13 + 4); // Tracks, native difficulty/flag fields.
            _ = reader.String(); // Icon, not a filesystem lookup.
            reader.Skip(2 + 2 + 5 + 4 + 8);
            int checksumOffset = reader.Position; reader.Skip(16);
            entries[index] = new(start, reader.Position, folder, chart, checksumOffset);
        }
        if (reader.Remaining != 0) throw Reject("CACHE_FORMAT_INVALID");
        return new(bytes, tables, countOffset, recordsOffset, entries);
    }

    private sealed class Reader
    {
        private readonly byte[] bytes;
        public int Position { get; private set; }
        public int Remaining => bytes.Length - Position;
        public Reader(byte[] bytes) { this.bytes = bytes; }
        public byte Byte() { Require(1); return bytes[Position++]; }
        public int Int32() { Require(4); int value = BinaryPrimitives.ReadInt32LittleEndian(bytes.AsSpan(Position, 4)); Position += 4; return value; }
        public void Skip(int count) { Require(count); Position += count; }
        private void Require(int count) { if (count < 0 || count > Remaining) throw Reject("CACHE_FORMAT_INVALID"); }
        public string String()
        {
            int length = 0, shift = 0;
            for (int index = 0; ; index++)
            {
                byte part = Byte();
                if (index == 4 && part > 7) throw Reject("CACHE_FORMAT_INVALID");
                length |= (part & 127) << shift;
                if ((part & 128) == 0)
                {
                    if (index > 0 && part == 0) throw Reject("CACHE_FORMAT_INVALID");
                    break;
                }
                if (index == 4) throw Reject("CACHE_FORMAT_INVALID");
                shift += 7;
            }
            if (length > MaxStringBytes) throw Reject("CACHE_FORMAT_INVALID");
            Require(length); string value;
            try { value = StrictUtf8.GetString(bytes, Position, length); }
            catch (DecoderFallbackException) { throw Reject("CACHE_FORMAT_INVALID"); }
            Position += length; return value;
        }
    }
}
