using System;
using System.Text;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Windows.Forms;

// Only adjusts the independently created agenda's Z order; never reparents it.
internal sealed class AgendaBottomHost : IDisposable {
    private delegate void WinEventProc(IntPtr hook, uint eventType, IntPtr window, int objectId, int childId, uint thread, uint time);
    [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr handle);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr handle);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr handle);
    [DllImport("user32.dll")] private static extern IntPtr GetShellWindow();
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern IntPtr GetWindowDpiAwarenessContext(IntPtr handle);
    [DllImport("user32.dll")] private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr handle, uint command);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetClassName(IntPtr handle, StringBuilder text, int count);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetWindowText(IntPtr handle, StringBuilder text, int count);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern IntPtr OpenProcess(uint access, bool inheritHandle, uint processId);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder path, ref int count);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] private static extern IntPtr GetCurrentProcess();
    [DllImport("advapi32.dll")] private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll")] private static extern bool GetTokenInformation(IntPtr token, int type, IntPtr buffer, int length, out int required);
    [DllImport("advapi32.dll")] private static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
    [DllImport("advapi32.dll")] private static extern IntPtr GetSidSubAuthority(IntPtr sid, uint index);
    [DllImport("user32.dll", SetLastError=true)] private static extern bool SetWindowPos(IntPtr handle, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr handle, int command);
    [DllImport("user32.dll", SetLastError=true)] private static extern IntPtr SetWinEventHook(uint first, uint last, IntPtr module, WinEventProc callback, uint process, uint thread, uint flags);
    [DllImport("user32.dll")] private static extern bool UnhookWinEvent(IntPtr hook);

    private readonly IntPtr window;
    private readonly uint owner;
    private readonly string title;
    private readonly Timer timer = new Timer();
    private readonly WinEventProc callback;
    private IntPtr hook;
    private IntPtr previousDpi;
    private bool adjusting;

    public AgendaBottomHost(IntPtr window, uint owner, string title) {
        this.window = window; this.owner = owner; this.title = title;
        if (!Matches()) throw new InvalidOperationException("The agenda window changed or was closed.");
        previousDpi = SetThreadDpiAwarenessContext(GetWindowDpiAwarenessContext(window));
        IntPtr process = OpenProcess(0x1000, false, owner);
        if (process == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot inspect the agenda process.");
        try {
            var image = new StringBuilder(32768); int size = image.Capacity;
            if (!QueryFullProcessImageName(process, 0, image, ref size)) throw new Win32Exception(Marshal.GetLastWin32Error());
            if (!String.Equals(System.IO.Path.GetFileName(image.ToString()), "Obsidian.exe", StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("The target must belong to Obsidian.");
        } finally { CloseHandle(process); }
        callback = (eventHook, type, target, obj, child, thread, time) => Maintain();
    }

    private bool Matches() {
        if (!IsWindow(window)) return false;
        uint process; GetWindowThreadProcessId(window, out process);
        var text = new StringBuilder(512); GetWindowText(window, text, text.Capacity);
        return process == owner && text.ToString() == title;
    }

    private static bool IsDesktop(IntPtr handle) {
        if (handle == IntPtr.Zero) return false;
        uint process, shell; GetWindowThreadProcessId(handle, out process); GetWindowThreadProcessId(GetShellWindow(), out shell);
        if (process != shell || shell == 0) return false;
        var name = new StringBuilder(128); GetClassName(handle, name, name.Capacity);
        return name.ToString() == "Progman" || name.ToString() == "WorkerW";
    }

    private void Lower() {
        // Show Desktop can minimize normal windows. Restore only this widget without focus.
        if (IsIconic(window) || !IsWindowVisible(window)) ShowWindow(window, 4); // SW_SHOWNOACTIVATE
        IntPtr foreground = GetForegroundWindow();
        IntPtr after = new IntPtr(1); // HWND_BOTTOM
        if (IsDesktop(foreground)) {
            // Explorer temporarily brings its desktop forward during Win+D.
            after = GetWindow(foreground, 3); // GW_HWNDPREV
            if (after == window) return;
        }
        if (!SetWindowPos(window, after, 0, 0, 0, 0, 0x4013)) { // ASYNC | NOSIZE | NOMOVE | NOACTIVATE
            int error = Marshal.GetLastWin32Error();
            string integrity = "unknown";
            IntPtr token; IntPtr buffer = Marshal.AllocHGlobal(1024);
            if (OpenProcessToken(GetCurrentProcess(), 8, out token)) {
                int needed;
                if (GetTokenInformation(token, 25, buffer, 1024, out needed)) {
                    IntPtr sid = Marshal.ReadIntPtr(buffer);
                    byte count = Marshal.ReadByte(GetSidSubAuthorityCount(sid));
                    integrity = Marshal.ReadInt32(GetSidSubAuthority(sid, (uint)(count - 1))).ToString();
                }
                CloseHandle(token);
            }
            Marshal.FreeHGlobal(buffer);
            throw new Win32Exception(error, "Cannot lower the agenda window (Win32 " + error + ", integrity=" + integrity + ").");
        }
    }

    private void Maintain() {
        if (adjusting) return;
        if (!Matches()) { Application.ExitThread(); return; }
        adjusting = true;
        try { Lower(); }
        catch { Application.ExitThread(); }
        finally { adjusting = false; }
    }

    public void Start() {
        Lower();
        hook = SetWinEventHook(3, 3, IntPtr.Zero, callback, 0, 0, 0); // FOREGROUND, OUTOFCONTEXT
        if (hook == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot watch foreground window changes.");
        timer.Interval = 500;
        timer.Tick += (sender, args) => Maintain();
        timer.Start();
    }

    public void Dispose() {
        timer.Stop(); timer.Dispose();
        if (hook != IntPtr.Zero) UnhookWinEvent(hook);
        if (previousDpi != IntPtr.Zero) SetThreadDpiAwarenessContext(previousDpi);
        GC.KeepAlive(callback);
    }
}

internal static class DesktopAgendaEntry {
    private static string Quote(string text) {
        return "\"" + text.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "\\r").Replace("\n", "\\n").Replace("\t", "\\t") + "\"";
    }
    [STAThread]
    private static int Main(string[] arguments) {
        bool ready = false;
        try {
            if (arguments.Length != 4) return 2;
            using (var host = new AgendaBottomHost(new IntPtr(long.Parse(arguments[0])), uint.Parse(arguments[1]), arguments[2])) {
                host.Start();
                System.IO.File.WriteAllText(arguments[3], "{\"ready\":true,\"mode\":\"bottom\"}", new UTF8Encoding(false));
                ready = true;
                Application.Run();
            }
            return 0;
        } catch (Exception error) {
            if (!ready && arguments.Length == 4) {
                try { System.IO.File.WriteAllText(arguments[3], "{\"ready\":false,\"error\":" + Quote(error.Message) + "}", new UTF8Encoding(false)); }
                catch { /* The caller reports a missing startup result. */ }
            }
            return 1;
        }
    }
}
