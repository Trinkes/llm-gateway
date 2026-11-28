// [fork] W23: record a clip from the microphone for the transcription playground.
import { useCallback, useRef, useState } from "react";

export function useRecorder() {
  const [active, setActive] = useState(false);
  const [recording, setRecording] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);

  const start = useCallback(async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => chunks.push(e.data);
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const type = rec.mimeType || "audio/webm";
        const ext = type.includes("ogg")
          ? "ogg"
          : type.includes("mp4")
            ? "m4a"
            : "webm";
        setRecording(new File(chunks, `recording.${ext}`, { type }));
        setActive(false);
      };
      recorder.current = rec;
      rec.start();
      setActive(true);
    } catch (err) {
      setError((err as Error).message || "Microphone unavailable");
    }
  }, []);

  const stop = useCallback(() => recorder.current?.stop(), []);

  return { active, recording, error, start, stop };
}
