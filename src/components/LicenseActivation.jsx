import { useState } from "react";
import { validateLicense } from "../licensing/keygen.js";

export default function LicenseActivation({ onActivated }) {
  const [licenseKey, setLicenseKey] = useState("");
  const [error, setError] = useState(null);
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setIsLoading(true);

    try {
      const result = await validateLicense(licenseKey.trim());

      if (result.success) {
        onActivated(result.license);
      } else {
        setError(result.error);
      }
    } catch (err) {
      setError("Noe gikk galt. Prøv igjen.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="bg-zinc-900 rounded-xl border border-zinc-800 p-8">
          <div className="text-center mb-8">
            <h1 className="text-2xl font-bold text-white mb-2">
              Assistio Trygghetsalarm
            </h1>
            <p className="text-zinc-400">
              Skriv inn lisensnøkkelen din for å aktivere
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-6">
            <div>
              <label
                htmlFor="license"
                className="block text-sm font-medium text-zinc-300 mb-2"
              >
                Lisensnøkkel
              </label>
              <input
                id="license"
                type="text"
                value={licenseKey}
                onChange={(e) => setLicenseKey(e.target.value)}
                placeholder="XXXX-XXXX-XXXX-XXXX"
                className="w-full px-4 py-3 bg-zinc-800 border border-zinc-700 rounded-lg text-white placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent font-mono"
                disabled={isLoading}
                autoFocus
              />
            </div>

            {error && (
              <div className="bg-red-900/30 border border-red-800 rounded-lg px-4 py-3 text-red-300 text-sm">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={isLoading || !licenseKey.trim()}
              className="w-full py-3 px-4 bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-700 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors"
            >
              {isLoading ? "Aktiverer..." : "Aktiver lisens"}
            </button>
          </form>

          <div className="mt-8 pt-6 border-t border-zinc-800">
            <p className="text-zinc-500 text-sm text-center">
              Har du ikke en lisens?{" "}
              <a
                href="mailto:kontakt@assistio.no"
                className="text-blue-400 hover:text-blue-300"
              >
                Kontakt oss
              </a>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
