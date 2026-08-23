"""official_forms/*.hwp(한글 5.0) → 텍스트.

관공서 공식 서식의 실제 문구·배치를 확인할 때 쓴다. 온라인 변환 사이트를 거치지
않으므로 서식 파일이 외부로 나가지 않는다.

    pip install olefile
    python scripts/hwp_text.py "official_forms/01_법원_등기/지급명령_이의신청서.hwp"

HWP 5.0 = OLE2 복합문서. 본문은 BodyText/SectionN 스트림에 raw deflate 로 들어 있고,
그 안은 (태그, 길이, 데이터) 레코드의 나열이다. 문단 텍스트 레코드(67)만 골라
UTF-16LE 로 읽는다. 표는 컨트롤 문자로만 표시되므로 셀 내용이 순서대로 흘러나오고
칸 경계는 탭으로 갈음한다 — 표 구조까지 복원하지는 않는다.
"""

import sys
import zlib
import struct

import olefile

EXT = {1, 2, 3, 11, 12, 14, 15, 16, 17, 18, 21, 22, 23}  # 확장 컨트롤(표·그림 등), 8 wchar
INL = {4, 5, 6, 7, 8, 9, 19, 20}                          # 인라인 컨트롤, 8 wchar
TAG_PARA_TEXT = 67


def records(buf):
    i = 0
    while i + 4 <= len(buf):
        (h,) = struct.unpack_from("<I", buf, i)
        i += 4
        tag, size = h & 0x3FF, (h >> 20) & 0xFFF
        if size == 0xFFF:  # 확장 길이는 뒤따르는 4바이트에 들어 있다
            (size,) = struct.unpack_from("<I", buf, i)
            i += 4
        yield tag, buf[i : i + size]
        i += size


def para_text(data):
    out, i, n = [], 0, len(data) // 2
    while i < n:
        (c,) = struct.unpack_from("<H", data, i * 2)
        if c in EXT or c in INL:
            i += 8
            out.append("\t")  # 표 칸·개체 자리
        elif c in (10, 13):
            i += 1
            out.append("\n")
        elif c < 32:
            i += 1
        else:
            i += 1
            out.append(chr(c))
    return "".join(out)


def hwp_text(path):
    ole = olefile.OleFileIO(path)
    try:
        compressed = bool(ole.openstream("FileHeader").read()[36] & 1)
        parts = []
        for sec in sorted(p[1] for p in ole.listdir() if p[0] == "BodyText"):
            raw = ole.openstream(["BodyText", sec]).read()
            buf = zlib.decompress(raw, -15) if compressed else raw
            parts += [para_text(d) for tag, d in records(buf) if tag == TAG_PARA_TEXT]
        return "\n".join(parts)
    finally:
        ole.close()


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    print(hwp_text(sys.argv[1]))
