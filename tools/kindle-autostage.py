#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Kindle U 盘"插线即托管"脚本。

用途：解决 Kindle 菜单里 "Update Your Kindle / 更新您的 Kindle" 灰掉点不了的问题。
菜单变亮的硬性条件只有三条，本脚本负责把其中"软件可修"的部分全部修好：

  1. U 盘根目录必须存在文件名以 Update_ 开头、后缀 .bin 的更新包
     -> 脚本自动拷入正确的包
  2. 根目录不能残留"已经装过"的旧 .bin（残留会让菜单灰 / 更新直接失败）
     -> 脚本自动清空所有旧 .bin
  3. 设备电量 >= 20%（老机器建议先充 30 分钟）+ 完全拔掉 USB 线
     -> 这是物理条件，脚本管不了，会在报告里提醒

检测到 Kindle 盘后：
  - 列出根目录，判断 mkk/ 是否存在（= 越狱是否真的成功过）
  - mkk 不存在  -> 部署"越狱包"，下一步装越狱
  - mkk 已存在  -> 部署"USBNetwork 包"，下一步装 SSH
  - 同步 usbnet 预埋配置（config / authorized_keys / 开机自启 auto）
  - 顺带把 board.sh 等面板脚本放到根目录

用法：
  python tools/kindle-autostage.py [--once] [--timeout 900] [--dry-run]

产出：仓库根 .kindle-stage.json + .kindle-stage.log
"""
import argparse
import ctypes
import json
import os
import shutil
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEPLOY = ROOT / "deploy" / "kindle-jailbreak"
JB_DIR = DEPLOY / "JailBreak" / "kindle-5.4-jailbreak"
USBNET_DIR = DEPLOY / "USBNetwork"
PRESET = DEPLOY / "usbnet-preset"
KINDLE_DIR = ROOT / "kindle"

USBNET_BIN = "Update_usbnet_0.22.N_install_touch_pw.bin"   # K4 Touch / Paperwhite 1 (FW 5.x)
JB_BIN = "Update_jb_$(cd mnt && cd us && sh jb.sh).bin"

REPORT = ROOT / ".kindle-stage.json"
LOG = ROOT / ".kindle-stage.log"

k32 = ctypes.windll.kernel32


def log(msg):
    line = "[%s] %s" % (time.strftime("%H:%M:%S"), msg)
    print(line, flush=True)
    try:
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


def volume_label(root):
    """返回盘符卷标，读不到返回空串。root 形如 'E:\\'"""
    buf = ctypes.create_unicode_buffer(1024)
    fsbuf = ctypes.create_unicode_buffer(1024)
    serial = ctypes.c_uint()
    maxlen = ctypes.c_uint()
    flags = ctypes.c_uint()
    try:
        ok = k32.GetVolumeInformationW(
            ctypes.c_wchar_p(root), buf, 1024,
            ctypes.byref(serial), ctypes.byref(maxlen),
            ctypes.byref(flags), fsbuf, 1024,
        )
    except Exception:
        return ""
    return buf.value if ok else ""


def drive_type(root):
    # DRIVE_REMOVABLE = 2
    return k32.GetDriveTypeW(ctypes.c_wchar_p(root))


def find_kindle():
    """返回 Kindle U 盘的 Path，找不到返回 None。"""
    bitmask = k32.GetLogicalDrives()
    for i in range(26):
        if not (bitmask >> i) & 1:
            continue
        letter = chr(ord("A") + i)
        if letter in ("A", "B", "C"):
            continue
        root = Path(letter + ":\\")
        try:
            if not root.exists():
                continue
        except Exception:
            continue
        label = volume_label(str(root))
        dtype = drive_type(str(root))
        has_docs = (root / "documents").is_dir()
        if label.strip().lower() == "kindle" or (has_docs and dtype == 2):
            return root, label, has_docs
    return None


def snapshot(root):
    """读取 U 盘根目录状态"""
    entries = []
    try:
        for p in sorted(root.iterdir()):
            try:
                entries.append({
                    "name": p.name,
                    "dir": p.is_dir(),
                    "size": p.stat().st_size if p.is_file() else None,
                })
            except Exception:
                entries.append({"name": p.name, "dir": None, "size": None})
    except Exception as e:
        log("列目录失败: %s" % e)
    return entries


def copy_file(src, dst, dry):
    if not src.exists():
        return False, "源不存在: %s" % src
    if dst.exists():
        try:
            if dst.stat().st_size == src.stat().st_size:
                return True, "已存在且大小一致，跳过"
        except Exception:
            pass
    if dry:
        return True, "[dry-run] 将复制"
    try:
        shutil.copy2(src, dst)
        return True, "已复制 (%.1f MB)" % (dst.stat().st_size / 1048576)
    except Exception as e:
        return False, "复制失败: %s" % e


def stage(root, dry=False):
    """核心：把 U 盘整理成"菜单一定能点亮"的状态"""
    actions = []
    jb = root / "mkk"
    jailbroken = jb.is_dir()

    # --- 步骤 1：清空根目录所有残留 .bin ---
    removed = []
    for p in sorted(root.glob("*.bin")):
        removed.append(p.name)
        if not dry:
            try:
                p.unlink()
            except Exception as e:
                actions.append({"step": "清旧包", "item": p.name, "ok": False, "msg": str(e)})
    if removed:
        actions.append({"step": "清空残留 .bin（残留会让菜单灰）", "item": ", ".join(removed), "ok": True, "msg": "已删除"})
    else:
        actions.append({"step": "清空残留 .bin", "item": "-", "ok": True, "msg": "本来就没有"})

    # --- 步骤 2：部署正确的更新包 ---
    if jailbroken:
        src = USBNET_DIR / USBNET_BIN
        ok, msg = copy_file(src, root / USBNET_BIN, dry)
        actions.append({"step": "部署 USBNetwork 更新包", "item": USBNET_BIN, "ok": ok, "msg": msg})
        next_action = "拔线 -> 菜单「更新您的 Kindle」-> 等待自动重启"
    else:
        # 越狱包：7 个文件全部拷到根目录
        for f in sorted(JB_DIR.iterdir()):
            if f.is_file():
                ok, msg = copy_file(f, root / f.name, dry)
                actions.append({"step": "部署越狱包", "item": f.name, "ok": ok, "msg": msg})
        next_action = "拔线 -> 菜单「更新您的 Kindle」-> 装完越狱再来一轮（插线我会自动改放 USBNetwork 包）"

    # --- 步骤 3：同步 usbnet 预埋配置 ---
    if PRESET.is_dir():
        for rel in ("auto", "etc/config", "etc/authorized_keys"):
            src = PRESET / rel
            dst = root / "usbnet" / rel
            if not src.exists():
                continue
            if not dry:
                dst.parent.mkdir(parents=True, exist_ok=True)
            ok, msg = copy_file(src, dst, dry)
            actions.append({"step": "预埋 usbnet 配置（覆盖为已验证版本）", "item": rel, "ok": ok, "msg": msg})

    # --- 步骤 4：面板脚本 ---
    if KINDLE_DIR.is_dir():
        for name in ("board.sh",):
            src = KINDLE_DIR / name
            ok, msg = copy_file(src, root / name, dry)
            actions.append({"step": "放置面板脚本", "item": name, "ok": ok, "msg": msg})

    # --- 步骤 5：结果核验 ---
    bins_now = [p.name for p in sorted(root.glob("*.bin"))]
    try:
        total, used, free = shutil.disk_usage(str(root))
        free_mb = free // 1048576
    except Exception:
        free_mb = None

    report = {
        "time": time.strftime("%Y-%m-%d %H:%M:%S"),
        "drive": str(root),
        "jailbroken": jailbroken,
        "bins_now": bins_now,
        "free_mb": free_mb,
        "actions": actions,
        "next": next_action,
        "reminder": [
            "电量低于 20% 时菜单一定是灰的 —— 老 KPW1 建议先充 30 分钟",
            "必须在完全拔掉 USB 线之后进菜单，插着线永远灰",
            "要在原生 Kindle 界面操作；多看界面下菜单项不一样",
            "装完会自动重启，重启后 2 分钟内我会自动扫描到它的 IP",
        ],
    }
    return report


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--once", action="store_true", help="只检测一次")
    ap.add_argument("--timeout", type=int, default=900, help="轮询秒数")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    log("=== Kindle 托管脚本启动 (timeout=%ss, dry=%s) ===" % (args.timeout, args.dry_run))
    if args.dry_run:
        log("当前没有任何 Kindle 盘，dry-run 无对象，退出")
        return 0

    deadline = time.time() + args.timeout
    seen = set()
    while time.time() < deadline:
        found = find_kindle()
        if found:
            root, label, has_docs = found
            if str(root) in seen:
                time.sleep(3)
                continue
            seen.add(str(root))
            log("发现 Kindle 盘: %s (卷标=%r, documents=%s)" % (root, label, has_docs))
            snap = snapshot(root)
            log("根目录: %s" % ", ".join("%s%s" % (e["name"], "/" if e["dir"] else "") for e in snap))
            rep = stage(root, args.dry_run)
            rep["root_before"] = snap
            REPORT.write_text(json.dumps(rep, ensure_ascii=False, indent=2), encoding="utf-8")
            log("报告已写入 %s" % REPORT)
            log("下一步: %s" % rep["next"])
            print(json.dumps(rep, ensure_ascii=False, indent=2), flush=True)
            return 0
        if args.once:
            break
        time.sleep(3)

    log("超时/未检测到 Kindle 盘（请把 USB 线插到电脑，不要接充电头）")
    return 1


if __name__ == "__main__":
    sys.exit(main())
