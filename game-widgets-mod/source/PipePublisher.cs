using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json;

namespace ChartsHub.CloneHero.Telemetry;

// One local client, explicit current-user ACL and authentication before export.
// The game thread only places immutable primitive records in a bounded queue.
internal sealed class PipePublisher : IDisposable
{
    private sealed record Event(string Attempt, int Player, long Sequence, string Type, object Data);
    private readonly BlockingCollection<Event> queue = new(1024);
    private readonly CancellationTokenSource stopped = new();
    private readonly string session = Guid.NewGuid().ToString();
    private readonly string pipeName = "ChartsHub.CloneHero.Telemetry." + Guid.NewGuid();
    private readonly string nonce = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
    private readonly string descriptor;
    private readonly string temporary;
    private readonly Task worker;
    private readonly ConcurrentDictionary<int, string> attempts = new();
    private long sequence;
    private long connectionGeneration;
    private volatile bool disposed;
    private volatile bool connected;
    private NamedPipeServerStream? activePipe;
    internal ConnectionSnapshot Connection { get { lock (queue) return new(connected, connectionGeneration); } }

    public PipePublisher(string? directory = null)
    {
        directory ??= Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ChartsHub", "Telemetry", "v1");
        directory = Path.GetFullPath(directory);
        RejectReparseAncestors(directory);
        var info = Directory.CreateDirectory(directory);
        RejectReparseAncestors(directory);
        var sid = WindowsIdentity.GetCurrent().User ?? throw new InvalidOperationException("No current user");
        var acl = new DirectorySecurity();
        acl.SetAccessRuleProtection(true, false);
        acl.SetOwner(sid);
        acl.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl,
            InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
        info.SetAccessControl(acl);
        RejectReparseAncestors(directory);
        descriptor = Path.Combine(directory, "connection.json");
        temporary = Path.Combine(directory, ".connection-" + Guid.NewGuid() + ".tmp");
        worker = Task.Run(Run);
    }

    public void Enqueue(string attemptId, int playerId, string type, object data)
    {
        if (disposed) return;
        attempts[playerId] = attemptId;
        if (!connected) return;
        lock (queue)
        {
            if (!connected) return;
            if (!queue.TryAdd(new(attemptId, playerId, ++sequence, type, data)))
            {
                // A gap invalidates cumulative timing. End the connection, so
                // the client starts a visibly partial segment on reconnect.
                connected = false;
                activePipe?.Dispose();
            }
        }
    }

    private async Task Run()
    {
        while (!stopped.IsCancellationRequested)
        {
            try
            {
                using var server = new NamedPipeServerStream(pipeName, PipeDirection.InOut, 1,
                    PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly, 65536, 65536);
                activePipe = server;
                PublishDescriptor();
                await server.WaitForConnectionAsync(stopped.Token);
                using (var authentication = CancellationTokenSource.CreateLinkedTokenSource(stopped.Token))
                {
                    authentication.CancelAfter(TimeSpan.FromSeconds(2));
                    string line = await ReadLine(server, 4096, authentication.Token);
                    using var json = JsonDocument.Parse(line, new JsonDocumentOptions { MaxDepth = 4 });
                    var root = json.RootElement;
                    if (root.ValueKind != JsonValueKind.Object || root.EnumerateObject().Count() != 2 ||
                        root.GetProperty("schema").GetString() != "chartshub.clonehero.handshake.v1" ||
                        root.GetProperty("nonce").GetString() is not string supplied || supplied.Length != 64 ||
                        !CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(supplied), Encoding.ASCII.GetBytes(nonce)))
                        throw new IOException("Authentication rejected");
                }
                lock (queue)
                {
                    while (queue.TryTake(out _)) { }
                    connectionGeneration++;
                    connected = true;
                    var snapshot = attempts.ToArray();
                    if (snapshot.Length == 0) snapshot = new[] { new KeyValuePair<int, string>(0, "idle") };
                    foreach (var player in snapshot)
                        queue.Add(new(player.Value, player.Key, ++sequence, "hello", new { capabilities = Provider.Capabilities, coverage = "since-connect" }));
                }
                long heartbeatAt = Stopwatch.GetTimestamp();
                while (server.IsConnected && connected && !stopped.IsCancellationRequested)
                {
                    Event? item;
                    if (queue.TryTake(out item, 250, stopped.Token))
                        await Write(server, item, stopped.Token);
                    else if (Stopwatch.GetTimestamp() - heartbeatAt >= Stopwatch.Frequency)
                    {
                        lock (queue)
                        {
                            var player = attempts.FirstOrDefault();
                            item = new(player.Value ?? "idle", player.Key, ++sequence, "heartbeat", new { });
                            if (!queue.TryAdd(item)) { connected = false; activePipe?.Dispose(); }
                        }
                        heartbeatAt = Stopwatch.GetTimestamp();
                    }
                }
            }
            catch (OperationCanceledException) when (stopped.IsCancellationRequested) { return; }
            catch (Exception) when (!stopped.IsCancellationRequested)
            {
                // No exception data, paths or nonces are logged or exported.
                try { File.Delete(temporary); } catch (Exception) { }
                await Task.Delay(250, stopped.Token);
            }
            finally { lock (queue) connected = false; activePipe = null; }
        }
    }

    private void PublishDescriptor()
    {
        stopped.Token.ThrowIfCancellationRequested();
        RejectReparseAncestors(Path.GetDirectoryName(descriptor)!);
        RejectReparseEntry(descriptor);
        RejectReparseEntry(temporary);
        var value = new { schema = "chartshub.clonehero.connection.v1", provider = Provider.ProviderIdentity,
            game = Provider.GameIdentity, pipeName, nonce, sessionId = session, pid = Environment.ProcessId };
        var bytes = JsonSerializer.SerializeToUtf8Bytes(value);
        if (bytes.Length > 4096) throw new IOException("Descriptor too large");
        using (var output = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
        { output.Write(bytes); output.Flush(true); }
        stopped.Token.ThrowIfCancellationRequested();
        RejectReparseAncestors(Path.GetDirectoryName(descriptor)!);
        RejectReparseEntry(descriptor);
        File.Move(temporary, descriptor, true);
    }

    internal static void RejectReparseAncestors(string directory)
    {
        string full = Path.GetFullPath(directory), root = Path.GetPathRoot(full)!;
        // Connection discovery is restricted to a local drive, never UNC or a
        // device path. Walk from the root, including every existing parent.
        if (root.Length != 3 || root[1] != ':') throw new IOException("Local directory required");
        string current = root;
        RejectReparseEntry(current);
        foreach (string component in full[root.Length..].Split(new[] { '\\', '/' }, StringSplitOptions.RemoveEmptyEntries))
        {
            current = Path.Combine(current, component);
            RejectReparseEntry(current);
        }
    }

    private static void RejectReparseEntry(string path)
    {
        try
        {
            if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
                throw new IOException("Reparse paths are not supported");
        }
        catch (FileNotFoundException) { }
        catch (DirectoryNotFoundException) { }
    }

    private bool DescriptorBelongsToSession()
    {
        RejectReparseAncestors(Path.GetDirectoryName(descriptor)!);
        RejectReparseEntry(descriptor);
        using var input = new FileStream(descriptor, FileMode.Open, FileAccess.Read, FileShare.Read);
        if (input.Length < 2 || input.Length > 4096) return false;
        var bytes = new byte[4097];
        int count = 0;
        while (count < bytes.Length)
        {
            int read = input.Read(bytes, count, bytes.Length - count);
            if (read == 0) break;
            count += read;
        }
        if (count > 4096) return false;
        using var current = JsonDocument.Parse(bytes.AsMemory(0, count), new JsonDocumentOptions { MaxDepth = 8 });
        return current.RootElement.GetProperty("sessionId").GetString() == session;
    }

    private async Task Write(Stream output, Event value, CancellationToken token)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(new { schema = "chartshub.clonehero.telemetry.v1",
            provider = Provider.ProviderIdentity, game = Provider.GameIdentity, sessionId = session,
            attemptId = value.Attempt, playerId = value.Player, sequence = value.Sequence, type = value.Type, data = value.Data });
        if (bytes.Length >= 65536) throw new IOException("Frame too large");
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token);
        deadline.CancelAfter(TimeSpan.FromSeconds(1));
        await output.WriteAsync(bytes, deadline.Token);
        await output.WriteAsync(new byte[] { 10 }, deadline.Token);
        await output.FlushAsync(deadline.Token);
    }

    private static async Task<string> ReadLine(Stream input, int limit, CancellationToken token)
    {
        var buffer = new byte[limit];
        var single = new byte[1];
        int count = 0;
        while (count < limit)
        {
            if (await input.ReadAsync(single, token) != 1) throw new EndOfStreamException();
            if (single[0] == 10) return new UTF8Encoding(false, true).GetString(buffer, 0, count);
            buffer[count++] = single[0];
        }
        throw new IOException("Handshake too large");
    }

    public void Dispose()
    {
        if (disposed) return;
        disposed = true;
        lock (queue) connected = false;
        stopped.Cancel();
        activePipe?.Dispose();
        // Only this provider's own descriptor may be removed.
        try
        {
            if (DescriptorBelongsToSession()) File.Delete(descriptor);
        }
        catch (Exception) { }
        try { RejectReparseAncestors(Path.GetDirectoryName(temporary)!); RejectReparseEntry(temporary); File.Delete(temporary); } catch (Exception) { }
    }
}
