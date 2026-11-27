#!/usr/bin/env python3
"""Build a minimal EPUB fixture for the ZhConvert EPUB pipeline tests.

Structure (mimetype FIRST + STORED, per the EPUB spec):
  mimetype                    (ZIP_STORED)
  META-INF/container.xml
  OEBPS/content.opf           (dc:title / dc:creator in Simplified)
  OEBPS/ch1.xhtml             (Simplified prose + Simplified ATTRIBUTE
                               + a <script> block + a <style> block —
                               attributes and script/style must NOT convert)
  OEBPS/ch2.xhtml             (more Simplified prose)
"""
import zipfile
import os

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "fixture.epub")

CONTAINER = """<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
"""

OPF = """<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:identifier id="bookid">urn:uuid:zhconvert-fixture</dc:identifier>
    <dc:title>简体小说测试</dc:title>
    <dc:creator>简体作者</dc:creator>
    <dc:language>zh-CN</dc:language>
  </metadata>
  <manifest>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
  </spine>
</package>
"""

CH1 = """<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-CN">
<head>
<title>第一章 简体标题</title>
<style type="text/css">.note::after { content: "简体样式不要动"; }</style>
<script type="text/javascript">var s = "简体脚本不要动";</script>
</head>
<body>
<h1 class="chapter" title="简体属性不要动">第一章 开始</h1>
<p class="intro" data-note="简体属性">简体中文，头发和鼠标都要转换。</p>
<p>周杰伦的新专辑很好听，大家都喜欢听。</p>
</body>
</html>
"""

CH2 = """<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-CN">
<head><title>第二章</title></head>
<body>
<h1>第二章 继续</h1>
<p>这是第二章的内容，简体字继续出现，头发依然要转换。</p>
</body>
</html>
"""


def main():
    if os.path.exists(OUT):
        os.remove(OUT)
    with zipfile.ZipFile(OUT, "w") as z:
        z.writestr(zipfile.ZipInfo("mimetype"), "application/epub+zip",
                   compress_type=zipfile.ZIP_STORED)
        z.writestr("META-INF/container.xml", CONTAINER,
                   compress_type=zipfile.ZIP_DEFLATED)
        z.writestr("OEBPS/content.opf", OPF, compress_type=zipfile.ZIP_DEFLATED)
        z.writestr("OEBPS/ch1.xhtml", CH1, compress_type=zipfile.ZIP_DEFLATED)
        z.writestr("OEBPS/ch2.xhtml", CH2, compress_type=zipfile.ZIP_DEFLATED)
    print("wrote", OUT)


if __name__ == "__main__":
    main()
