import os

search_dir = r"c:\tgbotapi"
target = "youtube.com/channel"
target2 = "UChqUTb7"

for root, dirs, files in os.walk(search_dir):
    if "node_modules" in root or ".venv" in root or ".git" in root: continue
    for f in files:
        if f.endswith((".json", ".txt", ".md", ".yml", ".yaml", ".js", ".jsx", ".py")):
            path = os.path.join(root, f)
            try:
                with open(path, "r", encoding="utf-8") as file:
                    for i, line in enumerate(file):
                        if target in line or target2 in line:
                            print(f"{path}:{i+1}: {line.strip()}")
            except:
                pass
