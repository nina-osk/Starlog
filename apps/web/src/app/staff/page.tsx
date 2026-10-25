"use client";

import jsQR from "jsqr";
import { useCallback, useEffect, useRef, useState } from "react";
import { post } from "@/lib/api";

type Result = {
  event: string;
  attendee: string;
  stamp: { tokenId: number; txHash: string } | null;
  alreadyStamped: boolean;
};

/** Door check-in for event staff: scan the attendee's QR (or paste the code). */
export default function StaffCheckIn() {
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [scanning, setScanning] = useState(false);
  const [manual, setManual] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(async (payload: string) => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await post<Result>("/api/checkin", { payload }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!scanning) return;
    let stream: MediaStream | null = null;
    let frame = 0;
    let stopped = false;

    const tick = () => {
      if (stopped) return;
      const v = video.current;
      const c = canvas.current;
      if (v && c && v.readyState === v.HAVE_ENOUGH_DATA) {
        c.width = v.videoWidth;
        c.height = v.videoHeight;
        const ctx = c.getContext("2d", { willReadFrequently: true });
        if (ctx) {
          ctx.drawImage(v, 0, 0, c.width, c.height);
          const code = jsQR(ctx.getImageData(0, 0, c.width, c.height).data, c.width, c.height);
          if (code?.data) {
            setScanning(false);
            void submit(code.data);
            return;
          }
        }
      }
      frame = requestAnimationFrame(tick);
    };

    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: "environment" } })
      .then((s) => {
        stream = s;
        if (video.current) {
          video.current.srcObject = s;
          void video.current.play();
        }
        frame = requestAnimationFrame(tick);
      })
      .catch(() => {
        setError("No se pudo abrir la cámara. Pega el código a mano.");
        setScanning(false);
      });

    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [scanning, submit]);

  return (
    <main className="min-h-screen flex flex-col items-center gap-6 p-8">
      <h1 className="text-2xl font-semibold">Check-in · staff</h1>

      <div className="w-full max-w-sm flex flex-col gap-3">
        {scanning ? (
          <>
            <video ref={video} className="w-full rounded-xl bg-black" muted playsInline />
            <button onClick={() => setScanning(false)} className="underline text-sm">
              Cancelar
            </button>
          </>
        ) : (
          <button
            onClick={() => setScanning(true)}
            disabled={busy}
            className="rounded-full bg-foreground text-background h-11 font-medium disabled:opacity-40"
          >
            Escanear QR con la cámara
          </button>
        )}
        <canvas ref={canvas} className="hidden" />

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (manual.trim()) void submit(manual.trim());
          }}
          className="flex gap-2"
        >
          <input
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            placeholder="…o pega el código del ticket"
            className="flex-1 rounded-lg border border-black/15 dark:border-white/20 bg-transparent px-3 h-10 text-sm"
          />
          <button disabled={busy || !manual.trim()} className="rounded-lg border px-3 h-10 text-sm disabled:opacity-40">
            Validar
          </button>
        </form>

        {busy && <p className="text-sm opacity-70">Validando y emitiendo el sello…</p>}
        {error && <p className="text-sm text-red-600">{error}</p>}
        {result && (
          <div className="rounded-xl border border-green-600/40 bg-green-600/10 p-4 text-sm flex flex-col gap-1">
            <p className="font-medium">✓ Check-in correcto · {result.event}</p>
            <p className="font-mono text-xs break-all">{result.attendee}</p>
            <p>
              {result.stamp
                ? `Sello #${result.stamp.tokenId} emitido (+100 XP).`
                : "Ya tenía el sello de este evento."}
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
