#!/usr/bin/env python3
"""
用 GitHub API 推送 —— 绕开 git 协议。

背景：github.com 的 git 端点（smart HTTP）在部分网络下被阻断，
      但 api.github.com 是通的。GitHub 的 git data API
      （create blob / tree / commit / update ref）能完成同样的事。

用法：
    python push-via-api.py <仓库目录> <token> [仓库名]
"""
import base64
import json
import os
import sys
import time
import urllib.request

API = "https://api.github.com"


def req(method, url, token, data=None, retries=3):
    body = json.dumps(data).encode("utf-8") if data is not None else None
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "User-Agent": "ai-workbench-uploader",
    }
    if body:
        headers["Content-Type"] = "application/json"
    last = None
    for attempt in range(retries):
        try:
            r = urllib.request.Request(url, data=body, headers=headers, method=method)
            with urllib.request.urlopen(r, timeout=60) as resp:
                raw = resp.read().decode("utf-8")
                return json.loads(raw) if raw else {}
        except Exception as e:
            last = e
            detail = ""
            if hasattr(e, "read"):
                try:
                    detail = e.read().decode("utf-8")[:200]
                except Exception:
                    pass
            print(f"  ! {method} 失败(第{attempt+1}次): {e} {detail}")
            if attempt < retries - 1:
                time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"{method} {url} 失败: {last}")


def main():
    root = sys.argv[1]
    token = sys.argv[2]
    repo = sys.argv[3] if len(sys.argv) > 3 else "ai-workbench"

    # 1. 收集要上传的文件
    files = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in (".git", "node_modules", "dist", "release-src")]
        for fn in filenames:
            full = os.path.join(dirpath, fn)
            rel = os.path.relpath(full, root).replace("\\", "/")
            if rel.startswith(".git/") or "/.git/" in rel:
                continue
            files.append(rel)
    files.sort()
    print(f"待上传 {len(files)} 个文件")

    # 2. 查远端当前 ref
    try:
        ref = req("GET", f"{API}/repos/{repo}/git/ref/heads/main", token)
        base_tree = ref["object"]["sha"]
        print(f"远端已有分支 main: {base_tree[:8]}")
    except Exception:
        base_tree = None
        print("远端还没有 main 分支")

    # 3. 逐个建 blob
    blobs = []
    for i, rel in enumerate(files, 1):
        with open(os.path.join(root, rel), "rb") as f:
            data = f.read()
        sha = req(
            "POST",
            f"{API}/repos/{repo}/git/blobs",
            token,
            {"content": base64.b64encode(data).decode("ascii"), "encoding": "base64"},
        )["sha"]
        blobs.append({"path": rel, "mode": "100644", "type": "blob", "sha": sha})
        if i % 10 == 0 or i == len(files):
            print(f"  blob {i}/{len(files)}")

    # 4. 建 tree
    tree = req("POST", f"{API}/repos/{repo}/git/trees", token, {"tree": blobs, "base_tree": base_tree})
    print(f"tree: {tree['sha'][:8]}")

    # 5. 建 commit
    with open(os.path.join(root, ".git", "COMMIT_EDITMSG"), encoding="utf-8") as f:
        msg = f.read().strip().split("\n")[0]
    commit = req(
        "POST",
        f"{API}/repos/{repo}/git/commits",
        token,
        {"message": msg, "tree": tree["sha"], "parents": [base_tree] if base_tree else []},
    )
    print(f"commit: {commit['sha'][:8]}")

    # 6. 更新 ref
    req("PATCH", f"{API}/repos/{repo}/git/refs/heads/main", token, {"sha": commit["sha"], "force": True})
    print(f"main → {commit['sha'][:8]}")

    print(f"\n完成：https://github.com/{repo}")


if __name__ == "__main__":
    main()
