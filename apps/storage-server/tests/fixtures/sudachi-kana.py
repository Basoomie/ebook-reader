"""Season 2 Phase 12 test helper: the PC's real kana step (apps/gpu-worker/tts/kana.py).

  python -I -B sudachi-kana.py <tts folder>   stdin: JSON list of readings
                                           stdout: JSON list of what the PC would speak
"""
import json
import sys

sys.path.insert(0, sys.argv[1])
from kana import to_kana  # noqa: E402

readings = json.loads(sys.stdin.buffer.read().decode("utf-8"))
sys.stdout.buffer.write(json.dumps([to_kana(r) for r in readings], ensure_ascii=False).encode("utf-8"))
