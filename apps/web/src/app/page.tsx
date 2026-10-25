import { Home } from "@/components/home";

export default function Page() {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center gap-8 p-8">
      <div className="text-center">
        <h1 className="text-4xl font-semibold tracking-tight">Estela</h1>
        <p className="mt-2 opacity-70">Viaja a tus eventos y paga con stablecoins en Stellar.</p>
      </div>
      <Home />
    </main>
  );
}
