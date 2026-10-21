param(
  [switch]$Detach,
  [switch]$Move,
  [Parameter(Mandatory = $true)][UInt64]$WindowHandle,
  [int]$X,
  [int]$Y,
  [int]$Width,
  [int]$Height
)

$ErrorActionPreference = 'Stop'

$nativeSource = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class BoheyunDesktopHost {
    public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string className, string windowName);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string className, string windowName);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hwnd, uint command);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hwnd, StringBuilder name, int maxCount);
    [DllImport("user32.dll")] public static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);
    [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr SetParent(IntPtr child, IntPtr parent);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr hwnd);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool ShowWindow(IntPtr hwnd, int command);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool ScreenToClient(IntPtr hwnd, ref Point point);
    [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr GetWindowLongPtr(IntPtr hwnd, int index);
    [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr SetWindowLongPtr(IntPtr hwnd, int index, IntPtr value);
    [DllImport("kernel32.dll", EntryPoint = "SetLastError")] private static extern void ClearLastError(uint error);

    [StructLayout(LayoutKind.Sequential)]
    public struct Point { public int X; public int Y; }

    private const uint GW_HWNDNEXT = 2;
    private const int GWL_STYLE = -16;
    private const int GWL_EXSTYLE = -20;
    private const long WS_CHILD = 0x40000000L;
    private const long WS_POPUP = unchecked((long)0x80000000L);
    private const long WS_EX_APPWINDOW = 0x00040000L;
    private const long WS_EX_TOOLWINDOW = 0x00000080L;
    private const long WS_EX_TOPMOST = 0x00000008L;
    private static readonly IntPtr HWND_BOTTOM = new IntPtr(1);
    private static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);
    private const uint SWP_NOSIZE = 0x0001;
    private const uint SWP_NOMOVE = 0x0002;
    private const uint SWP_FRAMECHANGED = 0x0020;
    private const uint SWP_SHOWWINDOW = 0x0040;
    private const uint SWP_NOACTIVATE = 0x0010;
    private const uint SWP_NOZORDER = 0x0004;
    private const uint SMTO_ABORTIFHUNG = 0x0002;
    private const int SW_SHOWNOACTIVATE = 4;
    private const int SW_RESTORE = 9;

    private static bool TrySetWindowLongPtr(IntPtr hwnd, int index, IntPtr value) {
        ClearLastError(0);
        IntPtr previous = SetWindowLongPtr(hwnd, index, value);
        return previous != IntPtr.Zero || Marshal.GetLastWin32Error() == 0;
    }

    private static bool TrySetParent(IntPtr child, IntPtr parent) {
        ClearLastError(0);
        IntPtr previous = SetParent(child, parent);
        return (previous != IntPtr.Zero || Marshal.GetLastWin32Error() == 0) && GetParent(child) == parent;
    }

    private static void RestoreWindow(IntPtr child, IntPtr parent, IntPtr style, IntPtr exStyle) {
        TrySetParent(child, parent);
        TrySetWindowLongPtr(child, GWL_STYLE, style);
        TrySetWindowLongPtr(child, GWL_EXSTYLE, exStyle);
        SetWindowPos(child, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_FRAMECHANGED | SWP_NOACTIVATE);
    }

    public static bool Detach(UInt64 rawHandle) {
        IntPtr child = new IntPtr(unchecked((long)rawHandle));
        if (child == IntPtr.Zero || !IsWindow(child)) return false;

        IntPtr currentParent = GetParent(child);
        if (currentParent != IntPtr.Zero && !TrySetParent(child, IntPtr.Zero)) return false;

        long style = GetWindowLongPtr(child, GWL_STYLE).ToInt64();
        style = (style & ~WS_CHILD) | WS_POPUP;
        long exStyle = GetWindowLongPtr(child, GWL_EXSTYLE).ToInt64();
        exStyle = (exStyle | WS_EX_APPWINDOW) & ~(WS_EX_TOOLWINDOW | WS_EX_TOPMOST);
        if (!TrySetWindowLongPtr(child, GWL_STYLE, new IntPtr(style)) ||
            !TrySetWindowLongPtr(child, GWL_EXSTYLE, new IntPtr(exStyle))) return false;

        SetWindowPos(child, HWND_NOTOPMOST, 0, 0, 0, 0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_FRAMECHANGED | SWP_NOACTIVATE | SWP_NOZORDER | SWP_SHOWWINDOW);
        ShowWindow(child, SW_SHOWNOACTIVATE);
        return GetParent(child) == IntPtr.Zero;
    }

    public static bool Move(UInt64 rawHandle, int x, int y, int width, int height) {
        IntPtr child = new IntPtr(unchecked((long)rawHandle));
        if (child == IntPtr.Zero || !IsWindow(child)) return false;
        IntPtr host = GetParent(child);
        if (host == IntPtr.Zero || !IsWindow(host)) return false;
        Point origin = new Point { X = x, Y = y };
        if (!ScreenToClient(host, ref origin)) return false;
        bool moved = SetWindowPos(child, HWND_BOTTOM, origin.X, origin.Y, width, height,
            SWP_FRAMECHANGED | SWP_SHOWWINDOW | SWP_NOACTIVATE);
        ShowWindow(child, SW_SHOWNOACTIVATE);
        return moved && GetParent(child) == host;
    }

    private static IntPtr FindWorkerBehindIcons() {
        IntPtr worker = IntPtr.Zero;
        EnumWindows(delegate(IntPtr top, IntPtr unused) {
            IntPtr view = FindWindowEx(top, IntPtr.Zero, "SHELLDLL_DefView", null);
            if (view == IntPtr.Zero) return true;
            IntPtr next = GetWindow(top, GW_HWNDNEXT);
            while (next != IntPtr.Zero) {
                StringBuilder className = new StringBuilder(128);
                GetClassName(next, className, className.Capacity);
                if (className.ToString() == "WorkerW" && IsWindowVisible(next) && !IsIconic(next)) {
                    worker = next;
                    return false;
                }
                next = GetWindow(next, GW_HWNDNEXT);
            }
            return false;
        }, IntPtr.Zero);
        return worker;
    }

    private static bool HasWorkerBehindIcons() {
        bool found = false;
        EnumWindows(delegate(IntPtr top, IntPtr unused) {
            if (FindWindowEx(top, IntPtr.Zero, "SHELLDLL_DefView", null) == IntPtr.Zero) return true;
            IntPtr next = GetWindow(top, GW_HWNDNEXT);
            while (next != IntPtr.Zero) {
                StringBuilder className = new StringBuilder(128);
                GetClassName(next, className, className.Capacity);
                if (className.ToString() == "WorkerW") {
                    found = true;
                    return false;
                }
                next = GetWindow(next, GW_HWNDNEXT);
            }
            return false;
        }, IntPtr.Zero);
        return found;
    }

    private static IntPtr FindWorkerChildOfProgman(IntPtr progman) {
        if (progman == IntPtr.Zero) return IntPtr.Zero;
        IntPtr child = FindWindowEx(progman, IntPtr.Zero, null, null);
        while (child != IntPtr.Zero) {
            StringBuilder className = new StringBuilder(128);
            GetClassName(child, className, className.Capacity);
            if (className.ToString() == "WorkerW" &&
                FindWindowEx(child, IntPtr.Zero, "SHELLDLL_DefView", null) == IntPtr.Zero &&
                IsWindowVisible(child) && !IsIconic(child)) {
                return child;
            }
            child = FindWindowEx(progman, child, null, null);
        }
        return IntPtr.Zero;
    }

    private static bool HasWorkerChildOfProgman(IntPtr progman) {
        if (progman == IntPtr.Zero) return false;
        IntPtr child = FindWindowEx(progman, IntPtr.Zero, null, null);
        while (child != IntPtr.Zero) {
            StringBuilder className = new StringBuilder(128);
            GetClassName(child, className, className.Capacity);
            if (className.ToString() == "WorkerW" &&
                FindWindowEx(child, IntPtr.Zero, "SHELLDLL_DefView", null) == IntPtr.Zero) {
                return true;
            }
            child = FindWindowEx(progman, child, null, null);
        }
        return false;
    }

    private static IntPtr FindDesktopHost(bool createIfMissing) {
        IntPtr progman = FindWindow("Progman", null);
        // Prefer a visible WorkerW directly owned by Progman. A top-level
        // WorkerW can be hidden by Explorer's "Show desktop" transition.
        IntPtr worker = progman != IntPtr.Zero ? FindWorkerChildOfProgman(progman) : IntPtr.Zero;
        if (worker == IntPtr.Zero) worker = FindWorkerBehindIcons();
        if (worker != IntPtr.Zero || progman == IntPtr.Zero) return worker;

        // If Explorer still has a WorkerW but it is temporarily hidden, wait
        // for that host instead of falling back behind the desktop icon view.
        if (HasWorkerChildOfProgman(progman) || HasWorkerBehindIcons()) return IntPtr.Zero;

        if (createIfMissing) {
            IntPtr ignored;
            SendMessageTimeout(progman, 0x052C, new IntPtr(0xD), new IntPtr(1),
                SMTO_ABORTIFHUNG, 1000, out ignored);
            for (int attempt = 0; attempt < 20; attempt++) {
                Thread.Sleep(150);
                worker = FindWorkerChildOfProgman(progman);
                if (worker == IntPtr.Zero) worker = FindWorkerBehindIcons();
                if (worker != IntPtr.Zero) return worker;
            }
        }

        // Some Explorer configurations keep the icon view under Progman and create no WorkerW.
        return FindWindowEx(progman, IntPtr.Zero, "SHELLDLL_DefView", null) != IntPtr.Zero
            ? progman
            : IntPtr.Zero;
    }

    public static bool Attach(UInt64 rawHandle, int x, int y, int width, int height) {
        IntPtr child = new IntPtr(unchecked((long)rawHandle));
        IntPtr host = FindDesktopHost(true);
        if (child == IntPtr.Zero || host == IntPtr.Zero || !IsWindow(child)) return false;

        IntPtr originalParent = GetParent(child);
        IntPtr originalStyle = GetWindowLongPtr(child, GWL_STYLE);
        IntPtr originalExStyle = GetWindowLongPtr(child, GWL_EXSTYLE);
        long style = (originalStyle.ToInt64() & ~WS_POPUP) | WS_CHILD;
        long exStyle = (originalExStyle.ToInt64() & ~(WS_EX_APPWINDOW | WS_EX_TOPMOST)) | WS_EX_TOOLWINDOW;

        SetWindowPos(child, HWND_NOTOPMOST, 0, 0, 0, 0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_FRAMECHANGED | SWP_NOACTIVATE);
        if (!TrySetWindowLongPtr(child, GWL_STYLE, new IntPtr(style)) ||
            !TrySetWindowLongPtr(child, GWL_EXSTYLE, new IntPtr(exStyle)) ||
            !TrySetParent(child, host)) {
            RestoreWindow(child, originalParent, originalStyle, originalExStyle);
            return false;
        }

        Point origin = new Point { X = x, Y = y };
        bool converted = ScreenToClient(host, ref origin);
        bool positioned = converted && SetWindowPos(child, HWND_BOTTOM, origin.X, origin.Y, width, height,
            SWP_FRAMECHANGED | SWP_SHOWWINDOW | SWP_NOACTIVATE);
        // Win+D can hide an already-attached child without changing its parent.
        // Explicitly show it again without activating or raising it above apps.
        ShowWindow(child, SW_SHOWNOACTIVATE);
        long actualExStyle = GetWindowLongPtr(child, GWL_EXSTYLE).ToInt64();
        // The desktop host can be temporarily hidden while Explorer processes
        // Win+D. Treat the parent/style relationship as a successful attach;
        // IsAttached will request another show pass once visibility is lost.
        bool attached = positioned && GetParent(child) == host &&
            (actualExStyle & WS_EX_TOPMOST) == 0;
        if (!attached) RestoreWindow(child, originalParent, originalStyle, originalExStyle);
        return attached;
    }

    public static bool IsAttached(UInt64 rawHandle) {
        IntPtr child = new IntPtr(unchecked((long)rawHandle));
        if (child == IntPtr.Zero || !IsWindow(child)) return false;
        IntPtr host = GetParent(child);
        if (host == IntPtr.Zero || !IsWindow(host)) return false;
        StringBuilder hostClass = new StringBuilder(128);
        GetClassName(host, hostClass, hostClass.Capacity);
        if (hostClass.ToString() != "WorkerW" && hostClass.ToString() != "Progman") return false;
        long style = GetWindowLongPtr(child, GWL_STYLE).ToInt64();
        long exStyle = GetWindowLongPtr(child, GWL_EXSTYLE).ToInt64();
        bool structureIsValid = (style & WS_CHILD) != 0 && (style & WS_POPUP) == 0 &&
            (exStyle & WS_EX_APPWINDOW) == 0 && (exStyle & WS_EX_TOPMOST) == 0;
        if (!structureIsValid) return false;

        IntPtr preferredHost = FindDesktopHost(false);
        // If Explorer has created a new visible desktop host, leave the old
        // hidden WorkerW so the next pass can attach to the active host.
        if (preferredHost != IntPtr.Zero && preferredHost != host) return false;
        // Keep a valid parent while Explorer temporarily hides it for Win+D.
        // When there is no replacement host yet, wait for Explorer to finish
        // the transition instead of repeatedly changing the parent.
        if (!IsWindowVisible(host) || IsIconic(host)) return true;
        return preferredHost == IntPtr.Zero || preferredHost == host;
    }

    public static bool RestoreVisibility(UInt64 rawHandle) {
        IntPtr child = new IntPtr(unchecked((long)rawHandle));
        if (child == IntPtr.Zero || !IsWindow(child)) return false;
        IntPtr host = GetParent(child);
        if (host == IntPtr.Zero || !IsWindow(host)) return false;
        if (!IsWindowVisible(host) || IsIconic(host)) return true;
        if (IsIconic(child)) {
            ShowWindow(child, SW_RESTORE);
        }
        if (!IsWindowVisible(child)) {
            ShowWindow(child, SW_SHOWNOACTIVATE);
        }
        return IsWindowVisible(child) && !IsIconic(child);
    }
}
'@

try {
  if (-not ('BoheyunDesktopHost' -as [type])) {
    Add-Type -TypeDefinition $nativeSource -Language CSharp
  }
  if ($Detach) {
    if (-not [BoheyunDesktopHost]::Detach($WindowHandle)) { exit 1 }
    exit 0
  }
  if ($Move) {
    if (-not [BoheyunDesktopHost]::Move($WindowHandle, $X, $Y, $Width, $Height)) { exit 1 }
    exit 0
  }
  $attached = [BoheyunDesktopHost]::Attach($WindowHandle, $X, $Y, $Width, $Height)
  if (-not $attached) { exit 1 }
  Write-Output 'ATTACHED'
  $attachFailures = 0
  while ([BoheyunDesktopHost]::IsWindow([IntPtr]::new([long]$WindowHandle))) {
    Start-Sleep -Seconds 2
    if (-not [BoheyunDesktopHost]::IsAttached($WindowHandle)) {
      if (-not [BoheyunDesktopHost]::Attach($WindowHandle, $X, $Y, $Width, $Height)) {
        $attachFailures += 1
        if ($attachFailures -ge 3) { exit 1 }
        Start-Sleep -Seconds 3
      } else {
        $attachFailures = 0
        Write-Output 'ATTACHED'
      }
    } else {
      [void][BoheyunDesktopHost]::RestoreVisibility($WindowHandle)
    }
  }
} catch {
  exit 1
}
