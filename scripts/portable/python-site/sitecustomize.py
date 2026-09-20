"""Load .pth metadata from Harbor's isolated, bundled Python package directories."""
import os
import site

for directory in os.environ.get("PYTHONPATH", "").split(os.pathsep):
    if directory and os.path.isdir(directory):
        site.addsitedir(directory)
