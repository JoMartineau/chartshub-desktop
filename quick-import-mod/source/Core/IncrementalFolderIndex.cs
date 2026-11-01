using System.Diagnostics;

namespace ChartsHub.QuickImport;

public readonly record struct NativeListStamp(nint Pointer, int Count, int Version);

/// <summary>
/// Main-thread, memory-only folder index. Each slice visits at most 128 native
/// entries and checks a cooperative two-millisecond budget between callbacks.
/// A callback itself cannot be preempted; callers must keep each callback cheap.
/// No files, native objects, worker threads or collection mutations are owned here.
/// </summary>
public sealed class IncrementalFolderIndex<T>
{
    private readonly Func<NativeListStamp> sourceStamp;
    private readonly Func<int, (string Folder, T Value)> read;
    private readonly int mainThread = Environment.CurrentManagedThreadId;
    private Dictionary<string, T> entries = NewEntries();
    private NativeListStamp stamp;
    private bool hasStamp, ready;
    private int next;
    private string? fault;

    public IncrementalFolderIndex(Func<NativeListStamp> stamp, Func<int, (string Folder, T Value)> read)
    {
        sourceStamp = stamp ?? throw new ArgumentNullException(nameof(stamp));
        this.read = read ?? throw new ArgumentNullException(nameof(read));
    }

    public bool Ready { get { OnThread(); return Synchronize() && ready; } }
    public int IndexedCount { get { OnThread(); Synchronize(); return next; } }
    public string? FaultCode { get { OnThread(); Synchronize(); return fault; } }

    public bool BuildSlice(TimeSpan budget, int maxEntries = 128)
    {
        OnThread();
        if (budget <= TimeSpan.Zero || budget > TimeSpan.FromMilliseconds(2)) throw new ArgumentOutOfRangeException(nameof(budget));
        if (maxEntries < 1 || maxEntries > 128) throw new ArgumentOutOfRangeException(nameof(maxEntries));
        long started = Stopwatch.GetTimestamp();
        double ticks = budget.TotalSeconds * Stopwatch.Frequency;
        if (!Synchronize() || ready) return ready;
        int visited = 0;
        while (next < stamp.Count && visited < maxEntries && Stopwatch.GetTimestamp() - started < ticks)
        {
            var owner = stamp;
            (string Folder, T Value) item;
            try { item = read(next); }
            catch { Fail("SOURCE_READ_FAILED"); return false; }
            // Discard a read if even a reentrant callback changes the collection.
            if (!Synchronize() || stamp != owner) return false;
            if (string.IsNullOrWhiteSpace(item.Folder) || item.Value is null) { Fail("INVALID_FOLDER_ENTRY"); return false; }
            if (!entries.TryAdd(item.Folder, item.Value)) { Fail("DUPLICATE_FOLDER"); return false; }
            next++; visited++;
        }
        ready = fault is null && next == stamp.Count;
        return ready;
    }

    public bool TryGet(string folder, out T value)
    {
        OnThread(); value = default!;
        return Synchronize() && ready && !string.IsNullOrWhiteSpace(folder) && entries.TryGetValue(folder, out value!);
    }

    /// <summary>
    /// Record our own confirmed append without rescanning. Call immediately after
    /// the native Add, before Ready/TryGet observe the new stamp and invalidate it.
    /// Version need only change; the native collection may increment it unevenly.
    /// Any inconsistency invalidates the old index rather than returning stale data.
    /// </summary>
    public bool CommitAppend(NativeListStamp before, NativeListStamp after, string folder, T value)
    {
        OnThread();
        NativeListStamp current;
        try { current = sourceStamp(); }
        catch { Fail("SOURCE_READ_FAILED"); return false; }
        if (!hasStamp || !ready || fault is not null || stamp != before || current != after
            || before.Pointer == 0 || after.Pointer != before.Pointer || before.Count == int.MaxValue
            || after.Count != before.Count + 1 || after.Version == before.Version
            || string.IsNullOrWhiteSpace(folder) || value is null || entries.ContainsKey(folder))
        {
            Reset(current);
            return false;
        }
        entries.Add(folder, value); stamp = after; next = after.Count; ready = true;
        return true;
    }

    private static Dictionary<string, T> NewEntries() => new(StringComparer.OrdinalIgnoreCase);
    private void OnThread()
    {
        if (Environment.CurrentManagedThreadId != mainThread) throw new InvalidOperationException("MAIN_THREAD_REQUIRED");
    }
    private bool Synchronize()
    {
        NativeListStamp current;
        try { current = sourceStamp(); }
        catch { Fail("SOURCE_READ_FAILED"); return false; }
        if (!hasStamp || current != stamp) Reset(current);
        return fault is null;
    }
    private void Reset(NativeListStamp current)
    {
        // Replacing avoids a synchronous O(N) Clear during a menu frame.
        entries = NewEntries(); stamp = current; hasStamp = true; next = 0;
        fault = current.Count < 0 || current.Count > 0 && current.Pointer == 0 ? "INVALID_SOURCE_STAMP" : null;
        ready = fault is null && current.Count == 0;
    }
    private void Fail(string code) { entries = NewEntries(); next = 0; ready = false; fault = code; }
}
