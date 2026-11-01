using System.Security.Cryptography;

namespace ChartsHub.QuickImport;

// Changes one already selected native cache file, never chart directories.
// The replaced destination is retained atomically; concurrent foreign content
// is preserved and never silently overwritten by a stale rollback.
public sealed class AtomicCacheUpdate
{
    public const int MaxCacheBytes = 256 * 1024 * 1024;
    public string BeforeSha256 { get; }
    public string AfterSha256 { get; }
    public string BackupFile { get; }
    private readonly string file;
    private AtomicCacheUpdate(string file, string backup, string before, string after) { this.file = file; BackupFile = backup; BeforeSha256 = before; AfterSha256 = after; }
    public static string Digest(byte[] bytes) { using var algorithm = SHA256.Create(); return Convert.ToHexString(algorithm.ComputeHash(bytes)).ToLowerInvariant(); }
    public static byte[] ReadBounded(string file)
    {
        ChartValidator.NoLinks(file);
        using var input = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read);
        if (input.Length is < 24 or > MaxCacheBytes) throw new ImportRejection("NATIVE_CACHE_SIZE_LIMIT");
        var bytes = new byte[(int)input.Length]; int at = 0;
        while (at < bytes.Length) { var n = input.Read(bytes, at, bytes.Length - at); if (n == 0) throw new ImportRejection("NATIVE_CACHE_CHANGED"); at += n; }
        if (input.ReadByte() != -1) throw new ImportRejection("NATIVE_CACHE_CHANGED");
        return bytes;
    }
    public static AtomicCacheUpdate Commit(string file, string backupDirectory, Guid id, byte[] original, byte[] replacement)
    {
        if (id == Guid.Empty || replacement.Length is < 24 or > MaxCacheBytes) throw new ImportRejection("INVALID_CACHE_UPDATE");
        ChartValidator.NoLinks(file); ChartValidator.NoLinks(backupDirectory);
        var before = Digest(original); var after = Digest(replacement);
        if (before == after) throw new ImportRejection("CACHE_UPDATE_HAS_NO_CHANGE");
        var nonce = Guid.NewGuid().ToString("N");
        var temporary = file + ".chartshub-" + nonce + ".tmp";
        // ReplaceFile requires all three files on the same volume. The game may
        // be on F: while its native cache is in AppData on C:.
        var backup = file + ".chartshub-" + id.ToString("N") + "-" + nonce + ".before.bin";
        if (File.Exists(temporary) || File.Exists(backup)) throw new ImportRejection("CACHE_TRANSACTION_COLLISION");
        try
        {
            using (var output = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None)) { output.Write(replacement, 0, replacement.Length); output.Flush(true); }
            if (Digest(ReadBounded(file)) != before) throw new ImportRejection("NATIVE_CACHE_CHANGED_BEFORE_COMMIT");
            File.Replace(temporary, file, backup, true);
            var saved = Digest(ReadBounded(backup));
            if (saved != before)
            {
                // File.Replace captured the actual concurrent destination in the
                // backup. Restore that content only while our bytes still own it.
                if (Digest(ReadBounded(file)) == after) File.Replace(backup, file, null, true);
                throw new ImportRejection("NATIVE_CACHE_CHANGED_DURING_COMMIT");
            }
            if (Digest(ReadBounded(file)) != after) throw new ImportRejection("NATIVE_CACHE_CHANGED_AFTER_COMMIT");
            return new(file, backup, before, after);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }
    public bool Rollback()
    {
        try
        {
            if (Digest(ReadBounded(file)) != AfterSha256 || Digest(ReadBounded(BackupFile)) != BeforeSha256) return false;
            // The current file must still be our committed generation. Preserve
            // it too so a failed restoration never destroys recovery evidence.
            var replaced = BackupFile + ".replaced.bin";
            if (File.Exists(replaced)) return false;
            File.Replace(BackupFile, file, replaced, true);
            if (Digest(ReadBounded(replaced)) != AfterSha256)
            {
                if (Digest(ReadBounded(file)) == BeforeSha256) File.Replace(replaced, file, null, true);
                return false;
            }
            return Digest(ReadBounded(file)) == BeforeSha256;
        }
        catch { return false; }
    }
}
