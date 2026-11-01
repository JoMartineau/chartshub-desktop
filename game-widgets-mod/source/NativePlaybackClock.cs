using System.Runtime.InteropServices;

namespace ChartsHub.CloneHero.Telemetry;

// Exact 6142 profile only. Native static field flow is sealed in
// research-summary/STATIC-PLAYBACK-SPEED-REVIEW.json. No getters are invoked.
internal static class NativePlaybackClock
{
    private static float Float(nint pointer, int offset) => BitConverter.Int32BitsToSingle(Marshal.ReadInt32(pointer, offset));
    internal static object Read(nint manager, double position, double duration)
    {
        // Existing clocks remain visible without speed when their timebase is
        // unknown. A media consumer must wait; unknown never defaults to 1.
        object unknown = new { positionSeconds = position, durationSeconds = duration };
        if (manager == 0) return unknown;
        nint sync = Marshal.ReadIntPtr(manager, 0xB0);
        if (sync == 0) return unknown;
        double initial = Float(sync, 0x2C), current = Float(sync, 0x30);
        double practice = Float(manager, 0xD8), percentDelta = Float(manager, 0xDC);
        if (!double.IsFinite(initial) || !double.IsFinite(current) || !double.IsFinite(practice) || !double.IsFinite(percentDelta) ||
            initial <= 0 || initial > 10 || current <= 0 || current > 10 || Math.Abs(current - practice) > .0001 || Math.Abs(percentDelta) > 10_000) return unknown;
        // The constructor receives an integer percentage / 100. Recover that
        // exact percentage from its float representation, with a narrow check.
        double initialFactor = Math.Round(initial * 100d, MidpointRounding.ToEven) / 100d;
        if (initialFactor < .01 || initialFactor > 10 || Math.Abs(initialFactor - initial) > .0001) return unknown;
        // GameManager sends round-to-even(percentDelta) to BASS tempo;
        // BASS receives percent relative to 100, while sync stores a factor.
        double speed = (Math.Round(percentDelta, MidpointRounding.ToEven) + 100d) / 100d;
        if (speed < .01 || speed > 10 || Math.Abs(speed - current) > .0001) return unknown;
        // Native sync normalizes chart/audio seconds by the initial factor.
        // Multiplication restores media seconds without accumulating our own
        // timer, and keeps native pauses, seeks and practice changes intact.
        double mediaPosition = position * initialFactor, mediaDuration = duration * initialFactor;
        if (!double.IsFinite(mediaPosition) || !double.IsFinite(mediaDuration) || mediaDuration < 0 || mediaDuration > 86400 || mediaPosition < -60 || mediaPosition > mediaDuration + 5) return unknown;
        return new { positionSeconds = mediaPosition, durationSeconds = mediaDuration, speed };
    }
}
