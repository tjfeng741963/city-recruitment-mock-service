import os

d = "C:/agent/media"
for f in sorted(os.listdir(d)):
    path = os.path.join(d, f)
    print(f, os.path.getsize(path), "bytes")
