#!/usr/bin/env python3
"""模拟 Chrome 的 Native Messaging 协议，独立测试 OCR 后端。

这样可以在装扩展之前，先把「4 字节小端长度前缀 + JSON」这层协议单独验证掉，
出问题时就能立刻区分是协议层还是扩展层。

用法：  python3 test_stdio.py <后端路径> <测试图>
"""
import base64
import json
import struct
import subprocess
import sys

HOST = sys.argv[1] if len(sys.argv) > 1 else "./livetext-ocr"
IMG = sys.argv[2]


def main():
    with open(IMG, "rb") as f:
        raw = f.read()
    b64 = base64.b64encode(raw).decode()

    req = json.dumps({"png": b64, "langs": ["zh-Hans", "en-US"]}).encode("utf-8")
    payload = struct.pack("<I", len(req)) + req

    print(f"请求: {len(raw)} 字节图片 → base64 {len(b64)} 字符 → 消息体 {len(req)} 字节")

    try:
        p = subprocess.run([HOST], input=payload, capture_output=True, timeout=90)
    except subprocess.TimeoutExpired:
        print("失败：后端超时未返回（可能卡在读循环里）")
        return 1

    print(f"退出码: {p.returncode}")

    if p.stderr:
        err = p.stderr.decode("utf-8", "replace").strip()
        if err:
            print(f"stderr: {err[:300]}")

    out = p.stdout
    if len(out) < 4:
        print(f"失败：stdout 只有 {len(out)} 字节，协议头都不够")
        return 1

    n = struct.unpack("<I", out[:4])[0]
    if len(out) - 4 < n:
        print(f"失败：声明长度 {n}，实际只有 {len(out) - 4} 字节")
        return 1

    resp = json.loads(out[4 : 4 + n].decode("utf-8"))

    print("协议解析: OK")
    print(f"ok={resp.get('ok')}  count={resp.get('count')}  elapsed={resp.get('elapsed_ms')}ms")
    if resp.get("error"):
        print(f"后端报错: {resp['error']}")
        return 1

    for l in (resp.get("lines") or [])[:10]:
        print(f"   conf={l['conf']:.2f}   {l['text']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
