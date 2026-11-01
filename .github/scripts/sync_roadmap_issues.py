#!/usr/bin/env python3
"""Autonomous GitHub Roadmap & Issue Curator Bot.

Synchronizes repository labels and maintains a steady window of contributor-ready
`good first issue` and `help wanted` issues from `.github/roadmap.json`.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

ROADMAP_MARKER_RE = re.compile(r"<!--\s*roadmap-id:\s*([A-Za-z0-9_-]+)\s*-->")
PRIORITY_RE = re.compile(r"priority/p(\d)")


def _sort_key(item: dict, index: int) -> tuple[int, int]:
    for label in item.get("labels", []):
        name = label.get("name") if isinstance(label, dict) else label
        match = PRIORITY_RE.fullmatch(str(name))
        if match:
            return (int(match.group(1)), index)
    return (5, index)


def render_issue_body(item: dict[str, Any]) -> str:
    item_id = item["id"]
    files_md = "\n".join(f"- `{path}`" for path in item.get("files", []))
    criteria_md = "\n".join(f"- [ ] {line}" for line in item.get("acceptance_criteria", []))

    return f"""<!-- roadmap-id: {item_id} -->
## Summary

{item['summary']}

## Why This Matters

{item['motivation']}

## Proposed Files to Touch

{files_md}

## Acceptance Criteria

{criteria_md}

## Local Verification

```bash
python -m pip install -e .
pytest -q
```

---
> 🤖 *Curated automatically by the roadmap bot (`{item_id}`). Want to work on this? Comment below and open a Pull Request referencing `Closes #<issue-number>`!*
"""


def extract_known_roadmap_ids(issues: list[dict[str, Any]]) -> tuple[set[str], int]:
    seen: set[str] = set()
    open_count = 0
    for issue in issues:
        if "pull_request" in issue:
            continue
        body = issue.get("body") or ""
        match = ROADMAP_MARKER_RE.search(body)
        if match:
            seen.add(match.group(1))
            if issue.get("state") == "open":
                open_count += 1
    return seen, open_count


def count_open_starters(existing_issues: list[dict[str, Any]]) -> int:
    return sum(
        1
        for issue in existing_issues
        if "pull_request" not in issue
        and issue.get("state") == "open"
        and any(
            (label.get("name") if isinstance(label, dict) else label) == "good first issue"
            for label in issue.get("labels", [])
        )
    )


def _is_starter(item: dict[str, Any]) -> bool:
    return "good first issue" in item.get("labels", [])


def select_items_to_open(
    roadmap: dict[str, Any],
    existing_issues: list[dict[str, Any]],
    limit: int | None = None,
) -> list[dict[str, Any]]:
    max_open = int(roadmap.get("max_open_roadmap_issues", 8))
    starter_floor = int(roadmap.get("min_open_good_first_issues", 0))

    seen_ids, current_open = extract_known_roadmap_ids(existing_issues)
    slots_available = max(0, max_open - current_open)

    queued = [
        item
        for index, item in enumerate(roadmap.get("items", []))
        if item["id"] not in seen_ids and item.get("status") != "shipped"
    ]
    queued.sort(key=lambda item: _sort_key(item, roadmap["items"].index(item)))

    if limit is not None:
        return queued[: max(0, limit)]

    to_open: list[dict[str, Any]] = []
    if count_open_starters(existing_issues) < starter_floor:
        to_open.extend([item for item in queued if _is_starter(item)][:starter_floor])

    for item in queued:
        if len(to_open) >= max(slots_available, len(to_open)):
            break
        if item in to_open:
            continue
        to_open.append(item)

    if limit is not None:
        to_open = to_open[: max(0, limit)]
    return to_open


def select_shipped_issues_to_close(
    roadmap: dict[str, Any],
    existing_issues: list[dict[str, Any]],
) -> list[tuple[int, dict[str, Any]]]:
    shipped = {
        item["id"]: item
        for item in roadmap.get("items", [])
        if item.get("status") == "shipped" and item.get("id")
    }
    to_close: list[tuple[int, dict[str, Any]]] = []
    for issue in existing_issues:
        if "pull_request" in issue or issue.get("state") != "open":
            continue
        match = ROADMAP_MARKER_RE.search(issue.get("body") or "")
        if not match:
            continue
        item = shipped.get(match.group(1))
        if item is not None:
            to_close.append((int(issue["number"]), item))
    return to_close


def render_shipped_comment(item: dict[str, Any]) -> str:
    version = item.get("shipped_in", "the latest release")
    return (
        f"Shipped in **{version}** — closing this as delivered. "
        f"Thanks to everyone who picked it up.\n\n"
        f"If you think something in this item is still missing, please open a new issue describing the remaining gap rather than reopening this one."
    )


def select_issues_to_refresh(
    roadmap: dict[str, Any],
    existing_issues: list[dict[str, Any]],
) -> list[tuple[int, dict[str, Any]]]:
    items = {item["id"]: item for item in roadmap.get("items", []) if item.get("id")}
    stale: list[tuple[int, dict[str, Any]]] = []
    for issue in existing_issues:
        if "pull_request" in issue or issue.get("state") != "open":
            continue
        match = ROADMAP_MARKER_RE.search(issue.get("body") or "")
        if not match:
            continue
        item = items.get(match.group(1))
        if item is None or item.get("status") == "shipped":
            continue
        if issue.get("title") != item["title"] or (issue.get("body") or "") != render_issue_body(item):
            stale.append((int(issue["number"]), item))
    return stale


class GitHubClient:
    def __init__(self, repo: str, token: str) -> None:
        self.repo = repo
        self.base_url = f"https://api.github.com/repos/{repo}"
        self.headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "Content-Type": "application/json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "roadmap-bot",
        }

    def request(self, method: str, path: str, payload: Any = None) -> Any:
        url = f"{self.base_url}{path}"
        data = json.dumps(payload).encode("utf-8") if payload is not None else None
        req = urllib.request.Request(url, data=data, headers=self.headers, method=method)
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw) if raw else None

    def sync_labels(self, labels: list[dict[str, str]]) -> None:
        existing_raw = self.request("GET", "/labels?per_page=100") or []
        existing = {lbl["name"].lower(): lbl["name"] for lbl in existing_raw}
        for spec in labels:
            key = spec["name"].lower()
            body = {
                "name": spec["name"],
                "color": spec["color"],
                "description": spec.get("description", "")[:100],
            }
            if key not in existing:
                self.request("POST", "/labels", body)
                print(f"[labels] created '{spec['name']}'")
            else:
                encoded = urllib.parse.quote(existing[key], safe="")
                self.request("PATCH", f"/labels/{encoded}", body)

    def list_all_issues(self) -> list[dict[str, Any]]:
        all_issues: list[dict[str, Any]] = []
        page = 1
        while True:
            batch = self.request("GET", f"/issues?state=all&per_page=100&page={page}") or []
            if not batch:
                break
            all_issues.extend(batch)
            if len(batch) < 100:
                break
            page += 1
        return all_issues

    def create_issue(self, title: str, body: str, labels: list[str]) -> dict[str, Any]:
        return self.request("POST", "/issues", {"title": title, "body": body, "labels": labels})

    def update_issue(self, number: int, title: str, body: str) -> None:
        self.request("PATCH", f"/issues/{number}", {"title": title, "body": body})

    def close_issue(self, number: int, comment: str) -> None:
        self.request("POST", f"/issues/{number}/comments", {"body": comment})
        self.request("PATCH", f"/issues/{number}", {"state": "closed", "state_reason": "completed"})


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Sync repository labels and contributor roadmap issues.")
    parser.add_argument("--roadmap", type=Path, default=Path(".github/roadmap.json"), help="Path to roadmap JSON file.")
    parser.add_argument("--repo", default=os.environ.get("GITHUB_REPOSITORY", ""), help="Target owner/repo (defaults to $GITHUB_REPOSITORY).")
    parser.add_argument("--count", type=int, default=None, help="Open at most N issues this run.")
    parser.add_argument("--dry-run", action="store_true", help="Validate roadmap and preview queued issues without calling GitHub API.")
    args = parser.parse_args(argv)

    roadmap = json.loads(args.roadmap.read_text(encoding="utf-8"))

    if args.dry_run:
        to_open = select_items_to_open(roadmap, [], limit=args.count)
        print(f"[dry-run] Validated {len(roadmap.get('items', []))} roadmap items and {len(roadmap.get('labels', []))} labels. Initial batch would open {len(to_open)} issues:")
        for item in to_open:
            print(f"  - [{item['id']}] {item['title']}")
        shipped = [i for i in roadmap.get("items", []) if i.get("status") == "shipped"]
        print(f"[dry-run] {len(shipped)} item(s) marked shipped and excluded from the queue.")
        return 0

    token = os.environ.get("GITHUB_TOKEN", "")
    if not args.repo or not token:
        print("Error: GITHUB_REPOSITORY and GITHUB_TOKEN must be set unless --dry-run is used.", file=sys.stderr)
        return 2

    client = GitHubClient(args.repo, token)
    try:
        client.sync_labels(roadmap.get("labels", []))
        existing = client.list_all_issues()
        for number, item in select_issues_to_refresh(roadmap, existing):
            client.update_issue(number, item["title"], render_issue_body(item))
            print(f"[roadmap-bot] Refreshed #{number}: {item['id']} text had drifted")
        to_close = select_shipped_issues_to_close(roadmap, existing)
        for number, item in to_close:
            client.close_issue(number, render_shipped_comment(item))
            print(f"[roadmap-bot] Closed #{number}: {item['id']} shipped")
        closed = {number for number, _ in to_close}
        remaining = [issue for issue in existing if int(issue.get("number", 0)) not in closed]
        to_open = select_items_to_open(roadmap, remaining, limit=args.count)
        if not to_open:
            print("[roadmap-bot] Active contributor queue is already full; nothing new to open.")
            return 0
        for item in to_open:
            created = client.create_issue(
                title=item["title"],
                body=render_issue_body(item),
                labels=item.get("labels", []),
            )
            print(f"[roadmap-bot] Opened #{created['number']}: {created['title']} ({created['html_url']})")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        print(f"GitHub API error ({exc.code}): {detail}", file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
