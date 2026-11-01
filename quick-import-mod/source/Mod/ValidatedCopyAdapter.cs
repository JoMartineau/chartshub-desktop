namespace ChartsHub.QuickImport;

// Capability is opened only by Provider after all disposable-copy identity and
// isolation checks and an explicit validatedTestImport local setting.
internal sealed class ValidatedCopyAdapter : ISingleChartAdapter
{
    internal const string ExactBuild = "CH-1.1.0.6142-win-x64-12bc21e5a88a2fc9";
    private readonly Func<NativeImportExperiment?> experiment;
    public ValidatedCopyAdapter(Func<NativeImportExperiment?> experiment) => this.experiment = experiment;
    public bool ImportValidated => experiment() is not null;
    public string Build => ExactBuild;
    public NativeOutcome Import(PreparedChart chart) => (experiment() ?? throw new ImportRejection("NATIVE_ADAPTER_NOT_READY")).ImportVerified(chart);
}
