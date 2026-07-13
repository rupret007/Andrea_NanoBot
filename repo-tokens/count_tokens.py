#!/usr/bin/env python3
"""Count repository tokens and update the README badge for the local action."""

import glob
import os
import re

import tiktoken


include_patterns = os.environ["INPUT_INCLUDE"].split()
exclude_patterns = os.environ["INPUT_EXCLUDE"].split()
context_window = int(os.environ["INPUT_CONTEXT_WINDOW"])
readme_path = os.environ["INPUT_README"]
encoding_name = os.environ["INPUT_ENCODING"]
marker = os.environ["INPUT_MARKER"]
badge_path = os.environ.get("INPUT_BADGE_PATH", "").strip()

included = set()
for pattern in include_patterns:
    included.update(glob.glob(pattern, recursive=True))

excluded = set()
for pattern in exclude_patterns:
    excluded.update(glob.glob(pattern, recursive=True))

files = sorted(included - excluded)
files = [file_path for file_path in files if os.path.isfile(file_path)]

encoding = tiktoken.get_encoding(encoding_name)
total = 0
for file_path in files:
    try:
        with open(file_path, "r", encoding="utf-8", errors="ignore") as source:
            total += len(encoding.encode(source.read()))
    except Exception as error:
        print(f"Skipping {file_path}: {error}")

if total >= 100000:
    display = f"{round(total / 1000)}k"
elif total >= 1000:
    display = f"{total / 1000:.1f}k"
else:
    display = str(total)

percentage = round(total / context_window * 100)
badge = f"{display} tokens \u00b7 {percentage}% of context window"

print(f"Files: {len(files)}, Tokens: {total}, Badge: {badge}")

marker_pattern = re.compile(
    rf"(<!--\s*{re.escape(marker)}\s*-->).*?(<!--\s*/{re.escape(marker)}\s*-->)",
    re.DOTALL,
)

with open(readme_path, "r", encoding="utf-8") as source:
    content = source.read()

repo_tokens_url = "https://github.com/qwibitai/nanoclaw/tree/main/repo-tokens"
linked_badge = f'<a href="{repo_tokens_url}">{badge}</a>'
new_content = marker_pattern.sub(rf"\1{linked_badge}\2", content)

if new_content != content:
    with open(readme_path, "w", encoding="utf-8") as destination:
        destination.write(new_content)
    print("README updated")
else:
    print("No change to README")

if badge_path:
    label_text = "tokens"
    value_text = display
    full_description = f"{display} tokens, {percentage}% of context window"

    character_width = 7.0
    label_width = round(len(label_text) * character_width) + 10
    value_width = round(len(value_text) * character_width) + 10
    total_width = label_width + value_width

    if percentage < 30:
        color = "#4c1"
    elif percentage < 50:
        color = "#97ca00"
    elif percentage < 70:
        color = "#dfb317"
    else:
        color = "#e05d44"

    label_x = label_width // 2
    value_x = label_width + value_width // 2

    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="{total_width}" height="20" role="img" aria-label="{full_description}">
  <title>{full_description}</title>
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r">
    <rect width="{total_width}" height="20" rx="3" fill="#fff"/>
  </clipPath>
  <a xlink:href="{repo_tokens_url}">
    <g clip-path="url(#r)">
      <rect width="{label_width}" height="20" fill="#555"/>
      <rect x="{label_width}" width="{value_width}" height="20" fill="{color}"/>
      <rect width="{total_width}" height="20" fill="url(#s)"/>
      <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
        <text aria-hidden="true" x="{label_x}" y="15" fill="#010101" fill-opacity=".3">{label_text}</text>
        <text x="{label_x}" y="14">{label_text}</text>
        <text aria-hidden="true" x="{value_x}" y="15" fill="#010101" fill-opacity=".3">{value_text}</text>
        <text x="{value_x}" y="14">{value_text}</text>
      </g>
    </g>
  </a>
</svg>'''

    os.makedirs(os.path.dirname(badge_path) or ".", exist_ok=True)
    with open(badge_path, "w", encoding="utf-8") as destination:
        destination.write(svg)
    print(f"Badge SVG written to {badge_path}")

with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
    output.write(f"tokens={total}\n")
    output.write(f"percentage={percentage}\n")
    output.write(f"badge={badge}\n")
