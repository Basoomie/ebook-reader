"""ttsu TTS runner (WP17), run inside the ttsu-irodori image.

  ttsu_tts.py sample --spec /work/spec.json

`sample` (the model-choice step): loads one model once and reads a few short items,
each item as the real pipeline will read a book: sentence by sentence (one model call
per sentence, so each sentence's length is exact), joined with fixed pauses.

spec.json:
  {
    "model": "Aratako/Irodori-TTS-v4.1-Small",      # Hugging Face repo[/subfolder]
    "revision": "<commit sha>",                     # pinned model revision
    "precision": "bf16" | "fp32",
    "out": "/work/out/<name>",
    "items": [
      {"name": "...", "paragraphs": [[{"text": "...", "reading": "..."}, ...], ...],
       "kana": true, "caption": null, "ref": "/work/ref.wav" | null, "seed": 1234}
    ],
    "pauses": {"sentenceMs": 300, "paragraphMs": 700}
  }

Writes <out>/<item>.wav, <out>/<item>.json (cues, readings, timings) and <out>/stats.json.
Progress lines on stdout start with "TTSU ".
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

import torch


def log(msg: str) -> None:
    print(f"TTSU {msg}", flush=True)


def download_checkpoint(source: str, revision: str | None) -> str:
    """Like irodori_tts.inference_runtime.download_hf_checkpoint, but pinned to a revision."""
    from huggingface_hub import snapshot_download

    parts = source.split("/")
    repo_id = "/".join(parts[:2])
    subfolder = "/".join(parts[2:]) or None
    if subfolder is None:
        rel = Path("model.safetensors")
        allow = ["model.safetensors", "tokenizer/*"]
    else:
        rel = Path(subfolder) / "model.safetensors"
        allow = [rel.as_posix(), f"{subfolder}/tokenizer/*", "tokenizer/*"]
    snap = Path(snapshot_download(repo_id=repo_id, revision=revision, allow_patterns=allow))
    path = snap / rel
    if not path.is_file():
        raise FileNotFoundError(f"no model.safetensors in {source}@{revision}")
    return str(path)


def load_runtime(model: str, revision: str | None, precision: str):
    from irodori_tts.inference_runtime import InferenceRuntime, RuntimeKey

    t0 = time.perf_counter()
    ckpt = download_checkpoint(model, revision)
    t_download = time.perf_counter() - t0
    device = "cuda" if torch.cuda.is_available() else "cpu"
    runtime = InferenceRuntime.from_key(
        RuntimeKey(
            checkpoint=ckpt,
            model_device=device,
            model_precision=precision,
            codec_device=device,
            codec_precision="fp32",
        )
    )
    return runtime, {"downloadSeconds": round(t_download, 2), "loadSeconds": round(time.perf_counter() - t0 - t_download, 2)}


def request_for(runtime, text: str, *, caption: str | None, ref: str | None, seed: int):
    from irodori_tts.inference_runtime import SamplingRequest, resolve_cfg_scales

    cfg = runtime.model_cfg
    use_speaker = bool(cfg.use_speaker_condition_resolved and ref)
    use_caption = bool(cfg.use_caption_condition and caption)
    text_s, caption_s, speaker_s, _ = resolve_cfg_scales(
        cfg_guidance_mode="independent",
        cfg_scale_text=3.0,
        cfg_scale_caption=3.0,
        cfg_scale_speaker=5.0,
        cfg_scale=None,
        use_caption_condition=use_caption,
        use_speaker_condition=use_speaker,
    )
    return SamplingRequest(
        text=text,
        caption=caption if use_caption else None,
        ref_wav=ref if use_speaker else None,
        no_ref=not use_speaker,
        cfg_scale_text=text_s,
        cfg_scale_caption=caption_s,
        cfg_scale_speaker=speaker_s,
        seed=seed,
    )


def split_sentences(text: str) -> list[str]:
    """Split after 。！？!? (with closing brackets that follow). Good enough for samples;
    the real jobs get sentences from the server (the reader's own boundaries)."""
    out, cur, i = [], [], 0
    closers = "」』）)】〉》\"'"
    while i < len(text):
        cur.append(text[i])
        if text[i] in "。！？!?":
            while i + 1 < len(text) and text[i + 1] in closers:
                i += 1
                cur.append(text[i])
            out.append("".join(cur))
            cur = []
        i += 1
    if "".join(cur).strip():
        out.append("".join(cur))
    return [s for s in (x.strip() for x in out) if s]


def pair_sentences(text: str, reading: str) -> list[tuple[str, str]]:
    """Sentence pairs (text, reading). The reading has the same sentence ends as the text
    (furigana never contains 。！？), so both split into the same number of parts."""
    a, b = split_sentences(text), split_sentences(reading)
    if len(a) != len(b):
        return [(text, reading)]
    return list(zip(a, b))


def cmd_sample(spec_path: str) -> int:
    from kana import to_kana

    spec = json.loads(Path(spec_path).read_text(encoding="utf-8"))
    out = Path(spec["out"])
    out.mkdir(parents=True, exist_ok=True)
    pauses = spec.get("pauses", {"sentenceMs": 300, "paragraphMs": 700})
    if torch.cuda.is_available():
        torch.cuda.reset_peak_memory_stats()
    log(f"loading {spec['model']}@{spec.get('revision')} {spec['precision']}")
    runtime, load_stats = load_runtime(spec["model"], spec.get("revision"), spec["precision"])
    stats = {
        "model": spec["model"],
        "revision": spec.get("revision"),
        "precision": spec["precision"],
        "irodoriCommit": os.environ.get("IRODORI_COMMIT"),
        "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
        "caption": bool(runtime.model_cfg.use_caption_condition),
        "speaker": bool(runtime.model_cfg.use_speaker_condition_resolved),
        **load_stats,
        "items": [],
    }
    if torch.cuda.is_available():
        stats["vramAfterLoadMiB"] = round(torch.cuda.memory_reserved() / 2**20)

    for item in spec["items"]:
        name = item["name"]
        caption = item.get("caption")
        ref = item.get("ref")
        if caption and not runtime.model_cfg.use_caption_condition:
            log(f"skip {name}: this model has no voice descriptions")
            continue
        if ref and not runtime.model_cfg.use_speaker_condition_resolved:
            log(f"skip {name}: this model takes no reference clip")
            continue
        seed = int(item.get("seed", 1234))
        batch = max(1, int(item.get("batch", 1)))
        # Units in reading order: (text, spoken, pause after in ms or None at the very end).
        units: list[tuple[str, str, int | None]] = []
        paragraphs = item["paragraphs"]
        for pi, para in enumerate(paragraphs):
            pairs = []
            for p in para:
                if item.get("whole"):
                    # One model call for the whole paragraph (a voice sample: one voice throughout).
                    pairs.append((p["text"], p.get("reading", p["text"])))
                else:
                    pairs.extend(pair_sentences(p["text"], p.get("reading", p["text"])))
            for si, (text, reading) in enumerate(pairs):
                spoken = to_kana(reading) if item.get("kana") else text
                if si < len(pairs) - 1:
                    gap = pauses["sentenceMs"]
                elif pi < len(paragraphs) - 1:
                    gap = pauses["paragraphMs"]
                else:
                    gap = None
                units.append((text, spoken, gap))

        # Warm-up call (CUDA kernels, caches), not counted in the speed.
        runtime.synthesize(request_for(runtime, "こんにちは。", caption=caption, ref=ref, seed=seed))
        if torch.cuda.is_available():
            torch.cuda.synchronize()
            torch.cuda.reset_peak_memory_stats()

        audios: list[torch.Tensor] = []
        gen_per_unit: list[float] = []
        sample_rate = None
        t_gen = 0.0
        for b0 in range(0, len(units), batch):
            group = units[b0 : b0 + batch]
            reqs = [request_for(runtime, u[1], caption=caption, ref=ref, seed=seed) for u in group]
            if batch > 1:
                for r in reqs:
                    r.decode_mode = "batch"
            t0 = time.perf_counter()
            results = runtime.synthesize_batch(reqs)
            dt = time.perf_counter() - t0
            t_gen += dt
            for res in results:
                audio = res.audio.detach().to("cpu", torch.float32)
                if audio.ndim == 1:
                    audio = audio.unsqueeze(0)
                sample_rate = res.sample_rate
                audios.append(audio)
                gen_per_unit.append(dt / len(group))
            log(f"{name} sentences {b0 + 1}-{b0 + len(group)} of {len(units)} in {dt:.2f}s")

        chunks: list[torch.Tensor] = []
        cues = []
        t_audio = 0.0
        for (text, spoken, gap), audio, g in zip(units, audios, gen_per_unit):
            secs = audio.shape[-1] / sample_rate
            cues.append({"start": round(t_audio, 3), "end": round(t_audio + secs, 3), "text": text, "spoken": spoken, "genSeconds": round(g, 2)})
            chunks.append(audio)
            t_audio += secs
            if gap is not None:
                n = int(sample_rate * gap / 1000)
                chunks.append(torch.zeros((audio.shape[0], n)))
                t_audio += n / sample_rate
        from irodori_tts.inference_runtime import save_wav

        save_wav(out / f"{name}.wav", torch.cat(chunks, dim=-1), sample_rate)
        speech = sum(c["end"] - c["start"] for c in cues)
        entry = {
            "name": name,
            "sentences": len(cues),
            "audioSeconds": round(t_audio, 2),
            "speechSeconds": round(speech, 2),
            "generateSeconds": round(t_gen, 2),
            "speechPerSecond": round(speech / t_gen, 2) if t_gen else None,
            "sampleRate": sample_rate,
            "batch": batch,
        }
        if torch.cuda.is_available():
            entry["peakAllocatedMiB"] = round(torch.cuda.max_memory_allocated() / 2**20)
            entry["peakReservedMiB"] = round(torch.cuda.max_memory_reserved() / 2**20)
        (out / f"{name}.json").write_text(json.dumps({**entry, "cues": cues}, ensure_ascii=False, indent=1), encoding="utf-8")
        stats["items"].append(entry)
        log(f"done {name}: {json.dumps(entry, ensure_ascii=False)}")

    if torch.cuda.is_available():
        stats["peakAllocatedMiB"] = round(torch.cuda.max_memory_allocated() / 2**20)
        stats["peakReservedMiB"] = round(torch.cuda.max_memory_reserved() / 2**20)
    (out / "stats.json").write_text(json.dumps(stats, ensure_ascii=False, indent=1), encoding="utf-8")
    log("stats " + json.dumps(stats, ensure_ascii=False))
    return 0


def cmd_check() -> int:
    ok = torch.cuda.is_available()
    print(json.dumps({"cuda": ok, "gpu": torch.cuda.get_device_name(0) if ok else None, "torch": torch.__version__}))
    return 0 if ok else 1


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(prog="ttsu_tts.py")
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("sample")
    s.add_argument("--spec", required=True)
    sub.add_parser("check")
    args = ap.parse_args(argv)
    if args.cmd == "sample":
        return cmd_sample(args.spec)
    return cmd_check()


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
