import io
import tempfile
import os
import wave

from flask import Flask, request, jsonify, send_file
from piper import PiperVoice

app = Flask(__name__)

MODEL_PATH = "/models/en_US-lessac-medium.onnx"
VOICE_NAME = "en_US-lessac-medium"

print(f"Loading Piper voice model: {MODEL_PATH}")
voice = PiperVoice.load(MODEL_PATH)
print(f"Voice model loaded. Sample rate: {voice.config.sample_rate}")


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "voice": VOICE_NAME})


@app.route("/synthesize", methods=["POST"])
def synthesize():
    data = request.get_json(force=True)
    text = data.get("text", "")

    if not text:
        return jsonify({"error": "text is required"}), 400

    tmp_path = None
    try:
        fd, tmp_path = tempfile.mkstemp(suffix=".wav")
        os.close(fd)

        with wave.open(tmp_path, "wb") as wav_file:
            voice.synthesize_wav(text, wav_file)

        with open(tmp_path, "rb") as f:
            wav_bytes = f.read()

        return send_file(
            io.BytesIO(wav_bytes),
            mimetype="audio/wav",
            as_attachment=True,
            download_name="speech.wav",
        )
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500
    finally:
        if tmp_path and os.path.exists(tmp_path):
            os.remove(tmp_path)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5500)
