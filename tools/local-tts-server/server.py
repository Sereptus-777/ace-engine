# ─── ACE Engine — local speech server (reference implementation) ─────────────
#
# ⚠️ WHAT THIS IS FOR. ACE Engine can send NPC lines to a speech server running
# on the GM's own machine instead of ElevenLabs. This is the smallest possible
# server that speaks the protocol, so the WHOLE PIPELINE can be proven — GM
# generates, audio is broadcast over Foundry's socket, every player hears it —
# BEFORE any large model is involved.
#
# Johnny, 2026-08-23: "this has got to be a carefully executed, surgical
# insertion." Proving the plumbing with a trivial engine, then swapping the
# engine, is how you do that. If voices work with this and break with a bigger
# model, the fault is the model. If they break here, the fault is the plumbing.
# Without this step those two are indistinguishable.
#
# ⚠️ ZERO INSTALL ON WINDOWS. It uses the speech engine already built into
# Windows, through PowerShell, so there is nothing to download to get a real
# voice out of it today. It is not a replacement for ElevenLabs in quality — it
# is the proof that the road is clear.
#
# ─── RUN IT ──────────────────────────────────────────────────────────────────
#     python server.py
# then in Foundry: ACE Engine settings, NPC Voice Provider -> Local speech
# server, address http://localhost:8123, and run Check Every Client.
#
# ─── THE PROTOCOL, WHICH ANY SERVER MAY IMPLEMENT ────────────────────────────
#   GET  /health  -> 200 and a small JSON body. Used to PROVE a client can
#                    reach this server before anything is spoken. Must be cheap.
#   POST /speak   -> JSON in:  {"text": "...", "voice": "...", "speed": 1.0}
#                    audio out: WAV or MP3 bytes, with a matching Content-Type.
#
# Anything that answers those two is a valid ACE speech server. Swap this file
# for Chatterbox, Kokoro, Piper, XTTS or anything else and ACE does not change.
#
# ⚠️ CHECK THE LICENCE OF ANY MODEL YOU PUT BEHIND THIS. ACE is sold. At least
# one popular voice-cloning model ships under a NON-COMMERCIAL licence, which
# would make it unusable here — the same trap as GPL Token Magic, which would
# have forced the whole suite open-source.
import json
import os
import shutil
import subprocess
import sys
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = "127.0.0.1"
PORT = 8123
MAX_CHARS = 1200          # matches the cap ACE's own relay enforces


def windows_speak_to_wav(text, voice="", speed=1.0):
    """Render speech with the voice engine already in Windows.

    ⚠️ The text is passed through a FILE, never interpolated into the command.
    A line of NPC dialogue is arbitrary text containing quotes and apostrophes,
    and building a shell string out of it is both broken and an injection hole.
    """
    if not shutil.which("powershell") and not shutil.which("powershell.exe"):
        return None, "PowerShell was not found, so the built-in Windows voice cannot be used"

    tmpdir = tempfile.mkdtemp(prefix="ace-tts-")
    txt_path = os.path.join(tmpdir, "line.txt")
    wav_path = os.path.join(tmpdir, "out.wav")
    try:
        with open(txt_path, "w", encoding="utf-8") as fh:
            fh.write(text)

        # Rate is -10..10 in this engine; map 0.5..2.0 onto a sane slice of it.
        rate = max(-10, min(10, int(round((float(speed) - 1.0) * 6))))
        select_voice = ""
        if voice:
            # A voice this engine does not have must not kill the request; the
            # default voice is a better answer than an exception.
            select_voice = (
                "try { $s.SelectVoice('" + voice.replace("'", "''") + "') } "
                "catch { Write-Host 'voice not found, using default' }\n"
            )

        script = (
            "Add-Type -AssemblyName System.Speech\n"
            "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer\n"
            + select_voice +
            "$s.Rate = " + str(rate) + "\n"
            "$s.SetOutputToWaveFile('" + wav_path.replace("'", "''") + "')\n"
            "$t = [System.IO.File]::ReadAllText('" + txt_path.replace("'", "''") + "', [System.Text.Encoding]::UTF8)\n"
            "$s.Speak($t)\n"
            "$s.Dispose()\n"
        )
        ps1_path = os.path.join(tmpdir, "speak.ps1")
        with open(ps1_path, "w", encoding="utf-8") as fh:
            fh.write(script)

        result = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive",
             "-ExecutionPolicy", "Bypass", "-File", ps1_path],
            capture_output=True, timeout=60,
        )
        if result.returncode != 0:
            err = (result.stderr or b"").decode("utf-8", "ignore")[:300]
            return None, "the Windows voice engine failed: " + err

        if not os.path.exists(wav_path) or os.path.getsize(wav_path) == 0:
            return None, "the Windows voice engine produced no audio"

        with open(wav_path, "rb") as fh:
            return fh.read(), None
    except subprocess.TimeoutExpired:
        return None, "the Windows voice engine timed out"
    except Exception as exc:                      # noqa: BLE001 - reported, not swallowed
        return None, "the Windows voice engine raised: " + str(exc)[:300]
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def list_windows_voices():
    """The voice names available on this machine, so the GM can pick one."""
    try:
        script = (
            "Add-Type -AssemblyName System.Speech; "
            "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; "
            "$s.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }"
        )
        out = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
            capture_output=True, timeout=20,
        )
        names = (out.stdout or b"").decode("utf-8", "ignore").splitlines()
        return [n.strip() for n in names if n.strip()]
    except Exception:                              # noqa: BLE001
        return []


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _cors(self):
        # ⚠️ FOUNDRY IS A DIFFERENT ORIGIN. The browser will refuse to read this
        # response without these headers, and it fails as an opaque network
        # error that looks exactly like the server being down. Every ACE speech
        # server needs them.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Accept")

    def _send(self, code, body, content_type):
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):                          # noqa: N802 - http.server API
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):                              # noqa: N802
        if self.path.rstrip("/") in ("/health", ""):
            body = json.dumps({
                "ok": True,
                "engine": "windows-sapi",
                "note": "reference server — proves the pipeline, not a quality voice",
                "voices": list_windows_voices(),
            }).encode("utf-8")
            self._send(200, body, "application/json")
            return
        self._send(404, b'{"error":"unknown path"}', "application/json")

    def do_POST(self):                             # noqa: N802
        if self.path.rstrip("/") != "/speak":
            self._send(404, b'{"error":"unknown path"}', "application/json")
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
            payload = json.loads(self.rfile.read(length) or b"{}")
        except Exception:                          # noqa: BLE001
            self._send(400, b'{"error":"body was not valid JSON"}', "application/json")
            return

        text = str(payload.get("text") or "").strip()
        if not text:
            self._send(400, b'{"error":"no text"}', "application/json")
            return
        if len(text) > MAX_CHARS:
            self._send(413, b'{"error":"line too long"}', "application/json")
            return

        audio, err = windows_speak_to_wav(
            text, str(payload.get("voice") or ""), payload.get("speed") or 1.0)
        if err:
            # ⚠️ SAY THE ACTUAL CAUSE IN THE BODY. ACE shows it verbatim to the
            # GM. "500" tells them nothing; the sentence tells them everything.
            self._send(500, json.dumps({"error": err}).encode("utf-8"), "application/json")
            return

        self._send(200, audio, "audio/wav")

    def log_message(self, fmt, *args):             # noqa: A003 - http.server API
        sys.stderr.write("  %s\n" % (fmt % args))


def main():
    print("ACE Engine — local speech server (reference)")
    print("=" * 62)
    voices = list_windows_voices()
    if voices:
        print("  Voices on this machine:")
        for v in voices:
            print("     " + v)
        print("  Put one of those names in an NPC's voice field, or leave it blank.")
    else:
        print("  No Windows voices found. /speak will report why when called.")
    print()
    print("  Listening on http://%s:%d" % (HOST, PORT))
    print("  In Foundry: NPC Voice Provider -> Local speech server")
    print("              Address            -> http://localhost:%d" % PORT)
    print("              Then run Check Every Client.")
    print()
    print("  ⚠️ Bound to 127.0.0.1 deliberately. Players do NOT connect to this;")
    print("     ACE sends them the finished audio over Foundry's own connection.")
    print("=" * 62)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
