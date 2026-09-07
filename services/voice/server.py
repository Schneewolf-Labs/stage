"""Voice service: Kokoro-82M text-to-speech with optional RVC voice conversion.

    POST /tts   {"text": "...", "voice": "af_heart", "rvc": "egirl" | null, "speed": 1.0}
                -> audio/wav (24 kHz mono float)
    GET  /health -> {"device": ..., "voices": [...], "rvc": [...]}

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


def tts(text, voice, rvc, speed):
    outs = [a for _, _, a in pipeline(text, voice=voice, speed=speed)]
    audio = np.concatenate([o.numpy() if hasattr(o, 'numpy') else np.asarray(o) for o in outs]).astype(np.float32)
    if rvc:
        with tempfile.TemporaryDirectory() as td:
            src, dst = os.path.join(td, 'in.wav'), os.path.join(td, 'out.wav')
            sf.write(src, audio, SR)
            load_rvc(rvc).infer_file(src, dst)
            audio, sr = sf.read(dst, dtype='float32')
            if audio.ndim > 1:
                audio = audio.mean(axis=1)
            if sr != SR:
                # RVC emits at the model's native rate; keep the contract simple for the client.
                import math
                n = int(math.ceil(len(audio) * SR / sr))
                audio = np.interp(np.linspace(0, len(audio) - 1, n), np.arange(len(audio)), audio).astype(np.float32)
    buf = io.BytesIO()
    sf.write(buf, audio, SR, format='WAV', subtype='PCM_16')
    return buf.getvalue(), len(audio) / SR


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
            self._send(200, json.dumps({'device': DEVICE, 'rvc': rvc_names(), 'loaded_rvc': list(rvc_cache)}).encode())
        else:
            self._send(404, b'{"error":"not found"}')

    def do_POST(self):
        if self.path.rstrip('/') != '/tts':
            return self._send(404, b'{"error":"not found"}')
        n = int(self.headers.get('Content-Length') or 0)
        try:
            req = json.loads(self.rfile.read(n) or b'{}')
            text = str(req.get('text', '')).strip()
            if not text:
                return self._send(400, b'{"error":"text required"}')
            t0 = time.perf_counter()
            with lock:
                wav, dur = tts(text, req.get('voice') or 'af_heart', req.get('rvc') or None, float(req.get('speed') or 1.0))
            self.send_response(200)
            self.send_header('Content-Type', 'audio/wav')
            self.send_header('Content-Length', str(len(wav)))
            self.send_header('X-Audio-Seconds', f'{dur:.2f}')
            self.send_header('X-Gen-Seconds', f'{time.perf_counter() - t0:.3f}')
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
