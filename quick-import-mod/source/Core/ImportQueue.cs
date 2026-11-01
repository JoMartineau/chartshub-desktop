namespace ChartsHub.QuickImport;

public enum GamePhase { Unknown, Menu, Loading, Playing, Paused, Results }
public sealed record NativeOutcome(bool Added, bool ListRefreshed, bool CachePersisted, bool AlreadyPresent = false);
public interface ISingleChartAdapter
{
    bool ImportValidated { get; }
    string Build { get; }
    NativeOutcome Import(PreparedChart chart);
}
public sealed class DiagnosticOnlyAdapter : ISingleChartAdapter
{
    public bool ImportValidated => false;
    public string Build => "1.1.0.6142 (static candidates only)";
    public NativeOutcome Import(PreparedChart _) => throw new ImportRejection("IMPORT_NOT_VALIDATED");
}
public sealed record JobStatus(Guid Id, string State, string? Code = null, bool Deduplicated = false);

public sealed class ImportQueue : IDisposable
{
    private sealed record Job(PreparedChart Chart) { public JobStatus Status = new(Chart.Request.Id, "queued"); }
    private sealed record AdmissionOutcome(JobStatus? Status, Exception? Error = null);
    private sealed record Admission(ImportRequest Request)
    {
        public readonly TaskCompletionSource<AdmissionOutcome> Completion = new(TaskCreationOptions.RunContinuationsAsynchronously);
    }
    private sealed record Alias(ImportRequest Request, Guid Owner);
    private readonly object gate = new();
    private readonly ChartValidator validator;
    private readonly ISingleChartAdapter adapter;
    private readonly int mainThread = Environment.CurrentManagedThreadId;
    private static readonly StringComparer PathComparer = OperatingSystem.IsWindows() ? StringComparer.OrdinalIgnoreCase : StringComparer.Ordinal;
    private readonly Dictionary<Guid, Job> jobs = new();
    private readonly Dictionary<string, Guid> identities = new(PathComparer);
    private readonly Dictionary<Guid, Admission> admissions = new();
    private readonly Dictionary<Guid, Alias> aliases = new();
    private readonly Queue<Guid> pending = new(), history = new();
    private readonly Queue<(Guid Id, Alias Value)> aliasHistory = new();
    private bool disposed;
    public bool ImportValidated => adapter.ImportValidated;
    public string Build => adapter.Build;
    public ImportQueue(ChartValidator validator, ISingleChartAdapter adapter) { this.validator = validator; this.adapter = adapter; }
    public JobStatus Enqueue(ImportRequest request)
    {
        Admission admission; bool owner;
        lock (gate)
        {
            if (disposed) throw new ImportRejection("STOPPED");
            // Never advertise success or accept imports on the diagnostic build.
            if (!adapter.ImportValidated) throw new ImportRejection("IMPORT_NOT_VALIDATED");
            request = NormalizeRequest(request); // Shape/path normalization only: no file access.
            if (jobs.TryGetValue(request.Id, out var same)) return Repeated(request, same.Chart.Request, same.Status);
            if (aliases.TryGetValue(request.Id, out var alias)) return Repeated(request, alias.Request, jobs[alias.Owner].Status);
            if (admissions.TryGetValue(request.Id, out var existing))
            {
                if (!SameRequest(request, existing.Request)) throw new ImportRejection("REQUEST_ID_CONFLICT");
                admission = existing; owner = false;
            }
            else
            {
                // Reserve before Prepare enumerates or hashes anything. Concurrent
                // validations count against the same bound as queued imports.
                if (pending.Count + admissions.Count >= 32) throw new ImportRejection("QUEUE_FULL");
                admission = new(request); admissions.Add(request.Id, admission); owner = true;
            }
        }
        if (!owner)
        {
            var outcome = admission.Completion.Task.GetAwaiter().GetResult();
            if (outcome.Error is not null) System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(outcome.Error).Throw();
            return outcome.Status! with { Deduplicated = true };
        }
        try
        {
            var prepared = validator.Prepare(request);
            lock (gate)
            {
                if (disposed) throw new ImportRejection("STOPPED");
                JobStatus status;
                if (identities.TryGetValue(prepared.Identity, out var prior))
                {
                    var registration = new Alias(request, prior);
                    aliases.Add(request.Id, registration); aliasHistory.Enqueue((request.Id, registration));
                    while (aliasHistory.Count > 256)
                    {
                        var expired = aliasHistory.Dequeue();
                        if (aliases.TryGetValue(expired.Id, out var current) && ReferenceEquals(current, expired.Value)) aliases.Remove(expired.Id);
                    }
                    status = jobs[prior].Status with { Deduplicated = true };
                }
                else
                {
                    var job = new Job(prepared); jobs.Add(request.Id, job); identities.Add(prepared.Identity, request.Id); pending.Enqueue(request.Id);
                    status = job.Status;
                }
                admissions.Remove(request.Id); admission.Completion.TrySetResult(new(status));
                return status;
            }
        }
        catch (Exception error)
        {
            lock (gate) { admissions.Remove(request.Id); admission.Completion.TrySetResult(new(null, error)); }
            throw;
        }
    }
    private static ImportRequest NormalizeRequest(ImportRequest request)
    {
        if (request is null || request.Id == Guid.Empty || request.ChartFile is not ("notes.chart" or "notes.mid") || !ChartValidator.Digest(request.ChartSha256)) throw new ImportRejection("INVALID_REQUEST");
        var folder = request.Folder;
        if (string.IsNullOrWhiteSpace(folder) || folder.Length > 230 || folder.Any(char.IsControl) || !Path.IsPathFullyQualified(folder) || folder.StartsWith("\\\\") || folder.StartsWith("//")) throw new ImportRejection("INVALID_PATH");
        try { return request with { Folder = Path.GetFullPath(folder) }; }
        catch (Exception error) when (error is ArgumentException or NotSupportedException or PathTooLongException) { throw new ImportRejection("INVALID_PATH"); }
    }
    private static bool SameRequest(ImportRequest left, ImportRequest right) => PathComparer.Equals(left.Folder, right.Folder) && left.ChartFile == right.ChartFile && left.ChartSha256 == right.ChartSha256;
    private static JobStatus Repeated(ImportRequest request, ImportRequest original, JobStatus status)
    {
        if (!SameRequest(request, original)) throw new ImportRejection("REQUEST_ID_CONFLICT");
        return status with { Deduplicated = true };
    }
    public JobStatus Status(Guid id) { lock (gate) return jobs.TryGetValue(id, out var job) ? job.Status : throw new ImportRejection("UNKNOWN_JOB"); }
    // UUIDs remain idempotent, but an unsuccessful attempt must not permanently
    // own the chart identity. A later request ID may retry after its cause is fixed.
    private void ReleaseIdentity(Job job)
    {
        if (identities.TryGetValue(job.Chart.Identity, out var owner) && owner == job.Chart.Request.Id) identities.Remove(job.Chart.Identity);
    }
    public JobStatus? Pump(GamePhase phase)
    {
        if (Environment.CurrentManagedThreadId != mainThread) throw new ImportRejection("MAIN_THREAD_REQUIRED");
        Job job;
        lock (gate)
        {
            if (disposed || phase != GamePhase.Menu || pending.Count == 0) return null;
            job = jobs[pending.Dequeue()]; job.Status = job.Status with { State = "importing" };
        }
        JobStatus resultStatus;
        try
        {
            validator.RequireUnchanged(job.Chart);
            var result = adapter.Import(job.Chart);
            resultStatus = (result.Added || result.AlreadyPresent) && result.ListRefreshed && result.CachePersisted ? new(job.Chart.Request.Id, "ready", Deduplicated: result.AlreadyPresent) : new(job.Chart.Request.Id, "failed", "NATIVE_IMPORT_NOT_COMPLETE");
        }
        catch (ImportRejection error) { resultStatus = new(job.Chart.Request.Id, "failed", error.Code); }
        catch { resultStatus = new(job.Chart.Request.Id, "failed", "NATIVE_IMPORT_FAILED"); }
        lock (gate)
        {
            job.Status = resultStatus;
            if (job.Status.State is "failed" or "cancelled") ReleaseIdentity(job);
            history.Enqueue(job.Chart.Request.Id);
            while (history.Count > 256)
            {
                var old = history.Dequeue(); ReleaseIdentity(jobs[old]); jobs.Remove(old);
                foreach (var id in aliases.Where(entry => entry.Value.Owner == old).Select(entry => entry.Key).ToArray()) aliases.Remove(id);
            }
            return job.Status;
        }
    }
    public void Dispose()
    {
        lock (gate)
        {
            disposed = true; pending.Clear();
            foreach (var admission in admissions.Values) admission.Completion.TrySetResult(new(null, new ImportRejection("STOPPED")));
            admissions.Clear();
            foreach (var job in jobs.Values.Where(j => j.Status.State == "queued")) { job.Status = job.Status with { State = "cancelled", Code = "STOPPED" }; ReleaseIdentity(job); }
        }
    }
}
