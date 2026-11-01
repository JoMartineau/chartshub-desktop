using System.Diagnostics;
using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text;
using HarmonyLib;
using Il2CppInterop.Runtime.InteropTypes;
using Il2CppInterop.Runtime.InteropTypes.Arrays;

namespace ChartsHub.QuickImport;

// Explicit private experiment for the synthetic B fixture in the disposable copy.
// This never enables the product API or invokes a full scan/coroutine.
internal sealed class NativeImportExperiment : IDisposable
{
    internal static string InitializationStage { get; private set; } = "not-started";
    private static NativeImportExperiment? active;
    private readonly HarmonyLib.Harmony hooks = new("ca.chartshub.quick-import.synthetic-B.6142");
    private readonly int mainThread = Environment.CurrentManagedThreadId;
    private readonly string root, directory, songs, expectedCacheDirectory;
    private string cache;
    private readonly bool scalableImport, production;
    private readonly ChartValidator validator;
    private readonly Type entryType;
    private readonly ConstructorInfo constructor, metadataConstructor;
    private readonly MethodInfo parse, finalizeMetadata, validateChart, add, remove, rebuildViews, saveCache, observeMenuEnabled, refreshDispatcher, applyCurrentSort, convertAction, localizationInstance, localize, nativeCount, serializeTables, serializeEntry, cacheHashToArray;
    private readonly PropertyInfo masterList, entryFolder, entryName, entryChartName, workerOwner, workerCache, scanFlag, globalSingleton, metadataContext;
    private readonly MethodInfo chartPath;
    private readonly PropertyInfo[] workerWarnings;
    private readonly PropertyInfo cachedViews, currentSortIndex, sortDescriptors, catalogDirty, songCountText, uniqueSongPaths, nativeCacheHash;
    private readonly ConstructorInfo pointerConstructor;
    private readonly IncrementalFolderIndex<nint> folderIndex;
    private string? nativeContextFault;
    private string? knownNativeCacheSha256;
    private readonly Dictionary<Guid, string> processed = new();
    private object? worker, menu;
    private bool menuActive;
    private long lastTick;
    private string currentScene = "unknown", lastStatus = "";
    private object? preflightEntry;
    private string? preflightIdentity;
    private bool SafeMenu => (currentScene is "Main Menu" or "MainMenu") && menuActive && menu is not null && worker is not null;
    internal GamePhase Phase
    {
        get
        {
            if (!SafeMenu) return GamePhase.Unknown;
            if (nativeContextFault is not null) return GamePhase.Menu; // Fail a queued job with the precise code.
            try { var controller = workerOwner.GetValue(worker); if (controller is null || scanFlag.GetValue(controller) is not false) return GamePhase.Unknown; }
            catch { nativeContextFault = "NATIVE_SCAN_STATE_UNAVAILABLE"; return GamePhase.Menu; }
            return !scalableImport || folderIndex.FaultCode is not null || folderIndex.Ready ? GamePhase.Menu : GamePhase.Unknown;
        }
    }
    internal NativeOutcome ImportVerified(PreparedChart prepared)
    {
        if (Environment.CurrentManagedThreadId != mainThread) throw new ImportRejection("MAIN_THREAD_REQUIRED");
        if (Phase != GamePhase.Menu) throw new ImportRejection("SONG_MENU_REQUIRED");
        return scalableImport ? ImportScalable(prepared) : ImportOne(prepared);
    }
    internal NativeImportExperiment(string root, string directory, string scene, bool scalableImport = false, string? songsRoot = null, bool production = false)
    {
        if (active is not null) throw new InvalidOperationException();
        this.root = root; this.directory = directory; this.scalableImport = scalableImport; this.production = production; currentScene = scene;
        songs = songsRoot ?? Path.Combine(root, "PlayerData", "Songs"); cache = Path.Combine(root, "Clone Hero_Data", "songcache.bin"); validator = new(songs);
        var assembly = AppDomain.CurrentDomain.GetAssemblies().Single(a => a.GetName().Name == "Il2CppCloneHero");
        var nativeBase = Process.GetCurrentProcess().Modules.Cast<ProcessModule>().Single(m => string.Equals(m.ModuleName, "GameAssembly.dll", StringComparison.OrdinalIgnoreCase)).BaseAddress;
        Type NativeType(string name) => HookResolver.ResolveType(assembly, "CloneHero.dll", "", name);
        MethodBase Bind(Type type, uint token, int arity, int rva)
        {
            var binding = HookResolver.Resolve(type, token, arity); HookResolver.ValidateNativePointer(binding, nativeBase, rva); return binding.Method;
        }
        InitializationStage = "native-types";
        entryType = NativeType("SongEntry"); var list = NativeType("ʾʲʽʻʺʶʺʺʷʿʺ"); var workerType = NativeType("ʺˀʹʻˀʾʸʻʾʽʺ"); var menuType = NativeType("SongSelect"); var scan = NativeType("SongScan");
        InitializationStage = "native-method-contracts";
        constructor = (ConstructorInfo)Bind(entryType, 0x06000960, 2, 0x35fc60);
        if (!constructor.GetParameters().Select(p => p.ParameterType).SequenceEqual(new[] { typeof(string), typeof(bool) })) throw new InvalidOperationException("Constructor signature");
        parse = (MethodInfo)Bind(entryType, 0x0600095f, 0, 0x35b5d0); if (parse.ReturnType != typeof(bool)) throw new InvalidOperationException("Parser signature");
        finalizeMetadata = (MethodInfo)Bind(entryType, 0x06000926, 0, 0x35ace0);
        // This is the validator called by the active RVA 0x282c10 folder chain.
        // 0x3065 is an obfuscated divergent clone and must not be invoked.
        validateChart = (MethodInfo)Bind(workerType, 0x06003066, 1, 0x27e730);
        if (validateChart.ReturnType != typeof(bool) || validateChart.GetParameters()[0].ParameterType != entryType) throw new InvalidOperationException("Targeted chart-validator signature");
        chartPath = (MethodInfo)Bind(entryType, 0x06000929, 0, 0x3602c0);
        add = (MethodInfo)Bind(list, 0x06001e42, 1, 0x171d30); remove = (MethodInfo)Bind(list, 0x06001e3c, 1, 0x1726f0);
        rebuildViews = (MethodInfo)Bind(list, 0x06001e68, 0, 0x1719f0);
        saveCache = (MethodInfo)Bind(workerType, 0x0600306e, 0, 0x27f4b0);
        serializeTables = (MethodInfo)Bind(list, 0x06001e52, 1, 0x1716f0);
        serializeEntry = (MethodInfo)Bind(entryType, 0x06000942, 1, 0x35f050);
        if (serializeTables.ReturnType != typeof(void) || serializeEntry.ReturnType != typeof(void) || serializeTables.GetParameters()[0].ParameterType.FullName != "Il2CppSystem.IO.BinaryWriter" || serializeEntry.GetParameters()[0].ParameterType != serializeTables.GetParameters()[0].ParameterType) throw new InvalidOperationException("Native cache serialization signature");
        var cacheFormat = NativeType("ˀʼʶʻʺʽʵʾʽʷʹ"); nativeCacheHash = HookResolver.ResolveFieldProperty(cacheFormat, "ʷʺʻʷʻʹʴʷʵʾʴ");
        if (!HookResolver.HasOriginalType(nativeCacheHash.PropertyType, "StrikeCore.dll", "", "ˁʶʾʿʲʵʷʲʼʵʻ")) throw new InvalidOperationException("Native format hash type");
        cacheHashToArray = (MethodInfo)Bind(nativeCacheHash.PropertyType, 0x0600027c, 0, 0x20fa600);
        observeMenuEnabled = (MethodInfo)Bind(menuType, 0x06000fc7, 0, 0x883f0);
        refreshDispatcher = (MethodInfo)Bind(menuType, 0x06000fb2, 1, 0x89080);
        var nativeActionType = refreshDispatcher.GetParameters()[0].ParameterType;
        if (refreshDispatcher.ReturnType != typeof(void) || nativeActionType.FullName != "Il2CppSystem.Action") throw new InvalidOperationException("Menu dispatcher signature");
        convertAction = typeof(Il2CppInterop.Runtime.DelegateSupport).GetMethods(BindingFlags.Public | BindingFlags.Static).Single(method => method.Name == "ConvertDelegate" && method.IsGenericMethodDefinition && method.GetGenericArguments().Length == 1 && method.GetParameters().Select(p => p.ParameterType).SequenceEqual(new[] { typeof(Delegate) })).MakeGenericMethod(nativeActionType);
        applyCurrentSort = (MethodInfo)Bind(list, 0x06001e49, 1, 0x16fef0);
        if (applyCurrentSort.ReturnType != typeof(void) || applyCurrentSort.GetParameters()[0].ParameterType != typeof(string)) throw new InvalidOperationException("Current sort signature");
        var localizationType = NativeType("ʽʵʷˀʿʺʵʹʽʶˀ");
        localizationInstance = (MethodInfo)Bind(localizationType, 0x0600187b, 0, 0x12f120); localize = (MethodInfo)Bind(localizationType, 0x0600187c, 1, 0x12ee30);
        nativeCount = (MethodInfo)Bind(list, 0x06001e30, 0, 0x173740);
        if (!localizationInstance.IsStatic || localize.ReturnType != typeof(string) || localize.GetParameters()[0].ParameterType != typeof(string) || nativeCount.ReturnType != typeof(int)) throw new InvalidOperationException("Localized counter signature");
        songCountText = HookResolver.ResolveFieldProperty(menuType, "songCountText");
        var globals = NativeType("GlobalVariables"); var metadataType = NativeType("ʵʴʺˁʵʽʾʹʸʹˀ");
        globalSingleton = HookResolver.ResolveFieldProperty(globals, "instance"); metadataContext = HookResolver.ResolveFieldProperty(globals, "currentSongMetadata");
        uniqueSongPaths = HookResolver.ResolveFieldProperty(globals, "uniqueSongPaths");
        metadataConstructor = (ConstructorInfo)Bind(metadataType, 0x06002427, 0, 0x5570);
        InitializationStage = "native-master-list-field";
        masterList = HookResolver.ResolveFieldProperty(list, "ʽʽʶʳʲʶʻʿʾʶʴ"); entryFolder = HookResolver.ResolveFieldProperty(entryType, "folderPath"); entryChartName = HookResolver.ResolveFieldProperty(entryType, "chartName");
        pointerConstructor = entryType.GetConstructor(new[] { typeof(nint) }) ?? throw new MissingMethodException("Interop entry pointer wrapper");
        folderIndex = new(ReadListStamp, ReadIndexEntry);
        cachedViews = HookResolver.ResolveFieldProperty(list, "ʳˀʸʿʹʸʻˀʴʿʲ");
        currentSortIndex = HookResolver.ResolveFieldProperty(list, "ʽʷˀʶʵʼˁʻʺʾʼ"); sortDescriptors = HookResolver.ResolveFieldProperty(list, "ʴʻʻʻʲʺʼʷʻʼʻ"); catalogDirty = HookResolver.ResolveFieldProperty(list, "ʴʾˀʺʷʽʳʳˀʽʲ");
        entryName = entryType.GetProperty("Name_StrippedTags", BindingFlags.Public | BindingFlags.Instance) ?? throw new MissingMemberException("Name wrapper");
        InitializationStage = "native-worker-fields";
        workerOwner = HookResolver.ResolveFieldProperty(workerType, "ʼʼʲʶʲʾʳʹʴʴˁ"); workerCache = HookResolver.ResolveFieldProperty(workerType, "ʺˁʺʳʹʶʺʶʿʳʾ"); scanFlag = HookResolver.ResolveFieldProperty(scan, "isScanning");
        workerWarnings = new[] { "ʾʽʵʿʺʴʷʾʹʻˁ", "ʲʲʿˀʾʻʻʺʾʶˁ", "ʵʵˀʾʷʶʲʹʼʴʵ", "ʵʻʳʳʻʾʹʶˀʳʽ" }.Select(name => HookResolver.ResolveFieldProperty(workerType, name)).ToArray();
        InitializationStage = "unity-persistent-path-type";
        // Facade assemblies can forward this type. Select the unique actual
        // Type rather than counting assemblies that can resolve its name.
        var application = AppDomain.CurrentDomain.GetAssemblies().Select(a => a.GetType("UnityEngine.Application", false)).Where(type => type is not null).Distinct().Single()!;
        if (!HookResolver.HasOriginalType(application, "UnityEngine.CoreModule.dll", "UnityEngine", "Application")) throw new InvalidOperationException("Native Unity application identity");
        InitializationStage = "unity-persistent-path-method";
        var persistent = (MethodInfo)Bind(application, 0x060000fc, 0, 0x2859290);
        if (!persistent.IsStatic || persistent.ReturnType != typeof(string)) throw new InvalidOperationException("Native persistent-data path signature");
        InitializationStage = "unity-persistent-path-read";
        expectedCacheDirectory = Canonical((string?)persistent.Invoke(null, null) ?? throw new ImportRejection("NATIVE_CACHE_DIRECTORY_UNAVAILABLE"));
        if (!production && !string.Equals(expectedCacheDirectory, Path.Combine(root, "Clone Hero_Data"), StringComparison.OrdinalIgnoreCase)) throw new ImportRejection("COPY_CACHE_DIRECTORY_CHANGED");
        try
        {
            InitializationStage = "native-observation-hooks";
            active = this;
            hooks.Patch(Bind(workerType, 0x06003086, 1, 0x27da30), prefix: new HarmonyMethod(typeof(NativeImportExperiment), nameof(CacheReadStarting)), postfix: new HarmonyMethod(typeof(NativeImportExperiment), nameof(CacheReadFinished)));
            hooks.Patch(saveCache, postfix: new HarmonyMethod(typeof(NativeImportExperiment), nameof(WorkerObserved)));
            hooks.Patch(observeMenuEnabled, postfix: new HarmonyMethod(typeof(NativeImportExperiment), nameof(MenuEnabled)));
            hooks.Patch(Bind(menuType, 0x06000fcb, 0, 0x882b0), prefix: new HarmonyMethod(typeof(NativeImportExperiment), nameof(MenuDisabled)));
            WriteStatus("waiting-for-private-request", new { nativeImportValidated = false });
            InitializationStage = "ready";
        }
        catch { active = null; hooks.UnpatchSelf(); throw; }
    }
    private static void CacheReadStarting(object __instance, out string? __state)
    {
        __state = null;
        if (active is not { } owner) return;
        try
        {
            var path = Canonical((string?)owner.workerCache.GetValue(__instance) ?? "");
            if (!path.StartsWith(owner.expectedCacheDirectory + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) || !File.Exists(path)) return;
            ChartValidator.NoLinks(path); __state = Digest(path);
        }
        catch { /* Never change the native loader's behavior. The postfix fails closed. */ }
    }
    private static void CacheReadFinished(object __instance, string? __state) => ObserveWorker(__instance, __state, requireLoadFence: true);
    private static void WorkerObserved(object __instance) => ObserveWorker(__instance, null, requireLoadFence: false);
    private static void ObserveWorker(object __instance, string? expectedLoadHash, bool requireLoadFence)
    {
        if (active is not { } owner) return;
        owner.worker = __instance;
        try
        {
            var path = Canonical((string?)owner.workerCache.GetValue(__instance) ?? throw new ImportRejection("NATIVE_CACHE_PATH_UNAVAILABLE"));
            if (!path.StartsWith(owner.expectedCacheDirectory + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new ImportRejection("NATIVE_CACHE_OUTSIDE_PERSISTENT_DATA");
            owner.cache = path;
            if (!File.Exists(path)) throw new ImportRejection("NATIVE_CACHE_MISSING_INITIAL_SCAN_REQUIRED");
            ChartValidator.NoLinks(path);
            var digest = Digest(path);
            if (requireLoadFence && (expectedLoadHash is null || digest != expectedLoadHash)) throw new ImportRejection("NATIVE_CACHE_CHANGED_DURING_NATIVE_LOAD");
            owner.knownNativeCacheSha256 = digest; owner.nativeContextFault = null;
        }
        catch (ImportRejection error) { owner.nativeContextFault = error.Code; }
        catch { owner.nativeContextFault = "NATIVE_CACHE_CONTEXT_UNAVAILABLE"; }
    }
    private static void MenuEnabled(object __instance) { if (active is { } owner) { owner.menu = __instance; owner.menuActive = true; } }
    private static void MenuDisabled() { if (active is { } owner) owner.menuActive = false; }
    internal void SetScene(string scene) { currentScene = scene.Length <= 128 ? scene : "unknown"; if (currentScene is not ("Main Menu" or "MainMenu")) menuActive = false; }
    private static string Canonical(string path) => Path.GetFullPath(path).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
    private object NativeList() => masterList.GetValue(null) ?? throw new ImportRejection("NATIVE_MASTER_UNAVAILABLE");
    private NativeListStamp ReadListStamp()
    {
        var list = NativeList();
        if (list is not Il2CppObjectBase wrapper || wrapper.Pointer == IntPtr.Zero) throw new ImportRejection("NATIVE_LIST_POINTER_CONTRACT");
        return new(wrapper.Pointer, (int)(list.GetType().GetProperty("Count")?.GetValue(list) ?? throw new ImportRejection("NATIVE_LIST_COUNT_CONTRACT")), (int)(list.GetType().GetProperty("_version")?.GetValue(list) ?? throw new ImportRejection("NATIVE_LIST_VERSION_CONTRACT")));
    }
    private (string Folder, nint Value) ReadIndexEntry(int index)
    {
        var list = NativeList(); var item = list.GetType().GetProperty("Item")?.GetValue(list, new object[] { index });
        if (item is not Il2CppObjectBase wrapper || wrapper.Pointer == IntPtr.Zero) throw new ImportRejection("NATIVE_ENTRY_POINTER_CONTRACT");
        return (Folder(item), wrapper.Pointer);
    }
    private void RequireNativeSongsRoot()
    {
        var globals = globalSingleton.GetValue(null) ?? throw new ImportRejection("NO_GLOBAL_CONTEXT");
        var roots = uniqueSongPaths.GetValue(globals) ?? throw new ImportRejection("NATIVE_SONG_ROOTS_UNAVAILABLE");
        var count = (int)(roots.GetType().GetProperty("Count")?.GetValue(roots) ?? throw new ImportRejection("NATIVE_SONG_ROOT_COUNT"));
        if (count is < 1 or > 1024) throw new ImportRejection("NATIVE_SONG_ROOT_LIMIT");
        var item = roots.GetType().GetProperty("Item") ?? throw new ImportRejection("NATIVE_SONG_ROOT_ITEM");
        for (int i = 0; i < count; i++) if (item.GetValue(roots, new object[] { i }) is string path && string.Equals(Canonical(path), Canonical(songs), StringComparison.OrdinalIgnoreCase)) return;
        throw new ImportRejection("SONGS_ROOT_NOT_CONFIGURED_IN_GAME");
    }
    internal void AdvanceIndex()
    {
        if (!scalableImport || !SafeMenu) return;
        if (nativeContextFault?.StartsWith("NATIVE_CACHE_", StringComparison.Ordinal) is true || nativeContextFault == "NATIVE_IMPORT_ROLLBACK_INCOMPLETE") return;
        try { var controller = workerOwner.GetValue(worker); if (controller is null || scanFlag.GetValue(controller) is not false) return; RequireNativeSongsRoot(); folderIndex.BuildSlice(TimeSpan.FromMilliseconds(2), 128); nativeContextFault = null; }
        catch (ImportRejection error) { nativeContextFault = error.Code; }
        catch { nativeContextFault = "NATIVE_INDEX_CONTEXT_UNAVAILABLE"; }
    }
    private object[] Entries()
    {
        var list = masterList.GetValue(null) ?? throw new InvalidOperationException("No native master list");
        var count = (int)(list.GetType().GetProperty("Count")?.GetValue(list) ?? throw new InvalidOperationException());
        if (count is < 0 or > 10000) throw new InvalidOperationException("Unexpected disposable library size");
        var item = list.GetType().GetProperty("Item") ?? throw new InvalidOperationException("List item wrapper");
        return Enumerable.Range(0, count).Select(i => item.GetValue(list, new object[] { i }) ?? throw new InvalidOperationException()).ToArray();
    }
    private string Folder(object entry) => Path.GetFullPath((string)(entryFolder.GetValue(entry) ?? throw new InvalidOperationException())).TrimEnd(Path.DirectorySeparatorChar);
    private object Describe(object entry)
    {
        object? Value(string name) => (entryType.GetProperty(name, BindingFlags.Public | BindingFlags.Instance) ?? throw new MissingMemberException("Entry inventory contract")).GetValue(entry);
        var folder = Folder(entry);
        if (!folder.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new ImportRejection("FOREIGN_NATIVE_ENTRY");
        var ini = (string?)Value("IniPath") ?? ""; var chart = (string?)Value("ChartPath") ?? "";
        var tracks = Value("tracksAvailable") ?? throw new MissingMemberException("Entry tracks contract");
        var trackBits = (long)(tracks.GetType().GetFields(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance).Single(field => field.FieldType == typeof(long)).GetValue(tracks) ?? throw new MissingMemberException("Track bitfield contract"));
        return new { folder, title = Value("Name_StrippedTags"), artist = Value("Artist_StrippedTags"), charter = Value("Charter_StrippedTags"), album = Value("Album_StrippedTags"), year = Value("Year_StrippedTags"), durationMs = Value("songLength"), trackBits, checksum = Value("ChecksumString"), isEnc = Value("isEnc"), isSng = Value("isSng"), iniPath = ini, chartPath = chart, iniExists = File.Exists(ini), chartExists = File.Exists(chart) };
    }
    private string[] Snapshot() => Entries().Select(e => JsonSerializer.Serialize(Describe(e))).OrderBy(x => x, StringComparer.OrdinalIgnoreCase).ToArray();
    private void InvalidateViewsOnly(bool validateOnly = false)
    {
        var views = cachedViews.GetValue(null); if (views is null) return;
        var length = Convert.ToInt32(views.GetType().GetProperty("Length")?.GetValue(views) ?? throw new ImportRejection("NATIVE_VIEW_CACHE_CONTRACT"));
        if (length is < 0 or > 128) throw new ImportRejection("NATIVE_VIEW_CACHE_LIMIT");
        var indexers = views.GetType().GetProperties().Where(property => property.SetMethod is not null && property.GetIndexParameters().Length == 1 && property.GetIndexParameters()[0].ParameterType is { } type && (type == typeof(int) || type == typeof(long))).ToArray();
        if (indexers.Length != 1) throw new ImportRejection("NATIVE_VIEW_INDEXER_CONTRACT");
        var indexer = indexers[0]; var longIndex = indexer.GetIndexParameters()[0].ParameterType == typeof(long);
        if (validateOnly) return;
        for (int i = 0; i < length; i++) indexer.SetValue(views, null, new object[] { longIndex ? (object)(long)i : i });
        // Do NOT invoke 0x16fd70: its tailcall 0x1769f0 destroys all metadata
        // tables, invalidating both existing entry indexes and native cache.
    }
    private string CurrentSort()
    {
        // Native ApplySort clears the metadata registry if this flag is true.
        // Never force that flag or call RefreshCurrentSort/OnEnable as a shortcut.
        if (catalogDirty.GetValue(null) is not false) throw new ImportRejection("CATALOG_DIRTY_REQUIRES_NATIVE_REFRESH");
        var index = (int)(currentSortIndex.GetValue(null) ?? throw new ImportRejection("NO_CURRENT_SORT"));
        var descriptors = sortDescriptors.GetValue(null) ?? throw new ImportRejection("NO_SORT_DESCRIPTORS");
        var length = Convert.ToInt32(descriptors.GetType().GetProperty("Length")?.GetValue(descriptors) ?? throw new ImportRejection("SORT_ARRAY_CONTRACT"));
        if (length is < 1 or > 128 || index < 0 || index >= length) throw new ImportRejection("SORT_INDEX_CONTRACT");
        var item = descriptors.GetType().GetProperties().Single(property => property.GetMethod is not null && property.GetIndexParameters().Length == 1);
        var sort = item.GetValue(descriptors, new object[] { item.GetIndexParameters()[0].ParameterType == typeof(long) ? (object)(long)index : index }) as string;
        if (string.IsNullOrWhiteSpace(sort) || sort.Length > 128) throw new ImportRejection("SORT_NAME_CONTRACT");
        return sort;
    }
    private void RefreshNativeMenu()
    {
        if (!menuActive || menu is null) throw new ImportRejection("SONG_MENU_NOT_ACTIVE");
        var sort = CurrentSort(); InvalidateViewsOnly(true);
        bool invoked = false; Exception? callbackFailure = null;
        Action callback = () =>
        {
            try
            {
                if (Environment.CurrentManagedThreadId != mainThread || CurrentSort() != sort) throw new ImportRejection("MENU_REFRESH_CONTEXT_CHANGED");
                invoked = true; InvalidateViewsOnly(); rebuildViews.Invoke(null, null); applyCurrentSort.Invoke(null, new object[] { sort });
                if (catalogDirty.GetValue(null) is not false) throw new ImportRejection("MENU_REFRESH_LEFT_DIRTY");
            }
            catch (Exception error) { callbackFailure = error; }
        };
        var nativeAction = convertAction.Invoke(null, new object[] { callback }) ?? throw new ImportRejection("MENU_ACTION_BRIDGE_UNAVAILABLE");
        // Dispatcher saves/restores selection and rebuilds actual menu rows.
        // Its Action only reapplies the existing sort, never changes a filter.
        try { refreshDispatcher.Invoke(menu, new[] { nativeAction }); }
        finally { GC.KeepAlive(callback); GC.KeepAlive(nativeAction); }
        if (!invoked) throw new ImportRejection("MENU_ACTION_NOT_INVOKED");
        if (callbackFailure is not null) throw new ImportRejection("MENU_ACTION_FAILED");
        var localization = localizationInstance.Invoke(null, null) ?? throw new ImportRejection("LOCALIZATION_UNAVAILABLE");
        var label = songCountText.GetValue(menu) ?? throw new ImportRejection("SONG_COUNT_LABEL_UNAVAILABLE");
        var text = label.GetType().GetProperty("text") ?? throw new ImportRejection("SONG_COUNT_TEXT_CONTRACT");
        // Same localized key and count getter as the native offline OnEnable branch.
        text.SetValue(label, (string?)localize.Invoke(localization, new object[] { "Songs" }) + ": " + nativeCount.Invoke(null, null));
    }
    private static string Digest(string file) { using var input = File.OpenRead(file); using var algorithm = SHA256.Create(); return Convert.ToHexString(algorithm.ComputeHash(input)).ToLowerInvariant(); }
    internal void Tick()
    {
        if (Environment.CurrentManagedThreadId != mainThread) throw new InvalidOperationException("Main thread required");
        if (Environment.TickCount64 - lastTick < 750) return; lastTick = Environment.TickCount64;
        try
        {
            var requestFile = Path.Combine(directory, "EXPERIMENT-REQUEST.json");
            if (!File.Exists(requestFile)) { WriteStatus("waiting-for-private-request", new { scene = currentScene, menuActive, workerCaptured = worker is not null, entries = Entries().Length }); return; }
            ChartValidator.NoLinks(requestFile); if (new FileInfo(requestFile).Length > 8192) throw new ImportRejection("OVERSIZED_EXPERIMENT_REQUEST");
            using var doc = JsonDocument.Parse(File.ReadAllBytes(requestFile), new JsonDocumentOptions { MaxDepth = 4 }); var request = doc.RootElement;
            var action = request.GetProperty("action").GetString();
            if (request.GetProperty("schema").GetInt32() != 1 || action is not ("import-single-fixture-B" or "preflight-single-fixture-B" or "import-single-fixture-C" or "preflight-single-fixture-C" or "import-single-fixture-D" or "preflight-single-fixture-D")) throw new ImportRejection("EXPERIMENT_ONLY");
            var id = request.GetProperty("id").GetGuid(); var sha = request.GetProperty("chartSha256").GetString() ?? "";
            if (processed.TryGetValue(id, out var prior)) { if (prior != sha) throw new ImportRejection("REQUEST_ID_CONFLICT"); return; }
            if (currentScene is not ("Main Menu" or "MainMenu") || worker is null) { WriteStatus("waiting-for-main-menu", new { scene = currentScene, menuActive, workerCaptured = worker is not null }); return; }
            if (action.StartsWith("import-", StringComparison.Ordinal) && (!menuActive || menu is null)) { WriteStatus("waiting-for-song-selection-menu", new { scene = currentScene, menuActive, workerCaptured = worker is not null }); return; }
            var fixture = action[^1..]; var target = Path.Combine(songs, fixture);
            var prepared = validator.Prepare(new(id, target, fixture == "D" ? "notes.mid" : "notes.chart", sha)); validator.RequireUnchanged(prepared);
            processed.Add(id, sha); if (processed.Count > 16) throw new ImportRejection("EXPERIMENT_LIMIT");
            if (action.StartsWith("preflight-", StringComparison.Ordinal)) { Preflight(prepared); return; }
            ImportOne(prepared);
        }
        catch (Exception error) { WriteStatus("experiment-refused", new { code = error is ImportRejection rejection ? rejection.Code : "EXPERIMENT_CONTEXT_UNAVAILABLE", scene = currentScene }); }
    }
    private object ParseDetached(PreparedChart prepared)
    {
        var globals = globalSingleton.GetValue(null) ?? throw new ImportRejection("NO_GLOBAL_CONTEXT");
        var previous = metadataContext.GetValue(globals);
        var temporary = metadataConstructor.Invoke(Array.Empty<object>());
        // The active Windows scanner lowercases folder paths before construction.
        // Only native entry text is normalized; no real file or folder is renamed.
        var entry = constructor.Invoke(new object[] { Canonical(prepared.CanonicalFolder).ToLowerInvariant(), true });
        // The API already specifies one validated chart file. The constructor
        // leaves chartName null; the native type/path getters require it.
        entryChartName.SetValue(entry, prepared.Request.ChartFile);
        if (!string.Equals((string?)chartPath.Invoke(entry, null), Path.Combine(prepared.CanonicalFolder, prepared.Request.ChartFile), StringComparison.OrdinalIgnoreCase)) throw new ImportRejection("NATIVE_CHART_PATH_DIFFERS");
        var warningLists = workerWarnings.Select(property => property.GetValue(worker) ?? throw new ImportRejection("NO_NATIVE_WARNING_LIST")).ToArray();
        var warningCounts = warningLists.Select(list => (int)(list.GetType().GetProperty("Count")?.GetValue(list) ?? throw new ImportRejection("NATIVE_WARNING_LIST_CONTRACT"))).ToArray();
        if (warningCounts.Any(count => count < 0)) throw new ImportRejection("NATIVE_WARNING_LIST_LIMIT");
        metadataContext.SetValue(globals, temporary);
        try
        {
            if (parse.Invoke(entry, null) is not true) throw new ImportRejection("NATIVE_FOLDER_PARSE_REJECTED");
            finalizeMetadata.Invoke(entry, null);
            if (validateChart.Invoke(worker, new[] { entry }) is not true) throw new ImportRejection("NATIVE_TARGETED_CHART_REJECTED");
            return entry;
        }
        finally
        {
            metadataContext.SetValue(globals, previous);
            // The targeted validator can append warnings to its scan worker.
            // No stale warning is left behind by this detached operation.
            for (int i = 0; i < warningLists.Length; i++)
            {
                var list = warningLists[i]; var count = (int)list.GetType().GetProperty("Count")!.GetValue(list)!;
                if (count < warningCounts[i] || count > 2048) throw new ImportRejection("NATIVE_WARNING_LIST_MUTATED");
                if (count > warningCounts[i]) list.GetType().GetMethod("RemoveRange", new[] { typeof(int), typeof(int) })!.Invoke(list, new object[] { warningCounts[i], count - warningCounts[i] });
            }
        }
    }
    private void Preflight(PreparedChart prepared)
    {
        var before = Snapshot(); var digest = Digest(cache);
        try
        {
            var owner = workerOwner.GetValue(worker) ?? throw new ImportRejection("NO_SCAN_CONTROLLER");
            if (scanFlag.GetValue(owner) is not false) throw new ImportRejection("NATIVE_SCAN_IN_PROGRESS");
            InvalidateViewsOnly(validateOnly: true);
            preflightEntry = ParseDetached(prepared); validator.RequireUnchanged(prepared); preflightIdentity = prepared.Identity;
            if (!before.SequenceEqual(Snapshot()) || digest != Digest(cache)) throw new ImportRejection("PREFLIGHT_MUTATED_LIBRARY");
            WritePreflight(prepared, "detached-native-parse-ready", new { entry = Describe(preflightEntry), existingEntries = before.Length, libraryUnchanged = true, cacheUnchanged = true, fullScanInvoked = false, nativeImportValidated = false });
        }
        catch (Exception error)
        {
            preflightEntry = null; preflightIdentity = null;
            var cause = error is TargetInvocationException invocation ? invocation.InnerException ?? error : error;
            WritePreflight(prepared, "detached-native-parse-refused", new { code = error is ImportRejection rejection ? rejection.Code : "NATIVE_PREFLIGHT_FAILED", exceptionType = cause.GetType().FullName, summary = cause.Message.Replace(root, "<test-copy>", StringComparison.OrdinalIgnoreCase)[..Math.Min(cause.Message.Replace(root, "<test-copy>", StringComparison.OrdinalIgnoreCase).Length, 1024)], libraryUnchanged = before.SequenceEqual(Snapshot()), cacheUnchanged = digest == Digest(cache), fullScanInvoked = false });
        }
    }
    private void WritePreflight(PreparedChart prepared, string state, object detail)
    {
        File.WriteAllText(Path.Combine(directory, "EXPERIMENT-PREFLIGHT.json"), JsonSerializer.Serialize(new { schema = 1, id = prepared.Request.Id, state, utc = DateTime.UtcNow, detail }, new JsonSerializerOptions { WriteIndented = true }));
        WriteStatus(state, new { scene = currentScene, menuActive, workerCaptured = worker is not null, entries = Entries().Length });
    }
    private byte[] SerializeNativeBlock(Action<object> write)
    {
        var writerType = serializeTables.GetParameters()[0].ParameterType;
        var memoryType = writerType.Assembly.GetType("Il2CppSystem.IO.MemoryStream", true)!;
        var memory = memoryType.GetConstructor(Type.EmptyTypes)?.Invoke(null) ?? throw new ImportRejection("NATIVE_MEMORY_STREAM_CONTRACT");
        var create = writerType.GetConstructors().Single(ctor => ctor.GetParameters().Length == 1 && ctor.GetParameters()[0].ParameterType.IsAssignableFrom(memoryType));
        var writer = create.Invoke(new[] { memory });
        try
        {
            write(writer);
            writerType.GetMethod("Flush", Type.EmptyTypes)?.Invoke(writer, null);
            if (memoryType.GetMethod("ToArray", Type.EmptyTypes)?.Invoke(memory, null) is not Il2CppStructArray<byte> bytes || bytes.Length > AtomicCacheUpdate.MaxCacheBytes) throw new ImportRejection("NATIVE_SERIALIZED_BYTES_CONTRACT");
            return bytes.ToArray();
        }
        finally { writerType.GetMethod("Dispose", Type.EmptyTypes)?.Invoke(writer, null); GC.KeepAlive(memory); }
    }
    private byte[] SerializeSingleton(byte[] original, object entry, PreparedChart prepared)
    {
        var tables = SerializeNativeBlock(writer => serializeTables.Invoke(null, new[] { writer }));
        var payload = SerializeNativeBlock(writer => serializeEntry.Invoke(entry, new[] { writer }));
        using var output = new MemoryStream();
        using (var writer = new BinaryWriter(output, Encoding.UTF8, true))
        {
            writer.Write(original, 0, 20); writer.Write(tables); writer.Write(1);
            writer.Write(Folder(entry));
            // Exactly the native writer's prefix, but only for the new chart.
            writer.Write(File.GetLastWriteTimeUtc(Path.Combine(prepared.CanonicalFolder, "song.ini")).ToBinary());
            writer.Write(File.GetLastWriteTimeUtc(Path.Combine(prepared.CanonicalFolder, prepared.Request.ChartFile)).ToBinary());
            writer.Write(payload);
        }
        return output.ToArray();
    }
    private string NativeChecksum(object entry) => (string?)entryType.GetProperty("ChecksumString")?.GetValue(entry) ?? throw new ImportRejection("NATIVE_CHECKSUM_UNAVAILABLE");
    private void RequireActiveCacheFormat(byte[] bytes)
    {
        var current = nativeCacheHash.GetValue(null) ?? throw new ImportRejection("NATIVE_FORMAT_HASH_UNAVAILABLE");
        if (cacheHashToArray.Invoke(current, null) is not Il2CppStructArray<byte> identity || identity.Length != 16 || bytes.Length < 20 || !bytes.AsSpan(4, 16).SequenceEqual(identity.ToArray())) throw new ImportRejection("CACHE_FORMAT_NOT_CURRENT_NATIVE_VERSION");
    }
    private NativeOutcome ImportScalable(PreparedChart prepared)
    {
        if (nativeContextFault is not null) throw new ImportRejection(nativeContextFault);
        if (folderIndex.FaultCode is { } fault) throw new ImportRejection("NATIVE_INDEX_" + fault);
        if (!folderIndex.Ready) throw new ImportRejection("NATIVE_INDEX_NOT_READY");
        RequireNativeSongsRoot(); _ = CurrentSort(); InvalidateViewsOnly(true);
        var owner = workerOwner.GetValue(worker) ?? throw new ImportRejection("NO_SCAN_CONTROLLER");
        if (scanFlag.GetValue(owner) is not false) throw new ImportRejection("NATIVE_SCAN_IN_PROGRESS");
        if (!string.Equals(Canonical((string?)workerCache.GetValue(worker) ?? ""), cache, StringComparison.OrdinalIgnoreCase)) throw new ImportRejection("NATIVE_CACHE_PATH_CHANGED");
        validator.RequireUnchanged(prepared);
        var before = ReadListStamp(); var original = AtomicCacheUpdate.ReadBounded(cache);
        if (knownNativeCacheSha256 is null || AtomicCacheUpdate.Digest(original) != knownNativeCacheSha256) throw new ImportRejection("NATIVE_CACHE_CHANGED_SINCE_LOAD");
        RequireActiveCacheFormat(original);
        if (folderIndex.TryGet(Canonical(prepared.CanonicalFolder), out var existingPointer))
        {
            var existing = pointerConstructor.Invoke(new object[] { existingPointer });
            if (!string.Equals((string?)chartPath.Invoke(existing, null), Path.Combine(prepared.CanonicalFolder, prepared.Request.ChartFile), StringComparison.OrdinalIgnoreCase)) throw new ImportRejection("EXISTING_CHART_FILE_DIFFERS");
            string currentChecksum; using (var input = File.OpenRead(Path.Combine(prepared.CanonicalFolder, prepared.Request.ChartFile))) using (var md5 = MD5.Create()) currentChecksum = Convert.ToHexString(md5.ComputeHash(input));
            if (!string.Equals(currentChecksum, NativeChecksum(existing), StringComparison.OrdinalIgnoreCase)) throw new ImportRejection("EXISTING_CHART_CONTENT_CHANGED");
            NativeCacheFormat.ValidateExisting(original, before.Count, Folder(existing), prepared.Request.ChartFile, currentChecksum);
            RefreshNativeMenu();
            if (ReadListStamp() != before) throw new ImportRejection("DUPLICATE_CHANGED_NATIVE_LIST");
            WriteReport(prepared, "already-present", new { entries = before.Count, parserInvoked = false, oldChartFilesInspected = 0, cacheSha256 = AtomicCacheUpdate.Digest(original), scalableImport = true });
            return new(false, true, true, AlreadyPresent: true);
        }
        object? entry = null; bool inserted = false; AtomicCacheUpdate? update = null;
        var stage = "parse-new-folder"; var started = Stopwatch.StartNew();
        try
        {
            entry = ParseDetached(prepared); validator.RequireUnchanged(prepared);
            if (ReadListStamp() != before) throw new ImportRejection("NATIVE_LIST_CHANGED_DURING_PARSE");
            var parseMilliseconds = started.Elapsed.TotalMilliseconds;
            stage = "append-native-entry"; add.Invoke(null, new[] { entry }); inserted = true;
            var after = ReadListStamp();
            if (entry is not Il2CppObjectBase wrapper || !folderIndex.CommitAppend(before, after, Folder(entry), wrapper.Pointer)) throw new ImportRejection("NATIVE_APPEND_INDEX_MISMATCH");
            stage = "serialize-only-new-entry";
            var singleton = SerializeSingleton(original, entry, prepared);
            var merged = NativeCacheFormat.Append(original, singleton, knownNativeCacheSha256, before.Count, Folder(entry), prepared.Request.ChartFile, NativeChecksum(entry));
            var serializationMilliseconds = started.Elapsed.TotalMilliseconds - parseMilliseconds;
            if (ReadListStamp() != after) throw new ImportRejection("NATIVE_LIST_CHANGED_BEFORE_COMMIT");
            validator.RequireUnchanged(prepared);
            stage = "atomic-cache-commit";
            update = AtomicCacheUpdate.Commit(cache, directory, prepared.Request.Id, original, merged.Bytes);
            stage = "refresh-native-menu"; RefreshNativeMenu();
            if (ReadListStamp() != after || !folderIndex.TryGet(Folder(entry), out var indexed) || indexed != wrapper.Pointer) throw new ImportRejection("NATIVE_LIST_CHANGED_AFTER_COMMIT");
            knownNativeCacheSha256 = update.AfterSha256;
            WriteReport(prepared, "native-import-complete", new { beforeEntries = before.Count, afterEntries = after.Count, scalableImport = true, oldChartFilesInspected = 0, fullScanInvoked = false, nativeFullCacheWriterInvoked = false, onlyNewEntrySerialized = true, merged.OriginalSha256, merged.MergedSha256, merged.PreservedRecordsSha256, merged.AppendedRecordSha256, parseMilliseconds, serializationMilliseconds, totalMilliseconds = started.Elapsed.TotalMilliseconds });
            return new(true, true, true);
        }
        catch (Exception error)
        {
            bool nativeRestored = !inserted, cacheRestored = false;
            try { cacheRestored = update is null && AtomicCacheUpdate.Digest(AtomicCacheUpdate.ReadBounded(cache)) == AtomicCacheUpdate.Digest(original); } catch { }
            try { if (inserted && entry is not null) { remove.Invoke(null, new[] { entry }); nativeRestored = ReadListStamp().Count == before.Count; } } catch { nativeRestored = false; }
            if (update is not null) cacheRestored = update.Rollback();
            if (cacheRestored) knownNativeCacheSha256 = AtomicCacheUpdate.Digest(original);
            try { if (nativeRestored) RefreshNativeMenu(); } catch { nativeRestored = false; }
            if (!nativeRestored || !cacheRestored) nativeContextFault = "NATIVE_IMPORT_ROLLBACK_INCOMPLETE";
            WriteReport(prepared, "scalable-import-refused", new { stage, code = error is ImportRejection rejected ? rejected.Code : "NATIVE_IMPORT_FAILED", nativeRestored, cacheRestored, foreignCachePreserved = !cacheRestored, oldChartFilesInspected = 0, fullScanInvoked = false });
            throw new ImportRejection(nativeContextFault ?? (error is ImportRejection rejection ? rejection.Code : "NATIVE_IMPORT_FAILED_ROLLED_BACK"));
        }
    }
    private NativeOutcome ImportOne(PreparedChart prepared)
    {
        var before = Snapshot(); var existing = Entries().Where(e => string.Equals(Folder(e), prepared.CanonicalFolder, StringComparison.OrdinalIgnoreCase)).ToArray();
        File.WriteAllText(Path.Combine(directory, "IMPORT-BEFORE-INVENTORY.json"), "[" + string.Join(",", before) + "]");
        if (existing.Length > 1) throw new ImportRejection("NATIVE_DUPLICATE_ALREADY_PRESENT");
        if (existing.Length == 1)
        {
            // A new request after restart must not re-add an entry. Prove the
            // cached native chart is the exact current file, not only its path.
            var chart = Path.Combine(prepared.CanonicalFolder, prepared.Request.ChartFile);
            if (!string.Equals((string?)chartPath.Invoke(existing[0], null), chart, StringComparison.OrdinalIgnoreCase)) throw new ImportRejection("EXISTING_CHART_FILE_DIFFERS");
            string md5; using (var input = File.OpenRead(chart)) using (var algorithm = MD5.Create()) md5 = Convert.ToHexString(algorithm.ComputeHash(input));
            if (!string.Equals((string?)entryType.GetProperty("ChecksumString")?.GetValue(existing[0]), md5, StringComparison.OrdinalIgnoreCase)) throw new ImportRejection("EXISTING_CHART_CONTENT_CHANGED");
            ChartValidator.NoLinks(cache); var persisted = File.ReadAllBytes(cache);
            if (persisted.AsSpan().IndexOf(Encoding.UTF8.GetBytes(Folder(existing[0]))) < 0 && persisted.AsSpan().IndexOf(Encoding.UTF8.GetBytes(Folder(existing[0]).ToLowerInvariant())) < 0) throw new ImportRejection("EXISTING_ENTRY_NOT_PERSISTED");
            RefreshNativeMenu();
            if (!Snapshot().SequenceEqual(before)) throw new ImportRejection("DUPLICATE_CHANGED_LIBRARY");
            WriteReport(prepared, "already-present", new { entries = before.Length, parserInvoked = false, cacheSha256 = Digest(cache), nativeChecksumMatchesCurrentChart = true, listRefreshed = true });
            return new(false, true, true, AlreadyPresent: true);
        }
        var owner = workerOwner.GetValue(worker) ?? throw new ImportRejection("NO_SCAN_CONTROLLER");
        if (scanFlag.GetValue(owner) is not false) throw new ImportRejection("NATIVE_SCAN_IN_PROGRESS");
        if (!string.Equals(Path.GetFullPath((string)(workerCache.GetValue(worker) ?? "")), cache, StringComparison.OrdinalIgnoreCase)) throw new ImportRejection("FOREIGN_CACHE_PATH");
        ChartValidator.NoLinks(cache); var cacheBefore = File.ReadAllBytes(cache); var cacheDigestBefore = Digest(cache);
        var backup = Path.Combine(directory, "cache-before-" + prepared.Request.Id.ToString("N") + ".bin"); File.WriteAllBytes(backup, cacheBefore);
        object? entry = null; bool inserted = false; var stage = "validate"; object? cacheObservation = null;
        try
        {
            _ = CurrentSort(); InvalidateViewsOnly(true);
            validator.RequireUnchanged(prepared);
            stage = "parse-detached-entry";
            entry = preflightEntry is not null && preflightIdentity == prepared.Identity ? preflightEntry : ParseDetached(prepared);
            stage = "checksum-and-add";
            add.Invoke(null, new[] { entry }); inserted = true;
            stage = "rebuild-views";
            InvalidateViewsOnly(); rebuildViews.Invoke(null, null);
            // This calls ONLY the proven native writer stage, never the scanner.
            // The writer requires this flag; restore it even if serialization fails.
            scanFlag.SetValue(owner, true);
            stage = "write-native-cache";
            try { saveCache.Invoke(worker, null); } finally { scanFlag.SetValue(owner, false); }
            var cacheAfterBytes = File.ReadAllBytes(cache);
            var cacheDigestAfter = Digest(cache);
            var nativeFolder = Folder(entry);
            bool HasBytes(string value) => cacheAfterBytes.AsSpan().IndexOf(Encoding.UTF8.GetBytes(value)) >= 0;
            var cacheContainsB = HasBytes(nativeFolder) || HasBytes(nativeFolder.ToLowerInvariant());
            cacheObservation = new { beforeBytes = cacheBefore.Length, afterBytes = cacheAfterBytes.Length, beforeSha256 = cacheDigestBefore, afterSha256 = cacheDigestAfter, containsBFolder = cacheContainsB };
            File.WriteAllBytes(Path.Combine(directory, "cache-after-" + prepared.Request.Id.ToString("N") + ".bin"), cacheAfterBytes);
            stage = "refresh-song-menu";
            RefreshNativeMenu();
            stage = "verify-delta";
            var after = Snapshot(); var entryKey = JsonSerializer.Serialize(Describe(entry));
            File.WriteAllText(Path.Combine(directory, "IMPORT-AFTER-INVENTORY.json"), "[" + string.Join(",", after) + "]");
            if (after.Length != before.Length + 1 || !before.SequenceEqual(after.Where(x => x != entryKey)) || after.Count(x => x == entryKey) != 1) throw new ImportRejection("NATIVE_LIBRARY_DELTA_MISMATCH");
            if (cacheDigestBefore == cacheDigestAfter || !cacheContainsB || cacheAfterBytes.Length == 0) throw new ImportRejection("CACHE_PERSISTENCE_NOT_OBSERVED");
            WriteReport(prepared, "imported-awaiting-play-and-restart-proof", new { beforeEntries = before.Length, afterEntries = after.Length, existingEntriesUnchanged = true, usedDetachedPreflight = preflightIdentity == prepared.Identity, nativeFolderParseCallsThisOperation = preflightIdentity == prepared.Identity ? 0 : 1, fullScanInvoked = false, nativeCacheWriterInvoked = true, cacheScanFlagTemporarilyHeld = true, menuRefreshInvoked = true, cacheObservation, title = entryName.GetValue(entry), productApiImportValidated = false });
            return new(true, true, true);
        }
        catch (Exception error)
        {
            Exception? rollbackFailure = null;
            try { if (inserted && entry is not null) remove.Invoke(null, new[] { entry }); }
            catch (Exception rollback) { rollbackFailure = rollback; }
            finally { File.WriteAllBytes(cache, cacheBefore); }
            try { RefreshNativeMenu(); } catch (Exception rollback) { rollbackFailure ??= rollback; }
            var cause = error is TargetInvocationException invocation ? invocation.InnerException ?? error : error;
            WriteReport(prepared, "failed-rolled-back", new { code = error is ImportRejection rejection ? rejection.Code : "NATIVE_EXPERIMENT_FAILED", stage, exceptionType = cause.GetType().FullName, cacheObservation, libraryRestored = Snapshot().SequenceEqual(before), cacheRestored = Digest(cache) == cacheDigestBefore, rollbackFailure = rollbackFailure?.GetType().FullName, fullScanInvoked = false });
            throw new ImportRejection(rollbackFailure is null ? "NATIVE_IMPORT_FAILED_ROLLED_BACK" : "NATIVE_IMPORT_ROLLBACK_INCOMPLETE");
        }
    }
    private void WriteReport(PreparedChart prepared, string state, object detail)
    {
        var report = new { schema = 1, id = prepared.Request.Id, state, utc = DateTime.UtcNow, chartSha256 = prepared.Request.ChartSha256, fixture = Path.GetFileName(prepared.CanonicalFolder), scene = currentScene, mainThread = Environment.CurrentManagedThreadId == mainThread, detail };
        File.WriteAllText(Path.Combine(directory, "EXPERIMENT-RESULT.json"), JsonSerializer.Serialize(report, new JsonSerializerOptions { WriteIndented = true }));
        WriteStatus(state, new { id = prepared.Request.Id, nativeImportValidated = false });
    }
    private void WriteStatus(string state, object detail)
    {
        var text = JsonSerializer.Serialize(new { schema = 1, state, detail }); if (text == lastStatus) return; lastStatus = text;
        File.WriteAllText(Path.Combine(directory, "EXPERIMENT-STATUS.json"), text);
    }
    public void Dispose() { hooks.UnpatchSelf(); active = null; }
}
