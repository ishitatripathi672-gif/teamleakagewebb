import json

log_path = r"C:\Users\Admin\.gemini\antigravity-ide\brain\30c6d69e-823d-46d4-9eb6-1a205d860993\.system_generated\logs\transcript.jsonl"
with open(log_path, "r", encoding="utf-8") as f:
    lines = f.readlines()

print(f"Total lines in log: {len(lines)}")
found = 0
for line in lines:
    if "pwthor_cache_test" in line or "pwthor_kid_test" in line:
        try:
            data = json.loads(line)
            if data.get("source") == "SYSTEM" or (data.get("source") == "MODEL" and "browser_subagent" in line):
                print(f"Step {data.get('step_index')}: Source={data.get('source')}, Type={data.get('type')}")
                content = data.get("content", "")
                if content:
                    print(f"  Content: {content.strip()}")
                found += 1
        except Exception as e:
            pass

print(f"Found {found} occurrences.")


