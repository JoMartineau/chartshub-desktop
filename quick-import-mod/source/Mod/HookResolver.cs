using System.Reflection;
using System.Reflection.Emit;
using System.Runtime.InteropServices;

namespace ChartsHub.QuickImport;

// Resolve generated wrappers by the original native method token, not the
// generator's unstable display names. No original-name attribute is assumed.
internal static class HookResolver
{
    private const BindingFlags Declared = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly;
    private static readonly Dictionary<ushort, OpCode> Opcodes = typeof(OpCodes).GetFields(BindingFlags.Public | BindingFlags.Static).Where(f => f.FieldType == typeof(OpCode)).Select(f => (OpCode)f.GetValue(null)!).ToDictionary(o => unchecked((ushort)o.Value));
    internal sealed record Binding(MethodBase Method, FieldInfo PointerField, uint OriginalToken);
    private sealed record Instruction(OpCode Opcode, int Value);
    private static List<Instruction> ReadIl(MethodBase method)
    {
        var bytes = method.GetMethodBody()?.GetILAsByteArray() ?? throw new InvalidOperationException("No generated IL");
        if (bytes.Length > 1024 * 1024) throw new InvalidOperationException("Generated IL too large");
        var output = new List<Instruction>();
        for (int at = 0; at < bytes.Length;)
        {
            ushort code = bytes[at++];
            if (code == 0xFE) { if (at == bytes.Length) throw new InvalidOperationException("Incomplete IL"); code = (ushort)(0xFE00 | bytes[at++]); }
            if (!Opcodes.TryGetValue(code, out var opcode)) throw new InvalidOperationException("Unknown IL opcode");
            int size = opcode.OperandType switch {
                OperandType.InlineNone => 0,
                OperandType.ShortInlineBrTarget or OperandType.ShortInlineI or OperandType.ShortInlineVar => 1,
                OperandType.InlineVar => 2,
                OperandType.InlineI8 or OperandType.InlineR => 8,
                OperandType.InlineSwitch => at + 4 <= bytes.Length && BitConverter.ToInt32(bytes, at) is >= 0 and <= 100000 ? checked(4 + 4 * BitConverter.ToInt32(bytes, at)) : throw new InvalidOperationException("Invalid switch"),
                _ => 4
            };
            if (at + size > bytes.Length) throw new InvalidOperationException("Truncated IL operand");
            int value = size >= 4 ? BitConverter.ToInt32(bytes, at) : size == 2 ? BitConverter.ToUInt16(bytes, at) : size == 1 ? bytes[at] : 0;
            output.Add(new(opcode, value)); at += size;
        }
        return output;
    }
    private static FieldInfo Field(Module module, int token) => module.ResolveField(token) ?? throw new MissingFieldException();
    private static bool SameField(FieldInfo a, FieldInfo b) => a.Module == b.Module && a.MetadataToken == b.MetadataToken && a.DeclaringType == b.DeclaringType;
    internal static bool HasOriginalType(Type type, string image, string originalNamespace, string originalName)
    {
        if (type.TypeInitializer is not { } cctor) return false;
        var il = ReadIl(cctor);
        int matches = 0;
        for (int i = 3; i + 1 < il.Count; i++)
        {
            if (il[i].Opcode != OpCodes.Call || il[i - 3].Opcode != OpCodes.Ldstr || il[i - 2].Opcode != OpCodes.Ldstr || il[i - 1].Opcode != OpCodes.Ldstr || il[i + 1].Opcode != OpCodes.Stsfld) continue;
            if (cctor.Module.ResolveString(il[i - 3].Value) != image || cctor.Module.ResolveString(il[i - 2].Value) != originalNamespace || cctor.Module.ResolveString(il[i - 1].Value) != originalName) continue;
            var called = cctor.Module.ResolveMethod(il[i].Value);
            if (called?.Name != "GetIl2CppClass" || called.DeclaringType?.FullName != "Il2CppInterop.Runtime.IL2CPP") continue;
            var klass = Field(cctor.Module, il[i + 1].Value);
            if (klass.Name != "NativeClassPtr" || klass.DeclaringType is not { IsGenericType: true } store || store.GetGenericTypeDefinition().FullName != "Il2CppInterop.Runtime.Il2CppClassPointerStore`1" || store.GetGenericArguments()[0] != type) continue;
            matches++;
        }
        return matches == 1;
    }
    internal static Type ResolveType(Assembly assembly, string image, string originalNamespace, string originalName) =>
        assembly.GetTypes().Single(t => HasOriginalType(t, image, originalNamespace, originalName));
    internal static PropertyInfo ResolveFieldProperty(Type type, string originalName)
    {
        var initializer = type.TypeInitializer ?? throw new MissingMethodException(); var il = ReadIl(initializer); var fields = new List<FieldInfo>();
        for (int i = 2; i + 1 < il.Count; i++)
        {
            if (il[i].Opcode != OpCodes.Call || il[i - 1].Opcode != OpCodes.Ldstr || il[i + 1].Opcode != OpCodes.Stsfld || initializer.Module.ResolveString(il[i - 1].Value) != originalName) continue;
            var called = initializer.Module.ResolveMethod(il[i].Value);
            if (called?.Name == "GetIl2CppField" && called.DeclaringType?.FullName == "Il2CppInterop.Runtime.IL2CPP") fields.Add(Field(initializer.Module, il[i + 1].Value));
        }
        if (fields.Count != 1) throw new MissingFieldException("Original field mapping is not unique");
        return type.GetProperties(Declared).Single(p => p.GetMethod is { } getter && ReadIl(getter).Any(x => x.Opcode == OpCodes.Ldsfld && SameField(Field(getter.Module, x.Value), fields[0])));
    }
    internal static Binding Resolve(Type type, uint originalToken, int arity)
    {
        if ((originalToken & 0xFF000000) != 0x06000000 || (originalToken & 0xFFFFFF) == 0 || arity < 0 || arity > 16) throw new InvalidOperationException("Invalid native token contract");
        var cctor = type.TypeInitializer ?? throw new MissingMethodException("No generated class initializer");
        var il = ReadIl(cctor); var fields = new List<FieldInfo>();
        for (int i = 1; i + 2 < il.Count; i++)
        {
            if (il[i].Opcode != OpCodes.Ldc_I4 || unchecked((uint)il[i].Value) != originalToken || il[i - 1].Opcode != OpCodes.Ldsfld || il[i + 1].Opcode != OpCodes.Call || il[i + 2].Opcode != OpCodes.Stsfld) continue;
            var called = cctor.Module.ResolveMethod(il[i + 1].Value);
            if (called?.Name != "GetIl2CppMethodByToken" || called.DeclaringType?.FullName != "Il2CppInterop.Runtime.IL2CPP") continue;
            var klass = Field(cctor.Module, il[i - 1].Value);
            if (klass.Name != "NativeClassPtr" || klass.DeclaringType is not { IsGenericType: true } store || store.GetGenericTypeDefinition().FullName != "Il2CppInterop.Runtime.Il2CppClassPointerStore`1" || store.GetGenericArguments().Length != 1 || store.GetGenericArguments()[0] != type) continue;
            var field = Field(cctor.Module, il[i + 2].Value);
            if (field.DeclaringType != type || !field.IsStatic || field.FieldType != typeof(nint) || !field.Name.StartsWith("NativeMethodInfoPtr_", StringComparison.Ordinal)) continue;
            fields.Add(field);
        }
        if (fields.Count != 1) throw new MissingMethodException("Native token initializer is not unique");
        var pointer = fields[0];
        var candidates = type.GetMethods(Declared).Cast<MethodBase>().Concat(type.GetConstructors(Declared)).Where(m => !m.IsGenericMethod && m.GetParameters().Length == arity && m.GetMethodBody() != null && ReadIl(m).Any(x => x.Opcode == OpCodes.Ldsfld && SameField(Field(m.Module, x.Value), pointer))).ToArray();
        if (candidates.Length != 1) throw new MissingMethodException("Native token wrapper is not unique");
        return new(candidates[0], pointer, originalToken);
    }
    internal static void ValidateNativePointer(Binding binding, nint gameAssemblyBase, int expectedRva)
    {
        if (gameAssemblyBase == 0 || expectedRva <= 0) throw new InvalidOperationException("Invalid native address contract");
        var pointer = (nint)(binding.PointerField.GetValue(null) ?? throw new InvalidOperationException("No native method info"));
        if (pointer == 0 || Marshal.ReadIntPtr(pointer) != gameAssemblyBase + expectedRva) throw new InvalidOperationException("Native method pointer differs from verified build");
    }
}
