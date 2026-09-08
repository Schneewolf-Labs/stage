"""Voice service: Kokoro-82M text-to-speech with optional RVC voice conversion.

    POST /tts      {"text": "...", "voice": "af_heart", "rvc": "egirl" | null, "speed": 1.0, "pitch": 0}
                   -> audio/wav (24 kHz mono)
    POST /convert?rvc=egirl&pitch=12   body: a WAV file (any rate, mono or stereo)
                   -> audio/wav, the same speech in the RVC model's voice. For recorded voiceovers.
    POST /transcribe   body: a WAV (any rate) -> {"text": "...", "seconds": 3.2, "ms": 410}
                   whisper.cpp (WHISPER_MODEL, default base.en) for the console's push-to-talk.
    GET  /health   -> {"device": ..., "rvc": [...], "loaded_rvc": [...], "whisper": "base.en"}

`pitch` is semitones of f0 shift into the model: a male voice into a female model usually wants
+12, same-range voices 0.

One request at a time: Kokoro and RVC share the GPU and a sentence takes well under a second, so
a lock is simpler and no slower than batching. Stage sends one sentence per request so the first
line of a reply is speaking while the rest is still being generated.
"""
import argparse, functools, glob, io, json, os, tempfile, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import soundfile as sf
import torch

# torch>=2.6 defaults weights_only=True, which rejects fairseq's Dictionary class inside the
# official RVC hubert_base.pt. That checkpoint is the upstream RVC release; allow it.
_load = torch.load
torch.load = functools.wraps(_load)(lambda *a, **k: _load(*a, **{**k, 'weights_only': False}))

SR = 24000
DEVICE = os.environ.get('DEVICE', 'cuda' if torch.cuda.is_available() else 'cpu')
RVC_MODELS = os.environ.get('RVC_MODELS', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'models'))
lock = threading.Lock()
pipeline = None
rvc_cache = {}
WHISPER_MODEL = os.environ.get('WHISPER_MODEL', 'base.en')
whisper = None


def load_whisper():
    global whisper
    if whisper is None:
        from pywhispercpp.model import Model
        whisper = Model(WHISPER_MODEL, print_progress=False, print_realtime=False)
    return whisper


def transcribe(audio, sr):
    """Any-rate WAV samples -> text. whisper wants 16 kHz mono float32."""
    mono = audio.mean(axis=1) if audio.ndim > 1 else audio
    if sr != 16000:
        n = int(np.ceil(len(mono) * 16000 / sr))
        mono = np.interp(np.linspace(0, len(mono) - 1, n), np.arange(len(mono)), mono)
    mono = mono.astype(np.float32)
    segs = load_whisper().transcribe(mono)
    import re
    text = ' '.join(s.text.strip() for s in segs)
    text = re.sub(r'\s*\[[A-Z_ ]+\]\s*', ' ', text).strip()  # whisper's [BLANK_AUDIO], [MUSIC] markers
    return text, len(mono) / 16000


def rvc_names():
    return sorted(os.path.basename(d) for d in glob.glob(os.path.join(RVC_MODELS, '*')) if glob.glob(os.path.join(d, '*.pth')))


def load_rvc(name):
    if name in rvc_cache:
        return rvc_cache[name]
    from rvc_python.infer import RVCInference
    d = os.path.join(RVC_MODELS, name)
    pth = glob.glob(os.path.join(d, '*.pth'))
    idx = glob.glob(os.path.join(d, '*.index'))
    if not pth:
        raise FileNotFoundError(f'no .pth in {d}')
    r = RVCInference(device=DEVICE + ':0' if DEVICE == 'cuda' else DEVICE)
    r.load_model(pth[0], index_path=idx[0] if idx else '')
    r.set_params(f0method='rmvpe', f0up_key=0, index_rate=0.6, protect=0.33)
    rvc_cache[name] = r
    return r


def to_mono_24k(audio, sr):
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    if sr != SR:
        n = int(np.ceil(len(audio) * SR / sr))
        audio = np.interp(np.linspace(0, len(audio) - 1, n), np.arange(len(audio)), audio)
    return audio.astype(np.float32)


def convert(audio, sr, rvc, pitch):
    """Run float audio through an RVC model. rvc-python is file-based, so round-trip via temp files."""
    with tempfile.TemporaryDirectory() as td:
        src, dst = os.path.join(td, 'in.wav'), os.path.join(td, 'out.wav')
        sf.write(src, audio, sr)
        r = load_rvc(rvc)
        r.set_params(f0up_key=int(pitch))
        r.infer_file(src, dst)
        out, out_sr = sf.read(dst, dtype='float32')
    return to_mono_24k(out, out_sr)


MOUTH_RATE = 50


def mouth_track(audio, sr=SR, rate=MOUTH_RATE):
    """Lipsync frames for a clip: [openness 0..1, form -1..1] every 1/rate s.

    Openness is a loudness envelope with a fast attack and slower release, normalised to the
    clip's own peak so a quiet voice still opens the mouth. Form is the spectral tilt: energy
    above ~1.5 kHz (e, i: wide) versus below (o, u: round), so the shape changes with the vowel.
    Cheap, deterministic, and aligned to the audio clock on the page, unlike polling an analyser.
    """
    hop = sr // rate
    win = np.hanning(hop * 2)
    frames = []
    freqs = np.fft.rfftfreq(len(win), 1 / sr)
    hi = freqs >= 1500
    for start in range(0, len(audio), hop):
        seg = audio[start:start + len(win)]
        if len(seg) < len(win):
            seg = np.pad(seg, (0, len(win) - len(seg)))
        seg = seg * win
        rms = float(np.sqrt(np.mean(seg * seg)))
        spec = np.abs(np.fft.rfft(seg)) ** 2
        tot = float(spec.sum()) + 1e-9
        tilt = float(spec[hi].sum()) / tot
        frames.append([rms, tilt])
    if not frames:
        return {'rate': rate, 'frames': []}
    env = np.array([f[0] for f in frames])
    peak = float(np.percentile(env, 97)) or 1.0
    env = np.clip(env / peak, 0, 1)
    env = np.where(env < 0.06, 0, env)          # gate the noise floor
    env = np.sqrt(env)                           # perceptual: small sounds still move the mouth
    out, level = [], 0.0
    for e, t in zip(env, (f[1] for f in frames)):
        level = e if e > level else level * 0.55 + e * 0.45   # instant attack, ~40 ms release
        form = (t - 0.18) * 4                                 # ~0.18 tilt is neutral speech
        out.append([round(float(level), 2), round(float(max(-1, min(1, form))), 2) if e > 0.06 else 0])
    return {'rate': rate, 'frames': out}


def encode(audio):
    buf = io.BytesIO()
    sf.write(buf, audio, SR, format='WAV', subtype='PCM_16')
    return buf.getvalue(), len(audio) / SR


def tts(text, voice, rvc, speed, pitch=0):
    outs = [a for _, _, a in pipeline(text, voice=voice, speed=speed)]
    audio = np.concatenate([o.numpy() if hasattr(o, 'numpy') else np.asarray(o) for o in outs]).astype(np.float32)
    if rvc:
        audio = convert(audio, SR, rvc, pitch)
    wav, dur = encode(audio)
    return wav, dur, mouth_track(audio)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype='application/json'):
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.rstrip('/') == '/health':
            self._send(200, json.dumps({'device': DEVICE, 'rvc': rvc_names(), 'loaded_rvc': list(rvc_cache), 'whisper': WHISPER_MODEL}).encode())
        else:
            self._send(404, b'{"error":"not found"}')

    def do_POST(self):
        from urllib.parse import parse_qs, urlparse
        u = urlparse(self.path)
        n = int(self.headers.get('Content-Length') or 0)
        try:
            t0 = time.perf_counter()
            if u.path.rstrip('/') == '/tts':
                req = json.loads(self.rfile.read(n) or b'{}')
                text = str(req.get('text', '')).strip()
                if not text:
                    return self._send(400, b'{"error":"text required"}')
                with lock:
                    wav, dur, mouth = tts(text, req.get('voice') or 'af_heart', req.get('rvc') or None,
                                          float(req.get('speed') or 1.0), int(req.get('pitch') or 0))
            elif u.path.rstrip('/') == '/transcribe':
                audio, sr = sf.read(io.BytesIO(self.rfile.read(n)), dtype='float32')
                with lock:
                    text, seconds = transcribe(audio, sr)
                return self._send(200, json.dumps({'text': text, 'seconds': round(seconds, 2),
                                                   'ms': round((time.perf_counter() - t0) * 1000)}).encode())
            elif u.path.rstrip('/') == '/convert':
                q = parse_qs(u.query)
                rvc = (q.get('rvc') or [''])[0]
                if not rvc:
                    return self._send(400, b'{"error":"rvc query param required"}')
                audio, sr = sf.read(io.BytesIO(self.rfile.read(n)), dtype='float32')
                with lock:
                    out = convert(audio, sr, rvc, int((q.get('pitch') or ['0'])[0]))
                    wav, dur = encode(out)
                    mouth = mouth_track(out)
            else:
                return self._send(404, b'{"error":"not found"}')
            self.send_response(200)
            self.send_header('Content-Type', 'audio/wav')
            self.send_header('Content-Length', str(len(wav)))
            self.send_header('X-Audio-Seconds', f'{dur:.2f}')
            self.send_header('X-Gen-Seconds', f'{time.perf_counter() - t0:.3f}')
            if len(mouth['frames']) <= 4000:  # 80 s at 50 Hz; a sentence is a few seconds
                self.send_header('X-Mouth', json.dumps(mouth, separators=(',', ':')))
            self.end_headers()
            self.wfile.write(wav)
        except Exception as e:  # report, never crash the service
            self._send(500, json.dumps({'error': f'{type(e).__name__}: {e}'}).encode())


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=int(os.environ.get('PORT', 8100)))
    ap.add_argument('--host', default='127.0.0.1')
    ap.add_argument('--preload-rvc', default='', help='comma-separated RVC model names to load at start')
    a = ap.parse_args()
    from kokoro import KPipeline
    pipeline = KPipeline(lang_code='a', device=DEVICE, repo_id='hexgrad/Kokoro-82M')
    tts('warm up.', 'af_heart', None, 1.0)
    for name in filter(None, a.preload_rvc.split(',')):
        load_rvc(name)
    print(f'voice service on http://{a.host}:{a.port} device={DEVICE} rvc={rvc_names()}', flush=True)
    ThreadingHTTPServer((a.host, a.port), Handler).serve_forever()
