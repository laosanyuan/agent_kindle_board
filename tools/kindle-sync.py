#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Kindle 插线即同步脚本（拿到 root 之后用）。

做的事：
  1. 轮询等 Kindle U 盘出现
  2. 读 /mnt/us/kindle-ssh/emergency.log + /mnt/us/board.log，提取 wlan0 的 IP
  3. 把本地 kindle/board.sh 以 LF 换行写回设备（覆盖旧版）
  4. 报告写到 .kindle-sync.json

用法：python tools/kindle-sync.py [--timeout 1800]
"""
import argparse
import ctypes
import json
import re
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REPORT = ROOT / ".kindle-sync.json"
LOG = ROOT / ".kindle-sync.log"
k32 = ctypes.windll.kernel32


def log(m):
    line = "[%s] %s" % (time.strftime("%H:%M:%S"), m)
    print(line, flush=True)
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(line + "\n")


def find_kindle():
    bm = k32.GetLogicalDrives()
    for i in range(26):
        if not (bm >> i) & 1:
            continue
        letter = chr(ord("A") + i)
        if letter in ("A", "B", "C", "D"):
            continue
        root = Path(letter + ":\\")
        try:
            if not root.exists():
                continue
        except Exception:
            continue
        buf = ctypes.create_unicode_buffer(1024)
        fs = ctypes.create_unicode_buffer(1024)
        sn = ctypes.c_uint(); ml = ctypes.c_uint(); fl = ctypes.c_uint()
        try:
            ok = k32.GetVolumeInformationW(ctypes.c_wchar_p(str(root)), buf, 1024,
                                           ctypes.byref(sn), ctypes.byref(ml),
                                           ctypes.byref(fl), fs, 1024)
        except Exception:
            continue
        if (ok and buf.value.strip().lower() == "kindle") or (root / "documents").is_dir():
            return root
    return None


def tail(p, n=60):
    if not p.exists():
        return None
    try:
        lines = p.read_bytes().decode("utf-8", "ignore").splitlines()
        return "\n".join(lines[-n:])
    except Exception as e:
        return "读取失败: %s" % e


def extract_ip(text):
    if not text:
        return None
    # wlan0 的 inet addr:192.168.x.x
    m = re.findall(r"inet addr:(\d+\.\d+\.\d+\.\d+)", text)
    if m:
        return m[0]
    m = re.findall(r"\b(192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)\b", text)
    # 排除明显不是本机的
    for x in m:
        if not x.startswith("192.168.100.218"):
            return x
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--timeout", type=int, default=1800)
    args = ap.parse_args()

    log("=== 同步脚本启动，等待 Kindle 插线 (timeout=%ss) ===" % args.timeout)
    deadline = time.time() + args.timeout
    while time.time() < deadline:
        root = find_kindle()
        if root:
            log("发现 Kindle: %s" % root)
            rep = {"time": time.strftime("%Y-%m-%d %H:%M:%S"), "drive": str(root)}

            elog = root / "kindle-ssh" / "emergency.log"
            blog = root / "board.log"
            rep["emergency_log"] = tail(elog, 80)
            rep["board_log"] = tail(blog, 30)
            ip = extract_ip((rep["emergency_log"] or "") + "\n" + (rep["board_log"] or ""))
            rep["ip"] = ip
            log("emergency.log 存在: %s" % elog.exists())
            log("提取到 IP: %s" % ip)
            if rep["emergency_log"]:
                log("---- emergency.log 尾部 ----")
                for l in rep["emergency_log"].splitlines()[-25:]:
                    log("  " + l)

            # 写回最新的 board.sh（先删，避开 FAT 上的独占锁定）
            src = ROOT / "kindle" / "board.sh"
            dst = root / "board.sh"
            try:
                if dst.exists():
                    dst.unlink()
                dst.write_bytes(src.read_bytes().replace(b"\r\n", b"\n"))
                rep["board_sh"] = "已更新 (%d bytes)" % dst.stat().st_size
            except Exception as e:
                rep["board_sh"] = "写入失败: %s" % e
            log("board.sh: %s" % rep["board_sh"])

            # 顺带把 emergency.sh 恢复成待命状态（若上次已改名 .done 就不再改）
            done = root / "emergency.sh.done"
            if done.exists() and not (root / "emergency.sh").exists():
                rep["emergency_sh"] = "已执行过 (emergency.sh.done 存在)"
            else:
                rep["emergency_sh"] = "仍是待命状态"

            REPORT.write_text(json.dumps(rep, ensure_ascii=False, indent=2), encoding="utf-8")
            log("报告: %s" % REPORT)
            return 0
        time.sleep(3)

    log("超时，未检测到 Kindle")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
