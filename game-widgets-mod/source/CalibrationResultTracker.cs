namespace ChartsHub.CloneHero.Telemetry;

internal readonly record struct ConnectionSnapshot(bool Connected, long Generation);
internal sealed record RetainedCalibrationResult(string Stage, int SettingMs, string CalibrationAttemptId);

// Only a real stage entry, accepted samples and its matching native completion
// can publish a retained setting. Network continuity is required for the whole
// observed trial, so a reconnect cannot relabel an old setting as a new result.
internal sealed class CalibrationResultTracker
{
    private nint owner;
    private int stage;
    private string attempt = string.Empty;
    private ConnectionSnapshot connection;
    private bool valid, frameObserved, reported;
    private int acceptedSamples;
    internal string Enter(nint nextOwner, int nextStage, ConnectionSnapshot nextConnection)
    {
        owner = nextOwner; stage = nextStage; attempt = Guid.NewGuid().ToString(); connection = nextConnection;
        valid = owner != 0 && stage is 1 or 3 && connection.Connected;
        frameObserved = false; reported = false; acceptedSamples = 0;
        return attempt;
    }
    internal void Invalidate() => valid = false;
    private bool Match(nint nextOwner, int nextStage, string nextAttempt, ConnectionSnapshot current) =>
        valid && !reported && nextOwner == owner && nextStage == stage && nextAttempt == attempt && current.Connected && current == connection;
    internal void ObserveFrame(nint nextOwner, int nextStage, string nextAttempt, ConnectionSnapshot current)
    {
        if (!Match(nextOwner, nextStage, nextAttempt, current)) { valid = false; return; }
        frameObserved = true;
    }
    internal void Sample(nint nextOwner, int nextStage, string nextAttempt, ConnectionSnapshot scoped, ConnectionSnapshot current)
    {
        if (!frameObserved || scoped != current || !Match(nextOwner, nextStage, nextAttempt, current)) { valid = false; return; }
        if (++acceptedSamples > 10_000_000) valid = false;
    }
    internal RetainedCalibrationResult? Complete(nint nextOwner, int before, int after, string nextAttempt, ConnectionSnapshot current, Func<int?> readRetained)
    {
        if (!frameObserved || acceptedSamples < 1 || !Match(nextOwner, before, nextAttempt, current) || !((before == 1 && after == 2) || (before == 3 && after == 4)))
        {
            if (after != before) valid = false;
            return null;
        }
        // Mark before the read: a missing/out-of-range native field cannot be
        // retried later and accidentally attributed to this completed trial.
        reported = true;
        int? value = readRetained();
        return value is >= -2000 and <= 2000 ? new(before == 1 ? "audio" : "video", value.Value, attempt) : null;
    }
}
