#!/usr/bin/env python3
r"""让 Kindle 退出「U 盘模式」（等价于 Windows 的「安全弹出」）。

为什么需要它：Kindle 插着电脑时会进 U 盘模式，把用户分区整个导出给电脑，
同时**关掉无线**、设备侧也看不到 /mnt/us —— 表现为「设备离线 + 面板不刷新」。
拔线能解决，但远程救援时拔不了线，就靠发一条 SCSI eject 让它自己退出来。

用法：
    python tools/kindle-eject.py            # 自动找盘符；找不到就按物理磁盘号试
    python tools/kindle-eject.py E          # 指定盘符
    python tools/kindle-eject.py --disk 1   # 指定物理磁盘号（\\.\PhysicalDriveN）

成败判断：命令返回 0 只代表指令发出去了，设备要在几十秒后才退出 U 盘模式。
真正的确认是 `tools/_scan_kindle.py` 能扫到 22 端口，或 Windows 里那个卷消失。
"""
import ctypes
import ctypes.wintypes as wintypes
import string
import sys
from pathlib import Path

GENERIC_READ = 0x80000000
FILE_SHARE_READ = 0x00000001
FILE_SHARE_WRITE = 0x00000002
OPEN_EXISTING = 3
INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value

IOCTL_STORAGE_MEDIA_REMOVAL = 0x002D4804  # PREVENT_MEDIA_REMOVAL
IOCTL_STORAGE_EJECT_MEDIA = 0x002D4808
IOCTL_STORAGE_LOAD_MEDIA = 0x002D480C

k32 = ctypes.windll.kernel32
k32.CreateFileW.restype = ctypes.c_void_p
k32.CreateFileW.argtypes = [
    wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p,
    wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p,
]
k32.DeviceIoControl.argtypes = [
    ctypes.c_void_p, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD,
    ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p,
]
k32.CloseHandle.argtypes = [ctypes.c_void_p]

ROOT = Path(__file__).resolve().parent.parent


def volume_labels():
    """枚举当前挂载的卷标签，用来找一个叫 KINDLE 的。"""
    out = {}
    buf = ctypes.create_unicode_buffer(261)
    for letter in string.ascii_uppercase:
        if k32.GetVolumeInformationW(f"{letter}:\\", buf, 261, None, None, None, None, 0):
            out[letter] = buf.value
    return out


def ioctl_eject(target):
    h = k32.CreateFileW(target, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
                        None, OPEN_EXISTING, 0, None)
    if h == INVALID_HANDLE_VALUE or h is None:
        err = ctypes.get_last_error() if hasattr(ctypes, "get_last_error") else 0
        print(f"[!] 打不开 {target}（可能需要管理员权限），Win32 error={err}")
        return False
    try:
        # 先解除「禁止弹出」锁，再发弹出
        prevent = ctypes.c_ulong(0)
        ret = wintypes.DWORD(0)
        k32.DeviceIoControl(h, IOCTL_STORAGE_MEDIA_REMOVAL,
                            ctypes.byref(prevent), ctypes.sizeof(prevent),
                            None, 0, ctypes.byref(ret), None)
        ok = k32.DeviceIoControl(h, IOCTL_STORAGE_EJECT_MEDIA,
                                 None, 0, None, 0, ctypes.byref(ret), None)
        print(f"[{'OK' if ok else '!!'}] 向 {target} 发送 STORAGE_EJECT_MEDIA"
              f"{'' if ok else '（调用失败）'}")
        return bool(ok)
    finally:
        k32.CloseHandle(h)


def main():
    args = [a for a in sys.argv[1:]]
    targets = []
    if args and args[0] == "--disk":
        targets = [rf"\\.\PhysicalDrive{args[1]}"]
    elif args:
        targets = [rf"\\.\{args[0][0].upper()}:"]
    else:
        labels = volume_labels()
        letter = next((l for l, v in labels.items() if "KINDLE" in v.upper()), None)
        if letter:
            print(f"[*] 找到 Kindle 卷：{letter}:")
            targets = [rf"\\.\{letter}:"]
        # 盘符常被 mountvol /p 摘掉，那就按物理磁盘挨个试
        targets += [rf"\\.\PhysicalDrive{n}" for n in (1, 2, 3)]
        print("[*] 卷标签扫描没结果时，按物理磁盘号依次尝试")

    for t in targets:
        if ioctl_eject(t):
            print(f"[+] 已向 {t} 发送弹出指令。等 30~90 秒后跑 tools/_scan_kindle.py 确认它上线。")
            return 0
    print("[!] 所有目标都失败。改用手动：拔掉 Kindle 的数据线（或托盘图标「安全删除硬件」）。")
    return 1


if __name__ == "__main__":
    sys.exit(main())
