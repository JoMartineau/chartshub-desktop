using System.IO.Pipes;
using System.Text;

namespace ChartsHub.QuickImport;

// The pipe is user-local and processes one bounded control request per client.
// It never receives executable text or starts a game process.
public sealed class LocalPipeHost : IDisposable
{
    private readonly CancellationTokenSource cancellation = new();
    private readonly Task worker;
    public string PipeName { get; }
    public LocalPipeHost(string pipeName, LocalProtocol protocol)
    {
        if (!pipeName.StartsWith("ChartsHub.QuickImport.v1.", StringComparison.Ordinal) || pipeName.Length > 100 || pipeName.Any(c => !(c is >= 'a' and <= 'z' or >= 'A' and <= 'Z' or >= '0' and <= '9' || c == '.'))) throw new ArgumentException("Invalid owned pipe name");
        PipeName = pipeName; worker = Task.Run(async () =>
        {
            while (!cancellation.IsCancellationRequested)
            {
                try
                {
                    using var pipe = new NamedPipeServerStream(PipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly, 4096, 4096);
                    await pipe.WaitForConnectionAsync(cancellation.Token);
                    using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellation.Token); timeout.CancelAfter(TimeSpan.FromSeconds(5));
                    var buffer = new byte[LocalProtocol.MaxRequestBytes + 1]; int count = 0;
                    while (count < buffer.Length)
                    {
                        if (await pipe.ReadAsync(buffer.AsMemory(count, 1), timeout.Token) == 0) break;
                        if (buffer[count++] == 10) break;
                    }
                    var response = protocol.Handle(buffer.AsSpan(0, count > 0 && buffer[count - 1] == 10 ? count - 1 : count));
                    var output = Encoding.UTF8.GetBytes(response + "\n"); await pipe.WriteAsync(output, timeout.Token); await pipe.FlushAsync(timeout.Token);
                }
                catch (OperationCanceledException) { }
                catch (IOException) { }
            }
        });
    }
    public void Dispose() { cancellation.Cancel(); try { worker.Wait(TimeSpan.FromSeconds(6)); } catch (AggregateException) { } cancellation.Dispose(); }
}
