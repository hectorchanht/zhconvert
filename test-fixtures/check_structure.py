#!/usr/bin/env python3
"""Verify the repacked EPUB structure after the node conversion test:
mimetype must be the FIRST entry and STORED; all entries readable."""
import zipfile
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PATH = os.path.join(HERE, "fixture-converted.epub")

z = zipfile.ZipFile(PATH)
infos = z.infolist()
assert infos, "empty zip"
first = infos[0]
print("entries:", [(i.filename, i.compress_type) for i in infos])
assert first.filename == "mimetype", f"first entry is {first.filename}, not mimetype"
assert first.compress_type == zipfile.ZIP_STORED, "mimetype is not STORED"
assert z.read("mimetype") == b"application/epub+zip", "mimetype content wrong"
bad = z.testzip()
assert bad is None, f"corrupt entry: {bad}"
ch1 = z.read("OEBPS/ch1.xhtml").decode("utf-8")
assert "簡體中文" in ch1, "converted prose missing in repacked epub"
print("STRUCTURE OK")
sys.exit(0)
