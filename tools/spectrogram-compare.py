#!/usr/bin/env python3
"""
Side-by-side spectrogram comparison for desktop ↔ web parity.

Inputs:  two WAV file paths (desktop, web)
Outputs:
  - <out>.png    side-by-side mel-spectrograms (desktop | web | diff)
  - <out>.json   {l2_distance, mfcc_distance, peak_freq_*, per_beat: [...], ...}

Per-beat windowed analysis fires when --beats N (and optionally --bpm M)
are given. Each window is `60/bpm` seconds wide, sliced from t=0. For
each beat we record per-side RMS, peak, and MFCC vector; cross-side we
record an L2 distance per beat. A second PNG (`<out>_perbeat.png`) plots
the per-beat distance bar chart and per-beat RMS comparison.

Usage:
  python3 tools/spectrogram-compare.py <desktop.wav> <web.wav> <out-prefix>
                                       [--bpm 120] [--beats 16]

Called by tools/compare-desktop-vs-web.ts. Standalone-runnable for ad-hoc use.
"""

from __future__ import annotations

import json
import os
import sys

import numpy as np
from scipy.io import wavfile

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

try:
    import librosa
    import librosa.display
except ImportError:
    os.system("pip3 install librosa")
    import librosa
    import librosa.display


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

N_MELS = 128
N_FFT = 2048
HOP_LENGTH = 512


def load_mono(path: str) -> tuple[np.ndarray, int]:
    """Load WAV, downmix to mono float32 in [-1, 1]."""
    sr, data = wavfile.read(path)
    if data.dtype == np.int16:
        data = data.astype(np.float32) / 32768.0
    elif data.dtype == np.int32:
        data = data.astype(np.float32) / 2147483648.0
    elif data.dtype == np.uint8:
        data = (data.astype(np.float32) - 128.0) / 128.0
    else:
        data = data.astype(np.float32)
    if data.ndim == 2:
        data = data.mean(axis=1)
    return data, sr


def mel_db(audio: np.ndarray, sr: int) -> np.ndarray:
    spec = librosa.feature.melspectrogram(
        y=audio, sr=sr, n_mels=N_MELS, n_fft=N_FFT, hop_length=HOP_LENGTH
    )
    return librosa.power_to_db(spec, ref=np.max)


def mfcc_distance(a: np.ndarray, sr_a: int, b: np.ndarray, sr_b: int) -> float:
    """Mean Euclidean distance between MFCC frames after length alignment.

    A small distance (< 30) means broadly similar timbral envelope. Values
    over ~80 mean very different content."""
    mfcc_a = librosa.feature.mfcc(y=a, sr=sr_a, n_mfcc=13)
    mfcc_b = librosa.feature.mfcc(y=b, sr=sr_b, n_mfcc=13)
    # Align lengths — truncate to the shorter
    n = min(mfcc_a.shape[1], mfcc_b.shape[1])
    if n == 0:
        return float("nan")
    return float(np.mean(np.linalg.norm(mfcc_a[:, :n] - mfcc_b[:, :n], axis=0)))


def l2_spectral_distance(mel_a: np.ndarray, mel_b: np.ndarray) -> float:
    """Per-frame L2 distance, averaged. Both inputs are mel-dB matrices."""
    n = min(mel_a.shape[1], mel_b.shape[1])
    if n == 0:
        return float("nan")
    diff = mel_a[:, :n] - mel_b[:, :n]
    return float(np.sqrt(np.mean(diff * diff)))


def peak_frequency(audio: np.ndarray, sr: int) -> float:
    """Dominant frequency from the average magnitude spectrum (Hz)."""
    spec = np.abs(np.fft.rfft(audio))
    freqs = np.fft.rfftfreq(len(audio), 1 / sr)
    if spec.sum() == 0:
        return 0.0
    return float(freqs[int(np.argmax(spec))])


def slice_beats(audio: np.ndarray, sr: int, bpm: float, beats: int) -> list[np.ndarray]:
    """Slice audio into `beats` windows of (60/bpm) seconds each, from t=0.

    If audio is shorter than the full grid, the last few windows may be empty
    or partial — we pad with silence so MFCC frame count stays consistent."""
    samples_per_beat = int(round(sr * 60.0 / bpm))
    out: list[np.ndarray] = []
    for k in range(beats):
        start = k * samples_per_beat
        end = start + samples_per_beat
        if start >= len(audio):
            out.append(np.zeros(samples_per_beat, dtype=np.float32))
        else:
            window = audio[start:end]
            if len(window) < samples_per_beat:
                window = np.concatenate(
                    [window, np.zeros(samples_per_beat - len(window), dtype=audio.dtype)]
                )
            out.append(window)
    return out


def per_beat_compare(
    audio_d: np.ndarray, sr_d: int,
    audio_w: np.ndarray, sr_w: int,
    bpm: float, beats: int,
) -> dict:
    """Slice both audios at the beat grid; compute per-beat RMS, peak, and
    cross-side MFCC distance. Both sides must use the same beat grid; if
    sample rates differ we resample web → desktop sample rate first."""
    if sr_w != sr_d:
        audio_w = librosa.resample(audio_w.astype(np.float32), orig_sr=sr_w, target_sr=sr_d)
        sr_w = sr_d

    bins_d = slice_beats(audio_d, sr_d, bpm, beats)
    bins_w = slice_beats(audio_w, sr_w, bpm, beats)

    rows = []
    for k in range(beats):
        d, w = bins_d[k], bins_w[k]
        d_rms = float(np.sqrt(np.mean(d * d))) if len(d) else 0.0
        w_rms = float(np.sqrt(np.mean(w * w))) if len(w) else 0.0
        d_peak = float(np.max(np.abs(d))) if len(d) else 0.0
        w_peak = float(np.max(np.abs(w))) if len(w) else 0.0
        # MFCC distance for this beat — if either is silent, distance is the
        # other's overall MFCC norm (i.e. "max possible" for present-vs-silent).
        try:
            mfcc_d = librosa.feature.mfcc(y=d, sr=sr_d, n_mfcc=13)
            mfcc_w = librosa.feature.mfcc(y=w, sr=sr_d, n_mfcc=13)
            n = min(mfcc_d.shape[1], mfcc_w.shape[1])
            mfcc_dist = float(np.mean(np.linalg.norm(mfcc_d[:, :n] - mfcc_w[:, :n], axis=0))) if n > 0 else float("nan")
        except Exception:
            mfcc_dist = float("nan")
        rows.append({
            "beat": k,
            "desktop_rms": round(d_rms, 4),
            "web_rms": round(w_rms, 4),
            "desktop_peak": round(d_peak, 4),
            "web_peak": round(w_peak, 4),
            "mfcc_distance": round(mfcc_dist, 2) if not np.isnan(mfcc_dist) else None,
        })
    # Identify the most divergent beats (top 3 by MFCC distance)
    valid = [r for r in rows if r["mfcc_distance"] is not None]
    most_divergent = sorted(valid, key=lambda r: r["mfcc_distance"], reverse=True)[:3]
    return {
        "bpm": bpm,
        "beats": beats,
        "rows": rows,
        "most_divergent_beats": [r["beat"] for r in most_divergent],
        "mean_per_beat_mfcc_distance": (
            float(np.mean([r["mfcc_distance"] for r in valid])) if valid else float("nan")
        ),
    }


def plot_per_beat(per_beat: dict, out_png: str) -> None:
    rows = per_beat["rows"]
    beats = [r["beat"] for r in rows]
    d_rms = [r["desktop_rms"] for r in rows]
    w_rms = [r["web_rms"] for r in rows]
    mfcc = [r["mfcc_distance"] if r["mfcc_distance"] is not None else 0 for r in rows]

    fig, axes = plt.subplots(2, 1, figsize=(max(8, len(beats) * 0.5), 6), constrained_layout=True)

    # Top: per-beat RMS comparison
    width = 0.4
    x = np.arange(len(beats))
    axes[0].bar(x - width / 2, d_rms, width, label="Desktop", color="#444")
    axes[0].bar(x + width / 2, w_rms, width, label="Web", color="#cc4444")
    axes[0].set_xticks(x)
    axes[0].set_xticklabels(beats)
    axes[0].set_xlabel("Beat index")
    axes[0].set_ylabel("RMS")
    axes[0].set_title(f"Per-beat RMS (bpm={per_beat['bpm']}, beats={per_beat['beats']})")
    axes[0].legend()

    # Bottom: per-beat MFCC distance
    axes[1].bar(x, mfcc, color="#aa4488")
    axes[1].axhline(30, color="green", linestyle="--", linewidth=0.8, label="≤30 similar")
    axes[1].axhline(80, color="red", linestyle="--", linewidth=0.8, label=">80 unrelated")
    axes[1].set_xticks(x)
    axes[1].set_xticklabels(beats)
    axes[1].set_xlabel("Beat index")
    axes[1].set_ylabel("MFCC distance")
    axes[1].set_title("Per-beat MFCC distance (timbre divergence)")
    axes[1].legend(loc="upper right")

    fig.savefig(out_png, dpi=110)
    plt.close(fig)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def parse_args(argv: list[str]) -> tuple[str, str, str, float | None, int | None]:
    if len(argv) < 4:
        return ("", "", "", None, None)
    desktop_path, web_path, out_prefix = argv[1], argv[2], argv[3]
    bpm: float | None = None
    beats: int | None = None
    i = 4
    while i < len(argv):
        if argv[i] == "--bpm":
            bpm = float(argv[i + 1])
            i += 2
        elif argv[i] == "--beats":
            beats = int(argv[i + 1])
            i += 2
        else:
            i += 1
    if beats is not None and bpm is None:
        bpm = 60.0  # Sonic Pi default
    return desktop_path, web_path, out_prefix, bpm, beats


def main() -> int:
    desktop_path, web_path, out_prefix, bpm, beats = parse_args(sys.argv)
    if not desktop_path:
        print(
            "Usage: spectrogram-compare.py <desktop.wav> <web.wav> <out-prefix> [--bpm N] [--beats K]",
            file=sys.stderr,
        )
        return 1
    out_png = f"{out_prefix}.png"
    out_json = f"{out_prefix}.json"

    if not os.path.exists(desktop_path):
        print(f"Desktop WAV not found: {desktop_path}", file=sys.stderr)
        return 1
    if not os.path.exists(web_path):
        print(f"Web WAV not found: {web_path}", file=sys.stderr)
        return 1

    audio_d, sr_d_raw = load_mono(desktop_path)
    audio_w, sr_w_raw = load_mono(web_path)

    # Sample-rate normalization (issue #266): if the two WAVs are at different
    # sample rates (44.1k vs 48k machines), every downstream metric — mel,
    # MFCC, peak-freq, l2 — would compare frames that don't align in time or
    # frequency, producing false divergence. Resample the lower-SR side up to
    # the higher SR so all metrics see a single consistent grid.
    sr = max(sr_d_raw, sr_w_raw)
    if sr_d_raw != sr:
        audio_d = librosa.resample(audio_d.astype(np.float32), orig_sr=sr_d_raw, target_sr=sr)
    if sr_w_raw != sr:
        audio_w = librosa.resample(audio_w.astype(np.float32), orig_sr=sr_w_raw, target_sr=sr)
    sr_d = sr_w = sr

    mel_d = mel_db(audio_d, sr_d)
    mel_w = mel_db(audio_w, sr_w)

    # Diff in mel-dB space (clipped for plotting)
    n_frames = min(mel_d.shape[1], mel_w.shape[1])
    diff = mel_d[:, :n_frames] - mel_w[:, :n_frames]

    # Plot — three panels, shared mel axis
    fig, axes = plt.subplots(1, 3, figsize=(18, 5), constrained_layout=True)
    librosa.display.specshow(
        mel_d, sr=sr_d, hop_length=HOP_LENGTH, y_axis="mel", x_axis="time",
        ax=axes[0], cmap="magma", vmin=-80, vmax=0,
    )
    axes[0].set_title(f"Desktop SP\n{os.path.basename(desktop_path)}\n{sr_d} Hz · {audio_d.shape[0]/sr_d:.2f}s")

    librosa.display.specshow(
        mel_w, sr=sr_w, hop_length=HOP_LENGTH, y_axis="mel", x_axis="time",
        ax=axes[1], cmap="magma", vmin=-80, vmax=0,
    )
    axes[1].set_title(f"SonicPi.js (web)\n{os.path.basename(web_path)}\n{sr_w} Hz · {audio_w.shape[0]/sr_w:.2f}s")

    img = librosa.display.specshow(
        diff, sr=sr_d, hop_length=HOP_LENGTH, y_axis="mel", x_axis="time",
        ax=axes[2], cmap="RdBu_r", vmin=-40, vmax=40,
    )
    axes[2].set_title("Diff (desktop − web), dB\nblue = web louder, red = desktop louder")
    fig.colorbar(img, ax=axes[2], format="%+2.0f dB")

    fig.savefig(out_png, dpi=110)
    plt.close(fig)

    # Numeric metrics
    metrics = {
        "desktop": {
            "path": desktop_path,
            "sample_rate": int(sr_d_raw),
            "sample_rate_normalized": int(sr_d),
            "duration_s": float(audio_d.shape[0] / sr_d),
            "peak_freq_hz": peak_frequency(audio_d, sr_d),
        },
        "web": {
            "path": web_path,
            "sample_rate": int(sr_w_raw),
            "sample_rate_normalized": int(sr_w),
            "duration_s": float(audio_w.shape[0] / sr_w),
            "peak_freq_hz": peak_frequency(audio_w, sr_w),
        },
        "comparison": {
            "l2_mel_db": l2_spectral_distance(mel_d, mel_w),
            "mfcc_distance": mfcc_distance(audio_d, sr_d, audio_w, sr_w),
            "frames_compared": int(n_frames),
            "spectrogram_png": out_png,
        },
    }

    if beats is not None and bpm is not None:
        per_beat = per_beat_compare(audio_d, sr_d, audio_w, sr_w, bpm, beats)
        per_beat_png = f"{out_prefix}_perbeat.png"
        plot_per_beat(per_beat, per_beat_png)
        per_beat["per_beat_png"] = per_beat_png
        metrics["per_beat"] = per_beat

    with open(out_json, "w") as f:
        json.dump(metrics, f, indent=2)

    # Echo a one-line summary so the caller can grep stdout
    summary = (
        f"spectrogram OK · L2(mel-dB)={metrics['comparison']['l2_mel_db']:.2f} · "
        f"MFCC dist={metrics['comparison']['mfcc_distance']:.2f} · "
        f"png={out_png}"
    )
    if "per_beat" in metrics:
        pb = metrics["per_beat"]
        summary += (
            f" · per-beat mean MFCC={pb['mean_per_beat_mfcc_distance']:.2f} · "
            f"divergent beats={pb['most_divergent_beats']}"
        )
    print(summary)
    return 0


if __name__ == "__main__":
    sys.exit(main())
